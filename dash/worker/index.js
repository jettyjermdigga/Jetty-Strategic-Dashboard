// The Jetty Dash: one door, and behind it every tool a person is entitled to.
//
// Deliberately small. It holds no data of its own -- no database, no writes,
// no uploads -- because everything it points at already holds its own. What it
// does is answer one question per visitor: who are you, and what are you in?
// Everything else on the page follows from the answer.
//
// It is not the lock. Each tool behind it keeps its own Access policy, and a
// tile hidden here is a door not shown rather than a door shut. See tiles.js.

import { identify } from './access.js';
import { visibleTiles, greeting, GROUPS } from './tiles.js';

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    // Who you are and what you can see is per-person and changes the moment
    // somebody's groups change. Nothing about it may sit in a shared cache.
    'cache-control': 'no-store',
    'vary': 'cookie',
  },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/me') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Read only.' }, 405);
      }
      const who = await identify(request, env);
      const tiles = visibleTiles(who.groups);
      const body = {
        email: who.email,
        verified: who.verified,
        accessConfigured: who.accessConfigured,
        // Surfaced rather than swallowed: a portal that has quietly stopped
        // being able to read group membership looks exactly like a portal
        // somebody has been taken off, and the two need different responses.
        reason: who.reason || '',
        groupReason: who.groupReason || '',
        groups: who.groups,
        knownGroups: GROUPS,
        greeting: greeting(who.email),
        tiles,
      };
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
      }
      return json(body);
    }

    // The dash has no other API. Anything under /api that is not /api/me is a
    // mistake somewhere, and should say so rather than fall through to the
    // page and return HTML to something expecting JSON.
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'No such endpoint.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
