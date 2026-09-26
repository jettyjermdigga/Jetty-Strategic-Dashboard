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

// Constant-time-ish comparison, so the key cannot be recovered a character at a
// time by timing the responses.
function keyMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const notFound = () => new Response('Not found\n', { status: 404 });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/calendar.ics') return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

    if (!env.ICS_KEY) {
      return new Response('The calendar feed is not configured yet.\n', { status: 503 });
    }
    if (!keyMatches(url.searchParams.get('key') || '', env.ICS_KEY)) return notFound();
    if (!env.DB) {
      return new Response('The calendar database is not bound to this Worker.\n', { status: 503 });
    }

    // Same ordering as the calendar's own list, so the two never disagree about
    // what comes first on a day.
    const res = await env.DB.prepare(
      'SELECT * FROM items ORDER BY start_date ASC, all_day DESC, start_time ASC, title ASC',
    ).all();

    const body = buildIcs(res.results || [], { includeCancelled: false });
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
