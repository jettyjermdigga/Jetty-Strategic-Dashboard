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
import { visibleTiles, dashCategories, linkCats, greeting } from './tiles.js';
import {
  rows as budgetRows, calendar as budgetCalendar,
  csv as budgetCsv, cleanYear, cleanLaborYear, cleanCadence, cleanBase,
  GROUPS as BUDGET_GROUPS, BASES, CADENCES, LINES as BUDGET_LINES,
  BASELINE_YEAR, WEEK_CURVE, CURVE_IS_PLACEHOLDER, FIRST_YEAR,
} from './budget.js';
import {
  rows as laborRows, summary as laborSummary, against as laborAgainst,
  csv as laborCsv, cleanKey as laborKey,
  withPrior as laborWithPrior, SHOWS as LABOR_SHOWS,
  PEOPLE as ROSTER, ROSTER_AS_OF, SEPARATE_DIVISIONS, PAY_TYPES, CLASSES,
  ROLLUPS, FULL_TIME_HOURS, FT_TYPES,
} from './labor.js';
import {
  ensureSchema, readCatalogue, readPeople, tilesFor,
  readLinks, cleanLink, saveLink, deleteLink, readMusic,
  readBudget, saveBudgetLine,
  readLabor, saveLaborPerson, removeLaborPerson, classifyPeople,
  cleanTile, cleanPerson, cleanKey, saveTile, deleteTile, savePerson, deletePerson,
  saveCategory, deleteCategory, saveGroup, deleteGroup,
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

// Who may open the budget.
//
// Its own list, NOT the tile assignment. A tile is a door not shown -- the
// doctrine this whole Worker is built on -- and the budget is the one thing
// behind this portal that needs a door that is actually shut: next year's
// payroll, partner draws and margin, line by line, before any of it is
// decided. Anyone not on this list gets a 404 from the endpoint whatever
// the People tab says.
//
// Left empty it falls back to the admins, so the list can never be
// accidentally empty -- which would lock Jeremy out of his own budget.
function budgetList(env) {
  const own = String(env.BUDGET_USERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return own.length ? own : adminList(env);
}

function canBudget(env, who) {
  return Boolean(who.email) && who.verified
    && budgetList(env).includes(who.email.toLowerCase());
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
      if (url.pathname === '/api/music') return await music(request, env, who);
      if (url.pathname.startsWith('/music/photo/')) {
        return await photo(request, env, who, url);
      }
      if (url.pathname.startsWith('/api/budget')) return await budget(request, env, url, who);
      if (url.pathname.startsWith('/api/labor')) return await labor(request, env, url, who);
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

  const visible = shutOut ? [] : visibleTiles(mine, cat.tiles);
  // Links go to every member of staff -- see the note on the table -- so
  // they are read whole rather than filtered. "Every member of staff" still
  // means staff, which is why an unverified request gets none of them.
  const links = shutOut ? [] : await readLinks(env.DB);

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
    tiles: shutOut ? [] : visible,
    // Every category, in order, each carrying what this person has in it and
    // whether that is anything at all. The page draws the whole row and lets
    // the closed ones sit there unclickable -- see dashCategories.
    cats: shutOut ? [] : dashCategories(visible, links, cat.categories),
    // The whole set, flat, so the Links & Forms column can filter on its own
    // without going back to the server. It is deliberately NOT tied to which
    // category is selected above: that row is about tiles, and a tile you do
    // not hold leaves its chip shut -- which would make the links filed
    // under it unreachable for exactly the people links are meant to be
    // open to.
    links: shutOut ? [] : links.map((l) => ({
      key: l.key, name: l.name, url: l.url, cats: linkCats(l),
    })),
  });
}

// The Music Monday archive. Behind the same Access as everything else, so
// nothing here is sent to a request that did not come through it -- the
// same rule /api/me follows.
async function music(request, env, who) {
  if (request.method !== 'GET') return json({ error: 'Read only.' }, 405);
  if (who.accessConfigured && !who.verified) {
    return json({ picks: [], reason: who.reason || '' });
  }
  return json({ picks: await readMusic(env.DB) });
}

