// "Add this to the Website Events page."
//
// A tick box on the event rather than a message somebody remembers to send.
// It lives in the needs list -- the same grid as Extra staff and Sound --
// because that is already the question "what does this event need from
// somebody else", and a second mechanism for the same question is how two
// lists come to disagree.
//
// Posted in a channel and addressed to one person, not DM'd. A website
// listing is work somebody else can pick up if Katie is away, and a DM is
// invisible to everyone who could.
//
// Pure, and in its own file, because index.js imports schema.sql through a
// wrangler rule and cannot be loaded in Node.

import { escapeSlack, eventWhen, eventWhere } from './slack.js';

export const WEBSITE_NEED = 'website-listing';

export const needed = (row) => String((row && row.needs) || '')
  .split(',').map((x) => x.trim()).includes(WEBSITE_NEED);

/**
 * What a website listing is made of.
 *
 * Deliberately shorter than the Paid Advo watch list. A note or a department
 * changing does not change what goes on the page, and a ping that fires on
 * every edit is one somebody filters within a fortnight.
 */
export const LISTING_FIELDS = [
  ['title', 'name'], ['start_date', 'start date'], ['end_date', 'end date'],
  ['start_time', 'start time'], ['end_time', 'end time'], ['all_day', 'all-day'],
  ['status', 'status'], ['venue', 'venue'], ['address', 'address'],
  ['city', 'city'], ['state', 'state'], ['zip', 'zip'], ['url', 'link'],
];

const moved = (before, after) => {
  const norm = (v) => (v == null || v === '' ? '' : String(v));
  return LISTING_FIELDS
    .filter(([c]) => norm(before && before[c]) !== norm(after && after[c]))
    .map(([, label]) => label);
};

/**
 * What to tell her, if anything. Returns { action, changed }.
 *
 *   add    -- the box has just been ticked, or an event arrived with it on
 *   update -- still ticked, and something that goes on the page moved
 *   remove -- the box came off, or the event is gone. The page does not
 *             know that on its own, and a listing for an event that is not
 *             happening is worse than one that was never added.
 *   ''     -- nothing worth saying. Opening an event and pressing save is
 *             not news, and neither is editing a field the page never shows.
 */
export function listingAction(before, after) {
  const was = needed(before);
  const now = needed(after);

  if (!was && !now) return { action: '', changed: [] };
  if (!was && now) return { action: 'add', changed: [] };
  if (was && !now) return { action: 'remove', changed: [] };

  const changed = moved(before, after);
  return changed.length ? { action: 'update', changed } : { action: '', changed: [] };
}

const HEAD = {
  add: 'please add to the *Website Events page*',
  update: 'this is on the *Website Events page* and it has changed',
  remove: 'please take this *off* the Website Events page',
};

/**
 * The channel message.
 *
 * `mentionId` is a Slack user id, so it arrives as a real mention that
 * notifies her. Everything taken off the event is escaped; the mention is
 * assembled afterwards, because escaping it would leave the literal text
 * <@U123> in the channel and nobody would be told at all.
 */
export function listingMessage({ actorName, item, action, changed, mentionId, url }) {
  const title = escapeSlack((item && item.title) || 'An event');
  const who = mentionId ? '<@' + mentionId + '> ' : '';

  const lines = [];
  const when = escapeSlack(eventWhen(item));
  const where = escapeSlack(eventWhere(item));
  if (when) lines.push('When: ' + when);
  if (where) lines.push('Where: ' + where);
  if (item && item.status) lines.push('Status: ' + escapeSlack(item.status));
  if (item && item.url) lines.push('Link: ' + escapeSlack(item.url));
  if (action === 'update' && changed && changed.length) {
    lines.push('Changed: ' + escapeSlack(changed.join(', ')));
  }

  const by = actorName ? ' (' + escapeSlack(actorName) + ')' : '';
  const head = who + (HEAD[action] || HEAD.add) + ': *' + title + '*' + by;
  // Nothing to open once it is deleted.
  const link = url && action !== 'remove'
    ? '\n\n<' + url + '|Open it on the Jetty calendar>' : '';
  return head + (lines.length ? '\n' + lines.map((l) => '• ' + l).join('\n') : '') + link;
}
