// Unit tests. No browser, no network, no dependencies -- `node tests/unit.mjs`
// runs anywhere Node does, which is why the deploy workflow gates on these and
// not on the browser suite.
//
// What is here is what has actually broken: a semicolon in a schema comment
// that took the calendar down, a migration that could undo a later edit, a
// palette that has to stay validated, and the retail week the whole business
// plans against.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = (p) => path.join(HERE, '..', p);

import { sqlStatements } from '../worker/sql.js';
import { planMigration } from '../worker/migrate.js';
import { buildIcs } from '../worker/ics.js';
import { retailWeek, retailWeekStart } from '../worker/retail.js';
import {
  DEPARTMENTS, DEPARTMENT_KEYS, EVENT_TYPE_KEYS, SUB_TYPES, NEEDS, VEHICLES,
  STATUSES, PRIMACY, RETAIL_EPOCH,
} from '../worker/taxonomy.js';

let failed = 0;
let ran = 0;
const groups = [];
let group = null;

function describe(name, fn) { groups.push([name, fn]); }
function it(name, fn) { group.push({ name, fn }); }
function eq(got, want, what) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) throw new Error((what ? what + ': ' : '') + 'got ' + g + ', want ' + w);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }

// ── the schema loader ────────────────────────────────────────────────────

describe('sqlStatements', () => {
  it('splits plain statements', () => {
    eq(sqlStatements('CREATE TABLE a (x TEXT);\nCREATE INDEX i ON a(x);').length, 2);
  });
  it('does not split on a semicolon inside a comment', () => {
    // The bug that took the calendar down: a ";" in a column comment cut the
    // CREATE TABLE in half and D1 answered "incomplete input".
    eq(sqlStatements('CREATE TABLE a (\n  x TEXT   -- one; two\n);').length, 1);
  });
  it('does not split on a semicolon inside a string', () => {
    eq(sqlStatements("INSERT INTO a VALUES ('one; two');").length, 1);
  });
  it('handles an escaped quote', () => {
    eq(sqlStatements("INSERT INTO a VALUES ('it''s; fine');\nSELECT 1;").length, 2);
  });
  it('never returns a comment as a statement', () => {
    eq(sqlStatements('-- just a note\n-- and another').length, 0);
    eq(sqlStatements('CREATE TABLE a (x TEXT);\n-- trailing').length, 1);
  });
  it('leaves every statement in the real schema complete and balanced', () => {
    const st = sqlStatements(fs.readFileSync(root('worker/schema.sql'), 'utf8'));
    ok(st.length > 0, 'schema produced no statements');
    for (const s of st) {
      ok(/^CREATE/i.test(s), 'not a CREATE: ' + s.slice(0, 40));
      eq((s.match(/\(/g) || []).length, (s.match(/\)/g) || []).length, 'unbalanced parens');
    }
  });
});

// ── the one-time migration ───────────────────────────────────────────────

describe('planMigration', () => {
  it('keeps a single department', () => {
    const p = planMigration({ event_types: 'box-truck-events' });
    eq([p.event_type, p.department, p.departments],
       ['events-marketing', 'box-truck', null]);
  });
  it('leaves a store sale with the store, not with Marketing', () => {
    const p = planMigration({ event_types: 'long-branch-store,marketing' });
    eq([p.department, p.departments], ['long-branch-store', 'marketing']);
  });
  it('reads Coquina Jam as JRF with the Box Truck along', () => {
    eq(planMigration({ event_types: 'box-truck-events,jrf' }).department, 'jrf');
  });
  it('turns a meeting into an Event Type, not a department', () => {
    const p = planMigration({ event_types: 'meetings' });
    eq([p.event_type, p.department], ['meetings-deadlines', null]);
  });
  it('renames prodev', () => {
    eq(planMigration({ event_types: 'prodev' }).department, 'product-development');
  });
  it('lifts the two vehicles out of needs and drops the retired ones', () => {
    const p = planMigration({
      event_types: 'box-truck-events',
      needs: 'jetty-brewing,box-truck-rig,setup-10x20,insurance,van',
    });
    eq([p.needs, p.vehicles], [null, 'box-truck,ink-van']);
  });
  it('keeps the needs that survived', () => {
    eq(planMigration({ event_types: 'jrf', needs: 'social-permit,sound,drifting-buoy' }).needs,
       'social-permit,sound');
  });
  it('drops the retired sub-types and keeps the rest', () => {
    eq(planMigration({ event_types: 'jrf', sub_types: 'event,meeting,blog-post,seasonal' }).sub_types,
       null);
    eq(planMigration({ event_types: 'marketing', sub_types: 'email,sms' }).sub_types, 'email,sms');
  });
  it('flags a primary it had to guess', () => {
    eq(planMigration({ event_types: 'jrf' }).guessedPrimary, false);
    eq(planMigration({ event_types: 'jrf,marketing' }).guessedPrimary, true);
  });
  it('is pure, so running it twice gives the same answer', () => {
    const row = { event_types: 'wholesale,jetty-ink,marketing', sub_types: 'tradeshow' };
    eq(planMigration(row), planMigration(row));
  });
});