// Music Monday artwork out of R2.
//
// Served through the Worker rather than from a public bucket, so the same
// Access that guards the rest of the portal guards the pictures. A bucket
// opened to the internet would be the one unauthenticated hole in it.
async function photo(request, env, who, url) {
  if (who.accessConfigured && !who.verified) return new Response(null, { status: 404 });
  if (!env.MUSIC) return new Response(null, { status: 404 });

  const key = decodeURIComponent(url.pathname.slice('/music/photo/'.length));
  // One pick a week, so a key is a date and an extension and nothing else.
  // Anything with a slash or a dot-dot in it is not asking for artwork.
  if (!/^\d{4}-\d{2}-\d{2}\.(webp|jpg|jpeg|png)$/.test(key)) {
    return new Response(null, { status: 404 });
  }

  const obj = await env.MUSIC.get(key);
  if (!obj) return new Response(null, { status: 404 });

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/webp',
      // Immutable in practice: the key is the week, and a week's picture
      // does not change. Private, because it is behind Access.
      'cache-control': 'private, max-age=86400',
      'etag': obj.httpEtag,
    },
  });
}

// ── The budget builder ──────────────────────────────────────────────────
//
// Reads the 2026 baseline out of the repo and the decisions out of D1, and
// answers with both plus the retail calendar it all hangs on. Writes one
// line at a time: there is no "save the budget" button, because a budget
// built over weeks must never depend on somebody remembering to press one.
async function budget(request, env, url, who) {
  if (!canBudget(env, who)) {
    // 404 rather than 403, the same as Setup: somebody without the budget
    // has no business learning it is here.
    return json({ error: 'No such endpoint.' }, 404);
  }

  const what = url.pathname.slice('/api/budget'.length);
  const year = cleanYear(url.searchParams.get('year')) || FIRST_YEAR;

  if (what === '' && request.method === 'GET') {
    return json({
      year,
      baselineYear: BASELINE_YEAR,
      first: FIRST_YEAR,
      you: who.email,
      groups: BUDGET_GROUPS,
      bases: BASES,
      cadences: CADENCES,
      lines: budgetRows(await readBudget(env.DB, year)),
      // Every cadence at once. It is four small arrays, it never changes
      // within a year, and sending it whole means switching view is
      // instant rather than another round trip.
      periods: budgetCalendar(year),
      curve: WEEK_CURVE,
      // Surfaced, not buried: the weekly shape is the one made-up number
      // in here, and the page says so rather than letting a weekly figure
      // look as settled as an annual one.
      curvePlaceholder: CURVE_IS_PLACEHOLDER,
    });
  }

  // The spreadsheet. A view the finance team can take into a meeting
  // without anybody needing a sign-in.
  if (what === '.csv' && request.method === 'GET') {
    const base = cleanBase(url.searchParams.get('base'));
    const cadence = cleanCadence(url.searchParams.get('view'));
    const body = budgetCsv(budgetRows(await readBudget(env.DB, year)), base, cadence, year);
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="jetty-budget-'
          + year + '-' + cadence + '.csv"',
        'cache-control': 'no-store',
      },
    });
  }

  if (what === '/line' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'That was not JSON.' }, 400);
    if (!BUDGET_LINES.some((l) => l.k === body.key)) {
      return json({ errors: ['No such line.'] }, 400);
    }
    const out = await saveBudgetLine(env.DB, year, body.key, body, who.email);
    if (out.errors) return json(out, 400);
    const lines = budgetRows(await readBudget(env.DB, year));
    // The whole set back, not just the row saved: the footer is a P&L over
    // all of them and the progress count is a count of all of them, so a
    // reply that only described one line would leave both to be guessed at.
    return json({ ok: true, lines });
  }

  return json({ error: 'No such endpoint.' }, 404);
}

