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
import { planMigration, mergeSubTypes, mergeFeedFilters, promoteSocial,
         planEmailSplit, MERGED_EMAIL_SMS, splitKind,
         SUB_TYPE_MERGES } from '../worker/migrate.js';
import { normaliseProducts, readProducts, MAX_PRODUCTS } from '../worker/products.js';
import { applyBlanks } from '../worker/blanks.js';
import { commentMessage, displayName, dmMentions, escapeSlack, eventUrl, eventWhen,
         slackHint, watchMessage, changedFields, eventWhere,
         WATCHED_FIELDS } from '../worker/slack.js';
import { rollPlaces, placeKey, placeLabel, hasPlace,
         FIELDS as PLACE_FIELDS } from '../worker/places.js';
import { listingAction, listingMessage, needed, LISTING_FIELDS,
         WEBSITE_NEED } from '../worker/listing.js';
import {
  ROLES, ROLE_KEYS, pointsFromConfig, cleanEntry, cleanLedger, staffMember,
  pickable, leaderboard, standings, csv as boxyCsv, personSummary,
  checkoutNames, SAMPLE_PER_POINT,
  STAFF as BOXY_STAFF, ROSTER_AS_OF as BOXY_AS_OF,
} from '../worker/boxy.js';
import { deadlineFor, deadlineAction, leadFor, minusDays, deadlineTitle,
         PREFIX, WATCHED_SUBS } from '../worker/deadlines.js';
import { planSmsDedupe } from '../worker/repair.js';
import { noticeBody, summarise, countUnread, isAutomatic,
         CALENDAR_AUTHOR } from '../worker/notices.js';
import { aov, netOfFee, hasReport, readyToPost, money, salesMessage, deliver,
         RESULTS_SLOT } from '../worker/sales.js';
import SOCIAL_BACKFILL from '../backfill/social.json' with { type: 'json' };
import { buildIcs } from '../worker/ics.js';
import { retailWeek, retailWeekStart } from '../worker/retail.js';
import {
  DEPARTMENTS, DEPARTMENT_KEYS, DIVISIONS, EVENT_TYPE_KEYS, SUB_TYPES, NEEDS, VEHICLES,
  STATUSES, PRIMACY, RETAIL_EPOCH, SOCIAL_TYPES, CHANNELS, PILLARS, PRODUCTION,
  SUB_TYPE_KEYS, SOCIAL_TYPE_KEYS, CHANNEL_KEYS, PILLAR_KEYS, PRODUCTION_KEYS, PAID_ADVO,
  WEBSITE_LISTING,
} from '../worker/taxonomy.js';

let failed = 0;
let ran = 0;
const groups = [];
let group = null;

function describe(name, fn) { groups.push([name, fn]); }
function it(name, fn) { group.push({ name, fn }); }
// JSON.stringify turns Infinity and NaN into null, so eq(Infinity, null)
// used to pass -- and the check that a division guards against zero passed
// whether or not the guard was there. Non-finite numbers are shown as
// themselves instead, which is both a correct comparison and a readable
// failure message.
const show = (v) => JSON.stringify(v, (k, x) =>
  (typeof x === 'number' && !Number.isFinite(x) ? '<' + String(x) + '>' : x));
function eq(got, want, what) {
  const g = show(got); const w = show(want);
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
    // Both are live keys again since the split, so neither is folded away.
    eq(planMigration({ event_types: 'marketing', sub_types: 'email,sms' }).sub_types, 'email,sms');
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
    eq(mergeSubTypes('campaign'), 'campaign-promotion');
    eq(mergeSubTypes('promotion'), 'campaign-promotion');
  });
  it('does not leave two copies on an item that had both', () => {
    eq(mergeSubTypes('campaign,promotion'), 'campaign-promotion');
  });
  it('leaves the other sub-types alone, in order', () => {
    eq(mergeSubTypes('social,campaign,website'), 'social,campaign-promotion,website');
  });
  it('is idempotent, so a second run changes nothing', () => {
    const once = mergeSubTypes('campaign,promotion');
    eq(mergeSubTypes(once), once);
    eq(mergeSubTypes('campaign-promotion'), 'campaign-promotion');
  });
  // Email and SMS were in this map until they were split back apart. Leaving
  // them would have been the whole bug: every fold would have turned a live
  // key back into a dead one, silently, on write.
  it('no longer folds Email and SMS, which are live keys again', () => {
    eq(mergeSubTypes('email'), 'email');
    eq(mergeSubTypes('sms'), 'sms');
    eq(mergeSubTypes('email,sms'), 'email,sms');
    ok(!Object.keys(SUB_TYPE_MERGES).includes('email'), 'email is still in the merge map');
    ok(!Object.keys(SUB_TYPE_MERGES).includes('sms'), 'sms is still in the merge map');
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
    // The merged key is still named there on purpose -- that list places an
    // UNMIGRATED row, and an unmigrated row is the one still carrying it.
    eq([...inMigration].filter((k) => k !== MERGED_EMAIL_SMS).sort(),
       [...inTaxonomy].sort());
    ok(inMigration.includes(MERGED_EMAIL_SMS),
       'a legacy Email/SMS row would now be filed as an Event');
  });
  it('only ever produces keys the taxonomy knows', () => {
    const keys = SUB_TYPES.map((s) => s.key);
    for (const merged of Object.values(SUB_TYPE_MERGES)) {
      ok(keys.includes(merged), merged + ' is not a real sub-type');
    }
  });

  it('rewrites a calendar sync that asked for the old keys', () => {
    eq(mergeFeedFilters('{"sub":["campaign","promotion"],"dept":["marketing"]}'),
       '{"sub":["campaign-promotion"],"dept":["marketing"]}');
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
    caption: null, tags: null, sub_types: 'email',
    event_fee: '100', orders: '4', net_revenue: '50',
    start_date: '2026-10-01', end_date: '2026-10-03',
  }, o);

  it('clears the place and the highlights on a send', () => {
    const out = applyBlanks(row({ event_type: 'marketing' }), ['email']);
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
    const out = applyBlanks(row({ event_type: 'event' }), ['email']);
    eq([out.venue, out.city, out.zip], ['The Shop', 'Manasquan', '08736']);
    eq(out.products.length, 1);
  });
  it('leaves a post alone for the same reason', () => {
    eq(applyBlanks(row({ event_type: 'social' }), ['email']).products.length, 1);
  });
  it('still takes the staff and the van off anything Marketing', () => {
    const out = applyBlanks(row({ event_type: 'marketing' }), ['campaign-promotion']);
    eq([out.needs, out.staff_count, out.vehicles], [null, null, null]);
  });
  it('still empties a meeting, and does not fight the Email/SMS rule', () => {
    const out = applyBlanks(row({ event_type: 'meeting' }), ['email']);
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
    ok(/if \(!to\.length\) return;/.test(idx), 'it would try to notify nobody');
  });
  // The comment IS the notice, and Taylor has no Slack account. Gating the
  // whole thing on a Slack token -- which is what it did when Slack was the
  // only delivery -- would mean the one person it was built for never hears.
  it('writes the comment whether or not Slack is configured', () => {
    const fn = idx.slice(idx.indexOf('const tellWatchers'));
    const body = fn.slice(0, fn.indexOf('\n  if (path ==='));
    const guards = body.slice(0, body.indexOf('const notify'));
    const writing = body.slice(body.indexOf('const comment'), body.indexOf('if (ctx &&'));
    ok(guards.indexOf('const notify') === -1 && guards.length > 80, 'the guard slice is wrong');
    ok(!/SLACK_BOT_TOKEN/.test(guards),
       'a missing Slack token stops the watch before it writes anything');
    ok(!/SLACK_BOT_TOKEN/.test(writing),
       'writing the comment depends on Slack being configured');
    ok(/if \(env\.SLACK_BOT_TOKEN\) ctx\.waitUntil\(notify\)/.test(body),
       'the DM is attempted with no token');
    ok(/ctx\.waitUntil\(comment\)/.test(body), 'the comment is never deferred');
  });
  // A watcher with no Slack account is not a failure any more: the comment
  // is how they are told. Reporting it as one would put a permanent warning
  // on the page for a thing that is working as designed.
  it('only DMs the people Slack can actually reach', () => {
    ok(/\.filter\(\(p\) => p && p\.slack_id\)/.test(idx),
       'it still hands dmMentions somebody with no Slack account');
  });
  // There is no event left to open, so a comment on it would be a notice
  // nobody can reach.
  it('writes no comment on a deletion', () => {
    ok(/if \(action === 'deleted' \|\| !item \|\| !item\.id\) return;/.test(idx),
       'a deleted event is commented on');
  });
});

// ── The notice in the calendar ──────────────────────────────────────────
//
// Taylor has no Slack account, so the DM had nowhere to land. She can sign
// in to the calendar -- Access lets sunnysidecalifornia.com through -- so
// the notice goes there instead: a comment on the event, mentioning her,
// which she can also reply to.

