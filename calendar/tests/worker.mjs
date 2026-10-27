// The Worker, actually run.
//
// Everything else in tests/ either tests a pure module or reads index.js as
// text, because index.js imports schema.sql through a wrangler rule and will
// not load in Node. That left the write path -- the SQL, the migrations, the
// rows that get created and deleted alongside the one being saved -- with no
// test that ever executed it.
//
// So: bundle it the way wrangler does, and run it against node:sqlite behind
// a small D1 shim. Skipped, not failed, where esbuild is missing, which is
// why this is not the deploy gate. tests/unit.mjs still is.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sqlStatements } from '../worker/sql.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jetty-worker-')), 'bundle.mjs');
try {
  execFileSync('npx', ['--yes', 'esbuild', path.join(ROOT, 'worker', 'index.js'),
    '--bundle', '--format=esm', '--loader:.sql=text', '--outfile=' + out],
    { stdio: 'pipe' });
} catch (err) {
  console.log('esbuild is not available here, so the worker suite is skipped.');
  console.log('  npm i -D esbuild');
  process.exit(0);
}

import { pathToFileURL } from 'node:url';
// Fresh module each time: the Worker remembers that it has applied the schema
// in a module-level flag, and a migration can only be watched running once.
let instances = 0;
const freshWorker = async () => (await import(
  pathToFileURL(out).href + '?i=' + (instances += 1))).default;

const worker = await freshWorker();

