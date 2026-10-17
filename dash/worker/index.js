// The Jetty Dash: one door, and behind it every tool a person is entitled to.
//
// It answers one question per visitor -- who are you, and what are you in --
// and draws the answer. Everything it points at keeps its own data and its own
// Access policy; the only thing the dash stores is the four lists somebody has
// to maintain: what tools exist, what kinds of work there are, what the
// permissions are called, and who holds them.
//
// It is not the lock. Each tool behind it keeps its own Access policy, and a
// tile hidden here is a door not shown rather than a door shut. See tiles.js.

import { identify } from './access.js';
import { canonicalTarget } from './canon.js';
import { visibleTiles, tileSections, withEmptyCategories, greeting } from './tiles.js';
import {
  ensureSchema, readCatalogue, readPeople, tilesFor,
  readLinks, linkSections, cleanLink, saveLink, deleteLink,
  cleanTile, cleanPerson, saveTile, deleteTile, savePerson, deletePerson,
  saveCategory, saveGroup, deleteGroup,
} from './store.js';

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

function adminList(env) {
  return String(env.DASH_ADMINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Editing the lists is a different permission from reading the page, and it
// is deliberately NOT one of the groups: the groups are data this list
// governs, so letting them govern it back would mean anybody who could edit
// the roster could grant themselves the right to edit the roster.
function isAdmin(env, who) {
  const admins = adminList(env);
  return Boolean(who.email) && who.verified && admins.includes(who.email.toLowerCase());
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Before anything else: are we even on the hostname Access guards? A
    // request that arrives here with no token on a second hostname never met
    // Access, and serving it would publish the portal round the side. See
    // canon.js. 302 rather than 301, because which hostname is canonical is
    // configuration and browsers cache a 301 more or less for ever.
    const go = canonicalTarget(
      request.url, env.CANONICAL_HOST,
      Boolean(request.headers.get('Cf-Access-Jwt-Assertion')),
    );
    if (go) return Response.redirect(go, 302);

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!env.DB) {
      return json({ error: 'The dash has no database bound, so it cannot read its lists.' }, 503);
    }

    try {
      await ensureSchema(env.DB);
      const who = await identify(request, env);
      if (url.pathname === '/api/me') return await me(request, env, who);
      if (url.pathname.startsWith('/api/admin/')) return await admin(request, env, url, who);
      return json({ error: 'No such endpoint.' }, 404);
    } catch (err) {
      return json({ error: 'Dash request failed: '
        + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};

async function me(request, env, who) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Read only.' }, 405);
  }
  const cat = await readCatalogue(env.DB);
  // null means "we could not establish who this is", which shows strictly
  // less than "known, and given nothing". Only a verified address is looked up.
  const mine = who.verified ? await tilesFor(env.DB, who.email) : null;
  const admin = isAdmin(env, who);

  // Access is in front, and this request did not come through it verified.
  //
  // That used to fall back to the tools marked open to everyone, on the
  // reasoning that they are open to everyone anyway. But "everyone" means
  // everyone on staff, and an unverified request is not staff -- it is
  // whoever found the address. The names of our tools and the links beside
  // them are a map of how the company works, and that map is not public.
  //
  // So it shows nothing at all and says why. Strictly less on an unknown
  // identity, which is the rule the rest of this file follows.
  const shutOut = who.accessConfigured && !who.verified;

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  }
  return json({
    email: who.email,
    verified: who.verified,
    accessConfigured: who.accessConfigured,
    // Surfaced rather than swallowed: a sign-in that cannot be verified looks
    // exactly like a portal somebody has been taken off, and the two need
    // different responses.
    reason: who.reason || '',
    isAdmin: admin,
    greeting: greeting(who.email),
    tiles: shutOut ? [] : visibleTiles(mine, cat.tiles),
    // An admin also gets the categories with nothing in them, flagged, so the
    // page shows the shape of what is being filled in rather than looking
    // broken while the catalogue is nearly empty. See withEmptyCategories.
    sections: shutOut ? []
      : (admin
          ? withEmptyCategories(tileSections(mine, cat.tiles, cat.categories), cat.categories)
          : tileSections(mine, cat.tiles, cat.categories)),
    // Links go to every member of staff -- see the note on the table. They
    // are sent whole rather than filtered, because there is nothing to
    // filter them by. "Every member of staff" still means staff, so an
    // unverified request gets none of them either.
    links: shutOut ? [] : linkSections(await readLinks(env.DB), cat.categories),
  });
}

async function admin(request, env, url, who) {
  if (!isAdmin(env, who)) {
    // 404 rather than 403: somebody who is not an admin has no business
    // learning that these endpoints exist, and the page never links to them.
    return json({ error: 'No such endpoint.' }, 404);
  }

  const what = url.pathname.slice('/api/admin/'.length);
  const cat = await readCatalogue(env.DB);

  if (request.method === 'GET' && what === 'all') {
    return json({
      tiles: cat.tiles,
      categories: cat.categories,
      links: await readLinks(env.DB),
      people: await readPeople(env.DB),
      admins: adminList(env),
      you: who.email,
    });
  }

  if (request.method !== 'POST') return json({ error: 'No such endpoint.' }, 404);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'That was not JSON.' }, 400);

  if (what === 'tile') {
    const out = cleanTile(body, cat.categories, cat.tiles.map((t) => t.key));
    if (out.errors) return json({ errors: out.errors }, 400);
    await saveTile(env.DB, out.row, who.email);
    return json({ ok: true, tile: out.row });
  }
  if (what === 'tile/delete') {
    await deleteTile(env.DB, body.key);
    return json({ ok: true });
  }
  if (what === 'person') {
    const out = cleanPerson(body, cat.tiles.map((t) => t.key));
    if (out.errors) return json({ errors: out.errors }, 400);
    await savePerson(env.DB, out.row, who.email);
    return json({ ok: true, person: out.row });
  }
  if (what === 'person/delete') {
    // Taking somebody off the roster does not take away their sign-in -- that
    // is the Access policy's job -- so they keep whatever is open to everyone.
    await deletePerson(env.DB, body.email);
    return json({ ok: true });
  }
  if (what === 'link') {
    const links = await readLinks(env.DB);
    const out = cleanLink(body, cat.categories, links.map((l) => l.key));
    if (out.errors) return json({ errors: out.errors }, 400);
    await saveLink(env.DB, out.row, who.email);
    return json({ ok: true, link: out.row });
  }
  if (what === 'link/delete') {
    await deleteLink(env.DB, body.key);
    return json({ ok: true });
  }
  if (what === 'category') {
    const out = await saveCategory(env.DB, body);
    return out.errors ? json(out, 400) : json(out);
  }
  if (what === 'group') {
    const out = await saveGroup(env.DB, body);
    return out.errors ? json(out, 400) : json(out);
  }
  if (what === 'group/delete') {
    await deleteGroup(env.DB, body.key);
    return json({ ok: true });
  }
  return json({ error: 'No such endpoint.' }, 404);
}