describe('the automatic notice', () => {
  const item = {
    id: 'abc', title: 'Spring IG push', start_date: '2027-03-01',
    end_date: '2027-03-14', all_day: 1, status: 'Booked',
    venue: 'Jetty Flagship', city: 'Manahawkin', state: 'NJ',
  };

  it('reads like something a person would have written', () => {
    const body = noticeBody({ actorName: 'Arlynn', item, action: 'created' });
    ok(body.startsWith('Arlynn added this Paid Advo item.'), body);
    ok(body.includes('When: 2027-03-01 – 2027-03-14'), body);
    ok(body.includes('Where: Jetty Flagship · Manahawkin, NJ'), body);
  });
  // Which date it moved to is the entire reason somebody outside the
  // company is being told.
  it('names the fields that moved', () => {
    const body = noticeBody({ actorName: 'A', item, action: 'changed',
                              changed: ['start date', 'status'] });
    ok(body.includes('Changed: start date, status'), body);
  });
  // It is read in a comment thread, not in Slack. Markup here would be
  // shown literally, and the page escapes what it renders anyway.
  it('carries no Slack markup', () => {
    const body = noticeBody({ actorName: 'A', item, action: 'created',
                              url: 'https://cal/?event=abc' });
    ok(!/[*<>|]/.test(body), body);
  });
  it('says something even when the event has nothing on it', () => {
    ok(noticeBody({ action: 'created', item: {} }).length > 10);
    ok(noticeBody({}).length > 10);
  });

  // Every real author comes out of verified Access claims, which always
  // carry an "@". So nothing a person can sign in as collides with this.
  it('has an author no person could ever be', () => {
    ok(!CALENDAR_AUTHOR.includes('@'), CALENDAR_AUTHOR + ' could be an address');
    eq(isAutomatic(CALENDAR_AUTHOR), true);
    eq(isAutomatic('jeremy@jettylife.com'), false);
    eq(isAutomatic(''), false);
  });
  it('is drawn as the calendar rather than as somebody oddly named', () => {
    const page = fs.readFileSync(root('public/assets/calendar.js'), 'utf8');
    ok(page.includes("var CALENDAR_AUTHOR = '" + CALENDAR_AUTHOR + "'"),
       'the page does not know the automatic author, or spells it differently');
    ok(/return 'Jetty Calendar'/.test(page), 'the page has no name for it');
  });
});

describe('what the For you list shows of a comment', () => {
  it('takes the first line that has anything on it', () => {
    eq(summarise('\n\n  Arlynn changed this.\nChanged: start date'), 'Arlynn changed this.');
  });
  it('trims one that runs on', () => {
    const out = summarise('x'.repeat(300), 40);
    eq(out.length, 40);
    ok(out.endsWith('…'), out);
  });
  it('copes with nothing', () => {
    eq(summarise(''), '');
    eq(summarise(null), '');
    eq(summarise('\n\n\n'), '');
  });
});

// A badge you cannot clear by reading is worse than no badge.
describe('how many mentions are new', () => {
  const rows = [
    { author: 'a@x.com', created_at: '2026-10-23T00:00:00Z' },
    { author: 'b@x.com', created_at: '2026-10-20T00:00:00Z' },
    { author: 'me@x.com', created_at: '2026-10-24T00:00:00Z' },
  ];
  it('counts only what arrived since you last looked', () => {
    eq(countUnread(rows, '2026-10-21T00:00:00Z', 'me@x.com'), 1);
  });
  it('counts everything when you never have', () => {
    eq(countUnread(rows, '', 'me@x.com'), 2);
  });
  // Mentioning yourself is a thing people do by accident.
  it('never counts your own', () => {
    eq(countUnread(rows, '', 'ME@X.COM'), 2);
    eq(countUnread([{ author: 'me@x.com', created_at: '2026-10-24T00:00:00Z' }], '', 'me@x.com'), 0);
  });
  it('counts nothing out of nothing', () => {
    eq(countUnread(null, '', 'me@x.com'), 0);
    eq(countUnread([], '2026-01-01', 'me@x.com'), 0);
  });
});

// A LIKE on a comma-separated column matches more than it should: '%a@b%'
// also hits 'xa@b.co'. A notice meant for one person turning up for another
// is worse than one that is slow to find.
describe('finding the comments that mention you', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  it('checks the match exactly rather than trusting the LIKE', () => {
    ok(/\.split\(','\)\.map\(\(x\) => x\.trim\(\)\.toLowerCase\(\)\)\.includes\(me\)/.test(idx),
       'the LIKE result is used as-is, so a mention can reach the wrong person');
  });
  it('refuses a request with nobody signed in', () => {
    const fn = idx.slice(idx.indexOf("path === '/api/mentions'"));
    ok(/if \(!who\.email\) return json\(\{ error: 'Not signed in\.' \}, 403\);/
      .test(fn.slice(0, 400)), 'the endpoint answers an unidentified request');
  });
  it('stores the seen mark against the signed-in address, not one that was sent', () => {
    const fn = idx.slice(idx.indexOf("path === '/api/mentions'"));
    const body = fn.slice(0, fn.indexOf('\n  // Everywhere'));
    ok(/const me = String\(who\.email\)\.toLowerCase\(\);/.test(body), 'me is not the caller');
    ok(!/searchParams\.get\('email'\)/.test(body), 'it takes an address from the query');
  });
});

// Who is actually configured to be told.
//
// A typo here is invisible: the comment is written, the mention is stored
// against an address nobody has, and it is never seen by anyone. Nothing
// errors, nothing warns, and the first anybody knows is a media buyer
// asking why they were not told about a date change.
// A channel ID, not a #name. A renamed channel keeps its id and loses its
// name, and the failure mode of getting this wrong is "channel_not_found"
// at the moment somebody is trying to post a sales report.
describe('the Slack channels as they ship', () => {
  const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
  const read = (key) => {
    const m = toml.match(new RegExp('^' + key + ' = "([^"]*)"', 'm'));
    return m ? m[1] : null;
  };

  for (const key of ['SALES_REPORT_CHANNEL', 'WEBSITE_CHANNEL']) {
    it(key + ' is set at all', () => ok(read(key), key + ' is missing from wrangler.toml'));
    it(key + ' is an id rather than a name', () => {
      const v = read(key);
      ok(!v.startsWith('#'), v + ' is a channel name; a rename would break it');
      ok(/^[CG][A-Z0-9]{6,20}$/.test(v),
         v + ' is not a Slack channel id (C… for a channel, G… for a private one)');
    });
  }
  // Posting a sales report into the website channel, or the other way
  // round, is the kind of mistake a copy-paste makes and nobody notices
  // until it has happened in front of everybody.
  it('does not point two different things at the same channel', () => {
    ok(read('SALES_REPORT_CHANNEL') !== read('WEBSITE_CHANNEL'),
       'both channels are ' + read('WEBSITE_CHANNEL'));
  });
});

describe('the watcher list as it ships', () => {
  const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
  const read = (key) => {
    const m = toml.match(new RegExp('^' + key + ' = "([^"]*)"', 'm'));
    return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
  };
  const watchers = read('PAID_ADVO_WATCHERS');

  it('is set at all', () => {
    ok(watchers, 'PAID_ADVO_WATCHERS is missing from wrangler.toml');
  });
  it('is every one of them a real address', () => {
    for (const e of watchers) {
      ok(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e), e + ' is not an email address');
      eq(e, e.toLowerCase(), e + ' is not lowercased, and the match is exact');
    }
  });
  // The comment is on an event. An address Access will not let in cannot
  // open the event, so the notice is written somewhere they cannot reach.
  it('is on a domain that can sign in to the calendar', () => {
    // The three domains Access admits. Kept here rather than read from
    // Cloudflare because this is the check that a FOURTH one, added to the
    // watch list without being added to Access, is caught before it ships.
    const ALLOWED = ['jettylife.com', 'sunnysidecalifornia.com', 'jettyrockfoundation.org'];
    for (const e of watchers) {
      const domain = e.split('@')[1];
      ok(ALLOWED.includes(domain),
         domain + ' is not on the calendar’s Access policy, so ' + e
         + ' cannot open the event the notice is written on');
    }
  });
  // Nothing but the Paid Advo watch can reach them. They are not in the
  // Slack roster, so they cannot be picked in the mention box either.
  it('names the person the website channel addresses', () => {
    const m = toml.match(/^WEBSITE_WATCHER = "([^"]*)"/m);
    ok(m, 'WEBSITE_WATCHER is missing from wrangler.toml');
    // Deliberately no Access-domain check here, unlike the Paid Advo list:
    // this address is only ever looked up against Slack, to turn the post
    // into a mention. It never has to open anything.
    ok(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(m[1]), m[1] + ' is not an email address');
    eq(m[1], m[1].toLowerCase(), m[1] + ' is not lowercased, and the match is exact');
  });
  it('is only ever used by the Paid Advo watch', () => {
    const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
    eq((idx.match(/PAID_ADVO_WATCHERS/g) || []).length, 1);
    const calls = [...idx.matchAll(/\bwatchers\(\)/g)].map((m) => m.index);
    eq(calls.length, 1, 'the watcher list is read in more than one place');
    ok(calls[0] > idx.indexOf('const tellWatchers'),
       'it is read somewhere other than inside the Paid Advo watch');
  });
});

// ── The sales report announcement ───────────────────────────────────────
//
// Results arrive in two pieces, in whichever order the person works: the
// figures typed into the form and the export from the till attached beside
// them. Announcing on either one alone sends a message with half of it
// missing, so the announcement waits for the set.

describe('average order value', () => {
  it('is revenue over orders', () => eq(aov(142, 8420.5).toFixed(4), '59.2993'));
  it('reads a figure typed the way people type one', () => {
    eq(aov('142', '$8,420.50').toFixed(2), '59.30');
  });
  // An event that took no orders has no average. $0.00 in a channel message
  // reads as a number somebody measured; Infinity reads as a broken page.
  it('is nothing at all when there were no orders', () => {
    eq(aov(0, 8420.5), null);
    eq(aov(null, 8420.5), null);
    eq(aov('', 8420.5), null);
  });
  it('is nothing at all when there is no revenue', () => {
    eq(aov(142, null), null);
    eq(aov(142, ''), null);
  });
  it('survives a revenue of zero, which is a real outcome', () => {
    eq(aov(142, 0), 0);
  });
});

describe('net of fee', () => {
  it('takes the cost of being there off the top', () => eq(netOfFee(8420.5, 250), 8170.5));
  it('goes negative when the day did not cover it', () => eq(netOfFee(100, 250), -150));
  // Equal to revenue would imply the day was free, which is a different
  // claim from not having been asked what it cost.
  it('is nothing at all when no fee was recorded', () => {
    eq(netOfFee(8420.5, null), null);
    eq(netOfFee(8420.5, ''), null);
  });
});

