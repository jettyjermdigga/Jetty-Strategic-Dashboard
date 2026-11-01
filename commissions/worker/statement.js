// A rep's month, as the sheet they are sent.
//
// This is a recreation of the file Amy has been sending by hand out of the
// Ledger: fourteen columns, the brand lines, then Jetty Ink underneath with
// its own total, then what the month comes to. The column order is hers and
// is not an accident -- reps have been reading it for years and a statement
// that arrives rearranged is a statement that gets queried.
//
// Pure. It takes payment rows and gives back the rows of a spreadsheet, so
// the arithmetic on a statement can be tested without a database, an R2
// bucket or a rep.

import { netInvoice, amountDue, cents } from './commission.js';
import { S, txt, mid, money, pct, date, sum, colName } from './xlsx.js';

export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                       'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const COLUMNS = [
  'Payment Date', 'Invoice #', 'Jetty Line', 'Retailer', 'Territory',
  'Sales Rep', 'Payment Type', '3% CC Fee', 'Original Invoice', 'Credits',
  'Net Invoice', 'Commission %', 'Amount Due', 'Notes',
];

// Widths taken off the file she sends, so the retailer column is wide
// enough for "Monkey Wrench Men & Women's Wear" without anybody dragging it.
const WIDTHS = [11.1, 10, 10, 27.8, 10, 14.1, 18.6, 10, 10.6, 10, 11.3, 11.7, 9.8, 24];

const MONEY_AT = 13;  // the Amount Due column, 1-based: where the totals go
const LABEL_AT = 12;  // the Commission % column, which the total is labelled in

export function monthOk(m) {
  const n = Number(m);
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

export function yearOk(y) {
  const n = Number(y);
  // Wide enough for backfill and narrow enough that a typo is caught. The
  // Ledger's history starts in 2019.
  return Number.isInteger(n) && n >= 2015 && n <= 2100;
}

/** '2026-SEP', which is how the Ledger has always named a month. */
export function periodLabel(year, month) {
  return String(year) + '-' + (MONTHS[Number(month) - 1] || '???');
}

/** The first and last day of the month, as the payments table stores them. */
export function periodRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: y + '-' + pad(m) + '-01', to: y + '-' + pad(m) + '-' + pad(last) };
}

/**
 * The file's name.
 *
 * `Total_Commissions-Nathan_Zelena-2026-SEP.xlsx`, which is what has landed
 * in reps' inboxes until now. Keeping it means a rep's folder sorts the new
 * ones in beside the old.
 */
