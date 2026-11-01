// Retail sales commissions.
//
// Jeremy logs a retailer payment. Amy says which rep it belongs to and at
// what rate. At month end the rep is paid and a statement goes out. That is
// the whole thing, and it is three separate days -- which is why allocation,
// payment and the statement are three separate actions rather than one
// status somebody drags along.
//
// Its own Worker, its own database, its own Access application: two people
// use this and it decides what they get paid, so it shares nothing with the
// calendar or the dashboard.

import { identify } from './access.js';
import { sqlStatements } from './sql.js';
import { cleanAllocation, totals } from './commission.js';
import { cleanIncoming } from './ingest.js';
import { buildWhere, cleanLimit, STATUSES } from './filters.js';
import {
  XERO_SCOPES, XERO_NEEDED, XERO_API, XERO_CONNECTIONS, authorizeUrl,
  missingScopes, tokenClaims, accountCodes, revenueAccounts,
} from './xero.js';
import {
  refreshAccess, exchangeCode, tenants, xeroHeaders,
  pullRows, chartOfAccounts,
} from './xero-pull.js';
import SCHEMA from './schema.sql';

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

let schemaReady = false;

// Columns a save writes. Deliberately not the whole table: id, source,
// source_ref, the generated figures and the stamps are set once and never by
// an edit.
const ALLOC_COLS = [
  'rep_key', 'commission_pct', 'retailer', 'customer', 'territory', 'jetty_line',
  'payment_method', 'invoice_no', 'credit_memo', 'notes',
  'credits', 'freight', 'usd_net', 'cc_fee', 'cad', 'partial',
];

async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of sqlStatements(SCHEMA)) await db.prepare(sql).run();
  schemaReady = true;
}

/**
 * Take a migration, or find somebody else already has it.
 *
 * The same atomic claim the calendar learned to use the hard way: read-then-
 * act behind a per-isolate flag lets several isolates all decide the work is
 * theirs, which is harmless for an UPDATE and doubles the rows on an INSERT.
 */
