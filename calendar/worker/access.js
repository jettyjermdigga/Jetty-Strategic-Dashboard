// Who is making this request?
//
// Cloudflare Access sits in front of the site and stamps every request it lets
// through with the signed-in email. Reading that header alone would be enough
// for a read-only page, but the calendar accepts writes, so the header is not
// trusted on its own: anything that reaches the Worker without going through
// Access could set it. When ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured we
// verify the Access JWT properly and use the email out of the verified claims.
//
// With those vars unset the Worker falls back to the header and reports
// verified:false, which the UI surfaces as a setup warning rather than pretending
// the identity is sound.

const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache = { at: 0, domain: '', keys: null };

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function loadKeys(teamDomain) {
  const fresh = certsCache.keys
    && certsCache.domain === teamDomain
    && Date.now() - certsCache.at < CERTS_TTL_MS;
  if (fresh) return certsCache.keys;

  const res = await fetch('https://' + teamDomain + '/cdn-cgi/access/certs');
  if (!res.ok) throw new Error('Access certs fetch failed: ' + res.status);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  certsCache = { at: Date.now(), domain: teamDomain, keys };
  return keys;
}

// Returns { claims } on success, or { problem, detail } saying what was wrong.
// "It did not verify" is not a diagnosis, and the difference between a missing
// token, a stale signing key and an audience meant for a different application
// is the difference between five minutes and an afternoon.
async function verifyJwt(token, teamDomain, auds) {
  const parts = token.split('.');
  if (parts.length !== 3) return { problem: 'malformed' };

  const header = b64urlToJson(parts[0]);
  if (header.alg !== 'RS256') return { problem: 'algorithm', detail: String(header.alg) };

  const keys = await loadKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { problem: 'signing key', detail: 'no key matching kid ' + String(header.kid) };

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify'],
  );
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed,
  );
  if (!ok) return { problem: 'signature' };

  const claims = b64urlToJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) return { problem: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return { problem: 'not yet valid' };

  // One Worker can sit behind more than one Access application -- a hostname
  // application and the Worker-level one during a move, and eventually one per
  // tool behind the same front door. Each stamps its own AUD, so accept any of
  // the configured ones rather than a single value. An AUD that is not on the
  // list is still refused: this widens what we accept, it does not skip it.
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (auds.length && !auds.some((a) => audience.includes(a))) {
    // An AUD tag names an Access application; it is not a secret and is on
    // screen in the dashboard. Naming both sides is what makes this fixable.
    return {
      problem: 'audience',
      detail: 'token is for ' + audience.join(', ')
        + '; this Worker accepts ' + auds.join(', '),
    };
  }

  return { claims };
}

// Comma-separated, so the calendar keeps working while an Access application
// is being replaced rather than going dark between the two.
function audList(env) {
  return String(env.ACCESS_AUD || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function editorList(env) {
  return String(env.CALENDAR_EDITORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function identify(request, env) {
  const headerEmail = request.headers.get('Cf-Access-Authenticated-User-Email') || '';
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  const teamDomain = env.ACCESS_TEAM_DOMAIN || '';
  const auds = audList(env);

  let email = headerEmail;
  let verified = false;

  let reason = '';

  if (teamDomain && auds.length && token) {
    try {
      const out = await verifyJwt(token, teamDomain, auds);
      if (out.claims) {
        email = out.claims.email || headerEmail;
        verified = true;
      } else {
        // A token was presented and did not check out. Trusting the header
        // here would defeat the point of verifying at all.
        email = '';
        reason = 'The Access token failed on its ' + out.problem + '.'
          + (out.detail ? ' ' + out.detail + '.' : '');
      }
    } catch (err) {
      // Certs unreachable. Stay in unverified mode rather than locking the
      // calendar for everyone over a transient fetch failure.
      verified = false;
      reason = 'Could not reach ' + teamDomain + ' to check the token.';
    }
  } else if (teamDomain && auds.length && !token) {
    reason = headerEmail
      ? 'Access set the email header but no token, so nothing could be verified.'
      : 'No Cloudflare Access headers reached this Worker at all.';
  }

  const editors = editorList(env);
  const lower = email.toLowerCase();
  // No allowlist configured means nobody can write. Read stays open to anyone
  // Access has already let in, so a misconfiguration degrades to read-only
  // rather than to an open write endpoint.
  const canEdit = Boolean(lower) && verified && editors.includes(lower);
  const wouldEdit = Boolean(lower) && editors.includes(lower);

  return {
    email,
    verified,
    reason,
    canEdit: canEdit || (wouldEdit && !teamDomain && !auds.length),
    editorsConfigured: editors.length > 0,
    accessConfigured: Boolean(teamDomain && auds.length),
  };
}
