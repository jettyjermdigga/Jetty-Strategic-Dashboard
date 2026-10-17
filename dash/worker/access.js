// Who is making this request, and what are they in?
//
// Lifted from the calendar Worker, which has been verifying Access tokens in
// production for a while, and extended with group membership. Kept as its own
// copy rather than shared: the two Workers deploy separately and on their own
// schedules, and a shared file would mean a calendar deploy could change who
// gets into the dash.
//
// Cloudflare Access sits in front and stamps every request it lets through
// with the signed-in email. The header alone is not trusted -- anything that
// reached the Worker without going through Access could set it -- so when
// ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured the JWT is verified and the
// email comes out of the verified claims.
//
// Groups are NOT in the JWT. Access answers for them at its identity endpoint,
// which needs the person's own Access cookie forwarded to it. That is a second
// network call, so it is made once per page load and not for every asset.

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

// Returns { groups } with the group names Access reports, or { reason } when
// it could not be asked. The difference matters: see visibleTiles, which shows
// strictly less when membership is unknown rather than falling open.
async function fetchGroups(request, teamDomain) {
  const cookie = request.headers.get('cookie') || '';
  if (!/(^|;\s*)CF_Authorization=/.test(cookie)) {
    return { reason: 'No Access cookie on the request, so group membership could not be looked up.' };
  }
  let res;
  try {
    res = await fetch('https://' + teamDomain + '/cdn-cgi/access/get-identity', {
      headers: { cookie },
    });
  } catch (err) {
    return { reason: 'Could not reach ' + teamDomain + ' to look up group membership.' };
  }
  if (!res.ok) {
    return { reason: 'Access returned ' + res.status + ' for the identity lookup.' };
  }
  let body;
  try { body = await res.json(); } catch (err) {
    return { reason: 'Access returned something other than JSON for the identity lookup.' };
  }
  // Shape per Cloudflare: { email, groups: [{ id, name, email }], ... }.
  // Defended rather than assumed, because this is the one claim here that is
  // read from a response body instead of a verified token.
  const raw = Array.isArray(body && body.groups) ? body.groups : [];
  const names = raw
    .map((g) => (g && typeof g.name === 'string' ? g.name.trim() : ''))
    .filter(Boolean);
  return { groups: names };
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

  // Groups are only asked for once the email is verified. Looking them up for
  // an identity we could not confirm would be answering a question nobody is
  // entitled to ask.
  let groups = null;
  let groupReason = '';
  if (verified && teamDomain) {
    const got = await fetchGroups(request, teamDomain);
    if (got.groups) groups = got.groups;
    else groupReason = got.reason || '';
  } else if (email) {
    groupReason = 'Groups are not looked up until the sign-in has been verified.';
  }

  return {
    email,
    verified,
    reason,
    // null means "not known", [] means "known, and in none". The page and the
    // tile filter treat those differently on purpose.
    groups,
    groupReason,
    accessConfigured: Boolean(teamDomain && auds.length),
  };
}
