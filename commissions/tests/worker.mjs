// The Worker, actually run.
//
// index.js imports schema.sql through a wrangler rule and will not load in
// Node, so it is bundled the way wrangler does and run against node:sqlite
// behind a small D1 shim. Skipped, not failed, where esbuild is missing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sqlStatements } from '../worker/sql.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jetty-cm-')), 'bundle.mjs');
try {
  execFileSync('npx', ['--yes', 'esbuild', path.join(ROOT, 'worker', 'index.js'),
    '--bundle', '--format=esm', '--loader:.sql=text', '--outfile=' + out], { stdio: 'pipe' });
} catch (err) {
  console.log('esbuild is not available here, so the worker suite is skipped.');
  process.exit(0);
}

let instances = 0;
const freshWorker = async () => (await import(
  pathToFileURL(out).href + '?i=' + (instances += 1))).default;

// ── a D1 shim over node:sqlite ──────────────────────────────────────────
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
  COMMISSION_USERS: 'amy@jettylife.com',
  INGEST_KEY: 'a-long-shared-secret',
  // No team domain and no AUD: the local-dev path through access.js, where
  // the header alone identifies a user. Never how production runs.
};

const worker = await freshWorker();

const call = async (method, p, body, headers) => {
  const res = await worker.fetch(new Request('https://cm.test' + p, {
    method,
    headers: Object.assign({
      'content-type': 'application/json',
      'Cf-Access-Authenticated-User-Email': 'amy@jettylife.com',
    }, headers || {}),
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
  ran += 1;
  try {
    const okay = await fn();
    console.log((okay ? '  ok   ' : '  FAIL ') + name);
    if (!okay) failed += 1;
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
};
const rows = (sql, ...b) => sqlite.prepare(sql).all(...b);

const payment = (x) => Object.assign({
  source_ref: 'rec' + Math.random().toString(36).slice(2, 10),
  paid_on: '2026-10-27', gross: 1000, retailer: 'East of Maui',
}, x || {});
const ingest = (body, key) => call('POST', '/api/ingest', body,
  { 'x-ingest-key': key === undefined ? 'a-long-shared-secret' : key });

console.log('the feed');

await t('takes a payment and puts it in the queue', async () => {
  const r = await ingest(payment({ source_ref: 'rec-one', invoice_no: '22183' }));
  const got = rows("SELECT * FROM payments WHERE source_ref = 'rec-one'");
  return r.status === 200 && r.body.made === 1 && got.length === 1
    && got[0].rep_key === null && got[0].created_by === 'feed'
    && got[0].invoice_no === '22183';
});
// A duplicate payment is a duplicate commission: money out of the door
// rather than a tidy-up.
await t('writes nothing the second time a payment is replayed', async () => {
  const r = await ingest(payment({ source_ref: 'rec-one', gross: 9999 }));
  const got = rows("SELECT gross FROM payments WHERE source_ref = 'rec-one'");
  return r.body.made === 0 && r.body.skipped === 1
    && got.length === 1 && got[0].gross === 1000;
});
await t('takes a batch, and reports what it could not take', async () => {
  const r = await ingest({ payments: [
    payment({ source_ref: 'rec-a' }),
    payment({ source_ref: 'rec-b', paid_on: '10/27/2026' }),
    payment({ source_ref: 'rec-c' }),
  ] });
  return r.status === 207 && r.body.made === 2 && r.body.errors.length === 1
    && r.body.errors[0].ref === 'rec-b';
});
// The one path answered before the Access check, so the key is the only
// thing standing in front of it.
await t('refuses the wrong key, and says nothing else', async () => {
  const r = await ingest(payment(), 'not-the-key');
  return r.status === 401 && !/secret/.test(r.text);
});
await t('refuses a missing key', async () => (await ingest(payment(), '')).status === 401);
// An unset secret must not mean an open endpoint.
await t('refuses everything when no key is configured', async () => {
  const w = await freshWorker();
  const res = await w.fetch(new Request('https://cm.test/api/ingest', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payment()),
  }), { ...ENV, INGEST_KEY: '' }, { waitUntil() {} });
  return res.status === 503;
});
await t('will not read, allocate or pay through the feed', async () => {
  const get = await call('GET', '/api/ingest', undefined, { 'x-ingest-key': 'a-long-shared-secret' });
  return get.status === 405;
});
// The feed reaches a Worker with no Access identity at all; nothing else may.
await t('lets nothing else past without an Access identity', async () => {
  const res = await worker.fetch(new Request('https://cm.test/api/queue'), ENV, { waitUntil() {} });
  return res.status === 403;
});

console.log('');
console.log('the queue');

await t('lists what is waiting, oldest first', async () => {
  await ingest({ payments: [
    payment({ source_ref: 'rec-old', paid_on: '2026-09-01', retailer: 'PRO Skateboard Shop' }),
    payment({ source_ref: 'rec-new', paid_on: '2026-10-28', retailer: 'Surf Unlimited' }),
  ] });
  const r = await call('GET', '/api/queue');
  const first = r.body.rows[0];
  return r.status === 200 && first.paid_on === '2026-09-01' && r.body.waiting >= 5;
});
await t('works out the figures on the way out', async () => {
  await ingest(payment({ source_ref: 'rec-math', gross: 1000 }));
  await call('PATCH', '/api/payments/' + rows(
    "SELECT id FROM payments WHERE source_ref = 'rec-math'")[0].id,
    { credits: -100, freight: 25 });
  const got = rows("SELECT net_invoice, amount_due FROM payments WHERE source_ref = 'rec-math'")[0];
  return got.net_invoice === 875 && got.amount_due === 0;
});
await t('searches on retailer and invoice', async () => {
  const r = await call('GET', '/api/queue?q=Skateboard');
  return r.body.rows.length === 1 && r.body.rows[0].retailer === 'PRO Skateboard Shop';
});

console.log('');
console.log('allocating');

const idOf = (ref) => rows('SELECT id FROM payments WHERE source_ref = ?', ref)[0].id;

await t('needs a rep on the list, so a typed name cannot get in', async () => {
  const r = await call('PATCH', '/api/payments/' + idOf('rec-one'),
    { rep_key: 'Nathan Zelena', commission_pct: 10 });
  return r.status === 400;
});
await t('allocates once the rep exists', async () => {
  sqlite.prepare("INSERT INTO reps (key, name, email) VALUES ('nathan-zelena','Nathan Zelena LLC','n@x.com')").run();
  const r = await call('PATCH', '/api/payments/' + idOf('rec-one'),
    { rep_key: 'nathan-zelena', commission_pct: 10 });
  const got = rows("SELECT * FROM payments WHERE source_ref = 'rec-one'")[0];
  return r.status === 200 && got.rep_key === 'nathan-zelena'
    && got.amount_due === 100 && got.updated_by === 'amy@jettylife.com';
});
// The whole definition of the queue, and the one thing allocating is for.
await t('takes it out of the queue', async () => {
  const r = await call('GET', '/api/queue');
  return !r.body.rows.some((x) => x.id === idOf('rec-one'));
});
// A form that sends only the rep must not blank what somebody typed
// yesterday.
await t('merges over what is already stored', async () => {
  const id = idOf('rec-a');
  await call('PATCH', '/api/payments/' + id, { retailer: 'Third Coast Beach Co.', territory: 'MI' });
  await call('PATCH', '/api/payments/' + id, { rep_key: 'nathan-zelena', commission_pct: 8 });
  const got = rows('SELECT * FROM payments WHERE id = ?', id)[0];
  return got.retailer === 'Third Coast Beach Co.' && got.territory === 'MI'
    && got.rep_key === 'nathan-zelena';
});
await t('will not take a rate that is not plausible', async () => {
  const r = await call('PATCH', '/api/payments/' + idOf('rec-c'),
    { rep_key: 'nathan-zelena', commission_pct: 1500 });
  return r.status === 400 && /over 50/.test(JSON.stringify(r.body));
});
await t('will not allocate a Canadian row with no USD net', async () => {
  await ingest(payment({ source_ref: 'rec-cad', gross: 1400, cad: true }));
  const r = await call('PATCH', '/api/payments/' + idOf('rec-cad'),
    { rep_key: 'nathan-zelena', commission_pct: 7 });
  return r.status === 400;
});
await t('pays a Canadian row on its USD net', async () => {
  const r = await call('PATCH', '/api/payments/' + idOf('rec-cad'),
    { rep_key: 'nathan-zelena', commission_pct: 7, usd_net: 1000 });
  const got = rows("SELECT amount_due FROM payments WHERE source_ref = 'rec-cad'")[0];
  return r.status === 200 && got.amount_due === 70;
});
await t('404s on a payment that does not exist', async () =>
  (await call('PATCH', '/api/payments/00000000-0000-4000-8000-000000000000', { retailer: 'x' }))
    .status === 404);

console.log('');
console.log('who can open it');

await t('refuses somebody not on the list, and says why', async () => {
  const res = await worker.fetch(new Request('https://cm.test/api/queue', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'arlynn@jettylife.com' },
  }), ENV, { waitUntil() {} });
  const body = await res.json();
  return res.status === 403 && /not on the commissions list/.test(body.error);
});
// There is no read-only tier: commission rates are not something to be
// half-admitted to.
await t('refuses them the choices and one payment too', async () => {
  const head = { 'Cf-Access-Authenticated-User-Email': 'arlynn@jettylife.com' };
  const a = await worker.fetch(new Request('https://cm.test/api/choices', { headers: head }), ENV, { waitUntil() {} });
  const b = await worker.fetch(new Request('https://cm.test/api/payments/' + idOf('rec-one'),
    { headers: head }), ENV, { waitUntil() {} });
  return a.status === 403 && b.status === 403;
});
await t('offers the form what has actually been used', async () => {
  const r = await call('GET', '/api/choices');
  return r.body.territories.includes('MI') && r.body.reps.length === 1
    && r.body.retailers.includes('East of Maui');
});

console.log('');
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
