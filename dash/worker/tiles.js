// What is on the dash, and who sees it.
//
// This file is the catalogue. Adding a tool means adding a row here; it does
// not mean touching the Worker. Each row says what the thing is called, what
// it is for, where it lives, and which Access groups it belongs to.
//
// IMPORTANT: this list controls what somebody SEES, not what they can OPEN.
// The lock on each tool is its own Cloudflare Access policy. Hiding a tile
// from somebody who is still on that tool's policy hides the door, not the
// room -- they can reach it by typing the address. So a tile's `groups` must
// name the same groups the tool's own Access policy names. Keeping those two
// in step is the whole job; everything else here is presentation.

// The groups the dash knows about. These are Cloudflare Access groups, created
// once in Zero Trust and pointed at by each tool's policy. The names here must
// match the group names there exactly -- they are compared as written.
//
// EVERYONE is not a real group. It means "anybody Access let through the front
// door", which on a staff portal is every member of staff.
export const EVERYONE = 'everyone';

export const GROUPS = [
  { key: 'directors',  label: 'Directors' },
  { key: 'marketing',  label: 'Marketing' },
  { key: 'wholesale',  label: 'Wholesale' },
  { key: 'retail',     label: 'Retail' },
  { key: 'ambassadors', label: 'Ambassadors' },
  { key: 'jrf',        label: 'Jetty Rock Foundation' },
];

// status:
//   'live'    -- built, reachable, has a url
//   'soon'    -- somebody is building it; shown greyed with no link
//   'planned' -- agreed but not started; shown only to Directors, so the
//                portal reads as a roadmap to the people deciding it and as a
//                working tool to everybody else
//
// url: for a 'live' tile this is where the tool actually is. The two below are
// the Worker addresses the deploys print. Swap them for custom domains when
// those exist -- the tile is the only place that needs changing.
export const TILES = [
  {
    key: 'calendar',
    name: 'Company Calendar',
    blurb: 'Events, marketing, social, meetings and deadlines. Everything the company has on, in one month view.',
    url: 'https://jetty-calendar.jeremy-85e.workers.dev',
    icon: 'calendar',
    groups: [EVERYONE],
    status: 'live',
  },
  {
    key: 'strategic',
    name: 'Strategic Dashboard',
    blurb: 'Revenue, COGS, OpEx, inventory and cash flow against plan, week by week.',
    url: 'https://jetty-strategic.jeremy-85e.workers.dev',
    icon: 'chart',
    groups: ['directors'],
    status: 'live',
  },
  // Below here are the hubs other people are building. A tile with no url is
  // never a link -- an address invented to fill a gap is worse than a gap,
  // because it looks like it should work. Fill in the url and flip the status
  // to 'live' when each one is real.
  {
    key: 'wholesale',
    name: 'Wholesale Hub',
    blurb: 'Order book, line sheets and account activity.',
    url: '',
    icon: 'box',
    groups: ['wholesale', 'directors'],
    status: 'soon',
  },
  {
    key: 'ambassadors',
    name: 'Ambassador Hub',
    blurb: 'Roster, agreements and activity for the ambassador programme.',
    url: '',
    icon: 'people',
    groups: ['ambassadors', 'marketing', 'directors'],
    status: 'soon',
  },
];

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Which tiles this person sees.
//
// `groups` is what Access reported. When Access could not be asked -- the
// identity endpoint was unreachable, or the dash is running without Access in
// front of it -- the caller passes null, which is different from "in no
// groups": the first is "we do not know", the second is "we know, and none".
//
// Not knowing shows the tiles that are open to everyone and nothing else. A
// portal that falls open to every tool the moment an endpoint times out is a
// worse failure than one that goes quiet, and the page says why rather than
// looking like somebody's access was taken away.
export function visibleTiles(groups, opts) {
  const known = Array.isArray(groups);
  const mine = known ? groups.map(norm) : [];
  const showPlanned = known && mine.includes('directors');

  return TILES.filter((t) => {
    if (t.status === 'planned' && !showPlanned) return false;
    const want = (t.groups || []).map(norm);
    if (want.includes(EVERYONE)) return true;
    if (!known) return false;
    return want.some((g) => mine.includes(g));
  }).map((t) => ({
    key: t.key,
    name: t.name,
    blurb: t.blurb,
    icon: t.icon,
    status: t.status,
    // A tile that is not live has no link, whatever is in the catalogue.
    url: t.status === 'live' ? t.url : '',
  }));
}

// What the page says above the tiles. Pulled out so it is one sentence to
// change, and so the tests can assert on it.
export function greeting(email) {
  const name = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!name) return 'Welcome';
  return 'Welcome, ' + name.charAt(0).toUpperCase() + name.slice(1);
}
