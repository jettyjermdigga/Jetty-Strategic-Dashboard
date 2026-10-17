// What is on the dash, and who sees it.
//
// This file holds the DEFAULTS and the rules. The live catalogue lives in the
// database, where it can be edited by somebody who is not editing the repo --
// see store.js, which seeds the first rows from the lists below and then never
// reads them again. The functions here are the rules, and they apply whether a
// row came from this file or from the admin page.
//
// Two rules, and they are the whole design:
//
//   A tile is only ever drawn if the person can actually open it. Nothing is
//   shown greyed out, nothing says "coming soon", and nothing appears that
//   somebody would have to ask about. A portal full of doors you cannot open
//   is a portal people stop reading.
//
//   This list controls what somebody SEES, not what they can OPEN. The lock on
//   each tool is its own Cloudflare Access policy. Hiding a tile from somebody
//   still on that tool's policy hides the door, not the room. So a tile's
//   `groups` must name the same people that tool's own policy names, and
//   keeping those two in step is the job.

// One list, used twice.
//
// There were two: departments for where a tile sits, and separately-named
// groups for who could see it. Two lists with overlapping names is one list
// too many -- the first thing anybody asked on seeing their own dash was what
// the second one meant.
//
// They merged because the dash is not a lock. Each tool behind it decides who
// actually gets in: Cory's wholesale tables already let his outside reps in,
// and whoever builds the Ambassador hub will set up its own access. All this
// list does is decide which sections of the portal an internal member of
// staff sees, and that does not need a vocabulary of its own.
//
// So a department is both the section a tile appears under and the thing a
// person is in. Being in Finance means you get the finance tools on your
// dash; it is not a claim about your job title.
//
// EVERYONE is not a department. It means "anybody Access let through the front
// door", which on an internal staff portal is every member of staff.
export const EVERYONE = 'everyone';

// What part of the business a tool belongs to. The page groups tiles under
// these, in this order, and skips any heading nothing lands under -- so
// somebody with two tools sees two tiles rather than eleven empty headings.
//
// These mirror the calendar's departments on purpose: one vocabulary for
// where a thing belongs, across both tools.
//
// A category is still not a permission, even where the names now overlap with
// the groups. Two tools under Marketing can be open to completely different
// people; `groups` decides who sees a tile and nothing else does. The
// categories only decide where it sits on the page.
export const CATEGORIES = [
  { key: 'general',     label: 'General / Staff / Culture', icon: 'people' },
  { key: 'box-truck',   label: 'Box Truck',                 icon: 'truck' },
  { key: 'long-branch', label: 'Long Branch',               icon: 'store' },
  { key: 'jrf',         label: 'Jetty Rock Foundation',     icon: 'wave' },
  { key: 'jetty-ink',   label: 'Jetty INK',                 icon: 'ink' },
  { key: 'wholesale',   label: 'Wholesale',                 icon: 'box' },
  { key: 'marketing',   label: 'Marketing',                 icon: 'megaphone' },
  { key: 'logistics',   label: 'Logistics',                 icon: 'route' },
  { key: 'prodev',      label: 'ProDev',                    icon: 'board' },
  { key: 'womens',      label: "Women's",                   icon: 'tag' },
  { key: 'finance',     label: 'Finance',                   icon: 'chart' },
];

// The one department everybody is in. A tile filed under it is company-wide,
// which is what the name says -- and it is what an unplaced new starter sees,
// so somebody Access let in is never shown an empty page.
export const EVERYONE_CAT = 'general';

// Who sees what is drawn from the same list as where things sit, so Setup
// offers one set of names in both places.
export const GROUPS = CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon }));



// Where tiles went when the categories changed from shapes of work to parts
// of the business. Lives here beside CATEGORIES, and not in store.js where it
// is used, because store.js reads schema.sql through a wrangler rule and so
// cannot be loaded in Node -- and a move pointing at a category that does not
// exist would drop every tile it touched off the page. There is a test.
export const CAT_MOVES = {
  company: 'general',
  sales: 'wholesale',
  community: 'jrf',
  // finance and marketing keep their keys and are simply relabelled.
};

// Where the old permission names went when the two lists became one. Same
// reasoning as CAT_MOVES: it lives here so it can be tested, and a move
// pointing at a department that does not exist would silently strip somebody
// of a section.
//
// retail has no department on the list -- Flagship is not on it either -- so
// Long Branch is a guess, flagged here and easily corrected in Setup.
export const GROUP_MOVES = {
  financials: 'finance',
  retail: 'long-branch',
  ambassadors: 'marketing',
};

