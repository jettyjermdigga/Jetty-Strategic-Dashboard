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
import { planMigration, mergeSubTypes, mergeFeedFilters, promoteSocial, splitKind,
         SUB_TYPE_MERGES } from '../worker/migrate.js';
import { normaliseProducts, readProducts, MAX_PRODUCTS } from '../worker/products.js';
import { commentMessage, displayName, dmMentions, escapeSlack, eventUrl, eventWhen,
         slackHint } from '../worker/slack.js';
import { buildIcs } from '../worker/ics.js';
import { retailWeek, retailWeekStart } from '../worker/retail.js';
import {
  DEPARTMENTS, DEPARTMENT_KEYS, DIVISIONS, EVENT_TYPE_KEYS, SUB_TYPES, NEEDS, VEHICLES,
  STATUSES, PRIMACY, RETAIL_EPOCH, SOCIAL_TYPES, CHANNELS, PILLARS, PRODUCTION,
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
       ['event', 'box-truck', null]);
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
    eq([p.event_type, p.department], ['meeting', null]);
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
    eq(planMigration({ event_types: 'marketing', sub_types: 'email,sms' }).sub_types, 'email-sms');
    eq(planMigration({ event_types: 'marketing', sub_types: 'campaign,promotion' }).sub_types,
       'campaign-promotion');
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

describe('merging the sub-types that said the same thing', () => {
  it('folds either half of a pair onto one key', () => {
    eq(mergeSubTypes('email'), 'email-sms');
    eq(mergeSubTypes('sms'), 'email-sms');
    eq(mergeSubTypes('campaign'), 'campaign-promotion');
    eq(mergeSubTypes('promotion'), 'campaign-promotion');
  });
  it('does not leave two copies on an item that had both', () => {
    eq(mergeSubTypes('email,sms'), 'email-sms');
    eq(mergeSubTypes('campaign,promotion'), 'campaign-promotion');
  });
  it('folds both pairs on one item', () => {
    eq(mergeSubTypes('campaign,email,promotion,sms'), 'campaign-promotion,email-sms');
  });
  it('leaves the other sub-types alone, in order', () => {
    eq(mergeSubTypes('social,sms,website'), 'social,email-sms,website');
  });
  it('is idempotent, so a second run changes nothing', () => {
    const once = mergeSubTypes('email,sms,campaign,promotion');
    eq(mergeSubTypes(once), once);
    eq(mergeSubTypes('email-sms'), 'email-sms');
    eq(mergeSubTypes('campaign-promotion'), 'campaign-promotion');
  });
  it('gives null for an item with no sub-type', () => {
    eq(mergeSubTypes(''), null);
    eq(mergeSubTypes(null), null);
  });
  it('only ever produces keys the taxonomy knows', () => {
    const keys = SUB_TYPES.map((s) => s.key);
    for (const merged of Object.values(SUB_TYPE_MERGES)) {
      ok(keys.includes(merged), merged + ' is not a real sub-type');
    }
  });

  it('rewrites a calendar sync that asked for the old keys', () => {
    eq(mergeFeedFilters('{"sub":["email","sms"],"dept":["marketing"]}'),
       '{"sub":["email-sms"],"dept":["marketing"]}');
    eq(mergeFeedFilters('{"sub":["campaign","promotion"]}'),
       '{"sub":["campaign-promotion"]}');
  });
  it('leaves a sync that never mentioned them untouched', () => {
    eq(mergeFeedFilters('{"sub":["tradeshow"]}'), null);
    eq(mergeFeedFilters('{"dept":["jrf"]}'), null);
    eq(mergeFeedFilters(''), null);
  });
  it('survives a filters column that is not JSON', () => {
    eq(mergeFeedFilters('not json at all'), null);
  });
});

