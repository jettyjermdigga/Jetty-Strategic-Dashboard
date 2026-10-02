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
  start_date: dayThis(8), end_date: dayThis(8), all_day: 1, start_time: '', end_time: '',
  venue: '', address: '', city: '', state: '', zip: '', notes: '', url: '', attachment_count: 0,
}, o);

// The calendar opens on the month containing today, so the fixture has to live
// there too -- dates written out in full went stale the moment that month
// passed, and the whole suite failed on a calendar that was working fine.
const NOW = new Date();
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');
const dayThis = (d) => NOW.getFullYear() + '-' + pad2(NOW.getMonth() + 1) + '-' + pad2(d);
const nextMonth = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1);
const NEXT_MONTH_LABEL = MONTH_NAMES[nextMonth.getMonth()] + ' ' + nextMonth.getFullYear();

// One per day: a month cell shows three chips and then "+N more".
const ITEMS = [
  ev({ id: '11111111-1111-4111-8111-111111111111', title: 'Coquina Jam',
       departments: 'box-truck', vehicles: 'box-truck', attachment_count: 1 }),
  ev({ id: '22222222-2222-4222-8222-222222222222', title: 'LB Spring Sale',
       department: 'long-branch-store', departments: 'marketing', sub_types: 'campaign-promotion',
       status: 'Pending', start_date: dayThis(10), end_date: dayThis(10) }),
  ev({ id: '33333333-3333-4333-8333-333333333333', title: 'Fall Email',
       department: 'marketing', sub_types: 'email-sms',
       start_date: dayThis(14), end_date: dayThis(14) }),
  ev({ id: '44444444-4444-4444-8444-444444444444', title: 'Buy Plan Meeting',
       event_type: 'meetings-deadlines', department: '',
       start_date: dayThis(17), end_date: dayThis(17) }),
  ev({ id: '55555555-5555-4555-8555-555555555555', title: 'Surf Expo',
       department: 'wholesale', departments: 'jetty-ink', sub_types: 'tradeshow',
       vehicles: 'ink-van', start_date: dayThis(22), end_date: dayThis(22) }),
];

const ATTACHMENTS = [{
  id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'permit.pdf', size: 20480,
  uploaded_by: 'jeremy@jettylife.com', uploaded_at: dayThis(1) + 'T10:00:00Z',
}];

const seen = { posted: null, patched: null, uploads: [], uploadSlots: [], deleted: [], savedFilters: null, resets: 0 };
let feedRow = { url: 'https://feed.test/calendar.ics?token=' + 'a'.repeat(64), filters: {} };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  // The lapsed-sign-in check aborts a request on purpose; the browser logs
  // that, and it is the point of the test rather than a fault.
  if (m.type() === 'error' && !/net::ERR_FAILED/.test(m.text())) {
    errors.push('console: ' + m.text());
  }
});

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
    const name = decodeURIComponent(req.headers()['x-file-name'] || '');
    seen.uploads.push(name);
    seen.uploadSlots.push({ name, slot: req.headers()['x-file-slot'] || '' });
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
  if (p === '/api/feed') {
    if (method === 'PUT') {
      seen.savedFilters = JSON.parse(req.postData()).filters;
      feedRow = { ...feedRow, filters: seen.savedFilters };
    }
    if (method === 'POST') {
      seen.resets++;
      feedRow = { ...feedRow, url: 'https://feed.test/calendar.ics?token=' + 'b'.repeat(64) };
    }
    return route.fulfill({ json: feedRow });
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
// No Everything chip any more: Clear all in the active-filter bar is the one
// way back to an unfiltered calendar, and it only exists while a filter is on.
const clearAll = async () => { await page.locator('#fltReset').click(); };

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
  await page.locator('.fchip[data-key="email-sms"]').click();
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
  await page.locator('.fchip[data-key="email-sms"]').click();
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
  return a === NEXT_MONTH_LABEL;
});

console.log('the export');
// Reads the file the browser actually wrote, not the string that built it --
// the BOM, the quoting and the line endings are the part a partner's importer
// trips over.
const grabCsv = async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#xGo').click(),
  ]);
  return fs.readFileSync(await dl.path(), 'utf8');
};
const csvRows = (text) => text.replace(/^﻿/, '').split('\r\n').filter(Boolean);

