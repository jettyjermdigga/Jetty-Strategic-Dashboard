// A spreadsheet, written by hand.
//
// An .xlsx is a ZIP of XML files, and a Worker has neither a ZIP library nor
// a way to install one. So this is both: a few hundred lines that turn rows
// into the handful of XML parts Excel insists on, and a stored-entry ZIP to
// put them in.
//
// Stored rather than deflated. A Worker has CompressionStream, but a ZIP
// entry wants the raw deflate stream without the zlib wrapper and the sizes
// known before the header is written, and a monthly statement is forty rows.
// Twenty kilobytes uncompressed is not a problem worth a compressor for.
//
// Pure: no fetch, no clock, no bindings. Bytes in, bytes out, which is what
// lets a test open the result and read it back.

// ── ZIP ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * A ZIP file, with every entry stored.
 *
 * `files` is [{ name, data }] where data is a Uint8Array. Names are plain
 * ASCII paths with forward slashes -- the parts of an .xlsx all are, so
 * there is no filename encoding flag to get wrong.
 *
 * The modification time is fixed rather than taken from a clock. Two runs
 * over the same figures then produce the same bytes, which is the only way
 * a test can say "this file did not change".
 */
export function zip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  // 1980-01-01 00:00, the earliest a DOS timestamp can say.
  const DOS_TIME = 0;
  const DOS_DATE = 33;

  for (const f of files) {
    const name = utf8(f.name);
    const data = f.data;
    const sum = crc32(data);
    const head = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(sum), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(head), name, data);
    entries.push({ name, sum, size: data.length, offset });
    offset += head.length + name.length + data.length;
  }

  const dirStart = offset;
  for (const e of entries) {
    const rec = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(e.sum), ...u32(e.size), ...u32(e.size),
      ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.offset),
    ];
    chunks.push(new Uint8Array(rec), e.name);
    offset += rec.length + e.name.length;
  }

  const end = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(offset - dirStart), ...u32(dirStart), ...u16(0),
  ];
  chunks.push(new Uint8Array(end));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ── Cells ───────────────────────────────────────────────────────────────

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // A tab or a newline inside a cell is legal and a control character is
    // not: one of them in a retailer name would make the whole file refuse
    // to open, which is a strange way to find out about a bad import.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** A1, B1 ... Z1, AA1. */
export function colName(n) {
  let s = '';
  let i = n;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

const DAY = 86400000;
// Excel counts days from 1899-12-30, which is one earlier than it looks
// because 1900 is wrongly a leap year in its calendar. Using 1899-12-31
// files every date before 1900-03-01 a day out and everything after it
// exactly right, which is the kind of bug nobody finds.
const EPOCH = Date.UTC(1899, 11, 30);

/** 'YYYY-MM-DD' as an Excel serial. Null for anything that is not one --
 *  a date cell holding the text "n/a" is what makes Excel refuse a file. */
export function serialDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return null;
  return Math.round((t - EPOCH) / DAY);
}

// The style slots, by what they are for rather than by number. Their order
// has to match cellXfs in STYLES below, so they are declared once here and
// the stylesheet is written to suit.
export const S = {
  plain: 0,
  head: 1,
  date: 2,
  mid: 3,
  text: 4,
  money: 5,
  pct: 6,
  label: 7,
  subtotal: 8,
  grand: 9,
  right: 10,
};

/** Cell constructors. A cell is a plain object so a row is data a test can
 *  read, rather than a string already turned into XML. */
export const txt = (v, s) => ({ t: 's', v, s: s == null ? S.text : s });
export const mid = (v) => ({ t: 's', v, s: S.mid });
export const num = (v, s) => ({ t: 'n', v, s: s == null ? S.plain : s });
export const money = (v, s) => ({ t: 'n', v, s: s == null ? S.money : s });
export const pct = (v) => ({ t: 'n', v, s: S.pct });
export const date = (v) => {
  const n = serialDate(v);
  return n == null ? txt(v, S.mid) : { t: 'n', v: n, s: S.date };
};
/** A formula, with the answer cached beside it. Without the cached value a
 *  reader that does not calculate -- Numbers, Google's preview, a phone --
 *  shows an empty total. */
export const sum = (ref, value, s) => ({ t: 'f', f: 'SUM(' + ref + ')', v: value,
                                         s: s == null ? S.subtotal : s });

