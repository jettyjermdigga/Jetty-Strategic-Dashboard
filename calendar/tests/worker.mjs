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

// The mail service, stubbed at the network -- globalThis.fetch is what the
// Worker reaches for. Nothing here talks to Resend, and no test needs a key
// that would work if it did.
const mail = { sent: [], fail: '' };
const dm = { sent: [], fail: '', down: '', members: [] };
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    const body = JSON.parse(opts.body);
    if (mail.fail) {
      return { ok: false, status: 403,
               json: async () => ({ message: mail.fail }) };
    }
    mail.sent.push({ ...body, auth: opts.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ id: 'id-' + mail.sent.length }) };
  }
  // Slack, stubbed the same way. `dm.fail` refuses a named recipient so the
  // fall back to email can be checked; `dm.down` refuses the whole call.
  if (String(url).startsWith('https://slack.com/api/')) {
    const method = String(url).slice('https://slack.com/api/'.length);
    const body = JSON.parse(opts.body);
    if (dm.down) return { ok: true, status: 200, json: async () => ({ ok: false, error: dm.down }) };
    if (method === 'conversations.open') {
      if (dm.fail && dm.fail === body.users) {
        return { ok: true, status: 200, json: async () => ({ ok: false, error: 'user_not_found' }) };
      }
      return { ok: true, status: 200,
               json: async () => ({ ok: true, channel: { id: 'D' + body.users } }) };
    }
    if (method === 'chat.postMessage') {
      dm.sent.push({ channel: body.channel, text: body.text });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (method === 'users.list') {
      return { ok: true, status: 200,
               json: async () => ({ ok: true, members: dm.members, response_metadata: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  throw new Error('Unexpected fetch to ' + url);
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

// ── who gets reminded ──────────────────────────────────────────────────

console.log('');
console.log('reminders on a deadline');

let dlId = '';
await t('keeps the list, cleaned, on a deadline', async () => {
  const r = await call('POST', '/api/items', {
    title: 'Artwork to Sunnyside', event_type: 'deadline', department: 'marketing',
    status: 'Booked', start_date: ymd(5), end_date: ymd(5), all_day: 1,
    notes: 'Three sizes.',
    remind_emails: 'Katie@jettylife.com; katie@jettylife.com, jim@sunnyside.co',
  });
  dlId = r.body && r.body.item && r.body.item.id;
  const got = rows('SELECT remind_emails FROM items WHERE id = ?', dlId)[0];
  return r.status === 201
    && got.remind_emails === 'katie@jettylife.com,jim@sunnyside.co';
});

await t('refuses an address that is not one, and keeps the old list', async () => {
  const r = await call('PATCH', '/api/items/' + dlId, { remind_emails: 'Katie' });
  const got = rows('SELECT remind_emails FROM items WHERE id = ?', dlId)[0];
  return r.status === 400 && /not an email address/.test(r.body.error)
    && got.remind_emails === 'katie@jettylife.com,jim@sunnyside.co';
});

// Only a deadline is reminded about, so only a deadline keeps a list. A
// meeting carrying one would be a list its own form never showed.
await t('drops the list if the item stops being a deadline', async () => {
  await call('PATCH', '/api/items/' + dlId, { event_type: 'meeting' });
  const got = rows('SELECT remind_emails FROM items WHERE id = ?', dlId)[0];
  const gone = got.remind_emails === null || got.remind_emails === '';
  await call('PATCH', '/api/items/' + dlId,
             { event_type: 'deadline', remind_emails: 'katie@jettylife.com' });
  return gone;
});

await t('lists what is owed on the day before, and nothing on the day after',
  async () => {
    const before = await call('GET', '/api/reminders/due?on=' + ymd(4));
    const after = await call('GET', '/api/reminders/due?on=' + ymd(6));
    const mine = (before.body.due || []).filter((x) => x.id === dlId)[0];
    return before.status === 200 && mine
      && mine.to.join(',') === 'katie@jettylife.com'
      && /Artwork to Sunnyside/.test(mine.subject)
      && !(after.body.due || []).some((x) => x.id === dlId);
  });

// Nothing in the Worker sends mail. The endpoint says so rather than
// leaving somebody to assume a reminder went out because it was listed.
await t('says plainly that it is not sending anything', async () => {
  const r = await call('GET', '/api/reminders/due?on=' + ymd(4));
  return r.body.sending === false;
});

await t('stops listing one that has already been reminded', async () => {
  sqlite.prepare("UPDATE items SET reminded_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
    .run(dlId);
  const r = await call('GET', '/api/reminders/due?on=' + ymd(4));
  return !(r.body.due || []).some((x) => x.id === dlId);
});

// A reminder already sent was about the date it was sent for. Move the
// deadline and it has to go again, or the new date is one nobody is told
// about.
await t('tells people again when the deadline moves', async () => {
  await call('PATCH', '/api/items/' + dlId, { start_date: ymd(20), end_date: ymd(20) });
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', dlId)[0];
  return got.reminded_at === null;
});

await t('tells a newly added person, rather than leaving them out', async () => {
  sqlite.prepare("UPDATE items SET reminded_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
    .run(dlId);
  await call('PATCH', '/api/items/' + dlId,
             { remind_emails: 'katie@jettylife.com, joe@jettylife.com' });
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', dlId)[0];
  return got.reminded_at === null;
});

await t('leaves it alone on a save that changed neither', async () => {
  sqlite.prepare("UPDATE items SET reminded_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
    .run(dlId);
  await call('PATCH', '/api/items/' + dlId, { notes: 'Still three sizes.' });
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', dlId)[0];
  return got.reminded_at === '2026-01-01T00:00:00.000Z';
});

// The list belongs to the deadline, not to the item the deadline was made
// from -- deadlineFor() knows nothing about it, so writing every column on
// an update would wipe whoever was tagged on it.
await t('keeps the list on a Worker-made deadline when its source moves', async () => {
  const r = await call('POST', '/api/items', {
    title: 'Winter Push', event_type: 'marketing', department: 'marketing',
    status: 'Booked', start_date: ymd(50), end_date: ymd(50), all_day: 1,
    sub_types: 'paid-advo',
  });
  const srcId = r.body.item.id;
  const made = rows('SELECT * FROM items WHERE deadline_for = ?', srcId)[0];
  await call('PATCH', '/api/items/' + made.id, { remind_emails: 'amy@jettylife.com' });
  await call('PATCH', '/api/items/' + srcId, { start_date: ymd(70), end_date: ymd(70) });
  const after = rows('SELECT * FROM items WHERE deadline_for = ?', srcId)[0];
  return after.remind_emails === 'amy@jettylife.com'
    && after.start_date === ymd(70 - 21);
});

// ── actually sending them ──────────────────────────────────────────────

console.log('');
console.log('the reminder run');

const SEND_ENV = { ...ENV, RESEND_KEY: 're_test_key',
                   REMINDER_FROM: 'Jetty Calendar <jeremy@jettylife.com>',
                   REMINDER_REPLY_TO: 'jeremy@jettylife.com',
                   REMINDER_BCC: 'jeremy@jettylife.com' };

const sendCall = async (p, body, env) => {
  const res = await worker.fetch(new Request('https://cal.test' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
    body: JSON.stringify(body || {}),
  }), env || SEND_ENV, { waitUntil() {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let sendId = '';
await t('sends one email to everybody on the deadline', async () => {
  mail.sent.length = 0;
  const made = await call('POST', '/api/items', {
    title: 'Line sheet to Sunnyside', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    notes: 'Autumn, two colourways.',
    remind_emails: 'katie@jettylife.com, jim@sunnyside.co',
  });
  sendId = made.body.item.id;
  const r = await sendCall('/api/reminders/send', { on: ymd(2) });
  const one = mail.sent[0];
  return r.status === 200 && r.body.sent === 1 && r.body.failed === 0
    && mail.sent.length === 1
    && one.to.join(',') === 'katie@jettylife.com,jim@sunnyside.co'
    && one.from === 'Jetty Calendar <jeremy@jettylife.com>'
    && one.reply_to === 'jeremy@jettylife.com'
    && /Line sheet to Sunnyside/.test(one.subject)
    && /two colourways/.test(one.text)
    && one.auth === 'Bearer re_test_key';
});

// Blind, so whoever is watching sees every reminder without appearing on a
// To line that already carries an agency.
await t('blind-copies the watcher, off the recipients\' To line', async () => {
  const one = mail.sent[0];
  return one.bcc.join(',') === 'jeremy@jettylife.com'
    && !one.to.some((x) => /jeremy@/.test(x));
});

await t('does not copy somebody twice who is already on the deadline', async () => {
  mail.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'Tax filing', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'Jeremy@jettylife.com, joe@jettylife.com',
  });
  await sendCall('/api/reminders/send', { on: ymd(2) });
  const one = mail.sent.filter((m) => /Tax filing/.test(m.subject))[0];
  return one && one.to.indexOf('jeremy@jettylife.com') >= 0 && one.bcc === undefined;
});

await t('marks it sent, so the next run leaves it alone', async () => {
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', sendId)[0];
  mail.sent.length = 0;
  const again = await sendCall('/api/reminders/send', { on: ymd(2) });
  return Boolean(got.reminded_at) && again.body.sent === 0 && mail.sent.length === 0;
});

// A deadline whose reminder failed keeps a null reminded_at, so the next
// morning tries again rather than writing it off.
await t('does not mark one sent that the mail service refused', async () => {
  const made = await call('POST', '/api/items', {
    title: 'Permit renewal', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'colleen@jettylife.com',
  });
  const id = made.body.item.id;
  mail.fail = 'The jettylife.com domain is not verified.';
  const r = await sendCall('/api/reminders/send', { on: ymd(2) });
  mail.fail = '';
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', id)[0];
  return r.body.failed >= 1 && got.reminded_at === null
    && /not verified/.test((r.body.errors || []).join(' '));
});

// One bad address must not cost everybody else their morning.
await t('keeps going past one that failed', async () => {
  const errs = await sendCall('/api/reminders/send', { on: ymd(2) });
  return errs.status === 200;
});

// Until the key is set nothing goes out, and the reason is carried through
// rather than reported as a send that worked.
await t('sends nothing, and says why, with no key set', async () => {
  // Something has to be owed, or the run returns before it ever looks for
  // a key and this passes for the wrong reason.
  mail.sent.length = 0;
  const made = await call('POST', '/api/items', {
    title: 'Insurance renewal', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'joe@jettylife.com',
  });
  const r = await sendCall('/api/reminders/send', { on: ymd(2) },
                           { ...ENV, REMINDER_FROM: 'a@b.com' });
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', made.body.item.id)[0];
  return r.body.owed >= 1 && r.body.sent === 0 && mail.sent.length === 0
    && got.reminded_at === null
    && /RESEND_KEY/.test((r.body.errors || []).join(' '));
});

await t('says on the listing whether a send would go at all', async () => {
  const off = await call('GET', '/api/reminders/due?on=' + ymd(2));
  const res = await worker.fetch(new Request(
    'https://cal.test/api/reminders/due?on=' + ymd(2),
    { headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' } }),
    SEND_ENV, { waitUntil() {} });
  const on = await res.json();
  return off.body.sending === false && /RESEND_KEY/.test(off.body.why)
    && on.sending === true && on.why === '';
});

// Nobody who is not an editor can make this Worker send mail.
await t('will not let a reader send anything', async () => {
  const res = await worker.fetch(new Request('https://cal.test/api/reminders/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'arlynn@jettylife.com' },
    body: '{}',
  }), SEND_ENV, { waitUntil() {} });
  return res.status === 403;
});

await t('runs on the cron without being asked', async () => {
  mail.sent.length = 0;
  sqlite.prepare("UPDATE items SET reminded_at = NULL, start_date = ?, end_date = ? "
    + 'WHERE id = ?').run(ymd(0), ymd(0), sendId);
  await worker.scheduled({}, SEND_ENV, { waitUntil() {} });
  const got = rows('SELECT reminded_at FROM items WHERE id = ?', sendId)[0];
  return mail.sent.length === 1 && Boolean(got.reminded_at);
});

// A thrown scheduled handler is retried, and every retry is another chance
// to send somebody the same reminder twice.
// Not a provider limit -- the blast radius of a bug. A mistake that made
// everything look due would otherwise send one email per deadline this
// calendar has ever held, in one run, before anybody could stop it.
await t('will not send more than one run should, and says there are more', async () => {
  mail.sent.length = 0;
  const put = sqlite.prepare(
    'INSERT INTO items (id, title, event_type, department, status, start_date, '
    + 'end_date, all_day, remind_emails) '
    + "VALUES (?, ?, 'deadline', 'wholesale', 'Booked', ?, ?, 1, 'flood@jettylife.com')");
  for (let i = 0; i < 60; i += 1) {
    put.run('flood-' + i, 'Flood ' + i, ymd(3), ymd(3));
  }
  const r = await sendCall('/api/reminders/send', { on: ymd(2) });
  const left = rows("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'flood-%' "
    + 'AND reminded_at IS NULL')[0].n;
  const capped = mail.sent.length <= 50 && r.body.more === true && left > 0;
  sqlite.prepare("DELETE FROM items WHERE id LIKE 'flood-%'").run();
  return capped;
});

await t('swallows a failure on the cron rather than being retried into one', async () => {
  mail.fail = 'nope';
  sqlite.prepare('UPDATE items SET reminded_at = NULL WHERE id = ?').run(sendId);
  let threw = false;
  try { await worker.scheduled({}, SEND_ENV, { waitUntil() {} }); } catch (e) { threw = true; }
  mail.fail = '';
  return !threw;
});

// ── the directory, and reminders that go by Slack ──────────────────────
//
// The point of the directory is that a reminder reaches somebody without a
// jettylife.com address and without a verified mail domain. Taylor is a
// guest in the Slack workspace, which is the case these are written around.

console.log('');
console.log('the people directory');

const SLACK_ENV = { ...SEND_ENV, SLACK_BOT_TOKEN: 'xoxb-test' };
// Slack but no mail service: the position before Resend is set up at all.
const SLACK_ONLY = { ...ENV, SLACK_BOT_TOKEN: 'xoxb-test',
                     REMINDER_BCC: 'jeremy@jettylife.com' };

const peopleCall = async (body, env) => {
  const res = await worker.fetch(new Request('https://cal.test/api/people', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
    body: JSON.stringify(body || {}),
  }), env || SLACK_ENV, { waitUntil() {} });
  return { status: res.status, body: await res.json().catch(() => null) };
};

await t('takes somebody the roster has never heard of', async () => {
  const r = await peopleCall({ name: 'Taylor Heussner',
    email: 'Taylor.Heussner@SunnySideCalifornia.com', slack_id: 'u0guest01' });
  const got = rows('SELECT * FROM people WHERE email = ?',
    'taylor.heussner@sunnysidecalifornia.com')[0];
  return r.status === 200 && got && got.slack_id === 'U0GUEST01'
    && got.manual === 1 && got.active === 1
    && got.added_by === 'jeremy@jettylife.com';
});

await t('refuses a Slack ID that is not one, rather than dropping it', async () => {
  const r = await peopleCall({ email: 'nope@elsewhere.com', slack_id: 'not-an-id' });
  const got = rows('SELECT * FROM people WHERE email = ?', 'nope@elsewhere.com');
  return r.status === 400 && /not a Slack ID/.test(r.body.error) && got.length === 0;
});

await t('will not let a reader change the directory', async () => {
  const res = await worker.fetch(new Request('https://cal.test/api/people', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'nobody@jettylife.com' },
    body: JSON.stringify({ email: 'x@y.co' }),
  }), SLACK_ENV, { waitUntil() {} });
  return res.status === 403;
});

// The whole reason `manual` exists. Slack is authoritative about Slack and
// wrong about exactly the rows somebody had to fix by hand.
await t('a Slack refresh does not undo a hand correction', async () => {
  await peopleCall({ name: 'Katie Hehl', email: 'katie@jettylife.com',
                     slack_id: 'U0KATIE01' });
  dm.members = [
    { id: 'U0SOMEONE', profile: { email: 'katie@jettylife.com', real_name: 'K. Hehl' } },
  ];
  sqlite.prepare('DELETE FROM meta WHERE key = ?').run('slack-roster-next');
  await worker.fetch(new Request('https://cal.test/api/people', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), SLACK_ENV, { waitUntil() {} });
  dm.members = [];
  const got = rows('SELECT * FROM people WHERE email = ?', 'katie@jettylife.com')[0];
  return got.slack_id === 'U0KATIE01' && got.name === 'Katie Hehl';
});

await t('DMs the people it has a Slack ID for', async () => {
  dm.sent.length = 0; mail.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'Artwork to Sunnyside', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    notes: 'Spring campaign, three sizes.',
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com',
  });
  const r = await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ENV);
  return r.body.sent === 1 && r.body.slack === 1 && r.body.email === 0
    && dm.sent.length === 1
    && dm.sent[0].channel === 'DU0GUEST01'
    && /Artwork to Sunnyside/.test(dm.sent[0].text)
    && /three sizes/.test(dm.sent[0].text)
    && !mail.sent.some((m) => /Artwork to Sunnyside/.test(m.subject));
});

await t('emails the ones it has no Slack ID for, in the same run', async () => {
  dm.sent.length = 0; mail.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'Mixed list', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com, printer@someshop.com',
  });
  const r = await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ENV);
  const one = mail.sent.filter((m) => /Mixed list/.test(m.subject))[0];
  return r.body.slack === 1 && r.body.email === 1
    && dm.sent.length === 1
    && one && one.to.join(',') === 'printer@someshop.com';
});

// A DM that fails must not be a reminder that vanishes.
await t('falls back to email when the DM is refused', async () => {
  dm.sent.length = 0; mail.sent.length = 0;
  dm.fail = 'U0GUEST01';
  await call('POST', '/api/items', {
    title: 'DM refused', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com',
  });
  const r = await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ENV);
  dm.fail = '';
  const one = mail.sent.filter((m) => /DM refused/.test(m.subject))[0];
  return r.body.sent === 1 && dm.sent.length === 0
    && one && one.to.join(',') === 'taylor.heussner@sunnysidecalifornia.com'
    && /trying email/.test((r.body.errors || []).join(' '));
});

// Before Resend exists at all, Slack alone still delivers.
await t('sends with no mail service configured at all', async () => {
  dm.sent.length = 0; mail.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'Slack only', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com',
  });
  const r = await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ONLY);
  return r.body.sent === 1 && r.body.slack === 1 && mail.sent.length === 0;
});