await t('replaces Import in the header', async () =>
  (await page.locator('#exportBtn').count()) === 1
  && (await page.locator('#importBtn').count()) === 0);
await page.locator('#exportBtn').click();
await t('says how many events will come out', async () =>
  (await page.locator('#xCount').textContent()) === ITEMS.length + ' events');
await t('says the whole calendar is going when nothing is filtered', async () =>
  (await page.locator('.modal-lede').textContent()).includes('whole calendar'));

let csv = await grabCsv();
await t('writes a header and one row per event', async () =>
  csvRows(csv).length === ITEMS.length + 1);
await t('leads with the columns a partner reads', async () =>
  csvRows(csv)[0].startsWith('Name,Status,Event Type,Department'));
await t('carries labels, not internal keys', async () =>
  csv.includes('Box Truck') && csv.includes('Campaign/Promo')
  && !csv.includes('box-truck') && !csv.includes('campaign-promotion'));
await t('is UTF-8 for Excel', async () => csv.startsWith('﻿'));

await page.locator('.fchip[data-axis="depts"][data-key="marketing"]').click();
await page.locator('#exportBtn').click();
await t('exports only what the chips left on screen', async () =>
  (await page.locator('#xCount').textContent()) === '2 events');
await t('names the filter in the file name', async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#xGo').click(),
  ]);
  const name = dl.suggestedFilename();
  csv = fs.readFileSync(await dl.path(), 'utf8');
  return name.includes('marketing') && name.endsWith('.csv');
});
await t('and the rows agree with the count', async () => csvRows(csv).length === 3);
await clearAll();

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
  return vals.includes('email-sms') && !vals.includes('tradeshow');
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
  { name: 'wrong-one.pdf', mimeType: 'application/pdf', buffer: Buffer.from('two') },
]);
await t('offers no product highlights until one is added', async () =>
  (await page.locator('.prod-row').count()) === 0
  && (await page.locator('#prodAdd').isVisible()));
await page.locator('#prodAdd').click();
await page.locator('#prodAdd').click();
await t('adds a row at a time', async () => (await page.locator('.prod-row').count()) === 2);
await t('offers the four divisions', async () => {
  const opts = await page.locator('.prod-row').first().locator('.p-div option')
    .evaluateAll((els) => els.map((e) => e.value));
  return JSON.stringify(opts) === JSON.stringify(['', 'mens', 'womens', 'yti', 'accessories']);
});
await t('drops a row without disturbing the one next to it', async () => {
  await page.locator('.prod-row').first().locator('.p-cat').fill('Boardshorts');
  await page.locator('.prod-row').nth(1).locator('.p-cat').fill('Delete me');
  await page.locator('.prod-row').nth(1).locator('.prod-x').click();
  return (await page.locator('.prod-row').count()) === 1
    && (await page.locator('.p-cat').inputValue()) === 'Boardshorts';
});
await page.locator('.prod-row .p-div').selectOption('womens');
await page.locator('.prod-row .p-sku').fill('JW-9000');
await page.locator('.prod-row .p-url').fill('https://jettylife.com/collections/boardshorts');
await page.locator('.prod-row .p-img').setInputFiles([
  { name: 'swatch.png', mimeType: 'image/png', buffer: Buffer.from('img') },
]);
await t('shows the example image it will attach to that row', async () =>
  (await page.locator('.prod-img-n').textContent()) === 'swatch.png');

await t('names the files waiting to go up', async () =>
  (await page.locator('.att-q .att-qn').allTextContents()).join() === 'flyer.pdf,wrong-one.pdf');
await t('takes one back off before it is uploaded', async () => {
  await page.locator('.att-qx[data-q="1"]').click();
  return (await page.locator('.att-q').count()) === 1
    && (await page.locator('.att-qn').textContent()) === 'flyer.pdf';
});
await t('marks the box while something is dragged over it', async () => {
  const fire = (type) => page.evaluate((t) => document.querySelector('#attBox')
    .dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true })), type);
  await fire('dragover');
  const on = await page.locator('#attBox.drag').count();
  await fire('dragleave');
  return on === 1 && (await page.locator('#attBox.drag').count()) === 0;
});
await page.locator('button[data-act="save"]').click();
await page.waitForFunction(() => document.querySelector('#modal').hidden);
await t('posts the five axes and the staff count', async () =>
  seen.posted.department === 'jrf'
  && JSON.stringify(seen.posted.departments) === '["marketing"]'
  && JSON.stringify(seen.posted.needs) === '["extra-staff"]'
  && seen.posted.staff_count === '3');