// status:
//   'live' -- built, reachable, has a url. The only status that is ever drawn.
//   'soon' -- somebody is building it. Kept here so the row is ready and the
//             url has somewhere to go, but NOT shown to anybody: a tile that
//             cannot be opened is noise on everybody's page.
//
// url: where the tool actually is. The two live ones below are the Worker
// addresses the deploys print; swap them for custom domains when those exist,
// and the tile is the only place that needs changing.
export const TILES = [
  {
    key: 'calendar',
    name: 'Company Calendar',
    blurb: 'Events, Marketing, Meetings, & Deadlines across every department within the company.',
    url: 'https://jetty-calendar.jeremy-85e.workers.dev',
    icon: 'calendar',
    category: 'general',
    groups: [EVERYONE],
    status: 'live',
  },
  {
    key: 'strategic',
    name: 'Strategic Dashboard',
    blurb: 'Revenue, COGS, OpEx, inventory and cash flow against plan, week by week.',
    url: 'https://jetty-strategic.jeremy-85e.workers.dev',
    icon: 'chart',
    category: 'finance',
    groups: ['finance'],
    status: 'live',
  },

  // Not yet built, and therefore not yet shown to anybody. Fill in the url and
  // flip the status to 'live' and the tile appears for the groups named. An
  // address is never invented to fill a gap: a link that looks like it should
  // work and does not is worse than no tile at all.
  {
    key: 'wholesale',
    name: 'Wholesale Hub',
    blurb: 'Order book, line sheets and account activity.',
    url: '',
    icon: 'box',
    category: 'wholesale',
    groups: ['wholesale'],
    status: 'soon',
  },
  {
    key: 'ambassadors',
    name: 'Ambassador Hub',
    blurb: 'Roster, agreements and activity for the ambassador programme.',
    url: '',
    icon: 'people',
    category: 'marketing',
    groups: ['marketing'],
    status: 'soon',
  },
];

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Which tiles this person sees, already grouped by category.
//
// `groups` is what the roster reported. When we could not establish who
// somebody is at all, the caller passes null -- which is different from "in no
// groups": the first is "we do not know", the second is "we know, and none".
//
// Not knowing shows the tools that are open to everyone and nothing else. A
// portal that falls open the moment something upstream fails is a worse
// failure than one that goes quiet, and the page says which has happened.
// `list` defaults to the real catalogue and exists so the tests can hand it a
// fixture. Once every unbuilt tile is hidden there is no live tile owned by
// two groups, and the rule that a tile shows to ANY of its groups would go
// untested until the day somebody relied on it.
export function visibleTiles(groups, list) {
  const known = Array.isArray(groups);
  const mine = known ? groups.map(norm) : [];

  return (list || TILES).filter((t) => {
    // Rule one: if it cannot be opened, it is not drawn. For anybody.
    if (!t.url) return false;
    const cat = norm(t.category);
    // Rule two: the section a tile sits in is the section you have to be in
    // to see it. There is no separate list of who-can-see, because the
    // department already answers that -- see the note above GROUPS.
    if (cat === EVERYONE_CAT) return true;
    if (!known) return false;
    return mine.includes(cat);
  }).map((t) => ({
    key: t.key,
    name: t.name,
    blurb: t.blurb,
    icon: t.icon,
    category: t.category,
    url: t.url,
  }));
}

// The same tiles, arranged as the page draws them: category headings in
// CATEGORIES order, each with at least one tile under it. Done here rather
// than in the browser so the order is testable and the page stays simple.
export function tileSections(groups, list, cats) {
  const mine = visibleTiles(groups, list);
  const out = [];
  for (const c of (cats || CATEGORIES)) {
    const inIt = mine.filter((t) => t.category === c.key);
    if (inIt.length) out.push({ key: c.key, label: c.label, tiles: inIt });
  }
  // A tile whose category is not in CATEGORIES would otherwise vanish from a
  // page that still counts it. Collected rather than dropped.
  const placed = new Set(out.flatMap((s) => s.tiles.map((t) => t.key)));
  const rest = mine.filter((t) => !placed.has(t.key));
  if (rest.length) out.push({ key: 'other', label: 'Other', tiles: rest });
  return out;
}

// What the page says above the tiles. Pulled out so it is one sentence to
// change, and so the tests can assert on it.
export function greeting(email) {
  const name = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!name) return 'Welcome';
  return 'Welcome, ' + name.charAt(0).toUpperCase() + name.slice(1);
}
