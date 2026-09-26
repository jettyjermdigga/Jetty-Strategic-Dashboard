// Browser tests. `node tests/browser.mjs`, needs Playwright with Chromium.
//
// The whole page runs against a stubbed API: no Worker, no database, no
// Cloudflare. What is checked is what the person actually sees and clicks --
// which is where most of this project's real bugs have been. Rows that were not
// clickable, colour dots with no size, a filter that blanked the calendar, a
// count that read zero and was telling the truth.

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
    console.log('  npm i -D playwright && npx playwright install chromium');
    process.exit(0);
  }
}

const { TAXONOMY } = await import('../worker/taxonomy.js');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const ev = (o) => Object.assign({
  event_type: 'events-marketing', department: 'jrf', departments: '', sub_types: '',
  needs: '', staff_count: '', vehicles: '', status: 'Booked',
  start_date: '2026-09-08', end_date: '2026-09-08', all_day: 1, start_time: '', end_time: '',
  venue: '', address: '', city: '', state: '', zip: '', notes: '', url: '', attachment_count: 0,
}, o);

// One per day: a month cell shows three chips and then "+N more".
const ITEMS = [
  ev({ id: '11111111-1111-4111-8111-111111111111', title: 'Coquina Jam',
       departments: 'box-truck', vehicles: 'box-truck', attachment_count: 1 }),
  ev({ id: '22222222-2222-4222-8222-222222222222', title: 'LB Spring Sale',
       department: 'long-branch-store', departments: 'marketing', sub_types: 'promotion',
       status: 'Pending', start_date: '2026-09-10', end_date: '2026-09-10' }),
  ev({ id: '33333333-3333-4333-8333-333333333333', title: 'Fall Email',
       department: 'marketing', sub_types: 'email',
       start_date: '2026-09-14', end_date: '2026-09-14' }),
  ev({ id: '44444444-4444-4444-8444-444444444444', title: 'Buy Plan Meeting',
       event_type: 'meetings-deadlines', department: '',
       start_date: '2026-09-17', end_date: '2026-09-17' }),
  ev({ id: '55555555-5555-4555-8555-555555555555', title: 'Surf Expo',
       department: 'wholesale', departments: 'jetty-ink', sub_types: 'tradeshow',
       vehicles: 'ink-van', start_date: '2026-09-22', end_date: '2026-09-22' }),
];

const ATTACHMENTS = [{
  id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'permit.pdf', size: 20480,
  uploaded_by: 'jeremy@jettylife.com', uploaded_at: '2026-09-01T10:00:00Z',
}];

const seen = { posted: null, patched: null, uploads: [], deleted: [] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.route('**/*', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const p = url.pathname;

  if (p === '/api/taxonomy') return route.fulfill({ json: TAXONOMY });
  if (p === '/api/me') {
    return route.fulfill({ json: {
      email: 'jeremy@jettylife.com', canEdit: true,
      accessConfigured: true, editorsConfigured: true,
    } });
  }
  if (/\/attachments$/.test(p) && method === 'POST') {
    seen.uploads.push(decodeURIComponent(req.headers()['x-file-name'] || ''));
    return route.fulfill({ status: 201, json: { attachment: { id: 'new', name: 'x', size: 1 } } });
  }
  if (/^\/api\/attachments\//.test(p) && method === 'DELETE') {
    seen.deleted.push(p.split('/').pop());
    return route.fulfill({ json: { deleted: 'ok' } });
  }
  if (/^\/api\/items\/[0-9a-f-]+$/.test(p) && method === 'GET') {
    const it = ITEMS.find((x) => x.id === p.split('/').pop());
    return route.fulfill({ json: { item: it, attachments: it && it.attachment_count ? ATTACHMENTS : [] } });
  }
  if (/^\/api\/items\/[0-9a-f-]+$/.test(p) && method === 'PATCH') {
    seen.patched = JSON.parse(req.postData());
    return route.fulfill({ json: { item: ITEMS[0] } });
  }
  if (p === '/api/items' && method === 'POST') {
    seen.posted = JSON.parse(req.postData());
    return route.fulfill({ status: 201, json: { item: ev({ id: '66666666-6666-4666-8666-666666666666' }) } });
  }
  if (p.startsWith('/api/items')) return route.fulfill({ json: { items: ITEMS } });

  const file = path.join(ROOT, p === '/' ? '/index.html' : p);
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({
    body: fs.readFileSync(file),
    contentType: MIME[path.extname(file)] || 'text/plain',
  });
});