function cellXml(c, ref) {
  if (c == null || c.v == null || c.v === '') {
    // An empty cell still carries its style, or the box around the row
    // stops wherever somebody left a note blank.
    return c && c.s ? '<c r="' + ref + '" s="' + c.s + '"/>' : '';
  }
  const s = c.s ? ' s="' + c.s + '"' : '';
  if (c.t === 'f') {
    return '<c r="' + ref + '"' + s + '><f>' + esc(c.f) + '</f><v>'
      + Number(c.v) + '</v></c>';
  }
  if (c.t === 'n') {
    const n = Number(c.v);
    if (!Number.isFinite(n)) return '<c r="' + ref + '"' + s + '/>';
    return '<c r="' + ref + '"' + s + '><v>' + n + '</v></c>';
  }
  // Inline, so there is no shared string table to keep in step. It costs
  // bytes on a sheet with the same word a thousand times and saves a whole
  // part of the file on one with forty rows.
  return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">'
    + esc(c.v) + '</t></is></c>';
}

// ── The parts ───────────────────────────────────────────────────────────

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const CONTENT_TYPES = XML
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = XML
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const BOOK_RELS = XML
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

// numFmtId 8 is money with red negatives, 14 is m/d/yy, 10 is 0.00%. All
// three are built in, so there is no numFmts part to declare.
const STYLES = XML
  + '<styleSheet xmlns="' + NS + '">'
  + '<fonts count="3">'
  + '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>'
  + '</fonts>'
  + '<fills count="4">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="3">'
  + '<border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFBFBFBF"/></left>'
  + '<right style="thin"><color rgb="FFBFBFBF"/></right>'
  + '<top style="thin"><color rgb="FFBFBFBF"/></top>'
  + '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFBFBFBF"/></left>'
  + '<right style="thin"><color rgb="FFBFBFBF"/></right>'
  + '<top style="double"><color rgb="FF1F3864"/></top>'
  + '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>'
  + '</borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="11">'
  // 0 plain
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  // 1 head
  + '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  // 2 date
  + '<xf numFmtId="14" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>'
  // 3 mid
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>'
  // 4 text
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'
  // 5 money
  + '<xf numFmtId="8" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
  // 6 pct
  + '<xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>'
  // 7 label
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  // 8 subtotal
  + '<xf numFmtId="8" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>'
  // 9 grand
  + '<xf numFmtId="8" fontId="2" fillId="2" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>'
  // 10 right
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/**
 * A sheet name Excel will accept.
 *
 * Five characters are forbidden and the limit is 31, and a file that breaks
 * either does not open at all -- so a rep with a long name silently costs
 * the whole statement unless it is cut here.
 */
export function sheetName(s) {
  const clean = String(s || 'Sheet1').replace(/[\\/?*[\]:]/g, '-').trim();
  return (clean || 'Sheet1').slice(0, 31);
}

function bookXml(name) {
  return XML + '<workbook xmlns="' + NS + '" xmlns:r="http://schemas.openxmlformats.org/'
    + 'officeDocument/2006/relationships"><sheets><sheet name="' + esc(sheetName(name))
    + '" sheetId="1" r:id="rId1"/></sheets>'
    // Every total is a formula with its answer cached. Asking for a full
    // calculation on load means the cached answer is checked rather than
    // trusted, so a stale one cannot survive being opened.
    + '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>';
}

export function sheetXml({ rows, widths, freeze }) {
  const body = [];
  const list = rows || [];
  let widest = 1;
  for (const r of list) if (r && r.length > widest) widest = r.length;

  for (let i = 0; i < list.length; i += 1) {
    const cells = list[i] || [];
    const n = i + 1;
    const parts = [];
    for (let c = 0; c < cells.length; c += 1) {
      const x = cellXml(cells[c], colName(c + 1) + n);
      if (x) parts.push(x);
    }
    // A row with nothing in it is still a row: skipping it would pull the
    // rows below it up and move every reference in every total.
    body.push('<row r="' + n + '">' + parts.join('') + '</row>');
  }

  const cols = (widths || []).map((w, i) => (w
    ? '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'
    : '')).join('');

  const pane = freeze
    ? '<pane ySplit="' + freeze + '" topLeftCell="A' + (freeze + 1)
      + '" activePane="bottomLeft" state="frozen"/>'
    : '';

  return XML + '<worksheet xmlns="' + NS + '">'
    + '<dimension ref="A1:' + colName(widest) + Math.max(list.length, 1) + '"/>'
    + '<sheetViews><sheetView workbookViewId="0">' + pane + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="14.4"/>'
    + (cols ? '<cols>' + cols + '</cols>' : '')
    + '<sheetData>' + body.join('') + '</sheetData>'
    + '</worksheet>';
}

/** The whole file. */
export function workbook({ name, rows, widths, freeze }) {
  return zip([
    { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
    { name: '_rels/.rels', data: utf8(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: utf8(bookXml(name)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(BOOK_RELS) },
    { name: 'xl/styles.xml', data: utf8(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheetXml({ rows, widths, freeze })) },
  ]);
}
