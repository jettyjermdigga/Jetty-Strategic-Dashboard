// The queue page in a real browser. Skipped, not failed, where Playwright is
// missing, which is why it is not the deploy gate.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'public');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
  } catch {
    console.log('Playwright is not installed here, so the browser suite is skipped.');
    process.exit(0);
  }
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
               '.png': 'image/png' };

const REPS = [
  { key: 'nathan-zelena-llc', name: 'Nathan Zelena LLC', email: 'n@x.com', active: 1 },
  { key: 'agenc-ani-caron', name: 'AgenC (Ani Caron)', email: 'a@x.com', active: 1 },
];
const CHOICES = {
  territories: ['HI', 'NJ', 'CANADA'], lines: ['SS26', 'FW26'],
  methods: ['Check', 'ACH', 'Stripe (CC)'],
  retailers: ['East of Maui', 'PRO Skateboard Shop'], reps: REPS,
};
let ROWS = [
  { id: '11111111-1111-4111-8111-111111111111', paid_on: '2026-09-01',
    invoice_no: '21362', retailer: 'PRO Skateboard Shop', customer: null,
    territory: null, jetty_line: null, payment_method: 'Check', rep_key: null,
    commission_pct: null, gross: 6479.55, credits: null, freight: null,
    cad: 0, usd_net: null, cc_fee: 0, partial: 0, paid: 0 },
  { id: '22222222-2222-4222-8222-222222222222', paid_on: '2026-10-27',
    invoice_no: '22183', retailer: 'East of Maui', customer: 'Kanibal Co.',
    territory: 'HI', jetty_line: 'SS26', payment_method: 'Stripe (CC)', rep_key: null,
    commission_pct: null, gross: 610, credits: -10, freight: 25,
    cad: 0, usd_net: null, cc_fee: 1, partial: 0, paid: 0 },
  { id: '33333333-3333-4333-8333-333333333333', paid_on: '2026-10-28',
    invoice_no: '22400', retailer: 'Surf Unlimited', customer: null,
    territory: 'CANADA', jetty_line: null, payment_method: 'Wire', rep_key: null,
    commission_pct: null, gross: 1400, credits: null, freight: null,
    cad: 1, usd_net: null, cc_fee: 0, partial: 0, paid: 0 },
];
const seen = { patched: [], pulls: 0 };
let XERO = {
  connected: true, configured: true, tenant: 'Jetty Brand',
  accounts: ['200'], lastRunAt: '2026-10-28T07:17:00.000Z',
  lastResult: { made: 4, skipped: 12 },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/400 \(Bad Request\)/.test(m.text())
      && !/500 \(Internal Server Error\)/.test(m.text())) {
    errors.push('console: ' + m.text());
  }
});

await page.route('**/*', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;

  if (p === '/api/choices') return route.fulfill({ json: CHOICES });
  if (p === '/api/xero/status') {
    if (!XERO) return route.fulfill({ status: 500, json: { error: 'nope' } });
    return route.fulfill({ json: XERO });
  }
  if (p === '/api/xero/connect') {
    return route.fulfill({ json: { go: 'https://login.xero.com/identity/connect/authorize?x=1' } });
  }
  if (p === '/api/xero/pull') { seen.pulls += 1; return route.fulfill({ json: { made: 2 } }); }
  if (p === '/api/queue') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const rows = ROWS.filter((r) => !r.rep_key).filter((r) => !q
      || (r.retailer || '').toLowerCase().includes(q)
      || (r.invoice_no || '').includes(q));
    return route.fulfill({ json: {
      rows, waiting: ROWS.filter((r) => !r.rep_key).length,
      totals: { gross: 8479.55 }, you: 'amy@jettylife.com',
    } });
  }
  if (/^\/api\/payments\//.test(p) && req.method() === 'PATCH') {
    const body = req.postDataJSON();
    seen.patched.push({ id: p.split('/').pop(), body });
    if (!body.rep_key || !body.commission_pct) {
      return route.fulfill({ status: 400,
        json: { errors: ['Set the commission rate as well as the rep.'] } });
    }
    ROWS = ROWS.map((r) => (r.id === p.split('/').pop()
      ? { ...r, ...body, rep_key: body.rep_key } : r));
    return route.fulfill({ json: { payment: { id: p.split('/').pop() } } });
  }

  const file = path.join(ROOT, p === '/' ? '/index.html' : p);
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ body: fs.readFileSync(file),
                         contentType: MIME[path.extname(file)] || 'text/plain' });
});

