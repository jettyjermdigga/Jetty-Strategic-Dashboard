// Talking to Xero: the token dance and the page loop.
//
// Every network call is injected rather than made here, so the parts that go
// wrong -- a rotated refresh token, a 429, a page that comes back empty, a
// tenant that has gone away -- are all testable without a live Xero account
// and without anybody's real invoices.

import {
  XERO_TOKEN, XERO_CONNECTIONS, XERO_API,
  heldScopes, pageQuery, sinceHeader, rowsFromPage,
} from './xero.js';

/**
 * A token for the Custom Connection.
 *
 * client_credentials: the app IS the credential, so there is no user to
 * sign in, no authorization code to exchange and no refresh token to store
 * or rotate. A token lasts about half an hour and the next run just asks
 * for another one, which removes the whole class of failure that a rotating
 * refresh token brings -- including the one where a connection unused for
 * sixty days quietly dies.
 */
export async function accessToken({ clientId, clientSecret, post, scope }) {
  if (!clientId || !clientSecret) {
    throw new Error('XERO_CLIENT_ID and the XERO_CLIENT_SECRET secret are not both set.');
  }
  // No scope by default: the connection's own grant decides, and naming a
  // scope is what Xero kept refusing. The probe passes one to ask about it
  // specifically; an empty string or undefined both send none.
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) body.set('scope', scope);
  const res = await post(XERO_TOKEN, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + btoa(clientId + ':' + clientSecret),
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.access_token) {
    // invalid_client is a wrong id or secret; invalid_scope is a scope the
    // Custom Connection was not given. Saying which is the difference
    // between fixing it in Cloudflare and fixing it in Xero.
    const why = (json && (json.error_description || json.error)) || ('HTTP ' + res.status);
    throw new Error('Xero refused the credentials: ' + why);
  }
  return { access: json.access_token, scopes: heldScopes(json.access_token) };
}

/**
 * Every scope worth asking Xero about, one at a time.
 *
 * Xero drops a scope it does not recognise and a scope the connection was
 * not granted, both silently, and only complains once nothing is left. So
 * a failure of the real request says "no valid scopes remaining" whether
 * the names are wrong, the grants are missing, or the app is not a Custom
 * Connection at all -- three different fixes behind one sentence.
 *
 * Asking for each on its own separates them. A scope that comes back ok is
 * one this connection really holds; if every one fails, including the
 * request that names no scope, the problem is the app and not the list.
 */
export const PROBE_SCOPES = [
  '',
  'accounting.transactions.read',
  'accounting.transactions',
  'accounting.settings.read',
  'accounting.settings',
  'accounting.contacts.read',
  'accounting.reports.read',
  'accounting.journals.read',
  'accounting.budgets.read',
  'accounting.attachments.read',
  'offline_access',
];

/**
 * Ask for each scope separately and report what Xero said.
 *
 * Read-only in every sense: it gets tokens and throws them away. Tokens are
 * cheap and this runs once, by hand, when the connection will not start.
 */
export async function probeScopes({ clientId, clientSecret, post, scopes }) {
  const out = [];
  for (const scope of (scopes || PROBE_SCOPES)) {
    try {
      await accessToken({ clientId, clientSecret, post, scope });
      out.push({ scope: scope || '(no scope named)', ok: true, why: '' });
    } catch (err) {
      const why = String((err && err.message) || err)
        .replace('Xero refused the credentials: ', '');
      out.push({ scope: scope || '(no scope named)', ok: false, why });
    }
  }
  return out;
}

/** Which Xero organisation this is. A Custom Connection reaches exactly
 *  one, but the tenant id still has to come from somewhere and this is
 *  where Xero keeps it. */
export async function tenants({ access, get }) {
  const res = await get(XERO_CONNECTIONS, {
    headers: { authorization: 'Bearer ' + access, accept: 'application/json' },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(json)) {
    throw new Error('Could not list the Xero organisations (HTTP ' + res.status + ').');
  }
  return json.map((c) => ({ tenantId: c.tenantId, name: c.tenantName || c.tenantId }));
}

/** The chart of accounts. One call, no paging -- a chart with more than a
 *  few hundred accounts is not a thing. */
export async function chartOfAccounts({ access, tenantId, get }) {
  const res = await get(XERO_API + '/Accounts', {
    headers: {
      authorization: 'Bearer ' + access,
      'xero-tenant-id': tenantId,
      accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error('Xero answered ' + res.status + ' for the chart of accounts.');
  return (await res.json().catch(() => null)) || {};
}

export const MAX_PAGES = 60;

/**
 * Every wholesale payment Xero knows about since `since`.
 *
 * Paged until a page comes back short, because Xero gives no total. Capped
 * at MAX_PAGES so a first pull over years of invoices cannot run forever
 * inside one request -- it stops, says so, and the next run carries on from
 * the watermark it did reach.
 */
export async function pullRows({ access, tenantId, codes, since, get, maxPages }) {
  const cap = maxPages || MAX_PAGES;
  const headers = {
    authorization: 'Bearer ' + access,
    'xero-tenant-id': tenantId,
    accept: 'application/json',
  };
  const stamp = sinceHeader(since);
  if (stamp) headers['If-Modified-Since'] = stamp;

  const rows = [];
  let pages = 0;
  let watermark = since || null;
  let more = false;

  for (let page = 1; page <= cap; page += 1) {
    const res = await get(XERO_API + '/Invoices?' + pageQuery(page), { headers });
    if (res.status === 429) {
      // Xero's rate limit. Stopping with what we have beats failing the run:
      // the watermark is saved and the next pull picks up where this left
      // off.
      more = true;
      break;
    }
    if (!res.ok) throw new Error('Xero answered ' + res.status + ' on page ' + page + '.');
    const body = await res.json().catch(() => null);
    const got = (body && Array.isArray(body.Invoices)) ? body.Invoices : [];
    pages += 1;
    rows.push(...rowsFromPage(body, codes));
    for (const inv of got) {
      const u = inv && inv.UpdatedDateUTC;
      const asIso = typeof u === 'string' && /\/Date\((-?\d+)/.test(u)
        ? new Date(Number(u.match(/\/Date\((-?\d+)/)[1])).toISOString()
        : (u ? String(u) : null);
      if (asIso && (!watermark || asIso > watermark)) watermark = asIso;
    }
    // A short page is the last page. Xero returns up to 100.
    if (got.length < 100) { more = false; break; }
    if (page === cap) more = true;
  }

  return { rows, pages, watermark, more };
}