// Jeremy asked to see what went out without being tagged on each deadline.
// A Slack-only morning would have told him nothing.
await t('copies the watcher on Slack when no email went', async () => {
  await peopleCall({ name: 'Jeremy', email: 'jeremy@jettylife.com',
                     slack_id: 'U0JEREMY1' }, SLACK_ONLY);
  dm.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'Watcher copy', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com',
  });
  await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ONLY);
  return dm.sent.length === 2
    && dm.sent.some((d) => d.channel === 'DU0JEREMY1');
});

await t('does not copy the watcher twice when they are on the deadline', async () => {
  dm.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'Watcher tagged', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'jeremy@jettylife.com',
  });
  await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ONLY);
  return dm.sent.length === 1;
});

// Kevin's case. Switched off, still named on deadlines that already listed
// him, and the run has to say so rather than quietly sending nothing.
await t('says out loud that a switched-off person was not told', async () => {
  dm.sent.length = 0; mail.sent.length = 0;
  await peopleCall({ name: 'Kevin', email: 'kevin@jettylife.com', active: false });
  await call('POST', '/api/items', {
    title: 'Kevin still tagged', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'kevin@jettylife.com',
  });
  const r = await sendCall('/api/reminders/send', { on: ymd(2) }, SLACK_ENV);
  const said = (r.body.errors || []).join(' ');
  return r.body.skipped >= 1 && dm.sent.length === 0
    && !mail.sent.some((m) => (m.to || []).includes('kevin@jettylife.com'))
    && /kevin@jettylife.com/.test(said) && /not notified/i.test(said);
});

