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
  // Departments, not job titles: being in finance means the finance tools
  // show up on your dash. Amy is in finance without being a director, which
  // is the whole reason this is a list of sections rather than of ranks.
  'jeremy@jettylife.com':        ['general', 'finance', 'marketing', 'wholesale',
                                  'long-branch', 'jrf', 'box-truck', 'jetty-ink',
                                  'logistics', 'prodev'],
  'cory@jettylife.com':          ['general', 'finance', 'wholesale'],
  'john@jettylife.com':          ['general', 'finance'],
  'amy@jettylife.com':           ['general', 'finance'],

  // Marketing. joncoen manages social; the rest are calendar editors whose
  // department I am guessing at -- correct these in Setup.
  'joncoen@jettylife.com':       ['general', 'marketing'],
  'arlynn@jettylife.com':        ['general', 'marketing'],
  'colleen@jettylife.com':       ['general', 'marketing'],

  'wholesale@jettylife.com':     ['general', 'wholesale'],
  'jjmckenna@jettylife.com':     ['general', 'wholesale'],

  // Was "retail", which is not one of the departments. Long Branch is the
  // nearest and is a guess -- Flagship is not on the list at all.
  'd.bachowski@jettylife.com':   ['general', 'long-branch'],
  'joem@jettylife.com':          ['general', 'long-branch'],

  'kyle@jettyrockfoundation.org':    ['general', 'jrf'],
  'jessica@jettyrockfoundation.org': ['general', 'jrf'],

  // Signed in to Access but not placed in a department yet. They still get
  // everything open to everyone.
  'bill@jettylife.com':          ['general'],
  'brooke.carty@jettylife.com':  ['general'],
  'collin@jettylife.com':        ['general'],
  'dhenry@jettylife.com':        ['general'],
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
