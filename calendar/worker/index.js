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
import { SOCIAL_TYPE_KEYS, CHANNEL_KEYS, PILLAR_KEYS, PRODUCTION_KEYS } from './taxonomy.js';
import { TAXONOMY, EVENT_TYPES, EVENT_TYPE_KEYS, DEPARTMENTS, DEPARTMENT_KEYS,
         SUB_TYPES, SUB_TYPE_KEYS, NEEDS, NEED_KEYS, VEHICLES, VEHICLE_KEYS,
         STATUSES, PRIMACY } from './taxonomy.js';
import { retailWeek, retailWeekStart } from './retail.js';
import { sqlStatements } from './sql.js';
import { planMigration, mergeSubTypes, mergeFeedFilters, promoteSocial,
         splitKind } from './migrate.js';
import { normaliseProducts } from './products.js';
import { commentMessage, dmMentions, displayName, eventUrl,
         fetchSlackPeople, slackHint } from './slack.js';
import SCHEMA from './schema.sql';
import SOCIAL_BACKFILL from '../backfill/social.json';

// Shown instead of the calendar when a request arrives with no Cloudflare
// Access identity. Self-contained on purpose: it has to render before any of
// this Worker's assets are allowed to load.
// Shown when a request arrives with no verified identity. It takes the reason
// from identify() rather than asserting one: this page used to state flatly
// that no Access application existed, which sent an afternoon into the wrong
// dashboard while the real cause was a token the Worker was refusing.
function notAvailableHtml(reason) {
  return NOT_PROTECTED_HTML.replace('<!--REASON-->', reason
    ? '<p class="why"><strong>What this Worker saw:</strong> ' + escHtml(reason) + '</p>'
    : '');
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

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
    padding:1px 5px;border-radius:4px;word-break:break-all}
  .why{font:13.5px/1.6 ui-monospace,monospace;background:rgba(127,127,127,.12);
    padding:10px 12px;border-radius:6px;word-break:break-word}