await t('forgetting a Slack person switches them off instead of deleting', async () => {
  const r = await peopleCall({ email: 'katie@jettylife.com', remove: true });
  const got = rows('SELECT * FROM people WHERE email = ?', 'katie@jettylife.com')[0];
  // She was hand-corrected, so manual = 1 and the row really goes.
  return r.body.how === 'deleted' && got === undefined;
});

// A directory full of Slack IDs is useless if the token goes away. The
// address typed on the deadline is still an address.
await t('emails a Slack person when there is no token to send with', async () => {
  dm.sent.length = 0; mail.sent.length = 0;
  await call('POST', '/api/items', {
    title: 'No token', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com',
  });
  // SEND_ENV has the mail service but no SLACK_BOT_TOKEN.
  const r = await sendCall('/api/reminders/send', { on: ymd(2) }, SEND_ENV);
  const one = mail.sent.filter((m) => /No token/.test(m.subject))[0];
  return r.body.sent === 1 && dm.sent.length === 0
    && one && one.to.join(',') === 'taylor.heussner@sunnysidecalifornia.com';
});

// Deleting a row Slack knows about achieves nothing -- the next refresh puts
// it straight back, and whoever deleted it believes they are done.
await t('forgetting a Slack-sourced person switches them off, not deletes', async () => {
  sqlite.prepare(
    'INSERT INTO people (email, name, slack_id, manual, active) VALUES (?, ?, ?, 0, 1)')
    .run('fromslack@jettylife.com', 'From Slack', 'U0FROMSLK');
  const r = await peopleCall({ email: 'fromslack@jettylife.com', remove: true });
  const got = rows('SELECT * FROM people WHERE email = ?', 'fromslack@jettylife.com')[0];
  return r.body.how === 'switched off' && got && got.active === 0
    && /bring them back/.test(r.body.note || '');
});

