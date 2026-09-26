// The Jetty Company Calendar feed, for Google and Apple Calendar.
//
// A second Worker rather than another route on the calendar, because
// Cloudflare Access protects a Worker as a whole and cannot exempt one path on
// it. The calendar must sit behind Access; Google's fetchers cannot sign in.
// Splitting them is the only arrangement where both are true.
//
// This Worker serves exactly one thing, reads and never writes, and is guarded
// by an unguessable key. Anything else gets 404 -- not 403, which would confirm
// to a stranger that there is something here.

import { buildIcs } from '../worker/ics.js';
import { matches, feedName } from '../worker/filter.js';
import { DEPARTMENTS, EVENT_TYPES, SUB_TYPES, VEHICLES } from '../worker/taxonomy.js';

// A subscribed calendar carrying all 588 events -- including a hundred emails
// and a hundred SMS sends -- buries the reader's own diary. So the link carries
// the filters that were on screen when it was made, and the feed honours them.
function labelFor(axis, key) {
  if (key === 'none') return 'Unassigned';
  const list = axis === 'dept' ? DEPARTMENTS
    : axis === 'kind' ? EVENT_TYPES
    : axis === 'sub' ? SUB_TYPES
    : axis === 'veh' ? VEHICLES
    : [];
  const hit = list.find((x) => x.key === key);
  return hit ? hit.label : key;
}

const notFound = () => new Response('Not found\n', { status: 404 });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/calendar.ics') return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

    if (!env.DB) {
      return new Response('The calendar database is not bound to this Worker.\n', { status: 503 });
    }

    // One token per person, looked up rather than compared: a link that gets
    // out is reset for that one person without disturbing anybody else. The
    // token is the whole credential, so an unknown one gets 404 -- a 403 would
    // confirm to a stranger that there is something here.
    const token = url.searchParams.get('token') || '';
    if (!/^[0-9a-f]{64}$/.test(token)) return notFound();
    const feed = await env.DB.prepare('SELECT filters FROM feeds WHERE token = ?')
      .bind(token).first();
    if (!feed) return notFound();

    // Same ordering as the calendar's own list, so the two never disagree about
    // what comes first on a day.
    const res = await env.DB.prepare(
      'SELECT * FROM items ORDER BY start_date ASC, all_day DESC, start_time ASC, title ASC',
    ).all();

    let filters = {};
    try { filters = JSON.parse(feed.filters || '{}'); } catch (err) { filters = {}; }
    const items = (res.results || []).filter((it) => matches(it, filters));

    const body = buildIcs(items, {
      includeCancelled: false,
      // Named after what was asked for, so a sidebar full of Jetty feeds says
      // which is which rather than three identical entries.
      name: feedName(filters, labelFor),
    });
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'inline; filename="jetty-company-calendar.ics"',
        // Google refreshes on its own schedule regardless; this keeps a burst of
        // requests from hitting D1 ten times over.
        'cache-control': 'public, max-age=600',
        'x-content-type-options': 'nosniff',
      },
    });
  },
};