// ── Labor planning ──────────────────────────────────────────────────────
//
// Behind the same lock as the budget, and for a stronger reason: this is
// every person's pay, by name. Nothing here is sent to a request that is
// not on BUDGET_USERS, and no figure in it exists anywhere but D1.
async function labor(request, env, url, who) {
  if (!canBudget(env, who)) return json({ error: 'No such endpoint.' }, 404);

  const what = url.pathname.slice('/api/labor'.length);
  const year = cleanYear(url.searchParams.get('year')) || FIRST_YEAR;
  // What next year is estimated from. One year back, always -- the plan is
  // "what changes from this year", and a baseline you can choose is a
  // baseline somebody will compare the wrong pair against.
  const baseYear = year - 1;

  if (what === '' && request.method === 'GET') {
    const saved = await readLabor(env.DB, year);
    const rs = laborWithPrior(laborRows(saved), await readLabor(env.DB, baseYear));
    const sum = laborSummary(rs);
    return json({
      year, baseYear, you: who.email,
      shows: LABOR_SHOWS,
      rosterAsOf: ROSTER_AS_OF, rosterSize: ROSTER.length,
      // Said on the page rather than left as a silently shorter list: two
      // people are missing from it on purpose.
      separate: SEPARATE_DIVISIONS.join(', '),
      payTypes: PAY_TYPES, classes: CLASSES, rollups: ROLLUPS,
      ftTypes: FT_TYPES,
      fullTimeHours: FULL_TIME_HOURS,
      people: rs,
      // What the budget tab currently says for the lines this rolls into.
      // Shown beside the plan, never written into it: the two are built by
      // the same person for the same year and should agree, but which one
      // is wrong on a given day is a judgement rather than arithmetic.
      against: laborAgainst(sum, await readBudget(env.DB, year), 'proj'),
    });
  }

  if (what === '.csv' && request.method === 'GET') {
    const body = laborCsv(
      laborWithPrior(laborRows(await readLabor(env.DB, year)),
                     await readLabor(env.DB, baseYear)),
      year, baseYear);
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="jetty-labor-' + year + '.csv"',
        'cache-control': 'no-store',
      },
    });
  }

  // Direct-or-G&A across a whole department. One call rather than thirteen,
  // and it touches only that field -- a figure already on a line is never
  // disturbed by classifying the department around it.
  if (what === '/classify' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'That was not JSON.' }, 400);

    const cls = String(body.cls || '');
    if (cls && !CLASSES.some((c) => c.key === cls)) {
      return json({ errors: ['No such kind of labor: ' + cls] }, 400);
    }

    // Only people this plan actually has. A key from anywhere else would
    // create a row for somebody who is not on the roster and never shows.
    const have = await readLabor(env.DB, year);
    const known = new Set([...ROSTER.map((p) => p.k), ...Object.keys(have)]);
    const keys = (Array.isArray(body.keys) ? body.keys : [])
      .map(laborKey).filter((k) => k && known.has(k));
    if (!keys.length) return json({ errors: ['Nobody to classify.'] }, 400);

    await classifyPeople(env.DB, year, keys, cls, who.email);
    const rs = laborWithPrior(laborRows(await readLabor(env.DB, year)),
                              await readLabor(env.DB, baseYear));
    return json({
      ok: true, set: keys.length, people: rs,
      against: laborAgainst(laborSummary(rs), await readBudget(env.DB, year), 'proj'),
    });
  }

  if ((what === '/person' || what === '/person/remove') && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'That was not JSON.' }, 400);

    // A write-in gets its key from its name, with a number on the end if
    // that name is taken -- the same rule tiles and links follow. A seeded
    // person keeps the key the roster gave them.
    let key = laborKey(body.key);
    if (!key && body.added) {
      const taken = new Set([...ROSTER.map((p) => p.k),
                             ...Object.keys(await readLabor(env.DB, year))]);
      const b = laborKey(body.name) || 'new-post';
      key = b;
      for (let n = 2; taken.has(key); n++) key = b + '-' + n;
    }
    if (!key) return json({ errors: ['That is not a person.'] }, 400);

    // Which year the figure belongs to. The baseline is recorded here as
    // well as the plan, so the grid edits both -- but only within the two
    // this page shows, and a year outside that is refused rather than
    // silently written to the plan.
    const onYear = body.year == null ? year : cleanLaborYear(body.year);
    if (!onYear || (onYear !== year && onYear !== baseYear)) {
      return json({ errors: ['That is not a year this plan holds.'] }, 400);
    }
    // Taking somebody off takes them off the plan, not off one year of it:
    // a person struck off who came back the moment you looked at the
    // baseline would be the same bug this codebase has had six times.
    const out = what === '/person/remove'
      ? await removeLaborPerson(env.DB, year, key, Boolean(body.added), who.email)
      : await saveLaborPerson(env.DB, onYear, key, body, who.email);
    if (out.errors) return json(out, 400);

    // The whole sheet back: the footer is a total over all of it and the
    // count is a count of all of it, so a reply about one person would
    // leave both to be guessed at.
    const saved = await readLabor(env.DB, year);
    const rs = laborWithPrior(laborRows(saved), await readLabor(env.DB, baseYear));
    return json({
      ok: true, key, people: rs,
      against: laborAgainst(laborSummary(rs), await readBudget(env.DB, year), 'proj'),
    });
  }

  return json({ error: 'No such endpoint.' }, 404);
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
    const out = cleanTile(body, cat.categories, cat.tiles.map((t) => t.key),
                          cat.tiles.find((t) => t.key === cleanKey(body && body.key)));
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
  if (what === 'category/delete') {
    const out = await deleteCategory(env.DB, body.key);
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