describe('product highlights', () => {
  const row = (o) => Object.assign({ id: 'r1', division: 'mens' }, o);

  it('keeps a row down to its division', () => {
    const r = normaliseProducts([row({})]);
    eq(r.errors, []);
    eq(readProducts(r.products), [{ id: 'r1', division: 'mens', category: '', sku: '', url: '' }]);
  });
  it('carries the category, SKU and link through', () => {
    const r = normaliseProducts([row({
      category: 'Boardshorts', sku: 'JM-1234', url: 'https://jettylife.com/collections/boardshorts' })]);
    eq(readProducts(r.products)[0].sku, 'JM-1234');
    eq(readProducts(r.products)[0].url, 'https://jettylife.com/collections/boardshorts');
  });
  it('takes JSON as readily as a list, because that is what the column holds', () => {
    eq(normaliseProducts(JSON.stringify([row({})])).products, normaliseProducts([row({})]).products);
  });
  it('stores nothing for an event with no highlights', () => {
    eq(normaliseProducts(null).products, null);
    eq(normaliseProducts([]).products, null);
  });
  it('drops a row that was started and abandoned', () => {
    const r = normaliseProducts([{ id: 'r1', division: '', category: '', sku: '', url: '' }]);
    eq(r.errors, []);
    eq(r.products, null);
  });
  it('refuses a row with a category but no division', () => {
    const r = normaliseProducts([{ id: 'r1', division: '', category: 'Tees' }]);
    ok(r.errors.length === 1 && r.errors[0].includes('pick a division'));
    eq(r.products, null);
  });
  it('refuses a division the taxonomy does not have', () => {
    ok(normaliseProducts([row({ division: 'pets' })]).errors[0].includes('unknown division'));
  });
  it('refuses a link that is not http', () => {
    ok(normaliseProducts([row({ url: 'javascript:alert(1)' })]).errors[0].includes('http://'));
    ok(normaliseProducts([row({ url: '/collections/tees' })]).errors.length === 1);
  });
  it('refuses a row id that could not be an object key', () => {
    ok(normaliseProducts([row({ id: '../../etc' })]).errors[0].includes('bad row id'));
    ok(normaliseProducts([row({ id: '' })]).errors.length === 1);
  });
  it('refuses two rows claiming the same id', () => {
    ok(normaliseProducts([row({}), row({ category: 'Tees' })]).errors[0].includes('duplicate'));
  });
  it('caps how many one event can carry', () => {
    const many = [];
    for (let i = 0; i <= MAX_PRODUCTS; i++) many.push({ id: 'r' + i, division: 'mens' });
    ok(normaliseProducts(many).errors[0].includes(String(MAX_PRODUCTS)));
  });
  it('writes nothing at all when any row is wrong', () => {
    const r = normaliseProducts([row({ category: 'Tees' }), { id: 'r2', division: 'pets' }]);
    eq(r.products, null);
  });
  it('survives a column holding something that is not JSON', () => {
    eq(readProducts('not json'), []);
    eq(readProducts('{"a":1}'), []);
    eq(readProducts(null), []);
    eq(normaliseProducts('not json').errors.length, 1);
  });
  it('names the four divisions the line is cut by', () => {
    eq(DIVISIONS.map((d) => d.key), ['mens', 'womens', 'yti', 'accessories']);
  });
});

