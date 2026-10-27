// Undoing a migration that ran more than once.
//
// The Email/SMS split inserted a row per future send. Every migration before
// it only ever UPDATEd a row to a fixed value, so running twice did nothing;
// an INSERT run twice makes two.
//
// And it can run twice. The guard is "read meta, do the work, write meta",
// with a module-level flag in front of it -- and that flag is per isolate.
// Cloudflare starts as many isolates as it likes, so several can read an
// empty meta table at the same moment, all decide the split has not happened,
// and all insert. Nothing in the sequence is atomic.
//
// So: work out which SMS rows are surplus, and take those away. Pure -- no
// database, no clock. index.js does the deleting.

function subsOf(row) {
  return String((row && row.sub_types) || '').split(',')
    .map((x) => x.trim()).filter(Boolean);
}

/**
 * Which rows to delete, given every item in the calendar.
 *
 * Rows are grouped by the three things a copy shares with the item it was
 * copied from and that two unrelated sends would not: name, date and
 * department. Inside a group:
 *
 *   originals  the rows carrying Email. One per send that was split, since
 *              the split UPDATEd the original in place and gave it that key.
 *   copies     the rows carrying SMS and not Email -- what the split wrote.
 *
 * One copy per original is right. Anything beyond that is a second isolate's
 * work, and that many copies come off.
 *
 * Deliberately conservative in three ways. A group with no original is left
 * entirely alone: an SMS send somebody typed by hand has no Email twin, and
 * deleting it because it is unaccompanied would be the worse bug by far. A
 * row with files or comments on it is never deleted, even when it is surplus
 * -- the split attached neither, so a copy that has them is not a copy. And
 * a deadline is never touched; it is not a send.
 *
 * Which surplus copy goes is decided by id, lowest kept, so the answer does
 * not depend on the order the rows came back in.
 */
export function planSmsDedupe(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (row.deadline_for) continue;
    const subs = subsOf(row);
    const isCopy = subs.includes('sms') && !subs.includes('email');
    const isOriginal = subs.includes('email');
    if (!isCopy && !isOriginal) continue;
    const key = [row.title, row.start_date, row.department].join('\u0000');
    if (!groups.has(key)) groups.set(key, { originals: 0, copies: [] });
    const g = groups.get(key);
    if (isOriginal) g.originals += 1;
    else g.copies.push(row);
  }

  const out = [];
  for (const g of groups.values()) {
    if (!g.originals) continue;
    const surplus = g.copies.length - g.originals;
    if (surplus <= 0) continue;
    const spare = g.copies
      .filter((r) => !Number(r.attachment_count || 0) && !Number(r.comment_count || 0))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const take = Math.min(surplus, spare.length);
    for (const row of spare.slice(spare.length - take)) out.push(row.id);
  }
  return out;
}