let failed = 0;
let ran = 0;
const t = async (name, fn) => {
  ran += 1;
  try {
    const okay = await fn();
    console.log((okay ? '  ok   ' : '  FAIL ') + name);
    if (!okay) failed += 1;
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
};

await page.goto('http://local.test/');
await page.waitForSelector('.cm-t tbody tr');

console.log('the queue');
await t('lists what is waiting, oldest first', async () => {
  const when = await page.locator('.cm-when').allTextContents();
  return when[0] === '2026-09-01' && when[2] === '2026-10-28';
});
// The two figures everything else hangs off, worked out on screen.
await t('shows the net after credits and freight', async () => {
  const cells = await page.locator('tbody tr').nth(1).locator('.cm-n').allTextContents();
  return cells.join('|').includes('$575.00');
});
await t('shows no commission until there is a rate', async () =>
  (await page.locator('.cm-due').first().textContent()) === '—');
await t('marks a row that carried a card fee or came in CAD', async () => {
  const flags = await page.locator('.cm-flag').allTextContents();
  return flags.includes('3%') && flags.includes('CAD');
});
await t('searches the queue', async () => {
  await page.fill('#q', 'Skateboard');
  await page.waitForFunction(() => document.querySelectorAll('.cm-t tbody tr').length === 1);
  await page.fill('#q', '');
  await page.waitForFunction(() => document.querySelectorAll('.cm-t tbody tr').length === 3);
  return true;
});

// ── Where the money comes from ──────────────────────────────────────────
console.log('');
console.log('the Xero line');
await t('says which organisation, and what the last pull did', async () => {
  const txt = await page.locator('#xero').textContent();
  return txt.includes('Jetty Brand') && txt.includes('4 new') && txt.includes('200');
});
await t('offers a pull, and runs one', async () => {
  const before = seen.pulls;
  await page.locator('#xPull').click();
  await page.waitForFunction(() => !document.querySelector('#xPull[disabled]'));
  return seen.pulls === before + 1;
});
// A pull that failed must say so where somebody is looking, not in a log.
await t('says plainly when the last pull failed', async () => {
  XERO = { ...XERO, lastResult: { error: 'Xero refused the refresh: expired' } };
  await page.reload();
  await page.waitForSelector('.cm-t tbody tr');
  const txt = await page.locator('#xero').textContent();
  return txt.includes('failed') && txt.includes('expired')
    && (await page.locator('#xero .cm-x-off').count()) > 0;
});
await t('offers Connect when nothing is connected', async () => {
  XERO = { connected: false, configured: true };
  await page.reload();
  await page.waitForSelector('.cm-t tbody tr');
  return (await page.locator('#xConnect').count()) === 1
    && (await page.locator('#xPull').count()) === 0;
});
// A Connect button that goes nowhere is worse than a sentence saying why.
await t('says what is missing when the app is not set up', async () => {
  XERO = { connected: false, configured: false };
  await page.reload();
  await page.waitForSelector('.cm-t tbody tr');
  const txt = await page.locator('#xero').textContent();
  return txt.includes('XERO_CLIENT_ID') && (await page.locator('#xConnect').count()) === 0;
});
// The rows are still there and still allocatable.
await t('still shows the queue when the connection cannot be read', async () => {
  XERO = null;
  await page.reload();
  await page.waitForSelector('.cm-t tbody tr');
  return (await page.locator('.cm-t tbody tr').count()) === 3
    && (await page.locator('#xero').isHidden());
});
XERO = { connected: true, configured: true, tenant: 'Jetty Brand', accounts: ['200'],
         lastRunAt: '2026-10-28T07:17:00.000Z', lastResult: { made: 4 } };
await page.reload();
await page.waitForSelector('.cm-t tbody tr');

console.log('');
console.log('allocating one');
await t('opens a form on the row rather than over the page', async () => {
  await page.locator('[data-open]').first().click();
  await page.waitForSelector('.cm-f');
  return (await page.locator('.cm-f [name="rep_key"]').count()) === 1
    && (await page.locator('.cm-modal').count()) === 0;
});
// Typed names are how one rep becomes three spellings and a statement comes
// up short.
await t('offers the reps as a list, not a text box', async () => {
  const tag = await page.locator('.cm-f [name="rep_key"]').evaluate((el) => el.tagName);
  const opts = await page.locator('.cm-f [name="rep_key"] option').allTextContents();
  return tag === 'SELECT' && opts.length === REPS.length + 1
    && opts.includes('Nathan Zelena LLC');
});
// The preview is why the page carries its own copy of the arithmetic: a
// round trip per keystroke would make it lag behind what is on screen.
await t('works the commission out as the rate is typed', async () => {
  await page.fill('.cm-f [name="commission_pct"]', '10');
  await page.waitForFunction(() =>
    document.querySelector('.cm-f-preview').textContent.includes('647.96'));
  return true;
});
await t('follows the credits and the freight too', async () => {
  await page.fill('.cm-f [name="credits"]', '-479.55');
  await page.waitForFunction(() =>
    document.querySelector('.cm-f-preview').textContent.includes('600.00'));
  return true;
});
// Every keystroke re-renders the table underneath the form.
await t('keeps what has been typed across a re-render', async () => {
  await page.selectOption('.cm-f [name="rep_key"]', 'nathan-zelena-llc');
  await page.fill('.cm-f [name="territory"]', 'HI');
  return (await page.locator('.cm-f [name="commission_pct"]').inputValue()) === '10'
    && (await page.locator('.cm-f [name="rep_key"]').inputValue()) === 'nathan-zelena-llc'
    && (await page.locator('.cm-f [name="territory"]').inputValue()) === 'HI';
});
await t('sends what was filled in', async () => {
  await page.locator('.cm-f-save').click();
  await page.waitForFunction(() => !document.querySelector('.cm-f'));
  const last = seen.patched[seen.patched.length - 1];
  return last.body.rep_key === 'nathan-zelena-llc' && last.body.commission_pct === '10'
    && last.body.credits === '-479.55' && last.body.territory === 'HI';
});
await t('takes the row out of the queue', async () =>
  (await page.locator('.cm-t tbody tr').count()) === 2);
// A Canadian row priced off a blank USD figure pays zero, which looks like a
// rate problem rather than a missing number.
await t('asks a Canadian row for its USD net', async () => {
  await page.locator('[data-open]').last().click();
  await page.waitForSelector('.cm-f');
  return (await page.locator('.cm-f [name="usd_net"]').count()) === 1;
});
await t('does not ask a row that is not Canadian', async () => {
  await page.locator('[data-cancel]').click();
  await page.locator('[data-open]').first().click();
  await page.waitForSelector('.cm-f');
  return (await page.locator('.cm-f [name="usd_net"]').count()) === 0;
});
await t('puts a refusal next to the form, and keeps the form open', async () => {
  await page.locator('.cm-f-save').click();
  await page.waitForSelector('.cm-f-err');
  return (await page.locator('.cm-f-err').textContent()).includes('commission rate');
});

// ── Contrast ────────────────────────────────────────────────────────────
//
// A sweep rather than assertions about colour: the ways text ends up
// unreadable are a var that does not exist, a rule below a media query at
// equal specificity, and a colour that was only ever checked in one mode.
const contrastSweep = async () => await page.evaluate(() => {
  const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const parse = (c) => {
    const str = c || '';
    const m = str.match(/[\d.]+/g);
    if (!m) return null;
    // Chromium serialises color-mix() as `color(srgb 0.95 0.89 0.88)` --
    // components 0-1, not 0-255.
    const k = /^color\(/.test(str) ? 255 : 1;
    return { r: +m[0] * k, g: +m[1] * k, b: +m[2] * k, a: m.length > 3 ? Number(m[3]) : 1 };
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
    const eff = over({ ...fg, a: fg.a * (op < 1 ? op : 1) }, bg);
    const cr = ratio(eff, bg);
    if (cr < 4.5) {
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase()
        + (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/)[0] : ''))
        + ' "' + el.textContent.trim().slice(0, 18) + '" ' + cr.toFixed(2));
    }
  });
  return [...new Set(bad)];
});

console.log('');
console.log('contrast');
for (const mode of ['dark', 'light']) {
  await page.emulateMedia({ colorScheme: mode });
  await page.waitForTimeout(200);
  await t('is readable in ' + mode + ' mode, form and all', async () => {
    const bad = await contrastSweep();
    if (bad.length) console.log('         ' + bad.slice(0, 8).join(', '));
    return bad.length === 0;
  });
}

console.log('');
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  failed += errors.length;
}
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
await browser.close();
process.exit(failed ? 1 : 0);
