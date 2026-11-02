// Renders the page against a mocked /api/me and screenshots it, so the thing
// can be looked at before it is deployed anywhere. Not part of the gate.
//
//   node tests/shot.mjs <out-dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleTiles, dashCategories, linkCats, greeting, TILES, CATEGORIES } from '../worker/tiles.js';
import { PEOPLE } from '../worker/people.js';
import { PICKS } from '../worker/music-seed.js';
import {
  rows as budgetRows, calendar as budgetCalendar, WEEK_CURVE, CURVE_IS_PLACEHOLDER,
  GROUPS as BUDGET_GROUPS, BASES, CADENCES, BASELINE_YEAR, FIRST_YEAR,
} from '../worker/budget.js';
import {
  rows as cogsRows, summary as cogsSummary, duplicates as cogsDuplicates,
  seasonOptions as cogsSeasons, KINDS as COGS_KINDS, SHOWS as COGS_SHOWS,
  yearsAround as cogsYearsAround, cleanLine as cogsClean, lineId as cogsLineId,
} from '../worker/cogs.js';
import {
  rows as laborRows, summary as laborSummary, against as laborAgainst,
  withPrior as laborWithPrior, SHOWS as LABOR_SHOWS,
  PEOPLE as ROSTER, ROSTER_AS_OF, SEPARATE_DIVISIONS, PAY_TYPES, CLASSES,
  ROLLUPS, FULL_TIME_HOURS, FT_TYPES, DIVISIONS, PAYROLL_TAX_RATE,
} from '../worker/labor.js';

// Same resolution shim the calendar suite uses: playwright is installed
// globally here, not as a dependency of this directory.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const OUT = process.argv[2] || '.';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// Built the way the Worker builds it, so the screenshots are of the real
// decision rather than a hand-written payload that agrees with nothing.
const me = (email) => {
  const held = email.startsWith('jeremy@') ? TILES.map((t) => t.key) : [];
  const vis = visibleTiles(held);
  return {
    email, verified: true, accessConfigured: true, reason: '',
    tilesHeld: held, greeting: greeting(email), isAdmin: email.startsWith('jeremy@'),
    tiles: vis, cats: dashCategories(vis, [], CATEGORIES),
  };
};

// A catalogue with enough in it to exercise the row. The real one has two
// live tiles, which lights two of eleven.
const FULL = [
  ['general', 'Company Calendar', 'Events, Marketing, Meetings, & Deadlines across every department within the company.'],
  ['general', 'Staff Handbook', 'Policies, benefits, time off and who to ask about what.'],
  ['general', 'Culture Board', 'What we are doing together this quarter.'],
  ['general', 'Org Chart', 'Who does what, and who they do it with.'],
  ['finance', 'Strategic Dashboard', 'Revenue, COGS, OpEx, inventory and cash flow against plan, week by week.'],
  ['wholesale', 'Wholesale Hub', 'Order book, line sheets and account activity.'],
  ['wholesale', 'Line Sheets', 'Every season, current and archived.'],
  ['marketing', 'Ambassador Hub', 'Roster, agreements and activity for the ambassador programme.'],
  ['box-truck', 'Box Truck Schedule', 'Where it is going and who is driving it.'],
  ['jrf', 'Grants', 'Applications, awards and reporting.'],
].map(([category, name, blurb], i) => ({
  key: 'f' + i, name, blurb, url: 'https://example.test/' + i,
  icon: 'link', category, everyone: category === 'general', status: 'live',
}));

// Everything not open to everyone is given to this fixture person.
const HELD = FULL.filter((t) => !t.everyone).map((t) => t.key);

const LINKS = [
  ['marketing', 'Model Inquiry Form', 'https://example.test/models'],
  ['marketing', 'Brand Guidelines', 'https://example.test/brand'],
  ['general', 'Benefits Portal', 'https://example.test/benefits'],
  ['general', 'IT Help', 'https://example.test/it'],
  ['wholesale', 'Faire Storefront', 'https://example.test/faire'],
  // Two categories, so it turns up under both filters -- the case the
  // whole multi-category change exists for.
  ['logistics,finance', 'Freight Vendor Portal', 'https://example.test/freight'],
  ['general,prodev', 'Fit Model Survey', 'https://example.test/fit'],
].map(([category, name, url], i) => ({ key: 'l' + i, name, url, category, sort: i }));

const flat = (ls) => ls.map((l) => ({ key: l.key, name: l.name, url: l.url, cats: linkCats(l) }));

const full = (email) => {
  const vis = visibleTiles(HELD, FULL);
  return {
    email, verified: true, accessConfigured: true, reason: '', isAdmin: true,
    tilesHeld: HELD, greeting: greeting(email),
    tiles: vis, cats: dashCategories(vis, LINKS, CATEGORIES),
    links: flat(LINKS),
  };
};

// Exactly what is live today: the two seeded tiles, no links. Two of eleven
// lit, which is the state that looked broken before.
const BARE = (email) => {
  const held = TILES.map((t) => t.key);
  const vis = visibleTiles(held);
  return {
    email, verified: true, accessConfigured: true, reason: '', isAdmin: true,
    tilesHeld: held, greeting: greeting(email),
    tiles: vis, cats: dashCategories(vis, [], CATEGORIES),
  };
};

