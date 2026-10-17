// Renders the page against a mocked /api/me and screenshots it, so the thing
// can be looked at before it is deployed anywhere. Not part of the gate.
//
//   node tests/shot.mjs <out-dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleTiles, dashCategories, linkCats, greeting, TILES, HUBS, CATEGORIES } from '../worker/tiles.js';
import { PEOPLE } from '../worker/people.js';
import { PICKS } from '../worker/music-seed.js';

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

// What the dash looks like once the Airtable hubs are in and assigned: the
// real catalogue, not a fixture. This is the case to look at before saying
// anything about how it will feel to use.
const HUBBED = (email) => {
  const all = [...TILES.filter((t) => t.url), ...HUBS];
  const held = all.map((t) => t.key);
  const vis = visibleTiles(held, all);
  return {
    email, verified: true, accessConfigured: true, reason: '', isAdmin: true,
    tilesHeld: held, greeting: greeting(email),
    tiles: vis, cats: dashCategories(vis, [], CATEGORIES),
  };
};

const CASES = [
  { file: 'dash-hubs-dark', scheme: 'dark', who: HUBBED('jeremy@jettylife.com'), wait: '.catbar' },
  { file: 'dash-hubs-light', scheme: 'light', who: HUBBED('jeremy@jettylife.com'), wait: '.catbar' },
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
  date: p.d, artist: p.a, song: p.s, by: p.by, yt: p.y, url: p.v, photo: '',
}));

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
    const file = path.join(ROOT, p === '/' ? '/index.html' : p);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'text/plain',
    });
  });
  await page.goto('http://local.test/' + (c.path || ''));
  await page.waitForSelector(c.wait || '.catbar, .pane-empty');
  if (c.type) {
    await page.fill(c.type[0], c.type[1]);
    await page.waitForTimeout(150);
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
      const m = (c || '').match(/[\d.]+/g);
      if (!m) return null;
      return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? Number(m[3]) : 1 };
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
  console.log(c.file + '  ' + (await page.locator('.cb, .tl, .row').count()) + ' items'
    + (bar ? '  row: ' + bar.rows + ' line' + (bar.rows === 1 ? '' : 's')
             + (bar.over > 0 ? ', OVERFLOWS by ' + bar.over + 'px' : ', fits') : '')
    + (outward.length ? '  NOT OPENING OUT: ' + outward.join(', ') : '')
    + (dim.length ? '  LOW CONTRAST: ' + dim.join(', ') : '  contrast ok'));
  await page.close();
}
await browser.close();
