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

async function verifyJwt(token, teamDomain, aud) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const header = b64urlToJson(parts[0]);
  if (header.alg !== 'RS256') return null;

  const keys = await loadKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify'],
  );
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed,
  );
  if (!ok) return null;

  const claims = b64urlToJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud && !audience.includes(aud)) return null;

  return claims;
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
  const aud = env.ACCESS_AUD || '';

  let email = headerEmail;
  let verified = false;

  if (teamDomain && aud && token) {
    try {
      const claims = await verifyJwt(token, teamDomain, aud);
      if (claims) {
        email = claims.email || headerEmail;
        verified = true;
      } else {
        // A token was presented and did not check out. Trusting the header
        // here would defeat the point of verifying at all.
        email = '';
      }
    } catch (err) {
      // Certs unreachable. Stay in unverified mode rather than locking the
      // calendar for everyone over a transient fetch failure.
      verified = false;
    }
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
    canEdit: canEdit || (wouldEdit && !teamDomain && !aud),
    editorsConfigured: editors.length > 0,
    accessConfigured: Boolean(teamDomain && aud),
  };
}