// Somebody who holds no tiles at all but can still reach the links. The
// category lights on its links alone, and the pane says why it has no tools.
const LINKS_ONLY = (email) => ({
  email, verified: true, accessConfigured: true, reason: '', isAdmin: false,
  tilesHeld: [], greeting: greeting(email),
  tiles: [], cats: dashCategories([], LINKS, CATEGORIES),
  links: flat(LINKS),
});

// What somebody sees on a hostname the Access application does not cover:
// nothing, and the reason.
const SHUT_OUT = {
  email: '', verified: false, accessConfigured: true, isAdmin: false,
  reason: 'No Cloudflare Access headers reached this Worker at all, which means'
    + ' jettydash.com is not on the Access application -- add that exact'
    + ' hostname to its destinations.',
  tilesHeld: null, greeting: greeting(''), tiles: [], cats: [],
};

const CASES = [
  { file: 'dash-bare-light', scheme: 'light', who: BARE('jeremy@jettylife.com'), wait: '.catbar' },
  { file: 'dash-bare-dark', scheme: 'dark', who: BARE('jeremy@jettylife.com'), wait: '.catbar' },
  { file: 'dash-full-dark', scheme: 'dark', who: full('jeremy@jettylife.com'), wait: '.catbar' },
  { file: 'dash-full-light', scheme: 'light', who: full('jeremy@jettylife.com'), wait: '.catbar' },
  // Click a category with both tiles and links in it.
  { file: 'dash-full-marketing', scheme: 'dark', who: full('jeremy@jettylife.com'),
    wait: '.catbar', click: '.cb[data-cat="marketing"]', after: '.cb.on[data-cat="marketing"]' },
  { file: 'dash-links-only', scheme: 'dark', who: LINKS_ONLY('amy@jettylife.com'),
    wait: '.catbar' },
  { file: 'dash-shut-out', scheme: 'dark', who: SHUT_OUT, wait: '.notice' },
  { file: 'music-dark', scheme: 'dark', who: full('jeremy@jettylife.com'),
    path: 'music.html', wait: '.mu-row' },
  { file: 'music-light', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'music.html', wait: '.mu-row' },
  { file: 'music-search', scheme: 'dark', who: full('jeremy@jettylife.com'),
    path: 'music.html', wait: '.mu-row', type: ['#q', 'bridges'], after: '.mu-row' },
  { file: 'dash-director-dark', scheme: 'dark',  who: me('jeremy@jettylife.com'), wait: '.catbar' },
  { file: 'dash-amy-dark', scheme: 'dark', who: me('amy@jettylife.com'), wait: '.catbar' },
  { file: 'dash-admin-dark', scheme: 'dark', who: me('jeremy@jettylife.com'),
    path: 'admin.html', wait: '.tile-row' },
  { file: 'dash-admin-people', scheme: 'dark', who: me('jeremy@jettylife.com'),
    path: 'admin.html', wait: '.tile-row', click: '.setup-tab[data-pane="people"]',
    after: '.secbox .chip' },
  { file: 'dash-admin-links', scheme: 'dark', who: me('jeremy@jettylife.com'),
    path: 'admin.html', wait: '.tile-row', click: '.setup-tab[data-pane="links"]',
    after: '.link-row' },
  { file: 'budget-year-light', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'budget.html', wait: '.bd-in' },
  { file: 'budget-year-dark', scheme: 'dark', who: full('jeremy@jettylife.com'),
    path: 'budget.html', wait: '.bd-in' },
  { file: 'budget-new-line', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'budget.html', wait: '.bd-in', scroll: '.bd-wrap' },
  { file: 'budget-month-dark', scheme: 'dark', who: full('jeremy@jettylife.com'),
    path: 'budget.html', wait: '.bd-in', click: '#seg button[data-v="month"]',
    after: '.bd-t.ro' },
  { file: 'budget-week-light', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'budget.html', wait: '.bd-in', click: '#seg button[data-v="week"]',
    after: '.bd-t.ro' },
  { file: 'labor-light', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'labor.html', wait: '.lb-sel', types: true },
  { file: 'labor-dark', scheme: 'dark', who: full('jeremy@jettylife.com'),
    path: 'labor.html', wait: '.lb-sel' },
  { file: 'labor-tbh', scheme: 'dark', who: full('jeremy@jettylife.com'),
    path: 'labor.html', wait: '.lb-sel', select: ['#filter', 'tbh'], after: '.lb-chip.tbh' },
  { file: 'labor-unsplit', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'labor.html', wait: '.lb-sel', select: ['#filter', 'unsplit'], after: '.lb-cls' },
  // One department, which is the shape this page is read in most: the
  // filters doing what the department bands used to do.
  { file: 'labor-dept', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'labor.html', wait: '.lb-sel',
    select: ['#fDept', 'Flagship Store'], after: '.lb-foot' },
  { file: 'cogs-light', scheme: 'light', adds: true, graph: true,
    who: full('jeremy@jettylife.com'),
    path: 'cogs.html', wait: '.lb-sel' },
  { file: 'cogs-dark', scheme: 'dark', graph: true, who: full('jeremy@jettylife.com'),
    path: 'cogs.html', wait: '.cg-svg' },
  // One season, which is the shape it gets read in: bulk against samples.
  { file: 'cogs-season', scheme: 'light', who: full('jeremy@jettylife.com'),
    path: 'cogs.html', wait: '.lb-sel',
    select: ['#fSeason', 'sp27'], after: '.lb-foot' },
  { file: 'cogs-shut-out', scheme: 'light', who: full('amy@jettylife.com'),
    path: 'cogs.html', wait: '.notice', noBudget: true },
  { file: 'labor-shut-out', scheme: 'light', who: full('amy@jettylife.com'),
    path: 'labor.html', wait: '.notice', noBudget: true },
  { file: 'budget-shut-out', scheme: 'dark', who: full('amy@jettylife.com'),
    path: 'budget.html', wait: '.notice', noBudget: true },
  { file: 'dash-admin-cats', scheme: 'dark', who: me('jeremy@jettylife.com'),
    path: 'admin.html', wait: '.tile-row', click: '.setup-tab[data-pane="cats"]',
    after: '.cat-row' },
];