// Seeing that somebody would be reached, and how, is the whole point of
// being able to look before the morning.
await t('the listing says which channel each person would take', async () => {
  await call('POST', '/api/items', {
    title: 'Channel listing', event_type: 'deadline', department: 'wholesale',
    status: 'Booked', start_date: ymd(3), end_date: ymd(3), all_day: 1,
    remind_emails: 'taylor.heussner@sunnysidecalifornia.com, printer@someshop.com, kevin@jettylife.com',
  });
  const res = await worker.fetch(new Request('https://cal.test/api/reminders/due?on=' + ymd(2), {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), SLACK_ENV, { waitUntil() {} });
  const body = await res.json();
  const row = (body.due || []).filter((d) => d.title === 'Channel listing')[0];
  if (!row) return false;
  const by = {};
  for (const r of row.recipients) by[r.email] = r.channel;
  return body.sending === true && body.slack === true
    && by['taylor.heussner@sunnysidecalifornia.com'] === 'slack'
    && by['printer@someshop.com'] === 'email'
    && by['kevin@jettylife.com'] === 'none';
});

// The calendar feed. Its token is not behind Access and nothing about it
// goes through a mailbox, so it is the one credential that outlives an
// offboarding -- and the step that gets forgotten.

await t('shows who holds a live calendar feed', async () => {
  await peopleCall({ name: 'The printer', email: 'printer@someshop.com' });
  sqlite.prepare(
    'INSERT INTO feeds (token, email, filters, created_at) VALUES (?, ?, ?, ?)')
    .run('f'.repeat(64), 'taylor.heussner@sunnysidecalifornia.com', '{}', '2026-01-01');
  const res = await worker.fetch(new Request('https://cal.test/api/people', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), SLACK_ENV, { waitUntil() {} });
  const body = await res.json();
  const by = {};
  for (const p of body.people) by[p.email] = p.feed;
  return by['taylor.heussner@sunnysidecalifornia.com'] === true
    && by['printer@someshop.com'] === false;
});

await t('revokes a feed on its own, and says it really went', async () => {
  const r = await peopleCall({ email: 'taylor.heussner@sunnysidecalifornia.com',
                               revokeFeed: true });
  const left = rows('SELECT * FROM feeds WHERE email = ?',
    'taylor.heussner@sunnysidecalifornia.com');
  return r.body.feedRevoked === 1 && left.length === 0
    && /no longer works/.test(r.body.note || '');
});

// The address may arrive however somebody typed it. A revoke that silently
// matches nothing is the worst possible outcome here: it reports success and
// leaves the link working.
await t('revokes regardless of how the address was typed', async () => {
  sqlite.prepare(
    'INSERT INTO feeds (token, email, filters, created_at) VALUES (?, ?, ?, ?)')
    .run('c'.repeat(64), 'mixedcase@jettylife.com', '{}', '2026-01-01');
  const r = await peopleCall({ email: '  MixedCase@JettyLife.com  ', revokeFeed: true });
  const left = rows('SELECT * FROM feeds WHERE email = ?', 'mixedcase@jettylife.com');
  return r.body.feedRevoked === 1 && left.length === 0;
});

// Claiming to have revoked something that was not there is how somebody
// believes a door is shut when it never existed.
await t('says plainly when there was no feed to revoke', async () => {
  const r = await peopleCall({ email: 'printer@someshop.com', revokeFeed: true });
  return r.body.feedRevoked === 0 && /nothing to revoke/.test(r.body.note || '');
});

// The whole point: one action, nothing left behind.
await t('switching somebody off revokes their feed too', async () => {
  sqlite.prepare(
    'INSERT INTO feeds (token, email, filters, created_at) VALUES (?, ?, ?, ?)')
    .run('e'.repeat(64), 'exiting@jettylife.com', '{}', '2026-01-01');
  sqlite.prepare(
    'INSERT INTO people (email, name, slack_id, manual, active) VALUES (?, ?, ?, 0, 1)')
    .run('exiting@jettylife.com', 'On the way out', 'U0EXIT001');
  const r = await peopleCall({ email: 'exiting@jettylife.com', remove: true });
  const feed = rows('SELECT * FROM feeds WHERE email = ?', 'exiting@jettylife.com');
  const who = rows('SELECT * FROM people WHERE email = ?', 'exiting@jettylife.com')[0];
  return feed.length === 0 && r.body.feedRevoked === 1
    && /feed link was revoked/.test(r.body.note || '')
    && who.active === 0;
});

await t('will not let a reader revoke a feed', async () => {
  sqlite.prepare(
    'INSERT INTO feeds (token, email, filters, created_at) VALUES (?, ?, ?, ?)')
    .run('d'.repeat(64), 'safe@jettylife.com', '{}', '2026-01-01');
  const res = await worker.fetch(new Request('https://cal.test/api/people', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'nobody@jettylife.com' },
    body: JSON.stringify({ email: 'safe@jettylife.com', revokeFeed: true }),
  }), SLACK_ENV, { waitUntil() {} });
  const left = rows('SELECT * FROM feeds WHERE email = ?', 'safe@jettylife.com');
  return res.status === 403 && left.length === 1;
});

await t('flags a directory address Access will not let in', async () => {
  await peopleCall({ name: 'The printer', email: 'printer@someshop.com' });
  const res = await worker.fetch(new Request('https://cal.test/api/people', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'jeremy@jettylife.com' },
  }), { ...SLACK_ENV, ACCESS_DOMAINS: 'jettylife.com,sunnysidecalifornia.com' },
    { waitUntil() {} });
  const body = await res.json();
  return Array.isArray(body.outsideAccess)
    && body.outsideAccess.includes('printer@someshop.com')
    && !body.outsideAccess.includes('taylor.heussner@sunnysidecalifornia.com');
});

console.log('');
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
