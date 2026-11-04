// Who gets told, the day before a deadline.
//
// A deadline carries a list of email addresses. The day before it falls,
// each of them is sent a reminder. The addresses are typed here because the
// people who need telling are not always on this calendar -- the Sunnyside
// deadlines are FOR an agency, and an artwork deadline is for whoever is
// drawing it.
//
// Nothing in here sends anything. It decides who should be told and what
// they should be told, which is the half that can be tested without a mail
// provider, a clock or a network. The sending is not built: see the README.
//
// Pure: no database, no clock, no ids.

import { minusDays } from './deadlines.js';

/** How far ahead of the deadline the reminder goes. */
export const REMIND_LEAD = 1;

/**
 * As many addresses as one deadline can carry.
 *
 * Not a technical limit. A reminder going to thirty people is a mailing
 * list somebody has built by accident, and the day it goes out wrong it
 * goes out wrong to thirty people.
 */
export const MAX_RECIPIENTS = 25;

// Deliberately not an RFC 5322 parser. It is looking for the shapes people
// actually mistype -- a name with no address, a missing dot, a stray comma
// caught inside the address -- and letting everything else through.
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

/**
 * The addresses on a deadline, as somebody typed them.
 *
 * Split on commas, semicolons and whitespace, because all three are what
 * comes out of a mail client when somebody copies a row of recipients.
 * Lower-cased and de-duplicated, so Katie@ and katie@ are one person and
 * get one email.
 */
export function cleanEmails(raw, errors) {
  const bad = errors || [];
  const list = [];
  const seen = new Set();
  const parts = (Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,;\s]+/))
    .map((x) => String(x).trim()).filter(Boolean);

  for (const part of parts) {
    const at = part.toLowerCase();
    if (!ADDRESS.test(at)) {
      bad.push('"' + part.slice(0, 60) + '" is not an email address.');
      continue;
    }
    if (at.length > 254) { bad.push('That address is too long to be one.'); continue; }
    if (seen.has(at)) continue;
    seen.add(at);
    list.push(at);
  }

  if (list.length > MAX_RECIPIENTS) {
    bad.push('That is more than ' + MAX_RECIPIENTS + ' addresses on one deadline.');
    return list.slice(0, MAX_RECIPIENTS);
  }
  return list;
}

/** The day the reminder for a deadline on `ymd` should go out. */
export function remindOn(ymd) {
  return minusDays(ymd, REMIND_LEAD);
}

export function recipientsOf(item) {
  const raw = (item && item.remind_emails) || '';
  return String(raw).split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Whether this item's reminder is owed on `today`.
 *
 * `>=` rather than `===` on the date, so a day the cron did not run is
 * caught up rather than skipped -- a reminder that arrives on the morning
 * of the deadline is late and still worth having, where one that never
 * arrives is the whole failure.
 *
 * A cancelled deadline is not reminded about, and one already reminded is
 * not reminded twice, which is what reminded_at is for.
 */
export function isDue(item, today) {
  const it = item || {};
  if (it.event_type !== 'deadline') return false;
  if (String(it.status || '') === 'Cancelled') return false;
  if (it.reminded_at) return false;
  if (!recipientsOf(it).length) return false;
  const on = remindOn(it.start_date);
  if (!on || !today) return false;
  // Not before the day it is due, and not after the deadline itself has
  // passed: nobody needs telling about a date that is behind them.
  return today >= on && today <= String(it.start_date || '');
}

export function dueReminders(rows, today) {
  return (rows || []).filter((r) => isDue(r, today));
}

const pretty = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
};

/**
 * What the reminder says.
 *
 * Here rather than wherever the sending ends up, so the wording is one
 * thing with a test on it rather than a template buried in a cron handler.
 * The deadline's own notes are the body: there is no second message field,
 * because a reminder that says something different from the calendar entry
 * is a second place to keep up to date.
 */
export function reminderText(item, today) {
  const it = item || {};
  const when = String(it.start_date || '');
  const days = when && today ? daysBetween(today, when) : null;
  const lead = days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'on ' + pretty(when);

  const subject = 'Reminder: ' + String(it.title || 'Deadline') + ' is due ' + lead;
  const lines = [String(it.title || 'Deadline') + ' is due ' + lead
    + (days === 0 ? '' : ' — ' + pretty(when)) + '.'];
  if (it.notes) lines.push('', String(it.notes));
  lines.push('', 'From the Jetty company calendar.');
  return { subject: subject.slice(0, 200), body: lines.join('\n') };
}

function daysBetween(from, to) {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