// What /api/admin/all answers, built from the same seed the store uses.
const ADMIN = {
  tiles: FULL,
  categories: CATEGORIES,
  links: LINKS.map((l) => ({ ...l, cats: linkCats(l) })),
  people: Object.keys(PEOPLE).sort().map((e, i) => ({
    email: e, name: '', tiles: i % 3 === 0 ? HELD.slice(0, 2) : HELD.slice(0, 1),
  })),
  admins: ['jeremy@jettylife.com'],
  you: 'jeremy@jettylife.com',
};

// The real thirteen years, newest first, exactly as the Worker sends them.
const MUSIC = [...PICKS].reverse().map((p) => ({
  date: p.d, artist: p.a, song: p.s, by: p.by, yt: p.y, url: p.v,
  photo: p.p ? p.d + '.webp' : '',
}));

// Exactly what /api/budget answers, built from the same modules the Worker
// uses -- with six lines decided, which is what a budget half-built looks
// like and is the only state where the three dot colours are all on screen.
const DECIDED = {
  'software-inventory-control': { amount: 104000, note: 'Dropping Asana + 2 unused seats; Shopify Plus renews Mar' },
  advertising: { amount: 430000, note: 'Pulling back paid; $137K over plan in 2026' },
  rent: { amount: 478000, note: '700 S Main escalator 2.5%' },
  utilities: { amount: 238000, note: 'Ran 35% over plan \u2014 needs a look', flagged: true },
  wholesale: { amount: 6100000, note: 'Recovery assumed; 2026 missed by $557K' },
  'jettylife-com-dtc': { amount: 3400000, note: 'Only line ahead of plan \u2014 leaning in' },
};
const BUDGET = {
  year: FIRST_YEAR, baselineYear: BASELINE_YEAR, first: FIRST_YEAR,
  you: 'jeremy@jettylife.com',
  groups: BUDGET_GROUPS, bases: BASES, cadences: CADENCES,
  lines: budgetRows(DECIDED),
  periods: budgetCalendar(FIRST_YEAR),
  curve: WEEK_CURVE, curvePlaceholder: CURVE_IS_PLACEHOLDER,
};

// A labor plan part way through: a few people costed, one struck off, one
// write-in. That is the only state where all of it is on screen at once --
// a costed row, an undecided one, a to-be-hired chip and a write-in.
const PLANNED = (() => {
  const out = {};
  const salaried = ROSTER.filter((p) => p.pay === 'salary').slice(0, 7);
  const hourly = ROSTER.filter((p) => p.pay === 'hourly').slice(0, 9);
  salaried.forEach((p, i) => {
    out[p.k] = { pay: 'salary', salary: 62000 + i * 9500,
                 // Some split, some not: "not yet split" is a state the
                 // page has to show as plainly as the other two.
                 cls: i < 4 ? 'gna' : i < 6 ? 'direct' : '',
                 note: i === 0 ? 'Merit review lands in Q2' : '' };
  });
  hourly.forEach((p, i) => {
    out[p.k] = { pay: 'hourly', rate: 21 + i, hours: i % 3 === 0 ? 1560 : FULL_TIME_HOURS,
                 cls: i < 6 ? 'direct' : '',
                 note: i === 1 ? 'Part-time through the winter' : '' };
  });
  const gone = ROSTER.find((p) => p.type === 'outsourced');
  if (gone) out[gone.k] = { removed: true };
  out['ink-logistics-associate-2'] = {
    added: true, name: 'INK Logistics Associate', title: 'INK Logistics Associate',
    dept: 'Operations (INK)', division: 'INK', pay: 'hourly', cls: 'direct',
    rate: 23, hours: 2080,
    note: 'Starts in March, so three quarters of a year',
  };
  return out;
})();

// What the baseline looks like part way through a backfill: most of it
// in, some of it not. A sheet where every baseline cell is full says
// nothing about how the half-done state reads.
const BASELINE = (() => {
  const out = {};
  Object.keys(PLANNED).forEach((k, i) => {
    if (i % 4 === 3) return;
    const d = PLANNED[k];
    out[k] = d.pay === 'hourly'
      ? { pay: 'hourly', rate: (d.rate || 20) - 2, hours: d.hours }
      : { pay: 'salary', salary: Math.round((d.salary || 60000) * 0.96) };
  });
  return out;
})();