// ── the taxonomy ─────────────────────────────────────────────────────────

describe('taxonomy', () => {
  it('has a unique key for everything', () => {
    for (const [name, list] of [['departments', DEPARTMENTS], ['sub-types', SUB_TYPES],
                                ['needs', NEEDS], ['vehicles', VEHICLES]]) {
      const keys = list.map((x) => x.key);
      eq(new Set(keys).size, keys.length, name + ' has a duplicate key');
    }
  });
  it('gives every department its own colour in both modes', () => {
    const light = DEPARTMENTS.map((d) => d.color);
    eq(new Set(light).size, light.length, 'two departments share a light colour');
    for (const d of DEPARTMENTS) {
      ok(/^#[0-9a-f]{6}$/i.test(d.color), d.key + ' has no valid colour');
      ok(/^#[0-9a-f]{6}$/i.test(d.colorDark || d.color), d.key + ' has no valid dark colour');
    }
  });
  it('lists every department in PRIMACY, and nothing else', () => {
    eq([...PRIMACY].sort(), [...DEPARTMENT_KEYS].sort());
  });
  it('scopes every sub-type to a department that exists', () => {
    for (const s of SUB_TYPES) {
      ok(DEPARTMENT_KEYS.includes(s.department), s.key + ' names an unknown department');
    }
  });
  it('leaves needs unscoped', () => {
    // They were scoped once, and a Flagship event could not record one at all.
    for (const n of NEEDS) ok(!n.department, n.key + ' is scoped again');
  });
  it('keeps the two Event Types the form branches on', () => {
    eq([...EVENT_TYPE_KEYS].sort(), ['events-marketing', 'meetings-deadlines']);
  });
  it('keeps Cancelled, which the ICS feed and the strikethrough rely on', () => {
    eq(STATUSES, ['Booked', 'Pending', 'Cancelled']);
  });
});

// ── the retail calendar ──────────────────────────────────────────────────

describe('retailWeek', () => {
  it('starts 2026 on the epoch', () => {
    const r = retailWeek(RETAIL_EPOCH);
    eq([r.year, r.week, r.start], [2026, 1, RETAIL_EPOCH]);
  });
  it('runs Sunday to Saturday', () => {
    const r = retailWeek('2026-01-07');       // a Wednesday
    eq([r.week, r.start, r.end], [1, '2026-01-04', '2026-01-10']);
  });
  it('rolls to week 2 on the next Sunday', () => {
    eq(retailWeek('2026-01-11').week, 2);
  });
  it('round-trips through retailWeekStart', () => {
    for (const wk of [1, 9, 26, 38, 52]) {
      eq(retailWeek(retailWeekStart(2026, wk)).week, wk, 'week ' + wk);
    }
  });
  it('refuses a week outside the year', () => {
    eq(retailWeekStart(2026, 0), null);
    eq(retailWeekStart(2026, 54), null);
  });
  it('refuses a date it cannot place', () => {
    eq(retailWeek('not-a-date'), null);
  });
});

// ── the Google Calendar feed ─────────────────────────────────────────────

const feedItem = (o) => Object.assign({
  id: 'x', title: 'Coquina Jam', event_type: 'events-marketing', department: 'jrf',
  departments: 'box-truck', sub_types: '', needs: 'sound', staff_count: '',
  vehicles: 'box-truck', status: 'Booked', start_date: '2026-09-26',
  end_date: '2026-09-26', all_day: 1, venue: 'Coquina Beach', city: 'LBI', state: 'NJ',
}, o);

describe('buildIcs', () => {
  const lines = (t) => t.split('\r\n');
  it('uses CRLF throughout, as RFC 5545 requires', () => {
    const out = buildIcs([feedItem()], {});
    ok(!/[^\r]\n/.test(out), 'a bare newline got in');
  });
  it('folds every line to 75 octets', () => {
    const out = buildIcs([feedItem({ notes: 'x'.repeat(400) })], {});
    for (const l of lines(out)) {
      ok(Buffer.byteLength(l) <= 75, 'line too long: ' + l.slice(0, 40));
    }
  });
  it('names the primary department and the others separately', () => {
    const out = buildIcs([feedItem()], {});
    ok(out.includes('Jetty Rock Foundation'), 'primary missing');
    ok(/with Box\s*\r?\n?\s*Truck/.test(out.replace(/\r\n /g, '')), 'others missing');
  });
  it('leaves cancelled events out by default', () => {
    const out = buildIcs([feedItem(), feedItem({ id: 'y', title: 'Gone', status: 'Cancelled' })], {});
    eq((out.match(/BEGIN:VEVENT/g) || []).length, 1);
    ok(!out.includes('Gone'), 'a cancelled event reached the feed');
  });
  it('includes them when asked, marked CANCELLED', () => {
    const out = buildIcs([feedItem({ status: 'Cancelled' })], { includeCancelled: true });
    ok(out.includes('STATUS:CANCELLED'), 'not marked cancelled');
  });
  it('marks anything not booked in the title', () => {
    ok(buildIcs([feedItem({ status: 'Pending' })], {}).includes('[Pending]'));
    ok(!buildIcs([feedItem()], {}).includes('['), 'a booked event got a prefix');
  });
});

// ── the feed Worker ──────────────────────────────────────────────────────
//
// A public endpoint with no Access in front of it: the key is the only thing
// between it and the internet, so what it refuses matters as much as what it
// serves.

const feed = (await import('../feed/index.js')).default;

// A token is 64 hex characters and is looked up, not compared -- so the stub
// answers for one and nothing else.
const TOKEN = 'a'.repeat(64);
const stubDb = {
  prepare: (sql) => ({
    bind: (...args) => ({
      first: async () => (/FROM feeds/.test(sql) && args[0] === TOKEN
        ? { filters: '{"dept":["jrf"]}' } : null),
      all: async () => ({ results: [] }),
    }),
    all: async () => ({ results: [
      feedItem(),
      feedItem({ id: 'b', title: 'Marketing Email', department: 'marketing', departments: '' }),
    ] }),
  }),
};
const call = (path, env, init) =>
  feed.fetch(new Request('https://feed.test' + path, init), env);

describe('feed Worker', () => {
  const env = { DB: stubDb };

  it('serves the feed for a known token', async () => {
    const res = await call('/calendar.ics?token=' + TOKEN, env);
    eq(res.status, 200);
    eq(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
  });
  it('carries only what that person asked for', async () => {
    // The stub's token says dept=jrf; the marketing event must not be in it.
    const body = await (await call('/calendar.ics?token=' + TOKEN, env)).text();
    ok(body.includes('Coquina Jam'), 'the JRF event is missing');
    ok(!body.includes('Marketing Email'), 'an unasked-for event got through');
  });
  it('names the calendar after the selection', async () => {
    const body = await (await call('/calendar.ics?token=' + TOKEN, env)).text();
    ok(/X-WR-CALNAME:.*Jetty Rock Foundation/.test(body.replace(/\r\n /g, '')),
       'the feed is not named after its filter');
  });
  it('404s an unknown token, rather than 403', async () => {
    // A 403 would confirm to a stranger that there is something here.
    eq((await call('/calendar.ics?token=' + 'b'.repeat(64), env)).status, 404);
  });
  it('404s a missing or malformed token', async () => {
    eq((await call('/calendar.ics', env)).status, 404);
    eq((await call('/calendar.ics?token=short', env)).status, 404);
    eq((await call('/calendar.ics?token=' + 'Z'.repeat(64), env)).status, 404);
  });
  it('404s every other path', async () => {
    eq((await call('/', env)).status, 404);
    eq((await call('/api/items?token=' + TOKEN, env)).status, 404);
    eq((await call('/calendar.ics/../api/items?token=' + TOKEN, env)).status, 404);
  });
  it('refuses to write', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      eq((await call('/calendar.ics?token=' + TOKEN, env, { method })).status, 404, method);
    }
  });
  it('says so when the database is not bound', async () => {
    eq((await call('/calendar.ics?token=' + TOKEN, {})).status, 503);
  });
  it('answers HEAD without a body', async () => {
    const res = await call('/calendar.ics?token=' + TOKEN, env, { method: 'HEAD' });
    eq(res.status, 200);
    eq(await res.text(), '');
  });
});

// ── report ───────────────────────────────────────────────────────────────

for (const [name, build] of groups) {
  group = [];
  build();
  console.log(name);
  for (const { name: label, fn } of group) {
    ran++;
    try {
      await fn();                       // some checks are async; most are not
      console.log('  ok   ' + label);
    } catch (err) {
      failed++;
      console.log('  FAIL ' + label + '\n         ' + err.message);
    }
  }
}
console.log('\n' + ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
