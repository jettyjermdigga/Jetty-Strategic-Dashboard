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
// An R2 bucket, in a Map. put/get is all the Worker asks of it, and the
// metadata is kept so a test can check the browser is told it is a
// spreadsheet rather than left to guess from the bytes.
const bucket = new Map();
const r2 = {
  async put(key, body, opts) {
    bucket.set(key, { body, opts: opts || {} });
    return { key };
  },
  async get(key) {
    const o = bucket.get(key);
    return o ? { body: o.body, httpMetadata: (o.opts || {}).httpMetadata } : null;
  },
};

const ENV = {
  DB: d1(sqlite),
  FILES: r2,
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

// ── Xero, stubbed at the network ────────────────────────
//
// globalThis.fetch is what the Worker reaches for, so that is what is
// replaced. Everything below is Xero's real response shape, taken from its
// OpenAPI spec -- including the Microsoft dates, which are the thing most
// likely to be got wrong.
const xero = { calls: [], issued: 0, invoicePages: {}, tokenStatus: 200,
               orgs: null, orgHeaders: null, refusedOn: '',
               holds: ['accounting.invoices.read', 'accounting.payments.read',
                       'accounting.settings.read'] };
// What this app is permitted to request, trimmed to what is needed.
const HOLDS = ['accounting.invoices.read', 'accounting.payments.read',
               'accounting.settings.read'];
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
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// A Xero access token is a JWT and the scope claim is read off it, so the
// stub has to hand back something shaped like one.
const token = (n) => 'hdr.' + btoa(JSON.stringify({
  sub: 'conn', scope: xero.holds.join(' '), jti: String(n),
})).replace(/=+$/, '') + '.sig';

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  xero.calls.push({ url: u, opts });
  if (u.startsWith('https://identity.xero.com/connect/token')) {
    if (xero.tokenStatus !== 200) {
      return reply(xero.tokenStatus, { error: 'invalid_grant',
                                       error_description: 'Refresh token expired' });
    }
    xero.issued += 1;
    // Rotated on every single refresh: the one just used is dead. A stub
    // that handed the same one back would hide the bug this is for.
    return reply(200, { access_token: token(xero.issued), expires_in: 1800,
                        refresh_token: 'refresh-' + xero.issued });
  }
  if (u === 'https://api.xero.com/connections') {
    return reply(200, xero.orgs === null
      ? [{ tenantId: 'tenant-1', tenantName: 'Jetty Brand' }] : xero.orgs);
  }
  if (u.startsWith('https://api.xero.com/api.xro/2.0/')) {
    // Without the tenant header the real API answers 403 with no body at
    // all, which is the least helpful refusal it has and the one that
    // cost this module a day.
    const t = (opts.headers || {})['xero-tenant-id'];
    if (!t) return reply(403, '');
    if (xero.refusedOn && u.includes(xero.refusedOn)) return reply(403, '');
  }
  if (u.startsWith('https://api.xero.com/api.xro/2.0/Accounts')) {
    xero.orgHeaders = opts.headers;
    return reply(200, { Accounts: [
      { Code: '200', Name: 'Wholesale Revenue', Class: 'REVENUE', Status: 'ACTIVE' },
      { Code: '090', Name: 'Bank', Class: 'ASSET', Status: 'ACTIVE' },
    ] });
  }
  if (u.startsWith('https://api.xero.com/api.xro/2.0/Invoices')) {
    const page = Number(new URL(u).searchParams.get('page'));
    return reply(200, { Invoices: xero.invoicePages[page] || [] });
  }
  if (u.startsWith('https://api.xero.com/api.xro/2.0/Organisation')) {
    return reply(200, { Organisations: [{ OrganisationID: 'tenant-1', Name: 'Jetty Brand' }] });
  }
  throw new Error('unexpected fetch: ' + u);
};

const XENV = { ...ENV, XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'csecret',
               XERO_ACCOUNTS: '200' };