const LABOR = (() => {
  const people = laborWithPrior(laborRows(PLANNED), BASELINE);
  return {
    year: FIRST_YEAR, baseYear: FIRST_YEAR - 1, shows: LABOR_SHOWS,
    years: [FIRST_YEAR, FIRST_YEAR + 1, FIRST_YEAR + 2],
    taxRate: PAYROLL_TAX_RATE, revenue: 14500000,
    you: 'jeremy@jettylife.com',
    rosterAsOf: ROSTER_AS_OF, rosterSize: ROSTER.length,
    separate: SEPARATE_DIVISIONS.join(', '),
    payTypes: PAY_TYPES, classes: CLASSES, rollups: ROLLUPS, ftTypes: FT_TYPES, divisions: DIVISIONS,
    fullTimeHours: FULL_TIME_HOURS,
    people,
    against: laborAgainst(laborSummary(people), {}, 'proj'),
  };
})();

// A COGS sheet part way through: next year half costed, one prior season
// backfilled so the trend has something to be a trend against.
const COGS_SAVED = (() => {
  const saved = {
    // SP27 is bought across two years: the deposit went down in 2026 and
    // the balance falls in the year it drops. SMS goes out ahead of the
    // bulk, so it is paid for earlier still.
    'sp27:bulk': { season: 'sp27', years: { 2026: 310000, 2027: 930000 } },
    'sp27:sms': { season: 'sp27', years: { 2026: 48500 } },
    'su27:bulk': { season: 'su27', years: { 2027: 910000 } },
    'f27:bulk': { season: 'f27', years: { 2027: 1180000, 2028: 200000 } },
    'f27:sms': { season: 'f27', years: { 2027: 52000 } },
    'starboard:bulk': { season: 'starboard', years: { 2027: 165000 } },
    // A prior season, now inside the window: 2025 is on screen against a
    // 2027 budget, which is what the wider reach is for.
    'sp26:bulk': { added: true, season: 'sp26', kind: 'bulk',
                   seasonLabel: 'SP26', years: { 2025: 240000, 2026: 952000 } },
    'sp26:sms': { added: true, season: 'sp26', kind: 'sms',
                  seasonLabel: 'SP26', years: { 2025: 44800 } },
  };
  return saved;
})();

// Built fresh on every request, so a line added through the entry row is
// on the sheet that comes back -- which is the half of adding a line that
// a screenshot cannot see.
const cogsSheet = () => {
  const rs = cogsRows(COGS_SAVED, FIRST_YEAR);
  return {
    you: 'jeremy@jettylife.com', kinds: COGS_KINDS, shows: COGS_SHOWS,
    year: FIRST_YEAR, years: cogsYearsAround(FIRST_YEAR),
    firstYear: FIRST_YEAR, baselineYear: FIRST_YEAR - 1,
    lines: rs, seasons: cogsSeasons(rs),
    summary: cogsSummary(rs), duplicates: cogsDuplicates(rs),
  };
};

// What the entry row actually sent. The sheet that comes back cannot
// answer this one: two lines under the same season key look identical on
// screen whichever label was typed.
const cogsPosts = [];