let failed = 0;
let ran = 0;
const t = async (name, fn) => {
  ran++;
  try {
    const okay = await fn();
    console.log((okay ? '  ok   ' : '  FAIL ') + name);
    if (!okay) failed++;
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
};

const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const chip = (label) => page.locator('.fchip').filter({ hasText: new RegExp('^' + rx(label)) }).first();
const listed = async () => await page.locator('#listPanel .day-title').allTextContents();
const clearAll = async () => { await page.locator('.fchip.all').click(); };

await page.goto('http://local.test/');
await page.waitForSelector('.mo-grid');
page.on('dialog', (d) => d.accept());

console.log('the calendar');
await t('shows every event when nothing is picked', async () =>
  (await page.locator('.chip').count()) === ITEMS.length);
await t('colours an event by its primary department', async () => await page.evaluate(() => {
  const c = [...document.querySelectorAll('.chip')].find((x) => x.textContent.includes('Coquina'));
  return getComputedStyle(c.querySelector('.bar i')).backgroundColor === 'rgb(0, 131, 0)';
}));
await t('marks the other departments as dots, not bands', async () => await page.evaluate(() => {
  const c = [...document.querySelectorAll('.chip')].find((x) => x.textContent.includes('Coquina'));
  return c.querySelectorAll('.bar i').length === 1 && c.querySelectorAll('.alsodots i').length === 1;
}));
await t('greys an event with no department rather than borrowing one', async () => await page.evaluate(() => {
  const c = [...document.querySelectorAll('.chip')].find((x) => x.textContent.includes('Buy Plan'));
  return getComputedStyle(c.querySelector('.bar i')).backgroundColor === 'rgb(138, 143, 152)';
}));

console.log('filtering');
await t('offers one chip per department, plus Unassigned', async () =>
  (await page.locator('.fchip[data-axis="depts"]').count()) === 12);
await t('opens the list once something is picked', async () => {
  await chip('Wholesale').click();
  return await page.locator('#listPanel').isVisible()
    && (await page.locator('#shell.split').count()) === 1;
});
await t('lists what the filter found', async () => {
  const l = await listed();
  return l.length === 1 && l[0].includes('Surf Expo');
});
await t('lets a department go when another axis is picked', async () => {
  await page.locator('.fchip[data-key="email"]').click();
  return (await chip('Wholesale').getAttribute('aria-pressed')) === 'false';
});
await t('drops everything else when a department is picked', async () => {
  await chip('Marketing (All)').click();
  return (await page.locator('.fs-tok').count()) === 1;
});
await t('keeps an event its department only promotes', async () => {
  const l = await listed();
  return l.length === 2;     // its own email, and the store sale it promotes
});
await t('finds the events with no department at all', async () => {
  await chip('Unassigned').click();
  const l = await listed();
  return l.length === 1 && l[0].includes('Buy Plan');
});
await t('names every active filter, removably', async () => {
  await clearAll();
  await page.locator('.fchip[data-key="email"]').click();
  await page.locator('.fchip[data-key="Pending"]').click();
  const toks = await page.locator('.fs-tok').allTextContents();
  return toks.length === 2;
});
await t('says so when the combination matches nothing', async () =>
  (await page.locator('.fs-count').textContent()).includes('nothing matches'));
await t('recovers when one token is removed', async () => {
  await page.locator('.fs-tok').filter({ hasText: 'Email' }).click();
  return (await page.locator('.fs-tok').count()) === 1;
});
await t('clears everything and closes the list', async () => {
  await clearAll();
  return (await page.locator('#listPanel').isHidden())
    && (await page.locator('.flt-status').count()) === 0;
});

console.log('the header');
await t('has no view switcher or retail-week box', async () =>
  (await page.locator('#views').count()) === 0 && (await page.locator('#wkNum').count()) === 0);
await t('moves a month at a time', async () => {
  await page.locator('#next').click();
  const a = (await page.locator('#period').textContent()).trim();
  await page.locator('#prev').click();
  return a === 'October 2026';
});

console.log('adding an event');
await page.locator('#addBtn').click();
await t('opens on the kind question, with a trail', async () =>
  (await page.locator('.step[data-step="kind"]:not([hidden])').count()) === 1
  && (await page.locator('.trail-n').textContent()).includes('Step 1 of'));
await t('will not advance without a name', async () => {
  await page.locator('button[data-act="next"]').click();
  await page.locator('button[data-act="next"]').click();
  return (await page.locator('.step[data-step="title"]:not([hidden])').count()) === 1;
});
await page.locator('#f-title').fill('Beach Cleanup');
await page.locator('button[data-act="next"]').click();
await t('will not advance without a department', async () => {
  await page.locator('button[data-act="next"]').click();
  return (await page.locator('.step[data-step="dept"]:not([hidden])').count()) === 1;
});
await page.locator('.f-dept[value="jrf"]').check();
await page.locator('button[data-act="next"]').click();
await t('does not offer the primary again as an extra', async () =>
  (await page.locator('.f-extra[value="jrf"]').count()) === 0);
await page.locator('.f-extra[value="marketing"]').check();
await page.locator('button[data-act="next"]').click();
await t('offers sub-types from every department on the event', async () => {
  const vals = await page.locator('.f-sub').evaluateAll((els) => els.map((e) => e.value));
  return vals.includes('email') && !vals.includes('tradeshow');
});
await page.locator('button[data-act="next"]').click();
await t('derives the retail week on screen', async () =>
  (await page.locator('#retailOut').textContent()).includes('Week'));
await page.locator('button[data-act="next"]').click();
await page.locator('button[data-act="next"]').click();
await t('asks every event what it needs', async () =>
  (await page.locator('.f-need').count()) === 3);
await t('asks how many only once extra staff is ticked', async () => {
  const before = await page.locator('#staffRow').isVisible();
  await page.locator('.f-need[value="extra-staff"]').check();
  return !before && await page.locator('#staffRow').isVisible();
});
await page.locator('#f-staff').fill('3');
await page.locator('button[data-act="next"]').click();
await t('defaults a new event to Booked', async () =>
  (await page.locator('#f-status').inputValue()) === 'Booked');
await t('holds files until the event has been saved', async () =>
  await page.locator('#attPending').isVisible());
await page.locator('#f-files').setInputFiles([
  { name: 'flyer.pdf', mimeType: 'application/pdf', buffer: Buffer.from('one') },
]);
await page.locator('button[data-act="save"]').click();
await page.waitForFunction(() => document.querySelector('#modal').hidden);
await t('posts the five axes and the staff count', async () =>
  seen.posted.department === 'jrf'
  && JSON.stringify(seen.posted.departments) === '["marketing"]'
  && JSON.stringify(seen.posted.needs) === '["extra-staff"]'
  && seen.posted.staff_count === '3');
await t('uploads the file after the event exists', async () =>
  seen.uploads.length === 1 && seen.uploads[0] === 'flyer.pdf');

console.log('a meeting');
await page.locator('#addBtn').click();
await page.locator('.f-kind[value="meetings-deadlines"]').check();
await t('is five steps, not nine', async () =>
  (await page.locator('.trail-n').textContent()).includes('of 5'));
await t('never asks about a venue', async () => {
  for (let i = 0; i < 6; i++) {
    if (await page.locator('#f-venue').isVisible()) return false;
    if (!(await page.locator('button[data-act="next"]').count())) break;
    if ((await page.locator('#deptPick').isVisible())
        && !(await page.locator('.f-dept:checked').count())) {
      await page.locator('.f-dept[value="finance"]').check();
    }
    await page.locator('button[data-act="next"]').click();
  }
  return true;
});
await page.locator('button[data-act="close"]').click();

console.log('an existing event');
await page.locator('.chip:has-text("Coquina")').click();
await page.waitForSelector('.att-slot .att-row');
await t('lists its attachments, as downloads', async () =>
  (await page.locator('.att-slot .att-name').first().getAttribute('download')) !== null);
await t('offers no way to remove them from the read view', async () =>
  (await page.locator('.att-slot .att-x').count()) === 0);
await page.locator('button[data-act="edit"]').click();
await page.waitForSelector('#attList .att-row');
await t('shows every section at once when editing, with no wizard', async () =>
  (await page.locator('.step:not([hidden])').count()) >= 8
  && (await page.locator('button[data-act="next"]').count()) === 0);
await t('preselects what the event already has', async () =>
  await page.locator('.f-dept[value="jrf"]').isChecked()
  && await page.locator('.f-extra[value="box-truck"]').isChecked()
  && await page.locator('.f-veh[value="box-truck"]').isChecked());
await t('removes an attachment straight away, not on save', async () => {
  await page.locator('#attList .att-x').first().click();
  await page.waitForFunction(() => !document.querySelector('#attList .att-row'));
  return seen.deleted.length === 1;
});

console.log('a list row');
await page.locator('button[data-act="close"]').click();
await chip('Wholesale').click();
await page.locator('#listPanel .day-item').first().click();
await t('opens its event', async () =>
  await page.locator('#modal').isVisible()
  && (await page.locator('.det-title').textContent()).includes('Surf Expo'));

console.log('');
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  failed += errors.length;
}
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
await browser.close();
process.exit(failed ? 1 : 0);
