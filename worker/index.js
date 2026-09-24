// Jetty site Worker.
//
// Static pages (landing, dashboard, calendar shell) are served straight from the
// build output by the assets binding. This script exists for the parts that
// cannot be static: the calendar's read/write API on D1, and the ICS feed that
// Google Calendar subscribes to.

import { identify } from './access.js';
import { buildIcs } from './ics.js';
import { TAXONOMY, CATEGORY_KEYS, DIVISION_KEYS, STATUSES, categoryByKey } from './taxonomy.js';
import SCHEMA from './schema.sql';

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  // Statements are idempotent, so running them on each cold start is cheaper
  // than carrying a migration step through the deploy workflow.
  for (const stmt of SCHEMA.split(';')) {
    const sql = stmt.trim();
    if (sql) await db.prepare(sql).run();
  }
  schemaReady = true;
}

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function clean(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max || 500);
}

// Turns whatever the form or import posted into a row we are willing to store,
// or an explanation of why we are not.
function normalise(input, existing) {
  const base = existing || {};
  const out = {};
  const errors = [];

  out.title = clean(input.title != null ? input.title : base.title, 200);
  if (!out.title) errors.push('Title is required.');

  out.category = clean(input.category != null ? input.category : base.category, 40);
  if (!out.category || !CATEGORY_KEYS.includes(out.category)) {
    errors.push('Category must be one of: ' + CATEGORY_KEYS.join(', ') + '.');
  }

  out.type = clean(input.type != null ? input.type : base.type, 60);
  const cat = categoryByKey(out.category);
  if (out.type && cat && !cat.types.includes(out.type)) {
    errors.push('"' + out.type + '" is not a type under ' + cat.label + '.');
  }

  out.division = clean(input.division != null ? input.division : base.division, 40);
  if (out.division && !DIVISION_KEYS.includes(out.division)) {
    errors.push('Unknown division "' + out.division + '".');
  }

  out.start_date = clean(input.start_date != null ? input.start_date : base.start_date, 10);
  if (!out.start_date || !DATE_RE.test(out.start_date)) errors.push('Start date must be YYYY-MM-DD.');

  out.end_date = clean(input.end_date != null ? input.end_date : base.end_date, 10) || out.start_date;
  if (!out.end_date || !DATE_RE.test(out.end_date)) errors.push('End date must be YYYY-MM-DD.');
  if (out.start_date && out.end_date && out.end_date < out.start_date) {
    errors.push('End date is before the start date.');
  }

  const allDayRaw = input.all_day != null ? input.all_day : base.all_day;
  out.all_day = (allDayRaw === false || allDayRaw === 0 || allDayRaw === '0' || allDayRaw === 'false') ? 0 : 1;

  out.start_time = clean(input.start_time != null ? input.start_time : base.start_time, 5);
  out.end_time = clean(input.end_time != null ? input.end_time : base.end_time, 5);
  if (out.all_day) {
    out.start_time = null;
    out.end_time = null;
  } else {
    if (!out.start_time || !TIME_RE.test(out.start_time)) errors.push('Start time must be HH:MM.');
    if (out.end_time && !TIME_RE.test(out.end_time)) errors.push('End time must be HH:MM.');
    if (out.start_time && out.end_time
        && out.start_date === out.end_date && out.end_time < out.start_time) {
      errors.push('End time is before the start time.');
    }
  }

  out.location = clean(input.location != null ? input.location : base.location, 200);
  out.owner = clean(input.owner != null ? input.owner : base.owner, 120);

  out.status = clean(input.status != null ? input.status : base.status, 20) || 'Confirmed';
  if (!STATUSES.includes(out.status)) errors.push('Unknown status "' + out.status + '".');

  out.notes = clean(input.notes != null ? input.notes : base.notes, 4000);
  out.url = clean(input.url != null ? input.url : base.url, 500);
  if (out.url && !/^https?:\/\//i.test(out.url)) errors.push('Link must start with http:// or https://.');

  return { row: out, errors };
}

const COLS = [
  'title', 'category', 'type', 'division', 'start_date', 'end_date', 'all_day',
  'start_time', 'end_time', 'location', 'owner', 'status', 'notes', 'url',
];

async function listItems(db, from, to) {
  // An item overlaps the window when it starts before the window ends and ends
  // after the window starts -- a plain start-date filter would drop multi-day
  // items already running when the month opened.
  let sql = 'SELECT * FROM items';
  const binds = [];
  if (from && to) {
    sql += ' WHERE start_date <= ? AND end_date >= ?';
    binds.push(to, from);
  } else if (from) {
    sql += ' WHERE end_date >= ?';
    binds.push(from);
  } else if (to) {
    sql += ' WHERE start_date <= ?';
    binds.push(to);
  }
  sql += ' ORDER BY start_date ASC, all_day DESC, start_time ASC, title ASC';
  const res = await db.prepare(sql).bind(...binds).all();
  return (res.results || []).map((r) => ({ ...r, all_day: r.all_day ? 1 : 0 }));
}

// Constant-time-ish comparison so the feed key cannot be recovered a character
// at a time by timing the responses.
function keyMatches(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCsv(text) {
  // Minimal RFC 4180 reader: handles quoted fields, embedded commas, doubled
  // quotes and CRLF. Enough for a spreadsheet paste, which is all this takes.
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const IMPORT_ALIASES = {
  title: 'title', name: 'title', event: 'title',
  category: 'category', type: 'type', 'event type': 'type',
  division: 'division', 'business unit': 'division',
  start: 'start_date', 'start date': 'start_date', date: 'start_date',
  end: 'end_date', 'end date': 'end_date',
  'all day': 'all_day', allday: 'all_day',
  'start time': 'start_time', 'end time': 'end_time',
  location: 'location', venue: 'location',
  owner: 'owner', status: 'status', notes: 'notes', note: 'notes',
  url: 'url', link: 'url',
};

function slugify(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Import files are written by people, not machines: accept the label as well as
// the key for category and division, so "Box Truck"/"events" and "Events" work.
function coerceKeys(rec) {
  if (rec.category) {
    const c = TAXONOMY.categories.find(
      (x) => x.key === slugify(rec.category) || slugify(x.label) === slugify(rec.category),
    );
    if (c) rec.category = c.key;
  }
  if (rec.division) {
    const d = TAXONOMY.divisions.find(
      (x) => x.key === slugify(rec.division) || slugify(x.label) === slugify(rec.division),
    );
    if (d) rec.division = d.key;
  }
  if (rec.status) {
    const s = STATUSES.find((x) => x.toLowerCase() === String(rec.status).trim().toLowerCase());
    if (s) rec.status = s;
  }
  return rec;
}

async function handleApi(request, env, url, who) {
  const db = env.DB;
  if (!db) {
    return json({ error: 'The calendar database is not bound to this Worker yet.' }, 503);
  }
  await ensureSchema(db);

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/items' && method === 'GET') {
    const items = await listItems(db, url.searchParams.get('from'), url.searchParams.get('to'));
    return json({ items });
  }

  const requireEditor = () => (who.canEdit
    ? null
    : json({ error: who.email
        ? 'Your account is not on the calendar editor list.'
        : 'Sign in to add calendar items.' }, 403));

  if (path === '/api/items' && method === 'POST') {
    const denied = requireEditor(); if (denied) return denied;
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Expected a JSON body.' }, 400);

    const { row, errors } = normalise(coerceKeys(body), null);
    if (errors.length) return json({ error: errors.join(' ') }, 400);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      'INSERT INTO items (id,' + COLS.join(',') + ',created_by,created_at,updated_by,updated_at) '
      + 'VALUES (?' + ',?'.repeat(COLS.length + 4) + ')',
    ).bind(id, ...COLS.map((c) => row[c]), who.email, now, who.email, now).run();

    return json({ item: { id, ...row, created_by: who.email, created_at: now } }, 201);
  }

  if (path === '/api/items/import' && method === 'POST') {
    const denied = requireEditor(); if (denied) return denied;
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Expected a JSON body.' }, 400);

    let records = [];
    if (Array.isArray(body.items)) {
      records = body.items;
    } else if (typeof body.csv === 'string') {
      const rows = parseCsv(body.csv);
      if (rows.length < 2) return json({ error: 'The paste needs a header row and at least one item.' }, 400);
      const header = rows[0].map((h) => IMPORT_ALIASES[h.trim().toLowerCase()] || null);
      const unknown = rows[0].filter((h, i) => h.trim() && !header[i]);
      records = rows.slice(1).map((cells) => {
        const rec = {};
        header.forEach((key, i) => { if (key && cells[i] != null && cells[i].trim()) rec[key] = cells[i].trim(); });
        return rec;
      });
      if (!records.length) return json({ error: 'No item rows found. Unrecognised columns: ' + (unknown.join(', ') || 'none') + '.' }, 400);
    } else {
      return json({ error: 'Send either { csv } or { items }.' }, 400);
    }

    if (records.length > 500) return json({ error: 'Import is capped at 500 items per paste.' }, 400);

    // Validate everything before writing anything -- a half-applied import is
    // worse than a rejected one, because you cannot tell what landed.
    const rows = [];
    const problems = [];
    records.forEach((rec, i) => {
      const { row, errors } = normalise(coerceKeys({ ...rec }), null);
      if (errors.length) problems.push('Row ' + (i + 2) + ': ' + errors.join(' '));
      else rows.push(row);
    });
    if (problems.length) return json({ error: 'Nothing was imported.', problems: problems.slice(0, 25) }, 400);

    const now = new Date().toISOString();
    const stmt = db.prepare(
      'INSERT INTO items (id,' + COLS.join(',') + ',created_by,created_at,updated_by,updated_at) '
      + 'VALUES (?' + ',?'.repeat(COLS.length + 4) + ')',
    );
    await db.batch(rows.map((row) => stmt.bind(
      crypto.randomUUID(), ...COLS.map((c) => row[c]), who.email, now, who.email, now,
    )));

    return json({ imported: rows.length }, 201);
  }

  const idMatch = path.match(
    /^\/api\/items\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (idMatch) {
    const id = idMatch[1];
    const existing = await db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'No calendar item with that id.' }, 404);

    if (method === 'GET') return json({ item: existing });

    const denied = requireEditor(); if (denied) return denied;

    if (method === 'DELETE') {
      await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
      return json({ deleted: id });
    }

    if (method === 'PATCH' || method === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'Expected a JSON body.' }, 400);
      const { row, errors } = normalise(coerceKeys(body), existing);
      if (errors.length) return json({ error: errors.join(' ') }, 400);
      const now = new Date().toISOString();
      await db.prepare(
        'UPDATE items SET ' + COLS.map((c) => c + ' = ?').join(', ')
        + ', updated_by = ?, updated_at = ? WHERE id = ?',
      ).bind(...COLS.map((c) => row[c]), who.email, now, id).run();
      return json({ item: { id, ...row, updated_by: who.email, updated_at: now } });
    }

    return json({ error: 'Method not allowed.' }, 405);
  }

  return json({ error: 'Unknown endpoint.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The ICS feed is fetched by Google's servers, which carry no Access
    // session, so it authenticates on an unguessable key instead. Without a key
    // configured the feed stays closed rather than defaulting to public.
    if (url.pathname === '/calendar.ics') {
      if (!env.ICS_KEY) {
        return new Response('The calendar feed is not configured yet.\n', { status: 503 });
      }
      if (!keyMatches(url.searchParams.get('key') || '', env.ICS_KEY)) {
        return new Response('Not found\n', { status: 404 });
      }
      if (!env.DB) return new Response('The calendar database is not bound yet.\n', { status: 503 });
      await ensureSchema(env.DB);
      const items = await listItems(env.DB, null, null);
      return new Response(buildIcs(items, { includeCancelled: false }), {
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': 'inline; filename="jetty-company-calendar.ics"',
          'cache-control': 'public, max-age=600',
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      const who = await identify(request, env);

      if (url.pathname === '/api/taxonomy') return json(TAXONOMY);
      if (url.pathname === '/api/me') {
        return json({
          email: who.email,
          canEdit: who.canEdit,
          verified: who.verified,
          accessConfigured: who.accessConfigured,
          editorsConfigured: who.editorsConfigured,
          feedConfigured: Boolean(env.ICS_KEY),
          // Anyone Access has let in can already read the calendar, so handing
          // them the feed key grants nothing new -- but it stays out of the
          // response for anonymous callers.
          feedUrl: (env.ICS_KEY && who.email)
            ? url.origin + '/calendar.ics?key=' + encodeURIComponent(env.ICS_KEY)
            : null,
        });
      }

      try {
        return await handleApi(request, env, url, who);
      } catch (err) {
        return json({ error: 'Calendar request failed: ' + (err && err.message ? err.message : String(err)) }, 500);
      }
    }

    // Everything else is a built page.
    return env.ASSETS.fetch(request);
  },
};