const browser = await chromium.launch();
for (const c of CASES) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 }, colorScheme: c.scheme,
  });
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/me') return route.fulfill({ json: c.who });
    if (p === '/api/admin/all') return route.fulfill({ json: ADMIN });
    if (p === '/api/music') return route.fulfill({ json: { picks: MUSIC } });
    // Not on the list: the endpoint 404s whatever the People tab says, and
    // the page has to say so rather than render an empty sheet.
    if (p === '/api/budget') {
      return c.noBudget
        ? route.fulfill({ status: 404, json: { error: 'No such endpoint.' } })
        : route.fulfill({ json: BUDGET });
    }
    if (p === '/api/cogs/line') {
      const body = route.request().postDataJSON();
      cogsPosts.push(body);
      const { row, errors } = cogsClean(body, null);
      if (errors) return route.fulfill({ status: 400, json: { errors } });
      COGS_SAVED[cogsLineId(row.season, row.kind)] = { ...row };
      return route.fulfill({ json: { ok: true, ...cogsSheet() } });
    }
    if (p === '/api/cogs' || p.startsWith('/api/cogs?')) {
      return c.noBudget
        ? route.fulfill({ status: 404, json: { error: 'No such endpoint.' } })
        : route.fulfill({ json: cogsSheet() });
    }
    if (p === '/api/labor') {
      return c.noBudget
        ? route.fulfill({ status: 404, json: { error: 'No such endpoint.' } })
        : route.fulfill({ json: LABOR });
    }
    // A stand-in for the artwork: the real files live in R2, which the
    // harness has no access to. Solid grey at the right aspect, so the
    // layout being checked is the layout that ships.
    if (p.startsWith('/music/photo/')) {
      return route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">'
          + '<rect width="300" height="300" fill="#7d8a92"/></svg>' });
    }
    const file = path.join(ROOT, p === '/' ? '/index.html' : p);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'text/plain',
    });
  });
  // The chart is off until somebody presses Graph, so a case that wants it
  // in the shot -- and in the contrast sweep -- says so here.
  if (c.graph) {
    await page.addInitScript(() => {
      try { localStorage.setItem('jetty-cogs-graph', '1'); } catch (err) { /* private */ }
    });
  }
  await page.goto('http://local.test/' + (c.path || ''));
  await page.waitForSelector(c.wait || '.catbar, .pane-empty');
  if (c.type) {
    await page.fill(c.type[0], c.type[1]);
    await page.waitForTimeout(150);
  }
  // The new-for-2027 line sits at the foot of OpEx, which nothing else
  // scrolls to -- and it is the only row that draws its 2026 columns
  // differently.
  if (c.scroll) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = el.scrollHeight;
    }, c.scroll);
    await page.waitForTimeout(120);
  }
  if (c.select) {
    await page.selectOption(c.select[0], c.select[1]);
    await page.waitForSelector(c.after || 'tbody tr');
  }
  if (c.click) {
    await page.locator(c.click).first().click();
    await page.waitForSelector(c.after || '.side-row');
  }
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, c.file + '.png') });

  // The calendar shipped three separate invisible-text bugs before anyone
  // rendered it in dark mode. This page gets the same sweep from the start.
  const dim = await page.evaluate(() => {
    const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const parse = (c) => {
      const s = c || '';
      const m = s.match(/[\d.]+/g);
      if (!m) return null;
      // Chromium serialises color-mix() as `color(srgb 0.95 0.89 0.88)` --
      // components 0-1, not 0-255. Read as 0-255 those are all but black,
      // so every color-mix background in here was being measured against
      // the wrong colour: this check was passing and failing on numbers it
      // had made up. The dash uses color-mix for the notice, the tile
      // badge and the budget's flag button.
      const k = /^color\(/.test(s) ? 255 : 1;
      return { r: +m[0] * k, g: +m[1] * k, b: +m[2] * k,
               a: m.length > 3 ? Number(m[3]) : 1 };
    };
    const over = (f, b) => ({
      r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a),
      b: f.b * f.a + b.b * (1 - f.a), a: 1,
    });
    const lum = (c) => 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const behind = (el) => {
      const stack = [];
      for (let n = el.parentElement; n; n = n.parentElement) stack.push(n);
      let acc = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) {
        const c = parse(getComputedStyle(stack[i]).backgroundColor);
        if (c && c.a > 0) acc = over(c, acc);
      }
      return acc;
    };
    const bad = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
      const fg = parse(cs.color);
      if (!fg) return;
      const selfBg = parse(cs.backgroundColor);
      let bg = behind(el);
      if (selfBg && selfBg.a > 0) bg = over(selfBg, bg);
      const op = Number(cs.opacity);
      const cr = ratio(over({ ...fg, a: fg.a * (op < 1 ? op : 1) }, bg), bg);
      if (cr < 4.5) {
        bad.push((el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/)[0] : el.tagName.toLowerCase())
          + ' "' + el.textContent.trim().slice(0, 16) + '" ' + cr.toFixed(2));
      }
    });
    return [...new Set(bad)];
  });
  // The People tab shows open-to-everyone tiles as locked chips. They must
  // not be class "chip": the submit handler collects .chip to build the
  // tiles list, so leaking one would store an assignment the All flag
  // already covers -- and it would outlive All being switched off.
  if (c.file === 'dash-admin-people') {
    const bad = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.chip-all')];
      return {
        n: all.length,
        asChip: all.filter((e) => e.matches('.chip')).length,
        removable: all.filter((e) => e.querySelector('.chip-x')).length,
        submitted: [...document.querySelectorAll('.secbox .chip')]
          .filter((e) => e.classList.contains('chip-all')).length,
      };
    });
    const faults = [];
    if (!bad.n) faults.push('no locked chips rendered at all');
    if (bad.asChip) faults.push(bad.asChip + ' locked chips match .chip');
    if (bad.removable) faults.push(bad.removable + ' locked chips have a remove button');
    if (bad.submitted) faults.push(bad.submitted + ' locked chips would be submitted');
    console.log('  locked chips: ' + bad.n
      + (faults.length ? '  FAULT: ' + faults.join('; ') : '  not submittable, not removable'));
  }

  // Every tile and link leaves the dash, so every one of them opens beside
  // it -- and target=_blank without rel=noopener hands the opened page a
  // handle on this one. Checked rather than trusted, because it is one
  // attribute on two lines of markup and nothing else would notice.
  const outward = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('a.tl, a.lk').forEach((a) => {
      const rel = (a.getAttribute('rel') || '');
      if (a.getAttribute('target') !== '_blank') bad.push(a.textContent.trim().slice(0, 18) + ' (no target)');
      else if (!/\bnoopener\b/.test(rel)) bad.push(a.textContent.trim().slice(0, 18) + ' (no noopener)');
    });
    return bad;
  });

  // Typing a figure repaints the running totals. Those cells used to be
  // found by counting along the row, and the day a column was inserted to
  // their left the total started being written over the salary box next
  // door, destroying the input it landed in. Screenshots did not catch it
  // because nothing typed; this does.
  if (c.types) {
    // Six figures that have to agree with each other. Hourly plus
    // Salaried is Total exactly; Direct plus G&A is Total minus whatever
    // has not been split, which is the one gap on the strip that is
    // allowed and the one its tooltip has to explain.
    const strip = await page.evaluate(() => {
      const n = (s2) => Number(String(s2).replace(/[^0-9.-]/g, '')) || 0;
      const out = {};
      document.querySelectorAll('#vs .bd-m').forEach((el) => {
        const b = el.querySelector('b');
        out[el.childNodes[0].textContent.trim()] = { v: n(b.textContent),
                                                     why: el.title || '' };
      });
      return out;
    });
    const g = (k) => (strip[k] ? strip[k].v : null);
    const adds = g('Hourly total') + g('Salaried total') === g('Total');

    // That they sum to Total says nothing about which is which -- moving
    // every hourly cost into Salaried still sums. So each is checked
    // against the sheet itself, filtered to that way of being paid.
    const footFor = async (pay) => {
      await page.selectOption('#fPay', pay);
      await page.waitForSelector('.lb-foot');
      const v = await page.evaluate(() => {
        const td = document.querySelector('.lb-foot .lb-tot:not(.lb-y1)');
        return Number(String(td.textContent).replace(/[^0-9.-]/g, '')) || 0;
      });
      await page.selectOption('#fPay', '');
      return v;
    };
    const byPay = { hourly: await footFor('hourly'), salary: await footFor('salary') };
    const right = byPay.hourly === g('Hourly total')
      && byPay.salary === g('Salaried total')
      && byPay.hourly > 0 && byPay.salary > 0;
    const gap = g('Total') - g('Direct labor') - g('Salaries — G&A');

    // The tax tile is a stated percentage of a figure on the same strip,
    // so it can be checked against it rather than taken on trust. Nobody
    // reproduces a number like this by hand, which is exactly why it is
    // the kind that goes wrong unnoticed.
    const tax = g('Est. payroll taxes');
    const taxRight = Math.abs(tax - g('Total') * 0.11) <= 1;
    // And the share is of payroll PLUS that tax, against the revenue the
    // Worker sent -- not of payroll alone, which would read lower than
    // employing anybody actually costs.
    const share = Number(String((await page.evaluate(() => {
      const el = [...document.querySelectorAll('#vs .bd-m')]
        .find((x) => x.childNodes[0].textContent.includes('% of revenue'));
      return el ? el.querySelector('b').textContent : '';
    }))).replace(/[^0-9.]/g, ''));
    const want = ((g('Total') + tax) / 14500000) * 100;
    const shareRight = Math.abs(share - want) <= 0.1;
    const explained = gap === 0 || /not split/.test(strip.Total.why);
    console.log('  strip: ' + Object.keys(strip).join(' / ')
      + (adds ? '  adds up' : '  DOES NOT ADD UP')
      + (right ? '' : '  WRONG SPLIT: sheet says ' + JSON.stringify(byPay))
      + (taxRight ? '' : '  TAX IS NOT 11% OF TOTAL: ' + tax)
      + (shareRight ? '' : '  SHARE IS NOT LOADED PAYROLL: ' + share + ' vs ' + want)
      + (explained ? '' : '  UNEXPLAINED GAP of ' + gap));
    if (!adds || !explained || !right || !taxRight || !shareRight) process.exitCode = 1;

    // A different year is a different plan, a different baseline and a
    // different budget to read it against -- so the picker has to offer
    // the budget's own years and not a list that drifts from them.
    const years = await page.evaluate(() => [...document.querySelectorAll('#fYear option')]
      .map((o) => o.value));
    const yearOk = years.length > 1 && years.every((y) => /^\d{4}$/.test(y))
      && years[0] === String(new Date().getFullYear() + 1);
    console.log('  years: ' + years.join(',') + (yearOk ? '' : '  WRONG YEARS'));
    if (!yearOk) process.exitCode = 1;

    // The header and the body have to agree on how many columns there are,
    // and a footer that spans the wrong number puts every total under the
    // wrong heading. Counted rather than looked at, because a row is
    // seventeen cells wide and nobody counts that by eye twice.
    const widths = await page.evaluate(() => {
      const n = (tr) => [...tr.children].reduce(
        (t, td) => t + (Number(td.getAttribute('colspan')) || 1), 0);
      return {
        head: n(document.querySelector('.lb-t thead tr')),
        body: n(document.querySelector('.lb-t tbody tr[data-k]')),
        foot: n(document.querySelector('.lb-t .lb-foot')),
      };
    });
    const square = widths.head === widths.body && widths.body === widths.foot;
    console.log('  columns: ' + JSON.stringify(widths) + (square ? ' square' : ' RAGGED'));
    if (!square) process.exitCode = 1;

    const before = await page.locator('tr[data-k] input.lb-in').count();
    const box = page.locator('tr[data-k] input.lb-in').first();
    await box.fill('25');
    await box.dispatchEvent('input');
    const after = await page.evaluate(() => {
      const tr = document.querySelector('tr[data-k]');
      return {
        inputs: document.querySelectorAll('tr[data-k] input.lb-in').length,
        totals: [...tr.querySelectorAll('[data-tot]')].map((td) => td.textContent),
        counted: [...tr.children].findIndex((td) => td.dataset.tot === 'base'),
      };
    });
    const kept = after.inputs === before;

    // A rate carries its cents. Rounding $19.10 to $19 on screen is not a
    // display choice: the next edit starts from what is shown, so the ten
    // pence is typed over and lost the first time anybody touches the row.
    const rate = page.locator('tr[data-k] input[data-f="rate"]').first();
    await rate.fill('19.10');
    await rate.dispatchEvent('input');
    await rate.dispatchEvent('change');
    const typed = await rate.inputValue();
    // And again after the sheet is drawn from scratch, which is the other
    // half of it: a rate can be rounded on the way into the box as well as
    // on the way out, and only one of those is what you see while typing.
    await page.fill('#q', 'zzzz');
    await page.fill('#q', '');
    await page.waitForSelector('tr[data-k] input[data-f="rate"]');
    const drawn = await page.locator('tr[data-k] input[data-f="rate"]').first().inputValue();
    const shown = typed === drawn ? typed : typed + ' typed / ' + drawn + ' redrawn';
    const hours = page.locator('tr[data-k] input[data-f="hours"]').first();
    await hours.fill('2080');
    await hours.dispatchEvent('change');
    const total = await page.evaluate(() => document.querySelector(
      'tr[data-k] [data-tot="base"]').textContent);

    console.log('  typing: ' + (kept ? 'inputs intact' : 'DESTROYED AN INPUT')
      + ', rate reads ' + JSON.stringify(shown)
      + ', total ' + JSON.stringify(total));
    if (!kept) process.exitCode = 1;
    if (shown !== '19.10') {
      console.log('    RATE LOST ITS CENTS: expected "19.10"');
      process.exitCode = 1;
    }
  }


  // ── adding a line ─────────────────────────────────────────────────────
  //
  // The sheet is a history being built one season at a time, so the entry
  // row at the bottom is the control that matters most. A screenshot shows
  // it is there; only driving it shows it works.
  if (c.adds) {
    const rows = () => page.locator('tr[data-id]').count();
    const before = await rows();

    // Season, a figure, Enter. No mouse, because a run of seasons typed
    // one after another is the whole point of the row.
    await page.fill('#nuSeason', 'SS24');
    await page.locator('[data-nu="2024"]').last().fill('880000');
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) =>
      document.querySelectorAll('tr[data-id]').length === n + 1, before);

    const landed = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('tr[data-id]')]
        .find((x) => x.querySelector('select[data-f="season"]')
          && x.querySelector('select[data-f="season"]').selectedOptions[0]
          && x.querySelector('select[data-f="season"]')
            .selectedOptions[0].textContent === 'SS24');
      return tr ? {
        y2024: tr.querySelector('[data-y="2024"]').value,
        total: tr.querySelector('.lb-tot').textContent,
      } : null;
    });

    // The row clears and the cursor goes back where the next season is
    // typed. Leaving it full is how a season gets entered twice.
    const after = await page.evaluate(() => ({
      season: document.querySelector('#nuSeason').value,
      focus: document.activeElement ? document.activeElement.id : '',
    }));

    // A season already on the sheet, typed in the wrong case. It has to
    // join that season under the name already in use -- checked on what was
    // sent, because two lines under one season key look identical on screen
    // whichever of the two spellings was stored against them.
    const seasonsBefore = await page.locator('#cgSeasons option').count();
    cogsPosts.length = 0;
    await page.fill('#nuSeason', 'ss24');
    await page.selectOption('#nuKind', 'sms');
    await page.click('#nuAdd');
    await page.waitForFunction((n) =>
      document.querySelectorAll('tr[data-id]').length === n + 2, before);
    const seasonsAfter = await page.locator('#cgSeasons option').count();
    const reused = cogsPosts.length === 1
      && cogsPosts[0].season === 'ss24' && cogsPosts[0].seasonLabel === 'SS24';

    // Both, which is what the prompt this replaced always did. A figure
    // typed once cannot belong to two lines, so the figure boxes are not
    // offered -- rather than taken and quietly dropped on the way in.
    await page.fill('#nuSeason', 'F24');
    await page.locator('[data-nu="2024"]').last().fill('123456');
    await page.selectOption('#nuKind', 'both');
    await page.waitForFunction(() => {
      const el = document.querySelector('.cg-add [data-nu]');
      return el && el.disabled;
    });
    const bothShut = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('.cg-add [data-nu]')];
      const note = document.querySelector('#nuNote');
      return cells.every((el) => el.disabled && el.value === '')
        && note.disabled && note.value === '';
    });
    await page.click('#nuAdd');
    await page.waitForFunction((n) =>
      document.querySelectorAll('tr[data-id]').length === n + 4, before);

    const ok = landed && landed.y2024 === '880,000'
      && /880,000/.test(landed.total)
      && after.season === '' && after.focus === 'nuSeason'
      && seasonsAfter === seasonsBefore && reused && bothShut;
    console.log('  entry row: ' + (landed ? 'line lands' : 'LINE DID NOT LAND')
      + ', ' + (after.season === '' ? 'clears' : 'LEFT FULL')
      + ', ' + (after.focus === 'nuSeason' ? 'keeps focus' : 'LOST FOCUS')
      + ', ' + (seasonsAfter === seasonsBefore && reused
        ? 'reuses a known season' : 'DUPLICATED A SEASON')
      + ', ' + (bothShut ? 'Both drops no figures' : 'BOTH ATE A TYPED FIGURE')
      + ', ' + (await rows()) + ' rows from ' + before);
    if (!ok) process.exitCode = 1;
    // Drawn again from scratch so the screenshot is the sheet, not the
    // sheet mid-edit.
    await page.reload();
    await page.waitForSelector('.cg-add');
  }

  // ── the chart ─────────────────────────────────────────────────────────
  //
  // It reads whatever the filters leave behind, which is the whole request.
  // The things worth driving: that filtering changes it, that the scale
  // covers the tallest column, and that one axis never mixes its units.
  if (c.graph) {
    const caps = () => page.locator('.cg-svg .cap').allTextContents();
    const cats = () => page.locator('.cg-svg .cat').allTextContents();

    const allCaps = await caps();
    const tickText = await page.locator('.cg-svg .tick').allTextContents();

    // A scale that stops below the tallest column draws it out of the top
    // of the plot. Measured: every segment's box inside the plot's box.
    const inside = await page.evaluate(() => {
      const svg = document.querySelector('.cg-svg');
      const top = svg.getBoundingClientRect().top;
      return [...svg.querySelectorAll('.seg')]
        .every((p) => p.getBoundingClientRect().top >= top - 0.5);
    });

    // One unit per axis. $500K beside $1.5M is two styles on one scale.
    const units = new Set(tickText.filter((t) => t !== '$0')
      .map((t) => t.replace(/[\d.,$]/g, '')));
    const oneUnit = units.size <= 1;

    // Colour follows the kind, never the column's position. Checked by
    // reading every two-part stack against the tokens themselves: an
    // earlier version compared one column's fill before and after a
    // filter, which column 0 satisfies whichever way the hue is picked.
    const hues = await page.evaluate(() => {
      const root = document.querySelector('.cg-chart');
      const cs = getComputedStyle(root);
      const paint = (v) => {
        const d = document.createElement('div');
        d.style.color = v;
        document.body.appendChild(d);
        const out = getComputedStyle(d).color;
        d.remove();
        return out;
      };
      const bulk = paint(cs.getPropertyValue('--s-bulk').trim());
      const sms = paint(cs.getPropertyValue('--s-sms').trim());
      const segs = [...document.querySelectorAll('.cg-svg .seg')]
        .map((p) => ({ fill: paint(getComputedStyle(p).fill),
                       y: p.getBoundingClientRect().top,
                       x: Math.round(p.getBoundingClientRect().left) }));
      const by = {};
      segs.forEach((g) => { (by[g.x] = by[g.x] || []).push(g); });
      // Bulk sits at the bottom of every stack, samples on top.
      return Object.keys(by).filter((x) => by[x].length === 2).map((x) => {
        const pair = by[x].slice().sort((a, b) => a.y - b.y);
        return pair[1].fill === bulk && pair[0].fill === sms;
      });
    });

    await page.selectOption('#fKind', 'sms');
    await page.waitForTimeout(120);
    const smsCaps = await caps();
    await page.selectOption('#fKind', '');
    await page.waitForTimeout(120);

    // By year is a different question off the same rows.
    await page.click('[data-by="year"]');
    await page.waitForTimeout(120);
    const yearCats = await cats();
    await page.click('[data-by="season"]');
    await page.waitForTimeout(120);

    // The tooltip is the overflow home for the split, on focus as on hover.
    await page.locator('.cg-svg .hit').first().focus();
    await page.waitForSelector('#cgTip:not([hidden])');
    const tip = await page.locator('#cgTip').textContent();

    const filters = smsCaps.length > 0 && smsCaps.join() !== allCaps.join();
    const years = yearCats.length > 0 && yearCats.every((y) => /^\d{4}$/.test(y));
    const keptHue = hues.length > 0 && hues.every(Boolean);
    const split = /Bulk|SMS/.test(tip);
    const okChart = inside && oneUnit && filters && years && keptHue && split;

    console.log('  chart: ' + allCaps.length + ' columns'
      + ', ' + (inside ? 'inside the plot' : 'OVERFLOWS THE PLOT')
      + ', ' + (oneUnit ? 'one axis unit' : 'MIXED AXIS UNITS: ' + [...units].join('/'))
      + ', ' + (filters ? 'follows the filter' : 'IGNORES THE FILTER')
      + ', ' + (years ? 'by year works' : 'BY YEAR BROKEN')
      + ', ' + (keptHue ? 'hue follows the kind' : 'HUE NOT KEYED TO THE KIND')
      + ', ' + (split ? 'tooltip on focus' : 'NO TOOLTIP ON FOCUS'));
    if (!okChart) process.exitCode = 1;
  }

  // The row is meant to be one line. Eleven chips fit only because the chip
  // is tight, so a twelfth category -- or a long name -- silently turns it
  // into a drag. Measured rather than eyeballed, and reported every run.
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.catbar');
    if (!el) return null;
    const tops = new Set([...el.querySelectorAll('.cb')]
      .map((c) => Math.round(c.getBoundingClientRect().top)));
    return { over: el.scrollWidth - el.clientWidth, rows: tops.size };
  });
  console.log(c.file + '  ' + (await page.locator('.cb, .tl, .row, tr[data-k], tr[data-id]').count()) + ' items'
    + (bar ? '  row: ' + bar.rows + ' line' + (bar.rows === 1 ? '' : 's')
             + (bar.over > 0 ? ', OVERFLOWS by ' + bar.over + 'px' : ', fits') : '')
    + (outward.length ? '  NOT OPENING OUT: ' + outward.join(', ') : '')
    + (dim.length ? '  LOW CONTRAST: ' + dim.join(', ') : '  contrast ok'));
  await page.close();
}
await browser.close();
