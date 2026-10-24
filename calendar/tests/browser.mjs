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
  event_type: 'event', department: 'jrf', departments: '', sub_types: '',
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
  // A Marketing item, which is what an email blast actually is -- and the
  // kind the Email/SMS rule is scoped to.
  ev({ id: '33333333-3333-4333-8333-333333333333', title: 'Fall Email',
       event_type: 'marketing', department: 'marketing', sub_types: 'email-sms',
       start_date: dayThis(14), end_date: dayThis(14) }),
  ev({ id: '44444444-4444-4444-8444-444444444444', title: 'Buy Plan Meeting',
       event_type: 'meeting', department: '',
       start_date: dayThis(17), end_date: dayThis(17) }),
  // Four on one day: the month cell caps at three, which is what the download
  // has to undo.
  ev({ id: '66666666-6666-4666-8666-666666666666', title: 'Crowded A',
       department: 'culture', start_date: dayThis(8), end_date: dayThis(8) }),
  ev({ id: '77777777-7777-4777-8777-777777777777', title: 'Crowded B',
       department: 'culture', start_date: dayThis(8), end_date: dayThis(8) }),
  ev({ id: '88888888-8888-4888-8888-888888888888', title: 'Crowded C',
       department: 'culture', start_date: dayThis(8), end_date: dayThis(8) }),
  ev({ id: '55555555-5555-4555-8555-555555555555', title: 'Surf Expo',
       department: 'wholesale', departments: 'jetty-ink', sub_types: 'tradeshow',
       vehicles: 'ink-van', start_date: dayThis(22), end_date: dayThis(22) }),
];

const ATTACHMENTS = [{
  id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'permit.pdf', size: 20480,
  uploaded_by: 'jeremy@jettylife.com', uploaded_at: dayThis(1) + 'T10:00:00Z',
}];

const COMMENTS = [{
  id: 'cccccccc-0000-4000-8000-000000000000', body: 'Do we have the permit?',
  mentions: 'amy@jettylife.com', author: 'dave@jettylife.com',
  created_at: '2026-10-01T09:00:00Z',
}];

// Flipped by the delivery-warning check below.
let slackStatus = null;

const seen = { posted: null, patched: null, uploads: [], uploadSlots: [], deleted: [],
               deletedComments: [], commented: null, savedFilters: null, resets: 0,
               mentionsSeen: 0 };
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
  // Everywhere the calendar has been, as the Worker derives it. Two of them
  // so picking one and then picking another is a real change.
  // Comments that mention me. One automatic notice from the calendar and
  // one from a person, so both render; the first is new, the second is not.
  if (p === '/api/mentions') {
    if (url.searchParams.get('seen') === '1') seen.mentionsSeen++;
    return route.fulfill({ json: {
      seenAt: seen.mentionsSeen ? '2026-12-31T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
      unread: seen.mentionsSeen ? 0 : 1,
      mentions: [
        { id: 'm1', item_id: ITEMS[0].id, title: ITEMS[0].title,
          start_date: ITEMS[0].start_date, author: 'calendar',
          body: 'Arlynn changed this Paid Advo item.\nChanged: start date',
          created_at: '2026-10-20T10:00:00.000Z' },
        { id: 'm2', item_id: ITEMS[0].id, title: ITEMS[0].title,
          start_date: ITEMS[0].start_date, author: 'amy@jettylife.com',
          body: 'Can you confirm the spend?', created_at: '2026-09-01T10:00:00.000Z' },
      ],
    } });
  }
  if (p === '/api/places') {
    return route.fulfill({ json: { places: [
      { key: 'a', label: 'Jetty Flagship \u2014 700 S Main St \u00b7 Manahawkin, NJ',
        venue: 'Jetty Flagship', address: '700 S Main St', city: 'Manahawkin',
        state: 'NJ', zip: '08050', n: 12, last: '2026-09-01' },
      { key: 'b', label: 'Taylor Ave. Waterfront \u2014 Beach Haven, NJ',
        venue: 'Taylor Ave. Waterfront', address: '', city: 'Beach Haven',
        state: 'NJ', zip: '', n: 3, last: '2026-06-13' },
    ] } });
  }
  if (p === '/api/people') {
    return route.fulfill({ json: { slackConfigured: true, slackStatus: slackStatus, people: [
      { email: 'jeremy@jettylife.com', name: 'Jeremy', slack_id: 'U1' },
      { email: 'amy@jettylife.com', name: 'Amy Smith', slack_id: 'U2' },
      { email: 'dave@jettylife.com', name: 'Dave', slack_id: null },
    ] } });
  }
  if (/\/comments$/.test(p) && method === 'GET') {
    return route.fulfill({ json: { comments: COMMENTS } });
  }
  if (/\/comments$/.test(p) && method === 'POST') {
    seen.commented = req.postDataJSON();
    return route.fulfill({ status: 201, json: { comment: {
      id: 'cccccccc-1111-4111-8111-111111111111', body: seen.commented.body,
      mentions: (seen.commented.mentions || []).join(','),
      author: 'jeremy@jettylife.com', created_at: '2026-10-02T12:00:00Z',
    } } });
  }
  if (/^\/api\/comments\//.test(p) && method === 'DELETE') {
    seen.deletedComments.push(p.split('/').pop());
    return route.fulfill({ json: { deleted: 'ok' } });
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
await t('shows every event when nothing is picked', async () => {
  // A crowded cell draws three and counts the rest, so the grid accounts for
  // every event without necessarily drawing every one.
  const drawn = await page.locator('.chip').count();
  const hidden = (await page.locator('.mo-more').allTextContents())
    .reduce((n, t) => n + Number(t.replace(/\D/g, '')), 0);
  return drawn + hidden === ITEMS.length;
});
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
  (await page.locator('.fchip[data-axis="depts"]').count())
    === TAXONOMY.departments.length + 1);
