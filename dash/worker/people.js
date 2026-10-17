// Who is in what.
//
// This was meant to be Cloudflare Access Groups, so that one place governed
// both the tile somebody sees here and the door they can open on the tool
// itself. This account's dashboard has no Access Groups page, so the dash
// keeps its own list instead.
//
// What that costs, said plainly: this list and each application's Access
// policy are now two places, and two places drift. The drift is not dangerous
// -- every tool still enforces its own policy, so a stale line here means
// somebody sees a tile they cannot open, or misses one they could. Annoying,
// visible, and fixable in a minute. It is not a way in.
//
// What it buys: it is in the repo with everything else, it is reviewed like
// everything else, the tests below cover it, and a change is a push rather
// than a click nobody can see afterwards.
//
// To change somebody's access: edit the line, push. The dash redeploys on its
// own and the change is live in about a minute -- no schedule to wait for.

import { EVERYONE, GROUPS } from './tiles.js';

// email -> the groups they are in. Addresses are compared lowercased, so case
// here does not matter; everything else about them does.
//
// Groups are named for the door they open rather than the job somebody holds
// -- see GROUPS in tiles.js for why. It means a line here reads as a list of
// permissions, which is what it is, and nobody has to be filed under a title
// they do not have in order to see what they need.
//
// Somebody who is not on this list is not locked out. Access let them in, so
// they are staff, and they get the tools that are open to everyone. They just
// do not get the ones that are not.
export const PEOPLE = {
  // Financials -- the Strategic Dashboard. The four on its policy today.
  // Amy is here and NOT in leadership: she needs the numbers without being a
  // director, which is the case that decided how these groups are named.
  // Listed in each group he needs rather than given an "admin" group that
  // skips the model. A bypass is a second mechanism, and the second mechanism
  // is always the one nobody remembers to check.
  'jeremy@jettylife.com':        ['financials', 'leadership', 'marketing',
                                  'wholesale', 'retail', 'jrf'],
  'cory@jettylife.com':          ['financials', 'leadership'],
  'john@jettylife.com':          ['financials', 'leadership'],
  'amy@jettylife.com':           ['financials'],

  // Marketing. joncoen manages social; the rest are calendar editors whose
  // department I am guessing at -- correct these.
  'joncoen@jettylife.com':       ['marketing'],
  'arlynn@jettylife.com':        ['marketing'],
  'colleen@jettylife.com':       ['marketing'],

  // Wholesale.
  'wholesale@jettylife.com':     ['wholesale'],
  'jjmckenna@jettylife.com':     ['wholesale'],

  // Retail. A guess from the calendar editor list -- likely wrong.
  'd.bachowski@jettylife.com':   ['retail'],
  'joem@jettylife.com':          ['retail'],

  // Jetty Rock Foundation.
  'kyle@jettyrockfoundation.org':    ['jrf'],
  'jessica@jettyrockfoundation.org': ['jrf'],

  // Signed in to Access but not yet placed. Listed with no groups rather than
  // left out, so the file says "known, and not assigned" instead of leaving
  // somebody to wonder whether they were forgotten.
  'bill@jettylife.com':          [],
  'brooke.carty@jettylife.com':  [],
  'collin@jettylife.com':        [],
  'dhenry@jettylife.com':        [],
};

const KNOWN = new Set(GROUPS.map((g) => g.key));

// Returns the groups for a verified address. An address nobody has placed
// yet comes back as [] -- known, and in none -- which is different from the
// null that means "we could not establish who this is at all".
export function groupsFor(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const mine = PEOPLE[key];
  if (!mine) return [];
  return mine.filter((g) => KNOWN.has(g));
}

// Everybody the file knows about, for the tests and for a future admin page.
export function roster() {
  return Object.keys(PEOPLE).sort().map((email) => ({ email, groups: PEOPLE[email] }));
}

export { EVERYONE };
