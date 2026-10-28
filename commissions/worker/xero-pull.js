// Talking to Xero: the token dance and the page loop.
//
// Every network call is injected rather than made here, so the parts that go
// wrong -- a rotated refresh token, a 429, a page that comes back empty, a
// tenant that has gone away -- are all testable without a live Xero account
// and without anybody's real invoices.

import { XERO_TOKEN, XERO_CONNECTIONS, XERO_API, pageQuery, sinceHeader, rowsFromPage } from './xero.js';

/**
 * Trade the stored refresh token for an access token.
 *
 * Xero rotates the refresh token on every single refresh: the one just used
 * is dead, and the new one comes back in this response. If it is not written
 * back the connection works exactly once and then fails silently until
 * somebody reconnects by hand, so the caller is handed it and MUST store it.
 */
export async function refreshAccess({ refresh, clientId, clientSecret, post }) {
  if (!refresh) throw new Error('Xero is not connected yet.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
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
    // A refresh token that has expired (60 days unused) or been revoked
    // comes back here. Saying which is the difference between reconnecting
    // and hunting a bug.
    const why = (json && (json.error_description || json.error)) || ('HTTP ' + res.status);
    throw new Error('Xero refused the refresh: ' + why);
  }
  return { access: json.access_token, refresh: json.refresh_token || refresh };
}

/** Swap the authorization code for the first pair of tokens. */
export async function exchangeCode({ code, redirect, clientId, clientSecret, post }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirect,
  });
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
    const why = (json && (json.error_description || json.error)) || ('HTTP ' + res.status);
    throw new Error('Xero refused the code: ' + why);
  }
  if (!json.refresh_token) {
    // Without offline_access there is no refresh token and the link dies in
    // half an hour. Better to refuse the connection than to store one that
    // will stop working on its own.
    throw new Error('Xero sent no refresh token. The app needs the offline_access scope.');
  }
  return { access: json.access_token, refresh: json.refresh_token };
}

/** Which Xero organisation this is. A token can reach several; the one we
 *  want is named rather than assumed to be the only one. */
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