describe('when there is something to announce', () => {
  const full = { orders: 142, net_revenue: 8420.5, results_posted_at: null };
  const withReport = [{ slot: RESULTS_SLOT }];

  it('needs the figures and the report', () => {
    eq(readyToPost(full, withReport), true);
    eq(readyToPost(full, [{ slot: null }]), false, 'announced with no report');
    eq(readyToPost({ ...full, orders: null }, withReport), false, 'announced with no orders');
    eq(readyToPost({ ...full, net_revenue: null }, withReport), false, 'announced with no revenue');
  });
  // A real outcome worth recording on the event, but not what @channel is
  // for.
  it('does not announce an event that took no orders', () => {
    eq(readyToPost({ ...full, orders: 0 }, withReport), false);
  });
  it('announces an event that took no money, which is news of a kind', () => {
    eq(readyToPost({ ...full, net_revenue: 0 }, withReport), true);
  });
  // The whole point of the stamp.
  it('never announces the same event twice', () => {
    eq(readyToPost({ ...full, results_posted_at: '2026-10-05T00:00:00Z' }, withReport), false);
  });
  it('knows a report from an ordinary attachment', () => {
    eq(hasReport([{ slot: 'results' }]), true);
    eq(hasReport([{ slot: null }, { slot: 'row-1' }]), false);
    eq(hasReport([]), false);
    eq(hasReport(null), false);
  });
  it('copes with no event at all', () => eq(readyToPost(null, withReport), false));
  // The page has called this slot 'results' since results were added. The
  // Worker decides what to announce on; they cannot be allowed to drift.
  it('agrees with the page on which slot the report is in', () => {
    const page = fs.readFileSync(root('public/assets/calendar.js'), 'utf8');
    ok(page.includes("var RESULTS_SLOT = '" + RESULTS_SLOT + "'"),
       'the page puts the sales report in a different slot from the one watched');
  });
});

describe('the @channel message', () => {
  const item = { title: 'Chowderfest', start_date: '2026-10-04',
                 orders: 142, net_revenue: 8420.5, event_fee: 250 };

  it('leads with the event and carries all four figures', () => {
    const m = salesMessage({ item, url: 'https://cal/?event=1' });
    ok(m.includes('Sales report in for *Chowderfest* (2026-10-04).'), m);
    ok(m.includes('Orders: 142'), m);
    ok(m.includes('Revenue: $8,420.50'), m);
    ok(m.includes('AOV: $59.30'), m);
    ok(m.includes('Net of fee: $8,170.50'), m);
    ok(m.includes('<https://cal/?event=1|'), m);
  });
  // Escaping the whole string at the end would turn the mention into
  // literal text and nobody would be notified at all -- which looks exactly
  // like a message that was sent.
  it('keeps the @channel mention as a mention', () => {
    ok(salesMessage({ item }).startsWith('<!channel> '), 'the mention was escaped away');
  });
  it('still escapes what came from the event', () => {
    const m = salesMessage({ item: { ...item, title: 'Beer & <Sauce>' } });
    ok(m.includes('Beer &amp; &lt;Sauce&gt;'), m);
    ok(m.startsWith('<!channel> '), m);
  });
  it('leaves the fee line off when no fee was recorded', () => {
    ok(!salesMessage({ item: { ...item, event_fee: null } }).includes('Net of fee'));
  });
  it('can be asked not to ping everybody', () => {
    ok(!salesMessage({ item, mention: false }).includes('<!channel>'));
  });
  it('shows money the way money is written', () => {
    eq(money(8420.5), '$8,420.50');
    eq(money(0), '$0.00');
    eq(money(-150), '−$150.00');
    eq(money(null), '');
  });
});

// The branch that matters is the one where Slack REFUSES the upload, and
// it was wrong: the fallback ran when there was no file to send and not
// when sending it failed. A missing files:write scope meant no message at
// all -- while the comment beside it said the opposite, which is how it
// survived being written.
describe('sending it when the file will not go', () => {
  const run = async (postFile) => {
    const posted = [];
    const out = await deliver({
      file: {}, text: 'the numbers',
      postFile: async (f, c) => { posted.push(['file', c]); return postFile(); },
      postText: async (t) => { posted.push(['text', t]); },
    });
    return { out, posted };
  };
  const refuse = () => { throw new Error('getUploadURLExternal: missing_scope'); };
  const fine = () => {};

  it('still posts the numbers', async () => {
    const { out, posted } = await run(refuse);
    eq(posted.map((p) => p[0]), ['file', 'text'], 'the numbers never went');
    eq(out.withFile, false);
  });
  // "Posted, without the report" is a different thing to have happened
  // from "posted", and whoever pressed the button can fix it.
  it('says why the file did not go, rather than swallowing it', async () => {
    const { out } = await run(refuse);
    ok(/missing_scope/.test(out.fileError), out.fileError);
  });
  it('posts once, not twice, when the file does go', async () => {
    const { out, posted } = await run(fine);
    eq(posted.map((p) => p[0]), ['file']);
    eq([out.withFile, out.fileError], [true, '']);
  });
  it('sends the numbers as the file\u2019s comment, so it is one post', async () => {
    const { posted } = await run(fine);
    eq(posted[0][1], 'the numbers');
  });
  it('posts the numbers alone when there is no file', async () => {
    const posted = [];
    const out = await deliver({
      file: null, text: 'the numbers',
      postFile: async () => { posted.push('file'); },
      postText: async () => { posted.push('text'); },
    });
    eq(posted, ['text']);
    eq([out.withFile, out.fileError], [false, '']);
  });
  // Nothing to fall back to. The caller turns this into the error the
  // person sees.
  it('throws when even the numbers will not go', async () => {
    let threw = '';
    try {
      await deliver({ file: null, text: 't', postFile: async () => {},
                      postText: async () => { throw new Error('not_in_channel'); } });
    } catch (e) { threw = e.message; }
    eq(threw, 'not_in_channel');
  });
});

// Two @channel pings for one event is the kind of mistake people remember.
// The automatic announcement fires on the write that completes a set of
// results -- which is no use to an event whose results were typed in before
// any of this existed, and no use for trying it out.
describe('posting a sales report on demand', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const fn = idx.slice(idx.indexOf('const announceMatch'));
  const body = fn.slice(0, fn.indexOf('\n  // Files attached to one event'));

  it('is the block this is about', () => {
    ok(body.length > 400 && /\/announce\$/.test(body), 'the slice missed the endpoint');
  });
  it('is editors only, and a POST', () => {
    ok(/if \(method !== 'POST'\) return json/.test(body), 'a GET would post to Slack');
    ok(/const denied = requireEditor\(\); if \(denied\) return denied;/.test(body),
       'anybody who can read the calendar could post to @channel');
  });
  // "Cannot post" sends somebody hunting. Naming the missing piece is one
  // glance at the form.
  it('says which piece is missing rather than refusing flatly', () => {
    for (const bit of ['orders', 'net revenue', 'the sales report file']) {
      ok(body.includes("'" + bit + "'"), 'it does not name ' + bit + ' as missing');
    }
    ok(/missing\.join\(', '\)/.test(body), 'it names only the first missing piece');
  });
  // Unlike the automatic path. A corrected revenue figure is worth saying
  // out loud, and refusing would send somebody to the database to clear a
  // timestamp.
  it('will post an event that has already been posted', () => {
    ok(!/readyToPost/.test(body), 'the button is gated on the same stamp as the automatic path');
    ok(/again: Boolean\(item\.results_posted_at\)/.test(body),
       'it does not say when it is posting a second time');
  });
  it('sends the same message the automatic path does', () => {
    ok(/await sendResults\(item, atts\)/.test(body),
       'the button builds its own message, which will drift from the other one');
  });
  // Slack's own error strings mean nothing to somebody who has never
  // configured a Slack app.
  it('hands back what to actually go and do', () => {
    ok(/hint: slackHint\(msg\)/.test(body), 'the error is relayed with no hint');
    const page = fs.readFileSync(root('public/assets/calendar.js'), 'utf8');
    ok(/err\.hint = body\.hint;/.test(page), 'the page throws the hint away');
  });
  it('says plainly when there is no channel to post to', () => {
    ok(/No Slack channel is set for sales reports/.test(body),
       'an unconfigured channel fails as something else');
  });
});

