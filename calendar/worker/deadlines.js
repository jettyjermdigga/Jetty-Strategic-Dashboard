// Deadlines the calendar sets for itself.
//
// A Paid Advo placement has to be with SunnySide three weeks before it runs,
// and an email ten days before it goes out. Those are dates somebody was
// working out by hand on every item, which is the kind of arithmetic that is
// right until the week it is not.
//
// So the Worker keeps a Deadline item alongside the source item: created with
// it, moved when it moves, renamed when it is renamed, and removed when the
// sub-type comes off or the item is deleted. A deadline left behind pointing
// at a date nothing happens on is worse than no deadline at all, which is why
// the whole lifecycle lives here rather than only the create half.
//
// Pure: no database, no clock, no ids. index.js does the writing.

import { PAID_ADVO, EMAIL } from './taxonomy.js';

// What goes in front of the source item's own title. SunnySide is who the
// deadline is FOR -- the placement goes to them, and the email artwork with
// it -- so their name is what makes it read as somebody else's deadline
// rather than an internal note.
export const PREFIX = 'Sunnyside Deadline: ';

// Days ahead, by sub-type. SMS is deliberately absent: it was split off Email
// precisely because it does not carry this.
export const DEADLINE_LEADS = [
  { sub: PAID_ADVO, days: 21 },
  { sub: EMAIL, days: 10 },
];

export const WATCHED_SUBS = DEADLINE_LEADS.map((d) => d.sub);

function subsOf(row) {
  const raw = (row && row.sub_types) || '';
  return (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((x) => String(x).trim()).filter(Boolean);
}

/**
 * How many days ahead this item's deadline falls, or 0 for none.
 *
 * An item that is both a paid placement and an email takes the longer lead
 * rather than two deadlines: three weeks covers the ten days inside it, and
 * two items with the same name on two dates is the thing somebody works to
 * the wrong one of.
 */
export function leadFor(row) {
  const subs = subsOf(row);
  let days = 0;
  for (const rule of DEADLINE_LEADS) {
    if (subs.includes(rule.sub) && rule.days > days) days = rule.days;
  }
  return days;
}

/** Component-wise, because new Date('2026-01-01') is UTC midnight and lands
 *  on the previous day west of Greenwich. */
export function minusDays(ymd, days) {
  const p = String(ymd || '').split('-').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return '';
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function deadlineTitle(title) {
  // Trimmed to the same 200 the title column takes, with the prefix counted
  // in -- a 200-character name would otherwise make a 221-character one.
  return (PREFIX + String(title || '').trim()).slice(0, 200);
}

/**
 * The deadline row an item should have, or null for none.
 *
 * Deliberately not a full item: index.js merges this over whatever its own
 * normalise() produces for a Deadline, so the blanking rules stay in one
 * place rather than being restated here.
 */
export function deadlineFor(item) {
  const days = leadFor(item);
  if (!days) return null;
  const on = minusDays(item && item.start_date, days);
  if (!on) return null;
  return {
    title: deadlineTitle(item.title),
    event_type: 'deadline',
    // The source item's own department, so the deadline carries its colour
    // and turns up under the same filter. These are all Marketing today, but
    // reading it off the item means a Paid Advo on somebody else's event
    // still lands on their calendar rather than Marketing's.
    department: item.department,
    status: item.status === 'Cancelled' ? 'Cancelled' : 'Booked',
    start_date: on,
    end_date: on,
    all_day: 1,
    deadline_for: item.id,
  };
}

/**
 * What to do about the deadline on a write: 'create', 'update', 'delete' or
 * '' for nothing.
 *
 * `had` is the existing deadline row, if there is one. Passing the row rather
 * than a boolean is what lets this answer "nothing to do" for a save that did
 * not touch anything the deadline is built from -- which is most saves.
 */
export function deadlineAction(after, had) {
  const want = after ? deadlineFor(after) : null;
  if (!want) return had ? 'delete' : '';
  if (!had) return 'create';
  for (const k of ['title', 'start_date', 'end_date', 'status', 'department']) {
    if (String(had[k] == null ? '' : had[k]) !== String(want[k] == null ? '' : want[k])) {
      return 'update';
    }
  }
  return '';
}