describe('a Slack delivery that fails', () => {
  const withFetch = async (handler, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = handler;
    try { return await fn(); } finally { globalThis.fetch = real; }
  };
  const replies = (...bodies) => {
    let i = 0;
    return async () => ({ json: async () => bodies[Math.min(i++, bodies.length - 1)] });
  };

  it('reports the Slack error rather than swallowing it', async () => {
    const r = await withFetch(replies({ ok: false, error: 'missing_scope' }), () =>
      dmMentions('x', [{ email: 'a@b.com', slack_id: 'U1' }], 'hi'));
    eq(r.sent, 0);
    ok(r.errors[0].error.includes('missing_scope'));
    ok(r.errors[0].email === 'a@b.com');
  });
  it('counts a delivery that worked', async () => {
    const r = await withFetch(replies({ ok: true, channel: { id: 'D1' } }, { ok: true }), () =>
      dmMentions('x', [{ email: 'a@b.com', slack_id: 'U1' }], 'hi'));
    eq([r.sent, r.errors.length], [1, 0]);
  });
  it('does not let one bad recipient stop the rest', async () => {
    let n = 0;
    const handler = async () => {
      n++;
      // First recipient's conversations.open fails; the second succeeds.
      if (n === 1) return { json: async () => ({ ok: false, error: 'user_not_found' }) };
      return { json: async () => ({ ok: true, channel: { id: 'D1' } }) };
    };
    const r = await withFetch(handler, () => dmMentions('x', [
      { email: 'bad@b.com', slack_id: 'U1' },
      { email: 'good@b.com', slack_id: 'U2' },
    ], 'hi'));
    eq([r.sent, r.errors.length], [1, 1]);
  });
  it('calls out a mention of somebody with no Slack account', async () => {
    const r = await dmMentions('x', [{ email: 'a@b.com', slack_id: null }], 'hi');
    eq(r.sent, 0);
    ok(r.errors[0].error.includes('no Slack account'));
  });

  it('turns Slack\u2019s error into the thing to go and do', () => {
    ok(slackHint('conversations.open: missing_scope').includes('reinstall'));
    ok(slackHint('chat.postMessage: invalid_auth').includes('SLACK_BOT_TOKEN'));
    ok(slackHint('no Slack account for that address').includes('Slack email'));
    eq(slackHint('something nobody has seen before'), '');
  });
});

describe('the Slack mention', () => {
  const ev = { title: 'Coquina Jam', start_date: '2026-07-11', end_date: '2026-07-11', all_day: 1 };

  it('escapes what Slack reads as markup', () => {
    eq(escapeSlack('A < B & C > D'), 'A &lt; B &amp; C &gt; D');
  });
  it('escapes the event title and the comment, not just one of them', () => {
    const msg = commentMessage({ authorName: 'Jeremy', body: '1 < 2',
                                 item: { ...ev, title: '<Jam>' }, url: '' });
    ok(msg.includes('&lt;Jam&gt;') && msg.includes('1 &lt; 2'));
  });
  it('quotes the comment so it cannot read as a command or another mention', () => {
    const msg = commentMessage({ authorName: 'Jeremy', body: '/remind @channel', item: ev, url: '' });
    ok(msg.includes('> /remind @channel'));
    ok(!/\n\/remind/.test(msg));
  });
  it('quotes every line of a multi-line comment', () => {
    const msg = commentMessage({ authorName: 'A', body: 'one\ntwo\nthree', item: ev, url: '' });
    eq(msg.split('\n').filter((l) => l.startsWith('> ')).length, 3);
  });
  it('links back to the event when there is somewhere to link', () => {
    ok(commentMessage({ authorName: 'A', body: 'x', item: ev, url: 'https://c/?event=7' })
      .includes('<https://c/?event=7|Open it'));
    ok(!commentMessage({ authorName: 'A', body: 'x', item: ev, url: '' }).includes('Open it'));
  });
  it('builds the deep link off the origin it was asked on', () => {
    eq(eventUrl('https://calendar.test', 'abc'), 'https://calendar.test/?event=abc');
    eq(eventUrl('https://calendar.test/', 'abc'), 'https://calendar.test/?event=abc');
    eq(eventUrl('', 'abc'), '');
  });

  it('says when, one day or several, timed or not', () => {
    eq(eventWhen(ev), '2026-07-11');
    eq(eventWhen({ ...ev, end_date: '2026-07-13' }), '2026-07-11 – 2026-07-13');
    eq(eventWhen({ ...ev, all_day: 0, start_time: '12:00' }), '2026-07-11 at 12:00');
  });

  it('makes a name out of an address when the roster has none', () => {
    eq(displayName('amy.smith@jettylife.com', ''), 'Amy Smith');
    eq(displayName('joem@jettylife.com', ''), 'Joem');
    eq(displayName('x@y.com', 'Real Name'), 'Real Name');
    eq(displayName('', ''), 'Someone');
  });
});