async function claim(db, key) {
  const res = await db.prepare(
    'INSERT OR IGNORE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(key, '"claimed"', new Date().toISOString()).run();
  const changed = res && res.meta
    ? (res.meta.changes != null ? res.meta.changes : res.meta.changed_db)
    : null;
  if (changed == null) {
    return Boolean(await db.prepare(
      'SELECT value FROM meta WHERE key = ? AND value = \'"claimed"\'').bind(key).first());
  }
  return Boolean(changed);
}

// ── Xero ────────────────────────────────────────────────────────────────
//
// One row, id = 1. Created on demand so the rest of the module works before
// anybody has connected anything.
async function xeroRow(db) {
  await db.prepare('INSERT OR IGNORE INTO xero (id) VALUES (1)').run();
  return db.prepare('SELECT * FROM xero WHERE id = 1').first();
}

/**
 * A token, and the organisation it reaches.
 *
 * Asked for on every run rather than stored: a client_credentials token
 * lasts about half an hour and there is nothing to keep. The tenant id is
 * read each time too -- it is one extra call on a nightly job, and a cached
 * one that has gone stale is a pull that writes nothing and says it worked.
 */
/**
 * An access token and the organisation it reaches.
 *
 * Every run refreshes. Xero rotates the refresh token on each refresh --
 * the one just used is dead and the new one comes back in the same
 * response -- so it is written back before anything else happens. Not
 * writing it back makes the connection work exactly once and then fail
 * silently, which is the worst shape this failure has.
 */
async function xeroSession(env, db) {
  const row = await xeroRow(db);
  if (!row || !row.refresh_token || !row.tenant_id) {
    throw new Error('Xero is not connected yet. Press Connect Xero and sign in.');
  }
  const tok = await refreshAccess({
    refresh: row.refresh_token,
    clientId: env.XERO_CLIENT_ID,
    clientSecret: env.XERO_CLIENT_SECRET,
    post: fetch,
  });
  await db.prepare('UPDATE xero SET refresh_token = ?, refreshed_at = ? WHERE id = 1')
    .bind(tok.refresh, new Date().toISOString()).run();

  // What the token actually carries, read off it rather than assumed. A
  // missing scope does not refuse the call -- it returns invoices with an
  // empty Payments array, or an empty chart of accounts, which reads as a
  // quiet month rather than as a permissions problem. That is the worst
  // way for this to be wrong, so it stops here instead.
  const short = missingScopes(tok.scopes);
  if (short.length) {
    throw new Error('This Xero connection is missing ' + short.join(' and ')
      + '. It holds ' + ((tok.scopes || []).join(' ') || 'nothing')
      + '. Press Connect Xero and sign in again to grant them.');
  }
  return { access: tok.access, tenantId: row.tenant_id, tenantName: row.tenant_name };
}

const PAYMENT_COLS = ['source', 'source_ref', 'paid_on', 'invoice_no', 'retailer',
  'customer', 'payment_method', 'gross', 'cc_fee', 'cad', 'usd_net', 'partial',
  'currency', 'xero_invoice_id'];

/**
 * A pull: ask Xero what has changed, and put the new payments in the queue.
 *
 * Every row goes through cleanIncoming, the same gate anything entering the
 * queue goes through, so a Xero row cannot carry a rep or a rate however the
 * mapper is changed later.
 *
 * Written with INSERT OR IGNORE on source_ref, which is UNIQUE: re-pulling an
 * overlapping window writes nothing the second time. A duplicate payment is a
 * duplicate commission.
 */
async function runPull(env, db, who, { full } = {}) {
  const codes = accountCodes(env.XERO_ACCOUNTS);
  if (!codes.length) {
    throw new Error('XERO_ACCOUNTS is not set, so nothing would be recognised as wholesale.');
  }
  const row = await xeroRow(db);
  const session = await xeroSession(env, db);

  const out = await pullRows({
    access: session.access,
    tenantId: session.tenantId,
    codes,
    since: full ? null : (row && row.watermark),
    get: fetch,
  });

  let made = 0;
  let skipped = 0;
  const rejected = [];
  const now = new Date().toISOString();
  for (const candidate of out.rows) {
    const { row: clean, errors } = cleanIncoming(candidate);
    if (errors) { rejected.push({ ref: candidate.source_ref, errors }); continue; }
    const res = await db.prepare(
      'INSERT OR IGNORE INTO payments (id, ' + PAYMENT_COLS.join(', ')
      + ', created_by, created_at) VALUES (?' + ',?'.repeat(PAYMENT_COLS.length + 2) + ')')
      .bind(crypto.randomUUID(), ...PAYMENT_COLS.map((c) => clean[c]), 'xero', now).run();
    const changed = res && res.meta
      ? (res.meta.changes != null ? res.meta.changes : res.meta.changed_db) : 1;
    if (changed) made += 1; else skipped += 1;
  }

  const result = { made, skipped, pages: out.pages, seen: out.rows.length,
                   rejected: rejected.length, more: out.more };
  // The watermark only moves when the run finished the window. Moving it
  // after a run that stopped on a rate limit would skip whatever was left.
  await db.prepare(
    'UPDATE xero SET watermark = ?, last_run_at = ?, last_result = ? WHERE id = 1')
    .bind(out.more ? (row.watermark || null) : (out.watermark || row.watermark || null),
          now, JSON.stringify(result)).run();
  return { ...result, by: (who && who.email) || 'schedule', rejected_detail: rejected.slice(0, 10) };
}

const QUEUE_FIELDS = 'id, source, paid_on, invoice_no, retailer, customer, territory, '
  + 'jetty_line, payment_method, rep_key, commission_pct, gross, credits, freight, '
  + 'cad, usd_net, cc_fee, partial, paid, paid_at, credit_memo, notes, '
  + 'net_invoice, amount_due, updated_by, updated_at';

async function handleApi(request, env, url, who) {
  const db = env.DB;
  if (!db) return json({ error: 'The commissions database is not bound to this Worker yet.' }, 503);
  await ensureSchema(db);

  const path = url.pathname;
  const method = request.method;

  const requireUser = () => (who.canEdit
    ? null
    : json({ error: who.email
        ? 'Your account is not on the commissions list.'
        : 'Sign in to use commissions.' }, 403));

  // Everything here is one of two people's work, so there is no read-only
  // tier: not being on the list means the module is not yours.
  const denied = requireUser();
  if (denied) return denied;

  const repList = async () => ((await db.prepare(
    'SELECT key, name, email, active, default_pct, territory FROM reps ORDER BY name').all())
    .results) || [];

  if (path === '/api/reps' && method === 'GET') {
    return json({ reps: await repList() });
  }

  // What the allocation form offers. Taken from what has actually been used
  // rather than from a list somebody maintains, so a new territory appears
  // the first time it is typed and a dead one falls off when nothing carries
  // it any more.
  if (path === '/api/choices' && method === 'GET') {
    const col = async (name) => (((await db.prepare(
      'SELECT DISTINCT ' + name + ' AS v FROM payments WHERE ' + name
      + " IS NOT NULL AND " + name + " != '' ORDER BY v").all()).results) || [])
      .map((r) => r.v);
    const years = (((await db.prepare(
      "SELECT DISTINCT substr(paid_on, 1, 4) AS v FROM payments "
      + "WHERE paid_on IS NOT NULL ORDER BY v DESC").all()).results) || []).map((r) => r.v);
    return json({
      territories: await col('territory'),
      lines: await col('jetty_line'),
      methods: await col('payment_method'),
      retailers: await col('retailer'),
      reps: await repList(),
      years,
      statuses: STATUSES,
      // What the month box opens on. From the Worker rather than the
      // browser: a laptop in another time zone should not see a different
      // month to the one the figures are filed under.
      thisMonth: new Date().toISOString().slice(0, 7),
    });
  }

  // Where the money comes from. Connecting is a two-step dance through
  // Xero's own sign-in, so it is a redirect rather than a form.
  if (path === '/api/xero/status' && method === 'GET') {
    const row = await xeroRow(db);
    return json({
      // There is nothing stored to be "connected" with -- the credentials
      // either work when asked or they do not. What is recorded is the last
      // time they did.
      connected: Boolean(row && row.tenant_id),
      tenant: (row && row.tenant_name) || null,
      connectedBy: (row && row.connected_by) || null,
      connectedAt: (row && row.connected_at) || null,
      watermark: (row && row.watermark) || null,
      lastRunAt: (row && row.last_run_at) || null,
      lastResult: (row && row.last_result) ? JSON.parse(row.last_result) : null,
      accounts: accountCodes(env.XERO_ACCOUNTS),
      // Said plainly rather than left to be discovered: without these the
      // Connect button goes nowhere.
      configured: Boolean(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET),
    });
  }

  // There is no sign-in to send anybody to. This asks Xero for a token and
  // says which organisation came back, which is the only thing there is to
  // check before a pull.
  // Off to Xero to sign in. A Web app reaches an organisation only once
  // somebody authorises it against one, which is what this starts.
  if (path === '/api/xero/connect' && method === 'GET') {
    if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) {
      return json({ error: 'XERO_CLIENT_ID and the XERO_CLIENT_SECRET secret '
        + 'are not both set.' }, 503);
    }
    await xeroRow(db);
    const state = crypto.randomUUID();
    await db.prepare('UPDATE xero SET oauth_state = ?, oauth_at = ? WHERE id = 1')
      .bind(state, new Date().toISOString()).run();
    // ?scope= asks for something other than the usual set, and ?show=1
    // hands back the URL instead of sending anybody to it. Both are for
    // bisecting an invalid_scope, which Xero reports on its own error
    // page with nothing in it that says which scope it objected to.
    const want = url.searchParams.get('scope') || '';
    const go = authorizeUrl({
      clientId: env.XERO_CLIENT_ID,
      redirect: url.origin + '/api/xero/callback',
      state,
      scopes: want || undefined,
    });
    if (url.searchParams.get('show')) {
      return json({ go, scope: want || XERO_SCOPES, clientId: env.XERO_CLIENT_ID,
                    redirect: url.origin + '/api/xero/callback' });
    }
    return json({ go });
  }

  if (path === '/api/xero/callback' && method === 'GET') {
    const row = await xeroRow(db);
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    // Xero says why it refused in the URL rather than in a body, and
    // "that sign-in did not match" would be a lie about, say, a scope it
    // would not grant.
    const refused = url.searchParams.get('error');
    if (refused) {
      return json({ error: 'Xero refused the sign-in: ' + refused
        + (url.searchParams.get('error_description')
          ? ' \u2014 ' + url.searchParams.get('error_description') : '') }, 400);
    }
    // One-time, and only for a few minutes: a callback arriving with a
    // stale or borrowed state is not the one we sent somebody off with.
    const issued = row && row.oauth_at ? Date.parse(row.oauth_at) : 0;
    const fresh = issued && (Date.now() - issued) < 15 * 60 * 1000;
    if (!code || !state || !row || !row.oauth_state || state !== row.oauth_state || !fresh) {
      return json({ error: 'That sign-in did not match the one this module '
        + 'started.' }, 400);
    }
    await db.prepare('UPDATE xero SET oauth_state = NULL WHERE id = 1').run();

    const tok = await exchangeCode({
      code,
      redirect: url.origin + '/api/xero/callback',
      clientId: env.XERO_CLIENT_ID,
      clientSecret: env.XERO_CLIENT_SECRET,
      post: fetch,
    });
    const orgs = await tenants({ access: tok.access, get: fetch });
    if (!orgs.length) {
      return json({ error: 'That Xero sign-in reaches no organisations. The app '
        + 'has to be authorised against one.' }, 400);
    }
    const org = orgs[0];
    await db.prepare(
      'UPDATE xero SET tenant_id = ?, tenant_name = ?, refresh_token = ?, '
      + 'connected_by = ?, connected_at = ? WHERE id = 1')
      .bind(org.tenantId, org.name, tok.refresh, who.email,
            new Date().toISOString()).run();
    // Back to the page rather than a wall of JSON: this is the end of a
    // journey somebody started by pressing a button.
    return new Response(null, { status: 302, headers: {
      location: '/?connected=' + encodeURIComponent(org.name) } });
  }

  // What this connection will actually let us ask for.
  //
  // Only useful when something will not start, and only by hand: open it
  // in a browser and read it. Nothing calls it and nothing depends on it.
  //
  // It exists because a 403 with an empty body is the least informative
  // refusal Xero has, and guessing at one cost this module a day. So it
  // asks the same question every plausible way at once and reports each
  // answer with whatever body came back.
  if (path === '/api/xero/probe' && method === 'GET') {
    const row = await xeroRow(db);
    const connected = Boolean(row && row.refresh_token && row.tenant_id);

    let tok = null;
    let why = '';
    if (connected) {
      try {
        tok = await refreshAccess({
          refresh: row.refresh_token,
          clientId: env.XERO_CLIENT_ID,
          clientSecret: env.XERO_CLIENT_SECRET,
          post: fetch,
        });
        // Rotated on every refresh, so it is written back even here. A
        // probe that quietly kills the connection it is diagnosing would
        // be worse than no probe.
        await db.prepare('UPDATE xero SET refresh_token = ?, refreshed_at = ? WHERE id = 1')
          .bind(tok.refresh, new Date().toISOString()).run();
      } catch (err) {
        why = String((err && err.message) || err);
      }
    }

    const holds = tok ? tok.scopes : null;
    const short = missingScopes(holds);
    const bearer = tok ? 'Bearer ' + tok.access : '';
    const tenant = (row && row.tenant_id) || '';
    const TRIES = tok ? [
      ['Organisation, with the tenant',
       XERO_API + '/Organisation',
       { authorization: bearer, 'xero-tenant-id': tenant, accept: 'application/json' }],
      ['Organisation, no tenant header',
       XERO_API + '/Organisation', { authorization: bearer, accept: 'application/json' }],
      ['Accounts, with the tenant',
       XERO_API + '/Accounts',
       { authorization: bearer, 'xero-tenant-id': tenant, accept: 'application/json' }],
      ['Invoices, with the tenant',
       XERO_API + '/Invoices?page=1',
       { authorization: bearer, 'xero-tenant-id': tenant, accept: 'application/json' }],
      ['connections',
       XERO_CONNECTIONS, { authorization: bearer, accept: 'application/json' }],
    ] : [];

    const tries = [];
    for (const [name, url2, headers] of TRIES) {
      try {
        const res = await fetch(url2, { headers });
        const body = (await res.text()).slice(0, 300);
        tries.push({ name, status: res.status, body: body || '(empty)' });
      } catch (err) {
        tries.push({ name, status: 0, body: String((err && err.message) || err) });
      }
    }

    // Claim names only, and values only where they could not be a secret.
    let claims = null;
    if (tok) {
      claims = {};
      const all = tokenClaims(tok.access) || {};
      for (const k of Object.keys(all)) {
        claims[k] = /tenant|org|scope|aud|iss/i.test(k) ? all[k] : '(present)';
      }
    }

    return json({
      connected,
      organisation: connected ? { id: tenant, name: row.tenant_name } : null,
      needs: XERO_NEEDED.split(' '),
      asks: XERO_SCOPES.split(' '),
      holds,
      missing: short,
      tries,
      claims,
      reading: !connected
        ? 'Nobody has signed in yet, so there is no organisation to reach. '
          + 'Press Connect Xero.'
        : !tok
          ? 'The stored connection would not refresh: ' + why
            + ' A refresh token dies after sixty days unused, and is dead '
            + 'once used, so this usually means signing in again.'
          : short.length
            ? 'The token is good but holds ' + (holds || []).join(' ')
              + ', which is missing ' + short.join(' and ') + '. Sign in again.'
            : 'The token is good and reaches ' + row.tenant_name
              + '. If a call below still fails, the answer is in its body.',
    });
  }

  // Which account codes could mean wholesale revenue. Read from Xero rather
  // than typed from memory: an account code that matches nothing imports
  // nothing, silently, and looks exactly like a quiet month.
  if (path === '/api/xero/accounts' && method === 'GET') {
    const session = await xeroSession(env, db);
    const body = await chartOfAccounts({
      access: session.access, tenantId: session.tenantId, get: fetch,
    });
    return json({ accounts: revenueAccounts(body), chosen: accountCodes(env.XERO_ACCOUNTS) });
  }

  if (path === '/api/xero/pull' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const result = await runPull(env, db, who, { full: Boolean(body && body.full) });
    return json(result);
  }

  // Payments, filtered. The default is the queue -- the screen is opened to
  // do the allocating, and anything else is asked for.
  if (path === '/api/payments' && method === 'GET') {
    const p = Object.fromEntries(url.searchParams.entries());
    const w = buildWhere(p);
    const limit = cleanLimit(p.limit, 200);

    const rows = ((await db.prepare(
      'SELECT ' + QUEUE_FIELDS + ' FROM payments' + w.sql + w.order + ' LIMIT ?')
      .bind(...w.binds, limit).all()).results) || [];

    // Totals over the whole filtered set, not the page of it on screen. A
    // strip that only adds up the first two hundred rows is a strip that
    // quietly lies about a year.
    const all = ((await db.prepare(
      'SELECT gross, credits, freight, cad, usd_net, commission_pct, rep_key, paid '
      + 'FROM payments' + w.sql).bind(...w.binds).all()).results) || [];

    // How many are still waiting, whatever is being looked at. It is the
    // number the day is measured by, so it does not move with the filter.
    const waitingRow = await db.prepare(
      'SELECT COUNT(*) AS n FROM payments WHERE rep_key IS NULL').first();

    return json({
      rows, status: w.status, matched: all.length, shown: rows.length, limit,
      totals: totals(all), waiting: (waitingRow && waitingRow.n) || 0,
      you: who.email,
    });
  }

  // One payment, allocated.
  const one = path.match(/^\/api\/payments\/([0-9a-f-]{36})$/);
  if (one) {
    const id = one[1];
    const existing = await db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'No such payment.' }, 404);

    if (method === 'GET') return json({ payment: existing });

    if (method === 'PATCH') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'Expected a JSON body.' }, 400);
      const reps = (await repList()).map((r) => r.key);
      // Merged over what is already stored, so a form that sends only the
      // rep does not blank the retailer somebody typed yesterday.
      const { row, errors } = cleanAllocation({ ...existing, ...body }, reps);
      if (errors) return json({ errors }, 400);

      const now = new Date().toISOString();
      await db.prepare(
        'UPDATE payments SET ' + ALLOC_COLS.map((c) => c + ' = ?').join(', ')
        + ', updated_by = ?, updated_at = ? WHERE id = ?')
        .bind(...ALLOC_COLS.map((c) => row[c]), who.email, now, id).run();
      const after = await db.prepare(
        'SELECT ' + QUEUE_FIELDS + ' FROM payments WHERE id = ?').bind(id).first();
      return json({ payment: after });
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
    // application is put in front of it. Rather than depend on that having
    // happened, refuse anything arriving without an Access identity.
    if (env.REQUIRE_IDENTITY !== 'false' && !who.email) {
      return json({
        error: 'This module is behind Cloudflare Access and no Access identity '
          + 'reached the Worker.' + (who.reason ? ' ' + who.reason : ''),
      }, 403);
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/me') {
        return json({
          email: who.email,
          canEdit: who.canEdit,
          verified: who.verified,
          accessConfigured: who.accessConfigured,
          editorsConfigured: who.editorsConfigured,
        });
      }
      try {
        return await handleApi(request, env, url, who, ctx);
      } catch (err) {
        return json({ error: 'Commissions request failed: '
          + (err && err.message ? err.message : String(err)) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  // The nightly pull. Nobody has to remember to press anything, and the
  // queue is what Amy finds in the morning rather than what she builds.
  //
  // Failures are swallowed deliberately: a thrown scheduled handler is
  // retried and retried, and the reason is already recorded in last_result
  // where the page shows it.
  async scheduled(event, env, ctx) {
    const run = (async () => {
      const db = env.DB;
      if (!db) return;
      await ensureSchema(db);
      try {
        await runPull(env, db, null, {});
      } catch (err) {
        await db.prepare(
          'UPDATE xero SET last_run_at = ?, last_result = ? WHERE id = 1')
          .bind(new Date().toISOString(),
                JSON.stringify({ error: String((err && err.message) || err) })).run()
          .catch(() => {});
      }
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(run);
    return run;
  },
};
