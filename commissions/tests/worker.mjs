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

// ── Xero, stubbed at the network ────────────────────────────────────────
//
// globalThis.fetch is what the Worker reaches for, so that is what is
// replaced. Everything below is Xero's real response shape, taken from its
// OpenAPI spec -- including the Microsoft dates, which are the thing most
// likely to be got wrong.
const xero = { calls: [], refresh: 'refresh-1', issued: 0, invoicePages: {}, tokenStatus: 200 };
const msdate = (iso) => '/Date(' + Date.parse(iso) + '+0000)/';
const invoice = (n, over) => Object.assign({
  Type: 'ACCREC', InvoiceID: 'inv-' + n, InvoiceNumber: String(22000 + n), Total: 610,
  CurrencyCode: 'USD', Contact: { Name: 'Shop ' + n },
  LineItems: [{ AccountCode: '200' }],
  UpdatedDateUTC: msdate('2026-10-2' + (n % 9) + 'T10:00:00Z'),
  Payments: [{ PaymentID: 'pay-' + n, Date: msdate('2026-10-27T00:00:00Z'),
               Amount: 610, Reference: 'Direct Debit', Status: 'AUTHORISED' }],
}, over || {});

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  xero.calls.push({ url: u, opts });
  if (u.startsWith('https://identity.xero.com/connect/token')) {
    if (xero.tokenStatus !== 200) {
      return reply(xero.tokenStatus, { error: 'invalid_grant',
                                       error_description: 'refresh token expired' });
    }
    xero.issued += 1;
    // Xero rotates the refresh token on every refresh and kills the old one.
    xero.refresh = 'refresh-' + (xero.issued + 1);
    return reply(200, { access_token: 'access-' + xero.issued, refresh_token: xero.refresh });
  }
  if (u === 'https://api.xero.com/connections') {
    return reply(200, [{ tenantId: 'tenant-1', tenantName: 'Jetty Brand' }]);
  }
  if (u.startsWith('https://api.xero.com/api.xro/2.0/Invoices')) {
    const page = Number(new URL(u).searchParams.get('page'));
    return reply(200, { Invoices: xero.invoicePages[page] || [] });
  }
  throw new Error('unexpected fetch: ' + u);
};

const XENV = { ...ENV, XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'csecret',
               XERO_ACCOUNTS: '200' };