const xcall = async (method, p, body, env) => {
  const res = await worker.fetch(new Request('https://cm.test' + p, {
    method,
    headers: { 'content-type': 'application/json',
               'Cf-Access-Authenticated-User-Email': 'amy@jettylife.com' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  }), env || XENV, { waitUntil() {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

// The trap this codebase keeps falling into, checked against a real
// database rather than by reading the source: a table that already
// exists is not revisited by CREATE TABLE IF NOT EXISTS, so a column
// added to schema.sql alone reaches every database except the live one.
await t('gains a new column on a database that already existed', async () => {
  const old = new DatabaseSync(':memory:');
  // The xero table as it shipped, before refreshed_at was added to it.
  old.exec('CREATE TABLE xero (id INTEGER PRIMARY KEY CHECK (id = 1), '
    + 'tenant_id TEXT, tenant_name TEXT, refresh_token TEXT, oauth_state TEXT, '
    + 'oauth_at TEXT, connected_by TEXT, connected_at TEXT, watermark TEXT, '
    + 'last_run_at TEXT, last_result TEXT)');
  let had = true;
  try { old.prepare('SELECT refreshed_at FROM xero').all(); } catch (e) { had = false; }
  for (const [table, col] of [['xero', 'refreshed_at TEXT']]) {
    try { old.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col); } catch (e) { /* there */ }
  }
  let now = true;
  try { old.prepare('SELECT refreshed_at FROM xero').all(); } catch (e) { now = false; }
  // And again, because every boot runs it: the second time has to be a
  // no-op rather than an error that takes the Worker down.
  let twice = true;
  try {
    old.exec('ALTER TABLE xero ADD COLUMN refreshed_at TEXT');
  } catch (e) { twice = false; }
  return had === false && now === true && twice === false;
});

console.log('signing in to Xero');

await t('says nothing is connected yet', async () => {
  const r = await xcall('GET', '/api/xero/status');
  return r.status === 200 && r.body.connected === false && r.body.configured === true;
});
// A Web app reaches an organisation only once somebody authorises it
// against one. Until then a token is real and points at no books, which
// is exactly the state this module spent a day in.
await t('sends you to Xero to sign in', async () => {
  const r = await xcall('GET', '/api/xero/connect');
  const go = (r.body && r.body.go) || '';
  const q = new URLSearchParams(go.slice(go.indexOf('?') + 1));
  return r.status === 200
    && go.startsWith('https://login.xero.com/identity/connect/authorize?')
    && q.get('response_type') === 'code'
    && q.get('redirect_uri') === 'https://cm.test/api/xero/callback'
    && q.get('scope').includes('offline_access')
    && q.get('scope').includes('accounting.invoices.read')
    && q.get('scope').includes('accounting.payments.read')
    && q.get('state').length > 10;
});
// A callback arriving with a borrowed state is not the one this sent
// somebody off with.
await t('refuses a callback whose state it did not issue', async () => {
  const r = await xcall('GET', '/api/xero/callback?code=abc&state=not-the-one');
  return r.status === 400 && /did not match/.test(r.text);
});
// Xero says why it refused in the URL rather than in a body, and "that
// did not match" would be a lie about a scope it would not grant.
await t('passes on what Xero said when it refuses the sign-in', async () => {
  const r = await xcall('GET',
    '/api/xero/callback?error=invalid_scope&error_description=Bad%20scope');
  return r.status === 400 && /invalid_scope/.test(r.text) && /Bad scope/.test(r.text);
});
await t('takes the code and remembers the organisation', async () => {
  const start = await xcall('GET', '/api/xero/connect');
  const state = new URLSearchParams(start.body.go.slice(start.body.go.indexOf('?') + 1))
    .get('state');
  const r = await xcall('GET', '/api/xero/callback?code=abc&state=' + state);
  const row = rows('SELECT * FROM xero WHERE id = 1')[0];
  return r.status === 302 && /connected=Jetty%20Brand/.test(r.headers.get('location'))
    && row.tenant_id === 'tenant-1' && row.tenant_name === 'Jetty Brand'
    && Boolean(row.refresh_token);
});
// One-time: the same callback replayed is not a second sign-in.
await t('will not take the same callback twice', async () => {
  const start = await xcall('GET', '/api/xero/connect');
  const state = new URLSearchParams(start.body.go.slice(start.body.go.indexOf('?') + 1))
    .get('state');
  await xcall('GET', '/api/xero/callback?code=abc&state=' + state);
  const again = await xcall('GET', '/api/xero/callback?code=abc&state=' + state);
  return again.status === 400;
});
await t('says which organisation it reached', async () => {
  const r = await xcall('GET', '/api/xero/status');
  return r.body.connected === true && r.body.tenant === 'Jetty Brand';
});
// Xero rotates the refresh token on every refresh. Not writing the new
// one back makes the connection work exactly once and then fail silently.
await t('writes the rotated refresh token back', async () => {
  const before = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  await xcall('GET', '/api/xero/accounts');
  const after = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  return before !== after && Boolean(after);
});
// A missing scope does not refuse the call. It returns invoices with an
// empty Payments array, which reads as a quiet month rather than as a
// permissions problem -- so it has to be caught at the token.
await t('stops when the token does not hold what it needs', async () => {
  xero.holds = ['accounting.settings.read'];
  const r = await xcall('GET', '/api/xero/accounts');
  xero.holds = HOLDS.slice();
  return r.status === 500 && /accounting.invoices.read/.test(r.text);
});
await t('accepts a token granted more than it needs', async () => {
  xero.holds = ['accounting.invoices', 'accounting.payments',
                'accounting.settings', 'accounting.contacts'];
  const r = await xcall('GET', '/api/xero/accounts');
  xero.holds = HOLDS.slice();
  return r.status === 200;
});
// Sending no tenant header answers 403 with no body. Every call carries
// the organisation that was chosen at sign-in.
await t('carries the organisation on every call', async () => {
  await xcall('GET', '/api/xero/accounts');
  return xero.orgHeaders && xero.orgHeaders['xero-tenant-id'] === 'tenant-1';
});
await t('says what Xero refused rather than swallowing it', async () => {
  xero.tokenStatus = 400;
  const r = await xcall('GET', '/api/xero/accounts');
  xero.tokenStatus = 200;
  return r.status === 500 && /Refresh token expired/.test(r.text);
});
await t('refuses outright when nobody has signed in', async () => {
  const had = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  sqlite.exec('UPDATE xero SET refresh_token = NULL WHERE id = 1');
  const r = await xcall('GET', '/api/xero/accounts');
  sqlite.prepare('UPDATE xero SET refresh_token = ? WHERE id = 1').run(had);
  return r.status === 500 && /not connected/.test(r.text);
});
await t('reads the chart of accounts for the wholesale codes', async () => {
  const r = await xcall('GET', '/api/xero/accounts');
  return r.status === 200 && r.body.accounts.length === 1
    && r.body.accounts[0].code === '200' && r.body.chosen.includes('200');
});

// The probe exists because a 403 with an empty body is the least
// informative refusal Xero has, and guessing at one cost a day.
await t('asks the same question several ways and reports each', async () => {
  const r = await xcall('GET', '/api/xero/probe');
  const names = r.body.tries.map((x) => x.name);
  return r.body.connected === true && names.length >= 4
    && names.some((n) => /with the tenant/.test(n))
    && names.some((n) => /no tenant header/.test(n));
});
await t('reports an empty refusal as an empty refusal', async () => {
  const r = await xcall('GET', '/api/xero/probe');
  const bare = r.body.tries.find((x) => /no tenant header/.test(x.name));
  return bare.status === 403 && bare.body === '(empty)';
});
// A probe that quietly kills the connection it is diagnosing would be
// worse than no probe.
await t('does not break the connection it is diagnosing', async () => {
  const before = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  await xcall('GET', '/api/xero/probe');
  const after = rows('SELECT refresh_token FROM xero WHERE id = 1')[0].refresh_token;
  const r = await xcall('GET', '/api/xero/accounts');
  return before !== after && r.status === 200;
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
await t('gets a fresh token for every run', async () => {
  const before = xero.issued;
  await xcall('POST', '/api/xero/pull', {});
  return xero.issued > before;
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
  const r = await xcall('POST', '/api/xero/pull', {}, { ...XENV, XERO_ACCOUNTS: '' });
  return r.status === 500 && /XERO_ACCOUNTS/.test(r.text);
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
  return r.status === 500 && /Refresh token expired/.test(r.text);
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
  const r = await call('GET', '/api/payments');
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
  const r = await call('GET', '/api/payments?status=all&q=Skateboard');
  return r.body.rows.length === 1 && r.body.rows[0].retailer === 'PRO Skateboard Shop';
});
// The totals belong to the filter, not to the page of it on screen.
await t('adds up the whole filtered set, not the page shown', async () => {
  const r = await call('GET', '/api/payments?status=all&limit=2');
  return r.body.shown === 2 && r.body.matched > 2
    && r.body.totals.rows === r.body.matched;
});
// The number the day is measured by does not move with the filter.
await t('keeps the waiting count whatever is being looked at', async () => {
  const a2 = await call('GET', '/api/payments');
  const b2 = await call('GET', '/api/payments?status=paid');
  return a2.body.waiting === b2.body.waiting && a2.body.waiting > 0;
});
await t('narrows to one rep and one month', async () => {
  const r = await call('GET', '/api/payments?status=all&month=2026-10');
  return r.body.rows.every((x) => x.paid_on >= '2026-10-01' && x.paid_on < '2026-11-01');
});
await t('offers the bar the reps, the places and the years', async () => {
  const r = await call('GET', '/api/choices');
  return Array.isArray(r.body.statuses) && r.body.statuses.length >= 4
    && Array.isArray(r.body.years) && r.body.years.includes('2026')
    && /^\d{4}-\d{2}$/.test(r.body.thisMonth);
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
  const r = await call('GET', '/api/payments');
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
  const res = await worker.fetch(new Request('https://cm.test/api/payments', {
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

// ── The monthly run ────────────────────────────────────────────────────
//
// Built, sent, paid: three days and three columns. The thing worth proving
// is the fourth state nobody names -- built, then the figures moved.

console.log('');
console.log('the monthly statements');

const SEP = { year: 2026, month: 9 };
const stmt = () => rows("SELECT * FROM statements WHERE rep_key = 'nathan-zelena' "
  + 'AND year = 2026 AND month = 9')[0];

// A clean month of its own, so the Xero rows above cannot drift into it.
const seedPayment = (ref, over) => {
  const o = Object.assign({ paid_on: '2026-09-14', gross: 1000, credits: 0, freight: 0,
    commission_pct: 10, rep_key: 'nathan-zelena', ink: 0, invoice_no: ref,
    retailer: 'Powder House', cad: 0, usd_net: null }, over || {});
  sqlite.prepare(
    'INSERT INTO payments (id, source, source_ref, paid_on, invoice_no, retailer, '
    + 'rep_key, commission_pct, gross, credits, freight, cad, usd_net, ink) '
    + "VALUES (lower(hex(randomblob(4))) || '-0000-4000-8000-' || lower(hex(randomblob(6))), "
    + "'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ref, o.paid_on, o.invoice_no, o.retailer, o.rep_key, o.commission_pct,
         o.gross, o.credits, o.freight, o.cad, o.usd_net, o.ink);
};

await t('counts a month off the payments, before anything is built', async () => {
  seedPayment('sep-1');
  seedPayment('sep-2', { gross: 500 });
  seedPayment('sep-ink', { gross: 2000, commission_pct: 2, ink: 1 });
  // A different month, which must not land in September's total.
  seedPayment('oct-1', { paid_on: '2026-10-02', gross: 9999 });
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  return r.status === 200 && mine.lines === 3 && mine.due === 190
    && mine.ink_due === 40 && mine.built_at === null;
});

await t('wants to know which month before it will say anything', async () => {
  const a = await call('GET', '/api/statements');
  const b = await call('GET', '/api/statements?year=2026&month=13');
  return a.status === 400 && b.status === 400;
});

await t('builds a file, keeps it, and writes the index', async () => {
  const r = await call('POST', '/api/statements/build', SEP);
  const made = (r.body.built || []).filter((x) => x.rep_key === 'nathan-zelena')[0];
  const st = stmt();
  return r.status === 200 && made && made.amount === 190
    && st.report_name === 'Total_Commissions-Nathan_Zelena_LLC-2026-SEP.xlsx'
    && st.report_key === 'statements/2026/09/nathan-zelena.xlsx'
    && st.lines === 3 && Boolean(st.built_at) && bucket.has(st.report_key);
});

await t('puts an openable workbook in the bucket, not a JSON blob', async () => {
  const st = stmt();
  const bytes = bucket.get(st.report_key).body;
  // "PK\x03\x04", the local file header every ZIP starts with.
  const head = Array.from(bytes.subarray(0, 4));
  const meta = bucket.get(st.report_key).opts.httpMetadata || {};
  return head.join(',') === '80,75,3,4'
    && /spreadsheetml\.sheet$/.test(meta.contentType || '')
    && /filename="Total_Commissions/.test(meta.contentDisposition || '');
});

await t('serves the file through the Worker, behind Access', async () => {
  const st = stmt();
  const res = await worker.fetch(new Request('https://cm.test/api/statements/' + st.id + '/file', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'amy@jettylife.com' },
  }), ENV, { waitUntil() {} });
  const type = res.headers.get('content-type') || '';
  const disp = res.headers.get('content-disposition') || '';
  return res.status === 200 && /spreadsheetml\.sheet/.test(type)
    && disp.indexOf('Total_Commissions-Nathan_Zelena_LLC-2026-SEP.xlsx') > 0;
});

await t('refuses the file to somebody not on the list', async () => {
  const st = stmt();
  const res = await worker.fetch(new Request('https://cm.test/api/statements/' + st.id + '/file', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'arlynn@jettylife.com' },
  }), ENV, { waitUntil() {} });
  return res.status === 403;
});

await t('will not mark a statement sent before it has been built', async () => {
  sqlite.prepare("INSERT INTO reps (key, name, email) VALUES ('new-rep','New Rep','r@x.com')").run();
  sqlite.prepare("INSERT INTO statements (id, rep_key, year, month) "
    + "VALUES ('00000000-0000-4000-8000-000000000001','new-rep',2026,9)").run();
  const r = await call('POST', '/api/statements/00000000-0000-4000-8000-000000000001/sent',
                       { sent: true });
  return r.status === 400 && /Build the statement/.test(r.body.errors.join(' '));
});

await t('records who sent it and when, and lets that be taken back', async () => {
  const id = stmt().id;
  const on = await call('POST', '/api/statements/' + id + '/sent', { sent: true });
  const sent = Boolean(on.body.statement.sent_at)
    && on.body.statement.sent_by === 'amy@jettylife.com';
  const off = await call('POST', '/api/statements/' + id + '/sent', { sent: false });
  return sent && off.body.statement.sent_at === null && off.body.statement.sent_by === null;
});

await t('says nothing is stale while the figures have not moved', async () => {
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  return mine.stale === false && mine.due === 190 && mine.amount === 190;
});

await t('notices when a correction lands after the file was built', async () => {
  // The whole reason this screen exists: a rep is holding a file that the
  // books no longer support, and nothing else would say so.
  sqlite.prepare("UPDATE payments SET gross = 2000 WHERE source_ref = 'sep-1'").run();
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  return mine.stale === true && mine.due === 290 && mine.amount === 190;
});

await t('clears the warning by rebuilding over the same file', async () => {
  const before = stmt().report_key;
  await call('POST', '/api/statements/build', Object.assign({ reps: ['nathan-zelena'] }, SEP));
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  // One rep-month, one file. A corrected month that left the old file
  // beside the new one would be a month with two right answers.
  return mine.stale === false && mine.amount === 290 && stmt().report_key === before;
});

await t('says when a statement was rebuilt after it had already gone out', async () => {
  const id = stmt().id;
  await call('POST', '/api/statements/' + id + '/sent', { sent: true });
  sqlite.prepare("UPDATE statements SET sent_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
    .run(id);
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  return mine.resent === true;
});

await t('does not build an empty statement for a rep with no month', async () => {
  const r = await call('POST', '/api/statements/build',
                       { year: 2026, month: 7, reps: ['nathan-zelena'] });
  return r.body.built.length === 0 && /Nothing in that month/.test(r.body.skipped[0].why);
});

await t('keeps a statement on screen after its payments have moved away', async () => {
  // The rep's September rows are pushed into August; the file that was sent
  // for September still has to account for itself.
  sqlite.prepare("UPDATE payments SET paid_on = '2026-08-14' WHERE source_ref LIKE 'sep-%'").run();
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  const back = mine && mine.lines === 0 && mine.due === 0 && mine.stale === true;
  sqlite.prepare("UPDATE payments SET paid_on = '2026-09-14' WHERE source_ref LIKE 'sep-%'").run();
  return back;
});

await t('marks a rep paid, and will not pay a row with no rep', async () => {
  const mine = rows("SELECT id FROM payments WHERE source_ref = 'sep-1'")[0].id;
  const orphan = rows('SELECT id FROM payments WHERE rep_key IS NULL LIMIT 1')[0].id;
  const r = await call('POST', '/api/payments/paid', { ids: [mine, orphan], paid: true });
  const after = rows('SELECT id, paid, paid_by FROM payments WHERE id IN (?, ?)', mine, orphan);
  const got = Object.fromEntries(after.map((x) => [x.id, x]));
  return r.status === 200 && got[mine].paid === 1
    && got[mine].paid_by === 'amy@jettylife.com' && got[orphan].paid === 0;
});

await t('refuses a paid run with nothing in it', async () => {
  const r = await call('POST', '/api/payments/paid', { ids: [], paid: true });
  return r.status === 400;
});

await t('shows on the month how much of it has reached the rep', async () => {
  const r = await call('GET', '/api/statements?year=2026&month=9');
  const mine = r.body.rows.filter((x) => x.rep_key === 'nathan-zelena')[0];
  return mine.paid_lines === 1 && mine.lines === 3;
});

await t('keeps a note against the month, the way the Ledger did', async () => {
  const id = stmt().id;
  const r = await call('POST', '/api/statements/' + id + '/note',
                       { notes: 'Ink commission included.' });
  return r.body.statement.notes === 'Ink commission included.'
    && stmt().notes === 'Ink commission included.';
});

console.log('');
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
