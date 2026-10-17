// Which hostname the dash answers on.
//
// Pure, and in its own file, for the usual reason: index.js imports store.js,
// which imports schema.sql through a wrangler rule and so cannot be loaded in
// Node. Anything decided here would otherwise be untestable.
//
// An Access application is attached to a HOSTNAME, not to a Worker. The dash
// is attached to two -- jettydash.com and www.jettydash.com -- and the Access
// application covers only one of them. A request to the uncovered one reaches
// the Worker with no token at all, which is not a sign-in failure: it is the
// front door being open round the side of the building.
//
// So a request carrying no token on a hostname that is not the canonical one
// is sent to the canonical one, where Access is waiting. That is the whole
// fix, and it needs nobody to change anything in Cloudflare.
//
// It is conditional on there being no token, deliberately. Add the second
// hostname to the Access application later and its requests arrive verified,
// no redirect fires, and both addresses simply work. Nothing here has to be
// undone.

export function canonicalTarget(rawUrl, canonicalHost, hasToken) {
  const host = String(canonicalHost || '').trim().toLowerCase();
  if (!host) return '';          // not configured: answer wherever we are asked
  if (hasToken) return '';       // already came through Access; leave it alone

  let u;
  try { u = new URL(rawUrl); } catch (err) { return ''; }
  if (u.hostname.toLowerCase() === host) return '';  // already canonical: no loop

  u.hostname = host;
  u.port = '';
  return u.toString();
}
