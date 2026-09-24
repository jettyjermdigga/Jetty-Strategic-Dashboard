// Jetty Company Calendar Worker.
//
// Standalone: its own Worker, its own hostname, its own deploy. It shares
// nothing with the Strategic Dashboard.
//
// The page itself is a static asset. This script exists for the parts that
// cannot be static: the read/write API on D1, the ICS feed Google Calendar
// subscribes to, and the check that nobody reaches any of it without having
// come through Cloudflare Access.

import { identify } from './access.js';
import { buildIcs } from './ics.js';
import { TAXONOMY, EVENT_TYPES, EVENT_TYPE_KEYS, SUB_TYPES, SUB_TYPE_KEYS,
         NEEDS, NEED_KEYS, STATUSES } from './taxonomy.js';
import { retailWeek, retailWeekStart } from './retail.js';
import SCHEMA from './schema.sql';

// Shown instead of the calendar when a request arrives with no Cloudflare
// Access identity. Self-contained on purpose: it has to render before any of
// this Worker's assets are allowed to load.
const NOT_PROTECTED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not available</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#F6F7F7;color:#252933;font:16px/1.65 ui-serif,Georgia,serif;padding:24px}
  @media (prefers-color-scheme:dark){body{background:#1b1e24;color:#EDECED}}
  .box{max-width:52ch}
  h1{font:700 22px/1.3 ui-sans-serif,system-ui,sans-serif;margin:0 0 12px}
  p{margin:0 0 12px}
  code{font:13px ui-monospace,monospace;background:rgba(127,127,127,.18);
    padding:1px 5px;border-radius:4px}
</style></head><body><div class="box">
<h1>This calendar is not available</h1>
<p>It is waiting on a Cloudflare Access application in front of this hostname.
Until one exists, no request carries a signed-in identity and nothing is served.</p>
<p>To switch it on: Zero Trust &rarr; Access &rarr; Applications &rarr; add a
self-hosted application for this hostname, then add the people who should be
able to open it. Add a <strong>Bypass</strong> policy for the single path
<code>/calendar.ics</code> so Google Calendar can still read the feed.</p>
</div></body></html>`;

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
  const pick = (k) => (input[k] != null ? input[k] : base[k]);

  // A multi-value axis: validate every key, drop duplicates, and store in
  // taxonomy order so two spellings of the same set become the same value.
  const multi = (field, allowed, label) => {
    const raw = pick(field);
    const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',');
    const picked = [];
    for (const item of list) {
      const key = clean(item, 60);
      if (!key) continue;
      if (!allowed.includes(key)) errors.push('Unknown ' + label + ' "' + key + '".');
      else if (!picked.includes(key)) picked.push(key);
    }
    picked.sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b));
    return picked;
  };

  out.title = clean(pick('title'), 200);
  if (!out.title) errors.push('Event name is required.');

  const types = multi('event_types', EVENT_TYPE_KEYS, 'Event Type');
  if (!types.length) errors.push('Pick at least one Event Type.');
  out.event_types = types.length ? types.join(',') : null;

  // Sub-types say what kind of item this is and apply to any calendar, so there
  // is nothing to scope them against.
  const subs = multi('sub_types', SUB_TYPE_KEYS, 'sub-type');
  out.sub_types = subs.length ? subs.join(',') : null;

  out.needs = ((n) => (n.length ? n.join(',') : null))(multi('needs', NEED_KEYS, 'need'));

  out.status = clean(pick('status'), 20) || 'Pending';
  if (!STATUSES.includes(out.status)) errors.push('Status must be Booked or Pending.');

  out.start_date = clean(pick('start_date'), 10);
  if (!out.start_date || !DATE_RE.test(out.start_date)) errors.push('Start date must be YYYY-MM-DD.');

  out.end_date = clean(pick('end_date'), 10) || out.start_date;
  if (!out.end_date || !DATE_RE.test(out.end_date)) errors.push('End date must be YYYY-MM-DD.');
  if (out.start_date && out.end_date && out.end_date < out.start_date) {
    errors.push('End date is before the start date.');
  }

  const allDayRaw = pick('all_day');
  out.all_day = (allDayRaw === false || allDayRaw === 0 || allDayRaw === '0' || allDayRaw === 'false') ? 0 : 1;

  out.start_time = clean(pick('start_time'), 5);
  out.end_time = clean(pick('end_time'), 5);
  if (out.all_day) {
    out.start_time = null;
    out.end_time = null;
  } else {
    if (!out.start_time || !TIME_RE.test(out.start_time)) errors.push('Start time must be HH:MM.');
    if (out.end_time && !TIME_RE.test(out.end_time)) errors.push('End time must be HH:MM.');
    if (out.start_time && out.end_time
        && out.start_date === out.end_date && out.end_time <= out.start_time) {
      errors.push('End time is not after the start time.');
    }
  }

  out.venue = clean(pick('venue'), 200);
  out.address = clean(pick('address'), 200);
  out.city = clean(pick('city'), 120);

  const st = clean(pick('state'), 2);
  out.state = st ? st.toUpperCase() : null;
  if (out.state && !/^[A-Z]{2}$/.test(out.state)) errors.push('State must be a two-letter code.');

  // Spreadsheets store zips as numbers, which eats the leading zero on every
  // NJ code -- 08260 comes back as 8260. Pad rather than reject.
  const zip = clean(pick('zip'), 10);
  out.zip = zip ? (/^\d{1,5}$/.test(zip) ? zip.padStart(5, '0') : zip) : null;
  if (out.zip && !/^\d{5}(-\d{4})?$/.test(out.zip)) errors.push('Zip must be 5 digits.');

  out.notes = clean(pick('notes'), 4000);
  out.url = clean(pick('url'), 500);
  if (out.url && !/^https?:\/\//i.test(out.url)) errors.push('Link must start with http:// or https://.');

  return { row: out, errors };
}

const COLS = [
  'title', 'event_types', 'sub_types', 'needs', 'status', 'start_date', 'end_date', 'all_day',
  'start_time', 'end_time', 'venue', 'address', 'city', 'state', 'zip', 'notes', 'url',
];

// Year / Week / Start (Week) / End (Week) / Month / Day are not stored; they are
// attached here so every reader sees the same values.
function withRetail(row) {
  return { ...row, all_day: row.all_day ? 1 : 0, retail: retailWeek(row.start_date) };
}

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
  return (res.results || []).map(withRetail);
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

// Headers as they actually appear on the Jetty sheets, alongside plainer
// spellings. Year / Week / Start (Week) / End (Week) / Month / Day are listed so
// an import can check them against the date rather than silently ignore them.
const IMPORT_ALIASES = {
  'name': 'title', 'title': 'title', 'event name': 'title', 'event': 'title',
  'booked': 'status', 'status': 'status',
  'event type': 'event_types', 'event types': 'event_types',
  'departments': 'event_types', 'department': 'event_types', 'tags': 'event_types',
  'sub-type': 'sub_types', 'sub type': 'sub_types', 'subtype': 'sub_types', 'sub-types': 'sub_types',
  'need': 'needs', 'needs': 'needs',
  'event \u{1F680}': 'start_date', 'start': 'start_date', 'start date': 'start_date', 'date': 'start_date',
  'event \u{1F6D1}': 'end_date', 'end': 'end_date', 'end date': 'end_date',
  'start \u{231A}': 'start_time', 'start time': 'start_time', 'event start time': 'start_time',
  'end \u{231A}': 'end_time', 'end time': 'end_time', 'event end time': 'end_time',
  'all day': 'all_day', 'allday': 'all_day',
  'venue': 'venue', 'address': 'address', 'city': 'city', 'state': 'state', 'zip': 'zip',
  'notes': 'notes', 'note': 'notes', 'url': 'url', 'link': 'url',
  // Checked against the event date, never stored.
  'year': '_year', 'week': '_week',
  'start (week)': '_week_start', 'end (week)': '_week_end',
  'month': '_month', 'day': '_day',
  // The sheet's Type column is what Airtable calls Type: the sub-type. Category
  // is read and discarded -- the axis it named no longer exists.
  'type': 'sub_types', 'category': '_ignored',
};

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// The sheet repeats facts that the event date already determines. Rather than
// drop those columns on import, compare them -- a disagreement is a typo worth
// naming, in the sheet or in the date.
function retailMismatches(rec) {
  const out = [];
  const d = rec.start_date;
  if (!d || !DATE_RE.test(d)) return out;
  const r = retailWeek(d);
  const parts = d.split('-').map(Number);
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const check = (given, actual, label) => {
    const g = String(given == null ? '' : given).trim();
    if (g && g.toUpperCase() !== String(actual).toUpperCase()) {
      out.push(label + ' says ' + g + ', but ' + d + ' is ' + actual);
    }
  };
  check(rec._year, r.year, 'Year');
  check(rec._week, r.week, 'Week');
  check(rec._week_start, r.start, 'Start (Week)');
  check(rec._week_end, r.end, 'End (Week)');
  check(rec._month, MONTH_ABBR[utc.getUTCMonth()], 'Month');
  check(rec._day, DOW_ABBR[utc.getUTCDay()], 'Day');
  return out;
}

function slugify(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Import files are written by people, not machines: accept the label, the key
// and the spelling the sheet actually uses.
function matchKey(list, raw) {
  const want = slugify(raw);
  if (!want) return null;
  const hit = list.find((x) => x.key === want
    || slugify(x.label) === want
    || (x.sheetValues || []).some((v) => slugify(v) === want));
  return hit ? hit.key : null;
}

// Comma or semicolon only. A slash is NOT a delimiter: real values contain one
// -- "Team Building / Culture / Building", "Photo/Vid", "Email/SMS" -- and
// splitting on it turns one Event Type into three unknown ones.
function splitList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : String(v).split(/[,;]+/)).map((x) => String(x).trim()).filter(Boolean);
}

function coerceKeys(rec) {
  // The sheet has one Event Type column, and not everything in it is an Event
  // Type: "JBC" is a reminder that the event wants our own branded beer. Route
  // anything that names a Need to the needs axis instead of rejecting the row.
  const rawTypes = splitList(rec.event_types);
  const rawNeeds = splitList(rec.needs);
  if (rawTypes.length || rawNeeds.length) {
    const types = [];
    const needs = rawNeeds.map((n) => matchKey(NEEDS, n) || n);
    for (const token of rawTypes) {
      const asType = matchKey(EVENT_TYPES, token);
      if (asType) { types.push(asType); continue; }
      const asNeed = matchKey(NEEDS, token);
      if (asNeed) { if (!needs.includes(asNeed)) needs.push(asNeed); continue; }
      types.push(token);   // unknown: let normalise() name it
    }
    rec.event_types = types;
    rec.needs = needs;
  }

  if (rec.sub_types != null) {
    rec.sub_types = splitList(rec.sub_types).map((x) => matchKey(SUB_TYPES, x) || x);
  }

  if (rec.status != null) {
    // The sheet's Booked column is a checkbox: ticked means booked, blank means
    // still being chased.
    const raw = String(rec.status).trim().toLowerCase();
    if (['checked', 'true', 'yes', 'y', 'x', '1', 'booked'].includes(raw)) rec.status = 'Booked';
    else if (!raw || ['unchecked', 'false', 'no', 'n', '0', 'pending'].includes(raw)) rec.status = 'Pending';
    else {
      const s2 = STATUSES.find((x) => x.toLowerCase() === raw);
      if (s2) rec.status = s2;
    }
  }

  // A row with times is not an all-day item.
  if (rec.all_day == null && (rec.start_time || rec.end_time)) rec.all_day = 0;

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
    let from = url.searchParams.get('from');
    let to = url.searchParams.get('to');
    const week = url.searchParams.get('week');
    if (week) {
      const year = url.searchParams.get('year') || TAXONOMY.retailEpochYear;
      const wkStart = retailWeekStart(year, week);
      if (!wkStart) return json({ error: 'week must be 1-53.' }, 400);
      const parts = wkStart.split('-').map(Number);
      from = wkStart;
      to = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 6)).toISOString().slice(0, 10);
    }
    return json({ items: await listItems(db, from, to) });
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

    return json({ item: withRetail({ id, ...row, created_by: who.email, created_at: now }) }, 201);
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
        header.forEach((key, i) => {
          if (!key || cells[i] == null || !cells[i].trim()) return;
          const val = cells[i].trim();
          // Type and Sub-type both feed the sub-type axis; a sheet can carry
          // either or both, so join instead of letting the last column win.
          rec[key] = (key === 'sub_types' && rec[key]) ? rec[key] + ',' + val : val;
        });
        return rec;
      });
      if (!records.length) return json({ error: 'No item rows found. Unrecognised columns: ' + (unknown.join(', ') || 'none') + '.' }, 400);
    } else {
      return json({ error: 'Send either { csv } or { items }.' }, 400);
    }

    // A year of a company calendar is legitimately ~600 rows -- the 2026 backfill
    // alone is 587 -- so the cap has to clear a full year or it bites every January.
    if (records.length > 2000) return json({ error: 'Import is capped at 2000 items per paste.' }, 400);

    // Validate everything before writing anything -- a half-applied import is
    // worse than a rejected one, because you cannot tell what landed.
    const rows = [];
    const problems = [];
    const warnings = [];
    records.forEach((rec, i) => {
      const coerced = coerceKeys({ ...rec });
      const { row, errors } = normalise(coerced, null);
      if (errors.length) {
        problems.push('Row ' + (i + 2) + ': ' + errors.join(' '));
        return;
      }
      // Not fatal: the item is fine, the sheet's own derived columns are not.
      retailMismatches({ ...coerced, start_date: row.start_date })
        .forEach((m) => warnings.push('Row ' + (i + 2) + ': ' + m));
      rows.push(row);
    });
    if (problems.length) return json({ error: 'Nothing was imported.', problems: problems.slice(0, 25) }, 400);

    const now = new Date().toISOString();
    const stmt = db.prepare(
      'INSERT INTO items (id,' + COLS.join(',') + ',created_by,created_at,updated_by,updated_at) '
      + 'VALUES (?' + ',?'.repeat(COLS.length + 4) + ')',
    );
    // D1 caps how many bound statements one batch may carry, so write in chunks.
    // Validation already passed for every row, so a chunk cannot fail on bad data.
    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.batch(rows.slice(i, i + BATCH).map((row) => stmt.bind(
        crypto.randomUUID(), ...COLS.map((c) => row[c]), who.email, now, who.email, now,
      )));
    }

    return json({ imported: rows.length, warnings: warnings.slice(0, 40) }, 201);
  }

  const idMatch = path.match(
    /^\/api\/items\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (idMatch) {
    const id = idMatch[1];
    const existing = await db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'No calendar item with that id.' }, 404);

    if (method === 'GET') return json({ item: withRetail(existing) });

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
      return json({ item: withRetail({ id, ...row, updated_by: who.email, updated_at: now }) });
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

    const who = await identify(request, env);

    // A new workers.dev hostname is reachable by anyone until an Access
    // application is put in front of it. Rather than depend on that happening
    // before anybody finds the URL, refuse every request that arrives without
    // an Access identity and explain what is missing. /calendar.ics is handled
    // above and is deliberately exempt -- Google's fetchers carry no session,
    // so the unguessable key is what protects that one path.
    if (env.REQUIRE_IDENTITY !== 'false' && !who.email) {
      if (url.pathname.startsWith('/api/')) {
        return json({ error: 'This request did not come through Cloudflare Access.' }, 403);
      }
      return new Response(NOT_PROTECTED_HTML, {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
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