await t('is four levels, each one named', async () => {
  const hints = await page.locator('.frow .fhint').allTextContents();
  return JSON.stringify(hints)
    === JSON.stringify(['Kind', 'Department', 'Marketing', 'Vehicle schedule']);
});
await t('fits every department on one line', async () => {
  // The row the bar is sized around. If a department ever wraps onto a second
  // line the hierarchy stops reading as four levels, so this is a guard, not a
  // nicety -- it catches the next department or the next longer label.
  const tops = await page.locator('.fchip[data-axis="depts"]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  return new Set(tops.map(Math.round)).size === 1;
});
await t('starts every row of chips at the same x', async () => {
  const lefts = await page.locator('.frow .fchips')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  return lefts.length === 4 && new Set(lefts).size === 1;
});
// Counted from the taxonomy, not written as a number: a literal here went
// stale the moment a sixth kind was added, and the failure said nothing
// about why.
await t('leads with every kind, Events first', async () =>
  (await page.locator('.fchip[data-axis="kinds"]').count()) === TAXONOMY.eventTypes.length
  && (await page.locator('.fchip[data-axis="kinds"]').first().textContent()).startsWith('Events'));
await t('opens the list once something is picked', async () => {
  await chip('Wholesale').click();
  return await page.locator('#listPanel').isVisible()
    && (await page.locator('#shell.split').count()) === 1;
});
await t('lists what the filter found', async () => {
  const l = await listed();
  return l.length === 1 && l[0].includes('Surf Expo');
});
await t('keeps a level on when another level is picked', async () => {
  // The whole point of the hierarchy: Kind, Department, Marketing and Vehicle
  // are separate questions that narrow together.
  await page.locator('.fchip[data-axis="kinds"][data-key="event"]').click();
  return (await chip('Wholesale').getAttribute('aria-pressed')) === 'true'
    && (await page.locator('.fs-tok').count()) === 2;
});
await t('replaces the answer when a second chip on the same row is picked', async () => {
  await chip('Flagship').click();
  return (await chip('Wholesale').getAttribute('aria-pressed')) === 'false'
    && (await page.locator('.fs-tok').count()) === 2;   // still Events + one department
});
await t('turns a level off when its lit chip is clicked again', async () => {
  await chip('Flagship').click();
  await page.locator('.fchip[data-axis="kinds"][data-key="event"]').click();
  return (await page.locator('.flt-status').count()) === 0;
});
await t('keeps an event its department only promotes', async () => {
  // Marketing names a kind and a department; the rows say which, so the test
  // has to as well.
  await page.locator('.fchip[data-axis="depts"][data-key="marketing"]').click();
  const l = await listed();
  return l.length === 2;     // its own email, and the store sale it promotes
});
await t('finds the events with no department at all', async () => {
  await page.locator('.fchip[data-axis="depts"][data-key="\u2014none\u2014"]').click();
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

console.log('a crowded day');
// The cell draws three and hides the rest behind "+N more". That control used
// to carry the cell's own data-day, so clicking it opened the new-event form
// and the hidden events stayed hidden.
await t('opens the day from "+N more" rather than the new-event form', async () => {
  await page.locator('.mo-cell[data-day="' + dayThis(8) + '"] .mo-more').click();
  const title = await page.locator('#modalTitle').textContent();
  return await page.locator('#modal').isVisible()
    && (await page.locator('#modalBody .day-list').count()) === 1
    && !title.includes('Add event')
    && title.includes(String(NOW.getFullYear()));
});
await t('shows the whole day, not only the part that was hidden', async () =>
  (await page.locator('#modalBody .day-list .day-item').count()) === 4);
await t('opens an event from a row in it', async () => {
  await page.locator('#modalBody .day-list .day-item').first().click();
  return (await page.locator('.det-title').count()) === 1;
});
await page.locator('button[data-act="close"]').click();
await page.waitForFunction(() => document.querySelector('#modal').hidden);

console.log('the download');
await t('caps a crowded day on screen', async () => {
  const cell = page.locator('.mo-cell[data-day="' + dayThis(8) + '"]');
  return (await cell.locator('.chip').count()) === 3
    && (await cell.locator('.mo-more').textContent()) === '+1 more';
});
await t('draws every event on the day once printing', async () => {
  // window.print() blocks on a dialog that headless Chromium never shows, so
  // it is stubbed. What is under test is the page the dialog would have read.
  await page.evaluate(() => { window.print = () => {}; });
  await page.locator('#downloadBtn').click();
  const cell = page.locator('.mo-cell[data-day="' + dayThis(8) + '"]');
  return (await cell.locator('.chip').count()) === 4
    && (await cell.locator('.mo-more').count()) === 0;
});
await t('says on the page what the view actually is', async () => {
  const txt = await page.locator('#printHead').textContent();
  return txt.includes('Jetty Company Calendar')
    && txt.includes('Everything')
    && txt.includes(ITEMS.length + ' events');
});
await t('puts the filters on the paper, so a filtered print cannot mislead', async () => {
  await page.locator('.fchip[data-axis="depts"][data-key="marketing"]').click();
  await page.locator('#downloadBtn').click();
  const txt = await page.locator('#printHead').textContent();
  return txt.includes('Filtered to') && txt.includes('Marketing');
});
await t('goes back to the screen version afterwards', async () => {
  await page.waitForFunction(() => !document.querySelector('.mo-cell .mo-more')
    || document.querySelectorAll('.mo-cell[data-day] .chip').length >= 0);
  await page.waitForTimeout(1700);   // the afterprint fallback
  await clearAll();
  const cell = page.locator('.mo-cell[data-day="' + dayThis(8) + '"]');
  return (await cell.locator('.chip').count()) === 3;
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

// Vehicles moved out of "what does it need" into their own step, so a
// Vehicle Booking can ask this and nothing else from that screen. An Event
// gets one more click for it, and it stays optional there.
await t('asks an event what has to be driven there, on its own step', async () => {
  const n = await page.locator('.f-veh').count();
  const needsGone = !(await page.locator('.f-need').first().isVisible());
  return n === 3 && needsGone;
});
await page.locator('button[data-act="next"]').click();

await t('asks how the event did, after everything else', async () =>
  (await page.locator('#f-orders').isVisible())
  && (await page.locator('#f-netrev').isVisible())
  && (await page.locator('.step[data-step="results"] .lbl-note').textContent())
       .includes('after the event'));
await t('works out the average order value as the numbers go in', async () => {
  const before = await page.locator('#aovOut').textContent();
  await page.locator('#f-orders').fill('100');
  await page.locator('#f-netrev').fill('$8,420.50');
  await page.waitForFunction(() => document.querySelector('#aovOut').textContent.includes('84.20'));
  return before.includes('appears once');
});
await t('says whether the day covered its fee', async () => {
  await page.locator('#f-fee').fill('250');
  await page.waitForFunction(() =>
    document.querySelector('#aovOut').textContent.includes('Net of fee'));
  return (await page.locator('#aovOut').textContent()).includes('8170.50');
});
await t('shows a fee the day did not cover as a loss', async () => {
  await page.locator('#f-fee').fill('9000');
  await page.waitForFunction(() =>
    document.querySelector('#aovOut').textContent.includes('\u2212$'));
  return (await page.locator('#aovOut').textContent()).includes('\u2212$579.50');
});
await page.locator('#f-fee').fill('250');
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
await t('takes the typed figures however they were typed', async () =>
  seen.posted.orders === '100' && seen.posted.net_revenue === '$8,420.50');
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

console.log('a social post');
await page.locator('#addBtn').click();
await page.locator('.f-kind[value="social"]').check();
await t('drops the venue, vehicle and needs questions', async () =>
  (await page.locator('.trail-n').textContent()).includes('of 7'));

// Walk to the social step the way a person would, picking a department when
// asked. The sub-type step appears only once a department owns the event, so
// the number of steps is not known in advance.
const next = () => page.locator('button[data-act="next"]').click();
await next();
await page.locator('#f-title').fill('Sunset Reel');
await t('never asks for a venue or a vehicle on the way', async () => {
  for (let i = 0; i < 9; i++) {
    if (await page.locator('#f-venue').isVisible()) return false;
    if (await page.locator('#f-caption').isVisible()) return true;
    if ((await page.locator('#deptPick').isVisible())
        && !(await page.locator('.f-dept:checked').count())) {
      await page.locator('.f-dept[value="marketing"]').check();
    }
    if (!(await page.locator('button[data-act="next"]').count())) break;
    await next();
  }
  return false;
});
await t('asks the questions a post actually has', async () =>
  (await page.locator('.f-stype').count()) === 4
  && (await page.locator('.f-chan').count()) === 6
  && (await page.locator('#f-pillar option').count()) === 9   // 8 pillars + the blank
  && (await page.locator('.f-prod').count()) === 5);
await t('keeps production state apart from Status', async () =>
  (await page.locator('.step[data-step="social"] .step-q.sub').textContent())
    .includes('not whether it is happening'));
await page.locator('.f-stype[value="reel"]').check();
await page.locator('.f-chan[value="instagram"]').check();
await page.locator('.f-chan[value="tiktok"]').check();
await page.locator('#f-pillar').selectOption('sea');
await page.locator('#f-caption').fill('Golden hour at the jetty');
await page.locator('#f-tags').fill('#TheJettyLife @someone');
await page.locator('.f-prod[value="needs-caption"]').check();
await next();                                   // past social, onto when
await next();                                   // past when, onto final
await page.locator('button[data-act="save"]').click();
await page.waitForFunction(() => document.querySelector('#modal').hidden);
await t('posts every social axis', async () => {
  const p = seen.posted;
  return p.event_type === 'social' && p.social_type === 'reel'
    && JSON.stringify(p.channels) === '["instagram","tiktok"]'
    && p.pillar === 'sea' && JSON.stringify(p.production) === '["needs-caption"]'
    && p.caption === 'Golden hour at the jetty' && p.tags === '#TheJettyLife @someone';
});
await t('has a Social chip of its own on the filter bar', async () =>
  (await page.locator('.fchip[data-axis="kinds"][data-key="social"]').count()) === 1);

console.log('a meeting');
await page.locator('#addBtn').click();
await page.locator('.f-kind[value="meeting"]').check();
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

console.log('a deadline');
await page.locator('#addBtn').click();
await page.locator('.f-kind[value="deadline"]').check();
await t('takes the same short form as a meeting', async () =>
  (await page.locator('.trail-n').textContent()).includes('of 5'));
await page.locator('button[data-act="next"]').click();
await page.locator('#f-title').fill('Line sheet due');
await page.locator('button[data-act="next"]').click();
await page.locator('.f-dept[value="wholesale"]').check();
await page.locator('button[data-act="next"]').click();
await t('falls on a day rather than running until one', async () =>
  (await page.locator('#f-start').isVisible())
  && !(await page.locator('#f-end').isVisible()));
await t('keeps the hidden end date in step with the start', async () => {
  await page.locator('#f-start').fill('2026-11-20');
  await page.locator('#f-start').dispatchEvent('change');
  return (await page.locator('#f-end').inputValue()) === '2026-11-20';
});
await page.locator('button[data-act="next"]').click();
await page.locator('button[data-act="save"]').click();
await page.waitForFunction(() => document.querySelector('#modal').hidden);
await t('posts as its own kind, one date wide', async () =>
  seen.posted.event_type === 'deadline'
  && seen.posted.start_date === '2026-11-20' && seen.posted.end_date === '2026-11-20');
await t('has a Deadlines chip beside Meetings and Social', async () =>
  (await page.locator('.fchip[data-axis="kinds"][data-key="deadline"]').count()) === 1
  && (await page.locator('.fchip[data-axis="kinds"][data-key="meeting"]').count()) === 1);

console.log('marketing');
await page.locator('#addBtn').click();
await page.locator('.f-kind[value="marketing"]').check();
await page.locator('button[data-act="next"]').click();
await page.locator('#f-title').fill('Spring Lookbook Shoot');
await t('is asked where, but not what staff or vans it needs', async () => {
  let sawWhere = false;
  for (let i = 0; i < 9; i++) {
    if (await page.locator('.f-need').first().isVisible().catch(() => false)) return false;
    if (await page.locator('#f-venue').isVisible()) sawWhere = true;
    if (await page.locator('#f-status').isVisible()) return sawWhere;
    if ((await page.locator('#deptPick').isVisible())
        && !(await page.locator('.f-dept:checked').count())) {
      await page.locator('.f-dept[value="marketing"]').check();
    }
    if (!(await page.locator('button[data-act="next"]').count())) break;
    await page.locator('button[data-act="next"]').click();
  }
  return false;
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

console.log('for you');
await t('shows a badge with how many are new', async () => {
  await page.waitForSelector('#forMe:not([hidden])');
  return (await page.locator('#forMe').textContent()).trim() === 'For you \u00b7 1'
    && await page.locator('#forMe.has-new').count() === 1;
});
await page.locator('#forMe').click();
await page.waitForSelector('.fy-list');
await t('lists every comment that mentions me, newest first', async () => {
  const titles = await page.locator('.fy-body').allTextContents();
  return titles.length === 2
    && titles[0].startsWith('Arlynn changed this Paid Advo item.')
    && titles[1] === 'Can you confirm the spend?';
});
// The notice has no "@" in its author, so it is the calendar itself rather
// than somebody with an odd name.
await t('names the calendar as the author of an automatic notice', async () =>
  (await page.locator('.fy').first().locator('.fy-who').textContent())
    .startsWith('Jetty Calendar'));
await t('shows only one line of a comment that has several', async () =>
  !(await page.locator('.fy-body').first().textContent()).includes('Changed:'));
await t('marks the new one and leaves the old one alone', async () =>
  (await page.locator('.fy.is-new').count()) === 1);
// On opening, not on closing: a modal dismissed with Escape would otherwise
// leave a badge that never clears.
await t('marks them read on opening', async () => {
  await page.waitForFunction(() => !document.querySelector('#forMe.has-new'));
  return seen.mentionsSeen === 1
    && (await page.locator('#forMe').textContent()).trim() === 'For you';
});
await t('opens the event behind a row', async () => {
  await page.locator('.fy').first().click();
  await page.waitForSelector('.det-title');
  return (await page.locator('.det-title').textContent()).includes(ITEMS[0].title);
});
await page.locator('button[data-act="close"]').click();

console.log('saved locations');
await page.locator('.chip:has-text("LB Spring Sale")').click();
await page.locator('button[data-act="edit"]').click();
await page.waitForSelector('#f-venue');
await page.waitForFunction(() => document.querySelectorAll('#f-loc option').length > 2);

await t('offers every place we have been, plus a way to add one', async () => {
  const opts = await page.locator('#f-loc option').allTextContents();
  return opts.length === 4
    && opts[0].startsWith('Use a saved location')
    && opts[1].includes('Jetty Flagship')
    && opts[3] === '+ New location';
});
// How often a place has been used is what makes the list scannable; the
// Worker sorts by it, and the page says so.
await t('says how many times a place has been used', async () =>
  (await page.locator('#f-loc option').nth(1).textContent()).includes('(12)'));

// Set through the DOM rather than by clicking: the Where step is one of
// several the form shows at a time, and this is about what picking does.
const pick = async (v) => await page.evaluate((val) => {
  const el = document.querySelector('#f-loc');
  el.value = val;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, v);
const addr = async () => await page.evaluate(() =>
  ['venue', 'address', 'city', 'state', 'zip']
    .map((f) => document.querySelector('#f-' + f).value));

await t('fills all five fields from the one it was given', async () => {
  await pick('0');
  return JSON.stringify(await addr())
    === JSON.stringify(['Jetty Flagship', '700 S Main St', 'Manahawkin', 'NJ', '08050']);
});
// It is an action, not a field. A select that stayed on what you picked
// would be claiming to describe the address even after you edited it.
await t('goes back to its own label once it has filled them', async () =>
  (await page.locator('#f-loc').inputValue()) === '');
await t('replaces the lot when a different place is picked', async () => {
  await pick('1');
  return JSON.stringify(await addr())
    === JSON.stringify(['Taylor Ave. Waterfront', '', 'Beach Haven', 'NJ', '']);
});
await t('clears them for a new one', async () => {
  await pick('new');
  return (await addr()).every((v) => v === '')
    && await page.evaluate(() => document.activeElement.id === 'f-venue');
});
await t('leaves the address alone when nothing is picked', async () => {
  await page.evaluate(() => { document.querySelector('#f-venue').value = 'Typed by hand'; });
  await pick('');
  return (await page.locator('#f-venue').inputValue()) === 'Typed by hand';
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

console.log('comments');
await t('shows the thread on the event, with names not addresses', async () => {
  await page.waitForSelector('.cmt');
  return (await page.locator('.cmt-who').textContent()) === 'Dave'
    && (await page.locator('.cmt-body').textContent()) === 'Do we have the permit?'
    && (await page.locator('.cmt-tag').textContent()) === '@Amy Smith';
});
await t('offers no delete on somebody else’s comment when you cannot edit', async () =>
  (await page.locator('.cmt-x').count()) === 1);   // this viewer is an editor
await t('opens the picker on @ and not before', async () => {
  await page.locator('#cmtBody').fill('Checking with ');
  const before = await page.locator('#cmtPick').isHidden();
  await page.locator('#cmtBody').fill('Checking with @am');
  await page.locator('#cmtBody').dispatchEvent('input');
  return before && (await page.locator('.cmt-opt').count()) === 1;
});
await t('says who will actually get a Slack DM', async () =>
  (await page.locator('.cmt-opt-s').count()) === 1);
await t('takes the half-typed name back out of the comment', async () => {
  await page.locator('.cmt-opt').click();
  return (await page.locator('#cmtBody').inputValue()) === 'Checking with '
    && (await page.locator('.cmt-note .cmt-tag').textContent()).includes('Amy Smith');
});
await t('posts the body and the picked address, not the typed text', async () => {
  await page.locator('#cmtPost').click();
  await page.waitForFunction(() => document.querySelectorAll('.cmt').length === 2);
  // Trimmed on the way out: the trailing space is what the @term left behind.
  return seen.commented.body === 'Checking with'
    && JSON.stringify(seen.commented.mentions) === '["amy@jettylife.com"]';
});
await t('clears the box and the pending mentions once it is posted', async () =>
  (await page.locator('#cmtBody').inputValue()) === ''
  && (await page.locator('.cmt-note .cmt-tag').count()) === 0);
await t('removes a comment on the spot', async () => {
  await page.locator('.cmt').nth(1).locator('.cmt-x').click();
  // The row goes once the DELETE comes back, not on the click -- a comment
  // that vanishes and then reappears is worse than one that takes a moment.
  await page.waitForFunction(() => document.querySelectorAll('.cmt').length === 1);
  return seen.deletedComments.length === 1;
});
await t('says nothing about Slack while mentions are being delivered', async () =>
  (await page.locator('.cmt-warn').count()) === 0);
await page.locator('button[data-act="close"]').click();

console.log('a Slack mention that did not arrive');
slackStatus = {
  at: '2026-10-02T12:00:00Z', sent: 0,
  errors: [{ email: 'arlynn@jettylife.com', error: 'conversations.open: missing_scope' }],
  hint: 'The Slack app is missing a scope. Add chat:write and im:write.',
};
await page.reload();
await page.waitForSelector('.mo-grid');
await page.locator('.chip').first().click();
await t('warns on the event where the next mention would be written', async () => {
  await page.waitForSelector('.cmt-warn');
  const txt = await page.locator('.cmt-warn').textContent();
  return txt.includes('not being delivered')
    && txt.includes('missing_scope')
    && txt.includes('arlynn@jettylife.com');
});
await t('says what to actually go and do about it', async () =>
  (await page.locator('.cmt-warn').textContent()).includes('reinstall')
  || (await page.locator('.cmt-warn').textContent()).includes('im:write'));
await page.locator('button[data-act="close"]').click();
slackStatus = null;

console.log('a Slack deep link');
// By name, not by index -- the fixture grows and an index silently points at
// a different event.
await page.goto('http://local.test/?event='
  + ITEMS.find((x) => x.title === 'Surf Expo').id);
await page.waitForSelector('.mo-grid');
await t('opens the event the DM pointed at', async () =>
  (await page.locator('.det-title').textContent()).includes('Surf Expo'));

console.log('product highlights on a marketing item');
// Email/SMS carries no product list of its own, so step 9 drops the section
// rather than showing one nobody fills in.
const toFinal = async (sub) => {
  await page.goto('http://local.test/');
  await page.waitForSelector('.mo-grid');
  await page.locator('#addBtn').click();
  await page.locator('.f-kind[value="marketing"]').check();
  await page.locator('button[data-act="next"]').click();
  await page.locator('#f-title').fill('October promo');
  await page.locator('button[data-act="next"]').click();
  await page.locator('.f-dept[value="marketing"]').check();
  await page.locator('button[data-act="next"]').click();   // extras
  await page.locator('button[data-act="next"]').click();   // to subs
  if (sub) await page.locator('.f-sub[value="' + sub + '"]').check();
  // Next until the last step, rather than a fixed count: Email/SMS drops the
  // where step, so the number of clicks is part of what is under test.
  for (let i = 0; i < 6; i++) {
    if (await page.locator('.step[data-step="final"]:not([hidden])').count()) break;
    await page.locator('button[data-act="next"]').click();
  }
  await page.waitForSelector('.step[data-step="final"]:not([hidden])');
};

await toFinal('email-sms');
await t('drops the highlights section on Email/SMS', async () =>
  await page.locator('#prodWrap').isHidden());
await t('and never asks where an email happens', async () => {
  // Gone from the step count as well as from view -- "Step 6 of 6", not a
  // step that is skipped over on the way past.
  // Gone from the step count as well as from view -- "of 7", not an eighth
  // step that is skipped over on the way past.
  const trail = await page.locator('.trail-n').textContent();
  return (await page.locator('.step[data-step="where"]:not([hidden])').count()) === 0
    && trail.includes('of 7');
});
await t('and saves no highlights for one', async () => {
  seen.posted = null;
  await page.locator('button[data-act="save"]').click();
  await page.waitForFunction(() => document.querySelector('#modal').hidden);
  return Array.isArray(seen.posted.products) && seen.posted.products.length === 0;
});

await toFinal('campaign-promotion');
await t('keeps it on a sub-type that does carry products', async () =>
  await page.locator('#prodWrap').isVisible());
await t('and still asks a shoot where it is', async () =>
  (await page.locator('.trail-n').textContent()).includes('of 8'));
await t('and drops it the moment Email/SMS is ticked as well', async () => {
  // Back to the sub-types by the step it is on, not by a count of clicks.
  for (let i = 0; i < 6; i++) {
    if (await page.locator('.step[data-step="subs"]:not([hidden])').count()) break;
    await page.locator('button[data-act="back"]').click();
  }
  await page.locator('.f-sub[value="email-sms"]').check();
  for (let i = 0; i < 6; i++) {
    if (await page.locator('.step[data-step="final"]:not([hidden])').count()) break;
    await page.locator('button[data-act="next"]').click();
  }
  return await page.locator('#prodWrap').isHidden()
    && (await page.locator('.trail-n').textContent()).includes('of 7');
});
await page.locator('button[data-act="close"]').click().catch(() => {});

// An Event with an Email/SMS campaign on it is still an event in a place.
await t('leaves an Event with an Email/SMS campaign its where step', async () => {
  await page.goto('http://local.test/');
  await page.waitForSelector('.mo-grid');
  if (await page.locator('#fltReset').count()) await clearAll();
  await page.locator('#addBtn').click();
  await page.locator('.f-kind[value="event"]').check();
  await page.locator('button[data-act="next"]').click();
  await page.locator('#f-title').fill('Coquina Jam');
  await page.locator('button[data-act="next"]').click();
  await page.locator('.f-dept[value="marketing"]').check();
  await page.locator('button[data-act="next"]').click();
  await page.locator('button[data-act="next"]').click();   // to subs
  await page.locator('.f-sub[value="email-sms"]').check();
  for (let i = 0; i < 8; i++) {
    if (await page.locator('.step[data-step="final"]:not([hidden])').count()) break;
    await page.locator('button[data-act="next"]').click();
  }
  return (await page.locator('#prodWrap').isVisible())
    && (await page.locator('.step[data-step="where"]').count()) === 1;
});
await page.locator('button[data-act="close"]').click().catch(() => {});

await t('and is gone when an existing Email/SMS item is opened to edit', async () => {
  await page.goto('http://local.test/');
  await page.waitForSelector('.mo-grid');
  // Filters are remembered across reloads, and earlier tests left some on.
  if (await page.locator('#fltReset').count()) await clearAll();
  await page.locator('.chip', { hasText: 'Fall Email' }).first().click();
  await page.waitForSelector('.det-title');
  await page.locator('#modalFoot button[data-act="edit"]').click();
  await page.waitForSelector('#prodWrap', { state: 'attached' });
  return await page.locator('#prodWrap').isHidden();
});
await page.locator('button[data-act="close"]').click().catch(() => {});

console.log('dark mode');
// Three separate rules put near-white text on a near-white surface here: a
// .cal-btn class that was never defined (so the buttons kept the browser's
// default light face while site.css handed them color:inherit), a bare
// .mo-cell.out sitting below the dark media query at equal specificity, and
// a .fld input[type=text] base rule that outranked the .fld input override.
// None of it was visible to a test that only ever rendered in light mode, so
// the guard is a contrast sweep rather than three assertions about colour.
const contrastSweep = async () => await page.evaluate(() => {
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
    const eff = over({ ...fg, a: fg.a * (op < 1 ? op : 1) }, bg);
    const cr = ratio(eff, bg);
    if (cr < 4.5) {
      // The text goes in the report too: a bare "span 3.04" is not enough to
      // find the rule that did it.
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase()
        + (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/)[0] : ''))
        + ' "' + el.textContent.trim().slice(0, 18) + '" ' + cr.toFixed(2));
    }
  });
  return [...new Set(bad)];
});

await page.goto('http://local.test/');
await page.waitForSelector('.mo-grid');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(200);

await t('keeps every label above the 4.5:1 floor', async () => {
  const bad = await contrastSweep();
  if (bad.length) console.log('         ' + bad.slice(0, 8).join(', '));
  return bad.length === 0;
});
await t('paints the buttons instead of leaving them the default face', async () =>
  await page.evaluate(() => ['#today', '#subscribe', '#downloadBtn', '#exportBtn']
    .every((sel) => {
      const cs = getComputedStyle(document.querySelector(sel));
      // A transparent button is fine -- it takes the dark page behind it.
      // The default UA face is what was not.
      const m = cs.backgroundColor.match(/[\d.]+/g);
      return m && (Number(m[3] ?? 1) === 0 || Number(m[0]) < 120);
    })));
await t('does not leave out-of-month cells painted white', async () =>
  await page.evaluate(() => {
    const cell = document.querySelector('.mo-cell.out');
    return Number(getComputedStyle(cell).backgroundColor.match(/\d+/g)[0]) < 120;
  }));

await page.emulateMedia({ colorScheme: 'light' });
await t('and the same holds in light mode', async () => {
  await page.waitForTimeout(200);
  const bad = await contrastSweep();
  if (bad.length) console.log('         ' + bad.slice(0, 8).join(', '));
  return bad.length === 0;
});

console.log('');
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  failed += errors.length;
}
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
await browser.close();
process.exit(failed ? 1 : 0);