const xcall = async (method, p, body) => {
  const res = await worker.fetch(new Request('https://cm.test' + p, {
    method,
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'amy@jettylife.com' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), XENV, { waitUntil() {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

console.log('connecting to Xero');

await t('says it is not connected yet', async () => {
  const r = await xcall('GET', '/api/xero/status');
  return r.status === 200 && r.body.connected === false && r.body.configured === true;
});
// Without offline_access the link dies in half an hour, on a Sunday.
await t('sends people to Xero asking for offline access', async () => {
  const r = await xcall('GET', '/api/xero/connect');
  const go = new URL(r.body.go);
  return go.origin + go.pathname === 'https://login.xero.com/identity/connect/authorize'
    && go.searchParams.get('scope').includes('offline_access')
    && go.searchParams.get('redirect_uri') === 'https://cm.test/api/xero/callback'
    && (go.searchParams.get('state') || '').length > 20;
});
await t('refuses a callback whose state it did not issue', async () =>
  (await xcall('GET', '/api/xero/callback?code=abc&state=not-mine')).status === 400);
await t('refuses a callback with no code at all', async () => {
  const state = new URL((await xcall('GET', '/api/xero/connect')).body.go)
    .searchParams.get('state');
  return (await xcall('GET', '/api/xero/callback?state=' + state)).status === 400;
});
await t('stores the organisation and the refresh token', async () => {
  const state = new URL((await xcall('GET', '/api/xero/connect')).body.go)
    .searchParams.get('state');
  const r = await xcall('GET', '/api/xero/callback?code=abc&state=' + state);
  const row = rows('SELECT * FROM xero WHERE id = 1')[0];
  return r.status === 302 && row.tenant_id === 'tenant-1'
    && row.tenant_name === 'Jetty Brand' && row.refresh_token
    && row.connected_by === 'amy@jettylife.com';
});
// One-time: a callback arriving twice is not the one we sent somebody off
// with.
await t('will not take the same state twice', async () => {
  const state = new URL((await xcall('GET', '/api/xero/connect')).body.go)
    .searchParams.get('state');
  const first = await xcall('GET', '/api/xero/callback?code=abc&state=' + state);
  const again = await xcall('GET', '/api/xero/callback?code=abc&state=' + state);
  return first.status === 302 && again.status === 400;
});

console.log('');
console.log('pulling from Xero');

await t('puts every wholesale payment in the queue', async () => {
  xero.invoicePages = { 1: [invoice(1), invoice(2), invoice(3)] };
  const r = await xcall('POST', '/api/xero/pull', { full: true });
  const got = rows("SELECT * FROM payments WHERE source = 'xero' ORDER BY source_ref");
  return r.status === 200 && r.body.made === 3 && got.length === 3
    && got[0].source_ref === 'pay-1' && got[0].retailer === 'Shop 1'
    && got[0].paid_on === '2026-10-27' && got[0].rep_key === null
    && got[0].created_by === 'xero';
});
// A duplicate payment is a duplicate commission.
await t('writes nothing the second time the same window is pulled', async () => {
  const r = await xcall('POST', '/api/xero/pull', { full: true });
  return r.body.made === 0 && r.body.skipped === 3
    && rows("SELECT id FROM payments WHERE source = 'xero'").length === 3;
});
// Xero kills the old refresh token the moment it issues a new one, so a
// stored token that is one behind means the next run cannot connect at all.
await t('stores the rotated refresh token every time', async () => {
  const before = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  await xcall('POST', '/api/xero/pull', {});
  const after = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  return before !== after && after === xero.refresh;
});
await t('ignores invoices that are not wholesale', async () => {
  xero.invoicePages = { 1: [
    invoice(10, { LineItems: [{ AccountCode: '999' }] }),
    invoice(11, { Type: 'ACCPAY' }),
    invoice(12),
  ] };
  const r = await xcall('POST', '/api/xero/pull', { full: true });
  return r.body.made === 1
    && rows("SELECT id FROM payments WHERE source_ref = 'pay-12'").length === 1
    && rows("SELECT id FROM payments WHERE source_ref IN ('pay-10','pay-11')").length === 0;
});
// Empty config must import nothing rather than everything.
await t('refuses to pull when no wholesale account is configured', async () => {
  const res = await worker.fetch(new Request('https://cm.test/api/xero/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'amy@jettylife.com' },
    body: '{}',
  }), { ...XENV, XERO_ACCOUNTS: '' }, { waitUntil() {} });
  return res.status === 500 && /XERO_ACCOUNTS/.test(await res.text());
});
await t('moves the watermark on so the next run asks for less', async () => {
  const w = rows('SELECT watermark FROM xero WHERE id = 1')[0].watermark;
  return typeof w === 'string' && w.startsWith('2026-10-2');
});
await t('says what it did, where the page can show it', async () => {
  const r = await xcall('GET', '/api/xero/status');
  return r.body.connected === true && r.body.tenant === 'Jetty Brand'
    && r.body.lastResult.made === 1 && Array.isArray(r.body.accounts);
});
// The reason belongs where somebody will see it, not in a log nobody reads.
await t('records why a pull failed rather than throwing it away', async () => {
  xero.tokenStatus = 400;
  const r = await xcall('POST', '/api/xero/pull', {});
  xero.tokenStatus = 200;
  return r.status === 500 && /refresh token expired/.test(r.text);
});

console.log('');
console.log('the queue');

// Seeded straight into the table: the queue is the same queue however a
// payment arrived, and the Xero path is covered above.
const seed = (ref, paid_on, retailer, gross) => sqlite.prepare(
  'INSERT INTO payments (id, source, source_ref, paid_on, retailer, gross) '
  + "VALUES (?, 'manual', ?, ?, ?, ?)")
  .run(crypto.randomUUID(), ref, paid_on, retailer, gross);

await t('lists what is waiting, oldest first', async () => {
  seed('rec-old', '2026-09-01', 'PRO Skateboard Shop', 1000);
  seed('rec-new', '2026-10-28', 'Surf Unlimited', 1000);
  const r = await call('GET', '/api/queue');
  return r.status === 200 && r.body.rows[0].paid_on === '2026-09-01' && r.body.waiting >= 5;
});
await t('works out the figures on the way out', async () => {
  seed('rec-math', '2026-10-01', 'East of Maui', 1000);
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
  const r = await call('PATCH', '/api/payments/' + idOf('pay-1'),
    { rep_key: 'Nathan Zelena', commission_pct: 10 });
  return r.status === 400;
});
await t('allocates once the rep exists', async () => {
  sqlite.prepare("INSERT INTO reps (key, name, email) VALUES ('nathan-zelena','Nathan Zelena LLC','n@x.com')").run();
  const r = await call('PATCH', '/api/payments/' + idOf('pay-1'),
    { rep_key: 'nathan-zelena', commission_pct: 10 });
  const got = rows("SELECT * FROM payments WHERE source_ref = 'pay-1'")[0];
  return r.status === 200 && got.rep_key === 'nathan-zelena'
    && got.amount_due === 61 && got.updated_by === 'amy@jettylife.com';
});
// The whole definition of the queue, and the one thing allocating is for.
await t('takes it out of the queue', async () => {
  const r = await call('GET', '/api/queue');
  return !r.body.rows.some((x) => x.id === idOf('pay-1'));
});
// A form that sends only the rep must not blank what somebody typed
// yesterday.
await t('merges over what is already stored', async () => {
  const id = idOf('pay-2');
  await call('PATCH', '/api/payments/' + id, { retailer: 'Third Coast Beach Co.', territory: 'MI' });
  await call('PATCH', '/api/payments/' + id, { rep_key: 'nathan-zelena', commission_pct: 8 });
  const got = rows('SELECT * FROM payments WHERE id = ?', id)[0];
  return got.retailer === 'Third Coast Beach Co.' && got.territory === 'MI'
    && got.rep_key === 'nathan-zelena';
});
await t('will not take a rate that is not plausible', async () => {
  const r = await call('PATCH', '/api/payments/' + idOf('pay-3'),
    { rep_key: 'nathan-zelena', commission_pct: 1500 });
  return r.status === 400 && /over 50/.test(JSON.stringify(r.body));
});
await t('will not allocate a Canadian row with no USD net', async () => {
  sqlite.prepare("INSERT INTO payments (id, source, source_ref, paid_on, gross, cad) "
    + "VALUES (?, 'manual', 'rec-cad', '2026-10-01', 1400, 1)").run(crypto.randomUUID());
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
  const b = await worker.fetch(new Request('https://cm.test/api/payments/' + idOf('pay-1'),
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
