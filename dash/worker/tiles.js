// What is on the dash, and who sees it.
//
// This file is the catalogue. Adding a tool means adding a row here; it does
// not mean touching the Worker. Each row says what the thing is called, what
// it is for, what kind of work it belongs to, where it lives, and which groups
// it is for.
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

// Groups are named for the door they open, not for the job somebody holds.
//
// That was learned the moment the list was first written: Amy is not a
// director but needs the Strategic Dashboard. Against a group called
// "Directors" she is an exception, and exceptions are what these lists rot
// around -- either somebody is quietly recorded as a director to get her the
// tiles, or a one-off is bolted on beside the groups and becomes the second
// mechanism nobody remembers to check. Against "Financials" she is simply a
// member, and nothing has to bend.
//
// So when a new tool arrives the question is not "whose department is this?"
// It is "what is the permission, and who needs it?"
//
// EVERYONE is not a real group. It means "anybody Access let through the front
// door", which on a staff portal is every member of staff.
export const EVERYONE = 'everyone';

export const GROUPS = [
  { key: 'financials',  label: 'Financials',
    note: 'Revenue, cash and inventory. Not the same thing as being a director.' },
  { key: 'marketing',   label: 'Marketing' },
  { key: 'wholesale',   label: 'Wholesale' },
  { key: 'retail',      label: 'Retail' },
  { key: 'ambassadors', label: 'Ambassadors' },
  { key: 'jrf',         label: 'Jetty Rock Foundation' },
];

// What kind of work a tool belongs to. The page groups tiles under these, in
// this order, and skips any heading nothing lands under -- so somebody with
// two tools sees two tiles rather than six empty headings.
//
// A category is not a permission. Two tools in the same category can be open
// to completely different people; `groups` decides that and nothing else does.
export const CATEGORIES = [
  { key: 'company',   label: 'Company' },
  { key: 'finance',   label: 'Finance' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'sales',     label: 'Sales' },
  { key: 'community', label: 'Community' },
];

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
    blurb: 'Events, marketing, social, meetings and deadlines. Everything the company has on, in one month view.',
    url: 'https://jetty-calendar.jeremy-85e.workers.dev',
    icon: 'calendar',
    category: 'company',
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
    groups: ['financials'],
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
    category: 'sales',
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
    groups: ['ambassadors', 'marketing'],
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
    if (t.status !== 'live' || !t.url) return false;
    const want = (t.groups || []).map(norm);
    if (want.includes(EVERYONE)) return true;
    if (!known) return false;
    return want.some((g) => mine.includes(g));
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
export function tileSections(groups, list) {
  const mine = visibleTiles(groups, list);
  const out = [];
  for (const c of CATEGORIES) {
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