describe('social becoming its own kind', () => {
  it('moves a row off the sub-type and onto the event type', () => {
    eq(promoteSocial({ sub_types: 'social' }), { event_type: 'social', sub_types: null });
  });
  it('keeps the sub-types that still mean something', () => {
    eq(promoteSocial({ sub_types: 'social,collab' }),
       { event_type: 'social', sub_types: 'collab' });
  });
  it('leaves a row that was never social alone', () => {
    eq(promoteSocial({ sub_types: 'collab' }), null);
    eq(promoteSocial({ sub_types: '' }), null);
    eq(promoteSocial({}), null);
  });
  it('is idempotent -- a row that already moved is not selected again', () => {
    const once = promoteSocial({ sub_types: 'social,collab' });
    eq(promoteSocial({ sub_types: once.sub_types }), null);
  });
  it('is no longer offered as a Marketing sub-type', () => {
    ok(!SUB_TYPES.some((s) => s.key === 'social'));
  });
});

describe('splitting Event from Marketing', () => {
  const old = (o) => Object.assign({ event_type: 'events-marketing' }, o);

  it('calls anything with a place an Event, whatever else it carries', () => {
    eq(splitKind(old({ venue: 'Dock Road', sub_types: 'photo-video' })), 'event');
    eq(splitKind(old({ address: '1 Main St' })), 'event');
    eq(splitKind(old({ city: 'Beach Haven' })), 'event');
  });
  it('calls a placeless item with a Marketing sub-type Marketing', () => {
    eq(splitKind(old({ sub_types: 'email-sms' })), 'marketing');
    eq(splitKind(old({ sub_types: 'campaign-promotion,collab' })), 'marketing');
  });
  it('falls back to Event, which asks more rather than less', () => {
    eq(splitKind(old({})), 'event');
    eq(splitKind(old({ sub_types: 'tradeshow' })), 'event');
  });
  it('sends every old meeting to Meeting and guesses no deadlines', () => {
    eq(splitKind({ event_type: 'meetings-deadlines' }), 'meeting');
  });
  it('leaves a kind that was already split alone', () => {
    eq(splitKind({ event_type: 'social' }), null);
    eq(splitKind({ event_type: 'marketing' }), null);
    eq(splitKind({ event_type: '' }), null);
  });
  it('is idempotent -- what it returns is not selected again', () => {
    eq(splitKind({ event_type: splitKind(old({ sub_types: 'email-sms' })) }), null);
  });
});

describe('the social axes', () => {
  it('offers the four shapes a post takes', () => {
    eq(SOCIAL_TYPES.map((x) => x.key), ['post', 'carousel', 'story', 'reel']);
  });
  it('offers every channel, Blog included', () => {
    eq(CHANNELS.map((x) => x.key),
       ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'blog']);
  });
  it('carries the pillars the MKG Comms sheet already used', () => {
    for (const want of ['COMMUNITY', 'BUZZ', 'ENVIRONMENT', 'SEA', 'LAND', 'EVERYTHING ELSE']) {
      ok(PILLARS.some((p) => (p.sheetValues || []).includes(want)), want + ' has nowhere to land');
    }
  });
  it('keeps production state apart from whether it is happening', () => {
    for (const p of PRODUCTION) ok(!STATUSES.includes(p.label), p.label + ' collides with a status');
  });
  it('gives every axis unique keys', () => {
    for (const list of [SOCIAL_TYPES, CHANNELS, PILLARS, PRODUCTION]) {
      eq(new Set(list.map((x) => x.key)).size, list.length);
    }
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
  it('keeps the five Event Types the form branches on', () => {
    eq([...EVENT_TYPE_KEYS].sort(),
       ['deadline', 'event', 'marketing', 'meeting', 'social']);
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