describe('the announcement is wired so it fires once', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const fn = idx.slice(idx.indexOf('const sendResults'));
  const body = fn.slice(0, fn.indexOf('\n  const requireEditor'));

  it('is the function this block is actually about', () => {
    ok(fn.indexOf('\n  const requireEditor') > 0, 'the slice has no end');
    ok(/const announceResults = \(itemId\) => \{/.test(body), 'announceResults is not here');
    ok(/const sendResults = async/.test(body), 'sendResults is not here');
  });
  // An upload and a save landing together would each see an incomplete row
  // become complete.
  it('claims the event before it sends anything', () => {
    ok(/WHERE id = \? AND results_posted_at IS NULL/.test(body),
       'the stamp is not claimed conditionally, so two writes can both post');
    ok(/claim\.meta\.changes !== 1/.test(body), 'the claim result is not checked');
    ok(body.indexOf('results_posted_at IS NULL') < body.indexOf('await sendResults'),
       'it sends before it claims, so two writes can both post');
  });
  // A failed post that stays stamped never retries, and fixing the scope
  // would change nothing.
  it('gives the claim back when Slack refuses', () => {
    ok(/UPDATE items SET results_posted_at = NULL WHERE id = \?/.test(body),
       'a failed send leaves the event marked as announced');
  });
  // The numbers are most of the value.
  it('still posts the numbers when the file will not go', () => {
    const send = body.slice(0, body.indexOf('const announceResults'));
    // The decision itself is deliver(), tested above against a Slack that
    // refuses. All this has to check is that the Worker uses it rather than
    // branching on its own again.
    ok(/return deliver\(\{/.test(send), 'the Worker decides this itself instead of using deliver');
    ok(/postText: \(t\) => postToChannel/.test(send), 'there is no text fallback wired in');
  });
  it('fires on both of the writes that can complete a set', () => {
    const calls = [...idx.matchAll(/announceResults\(/g)].map((m) => m.index);
    eq(calls.length, 2, 'called somewhere other than the save and the upload');
    const att = idx.indexOf("const attMatch");
    const patch = idx.indexOf("if (method === 'PATCH' || method === 'PUT')");
    ok(calls.some((c) => c > att && c < patch), 'nothing announces after an upload');
    ok(calls.some((c) => c > patch), 'nothing announces after a save');
  });
  it('is off until a channel is named', () => {
    ok(/if \(!env\.SLACK_BOT_TOKEN \|\| !env\.SALES_REPORT_CHANNEL\) return;/.test(body),
       'it would try to post with no channel');
  });
  it('never makes the save wait on Slack', () => {
    ok(/ctx\.waitUntil\(run\)/.test(body), 'the announcement is not deferred');
  });
  // The items table predates all of this, and CREATE TABLE IF NOT EXISTS
  // does not revisit a table that exists.
  it('adds its column to a database that already exists', () => {
    const added = idx.slice(idx.indexOf('const ADDED_COLUMNS'));
    ok(/'results_posted_at TEXT'/.test(added.slice(0, added.indexOf('];'))),
       'the column reaches schema.sql but never the live database');
  });
});

// ── Add to Website Events page ──────────────────────────────────────────
//
// A tick box in the needs grid rather than a message somebody remembers to
// send. Ticking it posts in the website channel; it posts again if what
// goes ON the page moves, and once more if the tick comes off.

describe('the website listing need', () => {
  it('is a need the form actually offers', () => {
    ok(NEEDS.some((n) => n.key === WEBSITE_NEED),
       WEBSITE_NEED + ' is not in the needs list, so nothing can ever tick it');
    eq(WEBSITE_LISTING, WEBSITE_NEED, 'the taxonomy and the watch disagree on the key');
  });
  it('reads the tick off a comma-separated needs column', () => {
    eq(needed({ needs: 'extra-staff,website-listing' }), true);
    eq(needed({ needs: 'website-listing' }), true);
    eq(needed({ needs: 'extra-staff,sound' }), false);
    eq(needed({ needs: '' }), false);
    eq(needed(null), false);
  });
  // 'website-listing-extra' must not match 'website-listing'.
  it('is not fooled by a key that merely starts the same', () => {
    eq(needed({ needs: 'website-listing-draft' }), false);
  });
});

describe('what the website channel is told, and when', () => {
  const on = { title: 'Sample Sale', start_date: '2026-11-07', end_date: '2026-11-08',
               all_day: 1, status: 'Booked', venue: 'Jetty Flagship', city: 'Manahawkin',
               state: 'NJ', needs: 'extra-staff,website-listing' };
  const off = { ...on, needs: 'extra-staff' };

  it('asks for it when the box is ticked', () => {
    eq(listingAction(off, on).action, 'add');
  });
  it('asks for it when an event arrives with the box already on', () => {
    eq(listingAction(null, on).action, 'add');
  });
  // Opening an event and pressing save is not news.
  it('says nothing when nothing changed', () => {
    eq(listingAction(on, { ...on }).action, '');
  });
  // A ping that fires on every edit is one somebody filters within a
  // fortnight.
  it('says nothing when the edit does not touch the page', () => {
    eq(listingAction(on, { ...on, notes: 'new note' }).action, '');
    eq(listingAction(on, { ...on, department: 'marketing' }).action, '');
    eq(listingAction(on, { ...on, sub_types: 'collab' }).action, '');
  });
  it('speaks up when something on the page moves', () => {
    eq(listingAction(on, { ...on, start_date: '2026-11-14' }),
       { action: 'update', changed: ['start date'] });
    eq(listingAction(on, { ...on, status: 'Cancelled' }),
       { action: 'update', changed: ['status'] });
    eq(listingAction(on, { ...on, venue: 'Long Branch', city: 'Long Branch' }),
       { action: 'update', changed: ['venue', 'city'] });
  });
  // A listing for an event that is not happening is worse than one that was
  // never added, and the page does not know on its own.
  it('asks for it to come off when the tick does', () => {
    eq(listingAction(on, off).action, 'remove');
  });
  it('asks for it to come off when the event is deleted', () => {
    eq(listingAction(on, null).action, 'remove');
  });
  it('says nothing about an event that never had the tick', () => {
    eq(listingAction(off, off).action, '');
    eq(listingAction(off, { ...off, start_date: '2027-01-01' }).action, '');
    eq(listingAction(null, off).action, '');
    eq(listingAction(off, null).action, '');
  });
  it('is not fooled by a number that came back as a string', () => {
    eq(listingAction(on, { ...on, all_day: '1' }).action, '');
  });
  it('watches only what the page actually shows', () => {
    const cols = LISTING_FIELDS.map(([c]) => c);
    for (const c of ['start_date', 'status', 'venue', 'title', 'url']) {
      ok(cols.includes(c), c + ' goes on the page but is not watched');
    }
    for (const c of ['notes', 'needs', 'department', 'sub_types', 'updated_at']) {
      ok(!cols.includes(c), c + ' is watched but never reaches the page');
    }
  });
});

describe('the website channel message', () => {
  const item = { title: 'Sample Sale', start_date: '2026-11-07', end_date: '2026-11-08',
                 all_day: 1, status: 'Booked', venue: 'Jetty Flagship',
                 city: 'Manahawkin', state: 'NJ', url: 'https://jettylife.com/sale' };
  const m = (over) => listingMessage({ actorName: 'Jeremy', item, action: 'add',
                                       mentionId: 'U123', url: 'https://cal/?e=1', ...over });

  it('says what to do, and to which event', () => {
    const out = m();
    ok(out.includes('please add to the *Website Events page*: *Sample Sale*'), out);
    ok(out.includes('When: 2026-11-07 – 2026-11-08'), out);
    ok(out.includes('Where: Jetty Flagship · Manahawkin, NJ'), out);
    ok(out.includes('Link: https://jettylife.com/sale'), out);
  });
  // Escaping the mention would leave the literal text in the channel and
  // nobody would be told at all.
  it('addresses her as a mention that notifies', () => {
    ok(m().startsWith('<@U123> '), m());
  });
  it('still posts to the channel with nobody to address', () => {
    const out = m({ mentionId: '' });
    ok(!out.includes('<@'), out);
    ok(out.includes('please add to the *Website Events page*'), out);
  });
  it('still escapes what came off the event', () => {
    const out = listingMessage({ item: { ...item, title: 'Beer & <Sauce>' },
                                 action: 'add', mentionId: 'U1' });
    ok(out.includes('Beer &amp; &lt;Sauce&gt;'), out);
    ok(out.startsWith('<@U1> '), out);
  });
  it('says something different for a change and for a removal', () => {
    ok(m({ action: 'update', changed: ['start date'] })
      .includes('it has changed'), 'an update reads like a new request');
    ok(m({ action: 'update', changed: ['start date'] })
      .includes('Changed: start date'), 'an update does not say what moved');
    ok(m({ action: 'remove' }).includes('take this *off*'), 'a removal reads like a request');
  });
  it('offers no link on a removal, because there is nothing to open', () => {
    ok(!m({ action: 'remove' }).includes('https://cal'), m({ action: 'remove' }));
  });
});

describe('the website watch is wired the way it is meant to be', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const fn = idx.slice(idx.indexOf('const tellWebsite'));
  const body = fn.slice(0, fn.indexOf('\n  // Comments that mention you'));

  it('is the block this is about', () => {
    ok(fn.indexOf('\n  // Comments that mention you') > 0, 'the slice has no end');
    ok(/const tellWebsite = \(before, after\) => \{/.test(body), 'tellWebsite is not here');
  });
  it('fires on all three writes', () => {
    const calls = [...idx.matchAll(/tellWebsite\(/g)].map((x) => x.index);
    eq(calls.length, 3, 'called somewhere other than create, edit and delete');
    const create = idx.indexOf("if (path === '/api/items' && method === 'POST')");
    const del = idx.indexOf("if (method === 'DELETE')");
    const edit = idx.indexOf("if (method === 'PATCH' || method === 'PUT')");
    ok(create > 0 && del > create && edit > del, 'the write paths moved');
    ok(calls.some((c) => c > create && c < del), 'nothing tells the channel about a new event');
    ok(calls.some((c) => c > del && c < edit), 'nothing tells the channel about a deletion');
    ok(calls.some((c) => c > edit), 'nothing tells the channel about an edit');
  });
  it('decides with listingAction rather than working it out again', () => {
    ok(/listingAction\(before, after\)/.test(body),
       'the Worker re-implements the decision, which will drift from the tests');
  });
  it('is off until a channel is named', () => {
    ok(/if \(!env\.SLACK_BOT_TOKEN \|\| !env\.WEBSITE_CHANNEL\) return;/.test(body),
       'it would try to post with no channel');
  });
  // A website listing is work somebody else can pick up if she is away.
  it('posts in a channel rather than DMing', () => {
    ok(/postToChannel\(env\.SLACK_BOT_TOKEN, env\.WEBSITE_CHANNEL/.test(body),
       'it is not posting to the channel');
    ok(!/dmMentions/.test(body), 'it DMs, so nobody else can pick the work up');
  });
  it('still posts when there is nobody to address', () => {
    ok(/let mentionId = '';/.test(body) && /if \(want\) \{/.test(body),
       'an unset WEBSITE_WATCHER would stop the post rather than drop the ping');
  });
  it('never makes the save wait on Slack', () => {
    ok(/ctx\.waitUntil\(run\)/.test(body), 'the post is not deferred');
  });
});

// Two features wrote into the same box.
//
// The file-attachments list has owned .att-row, .att-name and #attList
// since attachments were added. "Who was there" arrived calling its rows
// .att-row too, so it rendered into the attachments box and its CSS
// restyled the attachment list -- in a page where both appear on the same
// modal. Caught by a browser test that could not find .att-n inside the
// .att-row it had matched, which is a confusing way to learn it.
describe('the event modal does not have two things sharing a class', () => {
  const page = fs.readFileSync(root('public/assets/calendar.js'), 'utf8');
  const css = fs.readFileSync(root('public/assets/calendar.css'), 'utf8');

  // Attachments own att-, who-was-there owns who-. Neither may use the
  // other's prefix.
  const ids = (src) => new Set([...src.matchAll(/id="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));

  it('gives the two lists different element ids', () => {
    const all = [...ids(page)];
    const att = all.filter((x) => /^att/.test(x));
    const who = all.filter((x) => /^who/.test(x));
    ok(att.length && who.length, 'one of the two lists has no ids at all: '
       + JSON.stringify({ att, who }));
    for (const x of who) {
      ok(!att.includes(x), x + ' is used by both lists');
    }
  });
  it('gives who-was-there its own class prefix', () => {
    for (const c of ['who-row', 'who-n', 'who-r', 'who-p', 'who-x', 'who-add']) {
      ok(page.includes('class="' + c + '"') || page.includes("'." + c + "'"),
         'the page no longer uses ' + c);
      ok(new RegExp('\\.' + c + '[{,: ]').test(css), c + ' is drawn by nothing');
    }
  });
  // The one that actually bit: a selector that matches both lists.
  it('does not style attachment rows from the attendance rules', () => {
    const block = css.slice(css.indexOf('/* ── Who was there ──'));
    ok(block.length > 200, 'the attendance CSS block has moved or gone');
    ok(!/\.att-/.test(block), 'the attendance CSS reaches into the attachments list');
  });
  it('keeps the attachments list on the names it has always had', () => {
    ok(/class="att-row"/.test(page), 'the attachments list lost its class');
    ok(/id="attList"/.test(page), 'the attachments list lost its id');
  });
});

// ── Undoing the split that ran twice ─────────────────────────

describe('taking away the SMS rows that were written twice', () => {
  const row = (id, subs, x) => ({ id, title: 'Jetty Rewards', start_date: '2026-11-02',
                                  department: 'marketing', sub_types: subs, ...x });
  const email = (id, x) => row(id, 'email', x);
  const sms = (id, x) => row(id, 'sms', x);

  it('leaves one copy where the split wrote two', () => {
    eq(planSmsDedupe([email('a'), sms('b'), sms('c')]), ['c']);
  });
  it('copes with three isolates, not just two', () => {
    eq(planSmsDedupe([email('a'), sms('b'), sms('c'), sms('d')]), ['c', 'd']);
  });
  it('does nothing to a send that came out right', () => {
    eq(planSmsDedupe([email('a'), sms('b')]), []);
    eq(planSmsDedupe([]), []);
    eq(planSmsDedupe(null), []);
  });
  // Two real sends of the same thing on the same day have two Email rows
  // between them, so neither copy is surplus.
  it('counts one copy per original, not one per group', () => {
    eq(planSmsDedupe([email('a'), email('a2'), sms('b'), sms('c')]), []);
  });
  // Deleting an unaccompanied send because it is unaccompanied would be the
  // worse bug by far.
  it('never touches an SMS with no Email twin', () => {
    eq(planSmsDedupe([sms('b'), sms('c'), sms('d')]), []);
  });
  it('tells sends apart by name, day and department', () => {
    eq(planSmsDedupe([email('a'), sms('b'), { ...sms('c'), start_date: '2026-11-09' }]), []);
    eq(planSmsDedupe([email('a'), sms('b'), { ...sms('c'), title: 'Something else' }]), []);
    eq(planSmsDedupe([email('a'), sms('b'), { ...sms('c'), department: 'jrf' }]), []);
  });
  // A send that had already gone out was never duplicated; it carries both
  // keys on one row, which makes it an original rather than a copy.
  it('reads a row carrying both keys as the original', () => {
    eq(planSmsDedupe([row('a', 'email,sms'), sms('b')]), []);
    eq(planSmsDedupe([row('a', 'email,sms')]), []);
    eq(planSmsDedupe([row('a', 'email,sms'), sms('b'), sms('c')]), ['c'],
       'the row carrying both was counted as a copy of itself');
  });
  // The split attached neither, so a copy that has them is not a copy.
  it('keeps a copy somebody has put a file or a comment on', () => {
    eq(planSmsDedupe([email('a'), sms('b', { attachment_count: 1 }), sms('c')]), ['c']);
    eq(planSmsDedupe([email('a'), sms('b', { comment_count: 2 }), sms('c')]), ['c']);
    eq(planSmsDedupe([email('a'), sms('b', { attachment_count: 1 }),
                      sms('c', { comment_count: 1 })]), [],
       'it deleted something somebody had added to');
  });
  it('is not a deadline cleanup', () => {
    eq(planSmsDedupe([email('a'), sms('b'),
                      { ...sms('c'), deadline_for: 'a' }]), []);
  });
  // Two isolates reading the same rows back in different orders must reach
  // the same answer, or one deletes what the other kept.
  it('does not depend on the order the rows came back in', () => {
    const rows = [email('a'), sms('b'), sms('c'), sms('d')];
    eq(planSmsDedupe([...rows].reverse()).sort(), planSmsDedupe(rows).sort());
  });
  it('keeps the other sub-types out of it', () => {
    eq(planSmsDedupe([row('a', 'paid-advo'), row('b', 'paid-advo')]), []);
  });
});

describe('a migration takes its key before it works', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');

  // Read meta, do the work, write meta is a check and then an act with
  // nothing holding the two together -- and the flag in front of it is per
  // isolate. It never showed until a migration INSERTed.
  it('claims with an atomic insert rather than a read', () => {
    const at = idx.indexOf('async function claim(db, key)');
    ok(at > 0, 'there is no claim at all');
    const body = idx.slice(at, idx.indexOf('\n}', at));
    ok(/INSERT OR IGNORE INTO meta/.test(body), 'the claim is not atomic');
    ok(/changes/.test(body), 'nothing checks whether this caller won');
  });
  // The two that write rows. The older ones only ever update to a fixed
  // value, so running them twice is running them once.
  it('is used by every migration that creates or deletes rows', () => {
    for (const fn of ['migrateEmailSmsSplit', 'repairDoubledSms',
                      'backfillDeadlines']) {
      const at = idx.indexOf('async function ' + fn);
      ok(at > 0, fn + ' is missing');
      const body = idx.slice(at, idx.indexOf('\n}', at));
      ok(/if \(!\(await claim\(db, [A-Z_]+\)\)\) return;/.test(body),
         fn + ' still reads meta and then acts on it');
      ok(!/SELECT value FROM meta WHERE key = \?/.test(body),
         fn + ' still has the old check-then-act guard');
    }
  });
  it('is wired in, and after the split it is undoing', () => {
    ok(/await repairDoubledSms\(db\)/.test(idx), 'the repair never runs');
    ok(idx.indexOf('await migrateEmailSmsSplit(db)') < idx.indexOf('await repairDoubledSms(db)'),
       'the repair runs before the thing it repairs');
  });
});

// ── Deadlines the calendar sets for itself ──────────────────────

describe('when a deadline falls', () => {
  const item = (x) => ({ id: 'i1', title: 'Spring Launch', department: 'marketing',
                         status: 'Booked', start_date: '2026-06-01', ...x });

  it('is three weeks before a Paid Advo', () => {
    eq(deadlineFor(item({ sub_types: 'paid-advo' })).start_date, '2026-05-11');
    eq(leadFor(item({ sub_types: 'paid-advo' })), 21);
  });
  it('is ten days before an Email', () => {
    eq(deadlineFor(item({ sub_types: 'email' })).start_date, '2026-05-22');
    eq(leadFor(item({ sub_types: 'email' })), 10);
  });
  // SMS was split off Email precisely because it does not carry one.
  it('does not exist for an SMS', () => {
    eq(deadlineFor(item({ sub_types: 'sms' })), null);
    eq(leadFor(item({ sub_types: 'sms' })), 0);
    eq(leadFor(item({ sub_types: 'campaign-promotion,sms,website' })), 0);
  });
  // Two items with the same name on two dates is the thing somebody works
  // to the wrong one of.
  it('is one deadline at the longer lead when an item is both', () => {
    eq(leadFor(item({ sub_types: 'email,paid-advo' })), 21);
    eq(leadFor(item({ sub_types: 'paid-advo,email' })), 21);
  });
  it('carries the source item name behind the prefix', () => {
    eq(deadlineFor(item({ sub_types: 'email' })).title,
       'Sunnyside Deadline: Spring Launch');
    eq(PREFIX, 'Sunnyside Deadline: ');
  });
  // The title column takes 200, and the prefix has to be inside that.
  it('does not build a title longer than the column takes', () => {
    eq(deadlineTitle('x'.repeat(400)).length, 200);
  });
  it('is a point, not a span', () => {
    const d = deadlineFor(item({ sub_types: 'email' }));
    eq(d.start_date, d.end_date);
    eq(d.event_type, 'deadline');
    eq(d.all_day, 1);
  });
  it('lands on the source department, not on Marketing by assumption', () => {
    eq(deadlineFor(item({ sub_types: 'paid-advo', department: 'jrf' })).department, 'jrf');
  });
  // A deadline still showing Booked for a placement that was called off is
  // the thing somebody keeps working to.
  it('follows the item into Cancelled', () => {
    eq(deadlineFor(item({ sub_types: 'email', status: 'Cancelled' })).status, 'Cancelled');
    eq(deadlineFor(item({ sub_types: 'email', status: 'Pending' })).status, 'Booked');
  });
  it('points back at the item it belongs to', () => {
    eq(deadlineFor(item({ sub_types: 'email' })).deadline_for, 'i1');
  });

  // new Date('2026-01-01') is UTC midnight and lands on the previous day
  // west of Greenwich, which is where this calendar is.
  it('counts back across a month and a year end', () => {
    eq(minusDays('2026-03-02', 10), '2026-02-20');
    eq(minusDays('2026-01-05', 21), '2025-12-15');
    eq(minusDays('2028-03-05', 10), '2028-02-24', 'a leap year was miscounted');
  });
  it('gives nothing for a date it cannot read', () => {
    eq(minusDays('', 10), '');
    eq(minusDays('next tuesday', 10), '');
    eq(deadlineFor(item({ sub_types: 'email', start_date: '' })), null);
  });
});

describe('keeping a deadline in step', () => {
  const item = (x) => ({ id: 'i1', title: 'Spring Launch', department: 'marketing',
                         status: 'Booked', start_date: '2026-06-01',
                         sub_types: 'paid-advo', ...x });
  const its = (x) => deadlineFor(item(x));

  it('makes one that is not there', () => {
    eq(deadlineAction(item(), null), 'create');
  });
  // Most saves touch none of what a deadline is built from, and rewriting
  // the row on each of them would bury the real changes in its history.
  it('does nothing when nothing it reads has changed', () => {
    eq(deadlineAction(item(), its()), '');
    eq(deadlineAction(item({ notes: 'Confirmed' }), its()), '');
  });
  it('moves one when the item moves', () => {
    eq(deadlineAction(item({ start_date: '2026-07-01' }), its()), 'update');
  });
  it('renames one when the item is renamed', () => {
    eq(deadlineAction(item({ title: 'Autumn Launch' }), its()), 'update');
  });
  it('cancels one when the item is cancelled', () => {
    eq(deadlineAction(item({ status: 'Cancelled' }), its()), 'update');
  });
  // The one that would otherwise be left pointing at a date nothing
  // happens on.
  it('takes one away when the sub-type comes off', () => {
    eq(deadlineAction(item({ sub_types: 'campaign-promotion' }), its()), 'delete');
    eq(deadlineAction(null, its()), 'delete');
  });
  it('does not try to delete one that was never there', () => {
    eq(deadlineAction(item({ sub_types: 'sms' }), null), '');
    eq(deadlineAction(null, null), '');
  });
  // The keys are spelled once in the taxonomy and read here, so renaming one
  // cannot leave this watching a sub-type nothing carries.
  it('watches keys the taxonomy actually has', () => {
    for (const k of WATCHED_SUBS) {
      ok(SUB_TYPES.some((x) => x.key === k), k + ' is not a sub-type');
    }
    eq(WATCHED_SUBS.includes('sms'), false, 'SMS is not meant to have one');
  });
});

describe('the Worker writes the deadline it worked out', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const at = idx.indexOf('const keepDeadline');
  const body = idx.slice(at, idx.indexOf('const requireEditor'));

  it('exists, and is reached from all three write paths', () => {
    ok(at > 0, 'there is no deadline writer');
    const calls = [...idx.matchAll(/keepDeadline\(/g)].map((m) => m.index);
    eq(calls.length, 2, 'called somewhere other than the create and the edit');
    const post = idx.indexOf("path === '/api/items' && method === 'POST'");
    const patch = idx.indexOf("if (method === 'PATCH' || method === 'PUT')");
    ok(calls.some((c) => c > post && c < patch), 'nothing happens on a create');
    ok(calls.some((c) => c > patch), 'nothing happens on an edit');
    ok(/DELETE FROM items WHERE deadline_for = \?'\)\.bind\(id\)/.test(idx),
       'deleting an item leaves its deadline behind');
  });
  // The same blanking rules as a typed deadline, and the same validation.
  it('goes through normalise rather than straight into SQL', () => {
    ok(/normalise\(coerceKeys\(want\), null\)/.test(body),
       'the row is assembled by hand, so the blanking rules can drift');
  });
  // A deadline somebody typed is theirs, whatever it happens to be about.
  it('only ever touches rows it made', () => {
    ok(/deadline_for IS NOT NULL/.test(body),
       'the delete would take a hand-typed deadline with it');
    ok(/WHERE deadline_for = \?/.test(body), 'it does not find its own row by the link');
  });
  // Deferring it would mean the caller re-reads the calendar before the
  // deadline exists, which reads as the feature not working.
  it('finishes before the response goes back', () => {
    ok(/await keepDeadline\(/.test(idx), 'the write is not awaited');
    ok(!/waitUntil\([^)]*keepDeadline/.test(idx), 'it was deferred');
  });
  // CREATE TABLE IF NOT EXISTS never revisits a table that exists.
  it('adds its column to a database that already exists', () => {
    const added = idx.slice(idx.indexOf('const ADDED_COLUMNS'));
    ok(/'deadline_for TEXT'/.test(added.slice(0, added.indexOf('];'))),
       'the column reaches schema.sql but never the live database');
  });
  // deadline_for is not in COLS on purpose: COLS is what a normal save
  // writes, and a save that wrote it would blank the link on every edit.
  it('keeps the link out of the ordinary write columns', () => {
    const cols = idx.slice(idx.indexOf('const COLS = ['), idx.indexOf('];', idx.indexOf('const COLS = [')));
    ok(!/deadline_for/.test(cols),
       'an ordinary edit of a deadline would cut it loose from its item');
  });
});

// ── Email and SMS, split apart again ─────────────────────────────

describe('splitting Email/SMS back into two', () => {
  const TODAY = '2026-10-27';
  const row = (date, subs) => ({ start_date: date, sub_types: subs });

  // It really was both. Splitting history in two would invent a send that
  // never went out.
  it('leaves a send that has gone out as one item carrying both', () => {
    eq(planEmailSplit(row('2026-09-01', 'email-sms'), TODAY),
       { keep: 'email,sms', copy: null });
  });
  it('counts today as already gone', () => {
    eq(planEmailSplit(row(TODAY, 'email-sms'), TODAY).copy, null);
  });
  it('splits a send still to come into two', () => {
    eq(planEmailSplit(row('2026-12-01', 'email-sms'), TODAY),
       { keep: 'email', copy: 'sms' });
  });
  it('keeps the other sub-types on both halves, in taxonomy order', () => {
    eq(planEmailSplit(row('2026-12-01', 'email-sms,campaign-promotion'), TODAY),
       { keep: 'campaign-promotion,email', copy: 'campaign-promotion,sms' });
  });
  it('leaves a row that never carried the key alone', () => {
    eq(planEmailSplit(row('2026-12-01', 'paid-advo'), TODAY), null);
    eq(planEmailSplit(row('2026-12-01', ''), TODAY), null);
    eq(planEmailSplit({}, TODAY), null);
  });
  // A second pass must not make a third item.
  it('is idempotent: an already split row plans nothing', () => {
    eq(planEmailSplit(row('2026-12-01', 'email'), TODAY), null);
    eq(planEmailSplit(row('2026-09-01', 'email,sms'), TODAY), null);
  });
  it('never leaves a key on both sides of the split', () => {
    const p = planEmailSplit(row('2026-12-01', 'email-sms,email,sms'), TODAY);
    eq([p.keep, p.copy], ['email', 'sms']);
  });
  it('only ever produces keys the taxonomy knows', () => {
    for (const d of ['2026-09-01', '2026-12-01']) {
      const p = planEmailSplit(row(d, 'email-sms,website'), TODAY);
      for (const k of (p.keep + ',' + (p.copy || '')).split(',').filter(Boolean)) {
        ok(SUB_TYPES.some((x) => x.key === k), k + ' is not a sub-type');
      }
    }
  });
  it('is applied by a migration that records having run', () => {
    const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
    ok(/const EMAIL_SPLIT_KEY = /.test(idx), 'the migration is not guarded');
    ok(/await migrateEmailSmsSplit\(db\)/.test(idx), 'nothing ever calls it');
    const at = idx.indexOf('async function migrateEmailSmsSplit');
    const body = idx.slice(at, idx.indexOf('// One-time: Event and Marketing', at));
    ok(/UPDATE meta SET value = \?/.test(body),
       'it does not record what it did');
    ok(/planEmailSplit\(row, today\)/.test(body), 'it decides this for itself');
    // Somebody subscribed to the sends should keep getting them.
    ok(/UPDATE feeds SET filters/.test(body), 'a saved sync would go quiet');
  });
});

// ── Boxy Bucks ──────────────────────────────────────────────────────────

describe('the staff roster it runs on', () => {
  it('is the Employee Headcount view, with nobody duplicated', () => {
    ok(BOXY_STAFF.length > 50, 'only ' + BOXY_STAFF.length + ' people came across');
    eq(new Set(BOXY_STAFF.map((p) => p.k)).size, BOXY_STAFF.length, 'duplicate keys');
    ok(/^\d{4}-\d{2}-\d{2}$/.test(BOXY_AS_OF), BOXY_AS_OF);
  });
  it('gives everybody a name and a key the Worker will accept back', () => {
    for (const p of BOXY_STAFF) {
      ok(p.n && p.n.trim(), p.k + ' has no name');
      ok(staffMember(p.k), p.k + ' is not findable by its own key');
    }
  });
  // Most of this roster signs in with gmail or icloud. None of it is needed:
  // they are the subjects of the leaderboard, not its users.
  it('carries no email addresses', () => {
    ok(!JSON.stringify(BOXY_STAFF).includes('@'), 'an address got into the seed');
  });
  it('strips the org-chart numbering off a name', () => {
    for (const p of BOXY_STAFF) {
      ok(!/^\d+\s*-/.test(p.n), p.n + ' still carries its org-chart prefix');
    }
  });
  it('offers the picker an alphabetical list', () => {
    const names = pickable().map((p) => p.n.toLowerCase());
    eq(names, [...names].sort());
  });
});

describe('what a role is worth', () => {
  it('has a default for every role', () => {
    for (const r of ROLES) ok(Number.isInteger(r.points) && r.points > 0, r.key);
  });
  it('reads overrides out of config', () => {
    eq(pointsFromConfig('worked:5,attended:2'),
       { worked: 5, volunteered: 2, attended: 2 });
  });
  // A typo in config should not silently stop an event being worth anything.
  it('keeps the built-in value for anything it cannot read', () => {
    eq(pointsFromConfig('worked:abc,bogus:9,volunteered:'),
       { worked: 2, volunteered: 2, attended: 1 });
    eq(pointsFromConfig(''), { worked: 2, volunteered: 2, attended: 1 });
    eq(pointsFromConfig(null), { worked: 2, volunteered: 2, attended: 1 });
  });
  it('agrees with the value actually shipped in wrangler.toml', () => {
    const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
    const m = toml.match(/^BOXY_POINTS = "([^"]*)"/m);
    ok(m, 'BOXY_POINTS is missing from wrangler.toml');
    const shipped = pointsFromConfig(m[1]);
    const builtIn = Object.fromEntries(ROLES.map((r) => [r.key, r.points]));
    eq(shipped, builtIn,
       'config and fallback disagree, so an empty BOXY_POINTS would quietly '
       + 'change what an event is worth');
  });
  it('refuses a negative default', () => {
    eq(pointsFromConfig('worked:-5').worked, 2);
  });
});

describe('adding somebody to an event', () => {
  const who = BOXY_STAFF[0].k;
  const pts = { worked: 5, volunteered: 2, attended: 1 };

  // An event costed when Worked was worth 3 must not silently become worth
  // 5 because the default changed a month afterwards, so the number is
  // written onto the row rather than looked up later.
  it('writes the default onto the row rather than leaving it to be looked up', () => {
    eq(cleanEntry({ person: who, role: 'worked' }, pts).row.points, 5);
    eq(cleanEntry({ person: who, role: 'attended' }, pts).row.points, 1);
  });
  it('takes an override for this one event', () => {
    eq(cleanEntry({ person: who, role: 'worked', points: '12' }, pts).row.points, 12);
    eq(cleanEntry({ person: who, role: 'worked', points: 0 }, pts).row.points, 0,
       'a deliberate zero was overwritten by the default');
  });
  it('refuses somebody who is not on the staff list', () => {
    ok(cleanEntry({ person: 'nobody-at-all', role: 'worked' }, pts).errors);
    ok(cleanEntry({ role: 'worked' }, pts).errors);
  });
  it('refuses a role that does not exist', () => {
    ok(cleanEntry({ person: who, role: 'helped' }, pts).errors);
    ok(cleanEntry({ person: who }, pts).errors);
  });
  it('refuses points that are not a plausible number', () => {
    ok(cleanEntry({ person: who, role: 'worked', points: '-5' }, pts).errors);
    ok(cleanEntry({ person: who, role: 'worked', points: 'lots' }, pts).errors);
    ok(cleanEntry({ person: who, role: 'worked', points: '99999' }, pts).errors);
  });
});

describe('spending and corrections', () => {
  const who = BOXY_STAFF[0].k;
  // The real list is in wrangler.toml; a test that used it would pass for
  // the wrong reason the day somebody leaves.
  const CO = 'Ada Lovelace,Grace Hopper';
  const spend = (extra) => cleanLedger(
    Object.assign({ person: who, kind: 'spend', points: '3',
                    checkedBy: 'Grace Hopper' }, extra || {}), CO);

  // Entered positive, stored as a debit, so nobody has to remember a minus.
  it('stores a spend as a debit however it was typed', () => {
    eq(spend({ points: '12' }).row.points, -12);
    eq(spend({ points: '-12' }).row.points, -12);
  });
  // A correction can go either way.
  it('signs a correction however it was typed', () => {
    const add = (over) => cleanLedger(
      Object.assign({ person: who, kind: 'adjust', note: 'Trade show' }, over), CO);
    eq(add({ points: '5' }).row.points, 5);
    eq(add({ points: '-5' }).row.points, -5);
  });
  it('refuses zero, which moves nothing', () => {
    ok(cleanLedger({ person: who, kind: 'adjust', points: '0', note: 'x' }, CO).errors);
  });
  // A spend is explained by its own fields -- the day, the count, who
  // handed the samples over. Boxy Bucks arriving on a balance have none
  // of that, so the reason is the only record of why.
  it('will not add Boxy Bucks with nothing said about them', () => {
    const out = cleanLedger({ person: who, kind: 'adjust', points: '5' }, CO);
    ok(out.errors && out.errors.join(' ').includes('What are these for?'));
    ok(!cleanLedger({ person: who, kind: 'adjust', points: '5',
                      note: 'Ran the Asbury booth' }, CO).errors);
  });
  it('refuses a kind it does not know', () => {
    ok(cleanLedger({ person: who, kind: 'earn', points: '5' }, CO).errors);
  });

  // ── A spend is a checkout: so many samples, on a day, by somebody ──
  //
  // One Boxy Buck is one free sample, so a spend is stock going out the
  // door. The note used to be the only thing explaining it; now the date
  // and the name do that, and better.
  it('is one free sample per Boxy Buck', () => {
    eq(SAMPLE_PER_POINT, 1);
  });
  it('records who handed the samples over', () => {
    eq(spend({ checkedBy: 'Ada Lovelace' }).row.checkedBy, 'Ada Lovelace');
  });
  it('will not take a spend with nobody against it', () => {
    ok(spend({ checkedBy: '' }).errors);
    ok(spend({ checkedBy: '   ' }).errors);
  });
  // Otherwise the list is decoration: anything typed would be accepted,
  // including a name nobody can be held to.
  it('will not take a name that is not on the checkout list', () => {
    ok(spend({ checkedBy: 'Somebody Else' }).errors);
  });
  // An empty list has to fail closed. Falling back to "anyone" would turn
  // a missing config into an unaudited cupboard.
  it('takes nobody at all when the checkout list is empty', () => {
    ok(cleanLedger({ person: who, kind: 'spend', points: '3',
                     checkedBy: 'Grace Hopper' }, '').errors);
    eq(checkoutNames(''), []);
    eq(checkoutNames(null), []);
  });
  it('reads the checkout list off config, trimming as it goes', () => {
    eq(checkoutNames(' Ada Lovelace , Grace Hopper ,, '),
       ['Ada Lovelace', 'Grace Hopper']);
  });
  it('keeps the two lists in the form each is read as', () => {
    const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
    const admins = toml.match(/^BOXY_ADMINS = "([^"]*)"/m);
    ok(admins, 'BOXY_ADMINS is missing from wrangler.toml');
    for (const who of admins[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      ok(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who),
         '"' + who + '" is not an address, so it lets nobody in');
      eq(who, who.toLowerCase(), who + ' is not lower case');
    }
    for (const who of checkoutNames(
      (toml.match(/^BOXY_CHECKOUT = "([^"]*)"/m) || ['', ''])[1])) {
      ok(!who.includes('@'),
         '"' + who + '" is an address, and this list is shown to people');
    }
  });

  it('ships a checkout list in wrangler.toml', () => {
    const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
    const m = toml.match(/^BOXY_CHECKOUT = "([^"]*)"/m);
    ok(m, 'BOXY_CHECKOUT is missing from wrangler.toml');
    ok(checkoutNames(m[1]).length >= 2,
       'the shipped list would stop any spend being recorded');
  });

  // The day somebody got round to typing it in is not the day the samples
  // went, and a Monday entry for a Saturday event should say Saturday.
  it('takes the day the samples were actually taken', () => {
    eq(spend({ onDate: '2026-10-24' }).row.onDate, '2026-10-24');
  });
  it('defaults to today when no day is given', () => {
    eq(spend({}).row.onDate, new Date().toISOString().slice(0, 10));
  });
  it('refuses something that is not a date', () => {
    ok(spend({ onDate: 'last tuesday' }).errors);
    ok(spend({ onDate: '24/10/2026' }).errors);
  });
  it('counts samples whole', () => {
    ok(spend({ points: '2.5' }).errors);
  });

  // The note carried the whole explanation when there was nothing else;
  // date, count and name carry it now, so it is offered, not demanded.
  it('no longer demands a note, now the checkout says who and when', () => {
    ok(!spend({ note: '' }).errors);
    eq(spend({ note: ' Sample pack ' }).row.note, 'Sample pack');
  });
  // A correction is bookkeeping, not a handover, so it asks for neither.
  it('asks a correction for neither a name nor a day', () => {
    const r = cleanLedger({ person: who, kind: 'adjust', points: '5',
                            note: 'Trade show' }, CO).row;
    eq([r.checkedBy, r.onDate], ['', '']);
  });
});

// A checkout that reached the page but not the database would be a form
// that quietly throws two of its three fields away.
describe('a checkout survives the round trip', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const schema = fs.readFileSync(root('worker/schema.sql'), 'utf8');
  const ledger = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS boxy_ledger'));
  const table = ledger.slice(0, ledger.indexOf(');'));

  it('has somewhere to put the day and the name', () => {
    for (const col of ['on_date', 'checked_by']) {
      ok(new RegExp('\\b' + col + '\\s+TEXT').test(table),
         col + ' is not a column on boxy_ledger');
    }
  });
  // boxy_ledger already exists in production, and CREATE TABLE IF NOT
  // EXISTS never revisits a table that is already there. This is the
  // seventh time this has bitten; the test is cheaper than the eighth.
  it('adds both columns to a database that already has the table', () => {
    const at = idx.indexOf('const ADDED_LEDGER_COLUMNS');
    ok(at > 0, 'there is no migration for the ledger at all');
    const list = idx.slice(at, idx.indexOf('];', at));
    for (const col of ['on_date TEXT', 'checked_by TEXT']) {
      ok(list.includes("'" + col + "'"),
         col + ' reaches schema.sql but never a live database');
    }
    ok(/\['boxy_ledger', ADDED_LEDGER_COLUMNS\]/.test(idx),
       'the list exists but nothing runs it');
  });
  it('writes both of them on the way in', () => {
    const at = idx.indexOf("path === '/api/boxy/ledger' && method === 'POST'");
    const body = idx.slice(at, at + 1800);
    ok(/INSERT INTO boxy_ledger[\s\S]*on_date, checked_by/.test(body),
       'the insert does not name the new columns');
    ok(/r\.onDate \|\| null/.test(body) && /r\.checkedBy \|\| null/.test(body),
       'the cleaned values are not bound');
    ok(/cleanLedger\(body, env\.BOXY_CHECKOUT\)/.test(body),
       'the checkout list never reaches the validator, so any name would do');
  });
  it('reads both of them back out again', () => {
    const at = idx.indexOf("path === '/api/boxy/person'");
    const body = idx.slice(at, at + 1600);
    ok(/on_date, checked_by/.test(body), 'the person query does not select them');
    ok(/on: r\.on_date/.test(body) && /checkedBy: r\.checked_by/.test(body),
       'they are selected but never returned');
  });
  it('hands the page the list it has to choose from', () => {
    const at = idx.indexOf("path === '/api/boxy' && method === 'GET'");
    const body = idx.slice(at, idx.indexOf("path === '/api/boxy/person'"));
    ok(/checkout: boxyCheckout\(\)/.test(body), 'the page gets no checkout list');
    ok(/today: new Date\(\)/.test(body), 'the page gets no date to default to');
  });
});

describe('the leaderboard', () => {
  const [a, b] = BOXY_STAFF.map((p) => p.k);
  const build = (earned, moved) => leaderboard(earned, moved);

  // A board that lists only the people already on it cannot be used to
  // notice who is being left out of events, which is half of what it is for.
  it('lists everybody, including people on nothing yet', () => {
    eq(build([], []).length, BOXY_STAFF.length);
  });
  it('adds up what somebody earned, and counts their events', () => {
    const row = build([{ person: a, role: 'worked', points: 3 },
                       { person: a, role: 'attended', points: 1 }], [])
      .find((r) => r.k === a);
    eq([row.earned, row.events, row.byRole.worked, row.byRole.attended], [4, 2, 1, 1]);
  });
  it('takes spending off the balance and leaves earned alone', () => {
    const row = build([{ person: a, role: 'worked', points: 10 }],
                      [{ person: a, points: -4 }]).find((r) => r.k === a);
    eq([row.earned, row.spent, row.balance], [10, 4, 6]);
  });
  // "Spent" reading higher than what they actually took would be the
  // confusing half.
  it('counts an upward correction as earned, not as un-spent', () => {
    const row = build([], [{ person: a, points: 5 }]).find((r) => r.k === a);
    eq([row.earned, row.spent, row.balance], [5, 0, 5]);
  });
  it('ignores a row for somebody no longer on the roster', () => {
    const board = build([{ person: 'left-the-company', role: 'worked', points: 9 }], []);
    eq(board.length, BOXY_STAFF.length);
    eq(standings(board).earned, 0);
  });
  // The board is about turning up; ordering by balance would put whoever
  // has spent least on top.
  it('ranks by what was earned, not by what is left', () => {
    const board = build([{ person: a, role: 'worked', points: 10 },
                         { person: b, role: 'worked', points: 4 }],
                        [{ person: a, points: -9 }]);
    eq(board[0].k, a, 'the biggest spender fell down the board');
    eq([board[0].balance, board[1].balance], [1, 4]);
  });
  it('totals the strip above the table', () => {
    const board = build([{ person: a, role: 'worked', points: 10 },
                         { person: b, role: 'attended', points: 1 }],
                        [{ person: a, points: -4 }]);
    eq(standings(board), { people: BOXY_STAFF.length, onTheBoard: 2,
                           earned: 11, spent: 4, outstanding: 7 });
  });
  it('copes with nothing at all', () => {
    eq(standings(build([], [])).earned, 0);
    eq(build(null, null).length, BOXY_STAFF.length);
  });
  it('downloads with a row per person and a column per role', () => {
    const out = boxyCsv(build([], []));
    const lines = out.trim().split('\n');
    eq(lines.length, BOXY_STAFF.length + 1);
    for (const r of ROLES) ok(lines[0].includes(r.label), r.label + ' is not a column');
  });
});

// The leaderboard decides what people get, which is a different job from
// running an event -- so it is not the editor list.
describe('who the calendar lets edit', () => {
  const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
  const list = (name) => ((toml.match(new RegExp('^' + name + ' = "([^"]*)"', 'm')) || ['', ''])[1])
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

  // An editor on a domain Access blocks is a line of config that looks right
  // and does nothing: they meet a sign-in wall, not a permissions message,
  // and nothing on the calendar says who to ask.
  it('only names people Cloudflare Access will let in', () => {
    const domains = list('ACCESS_DOMAINS');
    ok(domains.length, 'ACCESS_DOMAINS is missing from wrangler.toml');
    const editors = list('CALENDAR_EDITORS');
    ok(editors.length > 5, 'only ' + editors.length + ' editors');
    for (const who of editors) {
      ok(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who), '"' + who + '" is not an address');
      ok(domains.includes(who.split('@')[1]),
         who + ' is on a domain Access does not admit');
    }
  });
  // She is told about every Paid Advo change and is expected to act on it,
  // which she cannot do read-only.
  it('lets the SunnySide watcher edit, not only watch', () => {
    for (const who of list('PAID_ADVO_WATCHERS')) {
      ok(list('CALENDAR_EDITORS').includes(who),
         who + ' is pinged about Paid Advo changes but cannot make one');
    }
  });
});

describe('who can open Boxy Bucks', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');

  it('is its own list, falling back to the editors rather than to nobody', () => {
    ok(/env\.BOXY_ADMINS/.test(idx), 'there is no list of its own');
    const fn = idx.slice(idx.indexOf('const boxyAdmins'));
    ok(/env\.CALENDAR_EDITORS/.test(fn.slice(0, 500)),
       'an empty BOXY_ADMINS would lock everybody out');
  });
  it('gates the leaderboard and the ledger, and 404s rather than 403s', () => {
    for (const route of ["path === '/api/boxy' && method === 'GET'",
                         "path === '/api/boxy/ledger' && method === 'POST'"]) {
      const at = idx.indexOf(route);
      ok(at > 0, 'route missing: ' + route);
      const body = idx.slice(at, at + 400);
      ok(/if \(!isBoxyAdmin\(\)\)/.test(body), route + ' is not gated');
      ok(/'Unknown endpoint\.' \}, 404\)/.test(body), route + ' answers 403, which confirms it exists');
    }
  });
  it('wants a verified Access identity, not just an address', () => {
    ok(/const isBoxyAdmin = \(\) => Boolean\(who\.email\) && who\.verified/.test(idx),
       'isBoxyAdmin ignores verification');
  });
  // Running an event and running the rewards are different jobs, but adding
  // people to an event is part of running one.
  it('lets any editor record who was there', () => {
    const at = idx.indexOf('const attMatchBoxy');
    const body = idx.slice(at, idx.indexOf('// The leaderboard', at));
    ok(/const denied = requireEditor\(\); if \(denied\) return denied;/.test(body),
       'recording attendance is not gated on editors');
    ok(!/isBoxyAdmin/.test(body), 'recording attendance needs the rewards list');
  });
});

// Clicking a name on the leaderboard: what they turned up to, and what has
// moved their balance since.
describe('one person on the leaderboard', () => {
  const evs = [
    { item_id: '1', title: 'Clam Jam', start_date: '2026-07-11', role: 'volunteered', points: 2 },
    { item_id: '2', title: 'Chowderfest', start_date: '2026-10-04', role: 'worked', points: 2 },
    { item_id: '3', title: 'Tent Sale', start_date: '2026-11-07', role: 'worked', points: 5 },
  ];
  const led = [
    { kind: 'spend', points: -3, note: 'Hoodie', at: '2026-10-10T00:00:00Z' },
    { kind: 'adjust', points: 2, note: 'Missed one', at: '2026-10-12T00:00:00Z' },
  ];

  // A leaderboard is about recent effort; scrolling to the bottom to find
  // out what somebody did last month is the wrong way round.
  it('puts the most recent event first', () => {
    eq(personSummary(evs, []).events.map((e) => e.start_date),
       ['2026-11-07', '2026-10-04', '2026-07-11']);
  });
  it('puts the most recent balance movement first', () => {
    eq(personSummary([], led).ledger.map((m) => m.note), ['Missed one', 'Hoodie']);
  });
  it('counts events and points per role', () => {
    const out = personSummary(evs, []);
    eq(out.byRole.worked, { events: 2, points: 7 });
    eq(out.byRole.volunteered, { events: 1, points: 2 });
    eq(out.byRole.attended, { events: 0, points: 0 });
  });
  // "Why is this number 8" is not answered by the events alone the moment
  // anybody has spent anything.
  it('adds the ledger into the totals the same way the board does', () => {
    const out = personSummary(evs, led);
    eq([out.earned, out.spent, out.balance], [11, 3, 8]);
  });
  it('counts an upward correction as earned, matching the board', () => {
    const one = personSummary([], [{ kind: 'adjust', points: 5, at: 'x' }]);
    eq([one.earned, one.spent, one.balance], [5, 0, 5]);
  });
  // The person panel and the board are two renderings of the same numbers.
  // They disagreeing is the kind of thing somebody notices as "the maths is
  // wrong" without being able to say where.
  it('agrees with the board for the same person', () => {
    const k = BOXY_STAFF[0].k;
    const row = leaderboard(evs.map((e) => ({ ...e, person: k })),
                            led.map((m) => ({ ...m, person: k })))
      .find((r) => r.k === k);
    const one = personSummary(evs, led);
    eq([one.earned, one.spent, one.balance], [row.earned, row.spent, row.balance]);
    eq(one.byRole.worked.events, row.byRole.worked);
  });
  it('copes with somebody on nothing at all', () => {
    const out = personSummary([], []);
    eq([out.earned, out.spent, out.balance, out.events.length], [0, 0, 0, 0]);
    eq(personSummary(null, null).balance, 0);
  });
  it('does not reorder the caller’s own arrays', () => {
    const mine = evs.slice();
    personSummary(mine, []);
    eq(mine.map((e) => e.item_id), ['1', '2', '3'], 'the input was sorted in place');
  });
});

describe('the person endpoint is gated like the board', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const at = idx.indexOf("path === '/api/boxy/person'");

  it('exists', () => ok(at > 0, 'there is no person endpoint'));
  it('refuses anybody not on the rewards list, with a 404', () => {
    const body = idx.slice(at, at + 300);
    ok(/if \(!isBoxyAdmin\(\)\) return json\(\{ error: 'Unknown endpoint\.' \}, 404\);/.test(body),
       'the detail is readable by people who cannot read the summary');
  });
  // The key comes off the query string, so it has to be cleaned and checked
  // against the roster before it reaches a query.
  it('only answers for somebody on the roster', () => {
    const body = idx.slice(at, at + 600);
    ok(/boxyKey\(url\.searchParams\.get\('key'\)\)/.test(body), 'the key is not cleaned');
    ok(/staffMember\(key\)/.test(body), 'any key would be queried for');
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
