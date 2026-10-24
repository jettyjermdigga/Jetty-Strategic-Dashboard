// A notice the calendar writes to itself.
//
// Slack was the first answer to "tell SunnySide when a Paid Advo date
// moves", and it is still the better one -- a DM reaches somebody who is
// not looking at the calendar. But it only works for people who are in the
// Slack workspace, and Taylor is not. She can sign in to the calendar,
// because Access lets sunnysidecalifornia.com through; she just has no
// Slack account for a DM to land in.
//
// So the notice goes where she can actually reach it: a comment on the
// event itself, mentioning her, exactly as a person would have written it.
// That has three things going for it over a second delivery channel.
// The record lives with the event rather than in somebody's DMs. She can
// reply to it, in the place the answer belongs. And it keeps working the
// day she does get Slack -- the same watcher list drives both, so the DM
// simply starts arriving as well.
//
// Pure, and in its own file, because index.js imports schema.sql through a
// wrangler rule and cannot be loaded in Node.

import { eventWhen, eventWhere } from './slack.js';

// The author on an automatic comment.
//
// Not an address, and it cannot become one: every real author comes out of
// verified Access claims and those always contain an "@". So nothing a
// person could ever sign in as collides with this, and the page can render
// it as the calendar rather than as somebody with an odd name.
export const CALENDAR_AUTHOR = 'calendar';

export const isAutomatic = (author) => String(author || '') === CALENDAR_AUTHOR;

/**
 * What the automatic comment says.
 *
 * Plain text: this is read in a comment thread, not in Slack, so there is
 * no markup to add and none to escape -- the page escapes what it renders.
 *
 * It names the fields that moved, because "this event was edited" is a
 * notice people learn to scroll past, and which date it moved to is the
 * entire reason somebody outside the company is being told.
 */
export function noticeBody({ actorName, item, action, changed, label }) {
  const what = label || 'Paid Advo';
  const verb = action === 'created' ? 'added'
    : action === 'deleted' ? 'deleted'
    : 'changed';

  const head = (actorName || 'Someone') + ' ' + verb + ' this ' + what + ' item.';
  const lines = [];

  const when = eventWhen(item);
  const where = eventWhere(item);
  if (when) lines.push('When: ' + when);
  if (where) lines.push('Where: ' + where);
  if (item && item.status) lines.push('Status: ' + item.status);
  if (action === 'changed' && changed && changed.length) {
    lines.push('Changed: ' + changed.join(', '));
  }

  return lines.length ? head + '\n' + lines.join('\n') : head;
}

/**
 * A line for the "For you" list.
 *
 * The event's own title does the work, so the row leads with it rather than
 * with who wrote the comment -- somebody scanning this is looking for which
 * event needs them, not for who typed.
 */
export function noticeLine(row) {
  const title = String((row && row.title) || 'An event').trim();
  const date = String((row && row.start_date) || '').trim();
  return date ? title + ' · ' + date : title;
}

/** The first line of a comment, for a list that shows one line of each. */
export function summarise(body, max) {
  const first = String(body == null ? '' : body).split('\n')
    .map((l) => l.trim()).filter(Boolean)[0] || '';
  const n = max || 120;
  return first.length > n ? first.slice(0, n - 1).trimEnd() + '…' : first;
}

/**
 * How many of these are new to this person.
 *
 * A timestamp rather than a row per comment: "everything since you last
 * looked" is the question being asked, and one row per person answers it
 * without a table that grows with every comment ever written.
 *
 * Your own comments never count as unread. Mentioning yourself is a thing
 * people do by accident, and a badge you cannot clear by reading is worse
 * than no badge.
 */
export function countUnread(rows, seenAt, me) {
  const since = String(seenAt || '');
  const mine = String(me || '').toLowerCase();
  return (rows || []).filter((r) => {
    if (String(r.author || '').toLowerCase() === mine) return false;
    return !since || String(r.created_at || '') > since;
  }).length;
}