</style></head><body><div class="box">
<h1>This calendar is not available</h1>
<p>No request reaching this Worker carried a signed-in identity, so nothing is
served.</p>
<!--REASON-->
<p>Usually that means there is no Cloudflare Access application in front of this
hostname: Zero Trust &rarr; Access &rarr; Applications &rarr; add a self-hosted
application for it, then add the people who should be able to open it. If one
already exists, the line above says what the Worker made of what it was sent.</p>
<p>The Google Calendar feed is a separate Worker, outside this one, because
Access protects a Worker whole and Google cannot sign in.</p>
</div></body></html>`;

let schemaReady = false;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an
// existing table alone, so a live database only gets them this way. Re-adding a
// column that is already there is the expected case, not a failure.
const ADDED_COLUMNS = [
  'event_type TEXT', 'department TEXT', 'departments TEXT',
  'staff_count TEXT', 'vehicles TEXT', 'products TEXT',
  'social_type TEXT', 'channels TEXT', 'pillar TEXT', 'production TEXT',
  'caption TEXT', 'tags TEXT', 'orders INTEGER', 'net_revenue REAL',
];

// Same idea, on the attachments table.
const ADDED_ATTACHMENT_COLUMNS = ['slot TEXT'];

async function ensureSchema(db) {
  if (schemaReady) return;
  // Statements are idempotent, so running them on each cold start is cheaper
  // than carrying a migration step through the deploy workflow.
  for (const sql of sqlStatements(SCHEMA)) {
    await db.prepare(sql).run();
  }
  for (const [table, cols] of [['items', ADDED_COLUMNS], ['attachments', ADDED_ATTACHMENT_COLUMNS]]) {
    for (const col of cols) {
      try {
        await db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + col).run();
      } catch (err) {
        // "duplicate column name" every time after the first, and on any database
        // created from the current schema. Anything else is worth surfacing.
        if (!/duplicate column/i.test(String(err && err.message))) throw err;
      }
    }
  }
  await migrateToDecisionTree(db);
  await migrateSubTypeMerges(db);
  await migrateSocialKind(db);
  await migrateKindSplit(db);
  await backfillSocial(db);
  schemaReady = true;
}

// One-time: move every stored row off the old no-primary "Event Type" axis onto
// Event Type + primary department + additional departments. Guarded by a row in
// meta, so it runs once and never again.
const MIGRATION_KEY = 'decision-tree-2026-09';

async function migrateToDecisionTree(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(MIGRATION_KEY).first();
  if (done) return;

  // Only rows that have never been through this. The meta guard already says
  // "done", but a guard is a single point of failure and this one rewrites
  // department on every row it touches -- so a re-run would silently undo any
  // department set by hand afterwards, which is a far worse failure than
  // running twice. Selecting on event_type makes a re-run a no-op instead.
  const res = await db.prepare(
    "SELECT id, event_types, sub_types, needs FROM items "
    + "WHERE event_type IS NULL OR event_type = ''").all();
  const rows = res.results || [];

  const stmt = db.prepare(
    'UPDATE items SET event_type = ?, department = ?, departments = ?, '
    + 'sub_types = ?, needs = ?, vehicles = ? WHERE id = ?');

  const counts = { rows: rows.length, guessed: 0, noDepartment: 0, vehicles: 0 };
  const batch = [];
  for (const row of rows) {
    const plan = planMigration(row);
    if (plan.guessedPrimary) counts.guessed++;
    if (!plan.department) counts.noDepartment++;
    if (plan.vehicles) counts.vehicles++;
    batch.push(stmt.bind(
      plan.event_type, plan.department, plan.departments,
      plan.sub_types, plan.needs, plan.vehicles, row.id,
    ));
  }

  // D1 caps how much one batch may carry, and a year of events is well past it.
  const BATCH = 200;
  for (let i = 0; i < batch.length; i += BATCH) {
    await db.batch(batch.slice(i, i + BATCH));
  }

  await db.prepare(
    'INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(MIGRATION_KEY, JSON.stringify(counts), new Date().toISOString()).run();
}

// Fold the merged sub-types (see SUB_TYPE_MERGES) onto their single key, on
// stored events and on the saved calendar-sync selections that named the old
// ones. The key carries the merge set, so adding a pair to the map and bumping
// this runs the fold again -- which is safe, because it is idempotent.
const SUB_MERGE_KEY = 'sub-type-merges-2026-10b';

async function migrateSubTypeMerges(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(SUB_MERGE_KEY).first();
  if (done) return;

  // Every row that has a sub-type at all, rather than a LIKE per merged key
  // that has to be kept in step with the map. Only the rows that actually
  // change are written. Unlike the decision-tree migration this one cannot
  // destroy a later edit -- it only ever folds two keys into one and leaves
  // every other sub-type in place.
  const res = await db.prepare(
    "SELECT id, sub_types FROM items WHERE sub_types IS NOT NULL AND sub_types != ''").all();
  const rows = res.results || [];

  const stmt = db.prepare('UPDATE items SET sub_types = ? WHERE id = ?');
  const batch = [];
  for (const row of rows) {
    const merged = mergeSubTypes(row.sub_types);
    if (merged !== row.sub_types) batch.push(stmt.bind(merged, row.id));
  }
  const BATCH = 200;
  for (let i = 0; i < batch.length; i += BATCH) {
    await db.batch(batch.slice(i, i + BATCH));
  }

  // Somebody subscribing to just the email sends, or just the promotions,
  // should keep getting them rather than quietly receiving nothing.
  const feeds = await db.prepare('SELECT token, filters FROM feeds').all();
  const feedStmt = db.prepare('UPDATE feeds SET filters = ? WHERE token = ?');
  const feedBatch = [];
  for (const f of feeds.results || []) {
    const next = mergeFeedFilters(f.filters);
    if (next) feedBatch.push(feedStmt.bind(next, f.token));
  }
  if (feedBatch.length) await db.batch(feedBatch);

  await db.prepare(
    'INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(SUB_MERGE_KEY, JSON.stringify({ items: batch.length, feeds: feedBatch.length }),
          new Date().toISOString()).run();
}

// One-time: anything tagged with the old Social sub-type becomes an event of
// kind Social. Guarded by meta, and safe to re-run -- a row that has already
// moved no longer carries the sub-type, so it is not selected a second time.
const SOCIAL_KIND_KEY = 'social-event-type-2026-10';

async function migrateSocialKind(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(SOCIAL_KIND_KEY).first();
  if (done) return;

  const res = await db.prepare(
    "SELECT id, sub_types FROM items WHERE sub_types LIKE '%social%'").all();
  const stmt = db.prepare('UPDATE items SET event_type = ?, sub_types = ? WHERE id = ?');
  const batch = [];
  for (const row of res.results || []) {
    const next = promoteSocial(row);
    if (next) batch.push(stmt.bind(next.event_type, next.sub_types, row.id));
  }
  const BATCH = 200;
  for (let i = 0; i < batch.length; i += BATCH) {
    await db.batch(batch.slice(i, i + BATCH));
  }

  // A saved calendar sync asking for the Social sub-type would otherwise go
  // quiet, since nothing carries that sub-type any more.
  const feeds = await db.prepare('SELECT token, filters FROM feeds').all();
  const feedStmt = db.prepare('UPDATE feeds SET filters = ? WHERE token = ?');
  const feedBatch = [];
  for (const f of feeds.results || []) {
    let parsed;
    try { parsed = JSON.parse(f.filters || '{}'); } catch (e) { continue; }
    if (!parsed || !Array.isArray(parsed.sub) || !parsed.sub.includes('social')) continue;
    const sub = parsed.sub.filter((k) => k !== 'social');
    const kind = Array.isArray(parsed.kind) ? parsed.kind.slice() : [];
    if (!kind.includes('social')) kind.push('social');
    feedBatch.push(feedStmt.bind(JSON.stringify({ ...parsed, sub, kind }), f.token));
  }
  if (feedBatch.length) await db.batch(feedBatch);

  await db.prepare(
    'INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(SOCIAL_KIND_KEY, JSON.stringify({ items: batch.length, feeds: feedBatch.length }),
          new Date().toISOString()).run();
}

// One-time: Event and Marketing were one kind, Meeting and Deadline another.
// See splitKind for how each stored row is placed. Guarded by meta, and safe to
// re-run -- a row that has already moved no longer carries an old key.
const KIND_SPLIT_KEY = 'kind-split-2026-10';

async function migrateKindSplit(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(KIND_SPLIT_KEY).first();
  if (done) return;

  const res = await db.prepare(
    "SELECT id, event_type, sub_types, venue, address, city FROM items "
    + "WHERE event_type IN ('events-marketing', 'meetings-deadlines')").all();
  const stmt = db.prepare('UPDATE items SET event_type = ? WHERE id = ?');
  const counts = { event: 0, marketing: 0, meeting: 0 };
  const batch = [];
  for (const row of res.results || []) {
    const next = splitKind(row);
    if (!next) continue;
    counts[next] = (counts[next] || 0) + 1;
    batch.push(stmt.bind(next, row.id));
  }
  const BATCH = 200;
  for (let i = 0; i < batch.length; i += BATCH) {
    await db.batch(batch.slice(i, i + BATCH));
  }

  // A saved sync asking for a kind that no longer exists would go quiet. The
  // old key covered both halves, so both are subscribed rather than guessing.
  const feeds = await db.prepare('SELECT token, filters FROM feeds').all();
  const feedStmt = db.prepare('UPDATE feeds SET filters = ? WHERE token = ?');
  const feedBatch = [];
  for (const f of feeds.results || []) {
    let parsed;
    try { parsed = JSON.parse(f.filters || '{}'); } catch (e) { continue; }
    if (!parsed || !Array.isArray(parsed.kind)) continue;
    const kind = [];
    let changed = false;
    for (const k of parsed.kind) {
      if (k === 'events-marketing') { changed = true; kind.push('event', 'marketing'); }
      else if (k === 'meetings-deadlines') { changed = true; kind.push('meeting', 'deadline'); }
      else kind.push(k);
    }
    if (changed) feedBatch.push(feedStmt.bind(JSON.stringify({ ...parsed, kind }), f.token));
  }
  if (feedBatch.length) await db.batch(feedBatch);

  await db.prepare(
    'INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(KIND_SPLIT_KEY, JSON.stringify({ ...counts, feeds: feedBatch.length }),
          new Date().toISOString()).run();
}

// The 2026 social calendar, out of the MKG Comms export. See
// backfill/build_social.py for how the file was made and what was left out:
// undated rows, 2025 and earlier, and rows that were blank in the sheet.
//
// Every row carries an id derived from its own content, so this is safe to run
// twice by construction -- a second pass collides on the primary key and
// changes nothing. The meta guard is there to save the work, not the data.
const SOCIAL_BACKFILL_KEY = 'mkg-comms-social-2026';
const BACKFILL_AUTHOR = 'mkg-comms-backfill';

async function backfillSocial(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(SOCIAL_BACKFILL_KEY).first();
  if (done) return;

  const now = new Date().toISOString();
  // Built off COLS so a column added later cannot quietly fall out of the
  // backfill while the insert still succeeds.
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO items (id,' + COLS.join(',')
    + ',created_by,created_at,updated_by,updated_at) '
    + 'VALUES (?' + ',?'.repeat(COLS.length + 4) + ')');

  const rows = Array.isArray(SOCIAL_BACKFILL) ? SOCIAL_BACKFILL : [];
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.batch(rows.slice(i, i + BATCH).map((r) => stmt.bind(
      r.id,
      ...COLS.map((c) => (r[c] === undefined ? null : r[c])),
      BACKFILL_AUTHOR, now, BACKFILL_AUTHOR, now,
    )));
  }

  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(SOCIAL_BACKFILL_KEY, JSON.stringify({ rows: rows.length }), now).run();
}

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// A count typed by a person: "1,240" and " 1240 " are the same number. Empty
// is null rather than nought -- "nobody has reported it" and "it sold nothing"
// are different answers and a roll-up must not confuse them.
function wholeNumber(v, label, errors) {
  const raw = clean(v, 20);
  if (raw == null) return null;
  const digits = raw.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(digits)) { errors.push(label + ' must be a whole number.'); return null; }
  return Number(digits);
}

// Likewise for an amount, which arrives with whatever the sales report put in
// front of it. Negative is allowed: a day can end in refunds.
function money(v, label, errors) {
  const raw = clean(v, 30);
  if (raw == null) return null;
  const n = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(n)) { errors.push(label + ' must be an amount, like 1240.50.'); return null; }
  return Math.round(Number(n) * 100) / 100;
}

function clean(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max || 500);
}

// Turns whatever the form posted into a row we are willing to store,
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

  // A single-value axis.
  const one = (field, allowed, label) => {
    const raw = clean(pick(field), 60);
    if (!raw) return null;
    if (!allowed.includes(raw)) { errors.push('Unknown ' + label + ' "' + raw + '".'); return null; }
    return raw;
  };

  out.title = clean(pick('title'), 200);
  if (!out.title) errors.push('Event name is required.');

  out.event_type = one('event_type', EVENT_TYPE_KEYS, 'Event Type') || 'event';
  const isMeeting = out.event_type === 'meeting' || out.event_type === 'deadline';

  // The primary department owns the event and gives it its colour. Everything
  // else on the event is along for the ride.
  out.department = one('department', DEPARTMENT_KEYS, 'department');
  if (!out.department) errors.push('Pick a primary department.');

  const extra = multi('departments', DEPARTMENT_KEYS, 'department')
    .filter((k) => k !== out.department);
  out.departments = extra.length ? extra.join(',') : null;

  // Every department on the event, primary first: what the scoped axes below
  // are measured against.
  const onEvent = (out.department ? [out.department] : []).concat(extra);

  // Sub-types and needs each belong to a department. The decision tree hangs
  // sub-types off the primary one; they are accepted from any department on the
  // event instead, because a store sale that Marketing promotes really is a
  // Promotion without Marketing having to own the event to say so.
  const subs = multi('sub_types', SUB_TYPE_KEYS, 'sub-type');
  for (const k of subs) {
    const def = SUB_TYPES.find((x) => x.key === k);
    if (def && !onEvent.includes(def.department)) {
      errors.push('"' + def.label + '" belongs to '
        + (DEPARTMENTS.find((d) => d.key === def.department) || {}).label
        + ', which is not on this event.');
    }
  }
  out.sub_types = subs.length ? subs.join(',') : null;

  // Unscoped: whose event it is has no bearing on what it needs.
  const needs = multi('needs', NEED_KEYS, 'need');
  out.needs = needs.length ? needs.join(',') : null;

  // Only meaningful alongside the need it details.
  out.staff_count = needs.includes('extra-staff') ? clean(pick('staff_count'), 20) : null;

  const veh = multi('vehicles', VEHICLE_KEYS, 'vehicle');
  out.vehicles = veh.length ? veh.join(',') : null;

  out.status = clean(pick('status'), 20) || 'Booked';
  if (!STATUSES.includes(out.status)) {
    errors.push('Status must be one of ' + STATUSES.join(', ') + '.');
  }

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

  // How the event did. Typed by a person after the fact, so "1,240" and
  // "$1,240.00" both have to mean the same number -- refusing them would just
  // teach people to go and find a cleaner copy of a figure they already have.
  out.orders = wholeNumber(pick('orders'), 'Orders', errors);
  out.net_revenue = money(pick('net_revenue'), 'Net revenue', errors);

  // The social axes. Kept out of the way of the event ones rather than
  // overloading them: a channel is not a venue and a production state is not a
  // status, however similar they look from a distance.
  out.social_type = one('social_type', SOCIAL_TYPE_KEYS, 'social type');
  const channels = multi('channels', CHANNEL_KEYS, 'channel');
  out.channels = channels.length ? channels.join(',') : null;
  out.pillar = one('pillar', PILLAR_KEYS, 'content pillar');
  const production = multi('production', PRODUCTION_KEYS, 'production state');
  out.production = production.length ? production.join(',') : null;
  out.caption = clean(pick('caption'), 4000);
  out.tags = clean(pick('tags'), 500);

  const prod = normaliseProducts(pick('products'));
  out.products = prod.products;
  for (const e of prod.errors) errors.push(e);

  // Each kind clears what its own form never showed, so what is stored matches
  // what the person who saved it was actually looking at.
  if (isMeeting) for (const k of MEETING_BLANKS) out[k] = null;
  if (out.event_type === 'social') for (const k of SOCIAL_BLANKS) out[k] = null;
  else for (const k of SOCIAL_ONLY) out[k] = null;
  if (out.event_type === 'marketing') for (const k of MARKETING_BLANKS) out[k] = null;
  // Only an Event takes money at the door.
  if (out.event_type !== 'event') for (const k of RESULTS_ONLY) out[k] = null;
  // A deadline is a point, not a span: it ends the day it falls on.
  if (out.event_type === 'deadline') out.end_date = out.start_date;

  return { row: out, errors };
}

const COLS = [
  'title', 'event_type', 'department', 'departments', 'sub_types', 'needs', 'staff_count',
  'vehicles', 'status', 'start_date', 'end_date', 'all_day', 'start_time', 'end_time',
  'venue', 'address', 'city', 'state', 'zip', 'notes', 'url', 'products',
  'social_type', 'channels', 'pillar', 'production', 'caption', 'tags',
  'orders', 'net_revenue',
];

// Meetings and deadlines take the short form: who, when, and nothing else. The
// rest is cleared on write rather than merely hidden, so what is stored matches
// what the form showed the person who saved it.
const MEETING_BLANKS = ['sub_types', 'needs', 'staff_count', 'vehicles',
                        'venue', 'address', 'city', 'state', 'zip', 'products'];

// A post happens online. It keeps its sub-types -- a Collab or an Ambassador
// post really is one -- and its product highlights, which is half the point of
// a product post.
const SOCIAL_BLANKS = ['needs', 'staff_count', 'vehicles',
                       'venue', 'address', 'city', 'state', 'zip'];
const SOCIAL_ONLY = ['social_type', 'channels', 'pillar', 'production', 'caption', 'tags'];

// Marketing can have a place -- a shoot happens somewhere -- but staff, permits
// and vans are an Event's concern.
const MARKETING_BLANKS = ['needs', 'staff_count', 'vehicles'];

// Reported after the fact, and only on something that actually sold.
const RESULTS_ONLY = ['orders', 'net_revenue'];

// Year / Week / Start (Week) / End (Week) / Month / Day are not stored; they are
// attached here so every reader sees the same values.
function withRetail(row) {
  return { ...row, all_day: row.all_day ? 1 : 0, retail: retailWeek(row.start_date) };
}

async function listItems(db, from, to) {
  // An item overlaps the window when it starts before the window ends and ends
  // after the window starts -- a plain start-date filter would drop multi-day
  // items already running when the month opened.
  // The count comes along so the calendar can mark an event that has files
  // without a query per event.
  let sql = 'SELECT items.*, (SELECT COUNT(*) FROM attachments a WHERE a.item_id = items.id)'
    + ' AS attachment_count FROM items';
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

function slugify(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Values reach us as people wrote them, not as keys: accept the label, the key
// and the spelling the sheet used.
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
  // A sheet's department column is one list with no primary, and not everything
  // in it is a department: a token may name a need, a vehicle or a sub-type.
  // Sort each one onto its own axis rather than rejecting the row, and let
  // PRIMACY choose the primary exactly as the migration did.
  const rawDepts = splitList(rec.departments);
  const rawNeeds = splitList(rec.needs);
  const rawVeh = splitList(rec.vehicles);
  if (rawDepts.length || rawNeeds.length || rawVeh.length) {
    const depts = [];
    const needs = rawNeeds.map((n) => matchKey(NEEDS, n) || n);
    const veh = rawVeh.map((v) => matchKey(VEHICLES, v) || v);
    const subs = splitList(rec.sub_types);
    for (const token of rawDepts) {
      const asDept = matchKey(DEPARTMENTS, token);
      if (asDept) { if (!depts.includes(asDept)) depts.push(asDept); continue; }
      const asNeed = matchKey(NEEDS, token);
      if (asNeed) { if (!needs.includes(asNeed)) needs.push(asNeed); continue; }
      const asVeh = matchKey(VEHICLES, token);
      if (asVeh) { if (!veh.includes(asVeh)) veh.push(asVeh); continue; }
      const asSub = matchKey(SUB_TYPES, token);
      if (asSub) { if (!subs.includes(asSub)) subs.push(asSub); continue; }
      depts.push(token);   // unknown: let normalise() name it
    }
    depts.sort((a, b) => PRIMACY.indexOf(a) - PRIMACY.indexOf(b));
    if (!rec.department && depts.length) rec.department = depts.shift();
    rec.departments = depts;
    rec.needs = needs;
    rec.vehicles = veh;
    rec.sub_types = subs;
  }

  if (rec.event_type != null) {
    rec.event_type = matchKey(EVENT_TYPES, rec.event_type) || rec.event_type;
  }
  if (rec.department != null) {
    rec.department = matchKey(DEPARTMENTS, rec.department) || rec.department;
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

// Workers cap a request body well above this; the limit is about what is
// sensible to hang off a calendar event, not what the platform allows.
const MAX_UPLOAD = 10 * 1024 * 1024;

// Content-Disposition is a header, and a header cannot carry a newline or a
// quote without changing what it means.
function asciiName(name) {
  return String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

async function listAttachments(db, itemId) {
  const res = await db.prepare(
    'SELECT id, name, size, slot, uploaded_by, uploaded_at FROM attachments '
    + 'WHERE item_id = ? ORDER BY uploaded_at ASC').bind(itemId).all();
  return res.results || [];
}

const MAX_COMMENT = 4000;
const MAX_MENTIONS = 25;
const EMAIL_RE = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;
// Long enough that a workspace change shows up the same day, far enough apart
// that a busy calendar is not calling Slack on every page load.
const ROSTER_TTL_MS = 6 * 60 * 60 * 1000;
// A failed attempt backs off minutes, not hours. The long interval is for a
// roster that is merely stale; applying it to a failure would mean a missing
// scope caught on the first call locks the picker out for the rest of the day,
// long after the scope was added.
const ROSTER_RETRY_MS = 5 * 60 * 1000;
const ROSTER_KEY = 'slack-roster-next';
// What happened the last time a mention was sent. Kept so a delivery that fails
// in the background can still be reported on the next page load -- the request
// that triggered it has long since gone.
const SLACK_STATUS_KEY = 'slack-last-delivery';

async function recordSlackResult(db, result) {
  const value = JSON.stringify({
    at: new Date().toISOString(),
    sent: result.sent,
    errors: (result.errors || []).slice(0, 5),
  });
  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(SLACK_STATUS_KEY, value, new Date().toISOString()).run();
}

async function readSlackStatus(db) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(SLACK_STATUS_KEY).first();
  if (!row) return null;
  try {
    const st = JSON.parse(row.value);
    if (!st.errors || !st.errors.length) return { at: st.at, sent: st.sent, errors: [] };
    return { at: st.at, sent: st.sent, errors: st.errors,
             hint: slackHint(st.errors[0] && st.errors[0].error) };
  } catch (e) {
    return null;
  }
}

function cleanMentions(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',');
  const out = [];
  for (const item of list) {
    const email = clean(item, 200);
    if (!email) continue;
    const low = email.toLowerCase();
    if (!EMAIL_RE.test(low) || out.includes(low)) continue;
    out.push(low);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

async function listComments(db, itemId) {
  const res = await db.prepare(
    'SELECT id, body, mentions, author, created_at FROM comments '
    + 'WHERE item_id = ? ORDER BY created_at ASC').bind(itemId).all();
  return res.results || [];
}

// Everyone worth offering in the mention picker: the Slack roster when there is
// one, plus anyone who has touched this calendar, so the feature is usable the
// day it ships rather than the day the Slack app is approved.
async function listPeople(db) {
  const byEmail = new Map();
  const add = (email, name, slackId) => {
    const low = String(email || '').toLowerCase();
    if (!low || !EMAIL_RE.test(low)) return;
    const was = byEmail.get(low) || {};
    byEmail.set(low, {
      email: low,
      name: was.name || name || displayName(low, ''),
      slack_id: was.slack_id || slackId || null,
    });
  };

  const roster = await db.prepare('SELECT email, name, slack_id FROM people').all();
  for (const p of roster.results || []) add(p.email, p.name, p.slack_id);

  const seen = await db.prepare(
    'SELECT created_by AS e FROM items WHERE created_by IS NOT NULL '
    + 'UNION SELECT updated_by FROM items WHERE updated_by IS NOT NULL '
    + 'UNION SELECT author FROM comments '
    + 'UNION SELECT email FROM feeds').all();
  for (const r of seen.results || []) add(r.e, '', null);

  return [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Refreshed in the background off a timestamp in meta. A Slack outage leaves
// the last roster in place rather than emptying the picker.
async function refreshRoster(env, db) {
  if (!env.SLACK_BOT_TOKEN) return;
  // The stored value is when to try again, not when it last worked, so success
  // and failure can set their own distance without a second row to read.
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(ROSTER_KEY).first();
  if (row && Date.now() < Number(row.value)) return;

  const setNext = (ms) => db.prepare(
    'INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(ROSTER_KEY, String(Date.now() + ms), new Date().toISOString()).run();

  // Claimed before the call so a bad token is not retried on every page load,
  // and short enough that fixing the token is not followed by a long wait.
  await setNext(ROSTER_RETRY_MS);

  const people = await fetchSlackPeople(env.SLACK_BOT_TOKEN);
  if (!people.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO people (email, name, slack_id, updated_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(email) DO UPDATE SET name = excluded.name, '
    + 'slack_id = excluded.slack_id, updated_at = excluded.updated_at');
  const BATCH = 200;
  for (let i = 0; i < people.length; i += BATCH) {
    await db.batch(people.slice(i, i + BATCH)
      .map((p) => stmt.bind(p.email, p.name, p.slack_id, now)));
  }
  await setNext(ROSTER_TTL_MS);
}

// One feed per person, created the first time they open Subscribe. The token
// is the credential -- 32 random bytes, not derived from the email, so knowing
// who works here tells you nothing about their link.
const FEED_AXES = ['dept', 'kind', 'sub', 'status'];

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanFilters(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const axis of FEED_AXES) {
    const raw = Array.isArray(src[axis]) ? src[axis] : [];
    const picked = [];
    for (const v of raw) {
      const key = clean(v, 60);
      // Only the shapes a key can take; nothing here is interpolated into SQL,
      // but a filter value has no business carrying anything else either.
      if (key && /^[A-Za-z0-9-]+$/.test(key) && !picked.includes(key)) picked.push(key);
    }
    if (picked.length) out[axis] = picked;
  }
  return out;
}

async function feedFor(db, email) {
  const row = await db.prepare('SELECT * FROM feeds WHERE email = ?').bind(email).first();
  if (row) return row;
  const now = new Date().toISOString();
  const token = newToken();
  await db.prepare(
    'INSERT INTO feeds (token, email, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(token, email, '{}', now, now).run();
  return { token, email, filters: '{}', created_at: now, updated_at: now };
}

async function handleApi(request, env, url, who, ctx) {
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

  // Your own calendar sync: the link, and what it carries. Never anybody
  // else's -- the row is looked up by the signed-in email, not by anything the
  // caller sends.
  if (path === '/api/feed') {
    if (!who.email) return json({ error: 'Not signed in.' }, 403);

    if (method === 'GET' || method === 'POST' || method === 'PUT') {
      let row = await feedFor(db, who.email);

      if (method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: 'Expected a JSON body.' }, 400);
        const filters = JSON.stringify(cleanFilters(body.filters));
        await db.prepare('UPDATE feeds SET filters = ?, updated_at = ? WHERE token = ?')
          .bind(filters, new Date().toISOString(), row.token).run();
        row = { ...row, filters };
      }

      if (method === 'POST') {
        // Reset: a new token, so a link that got out stops working for that
        // person and nobody else is disturbed.
        const token = newToken();
        await db.prepare('UPDATE feeds SET token = ?, updated_at = ? WHERE email = ?')
          .bind(token, new Date().toISOString(), who.email).run();
        row = { ...row, token };
      }

      let parsed = {};
      try { parsed = JSON.parse(row.filters || '{}'); } catch (err) { parsed = {}; }
      return json({
        url: env.FEED_ORIGIN
          ? env.FEED_ORIGIN.replace(/\/$/, '') + '/calendar.ics?token=' + row.token
          : null,
        filters: parsed,
      });
    }
    return json({ error: 'Method not allowed.' }, 405);
  }

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  // Files attached to one event. Everything here is a no-op until an R2 bucket
  // is bound, rather than a 500 -- the calendar works without attachments and
  // should say so plainly.
  const attMatch = path.match(new RegExp('^/api/items/(' + UUID + ')/attachments$', 'i'));
  if (attMatch) {
    const itemId = attMatch[1];
    if (method === 'GET') return json({ attachments: await listAttachments(db, itemId) });

    if (method === 'POST') {
      const denied = requireEditor(); if (denied) return denied;
      if (!env.FILES) {
        return json({ error: 'File storage is not set up for this calendar yet.' }, 503);
      }
      const owner = await db.prepare('SELECT id FROM items WHERE id = ?').bind(itemId).first();
      if (!owner) return json({ error: 'No calendar item with that id.' }, 404);

      const name = clean(request.headers.get('X-File-Name'), 200) || 'file';
      // Which product highlight this one illustrates, if any. The row it names
      // may not be stored yet -- the browser generates the id before the save --
      // so this is kept as given rather than checked against the item.
      const slot = clean(request.headers.get('X-File-Slot'), 40);
      const size = Number(request.headers.get('content-length') || 0);
      if (size > MAX_UPLOAD) {
        return json({ error: 'That file is larger than ' + (MAX_UPLOAD / 1048576) + ' MB.' }, 413);
      }

      const id = crypto.randomUUID();
      // The object key is generated, never taken from the filename: a name can
      // contain a slash, a traversal or another event's key.
      const r2Key = 'items/' + itemId + '/' + id;
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_UPLOAD) {
        return json({ error: 'That file is larger than ' + (MAX_UPLOAD / 1048576) + ' MB.' }, 413);
      }
      await env.FILES.put(r2Key, body);

      const now = new Date().toISOString();
      await db.prepare(
        'INSERT INTO attachments (id, item_id, name, size, content_type, r2_key, slot, uploaded_by, uploaded_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, itemId, name, body.byteLength,
             clean(request.headers.get('content-type'), 120), r2Key, slot, who.email, now).run();

      return json({ attachment: { id, name, size: body.byteLength, slot,
                                  uploaded_by: who.email, uploaded_at: now } }, 201);
    }
    return json({ error: 'Method not allowed.' }, 405);
  }

  // Who can be mentioned. Readable by anyone signed in -- it is a staff list,
  // and the picker is useless without it.
  if (path === '/api/people' && method === 'GET') {
    try {
      await refreshRoster(env, db);
    } catch (e) {
      // A Slack problem costs the list its freshness, not its existence.
    }
    return json({
      people: await listPeople(db),
      slackConfigured: Boolean(env.SLACK_BOT_TOKEN),
      // So a mention that is quietly not arriving shows up as a warning rather
      // than as nothing at all.
      slackStatus: env.SLACK_BOT_TOKEN ? await readSlackStatus(db) : null,
    });
  }

  const cmtMatch = path.match(new RegExp('^/api/items/(' + UUID + ')/comments$', 'i'));
  if (cmtMatch) {
    const itemId = cmtMatch[1];
    if (method === 'GET') return json({ comments: await listComments(db, itemId) });

    if (method === 'POST') {
      // Deliberately not requireEditor: a comment changes no event data, and a
      // calendar nobody but the seven editors can ask a question on is a
      // noticeboard rather than a conversation.
      if (!who.email) return json({ error: 'Not signed in.' }, 403);

      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'Expected a JSON body.' }, 400);
      const text = clean(body.body, MAX_COMMENT);
      if (!text) return json({ error: 'Write something first.' }, 400);

      const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(itemId).first();
      if (!item) return json({ error: 'No calendar item with that id.' }, 404);

      const mentions = cleanMentions(body.mentions);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.prepare(
        'INSERT INTO comments (id, item_id, body, mentions, author, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, itemId, text, mentions.join(',') || null, who.email, now).run();

      // The comment is stored and the response does not wait on Slack. A DM
      // that fails must not look like a comment that failed -- the comment is
      // on the event either way, which is where it actually lives.
      if (mentions.length && env.SLACK_BOT_TOKEN) {
        const notify = (async () => {
          const roster = await listPeople(db);
          // Everyone mentioned, not only those with a Slack id: a mention that
          // cannot be delivered is exactly the case worth reporting.
          const targets = roster.filter((p) => mentions.includes(p.email));
          if (!targets.length) return;
          const me = roster.find((p) => p.email === String(who.email).toLowerCase());
          const result = await dmMentions(env.SLACK_BOT_TOKEN, targets, commentMessage({
            authorName: displayName(who.email, me && me.name),
            item,
            body: text,
            url: eventUrl(url.origin, itemId),
          }));
          await recordSlackResult(db, result);
        })().catch((e) => recordSlackResult(db, {
          sent: 0, errors: [{ email: '', error: String((e && e.message) || e) }],
        }).catch(() => {}));
        if (ctx && ctx.waitUntil) ctx.waitUntil(notify);
      }

      return json({ comment: { id, body: text, mentions: mentions.join(','),
                               author: who.email, created_at: now } }, 201);
    }
    return json({ error: 'Method not allowed.' }, 405);
  }

  // Your own comment, or an editor tidying up. Nobody else's.
  const cmtOne = path.match(new RegExp('^/api/comments/(' + UUID + ')$', 'i'));
  if (cmtOne && method === 'DELETE') {
    const row = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(cmtOne[1]).first();
    if (!row) return json({ error: 'No comment with that id.' }, 404);
    if (row.author !== who.email && !who.canEdit) {
      return json({ error: 'That is somebody else’s comment.' }, 403);
    }
    await db.prepare('DELETE FROM comments WHERE id = ?').bind(row.id).run();
    return json({ deleted: row.id });
  }

  const fileMatch = path.match(new RegExp('^/api/attachments/(' + UUID + ')$', 'i'));
  if (fileMatch) {
    const row = await db.prepare('SELECT * FROM attachments WHERE id = ?')
      .bind(fileMatch[1]).first();
    if (!row) return json({ error: 'No such attachment.' }, 404);

    if (method === 'DELETE') {
      const denied = requireEditor(); if (denied) return denied;
      if (env.FILES) await env.FILES.delete(row.r2_key);
      await db.prepare('DELETE FROM attachments WHERE id = ?').bind(row.id).run();
      return json({ deleted: row.id });
    }

    if (method === 'GET') {
      if (!env.FILES) return json({ error: 'File storage is not bound.' }, 503);
      const obj = await env.FILES.get(row.r2_key);
      if (!obj) return json({ error: 'That file is no longer in storage.' }, 404);
      // Always a download, never a page. An uploaded .html or .svg served inline
      // would run on the calendar's own origin, with the uploader's Access
      // session -- so the browser is told to save it and not to sniff.
      return new Response(obj.body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="' + asciiName(row.name) + '"',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=300',
        },
      });
    }
    return json({ error: 'Method not allowed.' }, 405);
  }

  const idMatch = path.match(new RegExp('^/api/items/(' + UUID + ')$', 'i'));
  if (idMatch) {
    const id = idMatch[1];
    const existing = await db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'No calendar item with that id.' }, 404);

    if (method === 'GET') {
      return json({
        item: withRetail(existing),
        attachments: await listAttachments(db, id),
      });
    }

    const denied = requireEditor(); if (denied) return denied;

    if (method === 'DELETE') {
      // The objects go first: a row left without its file is a broken link on
      // the page, a file left without its row is storage nobody can ever reach.
      const files = await db.prepare('SELECT r2_key FROM attachments WHERE item_id = ?')
        .bind(id).all();
      if (env.FILES) {
        for (const f of (files.results || [])) await env.FILES.delete(f.r2_key);
      }
      await db.prepare('DELETE FROM attachments WHERE item_id = ?').bind(id).run();
      await db.prepare('DELETE FROM comments WHERE item_id = ?').bind(id).run();
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const who = await identify(request, env);

    // A new workers.dev hostname is reachable by anyone until an Access
    // application is put in front of it. Rather than depend on that happening
    // before anybody finds the URL, refuse every request that arrives without
    // an Access identity and explain what is missing. There is no exempt path
    // here: Access cannot carve one out of a Worker, which is exactly why the
    // feed is a Worker of its own.
    if (env.REQUIRE_IDENTITY !== 'false' && !who.email) {
      if (url.pathname.startsWith('/api/')) {
        return json({
          error: 'This request did not come through Cloudflare Access.',
          reason: who.reason || undefined,
        }, 403);
      }
      return new Response(notAvailableHtml(who.reason), {
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
          // Whether calendar sync can work at all. The link itself is per
          // person and comes from /api/feed, not from here -- it is a
          // credential, and it belongs in a response about one person rather
          // than in the one every page load makes.
          feedConfigured: Boolean(env.FEED_ORIGIN),
        });
      }

      try {
        return await handleApi(request, env, url, who, ctx);
      } catch (err) {
        return json({ error: 'Calendar request failed: ' + (err && err.message ? err.message : String(err)) }, 500);
      }
    }

    // Everything else is a built page.
    return env.ASSETS.fetch(request);
  },
};
