// ICS feed generation.
//
// Google Calendar subscribes to this by URL, so the output has to be valid
// enough for a strict parser: CRLF line endings, folding at 75 octets, escaped
// text values, and a real VTIMEZONE so timed items land at the right hour
// rather than drifting by the viewer's offset.

import { CATEGORIES, DEPARTMENTS } from './taxonomy.js';

const TZID = 'America/New_York';

// Rows store taxonomy keys; a subscriber reading this in Google Calendar
// wants the labels.
function label(list, key) {
  const hit = list.find((x) => x.key === key);
  return hit ? hit.label : key;
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:' + TZID,
  'X-LIC-LOCATION:' + TZID,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 folds on octets, not characters, so measure the UTF-8 length.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ' ' + ch;
      curBytes = 1 + n;
      limit = 75;
    } else {
      cur += ch;
      curBytes += n;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n');
}

function compact(dateStr) {
  return String(dateStr).replace(/-/g, '');
}

// DTEND on an all-day VEVENT is exclusive, so a one-day item ending on the
// 15th has to say the 16th or it renders as zero-length in some clients.
function dayAfter(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildIcs(items, opts) {
  const o = opts || {};
  const name = o.name || 'Jetty Company Calendar';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jetty//Company Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(name),
    'X-WR-TIMEZONE:' + TZID,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE,
  ];

  const now = stamp();
  for (const it of items) {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + esc(it.id) + '@jetty-calendar');
    lines.push('DTSTAMP:' + now);

    if (it.all_day) {
      lines.push('DTSTART;VALUE=DATE:' + compact(it.start_date));
      lines.push('DTEND;VALUE=DATE:' + compact(dayAfter(it.end_date)));
    } else {
      const s = (it.start_time || '09:00').replace(':', '') + '00';
      const e = (it.end_time || it.start_time || '10:00').replace(':', '') + '00';
      lines.push('DTSTART;TZID=' + TZID + ':' + compact(it.start_date) + 'T' + s);
      lines.push('DTEND;TZID=' + TZID + ':' + compact(it.end_date) + 'T' + e);
    }

    const prefix = it.status === 'Pending' ? '[Pending] ' : '';
    lines.push('SUMMARY:' + esc(prefix + it.title));

    const descParts = [];
    if (it.category) descParts.push('Type: ' + label(CATEGORIES, it.category));
    if (it.departments) {
      descParts.push('Event Type: ' + it.departments.split(',')
        .map((d) => label(DEPARTMENTS, d.trim())).join(', '));
    }
    if (it.status) descParts.push('Status: ' + it.status);
    const where = [it.venue, it.address,
                   [it.city, it.state].filter(Boolean).join(', '), it.zip]
      .filter(Boolean).join(' \u00b7 ');
    if (where) descParts.push('Where: ' + where);
    if (it.notes) descParts.push('', it.notes);
    if (descParts.length) lines.push('DESCRIPTION:' + esc(descParts.join('\n')));

    const loc = [it.venue, it.address, [it.city, it.state].filter(Boolean).join(', '), it.zip]
      .filter(Boolean).join(', ');
    if (loc) lines.push('LOCATION:' + esc(loc));
    if (it.url) lines.push('URL:' + esc(it.url));
    lines.push('CATEGORIES:' + esc([
      it.category && label(CATEGORIES, it.category),
      ...(it.departments ? it.departments.split(',').map((d) => label(DEPARTMENTS, d.trim())) : []),
    ].filter(Boolean).join(',')));
    lines.push('STATUS:' + (it.status === 'Booked' ? 'CONFIRMED' : 'TENTATIVE'));
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
