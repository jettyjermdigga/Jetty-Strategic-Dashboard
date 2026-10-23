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
import { applyBlanks } from '../worker/blanks.js';
import { commentMessage, displayName, dmMentions, escapeSlack, eventUrl, eventWhen,
         slackHint, watchMessage, changedFields, eventWhere,
         WATCHED_FIELDS } from '../worker/slack.js';
import { rollPlaces, placeKey, placeLabel, hasPlace,
         FIELDS as PLACE_FIELDS } from '../worker/places.js';
import SOCIAL_BACKFILL from '../backfill/social.json' with { type: 'json' };
import { buildIcs } from '../worker/ics.js';
import { retailWeek, retailWeekStart } from '../worker/retail.js';
import {
  DEPARTMENTS, DEPARTMENT_KEYS, DIVISIONS, EVENT_TYPE_KEYS, SUB_TYPES, NEEDS, VEHICLES,
  STATUSES, PRIMACY, RETAIL_EPOCH, SOCIAL_TYPES, CHANNELS, PILLARS, PRODUCTION,
  SUB_TYPE_KEYS, SOCIAL_TYPE_KEYS, CHANNEL_KEYS, PILLAR_KEYS, PRODUCTION_KEYS, PAID_ADVO,
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

// Booking a van is the shortest form on the calendar: which one, whose,
// when. The vehicle is the point, so unlike everywhere else it is required.
describe('vehicle bookings', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');
  const cal = fs.readFileSync(path.join(HERE, '..', 'public', 'assets', 'calendar.js'), 'utf8');

  it('is an event type', () => {
    ok(EVENT_TYPE_KEYS.includes('vehicle'), 'no vehicle event type');
  });
  it('is refused by the server with no vehicle on it', () => {
    ok(/out\.event_type === 'vehicle' && !veh\.length/.test(idx),
       'the server accepts a vehicle booking with no vehicle');
  });
  it('asks six questions, not an Event\'s ten', () => {
    const m = cal.match(/if \(k === 'vehicle'\) return \[([^\]]+)\]/);
    ok(m, 'no vehicle step list');
    const steps = (m[1].match(/'([a-z]+)'/g) || []).map((q) => q.slice(1, -1));
    eq(steps, ['kind', 'title', 'dept', 'vehicle', 'when', 'final']);
  });
  // Both flows share one set of checkboxes. Two would both sit in the DOM
  // and both be collected on save.
  it('renders the vehicle checkboxes exactly once', () => {
    eq((cal.match(/class="f-veh"/g) || []).length, 1);
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
  // Two lists that have to agree: SUB_TYPES says which sub-types are
  // Marketing, and migrate.js keeps its own copy to decide whether a legacy
  // row was a Marketing item. Adding one to the taxonomy and forgetting the
  // other would file it as an Event instead -- silently, and only for old
  // data, which is the kind of drift nobody notices for a year.
  it('agrees with the migration about which sub-types are Marketing', () => {
    const src = fs.readFileSync(path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'migrate.js'), 'utf8');
    const m = src.match(/const MARKETING_SUBS = \[([\s\S]*?)\];/);
    ok(m, 'MARKETING_SUBS not found in migrate.js');
    const inMigration = (m[1].match(/'([a-z0-9-]+)'/g) || []).map((q) => q.slice(1, -1));
    const inTaxonomy = SUB_TYPES.filter((s) => s.department === 'marketing').map((s) => s.key);
    eq([...inMigration].sort(), [...inTaxonomy].sort());
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

// The backfill goes into the database without passing through normalise(), so
// what the build script produced is checked here instead. A bad key would be
// stored and then fail to render, which is a much worse way to find out.
describe('the MKG Comms social backfill', () => {
  const keys = (list) => list.map((x) => x.key);
  const split = (v) => (v ? String(v).split(',').filter(Boolean) : []);

  it('is a non-empty list', () => {
    ok(Array.isArray(SOCIAL_BACKFILL) && SOCIAL_BACKFILL.length > 0);
  });
  it('gives every row its own id', () => {
    const ids = SOCIAL_BACKFILL.map((r) => r.id);
    eq(new Set(ids).size, ids.length, 'two rows share an id');
    for (const id of ids) ok(/^[0-9a-f-]{36}$/.test(id), id + ' is not a uuid');
  });
  it('gives every row the things the table will not take null for', () => {
    for (const r of SOCIAL_BACKFILL) {
      ok(r.title && r.title.length <= 200, 'bad title: ' + JSON.stringify(r.title));
      ok(/^\d{4}-\d{2}-\d{2}$/.test(r.start_date), 'bad start: ' + r.start_date);
      ok(/^\d{4}-\d{2}-\d{2}$/.test(r.end_date), 'bad end: ' + r.end_date);
      ok(STATUSES.includes(r.status), 'bad status: ' + r.status);
      eq(r.event_type, 'social');
    }
  });
  it('is all 2026 or later, as asked', () => {
    for (const r of SOCIAL_BACKFILL) ok(r.start_date >= '2026-01-01', r.start_date);
  });
  it('uses only keys the taxonomy knows', () => {
    for (const r of SOCIAL_BACKFILL) {
      if (r.department) ok(DEPARTMENT_KEYS.includes(r.department), 'dept ' + r.department);
      for (const d of split(r.departments)) ok(DEPARTMENT_KEYS.includes(d), 'dept ' + d);
      for (const k of split(r.sub_types)) ok(SUB_TYPE_KEYS.includes(k), 'sub-type ' + k);
      if (r.social_type) ok(SOCIAL_TYPE_KEYS.includes(r.social_type), 'shape ' + r.social_type);
      for (const k of split(r.channels)) ok(CHANNEL_KEYS.includes(k), 'channel ' + k);
      if (r.pillar) ok(PILLAR_KEYS.includes(r.pillar), 'pillar ' + r.pillar);
      for (const k of split(r.production)) ok(PRODUCTION_KEYS.includes(k), 'production ' + k);
    }
  });
  it('never repeats the primary department among the others', () => {
    for (const r of SOCIAL_BACKFILL) {
      ok(!split(r.departments).includes(r.department), r.title + ' repeats its primary');
    }
  });
  it('gives a timed post a time and an all-day one none', () => {
    for (const r of SOCIAL_BACKFILL) {
      if (r.all_day) ok(!r.start_time, r.title + ' is all day with a time');
      else ok(/^\d{2}:\d{2}$/.test(r.start_time || ''), r.title + ' is timed with no time');
    }
  });
  it('ends on the day it starts -- a post is not a span', () => {
    for (const r of SOCIAL_BACKFILL) eq(r.end_date, r.start_date);
  });
  // Unused here, but the suite should fail if the lists stop lining up.
  it('matches the taxonomy lists it was built against', () => {
    eq(keys(SOCIAL_TYPES), SOCIAL_TYPE_KEYS);
    eq(keys(CHANNELS), CHANNEL_KEYS);
    eq(keys(PILLARS), PILLAR_KEYS);
    eq(keys(PRODUCTION), PRODUCTION_KEYS);
  });
});

// Orders and net revenue are typed by a person off a sales report, so the
// parsing is where this either works or quietly stores the wrong number.
describe('reported figures', () => {
  // Mirrors worker/index.js. Kept here as a spec: if the two drift, a figure
  // is being accepted or rejected for a reason nobody wrote down.
  const clean = (v, max) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
  };
  const wholeNumber = (v, label, errors) => {
    const raw = clean(v, 20);
    if (raw == null) return null;
    const digits = raw.replace(/[,\s]/g, '');
    if (!/^\d+$/.test(digits)) { errors.push(label + ' must be a whole number.'); return null; }
    return Number(digits);
  };
  const money = (v, label, errors) => {
    const raw = clean(v, 30);
    if (raw == null) return null;
    const n = raw.replace(/[$,\s]/g, '');
    if (!/^-?\d*\.?\d+$/.test(n)) { errors.push(label + ' must be an amount, like 1240.50.'); return null; }
    return Math.round(Number(n) * 100) / 100;
  };
  const num = (fn, v) => { const e = []; return [fn(v, 'x', e), e.length]; };

  it('takes a count however the report wrote it', () => {
    eq(num(wholeNumber, '142'), [142, 0]);
    eq(num(wholeNumber, '1,240'), [1240, 0]);
    eq(num(wholeNumber, ' 1240 '), [1240, 0]);
  });
  it('takes an amount with or without its dollar sign', () => {
    eq(num(money, '8420.50'), [8420.5, 0]);
    eq(num(money, '$8,420.50'), [8420.5, 0]);
    eq(num(money, '.5'), [0.5, 0]);
  });
  it('allows a negative amount, because a day can end in refunds', () => {
    eq(num(money, '-120.40'), [-120.4, 0]);
  });
  it('rounds to the cent rather than storing a float tail', () => {
    eq(num(money, '10.005'), [10.01, 0]);
  });
  it('tells someone their typo rather than storing a guess', () => {
    eq(num(wholeNumber, '12.5'), [null, 1]);
    eq(num(wholeNumber, 'twelve'), [null, 1]);
    eq(num(money, '1.2.3'), [null, 1]);
    eq(num(money, 'free'), [null, 1]);
  });
  it('reads a stray comma as a thousands separator, not as a typo', () => {
    // "1,2," is not something anyone means, but commas are separators here and
    // guessing otherwise would reject the ordinary "1,240" case too.
    eq(num(money, '1,2,'), [12, 0]);
  });
  it('leaves unreported as null, not nought', () => {
    // "Nobody has reported it" and "it sold nothing" are different answers and
    // a total must not confuse them.
    eq(num(wholeNumber, ''), [null, 0]);
    eq(num(wholeNumber, null), [null, 0]);
    eq(num(money, '   '), [null, 0]);
    eq(num(wholeNumber, '0'), [0, 0]);
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
  // Was a list of five, which went stale the moment a sixth was added. The
  // thing actually worth guarding is in the old test's name: the form has to
  // branch on every type. One added here and not wired there gets the Event
  // form by default -- ten questions, most of them wrong for it, and no
  // error anywhere to say so.
  it('gives every Event Type a branch in the form', () => {
    const cal = fs.readFileSync(path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', 'public', 'assets', 'calendar.js'), 'utf8');
    for (const k of EVENT_TYPE_KEYS) {
      if (k === 'event') continue;          // the fall-through every other one departs from
      ok(cal.includes("k === '" + k + "'"),
         k + ' has no branch in activeSteps, so it would get the Event form');
    }
  });
  it('keeps Cancelled, which the ICS feed and the strikethrough rely on', () => {
    eq(STATUSES, ['Booked', 'Pending', 'Cancelled']);
  });
});

// ── the retail calendar ──────────────────────────────────────────────────

describe('applyBlanks', () => {
  const row = (o) => Object.assign({
    event_type: 'event', venue: 'The Shop', address: '1 Main', city: 'Manasquan',
    state: 'NJ', zip: '08736', products: [{ division: 'mens' }],
    needs: 'sound', staff_count: '3', vehicles: 'box-truck',
    social_type: 'reel', channels: 'ig', pillar: null, production: null,
    caption: null, tags: null, sub_types: 'email-sms',
    event_fee: '100', orders: '4', net_revenue: '50',
    start_date: '2026-10-01', end_date: '2026-10-03',
  }, o);

  it('clears the place and the highlights on Email/SMS', () => {
    const out = applyBlanks(row({ event_type: 'marketing' }), ['email-sms']);
    eq([out.venue, out.address, out.city, out.state, out.zip, out.products],
       [null, null, null, null, null, null]);
  });
  it('leaves them alone on a sub-type that keeps them', () => {
    const out = applyBlanks(row({ event_type: 'marketing' }), ['campaign-promotion']);
    eq([out.venue, out.products.length], ['The Shop', 1]);
  });
  // The rule that keyed on the sub-type alone wiped the venues off HopSauce
  // and Coquina Jam: both are Events that carry an Email/SMS sub-type because
  // there is a campaign about them, and both happen at a real beach.
  it('leaves an Event alone even when a campaign about it is Email/SMS', () => {
    const out = applyBlanks(row({ event_type: 'event' }), ['email-sms']);
    eq([out.venue, out.city, out.zip], ['The Shop', 'Manasquan', '08736']);
    eq(out.products.length, 1);
  });
  it('leaves a post alone for the same reason', () => {
    eq(applyBlanks(row({ event_type: 'social' }), ['email-sms']).products.length, 1);
  });
  it('still takes the staff and the van off anything Marketing', () => {
    const out = applyBlanks(row({ event_type: 'marketing' }), ['campaign-promotion']);
    eq([out.needs, out.staff_count, out.vehicles], [null, null, null]);
  });
  it('still empties a meeting, and does not fight the Email/SMS rule', () => {
    const out = applyBlanks(row({ event_type: 'meeting' }), ['email-sms']);
    eq([out.sub_types, out.venue, out.products], [null, null, null]);
  });
  it('still ends a deadline on the day it falls', () => {
    eq(applyBlanks(row({ event_type: 'deadline' }), []).end_date, '2026-10-01');
  });
  it('still keeps the door money on an Event alone', () => {
    eq(applyBlanks(row({ event_type: 'event' }), []).orders, '4');
    eq(applyBlanks(row({ event_type: 'marketing' }), []).orders, null);
  });
  it('still keeps the social-only fields on a post alone', () => {
    eq(applyBlanks(row({ event_type: 'social' }), []).social_type, 'reel');
    eq(applyBlanks(row({ event_type: 'event' }), []).social_type, null);
  });
});

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

// ── Places ──────────────────────────────────────────────────────────────
//
// There is no locations table: the list on the Where step is derived from
// every event there has ever been. That is what keeps it from going stale,
// and it is also what makes the folding rules matter -- the same car park
// typed three ways is three entries on a dropdown somebody has to scan.

describe('places', () => {
  const ev = (venue, city, date, over) => ({
    venue, city, state: 'NJ', address: '', zip: '', start_date: date, ...over,
  });

  it('collapses spellings that differ only by case and punctuation', () => {
    const out = rollPlaces([
      ev('Taylor Ave. Waterfront', 'Beach Haven', '2026-06-13'),
      ev('taylor ave waterfront', 'Beach Haven', '2025-06-14'),
      ev('TAYLOR AVE  WATERFRONT', 'Beach Haven', '2024-06-15'),
    ]);
    eq(out.length, 1);
    eq(out[0].n, 3);
  });
  // The latest spelling is the one somebody most recently thought was right.
  it('shows the most recent spelling of a place, not the oldest', () => {
    const out = rollPlaces([
      ev('Taylor Ave. Waterfront', 'Beach Haven', '2026-06-13'),
      ev('taylor ave waterfront', 'Beach Haven', '2025-06-14'),
    ]);
    eq(out[0].venue, 'Taylor Ave. Waterfront');
  });
  it('keeps genuinely different places apart', () => {
    const out = rollPlaces([
      ev('Jetty Flagship', 'Manahawkin', '2026-01-01'),
      ev('Jetty Flagship', 'Long Branch', '2026-02-01'),
    ]);
    eq(out.length, 2);
  });
  it('drops an event with no location at all', () => {
    eq(rollPlaces([{ venue: '', address: '', city: '', state: '', zip: '',
                     start_date: '2026-01-01' }]).length, 0);
    eq(hasPlace({ venue: '  ' }), false);
    eq(hasPlace({ city: 'Ship Bottom' }), true);
  });
  it('puts the places we use most at the top', () => {
    const out = rollPlaces([
      ev('Once', 'Ship Bottom', '2026-09-01'),
      ev('Often', 'Ship Bottom', '2026-08-01'),
      ev('Often', 'Ship Bottom', '2026-07-01'),
      ev('Often', 'Ship Bottom', '2026-06-01'),
    ]);
    eq(out.map((p) => p.venue), ['Often', 'Once']);
  });
  it('breaks a tie on how recently we were there', () => {
    const out = rollPlaces([
      ev('Older', 'Ship Bottom', '2024-01-01'),
      ev('Newer', 'Ship Bottom', '2026-01-01'),
    ]);
    eq(out.map((p) => p.venue), ['Newer', 'Older']);
  });
  it('remembers the most recent date even when the rows are out of order', () => {
    const out = rollPlaces([
      ev('Same', 'Ship Bottom', '2024-01-01'),
      ev('Same', 'Ship Bottom', '2026-05-05'),
    ]);
    eq(out[0].last, '2026-05-05');
  });
  it('tidies a state into the two letters the form wants', () => {
    eq(rollPlaces([ev('X', 'Ship Bottom', '2026-01-01', { state: 'nj' })])[0].state, 'NJ');
  });
  it('labels a place the way somebody would say it', () => {
    eq(placeLabel({ venue: 'Jetty Flagship', address: '700 S Main St',
                    city: 'Manahawkin', state: 'NJ' }),
       'Jetty Flagship — 700 S Main St · Manahawkin, NJ');
    // Not "123 Main St -- 123 Main St".
    eq(placeLabel({ address: '123 Main St', city: 'Ship Bottom', state: 'NJ' }),
       '123 Main St — Ship Bottom, NJ');
    eq(placeLabel({ venue: 'Somewhere' }), 'Somewhere');
    eq(placeLabel({}), 'Untitled place');
  });
  it('gives every place a key that is the same for the same place', () => {
    eq(placeKey({ venue: 'A B', city: 'C' }), placeKey({ venue: ' a  b ', city: 'c' }));
    ok(placeKey({ venue: 'A' }) !== placeKey({ venue: 'B' }));
  });
  it('honours a limit, because the dropdown is for scanning', () => {
    const many = Array.from({ length: 50 }, (_, i) => ev('V' + i, 'C', '2026-01-01'));
    eq(rollPlaces(many, 10).length, 10);
  });
  it('copes with nothing at all', () => {
    eq(rollPlaces(null), []);
    eq(rollPlaces([]), []);
  });
  // The page fills five inputs from whatever a place carries. A field added
  // to one side and not the other is an address that silently half-copies.
  it('carries exactly the fields the form has', () => {
    eq(PLACE_FIELDS, ['venue', 'address', 'city', 'state', 'zip']);
    const page = fs.readFileSync(root('public/assets/calendar.js'), 'utf8');
    const m = page.match(/var LOC_FIELDS = \[([^\]]+)\]/);
    ok(m, 'the page has no LOC_FIELDS list');
    eq(m[1].split(',').map((x) => x.trim().replace(/'/g, '')), PLACE_FIELDS);
    for (const f of PLACE_FIELDS) {
      ok(page.includes("id=\"f-" + f + "\""), 'the form has no f-' + f + ' input');
    }
  });
});

// ── Watching Paid Advo ──────────────────────────────────────────────────
//
// SunnySide buys the paid media. A date that moves after a placement is
// booked costs real money, so the calendar tells them rather than waiting
// for somebody here to remember to.

describe('the Paid Advo watcher', () => {
  const item = {
    id: 'abc', title: 'Spring IG push', start_date: '2027-03-01',
    end_date: '2027-03-14', all_day: 1, status: 'Booked',
    venue: 'Jetty Flagship', city: 'Manahawkin', state: 'NJ',
  };

  it('watches a sub-type that exists', () => {
    ok(SUB_TYPES.some((t) => t.key === PAID_ADVO),
       PAID_ADVO + ' is not a sub-type, so nothing would ever match it');
  });
  it('says who did what, and to which event', () => {
    const msg = watchMessage({ actorName: 'Arlynn', item, action: 'created',
                               url: 'https://cal/?event=abc' });
    ok(/Arlynn added a \*Paid Advo\* item: \*Spring IG push\*/.test(msg), msg);
    ok(msg.includes('2027-03-01 – 2027-03-14'), msg);
    ok(msg.includes('Jetty Flagship · Manahawkin, NJ'), msg);
    ok(msg.includes('<https://cal/?event=abc|'), msg);
  });
  // "An event you watch was edited" is a notice people learn to ignore. The
  // fields that moved are the entire reason to send it.
  it('names what changed on an edit', () => {
    const msg = watchMessage({
      actorName: 'Arlynn', item, action: 'changed', url: 'https://cal/?event=abc',
      changed: changedFields(item, { ...item, start_date: '2027-03-08', status: 'Hold' }),
    });
    ok(/Changed: start date, status/.test(msg), msg);
  });
  it('offers no link on a deletion, because there is nothing to open', () => {
    const msg = watchMessage({ actorName: 'A', item, action: 'deleted',
                               url: 'https://cal/?event=abc' });
    ok(/deleted a \*Paid Advo\*/.test(msg), msg);
    ok(!msg.includes('https://cal'), msg);
  });
  it('escapes what Slack would read as markup', () => {
    const msg = watchMessage({ actorName: 'A', item: { ...item, title: 'A < B & C' },
                               action: 'created' });
    ok(msg.includes('A &lt; B &amp; C'), msg);
  });

  it('reads an address the way the form stores one', () => {
    eq(eventWhere({ venue: 'V', address: 'A', city: 'C', state: 'NJ', zip: '08050' }),
       'V · A · C, NJ · 08050');
    eq(eventWhere({ city: 'C', state: 'NJ' }), 'C, NJ');
    eq(eventWhere({}), '');
    eq(eventWhere(null), '');
  });
});

// Opening an event and pressing Save is not news. A notification that fires
// on every save is one nobody reads by the third week.
describe('what counts as a change worth telling somebody about', () => {
  const base = { title: 'T', start_date: '2027-01-01', all_day: 1, venue: 'V', status: 'Booked' };

  it('says nothing changed when nothing changed', () => {
    eq(changedFields(base, { ...base }), []);
  });
  it('is not fooled by a number that came back as a string', () => {
    eq(changedFields({ all_day: 1 }, { all_day: '1' }), []);
  });
  it('is not fooled by null against empty', () => {
    eq(changedFields({ venue: null, notes: '' }, { venue: '', notes: null }), []);
  });
  it('ignores the columns that move on every save', () => {
    const cols = WATCHED_FIELDS.map(([c]) => c);
    for (const c of ['updated_at', 'updated_by', 'created_at', 'created_by']) {
      ok(!cols.includes(c), c + ' is watched, so every save would notify');
    }
  });
  it('catches the ones that cost money to get wrong', () => {
    eq(changedFields(base, { ...base, start_date: '2027-02-02' }), ['start date']);
    eq(changedFields(base, { ...base, status: 'Cancelled' }), ['status']);
    eq(changedFields({ sub_types: 'paid-advo' }, { sub_types: 'collab' }), ['tags']);
  });
  it('reports several at once, in a readable order', () => {
    eq(changedFields(base, { ...base, title: 'U', venue: 'W' }), ['name', 'venue']);
  });
});

// The watch fires when the tag is on EITHER side of the edit. A Paid Advo
// item that stops being one is exactly the change a media buyer needs, and
// checking only the new row would make it invisible.
describe('the watcher is wired the way it is meant to be', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');

  it('fires on a tag removed as well as a tag added', () => {
    ok(/if \(!isPaidAdvo\(before\) && !isPaidAdvo\(after\)\) return;/.test(idx),
       'the watch only looks at one side of the edit');
  });
  it('is called on create, on edit and on delete', () => {
    for (const a of ['created', 'changed', 'deleted']) {
      ok(new RegExp("tellWatchers\\('" + a + "'").test(idx), 'nothing notifies on ' + a);
    }
  });
  it('never makes the save wait on Slack', () => {
    const fn = idx.slice(idx.indexOf('const tellWatchers'));
    const body = fn.slice(0, fn.indexOf('\n  if (path ==='));
    ok(fn.indexOf('\n  if (path ===') > 0, 'the slice has no end, so it covers the whole file');
    ok(!/\/api\/places/.test(body), 'the slice runs past tellWatchers');
    ok(/ctx\.waitUntil\(notify\)/.test(body), 'the notification is not deferred');
    ok(!/await dmMentions/.test(body.split('const notify')[0] || ''),
       'something awaits Slack before responding');
  });
  it('does not ping the person who made the change', () => {
    ok(/filter\(\(e\) => e !== String\(who\.email\)\.toLowerCase\(\)\)/.test(idx),
       'the watcher would be told about their own edit');
  });
  it('takes the tag key from the taxonomy rather than spelling it again', () => {
    ok(/PAID_ADVO/.test(idx), 'index.js does not use the named key');
    ok(!/'paid-advo'/.test(idx), 'index.js spells the key by hand, which will go stale');
  });
  // A watcher added to Slack after the roster was last cached would not be
  // found, and the ping would fail quietly until somebody opened the mention
  // picker on a comment.
  it('looks Slack up again when a watcher is not in the cached roster', () => {
    const fn = idx.slice(idx.indexOf('const tellWatchers'));
    const body = fn.slice(0, fn.indexOf('\n  if (path ==='));
    ok(/refreshRoster\(env, db\)/.test(body), 'a stale roster is never refreshed');
    ok(/mine\(roster\)\.length < to\.length/.test(body),
       'it refreshes unconditionally, or never');
  });
  it('still delivers to the watchers it does know if the refresh fails', () => {
    const fn = idx.slice(idx.indexOf('const tellWatchers'));
    const body = fn.slice(0, fn.indexOf('\n  if (path ==='));
    ok(/catch \(e\) \{ \/\* a stale roster/.test(body),
       'a Slack lookup failure would stop the message going out at all');
  });
  it('is off until somebody is named, rather than erroring', () => {
    ok(/env\.PAID_ADVO_WATCHERS \|\| ''/.test(idx), 'an unset watcher list is not handled');
    ok(/if \(!to\.length \|\| !env\.SLACK_BOT_TOKEN\) return;/.test(idx),
       'it would try to notify with no token or nobody to notify');
  });
});

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
