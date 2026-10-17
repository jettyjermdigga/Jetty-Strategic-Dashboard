// Renders the page against a mocked /api/me and screenshots it, so the thing
// can be looked at before it is deployed anywhere. Not part of the gate.
//
//   node tests/shot.mjs <out-dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleTiles, greeting, GROUPS } from '../worker/tiles.js';

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

const me = (email, groups) => ({
  email, verified: true, accessConfigured: true, reason: '', groupReason: '',
  groups, knownGroups: GROUPS, greeting: greeting(email), tiles: visibleTiles(groups),
});

const CASES = [
  { file: 'dash-director-dark', scheme: 'dark',  who: me('jeremy@jettylife.com', ['Directors', 'Marketing']) },
  { file: 'dash-director-light', scheme: 'light', who: me('jeremy@jettylife.com', ['Directors', 'Marketing']) },
  { file: 'dash-wholesale-dark', scheme: 'dark', who: me('wholesale@jettylife.com', ['Wholesale']) },
  { file: 'dash-nogroups-dark', scheme: 'dark', who: me('newhire@jettylife.com', []) },
];

const browser = await chromium.launch();
for (const c of CASES) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 }, colorScheme: c.scheme,
  });
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/me') return route.fulfill({ json: c.who });
    const file = path.join(ROOT, p === '/' ? '/index.html' : p);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'text/plain',
    });
  });
  await page.goto('http://local.test/');
  await page.waitForSelector('.tile, .tiles-empty');
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
  console.log(c.file + '  ' + (await page.locator('.tile').count()) + ' tiles'
    + (dim.length ? '  LOW CONTRAST: ' + dim.join(', ') : '  contrast ok'));
  await page.close();
}
await browser.close();