// ── a D1 shim over node:sqlite ──────────────────────────────────────────
//
// Only the surface index.js uses. D1 returns plain objects from .all() under
// a `results` key and a bare row from .first(); node:sqlite returns
// null-prototype objects, which spread and index the same way.
function d1(db) {
  const prep = (sql) => {
    const make = (binds) => ({
      bind: (...xs) => make(xs),
      _sql: sql,
      _binds: binds,
      run() {
        const r = db.prepare(sql).run(...binds);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
      first() { return db.prepare(sql).get(...binds) ?? null; },
      all() { return { results: db.prepare(sql).all(...binds) }; },
    });
    return make([]);
  };
  return {
    prepare: prep,
    async batch(stmts) {
      for (const st of stmts) db.prepare(st._sql).run(...st._binds);
      return stmts.map(() => ({ success: true }));
    },
  };
}

const sqlite = new DatabaseSync(':memory:');
const ENV = {
  DB: d1(sqlite),
  CALENDAR_EDITORS: 'jeremy@jettylife.com',
  REQUIRE_IDENTITY: 'false',
  // No team domain and no AUD: the local-dev path through access.js, where
  // the header alone identifies an editor. Never how production runs.
};

const call = async (method, p, body) => {
  const res = await worker.fetch(new Request('https://cal.test' + p, {
    method,
    headers: {
      'content-type': 'application/json',
      'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), ENV, { waitUntil() {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body: json, text };
};

let failed = 0;
let ran = 0;
const t = async (name, fn) => {
  ran++;
  try {
    const okay = await fn();
    console.log((okay ? '  ok   ' : '  FAIL ') + name);
    if (!okay) failed++;
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
};

const rows = (sql, ...b) => sqlite.prepare(sql).all(...b);
const ymd = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const base = {
  title: 'Spring Launch', event_type: 'marketing', department: 'marketing',
  status: 'Booked', start_date: ymd(40), end_date: ymd(40), all_day: 1,
};

console.log('deadlines the Worker sets for itself');

let advoId = '';
await t('creates one three weeks before a Paid Advo', async () => {
  const r = await call('POST', '/api/items', { ...base, sub_types: 'paid-advo' });
  advoId = r.body && r.body.item && r.body.item.id;
  const d = rows('SELECT * FROM items WHERE deadline_for = ?', advoId);
  return r.status === 201 && d.length === 1
    && d[0].title === 'Sunnyside Deadline: Spring Launch'
    && d[0].event_type === 'deadline'
    && d[0].start_date === ymd(40 - 21) && d[0].end_date === d[0].start_date;
});
// The one that would otherwise be left pointing at a date nothing happens on.
await t('moves it when the placement moves', async () => {
  await call('PATCH', '/api/items/' + advoId, { start_date: ymd(60), end_date: ymd(60) });
  const d = rows('SELECT * FROM items WHERE deadline_for = ?', advoId);
  return d.length === 1 && d[0].start_date === ymd(60 - 21);
});
await t('renames it when the placement is renamed', async () => {
  await call('PATCH', '/api/items/' + advoId, { title: 'Autumn Launch' });
  const d = rows('SELECT * FROM items WHERE deadline_for = ?', advoId);
  return d.length === 1 && d[0].title === 'Sunnyside Deadline: Autumn Launch';
});
await t('does not pile up a second one on an unrelated save', async () => {
  await call('PATCH', '/api/items/' + advoId, { notes: 'Confirmed with Taylor' });
  return rows('SELECT * FROM items WHERE deadline_for = ?', advoId).length === 1;
});
await t('takes it away when the sub-type comes off', async () => {
  await call('PATCH', '/api/items/' + advoId, { sub_types: 'campaign-promotion' });
  return rows('SELECT * FROM items WHERE deadline_for = ?', advoId).length === 0;
});
await t('puts it back when the sub-type returns', async () => {
  await call('PATCH', '/api/items/' + advoId, { sub_types: 'paid-advo' });
  return rows('SELECT * FROM items WHERE deadline_for = ?', advoId).length === 1;
});
await t('takes it away with the placement itself', async () => {
  await call('DELETE', '/api/items/' + advoId);
  return rows('SELECT * FROM items WHERE deadline_for = ?', advoId).length === 0;
});

await t('gives an Email ten days, not three weeks', async () => {
  const r = await call('POST', '/api/items', { ...base, sub_types: 'email' });
  const d = rows('SELECT * FROM items WHERE deadline_for = ?', r.body.item.id);
  return d.length === 1 && d[0].start_date === ymd(40 - 10);
});
// SMS was split off Email precisely because it does not carry this.
await t('gives an SMS none at all', async () => {
  const r = await call('POST', '/api/items', { ...base, sub_types: 'sms' });
  return rows('SELECT * FROM items WHERE deadline_for = ?', r.body.item.id).length === 0;
});
// Two items with the same name on two dates is the thing somebody works to
// the wrong one of.
await t('gives an item that is both a single deadline at the longer lead', async () => {
  const r = await call('POST', '/api/items', { ...base, sub_types: 'email,paid-advo' });
  const d = rows('SELECT * FROM items WHERE deadline_for = ?', r.body.item.id);
  return d.length === 1 && d[0].start_date === ymd(40 - 21);
});
// A deadline is a point, not a span, and it stores none of an event's detail.
await t('writes a deadline through the same blanking rules as a typed one', async () => {
  const r = await call('POST', '/api/items', {
    ...base, sub_types: 'paid-advo', venue: 'The beach', notes: 'x',
  });
  const d = rows('SELECT * FROM items WHERE deadline_for = ?', r.body.item.id)[0];
  return d.venue === null && d.sub_types === null && d.end_date === d.start_date;
});
await t('hands the new deadline straight back to the caller', async () => {
  const r = await call('POST', '/api/items', { ...base, sub_types: 'paid-advo' });
  return Boolean(r.body.deadline) && r.body.deadline.deadline_for === r.body.item.id;
});
// A deadline somebody typed is theirs.
await t('leaves a hand-typed deadline alone', async () => {
  const mine = await call('POST', '/api/items', {
    ...base, event_type: 'deadline', title: 'Sunnyside Deadline: Autumn Launch',
  });
  const r = await call('POST', '/api/items', { ...base, sub_types: 'paid-advo' });
  await call('DELETE', '/api/items/' + r.body.item.id);
  const still = rows('SELECT * FROM items WHERE id = ?', mine.body.item.id);
  return still.length === 1 && still[0].deadline_for === null;
});


// ── the Email/SMS split, run against rows that predate it ───────────────
//
// Seeded the way a live database actually looks: the table already there,
// rows already carrying the merged key, and no meta row saying the split has
// happened. Then the first request, which is what applies it.
console.log('');
console.log('splitting Email/SMS apart again');

const pre = new DatabaseSync(':memory:');
for (const stmt of sqlStatements(
  fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8'))) pre.exec(stmt);
const seed = (id, title, date, subs, extra) => pre.prepare(
  'INSERT INTO items (id, title, event_type, department, sub_types, status, '
  + 'start_date, end_date, all_day, notes, caption, created_by, created_at) '
  + "VALUES (?,?,'marketing','marketing',?,'Booked',?,?,1,?,?,'arlynn@jettylife.com',"
  + "'2026-01-01T00:00:00.000Z')")
  .run(id, title, subs, date, date, (extra && extra.notes) || null,
       (extra && extra.caption) || null);

seed('old-1', 'September send', ymd(-50), 'email-sms');
seed('new-1', 'December send', ymd(30), 'email-sms', { notes: 'Two tiers', caption: 'Copy here' });
seed('new-2', 'Promo send', ymd(45), 'campaign-promotion,email-sms');
seed('other', 'A paid placement', ymd(30), 'paid-advo');
pre.prepare("INSERT INTO feeds (token, email, filters, created_at) VALUES (?,?,?,?)")
  .run('t'.repeat(64), 'arlynn@jettylife.com',
       '{"sub":["email-sms","website"],"dept":["marketing"]}', '2026-01-01T00:00:00.000Z');

const preWorker = await freshWorker();
await preWorker.fetch(new Request('https://cal.test/api/items', {
  headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
}), { ...ENV, DB: d1(pre) }, { waitUntil() {} });

const preRows = (sql, ...b) => pre.prepare(sql).all(...b);

// It really was both. Splitting history in two would invent a send that
// never went out.
await t('leaves a send that has already gone out as one item, carrying both', async () => {
  const r = preRows('SELECT * FROM items WHERE id = ?', 'old-1');
  return r.length === 1 && r[0].sub_types === 'email,sms'
    && preRows("SELECT * FROM items WHERE title = 'September send'").length === 1;
});
await t('splits a send still to come into two', async () => {
  const r = preRows("SELECT * FROM items WHERE title = 'December send' ORDER BY sub_types");
  return r.length === 2 && r[0].sub_types === 'email' && r[1].sub_types === 'sms';
});
// The copy was that item until this moment.
await t('carries the copy everything but the sub-type', async () => {
  const sms = preRows("SELECT * FROM items WHERE title = 'December send' AND sub_types = 'sms'")[0];
  return sms.notes === 'Two tiers' && sms.caption === 'Copy here'
    && sms.department === 'marketing' && sms.start_date === ymd(30)
    && sms.created_by === 'arlynn@jettylife.com';
});
// The id is what the attachments, the comments and anybody's subscribed
// calendar hang off, and Email is the half that carries a deadline.
await t('keeps the original id on the Email half', async () => {
  const keep = preRows('SELECT * FROM items WHERE id = ?', 'new-1');
  return keep.length === 1 && keep[0].sub_types === 'email';
});
await t('keeps the other sub-types on both halves', async () => {
  const r = preRows("SELECT sub_types FROM items WHERE title = 'Promo send' ORDER BY sub_types");
  return r.length === 2 && r[0].sub_types === 'campaign-promotion,email'
    && r[1].sub_types === 'campaign-promotion,sms';
});
await t('leaves everything else alone', async () => {
  const r = preRows('SELECT * FROM items WHERE id = ?', 'other');
  return r.length === 1 && r[0].sub_types === 'paid-advo';
});
// Somebody subscribed to the sends should keep getting them.
await t('subscribes a saved sync to both halves', async () => {
  const f = preRows('SELECT filters FROM feeds')[0];
  const sub = JSON.parse(f.filters).sub;
  return sub.includes('email') && sub.includes('sms')
    && !sub.includes('email-sms') && sub.includes('website');
});
await t('records that it ran, so it never runs twice', async () => {
  const m = preRows("SELECT value FROM meta WHERE key = 'email-sms-split-2026-10'");
  if (m.length !== 1) return false;
  const again = await freshWorker();
  await again.fetch(new Request('https://cal.test/api/items', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), { ...ENV, DB: d1(pre) }, { waitUntil() {} });
  return preRows("SELECT * FROM items WHERE title = 'December send'").length === 2;
});
// Nothing stores the merged key any more, so nothing should answer to it.
await t('leaves no row still carrying the merged key', async () =>
  preRows("SELECT * FROM items WHERE sub_types LIKE '%email-sms%'").length === 0);


// ── The split that ran twice ─────────────────────────────────
//
// Seeded the way the live database came out of it: every future send with an
// Email row and two identical SMS rows, which is what two isolates running
// the same unclaimed migration produces.
console.log('');
console.log('undoing a doubled SMS split');

const dup = new DatabaseSync(':memory:');
for (const stmt of sqlStatements(fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8'))) {
  dup.exec(stmt);
}
const put = (id, title, date, subs) => dup.prepare(
  'INSERT INTO items (id, title, event_type, department, sub_types, status, '
  + "start_date, end_date, all_day) VALUES (?,?,'marketing','marketing',?,'Booked',?,?,1)")
  .run(id, title, subs, date, date);

// A future send, split and then split again.
put('f-email', 'Jetty Rewards Program', ymd(30), 'email');
put('f-sms-1', 'Jetty Rewards Program', ymd(30), 'sms');
put('f-sms-2', 'Jetty Rewards Program', ymd(30), 'sms');
// One that came out right.
put('g-email', 'The Oyster Shooter Collection', ymd(31), 'email');
put('g-sms', 'The Oyster Shooter Collection', ymd(31), 'sms');
// A send that has already gone out: one row, both keys, never duplicated.
put('past', 'September send', ymd(-50), 'email,sms');
// An SMS somebody typed by hand, with no Email twin anywhere.
put('typed', 'A text on its own', ymd(20), 'sms');
// A surplus copy that somebody has since put a file on.
put('h-email', 'BFCM Asset Approval', ymd(32), 'email');
put('h-sms-1', 'BFCM Asset Approval', ymd(32), 'sms');
put('h-sms-2', 'BFCM Asset Approval', ymd(32), 'sms');
dup.prepare("INSERT INTO attachments (id, item_id, name, r2_key) VALUES ('at1','h-sms-2','brief.pdf','k')")
  .run();

const dupWorker = await freshWorker();
await dupWorker.fetch(new Request('https://cal.test/api/items', {
  headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
}), { ...ENV, DB: d1(dup) }, { waitUntil() {} });

const dupRows = (sql, ...b) => dup.prepare(sql).all(...b);
const kept = (title) => dupRows(
  "SELECT id FROM items WHERE title = ? AND sub_types = 'sms'", title).map((r) => r.id);

await t('leaves one SMS where there were two', async () =>
  kept('Jetty Rewards Program').length === 1);
await t('leaves the Email row where it was', async () =>
  dupRows("SELECT id FROM items WHERE id = 'f-email'").length === 1);
await t('does not touch a send that came out right', async () =>
  kept('The Oyster Shooter Collection').length === 1
  && dupRows("SELECT id FROM items WHERE id = 'g-sms'").length === 1);
await t('does not touch a send that has already gone out', async () =>
  dupRows("SELECT sub_types FROM items WHERE id = 'past'")[0].sub_types === 'email,sms');
// Deleting an unaccompanied send because it is unaccompanied would be the
// worse bug by far.
await t('leaves a hand-typed SMS with no Email twin alone', async () =>
  dupRows("SELECT id FROM items WHERE id = 'typed'").length === 1);
// The split attached no files, so a copy that has one is not a copy.
await t('keeps the copy somebody has put a file on, and drops the bare one', async () => {
  const left = kept('BFCM Asset Approval');
  return left.length === 1 && left[0] === 'h-sms-2';
});
await t('records what it deleted', async () => {
  const m = dupRows("SELECT value FROM meta WHERE key = 'sms-dedupe-2026-10'");
  return m.length === 1 && JSON.parse(m[0].value).deleted === 2;
});
// It is a delete, so a second pass has to be a no-op.
await t('does nothing at all on a second run', async () => {
  const before = dupRows('SELECT COUNT(*) AS n FROM items')[0].n;
  const again = await freshWorker();
  await again.fetch(new Request('https://cal.test/api/items', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), { ...ENV, DB: d1(dup) }, { waitUntil() {} });
  return dupRows('SELECT COUNT(*) AS n FROM items')[0].n === before;
});

// The cause, not the symptom: two isolates racing the same unclaimed key.
await t('lets exactly one caller claim a migration', async () => {
  const fresh = new DatabaseSync(':memory:');
  for (const stmt of sqlStatements(
    fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8'))) fresh.exec(stmt);
  const shim = d1(fresh);
  const take = () => shim.prepare(
    'INSERT OR IGNORE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind('a-key', '"claimed"', 'now').run();
  const first = take();
  const second = take();
  return first.meta.changes === 1 && second.meta.changes === 0;
});


// ── The deadlines that should already have been there ───────────────
//
// The rule only fires on a save, so every item put on the calendar before it
// shipped has none -- which is why clicking Deadline showed nothing.
console.log('');
console.log('backfilling the deadlines that were missing');

const old = new DatabaseSync(':memory:');
for (const stmt of sqlStatements(fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8'))) {
  old.exec(stmt);
}
const old_ = (id, title, date, subs, kind) => old.prepare(
  'INSERT INTO items (id, title, event_type, department, sub_types, status, '
  + "start_date, end_date, all_day) VALUES (?,?,?,'marketing',?,'Booked',?,?,1)")
  .run(id, title, kind || 'marketing', subs, date, date);

const ADVO = 'aaaaaaaa-1111-4111-8111-111111111111';
old_(ADVO, 'Spring Placement', ymd(40), 'paid-advo');
old_('ahead-email', 'December send', ymd(40), 'email');
old_('soon-email', 'This week send', ymd(4), 'email');   // due 6 days ago
old_('ahead-sms', 'A text', ymd(40), 'sms');
old_('past-advo', 'Last spring placement', ymd(-200), 'paid-advo');
old_('today-email', 'Going out today', ymd(0), 'email');
old_('other', 'A photo shoot', ymd(40), 'photo-video');
// One that was edited after the rule shipped, so it already has its own.
old_('has-one', 'Already done', ymd(40), 'paid-advo');
old.prepare("INSERT INTO items (id, title, event_type, department, status, start_date, "
  + "end_date, all_day, deadline_for) VALUES ('d-has','Sunnyside Deadline: Already done',"
  + "'deadline','marketing','Booked',?,?,1,'has-one')").run(ymd(19), ymd(19));

const oldWorker = await freshWorker();
await oldWorker.fetch(new Request('https://cal.test/api/items', {
  headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
}), { ...ENV, DB: d1(old) }, { waitUntil() {} });

const oldRows = (sql, ...b) => old.prepare(sql).all(...b);
const dl = (id) => oldRows('SELECT * FROM items WHERE deadline_for = ?', id);

await t('gives an upcoming Paid Advo the three weeks it should have had', async () => {
  const d = dl(ADVO);
  return d.length === 1 && d[0].start_date === ymd(40 - 21)
    && d[0].title === 'Sunnyside Deadline: Spring Placement'
    && d[0].event_type === 'deadline';
});
await t('gives an upcoming Email its ten days', async () =>
  dl('ahead-email').length === 1 && dl('ahead-email')[0].start_date === ymd(40 - 10));
// An email going out in four days was due with SunnySide six days ago, and
// a date in the past is the honest way to say so.
await t('still writes one whose date has already gone by', async () => {
  const d = dl('soon-email');
  return d.length === 1 && d[0].start_date === ymd(4 - 10);
});
await t('leaves SMS and the other sub-types out of it', async () =>
  dl('ahead-sms').length === 0 && dl('other').length === 0);
// There are years of these behind us and nobody can act on one.
await t('does not reach back over items that have already run', async () =>
  dl('past-advo').length === 0);
// Still to come until it has gone, and the ordinary rule would write one on
// a save, so the backfill writes the same row rather than a different one.
await t('counts something going out today as still to come', async () =>
  dl('today-email').length === 1);
await t('does not give a second one to an item that has one', async () =>
  dl('has-one').length === 1 && dl('has-one')[0].id === 'd-has');
await t('marks them as the calendar\'s own work, not somebody\'s', async () =>
  dl(ADVO)[0].created_by === 'calendar');
await t('records how many it made', async () => {
  const m = oldRows("SELECT value FROM meta WHERE key = 'deadline-backfill-2026-10'");
  return m.length === 1 && JSON.parse(m[0].value).made === 4;
});
// It inserts, so a second pass has to be a no-op.
await t('makes none a second time', async () => {
  const before = oldRows('SELECT COUNT(*) AS n FROM items')[0].n;
  const again = await freshWorker();
  await again.fetch(new Request('https://cal.test/api/items', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), { ...ENV, DB: d1(old) }, { waitUntil() {} });
  return oldRows('SELECT COUNT(*) AS n FROM items')[0].n === before;
});
// The thing Jeremy actually clicked.
await t('puts every one of them under the Deadline kind', async () => {
  const all = oldRows("SELECT * FROM items WHERE title LIKE 'Sunnyside Deadline:%'");
  // The four backfilled, plus the one that was already there.
  return all.length === 5 && all.every((r) => r.event_type === 'deadline'
    && r.sub_types === null && r.end_date === r.start_date);
});
// A later edit of the source item must move the backfilled row rather than
// add a second one beside it.
await t('hands the backfilled row over to the ordinary rule', async () => {
  const w = await freshWorker();
  await w.fetch(new Request('https://cal.test/api/items/' + ADVO, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com',
    },
    body: JSON.stringify({ start_date: ymd(60), end_date: ymd(60) }),
  }), { ...ENV, DB: d1(old) }, { waitUntil() {} });
  const d = dl(ADVO);
  return d.length === 1 && d[0].start_date === ymd(60 - 21);
});

console.log('');
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