export function fileName(repName, year, month) {
  const who = String(repName || 'rep').trim()
    .replace(/[^A-Za-z0-9 .()&-]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'rep';
  return 'Total_Commissions-' + who + '-' + periodLabel(year, month) + '.xlsx';
}

/** Where the file sits in R2. Year and month first, so a prefix listing is
 *  a month rather than a rep's whole history. */
export function objectKey(repKey, year, month) {
  return 'statements/' + year + '/' + String(month).padStart(2, '0') + '/'
    + String(repKey || 'rep') + '.xlsx';
}

/**
 * Brand lines and Ink lines.
 *
 * They are two sections on the sheet because they are two rates and two
 * businesses -- the reps earn 10% on wholesale and 2% on screen printing,
 * and showing one total over both hides which is which.
 */
export function split(rows) {
  const brand = [];
  const ink = [];
  for (const r of rows || []) (r && r.ink ? ink : brand).push(r);
  return { brand, ink };
}

const by = (a, b) => {
  const d = String(a.paid_on || '').localeCompare(String(b.paid_on || ''));
  if (d) return d;
  return String(a.invoice_no || '').localeCompare(String(b.invoice_no || ''));
};

/**
 * One payment, as fourteen cells.
 *
 * A Canadian row is the one place the sheet cannot be read straight down:
 * Net Invoice is in CAD and the rep is paid on the USD figure, so the two
 * do not multiply out. Rather than leave that looking like an arithmetic
 * error, the USD figure is said in the note.
 */
export function line(r, repName) {
  const note = [];
  if (r.notes) note.push(String(r.notes));
  if (r.cad) {
    note.push('Invoiced in ' + (r.currency || 'CAD')
      + '; commission paid on the USD net of ' + fmt(r.usd_net) + '.');
  }
  if (r.partial) note.push('Part payment.');
  return [
    date(r.paid_on),
    mid(r.invoice_no || ''),
    mid(r.jetty_line || ''),
    txt(r.retailer || r.customer || ''),
    mid(r.territory || ''),
    txt(repName || ''),
    txt(r.payment_method || ''),
    mid(r.cc_fee ? 'checked' : ''),
    money(r.gross == null ? null : cents(r.gross)),
    money(r.credits == null ? null : cents(r.credits)),
    money(netInvoice(r)),
    pct(r.commission_pct == null ? null : Number(r.commission_pct) / 100),
    money(amountDue(r)),
    txt(note.join(' ')),
  ];
}

function fmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '$0.00';
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const blank = () => [];

function headRow() {
  return COLUMNS.map((c) => txt(c, S.head));
}

/** A row that says what a run of lines came to, as a formula over them. */
function totalRow(firstRow, lastRow, value, style, label) {
  const row = [];
  const ref = colName(MONEY_AT) + firstRow + ':' + colName(MONEY_AT) + lastRow;
  row[LABEL_AT - 1] = txt(label, S.right);
  row[MONEY_AT - 1] = sum(ref, value, style);
  return row;
}

/**
 * The whole sheet.
 *
 * Returns the rows, the widths, and the figures the index needs -- the total
 * and how many lines are on it -- so the caller does not add it all up a
 * second time and get a different answer.
 */
export function build({ rep, year, month, rows }) {
  const name = (rep && rep.name) || '';
  const { brand, ink } = split(rows);
  brand.sort(by);
  ink.sort(by);

  const out = [headRow()];
  const at = () => out.length;        // the 1-based row the next push lands on

  let brandTotal = 0;
  let inkTotal = 0;

  const first = at() + 1;
  for (const r of brand) { out.push(line(r, name)); brandTotal = cents(brandTotal + amountDue(r)); }
  const brandLast = at();
  const hasBrand = brand.length > 0;
  const hasInk = ink.length > 0;

  // With both sections the sheet needs three totals; with one it needs one,
  // and a "total" repeating the subtotal underneath it is the sort of thing
  // that makes a rep ring up to ask which number is the real one.
  if (hasBrand && hasInk) {
    out.push(totalRow(first, brandLast, brandTotal, S.subtotal, 'Brand'));
  }

  let inkFirst = 0;
  let inkLast = 0;
  if (hasInk) {
    out.push(blank());
    const label = [];
    label[0] = txt('Jetty Ink', S.label);
    out.push(label);
    inkFirst = at() + 1;
    for (const r of ink) { out.push(line(r, name)); inkTotal = cents(inkTotal + amountDue(r)); }
    inkLast = at();
    if (hasBrand) out.push(totalRow(inkFirst, inkLast, inkTotal, S.subtotal, 'Jetty Ink'));
  }

  const total = cents(brandTotal + inkTotal);

  out.push(blank());
  const grand = [];
  grand[LABEL_AT - 1] = txt('Total due', S.right);
  if (hasBrand && hasInk) {
    // Two subtotals, so the grand total adds those two cells rather than
    // the lines again -- which is what makes it obvious on the sheet that
    // nothing has been counted twice.
    const a = colName(MONEY_AT) + (brandLast + 1);
    const b = colName(MONEY_AT) + (inkLast + 1);
    grand[MONEY_AT - 1] = { t: 'f', f: a + '+' + b, v: total, s: S.grand };
  } else {
    const lo = hasInk ? inkFirst : first;
    const hi = hasInk ? inkLast : brandLast;
    grand[MONEY_AT - 1] = rows && rows.length
      ? sum(colName(MONEY_AT) + lo + ':' + colName(MONEY_AT) + hi, total, S.grand)
      : money(0, S.grand);
  }
  out.push(grand);

  return {
    name: 'Total Commissions-' + name,
    rows: out,
    widths: WIDTHS,
    freeze: 1,
    total,
    lines: (rows || []).length,
    brandTotal,
    inkTotal,
  };
}