await t('posts the product highlight', async () => {
  const p = seen.posted.products;
  return p.length === 1 && p[0].division === 'womens' && p[0].category === 'Boardshorts'
    && p[0].sku === 'JW-9000'
    && p[0].url === 'https://jettylife.com/collections/boardshorts' && !!p[0].id;
});
await t('uploads the event file and the row image, after the event exists', async () =>
  seen.uploads.length === 2
  && seen.uploads.includes('flyer.pdf') && seen.uploads.includes('swatch.png'));
await t('tags the row image with the highlight it illustrates, and the file with nothing', async () => {
  const img = seen.uploadSlots.find((u) => u.name === 'swatch.png');
  const doc = seen.uploadSlots.find((u) => u.name === 'flyer.pdf');
  return img.slot === seen.posted.products[0].id && !doc.slot;
});

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

console.log('calendar sync');
await page.locator('button[data-act="close"]').click();   // the edit form is still open
await page.waitForFunction(() => document.querySelector('#modal').hidden);
await page.locator('#subscribe').click();
await page.waitForSelector('#syncBox .sub-url');
await t('hands out one stable link', async () =>
  (await page.locator('#feedUrl').textContent()).includes('token=' + 'a'.repeat(64)));
await t('warns that nothing ticked means all of it', async () =>
  (await page.locator('.sub-scope.warn').textContent()).includes('every Email/SMS send'));
// Counted off the taxonomy rather than written out, so adding a sub-type or a
// department is not a test failure.
await t('offers every axis to choose from', async () =>
  (await page.locator('.sync-opt[data-param="dept"]').count()) === TAXONOMY.departments.length
  && (await page.locator('.sync-opt[data-param="kind"]').count()) === TAXONOMY.eventTypes.length
  && (await page.locator('.sync-opt[data-param="sub"]').count()) === TAXONOMY.subTypes.length
  && (await page.locator('.sync-opt[data-param="status"]').count()) === TAXONOMY.statuses.length);
await t('saves a choice without a Save button', async () => {
  await page.locator('.sync-opt[data-param="dept"][value="box-truck"]').check();
  await page.waitForFunction(() => !document.querySelector('.sub-scope.warn'));
  return JSON.stringify(seen.savedFilters) === '{"dept":["box-truck"]}';
});
await t('keeps the same link when the selection changes', async () =>
  (await page.locator('#feedUrl').textContent()).includes('token=' + 'a'.repeat(64)));
await t('reset issues a new link', async () => {
  await page.locator('button[data-act="feed-reset"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#feedUrl').textContent.includes('bbbb'));
  return seen.resets === 1;
});
await page.locator('button[data-act="close"]').click();

console.log('a lapsed sign-in');
// Access expires while the page is open; the save is redirected to a login
// page on another origin and fetch rejects with a bare "Failed to fetch".
await page.locator('.chip:has-text("LB Spring Sale")').click();
await page.locator('button[data-act="edit"]').click();
await page.waitForSelector('#f-title');
await page.route('**/api/items/*', (route) => {
  if (route.request().method() === 'PATCH') return route.abort('failed');
  return route.fallback();
});
await page.locator('button[data-act="save"]').click();
await t('says the sign-in expired, not "Failed to fetch"', async () => {
  await page.waitForSelector('#formErr:not([hidden])');
  const msg = await page.locator('#formErr').textContent();
  return msg.includes('sign-in has expired') && !msg.includes('Failed to fetch');
});
await t('leaves the form open so the work is not lost', async () =>
  (await page.locator('#f-title').inputValue()).includes('LB Spring Sale')
  && (await page.locator('button[data-act="save"]').isEnabled()));
await page.unroute('**/api/items/*');
await page.locator('button[data-act="close"]').click();

console.log('a list row');
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
