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
    return json({
      territories: await col('territory'),
      lines: await col('jetty_line'),
      methods: await col('payment_method'),
      retailers: await col('retailer'),
      reps: await repList(),
    });
  }

  // The queue: every payment with no rep on it yet.
  if (path === '/api/queue' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
    const q = String(url.searchParams.get('q') || '').trim();
    let sql = 'SELECT ' + QUEUE_FIELDS + ' FROM payments WHERE rep_key IS NULL';
    const binds = [];
    if (q) {
      sql += ' AND (retailer LIKE ? OR invoice_no LIKE ? OR customer LIKE ?)';
      const like = '%' + q + '%';
      binds.push(like, like, like);
    }
    // Oldest first: the one that has been waiting longest is the one to do.
    sql += ' ORDER BY paid_on ASC, rowid ASC LIMIT ?';
    binds.push(limit);
    const rows = ((await db.prepare(sql).bind(...binds).all()).results) || [];
    const all = ((await db.prepare(
      'SELECT gross, credits, freight, cad, usd_net, commission_pct, rep_key, paid '
      + 'FROM payments WHERE rep_key IS NULL').all()).results) || [];
    return json({ rows, waiting: all.length, totals: totals(all), you: who.email });
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

/** Compares in time that does not depend on how much of the key is right.
 *  A plain === leaks the length of the shared prefix to anyone willing to
 *  measure, which is the whole attack on a fixed secret. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * A payment arriving from the feed.
 *
 * Keyed on source_ref, which is UNIQUE: a feed that replays yesterday writes
 * nothing the second time. A duplicate payment here is a duplicate
 * commission, which is money out of the door rather than a tidy-up.
 */
async function handleIngest(request, env) {
  const db = env.DB;
  if (!db) return json({ error: 'The commissions database is not bound yet.' }, 503);
  await ensureSchema(db);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Expected a JSON body.' }, 400);
  const items = Array.isArray(body) ? body : (Array.isArray(body.payments) ? body.payments : [body]);
  if (items.length > 500) return json({ error: 'Too many at once; send 500 or fewer.' }, 400);

  const made = [];
  const skipped = [];
  const errors = [];
  for (const item of items) {
    const { row, errors: bad } = cleanIncoming(item);
    if (bad) { errors.push({ ref: (item && item.source_ref) || null, errors: bad }); continue; }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const res = await db.prepare(
      'INSERT OR IGNORE INTO payments '
      + '(id, source, source_ref, paid_on, invoice_no, retailer, customer, '
      + 'payment_method, gross, cc_fee, cad, created_by, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, row.source, row.source_ref, row.paid_on, row.invoice_no, row.retailer,
            row.customer, row.payment_method, row.gross, row.cc_fee, row.cad,
            'feed', now).run();
    const changed = res && res.meta
      ? (res.meta.changes != null ? res.meta.changes : res.meta.changed_db) : 1;
    if (changed) made.push(row.source_ref);
    else skipped.push(row.source_ref);
  }
  return json({ made: made.length, skipped: skipped.length, errors }, errors.length ? 207 : 200);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // The feed. Zapier and a scheduled script cannot hold a Cloudflare
    // Access identity, so this one path is answered before the Access check
    // and carries its own key instead.
    //
    // Deliberately narrow: it only ever inserts a payment nobody has
    // allocated yet. It cannot read, cannot allocate, cannot mark anything
    // paid, and refuses outright when no key is configured -- an unset
    // secret must not mean an open endpoint.
    if (url.pathname === '/api/ingest') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      const want = String(env.INGEST_KEY || '');
      const got = request.headers.get('x-ingest-key') || '';
      if (!want) return json({ error: 'This feed is not configured.' }, 503);
      if (!safeEqual(want, got)) return json({ error: 'Not authorised.' }, 401);
      try {
        return await handleIngest(request, env);
      } catch (err) {
        return json({ error: 'Ingest failed: '
          + (err && err.message ? err.message : String(err)) }, 500);
      }
    }

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
};
