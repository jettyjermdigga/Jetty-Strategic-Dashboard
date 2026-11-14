// What the dash decides, tested without a browser or a network.
//
// The one rule worth guarding: not knowing somebody's groups must show less,
// never more. A portal that falls open when an endpoint times out is a worse
// failure than one that goes quiet.

import { visibleTiles, tileSections, linkSections, dashCategories, linkCats, greeting, TILES, GROUPS, CATEGORIES, CAT_MOVES, GROUP_MOVES, EVERYONE } from '../worker/tiles.js';
import { groupsFor, roster, PEOPLE } from '../worker/people.js';
import { cleanTile, cleanPerson, cleanLink, cleanKey, cleanUrl } from '../worker/clean.js';
import { canonicalTarget } from '../worker/canon.js';
import {
  cleanPick, cleanDate as mDate, mondayOf, youtubeId, isYouTube,
  weekLabel, missingMondays,
} from '../worker/music.js';
import {
  rows as budgetRows, value, spread, summary, csv, cleanLine, cleanYear,
  calendar, WEEK_CURVE, CURVE_IS_PLACEHOLDER, LINES as BUDGET_LINES, NEW_LINES,
  BASELINE_YEAR, FIRST_YEAR, LAST_YEAR, cleanLaborYear,
  GROUPS as BUDGET_GROUPS, CADENCES,
} from '../worker/budget.js';
import { periods, weekCounts, weekStart } from '../worker/retail.js';
import { LINES as SEED_LINES } from '../worker/budget-seed.js';
import {
  rows as laborRows, cost, decided, byDepartment, summary as laborSummary,
  against, cleanPerson as cleanLaborPerson, cleanKey as laborKey, csv as laborCsv,
  num, rollOf, PEOPLE as ROSTER, ON_STAFF, SEPARATE_DIVISIONS,
  PAY_TYPES, CLASSES, ROLLUPS, FULL_TIME_HOURS, ROSTER_AS_OF,
  withPrior, matches, SHOWS, FT_TYPES, DIVISIONS, PAYROLL_TAX_RATE,
} from '../worker/labor.js';

import {
  rows as cogsRows, summary as cogsSummary, duplicates as cogsDuplicates,
  seasonOptions as cogsSeasons, matches as cogsMatches, cleanLine as cogsClean,
  csv as cogsCsv, lineId as cogsLineId, cleanSeasonKey,
  SEASONS as COGS_SEASONS, KINDS as COGS_KINDS, SEED as COGS_SEED,
  SHOWS as COGS_SHOWS, yearsAround as cogsYearsAround, dropYear as cogsDropYear,
  yearTotal as cogsYearTotal, cleanYears as cogsCleanYears, yearsOf as cogsYearsOf,
  addCollision as cogsAddCollision,
} from '../worker/cogs.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ran = 0;
let failed = 0;
let group = '';

function describe(name, fn) { group = name; console.log(name); fn(); }
// Async tests are collected and awaited before the summary. Before this,
// it() called fn() and moved on: an async body returned a promise nobody
// held, process.exit() ran before the rejection landed, and the test
// printed "ok" whatever it found. Three deliberate breakages sailed
// through a test written to catch them.
const pending = [];
function it(label, fn) {
  ran++;
  const bad = (err) => {
    failed++;
    console.log('  FAIL ' + label + '\n         ' + err.message);
  };
  let out;
  try { out = fn(); } catch (err) { return bad(err); }
  if (out && typeof out.then === 'function') {
    pending.push(out.then(() => console.log('  ok   ' + label + ' (async)'), bad));
    return;
  }
  console.log('  ok   ' + label);
}
// JSON.stringify turns Infinity and NaN into null, so eq(Infinity, null)
// passes -- and a check that a division guards against zero passes whether
// or not the guard is there. The calendar suite had exactly that hole and
// it hid a real break. Non-finite numbers show as themselves instead.
const show = (v) => JSON.stringify(v, (k, x) =>
  (typeof x === 'number' && !Number.isFinite(x) ? '<' + String(x) + '>' : x));
function eq(got, want, note) {
  const a = show(got);
  const b = show(want);
  if (a !== b) throw new Error((note ? note + ': ' : '') + 'got ' + a + ', wanted ' + b);
}
function ok(cond, note) { if (!cond) throw new Error(note || 'expected true'); }

import { shape as cShape, shapeAll as cShapeAll, dueState as cDue,
         byPerson as cByPerson, timeline as cTimeline, totals as cTotals,
         NOBODY as cNOBODY, MAX_TASKS as cMAX,
         fetchBoard as cFetchBoard, TASKS_VIEW as cTASKS_VIEW,
         TASKS_TABLE as cTASKS_TABLE } from '../worker/campaign.js';

const keys = (groups) => visibleTiles(groups).map((t) => t.key);

describe('visibleTiles', () => {
  const fx = [
    { key: 'open', name: 'Open', blurb: '-', url: 'https://a.test', icon: 'link',
      category: 'general', everyone: true },
    { key: 'given', name: 'Given', blurb: '-', url: 'https://b.test', icon: 'link',
      category: 'finance' },
    { key: 'nourl', name: 'Unbuilt', blurb: '-', url: '', icon: 'link',
      category: 'finance' },
  ];
  const keys = (mine) => visibleTiles(mine, fx).map((t) => t.key);

  it('shows what somebody has been given', () => {
    eq(keys(['given']), ['open', 'given']);
  });
  it('does not show what they have not', () => {
    eq(keys([]), ['open']);
  });
  it('shows an open tile to everybody, assigned or not', () => {
    ok(keys([]).includes('open'));
  });
  it('ignores the category when deciding who sees it', () => {
    // The section a tile sits in says where it is drawn, not who gets it.
    eq(keys(['given']).includes('given'), true);
    eq(keys(['finance']).includes('given'), false, 'a category key is not a tile key');
  });

  // The failure mode that matters: not knowing must show less, never more.
  it('shows only the open tiles when we do not know who it is', () => {
    eq(keys(null), ['open']);
  });
  it('never shows more when unknown than when known and given nothing', () => {
    ok(keys(null).length <= keys([]).length);
  });

  it('never returns a tile that is not built, to anybody', () => {
    ok(!keys(['given', 'nourl']).includes('nourl'));
  });
  it('gives every tile it does return somewhere to go', () => {
    for (const t of visibleTiles(['given'], fx)) ok(t.url, t.key + ' was drawn without a url');
  });
  it('leaks nothing about a tile somebody cannot see', () => {
    ok(!JSON.stringify(visibleTiles([], fx)).includes('b.test'));
  });
});

describe('tileSections', () => {
  it('puts a tile under its own category', () => {
    const s = tileSections(['strategic']);
    const finance = s.find((x) => x.key === 'finance');
    ok(finance, 'there should be a Finance section');
    eq(finance.tiles.map((t) => t.key), ['strategic']);
  });
  it('leaves out a heading nothing lands under', () => {
    for (const s of tileSections(['strategic'])) ok(s.tiles.length, s.key + ' is empty');
  });
  it('keeps the categories in the order they are declared', () => {
    const order = tileSections(TILES.map((t) => t.key)).map((s) => s.key);
    const want = CATEGORIES.map((c) => c.key).filter((k) => order.includes(k));
    eq(order, want);
  });
  it('accounts for every visible tile exactly once', () => {
    for (const who of [null, [], ['strategic'], TILES.map((t) => t.key)]) {
      const flat = tileSections(who).flatMap((s) => s.tiles.map((t) => t.key));
      eq(flat.slice().sort(), visibleTiles(who).map((t) => t.key).sort(),
         'sections and tiles disagree for ' + JSON.stringify(who));
      eq(new Set(flat).size, flat.length, 'a tile appeared twice');
    }
  });
});

describe('groupsFor', () => {
  it('gives somebody their groups', () => {
    ok(groupsFor('jeremy@jettylife.com').includes('finance'));
    ok(groupsFor('jeremy@jettylife.com').includes('general'));
  });
  it('does not care about case or stray spaces', () => {
    eq(groupsFor('  JEREMY@JettyLife.com '), groupsFor('jeremy@jettylife.com'));
  });

  // Somebody Access let in is staff. Not being on the list yet is not a
  // lockout -- it is "known, and in no groups", which still sees the tools
  // that are open to everyone.
  it('places an unlisted address in no groups rather than nowhere', () => {
    eq(groupsFor('brandnew@jettylife.com'), []);
    // Derived, not listed: this is "exactly the open-to-everyone tiles",
    // and spelling them out meant adding one broke an unrelated test.
    eq(visibleTiles(groupsFor('brandnew@jettylife.com')).map((t) => t.key),
       TILES.filter((t) => t.everyone && t.url).map((t) => t.key));
  });
  it('tells an empty address apart from an unlisted one', () => {
    eq(groupsFor(''), null, 'no address at all is "we do not know"');
    eq(groupsFor('nobody@jettylife.com'), [], 'an unknown address is "known, in none"');
  });
  it('drops a group that no longer exists rather than passing it through', () => {
    // A group deleted from GROUPS but left on a person would otherwise be
    // compared against tiles forever and quietly match nothing.
    for (const { email, groups } of roster()) {
      const live = groupsFor(email);
      ok(live.length <= groups.length, email);
      for (const g of live) ok(GROUPS.some((k) => k.key === g), email + ' has unknown group ' + g);
    }
  });
});

describe('the roster itself', () => {
  it('writes every address in lower case, since that is how it is looked up', () => {
    for (const email of Object.keys(PEOPLE)) {
      eq(email, email.toLowerCase(), email + ' would never be found');
    }
  });
  it('names only groups that exist', () => {
    const known = new Set(GROUPS.map((g) => g.key));
    for (const { email, groups } of roster()) {
      for (const g of groups) ok(known.has(g), email + ' is in a group that does not exist: ' + g);
    }
  });
  // Departments with nobody in them are expected now: the list is every part
  // of the business, and some have no tools and no assigned staff yet. What
  // would be wrong is a department nobody is in that nonetheless owns a tile,
  // which the next check covers.

});

// What the Setup page is allowed to save. Everything typed in by hand goes
// through the same cleaning the seeded rows went through, so a row keyed in
// cannot be shaped differently from a row that came from the file.
describe('cleanTile', () => {
  const cats = [{ key: 'finance' }, { key: 'general' }];
  const good = { name: 'Hub', blurb: 'A hub.', url: 'https://hub.test/',
                 category: 'finance', icon: 'box' };

  it('accepts the answers the form asks for', () => {
    const out = cleanTile(good, cats, []);
    ok(!out.errors, JSON.stringify(out.errors));
    eq([out.row.name, out.row.category, out.row.icon], ['Hub', 'finance', 'box']);
  });
  it('derives whether it is shown from whether it has an address', () => {
    eq(cleanTile(good, cats, []).row.status, 'live');
    eq(cleanTile({ ...good, url: '' }, cats, []).row.status, 'soon');
  });
  it('carries the open-to-everyone flag', () => {
    eq(cleanTile({ ...good, everyone: true }, cats, []).row.everyone, true);
    eq(cleanTile(good, cats, []).row.everyone, false);
  });
  it('says so when an address was typed and is not one', () => {
    ok(cleanTile({ ...good, url: 'hub' }, cats, []).errors);
  });
  it('refuses a category that does not exist', () => {
    ok(cleanTile({ ...good, category: 'made-up' }, cats, []).errors);
  });
  it('makes a key out of the name and does not collide', () => {
    eq(cleanTile({ ...good, name: 'Wholesale Hub' }, cats, []).row.key, 'wholesale-hub');
    eq(cleanTile({ ...good, name: 'Hub' }, cats, ['hub']).row.key, 'hub-2');
  });
  it('keeps the key an existing tile already has, so renaming is safe', () => {
    eq(cleanTile({ ...good, key: 'original', name: 'Renamed' }, cats, []).row.key, 'original');
  });
  it('refuses a tile with no name', () => {
    ok(cleanTile({ ...good, name: '  ' }, cats, []).errors);
  });
});

describe('cleanUrl', () => {
  it('keeps an http or https address', () => {
    eq(cleanUrl('https://a.test/x'), 'https://a.test/x');
  });
  // A tile is a link somebody clicks. javascript: and data: are not addresses
  // anybody should be sent to, and an empty url means the tile is not drawn --
  // so a bad one fails closed rather than being put on the page.
  it('throws away anything that is not a web address', () => {
    eq(cleanUrl('javascript:alert(1)'), '');
    eq(cleanUrl('data:text/html,<script>'), '');
    eq(cleanUrl('not a url'), '');
    eq(cleanUrl(''), '');
  });
});

describe('cleanKey', () => {
  it('tidies something typed by hand into a usable key', () => {
    eq(cleanKey('  Wholesale Hub '), 'wholesale-hub');
    eq(cleanKey('Finance'), 'finance');
  });
  it('refuses one that cleans down to nothing', () => {
    eq(cleanKey('!!!'), '');
    eq(cleanKey(''), '');
  });
});

describe('cleanPerson', () => {
  const keys = ['calendar', 'strategic'];
  it('accepts an address and the tiles it is given', () => {
    const out = cleanPerson({ email: ' Amy@JettyLife.com ', tiles: ['strategic'] }, keys);
    ok(!out.errors);
    eq(out.row.email, 'amy@jettylife.com', 'stored lowercased, which is how it is looked up');
    eq(out.row.tiles, 'strategic');
  });
  it('accepts somebody given nothing, which is a real state', () => {
    ok(!cleanPerson({ email: 'new@jettylife.com', tiles: [] }, keys).errors);
  });
  it('refuses something that is not an address', () => {
    ok(cleanPerson({ email: 'nope', tiles: [] }, keys).errors);
  });
  // A key left behind by a deleted tile would sit in the row matching nothing.
  it('refuses a tile that does not exist', () => {
    ok(cleanPerson({ email: 'a@b.test', tiles: ['gone'] }, keys).errors);
  });
  it('does not store the same tile twice', () => {
    eq(cleanPerson({ email: 'a@b.test', tiles: ['calendar', 'calendar'] }, keys).row.tiles,
       'calendar');
  });
});

// A link is a bookmark, not a tool: there is nothing to it but the address,
// and everybody sees it. So it is cleaned more strictly than a tile -- a tile
// with no address is an unfinished tile worth keeping, whereas a link with no
// address is nothing at all.
describe('cleanLink', () => {
  const cats = [{ key: 'marketing' }, { key: 'general' }];
  const good = { name: 'Model Inquiry Form', url: 'https://forms.test/models',
                 category: ['marketing'] };

  it('accepts a name, an address and a category', () => {
    const out = cleanLink(good, cats, []);
    ok(!out.errors, JSON.stringify(out.errors));
    eq([out.row.name, out.row.category], ['Model Inquiry Form', 'marketing']);
  });
  it('stores several categories, so one link lands under several filters', () => {
    const out = cleanLink({ ...good, category: ['marketing', 'general'] }, cats, []);
    ok(!out.errors, JSON.stringify(out.errors));
    eq(out.row.category, 'marketing,general');
  });
  it('accepts them comma-separated too, the way a row comes back', () => {
    eq(cleanLink({ ...good, category: 'marketing, general' }, cats, []).row.category,
       'marketing,general');
  });
  it('does not store the same category twice', () => {
    eq(cleanLink({ ...good, category: ['marketing', 'marketing'] }, cats, []).row.category,
       'marketing');
  });
  it('refuses a link filed under nothing at all', () => {
    ok(cleanLink({ ...good, category: [] }, cats, []).errors);
  });
  it('refuses a link with no address, unlike a tile', () => {
    ok(cleanLink({ ...good, url: '' }, cats, []).errors);
    ok(!cleanTile({ name: 'Hub', url: '', category: 'general' },
                  [{ key: 'general' }], []).errors);
  });
  it('refuses an address that is not one', () => {
    ok(cleanLink({ ...good, url: 'forms.test/models' }, cats, []).errors);
  });
  it('refuses a category that does not exist, even beside a real one', () => {
    ok(cleanLink({ ...good, category: ['made-up'] }, cats, []).errors);
    ok(cleanLink({ ...good, category: ['marketing', 'made-up'] }, cats, []).errors);
  });
  it('makes a key out of the name and does not collide', () => {
    eq(cleanLink(good, cats, []).row.key, 'model-inquiry-form');
    eq(cleanLink(good, cats, ['model-inquiry-form']).row.key, 'model-inquiry-form-2');
  });
  it('keeps the key an existing link already has, so renaming is safe', () => {
    eq(cleanLink({ ...good, key: 'original', name: 'Renamed' }, cats, []).row.key, 'original');
  });
  it('refuses a link with no name', () => {
    ok(cleanLink({ ...good, name: '  ' }, cats, []).errors);
  });
});

// The right-hand column. Links are not assigned to anybody -- the thing on the
// far end sets its own access the same way a tile's tool does -- so the only
// job here is filing them under the categories, in the order the categories
// are listed, and losing none of them on the way.
describe('linkSections', () => {
  const cats = [{ key: 'general', label: 'General', icon: 'star' },
                { key: 'marketing', label: 'Marketing', icon: 'megaphone' },
                { key: 'finance', label: 'Finance', icon: 'chart' }];
  const link = (key, category, url) => ({ key, name: key, category, url: url === undefined ? 'https://a.test/' + key : url });

  it('files each link under its category', () => {
    const out = linkSections([link('m1', 'marketing'), link('g1', 'general')], cats);
    eq(out.map((s) => s.key), ['general', 'marketing']);
    eq(out[1].links.map((l) => l.key), ['m1']);
  });
  it('keeps the categories in the order they are listed, not the links order', () => {
    const out = linkSections([link('f1', 'finance'), link('g1', 'general')], cats);
    eq(out.map((s) => s.key), ['general', 'finance']);
  });
  it('leaves out a category nobody has a link in', () => {
    eq(linkSections([link('m1', 'marketing')], cats).map((s) => s.key), ['marketing']);
  });
  it('carries the label and icon through for the heading', () => {
    const out = linkSections([link('m1', 'marketing')], cats);
    eq([out[0].label, out[0].icon], ['Marketing', 'megaphone']);
  });
  it('drops a link with no address, which would be a dead bookmark', () => {
    eq(linkSections([link('m1', 'marketing', '')], cats), []);
  });
  // Deleting a category must not silently delete the links filed under it.
  it('gathers links under a category that no longer exists', () => {
    const out = linkSections([link('x1', 'deleted-cat'), link('g1', 'general')], cats);
    eq(out.map((s) => s.key), ['general', 'other']);
    eq(out[1].links.map((l) => l.key), ['x1']);
  });
  it('has nothing to show when there are no links', () => {
    eq(linkSections([], cats), []);
  });
});

describe('the group merge', () => {
  it('moves every old permission name onto a department that exists', () => {
    const known = new Set(GROUPS.map((g) => g.key));
    for (const [from, to] of Object.entries(GROUP_MOVES)) {
      ok(known.has(to), from + ' moves to ' + to + ', which is not a department');
    }
  });
  it('does not move a name that is still live', () => {
    const known = new Set(GROUPS.map((g) => g.key));
    for (const from of Object.keys(GROUP_MOVES)) {
      ok(!known.has(from), from + ' is both a live department and being moved away');
    }
  });
  it('leaves nothing in the seed still using an old name', () => {
    for (const t of TILES) {
      for (const g of t.groups || []) ok(!GROUP_MOVES[g], t.key + ' still uses ' + g);
    }
    for (const { email, groups } of roster()) {
      for (const g of groups) ok(!GROUP_MOVES[g], email + ' still uses ' + g);
    }
  });
  // Departments and sections are now the same list, which is the point.
  it('draws who-sees-it from the same list as where-it-sits', () => {
    eq(GROUPS.map((g) => g.key), CATEGORIES.map((c) => c.key));
  });
});

describe('the category migration', () => {
  it('moves every old category to one that exists', () => {
    const known = new Set(CATEGORIES.map((c) => c.key));
    for (const [from, to] of Object.entries(CAT_MOVES)) {
      ok(known.has(to), from + ' moves to ' + to + ', which is not a category');
    }
  });
  it('does not move a category that is still in the list', () => {
    const known = new Set(CATEGORIES.map((c) => c.key));
    for (const from of Object.keys(CAT_MOVES)) {
      ok(!known.has(from), from + ' is both a live category and something being moved away');
    }
  });
  it('leaves no tile in the catalogue pointing at a category being moved', () => {
    for (const t of TILES) {
      ok(!CAT_MOVES[t.category], t.key + ' still uses the old category ' + t.category);
    }
  });
});

// An Access application guards a HOSTNAME, not a Worker. The dash answers on
// two hostnames and the application covers one, so the other reaches the
// Worker having never met Access. These are the rules that close that.
// Every category across the top, with what this person has in each.
//
// The two gates are different on purpose: a tile is one of our tools and is
// assigned person by person, a link is an address with nothing of ours behind
// it and goes to everybody. So a category can be open on links alone.
describe('dashCategories', () => {
  const cats = [{ key: 'general', label: 'General', icon: 'star' },
                { key: 'finance', label: 'Finance', icon: 'chart' },
                { key: 'marketing', label: 'Marketing', icon: 'mega' }];
  const tile = (key, category) => ({ key, name: key, category, url: 'https://t.test/' + key });
  const link = (key, category, url) => ({ key, name: key, category,
                                          url: url === undefined ? 'https://l.test/' + key : url });

  // Alphabetical by label, not the order Setup lists them in.
  it('lists every category, alphabetically', () => {
    eq(dashCategories([], [], cats).map((c) => c.key), ['finance', 'general', 'marketing']);
  });
  it('opens a category the person has a tile in', () => {
    const out = dashCategories([tile('t1', 'finance')], [], cats);
    eq(out.filter((c) => c.open).map((c) => c.key), ['finance']);
  });
  // The case that decides the whole design: links are not assigned, so they
  // can open a category on their own.
  it('opens a category on its links alone, with no tile in it', () => {
    const out = dashCategories([], [link('l1', 'marketing')], cats);
    eq(out.map((c) => c.open), [false, false, true]);
    eq(out[2].tiles, []);
    eq(out[2].links.map((l) => l.key), ['l1']);
  });
  it('leaves a category with nothing in it shut', () => {
    ok(dashCategories([tile('t1', 'finance')], [], cats).every(
      (c) => c.key === 'finance' || !c.open));
  });
  it('files tiles and links into the same category together', () => {
    const out = dashCategories([tile('t1', 'marketing')], [link('l1', 'marketing')], cats);
    eq([out[2].tiles.length, out[2].links.length, out[2].open], [1, 1, true]);
  });
  it('drops a link with no address, which would be a dead bookmark', () => {
    const out = dashCategories([], [link('l1', 'marketing', '')], cats);
    eq(out[2].open, false);
  });
  // Deleting a category must not silently delete what was filed under it.
  it('gathers anything under a category that no longer exists', () => {
    const out = dashCategories([tile('t1', 'gone')], [link('l1', 'gone')], cats);
    eq(out[out.length - 1].key, 'other');
    eq([out[3].tiles.length, out[3].links.length, out[3].open], [1, 1, true]);
  });
  it('adds no Other bucket when everything is filed somewhere real', () => {
    eq(dashCategories([tile('t1', 'finance')], [], cats).length, 3);
  });
  // A tile only reaches here if visibleTiles let it through, so this is the
  // seam where the People tab actually takes effect.
  it('shows only the tiles it is given, which is what the People tab sets', () => {
    const fx = [{ key: 'mine', category: 'finance', url: 'https://a.test' },
                { key: 'theirs', category: 'finance', url: 'https://b.test' }];
    const out = dashCategories(visibleTiles(['mine'], fx), [], cats);
    const fin = out.filter((c) => c.key === 'finance')[0];
    eq(fin.tiles.map((t) => t.key), ['mine']);
  });
});

// Renaming a category after it is already in a database. The seed alone
// never reaches one that exists, because syncCategories is guarded.
describe('the category rename', () => {
  it('renames away from a label no category still uses', () => {
    const live = new Set(CATEGORIES.map((c) => c.label));
    // Each fix is [key, from, to]. Mirrors LABEL_FIXES in store.js, which
    // cannot be imported here: store.js reads schema.sql through a wrangler
    // rule and will not load in Node.
    const FIXES = [['general', 'General / Staff / Culture', 'General']];
    for (const [, from] of FIXES) {
      ok(!live.has(from), from + ' is both a live label and one being renamed away');
    }
  });
  it('renames to a label the category list actually has', () => {
    const byKey = new Map(CATEGORIES.map((c) => [c.key, c.label]));
    const FIXES = [['general', 'General / Staff / Culture', 'General']];
    for (const [key, , to] of FIXES) {
      eq(byKey.get(key), to, key + ' is renamed to something the seed disagrees with');
    }
  });
});

describe('linkCats', () => {
  it('reads a single category, the way every row written before this one is', () => {
    eq(linkCats({ category: 'marketing' }), ['marketing']);
  });
  it('reads several', () => {
    eq(linkCats({ category: 'logistics,finance' }), ['logistics', 'finance']);
  });
  it('copes with spacing and case', () => {
    eq(linkCats({ category: ' Logistics , FINANCE ' }), ['logistics', 'finance']);
  });
  it('reads an array as well, which is what Setup sends', () => {
    eq(linkCats({ category: ['a', 'b'] }), ['a', 'b']);
  });
  it('says nothing rather than something empty', () => {
    eq(linkCats({ category: '' }), []);
    eq(linkCats({}), []);
    eq(linkCats(null), []);
  });
});

// Alphabetical, and a link in two categories reachable from both.
// The dash page: links and forms used to be a column of their own with a
// filter of their own. They are pills under the department they belong to
// now, which is the same question the row along the top already answers.
// Who may open the Campaign Board. This is a list of SIGN-IN addresses, and
// three of the ten people on that board are in Airtable under a different
// one -- so the obvious way to build this list is the wrong way, and the
// failure is silent: the tile sits on their dash and the board 404s.
describe('the Campaign Board allow-list', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const toml = fs.readFileSync(path.join(HERE, '..', 'wrangler.toml'), 'utf8');
  const list = (/CAMPAIGN_USERS = "([^"]*)"/.exec(toml) || [, ''])[1]
    .split(',').map((e) => e.trim()).filter(Boolean);

  it('only holds addresses Access will admit', () => {
    ok(list.length > 0, 'the list is empty, which shuts the board to everybody');
    for (const e of list) {
      ok(/@(jettylife\.com|jettyrockfoundation\.org)$/.test(e),
         e + ' is not a domain Access admits -- the board will 404 for them');
    }
  });

  it('is lowercase and has nobody twice', () => {
    // canSeeCampaign lowercases what it compares, so a capital here is a
    // name that silently never matches.
    for (const e of list) eq(e, e.toLowerCase(), e + ' will never match');
    eq(new Set(list).size, list.length, 'somebody is on the list twice');
  });

  // The three that catch people out, named so a future edit cannot quietly
  // put the Airtable address back.
  it('uses the sign-in address, not the Airtable one', () => {
    for (const bad of ['khehldesign@gmail.com', 'joncoen@comcast.net']) {
      ok(!list.includes(bad), bad + ' is an Airtable address, not a sign-in');
    }
    for (const good of ['k.hehl@jettylife.com', 'joncoen@jettylife.com']) {
      ok(list.includes(good), good + ' is missing, so they will be refused');
    }
  });
});

// The Harbor sign-in page's bathymetry, now on the band at the top of every
// module. Three Workers serve it, so there are three copies of the file and
// three copies of the rule -- the same duplication the rest of this repo
// pins rather than imports.
describe('the header band artwork', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(HERE, '..', '..');
  const copies = ['dash/public/assets/bathy.webp',
                  'calendar/public/assets/bathy.webp',
                  'commissions/public/assets/bathy.webp'];

  it('is the same file in all three Workers', () => {
    const bytes = copies.map((f) => fs.readFileSync(path.join(root, f)));
    for (const b of bytes) ok(b.length > 0, 'one copy is empty');
    ok(bytes[0].equals(bytes[1]) && bytes[0].equals(bytes[2]),
       'the three Workers are serving different artwork');
    // It loads on every page of every module, so it has a budget.
    ok(bytes[0].length < 60 * 1024,
       'the artwork is ' + Math.round(bytes[0].length / 1024) + 'KB, over the 60KB budget');
    // WebP, not a PNG renamed.
    eq(bytes[0].slice(0, 4).toString('latin1'), 'RIFF', 'not a WebP');
    eq(bytes[0].slice(8, 12).toString('latin1'), 'WEBP', 'not a WebP');
  });

  it('is on the band in all three, over Deep Sea', () => {
    for (const f of ['dash/public/assets/dash.css',
                     'calendar/public/assets/site.css',
                     'commissions/public/assets/site.css']) {
      const css = fs.readFileSync(path.join(root, f), 'utf8');
      const band = css.slice(css.indexOf('.site-top{'), css.indexOf('.site-top{') + 900);
      ok(/url\('\/assets\/bathy\.webp'\)/.test(band), f + ' does not draw the artwork');
      // The colour has to stay under it: the file is only contour lines.
      ok(/background:var\(--primary\) url/.test(band), f + ' dropped Deep Sea from under it');
      // A map is not a tile. Repeating it shows the seam.
      ok(/no-repeat/.test(band), f + ' repeats the map');
    }
  });

  // A harness that cannot serve the file paints a bare band and agrees that
  // nothing is wrong, which is how this would go unnoticed.
  it('can be served by every harness that renders a page', () => {
    for (const f of ['dash/tests/shot.mjs', 'calendar/tests/browser.mjs',
                     'commissions/tests/browser.mjs']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      ok(/'\.webp': 'image\/webp'/.test(t), f + ' would serve the artwork as text');
    }
  });
});

describe('the dash page: links under their department', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const page = fs.readFileSync(path.join(HERE, '..', 'public/assets/dash.js'), 'utf8');
  const html = fs.readFileSync(path.join(HERE, '..', 'public/index.html'), 'utf8');

  // Runs the page's own linkPills(), so the ordering is the shipped one.
  const pills = (() => {
    const cut = (a, b) => page.slice(page.indexOf(a), page.indexOf(b));
    const src = cut('function esc(', '  var ICONS')
      + "var OUT = '';\n"
      + cut('function linkPills(', '  // Below the row:');
    return new Function(src + ';return linkPills;')();
  })();

  const L = (name) => ({ name, url: 'https://l.test/' + name });

  it('puts them in ABC order, whatever order they were added in', () => {
    const out = pills({ links: [L('Model Inquiry Form'), L('Benefits Portal'),
                                L('brand guidelines'), L('IT Help')] });
    eq([...out.matchAll(/class="lk"[^>]*>([^<]*)</g)].map((m) => m[1]).join(' | '),
       'Benefits Portal | brand guidelines | IT Help | Model Inquiry Form',
       'the links are not in alphabetical order');
  });

  it('draws them as pills, not as tools', () => {
    const out = pills({ links: [L('IT Help')] });
    ok(/class="lk"/.test(out), 'a link is not drawn as a pill');
    ok(!/class="tl"/.test(out), 'a link is being drawn as a tool');
    ok(!/tl-blurb|tile-ico/.test(out), 'a link borrowed a tool\u2019s furniture');
    ok(/lk-head/.test(out), 'nothing says what the pills are');
    // Everything here leaves the dash; the arrow is the only warning.
    ok(/lk-out/.test(out), 'the pills do not say they open somewhere else');
  });

  it('has nothing to draw when a department holds no links', () => {
    eq(pills({ links: [] }), '');
    eq(pills({}), '');
  });

  // A category can be open on its links alone -- that is the case the whole
  // design turns on, and the pane has to say why it has no tools.
  it('still explains a department that has links but no tools', () => {
    const pane = page.slice(page.indexOf('function paneHtml('), page.indexOf('function noticeHtml('));
    ok(/cat\.tiles\.length/.test(pane), 'the pane no longer checks for tools');
    ok(/are assigned to you/.test(pane), 'it stopped saying why there are no tools');
    ok(/pills \? ', but its links and forms are below\.'/.test(pane),
       'it still points at a column that is not there any more');
    ok(/'<div class="cat">' \+ body \+ pills/.test(pane),
       'the pills are not inside the category card with the tools');
  });

  it('has no second column left anywhere', () => {
    ok(!/id="links"/.test(html), 'the links aside is still in the markup');
    ok(!/linksHtml|LFILTER|lkfilter/.test(page), 'the old links column is still in the script');
    const css = fs.readFileSync(path.join(HERE, '..', 'public/assets/dash.css'), 'utf8');
    ok(!/\.shell\.split/.test(css), 'the split grid is still styled');
    ok(!/\.lk-filter|\.lk-list|\.links-head/.test(css), 'the old column is still styled');
    ok(/\.lk-row\{/.test(css) && /\.lk-head\{/.test(css), 'the pills are not styled');
  });
});

describe('dashCategories: order and multi-category links', () => {
  const cats = [{ key: 'wholesale', label: 'Wholesale', icon: 'box' },
                { key: 'finance', label: 'Finance', icon: 'chart' },
                { key: 'box-truck', label: 'Box Truck', icon: 'truck' }];
  const link = (key, category) => ({ key, name: key, category, url: 'https://l.test/' + key });

  it('orders the row alphabetically by label, not by how Setup lists them', () => {
    eq(dashCategories([], [], cats).map((c) => c.label),
       ['Box Truck', 'Finance', 'Wholesale']);
  });
  it('puts a link in two categories under both of them', () => {
    const out = dashCategories([], [link('l1', 'finance,box-truck')], cats);
    const inIt = out.filter((c) => c.links.length).map((c) => c.key);
    eq(inIt, ['box-truck', 'finance']);
  });
  it('opens both of those categories', () => {
    const out = dashCategories([], [link('l1', 'finance,box-truck')], cats);
    eq(out.filter((c) => c.open).map((c) => c.key), ['box-truck', 'finance']);
  });
  it('keeps Other last however the alphabet falls', () => {
    const out = dashCategories([], [link('l1', 'gone')], cats);
    eq(out[out.length - 1].key, 'other');
  });
  it('only calls a link lost when none of its categories exist', () => {
    const out = dashCategories([], [link('l1', 'finance,gone')], cats);
    ok(!out.some((c) => c.key === 'other'), 'a link with one real category is not lost');
    eq(out.filter((c) => c.links.length).map((c) => c.key), ['finance']);
  });
});

// Icons are named in one file and drawn in two others, and nothing in the
// build connects the three. An icon name with no drawing behind it falls
// back silently to the generic chain link -- which is exactly how every
// category came to look identical without anybody noticing.
describe('every icon named has a drawing behind it', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const read = (f) => fs.readFileSync(path.join(HERE, '..', 'public', 'assets', f), 'utf8');
  const dash = read('dash.js');
  const admin = read('admin.js');

  // The keys of the ICONS map in dash.js, which is what actually draws them.
  const drawn = new Set([...dash.matchAll(/^    ([a-z]+): '</gm)].map((m) => m[1]));

  it('draws every icon a category asks for', () => {
    for (const c of CATEGORIES) {
      ok(drawn.has(c.icon), c.key + ' wants the "' + c.icon + '" icon, which is not drawn');
    }
  });
  it('draws every icon a seeded tile asks for', () => {
    for (const t of TILES) {
      ok(drawn.has(t.icon), t.key + ' wants the "' + t.icon + '" icon, which is not drawn');
    }
  });
  // Icons are chosen in the code now, so Setup must not ask -- and more
  // importantly must not SEND one, because an empty value arriving at the
  // save path is what would reset them all.
  it('does not ask for an icon anywhere in Setup', () => {
    ok(!/f-icon|iconSelect/.test(admin), 'Setup still has an icon field');
  });
  // The reason the whole category row looked like eleven of the same thing.
  it('does not leave most categories on the fallback', () => {
    const fallback = CATEGORIES.filter((c) => c.icon === 'link').length;
    ok(fallback === 0, fallback + ' categories still use the generic link icon');
  });
});

// Setup stopped sending an icon, and cleanTile runs on every save. A
// silent default here would wipe every tile's icon the first time somebody
// renamed one -- the same shape as the bug backfillIcons just repaired.
describe('cleanTile keeps icons that Setup no longer asks for', () => {
  const cats = [{ key: 'finance', label: 'Finance', icon: 'chart' },
                { key: 'general', label: 'General', icon: 'people' }];
  const base = { name: 'Hub', url: 'https://hub.test/', category: 'finance' };

  it('keeps the icon a tile already has when none is sent', () => {
    const out = cleanTile({ ...base, key: 'hub' }, cats, [], { key: 'hub', icon: 'calendar' });
    eq(out.row.icon, 'calendar');
  });
  it('falls back to the category icon for a new tile, not the chain link', () => {
    eq(cleanTile(base, cats, []).row.icon, 'chart');
    eq(cleanTile({ ...base, category: 'general' }, cats, []).row.icon, 'people');
  });
  it('still honours an icon when one is sent', () => {
    eq(cleanTile({ ...base, icon: 'box' }, cats, []).row.icon, 'box');
  });
  it('only reaches the chain link when the category has no icon either', () => {
    eq(cleanTile({ ...base, category: 'x' }, [{ key: 'x', label: 'X' }], []).row.icon, 'link');
  });
});

// Deleting a section. The Categories tab was wired to group/delete -- the
// retired table -- so it quietly deleted nothing at all for weeks.
// Four bugs have now had the same shape: something added to the repo that
// a guarded migration never carries into a database that already exists.
// seed() runs once. So does seedHubs, syncCategories and the icon backfill.
// A tile added to TILES after the first deploy reaches nobody, renders
// perfectly in the fixture, and is simply absent in production.
describe('a tile added to the repo can actually reach a live database', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const store = fs.readFileSync(path.join(HERE, '..', 'worker', 'store.js'), 'utf8');

  it('has a step that offers repo tiles to an existing database', () => {
    ok(/async function offerNewTiles/.test(store), 'nothing carries new tiles across');
    ok(/^\s*await offerNewTiles\(db\);/m.test(store), 'offerNewTiles is never called');
  });
  it('runs that step on every boot, not behind a one-shot guard', () => {
    // The whole point: it must not sit behind `if (done) return`, which is
    // what made every other migration a one-off.
    const fn = store.slice(store.indexOf('async function offerNewTiles'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    ok(!/if \(done\) return/.test(body), 'offerNewTiles is guarded like the one-shots');
    ok(/OFFERED_KEY/.test(body), 'it does not remember what it already offered');
  });
  it('only offers tiles that have an address', () => {
    const fn = store.slice(store.indexOf('async function offerNewTiles'));
    ok(/TILES\.filter\(\(t\) => t\.url\)/.test(fn.slice(0, 1200)),
       'a tile with no url would be inserted, and the retired placeholders would return');
  });
  // The specific tile that went missing and prompted all this.
  it('has Music Monday in the repo with an address and open to everyone', () => {
    const m = TILES.find((t) => t.key === 'music-monday');
    ok(m, 'the Music Monday tile is not in TILES');
    eq([Boolean(m.url), m.everyone], [true, true]);
  });
});

// Twenty-nine tiles pointing at Airtable bases were seeded unasked and
// taken out again. Nothing links out of this dash unless somebody chose to
// put it there, so the repo must not carry a list of them to re-offer.
describe('no Airtable hubs are seeded from the repo', () => {
  it('has no HUBS list to re-add them from', async () => {
    const m = await import('../worker/tiles.js');
    eq(m.HUBS, undefined, 'HUBS is back; tiles are added in Setup, not here');
  });
  it('seeds no tile pointing at an Airtable base', () => {
    for (const t of TILES) {
      ok(!/airtable\.com/.test(t.url || ''),
         t.key + ' links to Airtable and was not asked for');
    }
  });
  it('removes the ones already in the database', () => {
    const store = fs.readFileSync(path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'store.js'), 'utf8');
    ok(/async function removeHubs/.test(store), 'nothing takes the seeded hubs back out');
    ok(/^\s*await removeHubs\(db\);/m.test(store), 'removeHubs is never called');
    // It must also take the keys off the people holding them, or the People
    // tab refuses to save those rows.
    ok(/UPDATE people SET tiles/.test(store.slice(store.indexOf('async function removeHubs'))),
       'removeHubs leaves dead keys on people');
  });
});

describe('deleting a category', () => {
  it('has an endpoint, and Setup asks for that one', () => {
    const idx = fs.readFileSync(path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'index.js'), 'utf8');
    const adm = fs.readFileSync(path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'admin.js'), 'utf8');
    ok(/what === 'category\/delete'/.test(idx), 'the Worker has no category/delete');
    ok(/'category' : 'tile'/.test(adm), 'the Categories tab is not asking for category/delete');
    ok(!/cat-row'\) \? 'group'/.test(adm), 'the Categories tab still deletes from groups');
  });
});

describe('canonicalTarget', () => {
  const HOST = 'www.jettydash.com';

  it('sends an unguarded hostname to the one Access is on', () => {
    eq(canonicalTarget('https://jettydash.com/', HOST, false),
       'https://www.jettydash.com/');
  });
  it('keeps the path and the query, so a link into Setup still lands there', () => {
    eq(canonicalTarget('https://jettydash.com/admin.html?tab=links', HOST, false),
       'https://www.jettydash.com/admin.html?tab=links');
  });
  // The redirect exists to find Access, so a request that already came
  // through it has nothing to find. This is what lets the second hostname be
  // added to the application later without anything here being undone.
  it('leaves a request that already carries an Access token alone', () => {
    eq(canonicalTarget('https://jettydash.com/', HOST, true), '');
  });
  it('does not redirect the canonical hostname to itself', () => {
    eq(canonicalTarget('https://www.jettydash.com/', HOST, false), '');
  });
  it('ignores case in the hostname, which DNS does too', () => {
    eq(canonicalTarget('https://WWW.JettyDash.com/', HOST, false), '');
  });
  it('answers wherever it is asked when no canonical host is set', () => {
    eq(canonicalTarget('https://jettydash.com/', '', false), '');
    eq(canonicalTarget('https://jettydash.com/', null, false), '');
  });
  // A loop here would be a portal nobody can open, so it is worth stating.
  it('never produces a target equal to its own input', () => {
    for (const u of ['https://jettydash.com/', 'https://www.jettydash.com/x',
                     'https://jetty-dash.workers.dev/']) {
      const out = canonicalTarget(u, HOST, false);
      ok(out !== u, u + ' redirects to itself');
    }
  });
});

describe('greeting', () => {
  it('uses the name out of the address', () => {
    eq(greeting('jeremy@jettylife.com'), 'Welcome, Jeremy');
  });
  it('tidies a dotted address', () => {
    eq(greeting('d.bachowski@jettylife.com'), 'Welcome, D bachowski');
  });
  it('says something sensible with no address at all', () => {
    eq(greeting(''), 'Welcome');
    eq(greeting(null), 'Welcome');
  });
});



// ── The budget builder ──────────────────────────────────────────────────
//
// The whole thing is arithmetic over two inputs: a committed 2026 baseline
// and a set of decisions. Neither has a UI worth trusting to catch a sign
// error, and nobody re-adds 77 lines by hand to check a footer.

describe('the 2026 baseline it all hangs on', () => {
  it('has every line in exactly one group', () => {
    const known = new Set(BUDGET_GROUPS.map((g) => g.key));
    for (const l of BUDGET_LINES) ok(known.has(l.g), l.k + ' is in group "' + l.g + '"');
  });
  it('gives every line a key of its own', () => {
    const seen = new Set();
    for (const l of BUDGET_LINES) {
      ok(l.k && !seen.has(l.k), 'duplicate or empty key: ' + l.k);
      seen.add(l.k);
    }
  });
  it('carries all three 2026 columns as numbers on every seeded line', () => {
    for (const l of SEED_LINES) {
      for (const c of ['plan', 'act', 'proj']) {
        ok(Number.isFinite(l[c]), l.k + ' has a non-numeric ' + c + ': ' + l[c]);
      }
    }
  });
  it('is a baseline, not a budget year', () => {
    eq(cleanYear(BASELINE_YEAR), 0, 'budgeting the year you quote against is circular');
    eq(cleanYear(FIRST_YEAR), FIRST_YEAR);
    eq(cleanYear('2027'), 2027);
    eq(cleanYear('nonsense'), 0);
    eq(cleanYear(1999), 0);
  });
});

// A curve summing to 0.98 would lose two percent of every line in every
// view below annual, and every figure would still look perfectly plausible.
// 2026 put the whole of payroll in one COGS line, so splitting it leaves
// the G&A half with nowhere in OpEx to land. A line that begins in the
// budget year has no 2026 behind it, and that is a different fact from
// having spent nothing -- a hand-written row in budget-seed.js with
// invented figures would make that file a lie about where it came from.
describe('a line that begins in the budget year', () => {
  it('is kept out of the 2026 snapshot', () => {
    for (const l of NEW_LINES) {
      ok(!SEED_LINES.some((x) => x.k === l.k),
         l.k + ' was written into budget-seed.js, which is a 2026 snapshot');
    }
  });
  it('still reaches the budget', () => {
    for (const l of NEW_LINES) {
      ok(BUDGET_LINES.some((x) => x.k === l.k), l.k + ' never reaches the sheet');
    }
    eq(BUDGET_LINES.length, SEED_LINES.length + NEW_LINES.length);
  });
  it('has no 2026 figures at all, rather than zeroes', () => {
    for (const l of NEW_LINES) {
      for (const c of ['plan', 'act', 'proj']) {
        eq(l[c], null, l.k + '.' + c + ' is ' + l[c] + ', which reads as "we spent nothing"');
      }
    }
  });
  it('says which year it starts', () => {
    for (const l of NEW_LINES) ok(l.since > BASELINE_YEAR, l.k + ' starts ' + l.since);
    eq(budgetRows({}).find((r) => r.k === NEW_LINES[0].k).since, NEW_LINES[0].since);
  });
  // `a + null` is a, `a * null` is 0 and `Math.max(1, null)` is 1 -- null
  // slips through arithmetic differently in each place it is touched.
  it('contributes nothing to a total until somebody decides it', () => {
    const r = budgetRows({}).find((x) => x.k === NEW_LINES[0].k);
    eq(value(r, 'proj'), 0);
    ok(Number.isFinite(summary(budgetRows({}), 'proj').opex), 'OpEx came out NaN');
  });
  it('counts once it is decided', () => {
    const before = summary(budgetRows({}), 'proj').opex;
    const after = summary(budgetRows({ [NEW_LINES[0].k]: { amount: 500000 } }), 'proj').opex;
    eq(Math.round(after - before), 500000);
  });
  it('writes its empty 2026 cells as empty in the download', () => {
    const line = csv(budgetRows({}), 'proj', 'year', 2027)
      .split('\n').find((l) => l.startsWith('Operating expenses,Salaries'));
    ok(/,,,/.test(line), 'the empty 2026 columns came out as something: ' + line);
  });
});

describe('the seasonality curve', () => {
  it('is 52 weeks long', () => eq(WEEK_CURVE.length, 52));
  it('sums to exactly one', () => {
    const total = WEEK_CURVE.reduce((a, b) => a + b, 0);
    ok(Math.abs(total - 1) < 1e-9, 'sums to ' + total);
  });
  it('is nowhere negative', () => ok(WEEK_CURVE.every((c) => c > 0)));
  // Not a style rule: the page says out loud that the shape is made up, and
  // it reads that off this flag. Deriving a real curve means clearing it.
  it('still declares itself a placeholder', () => eq(CURVE_IS_PLACEHOLDER, true));
});

describe('spreading an annual figure over the retail calendar', () => {
  for (const c of CADENCES) {
    it('loses nothing spreading ' + c, () => {
      const out = spread(10000000, c);
      ok(Math.abs(out.reduce((a, b) => a + b, 0) - 10000000) < 0.01,
         c + ' totals ' + out.reduce((a, b) => a + b, 0));
    });
  }
  it('gives each cadence as many periods as the calendar has', () => {
    for (const c of CADENCES) eq(spread(1, c).length, periods(2027, c).length, c);
  });
  // The reason the retail calendar is in here at all. Twelve equal months
  // would make every four-week month identical to every five-week one.
  it('makes the five-week months longer than the four-week ones', () => {
    const m = spread(1200000, 'month');
    const w = weekCounts('month');
    eq(w, [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5], '4-4-5');
    // March against February: both sit on the same part of the curve, so a
    // difference between them can only come from the extra week.
    ok(m[2] > m[1], 'March (5w) is not larger than February (4w)');
    ok(m[5] > m[4], 'June (5w) is not larger than May (4w)');
  });
  it('rolls months up into exactly the quarters', () => {
    const m = spread(9000000, 'month');
    const q = spread(9000000, 'qtr');
    for (let i = 0; i < 4; i++) {
      const sum = m[i * 3] + m[i * 3 + 1] + m[i * 3 + 2];
      ok(Math.abs(sum - q[i]) < 0.01, 'Q' + (i + 1) + ': months ' + sum + ' vs quarter ' + q[i]);
    }
  });
  it('spreads a negative line without losing the sign', () => {
    const out = spread(-52000, 'qtr');
    ok(out.every((v) => v < 0), 'a negative line went positive somewhere');
  });
});

describe('what a line is worth', () => {
  const l = (over) => budgetRows(over)[0];
  const key = BUDGET_LINES[0].k;

  it('falls back to the chosen baseline when nobody has decided', () => {
    const r = l({});
    eq(r.amount, null);
    eq(value(r, 'proj'), BUDGET_LINES[0].proj);
    eq(value(r, 'plan'), BUDGET_LINES[0].plan);
    eq(value(r, 'act'), BUDGET_LINES[0].act);
  });
  // The trap: `amount || baseline` budgets last year's figure for a line
  // somebody deliberately zeroed, and the page would look right.
  it('treats a decision of zero as a decision', () => {
    const r = l({ [key]: { amount: 0 } });
    eq(r.amount, 0);
    eq(value(r, 'proj'), 0, 'a zeroed line fell back to 2026');
  });
  it('keeps the note and the flag beside the figure', () => {
    const r = l({ [key]: { amount: 5, note: 'why', flagged: true } });
    eq([r.note, r.flagged], ['why', true]);
  });
  it('ignores a decision whose key matches no line', () => {
    eq(budgetRows({ 'no-such-line': { amount: 9 } }).filter((r) => r.amount != null).length, 0);
  });
});

describe('the P&L under the sheet', () => {
  const key = BUDGET_LINES[0].k;
  it('counts only the lines somebody has actually set', () => {
    const s = summary(budgetRows({ [key]: { amount: 1, note: '', flagged: true } }), 'proj');
    eq([s.set, s.flagged, s.total], [1, 1, BUDGET_LINES.length]);
  });
  it('adds up to net income', () => {
    const s = summary(budgetRows({}), 'proj');
    eq(s.gross, s.rev - s.cogs);
    eq(s.net, s.rev - s.cogs - s.opex);
  });
  // Clearing every revenue line is a thing somebody does on the way to
  // typing the real ones in. NaN% reads as the page being broken.
  it('does not divide by a revenue of zero', () => {
    const zeroed = {};
    for (const l of BUDGET_LINES) if (l.g === 'rev') zeroed[l.k] = { amount: 0 };
    const s = summary(budgetRows(zeroed), 'proj');
    eq(s.rev, 0);
    ok(Number.isFinite(s.grossPct), 'grossPct is ' + s.grossPct);
  });
});

describe('what somebody typed into a line', () => {
  const amt = (v) => cleanLine({ amount: v });
  it('takes a figure typed the way people type figures', () => {
    eq(amt('1200').row.amount, 1200);
    eq(amt('$1,200').row.amount, 1200);
    eq(amt(' 1 200 ').row.amount, 1200);
    eq(amt(1200).row.amount, 1200);
  });
  it('refuses what is not a figure, rather than storing NaN', () => {
    ok(amt('abc').errors, 'letters were accepted');
    ok(amt('12-34').errors, 'that is not a number');
    ok(amt('1e9').errors, 'exponent notation is not a typed figure');
  });
  it('keeps zero and keeps negatives', () => {
    eq(amt('0').row.amount, 0);
    eq(amt('0').row.clear, false, 'a zero was mistaken for an empty cell');
    eq(amt('-500').row.amount, -500);
  });
  it('calls an empty line with nothing on it undecided', () => {
    eq(amt('').row.clear, true);
    eq(cleanLine({ amount: '', note: 'still thinking' }).row.clear, false);
    eq(cleanLine({ amount: '', flagged: true }).row.clear, false);
  });
  it('bounds the note rather than storing whatever arrives', () => {
    eq(cleanLine({ amount: '1', note: 'x'.repeat(900) }).row.note.length, 500);
  });
});

describe('the download', () => {
  const key = BUDGET_LINES[0].k;
  const out = csv(budgetRows({ [key]: { amount: 12, note: 'Shopify, Klaviyo and "the rest"' } }),
                  'proj', 'qtr', 2027);
  const lines = out.trim().split('\n');

  it('has a row per line and a header', () => eq(lines.length, BUDGET_LINES.length + 1));
  it('names the retail periods with their dates', () => {
    ok(/Q1 \(2027-01-03–2027-04-03\)/.test(lines[0]), lines[0]);
  });
  // The figure is the part somebody could have got anywhere; the note is
  // why it is that number. A quote or a comma in it must not shift columns.
  it('carries a note containing commas and quotes without breaking the row', () => {
    const cells = lines[1].match(/("([^"]|"")*"|[^,]*)/g).filter((x) => x !== '');
    eq(cells[cells.length - 1], '"Shopify, Klaviyo and ""the rest"""');
  });
  it('says whether each figure was decided or is still the baseline', () => {
    ok(/,baseline,/.test(lines[2]), 'an undecided line does not say so');
  });
});

// Three of the dash's five repeated bugs were a thing that existed in the
// repo and was never actually reachable. A tile pointing at a page of ours
// that is not deployed is the same bug with a 404 on the end.
describe('every tile that points at the dash itself points at a real page', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  it('has the file behind every local url', () => {
    for (const t of TILES) {
      if (!t.url || !t.url.startsWith('/')) continue;
      const f = path.join(HERE, '..', 'public', t.url.replace(/^\//, '').split('?')[0]);
      ok(fs.existsSync(f), t.key + ' points at ' + t.url + ', which is not in public/');
    }
  });
});

// The budget is the one thing behind this portal with a lock of its own.
// A tile is a door not shown -- that is the doctrine the whole Worker is
// built on -- so if the endpoint ever rides on the tile assignment instead,
// next year's payroll is readable by everybody the tile was shown to.
describe('the budget endpoint is gated on its own list', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');

  it('refuses before doing anything else', () => {
    ok(/async function budget\([^)]*\)\s*\{\s*if \(!canBudget\(env, who\)\)/.test(idx),
       'the budget handler does not begin by checking canBudget');
  });
  it('wants a verified Access identity, not just an address', () => {
    ok(/function canBudget[\s\S]*?who\.verified/.test(idx), 'canBudget ignores verification');
  });
  it('falls back to the admins rather than to an empty list', () => {
    ok(/function budgetList[\s\S]*?adminList\(env\)/.test(idx),
       'an empty BUDGET_USERS would lock everybody out, or let everybody in');
  });
});

describe('the retail year the budget is built on', () => {
  it('starts 2027 on the Sunday Jeremy’s calendar starts it', () => {
    eq(weekStart(2027, 1), '2027-01-03');
  });
  it('runs 52 weeks to the day before the next one starts', () => {
    const y = periods(2027, 'year')[0];
    eq([y.start, y.end, y.weeks], ['2027-01-03', '2028-01-01', 52]);
    eq(weekStart(2028, 1), '2028-01-02');
  });
  it('leaves no gap and no overlap between periods', () => {
    for (const c of CADENCES) {
      const ps = periods(2027, c);
      for (let i = 1; i < ps.length; i++) {
        const next = new Date(ps[i - 1].end + 'T00:00:00Z').getTime() + 86400000;
        eq(new Date(next).toISOString().slice(0, 10), ps[i].start, c + ' period ' + i);
      }
    }
  });
  it('gives the page every cadence at once', () => {
    eq(Object.keys(calendar(2027)).sort(), [...CADENCES].sort());
  });
});


// ── Labor planning ──────────────────────────────────────────────────────

// The invariant this whole design turns on. The Staff base holds salary
// history, SS numbers and I-9 attachments, and the inventory written last
// week called the duplicated copies of that the one real exposure in
// Airtable. A regenerated seed that quietly brought pay across would put a
// third copy into git -- in history, in every clone, for ever.
describe('the roster seed carries no pay', () => {
  const ALLOWED = new Set(['k', 'n', 't', 'd', 'v', 'pay', 'ft', 'type', 'tbh']);
  it('has only the fields it is meant to', () => {
    for (const p of ON_STAFF) {
      for (const f of Object.keys(p)) {
        ok(ALLOWED.has(f), p.k + ' carries an unexpected field: ' + f);
      }
    }
  });
  // "pay" is how, never how much. A number anywhere in this file is a
  // figure, and no figure belongs in it.
  it('holds no numbers at all', () => {
    for (const p of ON_STAFF) {
      for (const [f, v] of Object.entries(p)) {
        ok(typeof v !== 'number', p.k + '.' + f + ' is a number: ' + v);
      }
    }
  });
  it('names no field that sounds like money', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(HERE, '..', 'worker', 'labor-seed.js'), 'utf8');
    const body = src.slice(src.indexOf('export const PEOPLE'));
    ok(!/\b(salary|rate|wage|comp|hourly_rate|gross)\b\s*:/i.test(body),
       'the seed has a pay-shaped field in it');
  });
});

// The Jetty Rock Foundation is its own 501(c)(3), with its own books and
// its own payroll. Its people are in the Staff base because that is where
// the org chart lives; budgeting their wages against Jetty's Labor line
// would put another entity's costs into this company's P&L.
describe('a separate entity is not on this plan', () => {
  it('leaves them in the Staff base snapshot, which is a snapshot', () => {
    ok(ON_STAFF.some((p) => SEPARATE_DIVISIONS.includes(p.v)),
       'the seed was cut rather than filtered, so it no longer matches Staff');
  });
  it('keeps them off the plan', () => {
    for (const p of ROSTER) {
      ok(!SEPARATE_DIVISIONS.includes(p.v), p.k + ' is in ' + p.v);
    }
    ok(ROSTER.length < ON_STAFF.length, 'nobody was excluded at all');
  });
  it('keeps them out of the sheet and out of every total', () => {
    const gone = ON_STAFF.filter((p) => SEPARATE_DIVISIONS.includes(p.v));
    const rs = laborRows(Object.fromEntries(
      gone.map((p) => [p.k, { pay: 'salary', salary: 90000, cls: 'gna' }])));
    eq(rs.length, ROSTER.length, 'a decision put an excluded person back');
    eq(laborSummary(rs).roll.gna.cost, 0, 'their pay landed in a total');
    for (const g of byDepartment(rs)) {
      ok(!/nonprofit|jrf/i.test(g.dept), 'their department is still a band: ' + g.dept);
    }
  });
  it('keeps them out of the download', () => {
    const out = laborCsv(laborRows({}), 2027);
    for (const p of ON_STAFF.filter((x) => SEPARATE_DIVISIONS.includes(x.v))) {
      ok(!out.includes(p.n), p.n + ' is in the CSV');
    }
  });
  // Said on the page, not left as a list that is quietly two people short.
  it('says so on the page', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(HERE, '..', 'public', 'assets', 'labor.js'), 'utf8');
    const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');
    ok(/separate: SEPARATE_DIVISIONS/.test(idx), 'the Worker does not send what it left out');
    ok(/D\.separate/.test(page), 'the page does not say what it left out');
    // In the header line, which is what is left after the paragraph that
    // used to carry it was taken off.
    ok(/sub\.textContent[\s\S]{0,400}D\.separate/.test(page),
       'what was left out is only in a tooltip now');
  });
});

describe('the roster seed', () => {
  it('gives everybody a key of their own', () => {
    const seen = new Set();
    for (const p of ON_STAFF) {
      ok(p.k && !seen.has(p.k), 'duplicate or empty key: ' + p.k);
      seen.add(p.k);
      eq(laborKey(p.k), p.k, p.k + ' is not a key this would accept back');
    }
  });
  it('gives everybody a name and a department', () => {
    for (const p of ON_STAFF) {
      ok(p.n && p.n.trim(), p.k + ' has no name');
      ok(p.d && p.d.trim(), p.k + ' has no department');
    }
  });
  it('only uses ways of being paid that exist', () => {
    const known = new Set(PAY_TYPES.map((t) => t.key));
    for (const p of ON_STAFF) {
      ok(!p.pay || known.has(p.pay), p.k + ' is paid "' + p.pay + '"');
    }
  });
  it('has posts to be hired as well as people who are here', () => {
    ok(ROSTER.some((p) => p.tbh), 'no to-be-hired posts came across');
    ok(ROSTER.some((p) => !p.tbh), 'no actual people came across');
  });
  it('says when it was taken, because a roster goes stale', () => {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(ROSTER_AS_OF), ROSTER_AS_OF);
  });
});

// Showing 2,080 as a placeholder and then quietly using it would put a
// number nobody chose into the company's labor budget.
describe('what one person costs', () => {
  const at = (over) => ({ pay: '', rate: null, salary: null, hours: null, ...over });

  it('costs an hourly person at rate times hours', () => {
    eq(cost(at({ pay: 'hourly', rate: 26, hours: 2080 })), 54080);
  });
  it('will not cost an hourly person on a rate alone', () => {
    eq(cost(at({ pay: 'hourly', rate: 26 })), null);
    eq(cost(at({ pay: 'hourly', hours: 2080 })), null);
  });
  it('does not quietly assume a full-time year', () => {
    ok(FULL_TIME_HOURS === 2080, 'the placeholder moved');
    eq(cost(at({ pay: 'hourly', rate: 26 })), null, 'the placeholder became a decision');
  });
  it('costs a salaried person at their salary', () => {
    eq(cost(at({ pay: 'salary', salary: 72000 })), 72000);
  });
  it('costs an unpaid intern at nothing, not at zero', () => {
    eq(cost(at({ pay: 'unpaid', salary: 50000 })), null);
  });
  it('costs somebody with no way of being paid at nothing', () => {
    eq(cost(at({ salary: 50000 })), null);
  });
  it('treats a salary of zero as a decision, not as undecided', () => {
    eq(cost(at({ pay: 'salary', salary: 0 })), 0);
    eq(decided(at({ pay: 'salary', salary: 0 })), true);
  });
});

describe('the roster plus the plan', () => {
  const someone = ROSTER.find((p) => !p.tbh).k;

  it('shows everybody when nothing has been decided', () => {
    eq(laborRows({}).length, ROSTER.length);
  });
  it('takes the decision where there is one, the roster where there is not', () => {
    const r = laborRows({ [someone]: { pay: 'salary', salary: 81000 } })
      .find((x) => x.k === someone);
    eq([r.pay, r.salary], ['salary', 81000]);
    eq(r.n, ROSTER.find((p) => p.k === someone).n, 'the name stopped coming from the roster');
  });
  // The bug this codebase has now had six times: the seed is re-read on
  // every boot, so anything struck off comes straight back unless the
  // striking-off is itself stored.
  it('keeps somebody struck off struck off', () => {
    const rs = laborRows({ [someone]: { removed: true } });
    eq(rs.length, ROSTER.length - 1);
    ok(!rs.some((r) => r.k === someone), 'they came back');
  });
  it('shows a write-in with the name it was given', () => {
    const rs = laborRows({ 'ap-clerk': { added: true, name: 'A/P Clerk', dept: 'Finance' } });
    const mine = rs.find((r) => r.k === 'ap-clerk');
    eq([mine.n, mine.d, mine.added, mine.tbh], ['A/P Clerk', 'Finance', true, true]);
  });
  it('does not show a write-in that has been struck off', () => {
    eq(laborRows({ x: { added: true, name: 'X', removed: true } }).length, ROSTER.length);
  });
  it('files a write-in with no department under Unassigned', () => {
    eq(laborRows({ x: { added: true, name: 'X' } }).find((r) => r.k === 'x').d, 'Unassigned');
  });
});

describe('the sheet, by department', () => {
  it('puts Unassigned last however the alphabet falls', () => {
    const gs = byDepartment(laborRows({}));
    eq(gs[gs.length - 1].dept, 'Unassigned');
  });
  it('is otherwise alphabetical', () => {
    const real = byDepartment(laborRows({})).slice(0, -1).map((g) => g.dept.toLowerCase());
    eq(real, [...real].sort());
  });
  it('loses nobody', () => {
    const gs = byDepartment(laborRows({}));
    eq(gs.reduce((a, g) => a + g.people.length, 0), ROSTER.length);
  });
  // A list you are adding to must not reshuffle under the cursor.
  it('puts a write-in after the people already in its department', () => {
    const g = byDepartment(laborRows({ aaa: { added: true, name: 'Aaa', dept: 'Finance' } }))
      .find((x) => x.dept === 'Finance');
    eq(g.people[g.people.length - 1].k, 'aaa', 'the write-in sorted into the alphabet');
  });
});

// Commissions and partner draws are real money and real people, but they
// are their own budget lines. Rolling them into payroll would double count
// them the moment anybody compared the two.
describe('what the plan rolls up into', () => {
  it('splits payroll by what somebody decided, and nothing else by it', () => {
    eq(rollOf({ pay: 'salary', cls: 'direct' }), 'direct');
    eq(rollOf({ pay: 'hourly', cls: 'gna' }), 'gna');
    eq(rollOf({ pay: 'commission', cls: 'direct' }), 'commission',
       'a class on a commission line moved it');
    eq(rollOf({ pay: 'guaranteed' }), 'guaranteed');
    eq(rollOf({ pay: 'unpaid' }), 'other');
    eq(rollOf({ pay: '' }), 'other');
  });
  // Putting unsplit payroll into either half would be a guess with
  // somebody's wages in it; leaving it out of the totals altogether would
  // hide the work still to do.
  it('holds payroll nobody has split in a bucket of its own', () => {
    eq(rollOf({ pay: 'salary' }), 'unclassified');
    eq(rollOf({ pay: 'hourly', cls: '' }), 'unclassified');
    const who = ROSTER.filter((p) => p.pay === 'salary')[0];
    const s = laborSummary(laborRows({ [who.k]: { pay: 'salary', salary: 90000 } }));
    eq(s.roll.unclassified.cost, 90000);
    eq([s.roll.direct.cost, s.roll.gna.cost], [0, 0]);
  });
  it('keeps a commission out of both halves of payroll', () => {
    const who = ROSTER.filter((p) => p.pay === 'commission')[0];
    ok(who, 'nobody in the roster is on commission to test with');
    const s = laborSummary(laborRows({ [who.k]: { pay: 'commission', salary: 90000 } }));
    eq(s.roll.direct.cost + s.roll.gna.cost + s.roll.unclassified.cost, 0);
    eq(s.roll.commission.cost, 90000);
  });
  it('counts every head exactly once', () => {
    const s = laborSummary(laborRows({}));
    eq(ROLLUPS.reduce((a, r) => a + s.roll[r.key].heads, 0), ROSTER.length);
  });
  it('sends direct labor and G&A to different places', () => {
    const [a, b] = ROSTER.filter((p) => p.pay === 'salary').slice(0, 2);
    const s = laborSummary(laborRows({
      [a.k]: { pay: 'salary', salary: 100000, cls: 'direct' },
      [b.k]: { pay: 'salary', salary: 60000, cls: 'gna' },
    }));
    eq([s.roll.direct.cost, s.roll.gna.cost], [100000, 60000]);
  });
  it('counts only the people somebody has actually costed', () => {
    const who = ROSTER.filter((p) => p.pay === 'salary')[0];
    eq(laborSummary(laborRows({ [who.k]: { pay: 'salary', salary: 1 } })).set, 1);
    eq(laborSummary(laborRows({})).set, 0);
  });
});

// A rollup pointing at a budget line that does not exist would show "not
// set" for ever and nobody would know why.
describe('the plan against the budget', () => {
  it('points every rollup at a line the budget actually has', () => {
    for (const r of ROLLUPS) {
      if (!r.line) continue;
      ok(BUDGET_LINES.some((l) => l.k === r.line),
         r.key + ' rolls into "' + r.line + '", which is not a budget line');
    }
  });
  // Partner draws are decided in the budget, not on this sheet. Comparing
  // them said the plan was $300,000 short of a line nobody fills in from
  // here -- a gap that reads as outstanding work and is nothing of the
  // kind.
  it('does not compare the partner draws against the budget', () => {
    const out = against(laborSummary(laborRows({})), {}, 'proj');
    ok(!out.some((a) => a.key === 'guaranteed'),
       'guaranteed payments are still being measured against a budget line');
    ok(ROLLUPS.some((r) => r.key === 'guaranteed'),
       'the partners fell off the sheet altogether');
  });
  // Everything else still is, or the comparison would quietly be empty.
  it('still compares the two halves of payroll', () => {
    const out = against(laborSummary(laborRows({})), {}, 'proj');
    for (const k of ['direct', 'gna', 'commission']) {
      ok(out.some((a) => a.key === k), k + ' lost its budget line');
    }
  });
  it('falls back to the 2026 baseline when the line is undecided', () => {
    const out = against(laborSummary(laborRows({})), {}, 'proj');
    const direct = out.find((a) => a.key === 'direct');
    eq(direct.budget, BUDGET_LINES.find((l) => l.k === 'labor-total').proj);
    eq(direct.decided, false);
  });
  it('uses the decision once there is one', () => {
    const out = against(laborSummary(laborRows({})), { 'labor-total': { amount: 3000000 } }, 'proj');
    const direct = out.find((a) => a.key === 'direct');
    eq([direct.budget, direct.decided], [3000000, true]);
  });
  it('reports the gap in the direction that reads as overspend', () => {
    const who = ROSTER.filter((p) => p.pay === 'salary')[0];
    const rs = laborRows({ [who.k]: { pay: 'salary', salary: 4000000, cls: 'direct' } });
    const direct = against(laborSummary(rs), { 'labor-total': { amount: 3000000 } }, 'proj')
      .find((a) => a.key === 'direct');
    eq(direct.gap, 1000000, 'a plan over budget did not come out positive');
  });
  // G&A has no 2026 behind it -- 2026 put the whole of payroll in one COGS
  // line -- so its budget cell is empty rather than zero, and the plan is
  // the only figure there is.
  it('says the G&A line has no baseline rather than calling it zero', () => {
    const gna = against(laborSummary(laborRows({})), {}, 'proj').find((a) => a.key === 'gna');
    eq(gna.budget, null, 'a line that did not exist in 2026 came back as a number');
    eq(gna.lineName, 'Salaries \u2014 G&A');
  });
});

describe('what somebody typed into a person', () => {
  const base = { pay: 'salary', salary: '72,000' };
  it('takes figures typed the way people type figures', () => {
    const r = cleanLaborPerson({ pay: 'hourly', rate: '$26.50', hours: '1,560' }).row;
    eq([r.rate, r.hours], [26.5, 1560]);
  });
  it('refuses what is not a figure', () => {
    ok(cleanLaborPerson({ ...base, salary: 'about 70k' }).errors);
  });
  it('refuses more hours than a year has', () => {
    ok(cleanLaborPerson({ pay: 'hourly', rate: '20', hours: '20000' }).errors);
    ok(!cleanLaborPerson({ pay: 'hourly', rate: '20', hours: '2080' }).errors);
  });
  it('refuses a way of being paid that does not exist', () => {
    ok(cleanLaborPerson({ pay: 'equity' }).errors);
  });
  it('wants a name on a write-in, since nothing else knows about it', () => {
    ok(cleanLaborPerson({ added: true, name: '  ' }).errors);
    ok(!cleanLaborPerson({ added: true, name: 'Ink Sales Associate' }).errors);
  });
  // A second copy of somebody's name that drifts from the Staff base is how
  // the duplicated-roster problem started in the first place.
  it('does not let a seeded person be renamed here', () => {
    eq(cleanLaborPerson({ name: 'Somebody Else', pay: 'salary', salary: '1' }).row.name, '');
  });
  it('calls a seeded person with nothing on their line undecided', () => {
    eq(cleanLaborPerson({}).row.clear, true);
    eq(cleanLaborPerson({ note: 'raise in Q2' }).row.clear, false);
    eq(cleanLaborPerson({ pay: 'salary' }).row.clear, false);
  });
  // A write-in is the only record that the post exists, so its row never
  // goes just because the figures were cleared.
  it('never calls a write-in undecided', () => {
    eq(cleanLaborPerson({ added: true, name: 'New post' }).row.clear, false);
  });
  it('reads a cleared figure as cleared, and zero as zero', () => {
    eq(num(''), null);
    eq(num('0'), 0);
    eq(num(null), null);
    eq(num('abc'), undefined);
  });
});

describe('the labor download', () => {
  const who = ROSTER.filter((p) => p.pay === 'hourly')[0];
  const out = laborCsv(laborRows({
    [who.k]: { pay: 'hourly', rate: 26, hours: 2080, note: 'Raise in Q2, "if" INK holds' },
  }), 2027);
  const lines = out.trim().split('\n');

  it('has a row per person and a header', () => eq(lines.length, ROSTER.length + 1));
  it('says which budget line each person lands on', () => {
    ok(/Rolls into/.test(lines[0]), lines[0]);
  });
  it('carries a note with commas and quotes without breaking the row', () => {
    ok(out.includes('"Raise in Q2, ""if"" INK holds"'), 'the note was not escaped');
  });
  it('says who is a post rather than a person', () => {
    ok(/,To be hired,/.test(out), 'nothing is marked to-be-hired');
  });
});

// The page has to redraw the instant a figure is typed, which it cannot do
// by asking the server -- so which figures a way of being paid asks for is
// decided in two places. They have to agree, or a row is un-fillable.
describe('the page and the Worker agree on what each row asks for', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const page = fs.readFileSync(path.join(HERE, '..', 'public', 'assets', 'labor.js'), 'utf8');

  it('only uses the three answers the page knows how to draw', () => {
    for (const t of PAY_TYPES) {
      ok(['rate', 'salary', 'none'].includes(t.asks),
         t.key + ' asks for "' + t.asks + '", which the page cannot draw');
    }
  });
  it('reads them off what the Worker sent, rather than keeping its own list', () => {
    ok(/D\.payTypes/.test(page), 'the page does not use the types the Worker sent');
    ok(!/'commission'|'guaranteed'|'unpaid'/.test(page),
       'the page hardcodes a pay type, which will drift from PAY_TYPES');
  });
  it('gives every rollup the page draws a label', () => {
    for (const r of ROLLUPS) ok(r.label, r.key + ' has no label');
  });
  it('has a rollup for every way a person can be classified', () => {
    for (const c of CLASSES) {
      ok(ROLLUPS.some((r) => r.key === c.roll),
         c.key + ' rolls into "' + c.roll + '", which is not a total');
    }
    ok(ROLLUPS.some((r) => r.key === 'unclassified'),
       'payroll nobody has split has nowhere to go');
  });
  it('reads the classes off what the Worker sent, not its own list', () => {
    ok(/D\.classes/.test(page), 'the page does not use the classes the Worker sent');
    // The dropdown is built from what the Worker sent; nothing names a
    // class where a list would do.
    const fn = page.slice(page.indexOf('function clsCell(p)'),
                          page.indexOf('function pick(p,'));
    ok(fn.length > 100, 'the cell this is about has moved or gone');
    ok(!/'direct'|'gna'/.test(fn), 'the row hardcodes a class, which will drift');
  });
  // The totals strip is the one place that does name them, because it was
  // asked for in those terms: direct labor and G&A, specifically. Naming
  // them is fine; naming one that does not exist is not, and would show
  // $0 for ever without saying why.
  it('names only rollups that exist, where it names them at all', () => {
    const fn = page.slice(page.indexOf("var vs = $('#vs')"), page.indexOf("$('#dl').href"));
    const named = [...fn.matchAll(/by\.([a-z]+)/g)].map((m) => m[1]);
    ok(named.length, 'the strip names no rollup at all, so this proves nothing');
    for (const k of new Set(named)) {
      ok(ROLLUPS.some((r) => r.key === k), 'the strip reads by.' + k + ', which is not a rollup');
    }
  });
});

describe('setting a whole department at once', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');
  const store = fs.readFileSync(path.join(HERE, '..', 'worker', 'store.js'), 'utf8');

  it('only accepts a kind of labor that exists', () => {
    ok(/CLASSES\.some\(\(c\) => c\.key === cls\)/.test(idx),
       'the classify endpoint does not check the value it is given');
  });
  it('only touches people this plan actually has', () => {
    ok(/known\.has\(k\)/.test(idx),
       'a key from anywhere would create a row for somebody who never shows');
  });
  // A bulk write that also wrote the figures would wipe a salary somebody
  // had already typed, for everybody in the department, in one click.
  it('writes only the one field', () => {
    const fn = store.slice(store.indexOf('export async function classifyPeople'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    for (const col of ['salary', 'rate', 'hours', 'pay_type', 'note', 'name']) {
      ok(!new RegExp('\\b' + col + '\\b').test(body),
         'classifyPeople touches ' + col);
    }
  });
});

// The labor table shipped before payroll was split. CREATE TABLE IF NOT
// EXISTS does not revisit a table that already exists, so a column added to
// schema.sql alone reaches every database except the live one -- the trap
// ADDED_COLUMNS exists for, and the one this codebase keeps falling into.
describe('the direct/G&A column reaches a database that already exists', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const store = fs.readFileSync(path.join(HERE, '..', 'worker', 'store.js'), 'utf8');
  const schema = fs.readFileSync(path.join(HERE, '..', 'worker', 'schema.sql'), 'utf8');

  it('is in the schema, for a database that does not exist yet', () => {
    ok(/CREATE TABLE IF NOT EXISTS labor[\s\S]*?cls\s+TEXT/.test(schema),
       'labor has no cls column in schema.sql');
  });
  it('is in ADDED_COLUMNS, for the one that does', () => {
    const added = store.slice(store.indexOf('const ADDED_COLUMNS'));
    ok(/\['labor', 'cls TEXT/.test(added.slice(0, added.indexOf('];'))),
       'nothing adds cls to a labor table that already exists');
  });
});

describe('labor planning is gated and reachable', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');
  const budgetPage = fs.readFileSync(path.join(HERE, '..', 'public', 'budget.html'), 'utf8');

  it('refuses before doing anything else', () => {
    ok(/async function labor\([^)]*\)\s*\{\s*if \(!canBudget\(env, who\)\)/.test(idx),
       'the labor handler does not begin by checking canBudget');
  });
  it('has a page behind the link the budget offers', () => {
    const m = budgetPage.match(/href="\/(labor\.html)"/);
    ok(m, 'the budget page does not link to labor planning');
    ok(fs.existsSync(path.join(HERE, '..', 'public', m[1])), m[1] + ' is not in public/');
  });
  it('gets back to the budget from the labor page', () => {
    const labourPage = fs.readFileSync(path.join(HERE, '..', 'public', 'labor.html'), 'utf8');
    ok(/href="\/budget\.html"/.test(labourPage), 'no way back to the budget');
  });
});

// ── Two years on one sheet ──────────────────────────────────────────────
//
// The plan year is what is being budgeted; the year before it is what
// people were actually paid, which is the thing the budget is estimated
// from. Both are typed into the same grid and stored as two rows in the
// labor table, joined on the person.

describe('the baseline year beside the plan', () => {
  const HERE2 = path.dirname(fileURLToPath(import.meta.url));
  const rd = (f) => fs.readFileSync(path.join(HERE2, '..', f), 'utf8');

  // 2026 cannot be budgeted -- budgeting the year you quote against is
  // circular -- but it has to be recordable, or the comparison lives
  // somewhere else.
  it('records a year the budget will not plan', () => {
    eq(cleanYear(BASELINE_YEAR), 0, 'the budget would plan the baseline');
    eq(cleanLaborYear(BASELINE_YEAR), BASELINE_YEAR);
    eq(cleanLaborYear(FIRST_YEAR), FIRST_YEAR);
    eq(cleanLaborYear(LAST_YEAR), LAST_YEAR);
  });
  it('still refuses a year on neither side of that', () => {
    eq(cleanLaborYear(BASELINE_YEAR - 1), 0);
    eq(cleanLaborYear(LAST_YEAR + 1), 0);
    eq(cleanLaborYear('nineteen'), 0);
  });

  const one = (over) => Object.assign(
    { k: 'ann', n: 'Ann Lee', t: 'Manager', d: 'Finance', v: 'BRAND',
      pay: 'salary', cls: 'gna', rate: null, salary: 80000, hours: null,
      tbh: false, added: false, note: '' }, over || {});

  it('hangs last year on the same person', () => {
    const r = withPrior([one()], { ann: { pay: 'salary', salary: 72000 } })[0];
    eq(r.prior.salary, 72000);
    eq(r.prior.cost, 72000);
    eq(r.salary, 80000, 'the plan year was overwritten by the baseline');
  });
  // Somebody hourly last year and salaried this year is ordinary. Costing
  // their 2026 against a 2027 salary would be nonsense in the one column
  // meant to be the fact.
  it('costs the baseline against the way they were paid then', () => {
    const r = withPrior([one()], { ann: { pay: 'hourly', rate: 30, hours: 1800 } })[0];
    eq(r.prior.cost, 54000);
    eq(r.prior.pay, 'hourly');
  });
  it('leaves the baseline empty rather than guessing it', () => {
    const r = withPrior([one()], {})[0];
    eq(r.prior.cost, null);
    eq(r.prior.salary, null);
    eq(r.prior.pay, 'salary', 'with nothing recorded, this year is the best guess at how');
  });
  // Half a figure is not a cost. The same rule the plan year is under.
  it('will not cost an hourly baseline from a rate alone', () => {
    const r = withPrior([one()], { ann: { pay: 'hourly', rate: 30 } })[0];
    eq(r.prior.cost, null);
  });

  it('puts both years in the download, and neither twice', () => {
    const rs = withPrior([one()], { ann: { pay: 'salary', salary: 72000 } });
    const out = laborCsv(rs, 2027, 2026).split('\n');
    const head = out[0];
    ok(head.includes('2026 total') && head.includes('2027 projection'), head);
    eq(head.split(',').length, out[1].split(',').length, 'a row is a different width');
    ok(out[1].includes('72000') && out[1].includes('80000'));
  });
  // A download of the plan alone should not be six empty columns wide.
  it('leaves the baseline columns out when there is no baseline', () => {
    const head = laborCsv([one()], 2027).split('\n')[0];
    ok(!head.includes('2026'), head);
  });
});

// ── Finding one person among ninety-four ────────────────────────────────

describe('narrowing the labor sheet', () => {
  const rs = withPrior([
    { k: 'ann', n: 'Ann Lee', t: 'Finance Manager', d: 'Finance', v: 'BRAND',
      pay: 'salary', cls: 'gna', salary: 80000, rate: null, hours: null, tbh: false },
    { k: 'bo', n: 'Bo Diaz', t: 'Press Operator', d: 'Production', v: 'INK',
      pay: 'hourly', cls: '', salary: null, rate: 22, hours: 2080, tbh: false },
    { k: 'cy', n: 'Cy Park', t: 'Sales Rep', d: 'Wholesale', v: 'MIXED',
      pay: 'commission', cls: '', salary: null, rate: null, hours: null, tbh: true },
  ], { ann: { pay: 'salary', salary: 76000 } });
  const keys = (f) => rs.filter((r) => matches(r, f)).map((r) => r.k).join(',');

  it('asks nothing when nothing is picked', () => {
    eq(keys({}), 'ann,bo,cy');
    eq(keys({ show: 'all' }), 'ann,bo,cy');
  });
  it('finds a person by any part of their row', () => {
    eq(keys({ q: 'ann' }), 'ann');
    eq(keys({ q: 'press' }), 'bo', 'the job title is not searched');
    eq(keys({ q: 'finance' }), 'ann', 'the department is not searched');
    eq(keys({ q: 'ink' }), 'bo', 'the division is not searched');
    eq(keys({ q: 'ANN' }), 'ann', 'case matters, and should not');
  });
  it('filters by each column it offers', () => {
    eq(keys({ division: 'INK' }), 'bo');
    eq(keys({ dept: 'Wholesale' }), 'cy');
    eq(keys({ pay: 'salary' }), 'ann');
    eq(keys({ cls: 'gna' }), 'ann');
  });
  // Not split yet is a real answer, and not the same as asking nothing.
  it('can ask for the ones nobody has split', () => {
    eq(keys({ cls: '-' }), 'bo,cy');
  });
  // Picking Brand and then Finance means Brand Finance, not Brand or
  // Finance. Every field narrows the last.
  it('narrows rather than widens as more is picked', () => {
    eq(keys({ division: 'BRAND', dept: 'Finance' }), 'ann');
    eq(keys({ division: 'INK', dept: 'Finance' }), '');
  });
  it('answers the questions the figures raise', () => {
    eq(keys({ show: 'todo' }), 'cy', 'commission has no figure, so it is undecided');
    eq(keys({ show: 'base-todo' }), 'bo,cy', 'the baseline is only backfilled for one');
    eq(keys({ show: 'tbh' }), 'cy');
    eq(keys({ show: 'payroll' }), 'ann,bo');
    eq(keys({ show: 'unsplit' }), 'bo', 'commission does not split, so it is not unsplit');
  });

  // The sheet narrows as you type, which it cannot do by asking the
  // server -- so the rule is in both places and this is what keeps them
  // honest. The same arrangement asks() and roll() are already under.
  it('is the same rule on the page as in the Worker', () => {
    const HERE2 = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(
      path.join(HERE2, '..', 'public', 'assets', 'labor.js'), 'utf8');
    const fn = page.slice(page.indexOf('function keep(p)'),
                          page.indexOf('function shown()'));
    for (const field of ['division', 'dept', 'pay', 'cls']) {
      ok(fn.includes("f." + field), 'the page does not filter on ' + field);
    }
    for (const show of SHOWS.map((x) => x.key).filter((x) => x !== 'all')) {
      ok(fn.includes("'" + show + "'"), 'the page does not know the ' + show + ' filter');
    }
    ok(fn.includes("f.cls === '-'"), 'not-split-yet means nothing on the page');
  });
  it('offers every one of them on the page', () => {
    const HERE2 = path.dirname(fileURLToPath(import.meta.url));
    const html = fs.readFileSync(path.join(HERE2, '..', 'public', 'labor.html'), 'utf8');
    for (const id of ['q', 'fDiv', 'fDept', 'fPay', 'fCls', 'filter']) {
      ok(html.includes('id="' + id + '"'), 'no control for ' + id);
    }
  });
});

// ── Writing to the right year ───────────────────────────────────────────

describe('which year a typed figure lands on', () => {
  const HERE2 = path.dirname(fileURLToPath(import.meta.url));
  const idx = fs.readFileSync(path.join(HERE2, '..', 'worker', 'index.js'), 'utf8');
  const at = idx.indexOf("what === '/person'");
  // To the end of the labor router, not to the first early return in it.
  const body = idx.slice(at, idx.indexOf("No such endpoint.", at));
  const page = fs.readFileSync(
    path.join(HERE2, '..', 'public', 'assets', 'labor.js'), 'utf8');

  it('takes the year from the row that was typed in', () => {
    ok(/const onYear = body\.year == null \? year : cleanLaborYear\(body\.year\)/.test(body),
       'every figure lands on the plan year whatever was typed');
    ok(/saveLaborPerson\(env\.DB, onYear, key/.test(body),
       'the year is worked out and then not used');
  });
  // A year outside the two on screen is a figure nobody can see again.
  it('refuses a year this page does not show', () => {
    ok(/onYear !== year && onYear !== baseYear/.test(body),
       'any year at all could be written to');
  });
  // The baseline is a record of what happened. The note, the split and
  // next year's pay decision belong to the year being planned, and one
  // edit must not quietly change two years.
  it('sends only the figures to the baseline', () => {
    const fn = page.slice(page.indexOf('function saveBase(p)'),
                          page.indexOf('// ── Wiring'));
    ok(/year: D\.baseYear/.test(fn), 'the baseline saves to the plan year');
    ok(!/cls:/.test(fn), 'the split is written onto the baseline too');
    ok(!/note:/.test(fn), 'the note is written onto the baseline too');
    ok(/rate: b\.rate/.test(fn) && /hours: b\.hours/.test(fn)
       && /salary: b\.salary/.test(fn), 'the baseline figures are not sent');
  });
  // Struck off is struck off. A person who came back the moment you
  // looked at the baseline is the bug this codebase has had six times.
  it('takes somebody off the plan rather than off one year of it', () => {
    ok(/removeLaborPerson\(env\.DB, year, key/.test(body),
       'a removal is scoped to whichever year was being typed in');
  });
});

// ── The roster is where a person starts, not where they are fixed ───────
//
// Department and hours were read off the Staff base and could not be
// changed here. Moving somebody for next year, or putting them on four
// days, is a decision about the plan -- and the Staff base is still right
// about today either way.

describe('overriding what the roster says', () => {
  const seeded = ROSTER[0];

  it('keeps the roster answer when nothing was decided', () => {
    const r = laborRows({})[0];
    eq(r.d, ROSTER[0].d);
    eq(r.ft, ROSTER[0].ft);
  });
  it('takes the decision over the roster when there is one', () => {
    const r = laborRows({ [seeded.k]: { dept: 'Wholesale', ft: 'Part-time' } })
      .filter((x) => x.k === seeded.k)[0];
    eq(r.d, 'Wholesale');
    eq(r.ft, 'Part-time');
  });
  // Empty is "as the roster has it", which is not the same as a blank: an
  // outsourced supplier is neither full nor part time, and writing the
  // seeded value onto every row would freeze each one against a later
  // roster.
  it('does not store the roster answer as a decision', () => {
    const row = cleanLaborPerson({ dept: '', ft: '' }, null).row;
    eq(row.dept, '');
    eq(row.ft, '');
  });
  it('moves somebody between divisions as well', () => {
    const r = laborRows({ [seeded.k]: { division: 'INK' } })
      .filter((x) => x.k === seeded.k)[0];
    eq(r.v, 'INK');
  });
  // The list comes off the roster so it cannot drift from the Staff base,
  // and leaves out the entity this plan deliberately does not budget for.
  it('offers the divisions this plan budgets for, and no others', () => {
    for (const v of DIVISIONS) {
      ok(ROSTER.some((p) => p.v === v), v + ' is on the list and on nobody');
    }
    for (const v of SEPARATE_DIVISIONS) ok(!DIVISIONS.includes(v), v);
    for (const p of ROSTER) ok(!p.v || DIVISIONS.includes(p.v), p.k + ' is in ' + p.v);
  });
  // They would stay on the sheet and in every total while reading as
  // though they belonged to another company's books.
  it('will not label somebody into the entity it leaves out', () => {
    for (const v of SEPARATE_DIVISIONS) {
      ok(cleanLaborPerson({ division: v }, null).errors, v + ' was accepted');
    }
    ok(!cleanLaborPerson({ division: 'INK' }, null).errors);
  });
  it('refuses hours that are not a kind of hours', () => {
    ok(cleanLaborPerson({ ft: 'Sometimes' }, null).errors);
    for (const v of FT_TYPES) ok(!cleanLaborPerson({ ft: v }, null).errors, v);
  });
  // A row whose only content is an override is still a decision. Clearing
  // it would put the person back where the roster had them the moment the
  // page reloaded.
  it('keeps a row that carries nothing but an override', () => {
    eq(cleanLaborPerson({ dept: 'Wholesale' }, null).row.clear, false);
    eq(cleanLaborPerson({ ft: 'Part-time' }, null).row.clear, false);
    eq(cleanLaborPerson({}, null).row.clear, true, 'an empty line should go');
  });
  // Two spellings of one department would split the filter, the totals and
  // the classifier three ways.
  it('is picked from a list on the page rather than typed', () => {
    const HERE2 = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(
      path.join(HERE2, '..', 'public', 'assets', 'labor.js'), 'utf8');
    ok(/pick\(p, 'division'/.test(page), 'the division is not a picker');
    ok(/pick\(p, 'dept'/.test(page), 'the department is not a picker');
    ok(/pick\(p, 'ft'/.test(page), 'the hours are not a picker');
    ok(/function deptOptions/.test(page), 'the list is not built from the plan');
  });
  it('reaches a database that already exists', () => {
    const HERE2 = path.dirname(fileURLToPath(import.meta.url));
    const store = fs.readFileSync(path.join(HERE2, '..', 'worker', 'store.js'), 'utf8');
    ok(/\['labor', 'ft TEXT/.test(store), 'the column never reaches the live database');
    ok(/ft = excluded\.ft/.test(store), 'a second save would not change it');
  });
});

// ── One strip, not two ──────────────────────────────────────────────────
//
// The labor sheet carried the same six totals twice: a panel under the
// filters comparing the plan against the budget, and a bar pinned to the
// bottom of the window. The pinned one covered the last row of the sheet
// to say what was already on screen.

describe('what the labor totals are shown in', () => {
  const HERE2 = path.dirname(fileURLToPath(import.meta.url));
  const rd = (f) => fs.readFileSync(path.join(HERE2, '..', f), 'utf8');
  const page = rd('public/assets/labor.js');

  it('has no pinned bar left on the labor page', () => {
    ok(!/id="pl"/.test(rd('public/labor.html')), 'the bar is still in the markup');
    ok(!/\$\('#pl'\)/.test(page), 'the page still writes to it');
  });
  // The budget sheet is a different page with a different shape, and
  // nobody asked for its footer to go.
  it('leaves the budget page\'s own footer alone', () => {
    ok(/id="pl"/.test(rd('public/budget.html')), 'the budget lost its P&L bar');
    ok(/\$\('#pl'\)/.test(rd('public/assets/budget.js')), 'nothing fills it any more');
  });
  // Chosen rather than enumerated: the rollups are how a cost is filed,
  // this is how the plan is read. Not yet split, Commissions and the
  // total including partners were all taken off deliberately.
  it('shows the figures the strip was asked for, and only those', () => {
    const fn = page.slice(page.indexOf("var vs = $('#vs')"), page.indexOf("$('#dl').href"));
    for (const label of ['Direct labor', 'Salaries', 'Hourly total',
                         'Salaried total']) {
      ok(fn.includes(label), label + ' is not on the strip');
    }
    ok(!/Not yet split|Commissions|incl\. partners/.test(fn),
       'something taken off is back');
    for (const label of ['Est. payroll taxes', '% of revenue']) {
      ok(fn.includes(label), label + ' is not on the strip');
    }
    ok(/id="saved"/.test(fn), 'the saving indicator went with the pinned bar');
    ok(/vs budget/.test(fn), 'the comparison went with the panel');
  });
  // The budget's Labor line is the whole of labour. Direct labor is one
  // half of it, so the gap between them was never a shortfall -- it was
  // the other half, read as work outstanding.
  it('does not measure direct labor against the whole of labour', () => {
    const fn = page.slice(page.indexOf("var vs = $('#vs')"), page.indexOf("$('#dl').href"));
    // The third argument to tile() is the budget line it compares
    // against, and an empty one is what says "do not". Matched on that
    // argument rather than on the word, because 'direct' appears either
    // way -- by.direct is the figure itself.
    ok(/tile\('Direct labor',[^,]+,\s*''/.test(fn),
       'direct labor is compared against a budget line again');
  });
  // Hourly plus Salaried is Total exactly; Direct plus G&A is Total less
  // whatever is unsplit. That second gap has no tile any more, so it has
  // to be said somewhere or the strip simply does not add up.
  // Eleven per cent is a planning number, not a calculation -- employer
  // FICA is 7.65% and the unemployment insurances are the rest. It lives
  // in the Worker so there is one of it, and the page names it so the
  // figure can be reproduced by whoever is arguing with it.
  it('keeps the tax rate in one place and says what it is', () => {
    eq(PAYROLL_TAX_RATE, 0.11);
    const idx = fs.readFileSync(path.join(HERE2, '..', 'worker', 'index.js'), 'utf8');
    ok(/taxRate: PAYROLL_TAX_RATE/.test(idx), 'the page is never told the rate');
    const fn = page.slice(page.indexOf("var vs = $('#vs')"), page.indexOf("$('#dl').href"));
    ok(/D\.taxRate/.test(fn), 'the page has a rate of its own, which will drift');
    ok(!/0\.11|11%/.test(fn), 'the rate is written into the page as well');
    ok(/of Total/.test(fn), 'the tile never says what it is a percentage of');
  });
  // Payroll as a share of revenue with the employer's own contribution
  // left out is the smaller half of what employing anybody costs.
  it('measures payroll against revenue with the tax on it', () => {
    const fn = page.slice(page.indexOf("var vs = $('#vs')"), page.indexOf("$('#dl').href"));
    ok(/var loaded = payroll \+ payroll \* rate/.test(fn),
       'the share leaves the payroll tax out');
    ok(/pctTile\(loaded, D\.revenue\)/.test(fn), 'the share is of something else');
  });
  // 0% and "no budget yet" are different answers, and only one of them
  // is true when the year has no revenue in it.
  it('draws no share at all when there is no revenue to share', () => {
    const fn = page.slice(page.indexOf('var pctTile'), page.indexOf('vs.innerHTML'));
    ok(/if \(!revenue\)/.test(fn), 'a year with no budget reads as 0%');
  });
  // A year is a different plan, a different baseline and a different
  // budget to read it against.
  it('offers the budget\'s own years and fetches the one picked', () => {
    const idx = fs.readFileSync(path.join(HERE2, '..', 'worker', 'index.js'), 'utf8');
    ok(/years: yearRange\(\)/.test(idx), 'the page is never told which years exist');
    ok(/revenue: budgetSummary/.test(idx), 'revenue is not read off the budget');
    ok(/#fYear/.test(page) && /api\('\/api\/labor\?year=' \+ want\)/.test(page),
       'picking a year does not go and get it');
  });
  it('explains the one gap it is allowed to have', () => {
    const fn = page.slice(page.indexOf("var vs = $('#vs')"), page.indexOf("$('#dl').href"));
    ok(/unsplitCost/.test(fn), 'nothing measures what is left unsplit');
    ok(/not split into direct/.test(fn), 'the gap under Total is never explained');
  });
});

// ── COGS planning ───────────────────────────────────────────────────────
//
// A row is a season and a kind of buy: the bulk production run, and the
// salesman samples that go out months ahead of it against the same season.
// Keeping those two apart is most of why the sheet exists -- a season
// costed as one number has the samples buried in it or missing.

describe('the COGS sheet', () => {
  const HERE2 = path.dirname(fileURLToPath(import.meta.url));
  const rd = (f) => fs.readFileSync(path.join(HERE2, '..', f), 'utf8');

  it('opens with every season bought both ways', () => {
    eq(COGS_SEED.length, COGS_SEASONS.length * COGS_KINDS.length);
    eq(cogsRows({}).length, COGS_SEED.length);
    for (const want of ['sp27', 'su27', 'f27', 'h27', 'collab',
                        'special-drops', 'starboard']) {
      ok(COGS_SEASONS.some((s) => s.key === want), want + ' is not a season');
    }
    eq(COGS_KINDS.map((k) => k.key).join(','), 'bulk,sms');
  });
  // There is no seeded figure anywhere, which is what makes a blank a
  // blank rather than a zero somebody might read as a decision.
  it('opens with no money in it at all', () => {
    for (const r of cogsRows({})) eq(r.amount, null, r.id + ' arrived costed');
    ok(!/\b\d{4,}\b/.test(rd('worker/cogs.js').replace(/\b2\d{3}\b/g, '')),
       'there is a figure in the module');
  });

  const saved = {
    'sp27:bulk': { amount: 1240000 },
    'sp27:sms': { amount: 48500 },
    'sp26:bulk': { added: true, season: 'sp26', kind: 'bulk',
                   seasonLabel: 'SP26', amount: 1192000 },
  };

  it('keeps a struck-off line struck off', () => {
    const rs = cogsRows({ ...saved, 'h27:sms': { removed: true } });
    ok(!rs.some((r) => r.id === 'h27:sms'), 'the seed put it back');
    eq(rs.length, COGS_SEED.length, 'and took something else with it');
  });
  it('carries a backfilled season that nothing else knows about', () => {
    const rs = cogsRows(saved);
    const back = rs.filter((r) => r.season === 'sp26')[0];
    ok(back && back.added, 'the prior season is not on the sheet');
    eq(back.seasonLabel, 'SP26', 'it has no name of its own');
  });
  it('offers the planned seasons first and the backfilled ones behind', () => {
    const got = cogsSeasons(cogsRows(saved)).map((s) => s.key);
    eq(got.slice(0, COGS_SEASONS.length), COGS_SEASONS.map((s) => s.key));
    eq(got[got.length - 1], 'sp26');
  });

  it('totals bulk and samples apart as well as together', () => {
    const s = cogsSummary(cogsRows(saved));
    eq(s.byKind.bulk.cost, 1240000 + 1192000);
    eq(s.byKind.sms.cost, 48500);
    eq(s.total, 1240000 + 1192000 + 48500);
  });
  // A season nobody has costed is not a season costing nothing, and the
  // difference is the whole of what is left to do.
  it('counts what has been costed, not what exists', () => {
    const s = cogsSummary(cogsRows(saved));
    eq(s.decided, 3);
    eq(s.lines, COGS_SEED.length + 1);
    ok(s.lines > s.decided, 'everything reads as decided');
    // Per kind too: "5 of 8 costed" is what the strip says, and it is the
    // only thing on the page saying how much is left to do.
    eq([s.byKind.bulk.decided, s.byKind.bulk.lines], [2, COGS_SEASONS.length + 1]);
    eq([s.byKind.sms.decided, s.byKind.sms.lines], [1, COGS_SEASONS.length]);
  });
  // A season bought bulk twice is either two commitments or one typed in
  // twice, and the sheet cannot tell. It can say so, which is the
  // difference between a total somebody trusts and a silent double count.
  it('says when a season is on the sheet twice', () => {
    eq(cogsDuplicates(cogsRows(saved)).length, 0);
    const twice = cogsRows({ ...saved,
      'sp27:bulk:2': { added: true, season: 'sp27', kind: 'bulk', amount: 5 } });
    const d = cogsDuplicates(twice);
    eq(d.length, 1);
    eq(d[0].count, 2);
  });

  const keys = (f) => cogsRows(saved).filter((r) => cogsMatches(r, f))
    .map((r) => r.id).join(',');
  // Any subset, which is the point of the tick boxes: "these four of the
  // nine" is not a question the dropdown they replaced could ask.
  const allBut = (field, ...on) => {
    const off = {};
    const every = field === 'kind' ? COGS_KINDS.map((k) => k.key)
      : COGS_SEASONS.map((x) => x.key);
    every.forEach((k) => { if (!on.includes(k)) off[k] = true; });
    return { off: { [field]: off } };
  };
  it('narrows by each thing it offers', () => {
    eq(keys(allBut('season', 'sp26')), 'sp26:bulk');
    eq(keys(allBut('kind', 'sms')).split(',').length, COGS_SEASONS.length);
    eq(keys({ off: { season: allBut('season', 'sp27').off.season, kind: { bulk: true } } }),
       'sp27:sms');
    eq(keys({ q: 'sp26' }), 'sp26:bulk');
  });
  // Nothing switched off draws everything, and a season added later is in
  // by default rather than silently left out.
  it('leaves everything in when nothing is switched off', () => {
    eq(keys({}), keys({ off: { season: {}, kind: {} } }));
    ok(keys({ off: { season: { sp26: true } } }).indexOf('sp26:') < 0);
    ok(keys({ off: { season: { sp26: true } } }).indexOf('sp27:') >= 0);
  });
  it('answers what is left to cost', () => {
    eq(keys({ show: 'costed' }), 'sp27:bulk,sp27:sms,sp26:bulk');
    ok(!keys({ show: 'todo' }).includes('sp27:bulk'));
  });
  // The sheet narrows as you type, which it cannot do by asking the
  // server, so the rule is in both places and this keeps them honest.
  it('is the same rule on the page as in the Worker', () => {
    const page = rd('public/assets/cogs.js');
    const fn = page.slice(page.indexOf('function keep(r)'), page.indexOf('function shown()'));
    ok(fn.length > 50, 'keep() was not found on the page');
    // Written out in full. 'f.' + field matched 'f.off.season' by accident
    // of the second f, so it went on passing after the rule had changed
    // shape underneath it.
    for (const field of ['season', 'kind']) {
      ok(fn.includes('f.off.' + field + '[r.' + field + ']'),
         'the page does not narrow on ' + field + ' the way the Worker does');
    }
    for (const show of COGS_SHOWS.map((x) => x.key).filter((x) => x !== 'all')) {
      ok(fn.includes("'" + show + "'"), 'the page does not know the ' + show + ' filter');
    }
  });

  // Starboard, Collab and Special Drops are seeded under a plain name
  // somebody would naturally type again. A line's id is its season and its
  // kind, and the save is an upsert -- so typing one of those a second time
  // used to land on top of the line already there, replace whatever it had
  // been costed at, and leave the sheet looking exactly as it did. "It will
  // not let me add it" is what that looks like from the outside.
  it('will not add a season the sheet already has', () => {
    const lines = cogsRows({}, 2027);
    const why = cogsAddCollision(lines, 'starboard:bulk');
    ok(why, 'adding Starboard again was allowed');
    ok(/already on the sheet/.test(why), why);
    ok(/Starboard/.test(why) && /Bulk/.test(why), 'say which line it clashed with: ' + why);
    // and it has to say what to do instead, or the only move left is to
    // overwrite the line that is there
    ok(/name of its own/.test(why), 'no way out offered: ' + why);
  });

  it('allows the same season under a name of its own', () => {
    const lines = cogsRows({}, 2027);
    eq(cogsAddCollision(lines, 'starboard-sp27:bulk'), '');
    eq(cogsAddCollision(lines, 'starboard-2:bulk'), '');
    // a season that was struck off is not in the way of re-adding it
    const gone = cogsRows({ 'starboard:bulk': { removed: 1 } }, 2027);
    eq(cogsAddCollision(gone, 'starboard:bulk'), '');
  });

  // Said on the page as well, so it is said before the round trip -- and
  // before Both sends two requests of which one lands and one is refused.
  it('is the same refusal on the page as in the Worker', () => {
    const page = rd('public/assets/cogs.js');
    const fn = page.slice(page.indexOf('function collides(key, kinds)'),
                          page.indexOf('function addLine()'));
    ok(fn, 'the page has no collides()');
    ok(/already on the/.test(fn), 'the page does not say the line is already there');
    ok(/name of its own/.test(fn), 'the page offers no way out');
    // and addLine has to actually call it, before it clears what was typed
    const add = page.slice(page.indexOf('function addLine()'),
                           page.indexOf('function bind()'));
    const calls = add.indexOf('collides(');
    const clears = add.indexOf('nu = {');
    ok(calls > -1, 'addLine never checks for a collision');
    ok(clears > -1 && calls < clears, 'the box is cleared before the check');
  });

  // The route itself. dash has no Worker harness -- nothing here can issue
  // a request -- so this reads the source, the way sql.mjs does for the same
  // reason. Weaker than running it, and it still catches the two ways this
  // guard goes wrong: dropped entirely, or applied to an edit as well, which
  // would make every existing line unsaveable.
  it('guards the add route, and only the add route', () => {
    const src = rd('worker/index.js');
    const route = src.slice(src.indexOf("what === '/line'"),
                            src.indexOf('async function labor('));
    ok(route.includes('cogsAddCollision'), 'the route never checks for a collision');
    ok(/if \(!given\)/.test(route),
       'the check is not limited to a line with no id of its own, so an edit '
       + 'would be refused as a duplicate of itself');
    // and the refusal has to be a refusal, not a 200 with a note in it
    const guard = route.slice(route.indexOf('if (!given)'));
    ok(/errors: \[why\]/.test(guard) && /40\d/.test(guard),
       'a collision does not come back as an error the page can show');
  });

  it('refuses a line with nothing to file it under', () => {
    ok(cogsClean({ kind: 'bulk' }, null).errors, 'a line with no season was taken');
    ok(cogsClean({ season: 'sp27' }, null).errors, 'a line with no kind was taken');
    ok(cogsClean({ season: 'sp27', kind: 'both' }, null).errors);
  });
  // A seeded line pointed at a season that does not exist would vanish
  // from the sheet it came from. A backfilled one brings its own, which
  // is the only way a prior season gets here at all.
  it('takes a season it has never heard of only on a backfilled line', () => {
    ok(cogsClean({ season: 'sp26', kind: 'bulk' }, null).errors);
    ok(!cogsClean({ added: true, season: 'sp26', kind: 'bulk' }, null).errors);
  });
  it('refuses a cost that is not one', () => {
    ok(cogsClean({ season: 'sp27', kind: 'bulk', amount: 'lots' }, null).errors);
    ok(cogsClean({ season: 'sp27', kind: 'bulk', amount: '-5' }, null).errors);
    eq(cogsClean({ season: 'sp27', kind: 'bulk', amount: '$1,240,000' }, null).row.amount,
       1240000);
  });
  it('clears a seeded line that has nothing on it, and keeps a backfilled one', () => {
    eq(cogsClean({ season: 'sp27', kind: 'bulk' }, null).row.clear, true);
    eq(cogsClean({ season: 'sp27', kind: 'bulk', note: 'waiting on the quote' },
                 null).row.clear, false);
    eq(cogsClean({ added: true, season: 'sp26', kind: 'bulk' }, null).row.clear, false);
  });
  // The id is season:kind, so a colon in a season name would make one id
  // mean two things.
  it('will not let a season name break the id it is half of', () => {
    eq(cleanSeasonKey('SP:26'), 'sp-26');
    eq(cleanSeasonKey('  F25  '), 'f25');
    eq(cleanSeasonKey('!!'), '');
    eq(cogsLineId('sp27', 'bulk'), 'sp27:bulk');
  });

  it('downloads what is on the sheet', () => {
    const out = cogsCsv(cogsRows(saved)).split('\n');
    ok(out[0].includes('Season') && out[0].includes('Total COGS'), out[0]);
    ok(out.some((l) => l.startsWith('SP26,Bulk,1192000')), 'the backfilled season is missing');
  });

  it('is behind the same door as the budget', () => {
    const idx = rd('worker/index.js');
    const fn = idx.slice(idx.indexOf('async function cogs('),
                         idx.indexOf('async function labor('));
    ok(/canBudget\(env, who\)/.test(fn), 'anybody signed in could read it');
    const tile = TILES.find((t) => t.key === 'cogs');
    ok(tile, 'there is no tile for it');
    eq(tile.everyone, false, 'the tile is shown to everybody');
  });
  // The seed runs on every boot. Deleting a seeded line rather than
  // marking it would put it straight back, which is the bug this codebase
  // has now had six times.
  it('strikes a seeded line off rather than deleting it', () => {
    const store = rd('worker/store.js');
    const fn = store.slice(store.indexOf('export async function removeCogsLine'));
    ok(/DELETE FROM cogs WHERE id = \? AND added = 1/.test(fn),
       'a backfilled line is not deleted outright');
    ok(/removed = 1/.test(fn), 'a seeded line is deleted and will come back');
  });
});

// ── what a season costs, and when it is paid for ───────────────────────
//
// A season is mostly paid for in the year it drops. Mostly: a deposit goes
// down the year before and an early shipment drags part of it into the year
// after, which one figure per line could never say.

describe('the COGS years', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rd = (f) => fs.readFileSync(path.join(here, '..', f), 'utf8');

  // Three years back and one forward, not a window centred on the pick:
  // backwards is where the prior seasons are and backfilling them is the
  // point, while forwards only the spillover year is ever used.
  it('reaches further back than forward', () => {
    eq(cogsYearsAround(2027), ['2024', '2025', '2026', '2027', '2028']);
    eq(cogsYearsAround(2025), ['2022', '2023', '2024', '2025', '2026']);
  });

  it('reads the drop year off the season name', () => {
    eq(cogsDropYear('sp27'), 2027);
    eq(cogsDropYear('f25'), 2025);
    eq(cogsDropYear('holiday-2027'), 2027);
  });

  it('falls back for the three seasons that carry no year and never will', () => {
    for (const k of ['collab', 'special-drops', 'starboard']) {
      eq(cogsDropYear(k, 2027), 2027, k + ' invented a year');
    }
    eq(cogsDropYear('collab'), null);
  });

  it('adds a line up across every year it is filed under', () => {
    eq(cogsYearTotal({ 2026: 150000, 2027: 850000 }), 1000000);
    eq(cogsYearTotal({}), 0);
    eq(cogsYearTotal(null), 0);
  });

  it('takes the years as typed, commas and all', () => {
    const errs = [];
    eq(cogsCleanYears({ 2026: '150,000', 2027: 850000 }, errs), { 2026: 150000, 2027: 850000 });
    eq(errs, []);
  });

  // The rule the whole sheet is built on: nobody has said yet is not the
  // same as nothing.
  it('drops a blank year rather than storing it as a zero', () => {
    const errs = [];
    eq(cogsCleanYears({ 2026: '', 2027: 100 }, errs), { 2027: 100 });
    eq(errs, []);
  });

  it('refuses a year that is not one, and a cost that is not one', () => {
    const a = [];
    cogsCleanYears({ nope: 100 }, a);
    ok(a.length, 'a key that is not a year got through');
    const b = [];
    cogsCleanYears({ 2027: 'lots' }, b);
    ok(b.length, 'a cost that is not a number got through');
    const c = [];
    cogsCleanYears({ 1999: 100 }, c);
    ok(c.length, '1999 got through');
    const d = [];
    cogsCleanYears({ 2027: -5 }, d);
    ok(d.length, 'a negative cost got through');
  });

  // The sheet shipped with one Total COGS per line. A figure typed then
  // belongs to the year the season dropped, and must not be lost or
  // double counted now that there are columns.
  it('files a figure typed before there were year columns', () => {
    eq(cogsYearsOf({ season: 'sp27', amount: 1240000 }, 2027), { 2027: 1240000 });
    eq(cogsYearsOf({ season: 'f25', amount: 500 }, 2027), { 2025: 500 });
    eq(cogsYearsOf({ season: 'collab', amount: 900 }, 2027), { 2027: 900 });
  });

  it('prefers the years to the old figure wherever both are there', () => {
    eq(cogsYearsOf({ season: 'sp27', amount: 999, years: { 2026: 10 } }, 2027), { 2026: 10 });
  });

  it('carries the years onto the sheet and totals them', () => {
    const rs = cogsRows({
      'sp27:bulk': { season: 'sp27', kind: 'bulk', years: { 2026: 150000, 2027: 850000 } },
      'f27:sms': { season: 'f27', kind: 'sms', amount: 42000 },
    }, 2027);
    const bulk = rs.find((r) => r.id === 'sp27:bulk');
    eq(bulk.years, { 2026: 150000, 2027: 850000 });
    eq(bulk.amount, 1000000);
    eq(rs.find((r) => r.id === 'f27:sms').years, { 2027: 42000 });
    ok(rs.filter((r) => r.amount == null).length > 10, 'lines arrived costed');
  });

  it('counts every year anything is filed under, not the ones on screen', () => {
    const rs = cogsRows({
      'sp27:bulk': { season: 'sp27', kind: 'bulk', years: { 2021: 1000, 2027: 9000 } },
    }, 2027);
    const sum = cogsSummary(rs);
    // 2021 is off the left of the window and is still in the total.
    eq(sum.byYear, { 2021: 1000, 2027: 9000 });
    eq(sum.total, 10000);
  });

  it('saves the years and works the total out rather than taking one', () => {
    const { row } = cogsClean({ season: 'sp27', kind: 'bulk',
                                years: { 2026: '150,000', 2027: 850000 } });
    eq(row.years, { 2026: 150000, 2027: 850000 });
    eq(row.amount, 1000000);
    ok(!row.clear, 'a costed line said it was empty');
  });

  it('still understands a line sent the old single figure', () => {
    const { row } = cogsClean({ season: 'f27', kind: 'bulk', amount: '42000' });
    eq(row.years, { 2027: 42000 });
    eq(row.amount, 42000);
  });

  it('clears a seeded line whose last year was emptied', () => {
    const { row } = cogsClean({ season: 'sp27', kind: 'bulk', years: {} });
    eq(row.amount, null);
    ok(row.clear, 'an emptied line would have been left behind');
  });

  it('puts every year it holds on the download', () => {
    const rs = cogsRows({
      'sp27:bulk': { season: 'sp27', kind: 'bulk', years: { 2026: 150000, 2027: 850000 } },
    }, 2027);
    const lines = cogsCsv(rs).split('\n');
    eq(lines[0], 'Season,Bulk or SMS,2026,2027,Total COGS,Note');
    eq(lines[1], 'SP27,Bulk,150000,850000,1000000,');
  });

  // The sheet is a history being built one season at a time, so the entry
  // row is the control that matters most. The page is an IIFE and cannot be
  // imported, so what the gate can check is that the shape is still there;
  // tests/shot.mjs drives it for real.
  it('adds a line from the sheet rather than from a dialog', () => {
    const page = rd('public/assets/cogs.js');
    ok(!/window\.prompt/.test(page),
       'a season is still added through a browser dialog');
    ok(/function addRow\(/.test(page), 'the entry row is gone');
    // Outside the filter and outside the sort, or narrowing the sheet would
    // take away the only way to add to it.
    ok(/\+ addRow\(\)/.test(page) && !/list\.map\(addRow/.test(page),
       'the entry row is drawn from the filtered list');
    ok(/knownSeason/.test(page),
       'a season typed in the wrong case would start a second one');
    ok(/box\.focus\(\)/.test(page),
       'the cursor does not go back to the season box');
  });

  // The chart reads whatever the filters leave behind. The page is an IIFE
  // and cannot be imported, so the gate checks the shape; tests/shot.mjs
  // drives the real thing, including the colour and the axis.
  it('graphs what the filters leave behind, in two validated hues', () => {
    const page = rd('public/assets/cogs.js');
    const css = rd('public/assets/labor.css');
    ok(/renderChart\(list\)/.test(page),
       'the chart is drawn from something other than the filtered list');
    // Colour follows the kind, never the column's position: narrowing the
    // sheet must not repaint what survives.
    ok(/var\(--s-' \+ \(kind \|\| 'bulk'\) \+ '\)/.test(page),
       'the segment colour is not keyed to the kind');
    // The brand's own two neutrals failed the validator outright -- normal
    // vision deltaE 7.7 against a floor of 15 -- so the chart does not use
    // them, and must not quietly go back to them.
    ok(/--s-bulk:#2a78d6/.test(css) && /--s-sms:#eb6834/.test(css),
       'the validated light hues are gone');
    ok(/--s-bulk:#3987e5/.test(css) && /--s-sms:#d95926/.test(css),
       'the dark mode steps are gone');
    ok(!/--s-(bulk|sms):\s*var\(--(good|watch)\)/.test(css),
       'a status colour is being used for a series');
    // One chart per kind rather than two series stacked in one: samples run
    // at a few per cent of the production run and were a sliver nobody
    // could read. Each chart has one series, so neither carries a legend
    // box -- its title names it.
    ok(/chartPanel/.test(page), 'the per-kind charts are gone');
    ok(!/cg-leg/.test(page), 'a legend box is back on a single-series chart');
    // Two scales, so each has to say so: a column on one is not comparable
    // by height to a column on the other.
    ok(/own scale/.test(page), 'the separate scales are not declared');
    // Oldest on the left, Spring before Summer before Fall before Holiday,
    // with SS -- the older naming, where the two were bought as one --
    // between Spring and Summer.
    ok(/SEASON_RANK = \{ sp: 1, ss: 2, su: 3, f: 4, h: 5 \}/.test(page),
       'the season order is not Spring, SS, Summer, Fall, Holiday');
    ok(/seasonWhen/.test(page), 'the chart is back on the sheet order');
    // The export reads styles off the LIVE nodes. getComputedStyle on a
    // detached clone resolves nothing, which took the colour out of the
    // whole picture and left black bars in a default serif.
    ok(/inlineStyles\(svg, clone, window\)/.test(page),
       'the export reads styles off the detached clone');
  });

  it('files a figure typed before the columns, once, at boot', () => {
    const fn = rd('worker/store.js');
    ok(/splitCogsYears/.test(fn), 'the migration is gone');
    ok(/cogs-years-split/.test(fn), 'it has no key, so it would run every boot');
    ok(/years = ''/.test(fn), 'it would refile a line that already has years');
    ok(/\['cogs', 'years TEXT/.test(fn),
       'the live table would never get the column');
  });
});

describe('campaign board', () => {
  const TODAY = '2026-11-12';
  const CAMPS = { recA: 'Datmos Website Re-Launch (2026)', recB: 'Clam Jam (2026)' };
  const rec = (over) => ({ id: over.id || 'rec1', fields: Object.assign({
    'Task Name': 'A task', Deadline: '2026-11-20', Campaign: ['recA'],
  }, over.fields || {}) });

  // What is active is the VIEW's call, not this file's. shape() asks for a
  // deadline and nothing else -- a second definition of "active" living
  // here is how the board ended up showing work from finished campaigns.
  it('asks only for a deadline, and leaves active to the view', () => {
    eq(cShape(rec({ fields: { Deadline: null } }), CAMPS), null, 'no deadline, nothing to place');
    eq(cShape(rec({ fields: { Deadline: 'soon' } }), CAMPS), null, 'a deadline that is not a date');
    ok(cShape(rec({}), CAMPS), 'a dated task is drawn');
    // These two used to be re-tested here. Hide From View was never in the
    // view at all, so applying it hid rows the view shows.
    ok(cShape(rec({ fields: { Complete: true } }), CAMPS),
       'shape() is second-guessing the view on Complete');
    ok(cShape(rec({ fields: { 'Hide From View': true } }), CAMPS),
       'shape() is applying a filter the view does not have');
  });

  // Airtable rejects an unknown name in fields[] outright, so a field
  // renamed in the base takes the WHOLE fetch down and the board falls
  // back to its last good cache -- stale, and silent about it. That is
  // exactly what 'Assignee' -> 'Executor' did.
  it('asks for fields that exist in the base', async () => {
    const seen = [];
    const get = async (u) => {
      seen.push(String(u));
      return { ok: true, status: 200, json: async () => ({ records: [] }) };
    };
    await cFetchBoard('key', get, TODAY);
    const url = seen.filter((u) => u.includes(cTASKS_TABLE)).join(' ');
    for (const f of ['Executor', 'Supporter%28s%29', 'Priority', 'Deadline', 'Campaign']) {
      ok(url.includes('fields%5B%5D=' + f) || url.includes(decodeURIComponent(f)),
         'the fetch does not ask for ' + decodeURIComponent(f));
    }
    // The name that was renamed. Asking for it again breaks everything.
    ok(!/fields%5B%5D=Assignee\b/.test(url) && !/=Assignee&/.test(url),
       'the fetch still asks for Assignee, which no longer exists');
  });

  it('keeps the two roles apart, and together where it matters', () => {
    const r = (over) => cShape({ id: 'r1', fields: Object.assign({
      'Task Name': 'A task', Deadline: '2026-11-20', Campaign: ['recA'],
    }, over) }, CAMPS);
    const kate = { id: 'k', name: 'Katie', email: 'k@j.com' };
    const kyle = { id: 'y', name: 'Kyle', email: 'y@j.org' };

    const t = r({ Executor: [kate], 'Supporter(s)': [kyle] });
    eq(t.executor.map((p) => p.name), ['Katie']);
    eq(t.supporters.map((p) => p.name), ['Kyle']);
    // Being somebody's supporter is still their work: the chips, the
    // filter and the per-person counts all run off assignees.
    eq(t.assignees.map((p) => p.name), ['Katie', 'Kyle'],
       'a supporter is missing from the list their own chip is built from');

    // The base says one executor and holds three on some rows.
    eq(r({ Executor: [kate, kyle] }).executor.length, 2, 'a second executor was dropped');
    // Neither field set is not a crash.
    eq(r({}).assignees, []);
    eq(r({}).supporters, []);
  });

  it('reads the priority box', () => {
    const r = (over) => cShape({ id: 'r1', fields: Object.assign({
      'Task Name': 'A task', Deadline: '2026-11-20',
    }, over) }, CAMPS);
    eq(r({ Priority: true }).priority, true);
    eq(r({ Priority: false }).priority, false);
    // Airtable leaves an unticked checkbox out of the payload entirely.
    eq(r({}).priority, false, 'a missing checkbox is not false');
  });

  // The whole fix, pinned: the request must name the view. A formula that
  // merely resembles it is what put finished campaigns on the board.
  it('asks Airtable for the view by id, not for a lookalike formula', async () => {
    const seen = [];
    const get = async (u) => {
      seen.push(String(u));
      return { ok: true, status: 200, json: async () => ({ records: [] }) };
    };
    await cFetchBoard('key', get, TODAY);
    const tasks = seen.filter((u) => u.includes(cTASKS_TABLE));
    // Pinned to the literal, because asserting the constant against itself
    // agrees with any view -- including 'DEADLINES - By DATE', which looks
    // almost identical and is not the one that was asked for.
    eq(cTASKS_VIEW, 'viw0YplB3wLrLb4R0',
       'this is not the \u{1F680} DEADLINES - By CAMPAIGN view');
    ok(tasks.length, 'the tasks table was never asked for');
    ok(tasks.every((u) => u.includes('view=' + cTASKS_VIEW)),
       'the task fetch does not name the Deadlines by Campaign view');
    ok(!/Hide\+From\+View|Hide%20From%20View/.test(tasks.join(' ')),
       'the old hand-written active filter is still being sent');
  });

  // A linked-record cell is an array of RECORD IDS over the REST API.
  // Without the join this prints recx3PtJyw3prjmBO at somebody.
  it('resolves the campaign to its name, never its record id', () => {
    eq(cShape(rec({}), CAMPS).campaign, 'Datmos Website Re-Launch (2026)');
    eq(cShape(rec({ fields: { Campaign: ['recUNKNOWN'] } }), CAMPS).campaign, '',
       'an id with no name is blank, not the id');
    eq(cShape(rec({ fields: { Campaign: [{ id: 'recZ', name: 'Inline' }] } }), CAMPS).campaign,
       'Inline', 'a name handed over inline is taken');
    eq(cShape(rec({ fields: { Campaign: [] } }), CAMPS).campaign, '');
  });

  // A lookup of a multipleSelects field arrives as an array OF ARRAYS.
  // Read one level deep it stringifies to [object Object].
  it('flattens a nested lookup rather than stringifying it', () => {
    const t = cShape(rec({ fields: { 'MKG Division': [['BRAND']],
                                     'Task Type': [{ name: 'Website' }, { name: 'Website' },
                                                   { name: 'Copy' }] } }), CAMPS);
    eq(t.division, 'BRAND');
    eq(t.types, ['Website', 'Copy'], 'duplicates collapse');
    ok(!/object Object/.test(JSON.stringify(t)), 'nothing stringified to [object Object]');
  });

  it('reads a deadline against today', () => {
    eq(cDue('2026-11-11', TODAY), 'overdue');
    eq(cDue('2026-11-12', TODAY), 'today');
    eq(cDue('2026-11-19', TODAY), 'week');
    eq(cDue('2026-11-20', TODAY), 'later', 'eight days out is not this week');
    eq(cDue('', TODAY), 'none');
  });

  const T = (name, deadline, who, campaign) => ({
    id: name, name, deadline, assignees: who || [], campaign: campaign || 'C1',
    division: 'BRAND', types: [], review: false, link: '',
  });
  const KATIE = [{ email: 'katie@x.com', name: 'Katie' }];
  const BOTH = [{ email: 'katie@x.com', name: 'Katie' }, { email: 'jon@x.com', name: 'Jon' }];

  // An unassigned deadline is nobody's, which is the thing this view
  // exists to surface -- not something to leave out because it has no
  // column to sit in.
  it('gives unassigned work a place of its own', () => {
    const rows = cByPerson([T('a', '2026-11-20'), T('b', '2026-11-20', KATIE)], TODAY);
    const un = rows.filter((r) => r.key === cNOBODY)[0];
    ok(un, 'unassigned work vanished');
    eq(un.tasks.length, 1);
  });

  it('puts a shared task on everybody it names', () => {
    const rows = cByPerson([T('a', '2026-11-20', BOTH)], TODAY);
    eq(rows.length, 2);
    eq(rows.map((r) => r.tasks.length), [1, 1]);
  });

  it('leads with whoever is furthest behind', () => {
    const rows = cByPerson([
      T('x', '2026-11-20', KATIE), T('y', '2026-11-20', KATIE),
      T('z', '2026-11-01', [{ email: 'jon@x.com', name: 'Jon' }]),
    ], TODAY);
    eq(rows[0].name, 'Jon', 'one overdue outranks two that are merely due');
    eq(rows[0].overdue, 1);
  });

  it('spans a campaign across the work still open on it', () => {
    const rows = cTimeline([
      T('a', '2026-11-20', KATIE, 'Datmos'), T('b', '2026-12-31', KATIE, 'Datmos'),
      T('c', '2026-11-01', KATIE, 'Clam Jam'),
    ], TODAY);
    eq(rows.map((r) => r.name), ['Clam Jam', 'Datmos'], 'earliest start first');
    const d = rows.filter((r) => r.name === 'Datmos')[0];
    eq([d.from, d.to], ['2026-11-20', '2026-12-31']);
    eq(d.tasks, 2);
    eq(d.point, false);
    eq(rows.filter((r) => r.name === 'Clam Jam')[0].overdue, 1);
  });

  // 31 December is used across this base as "sometime this year". A
  // campaign whose work is all on one date is a marker, not a bar of no
  // width -- said in the data so the page does not have to guess.
  it('marks a campaign whose work all lands on one day', () => {
    const rows = cTimeline([T('a', '2026-12-31', KATIE, 'Promos'),
                            T('b', '2026-12-31', KATIE, 'Promos')], TODAY);
    eq(rows[0].point, true);
    eq(rows[0].days, 0);
  });

  it('counts the board the same way everywhere', () => {
    const got = cTotals([
      T('a', '2026-11-01', KATIE, 'X'), T('b', '2026-11-12', KATIE, 'X'),
      T('c', '2026-11-15', [], 'Y'), T('d', '2027-01-01', KATIE, 'Y'),
    ], TODAY);
    eq(got.tasks, 4);
    eq(got.overdue, 1);
    eq(got.today, 1);
    eq(got.week, 2, 'today counts as due this week');
    eq(got.unassigned, 1);
    eq(got.campaigns, 2);
  });

  // The page re-reads a deadline per row as it draws -- a round trip per
  // row is not a thing -- so the rule is in both places. These keep them
  // honest, the way keep()/matches() are kept honest on the COGS page.
  it('reads a deadline the same way on the page as in the Worker', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const fn = page.slice(page.indexOf('function state(deadline)'),
                          page.indexOf('var MONTH'));
    ok(fn.length > 60, 'state() was not found on the page');
    for (const [needle, what] of [["'overdue'", 'overdue'], ["'today'", 'today'],
                                  ["'week'", 'this week'], ["'later'", 'later']]) {
      ok(fn.includes(needle), 'the page does not know ' + what);
    }
    // The boundaries are the part that silently drifts: < 0 and <= 7.
    ok(/n < 0/.test(fn), 'the page does not treat a past date as overdue');
    ok(/n <= 7/.test(fn), 'the page does not use the same seven-day window');
    ok(/n === 0/.test(fn), 'the page does not single out today');
  });

  // Colour carries urgency on that page, and the two hues have to be
  // readable in BOTH themes -- the dash flips --card and leaves --watch
  // alone, which is how a red badge ends up at 2.8:1 on a dark card.
  it('declares its urgency colours for both themes', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.css'), 'utf8');
    ok(!/var\(--cell\)/.test(css), '--cell is the calendar\u2019s token; the dash has --card');
    for (const sel of ['prefers-color-scheme: dark', '[data-theme="dark"]', '[data-theme="light"]']) {
      ok(css.includes(sel), 'no urgency colours declared for ' + sel);
    }
    for (const v of ['--cp-late', '--cp-due']) {
      const hits = css.split(v + ':').length - 1;
      ok(hits >= 3, v + ' is set ' + hits + ' times; it needs light, dark and both explicit themes');
    }
  });

  // "You cannot see this" and "there is nothing to see" look identical if a
  // refusal is rendered as an empty board. It was, until it wasn't.
  it('turns a refusal into something a person can act on', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    ok(/if \(!res\.ok\)[\s\S]{0,160}throw/.test(page),
       'a non-ok answer is returned rather than thrown, so it draws as an empty board');
    ok(/No such endpoint\|404/.test(page) || /No such endpoint/.test(page),
       'the page does not recognise the Worker\u2019s refusal');
    ok(/not open to this address/i.test(page), 'the page does not say what the refusal means');
    ok(/CAMPAIGN_USERS/.test(page), 'the page does not say what to ask for');
  });

  // ── the filter chips ───────────────────────────────────────────────────
  //
  // These run the page's REAL functions rather than grepping its source.
  // The chip row is the one place where a quiet change -- a different key,
  // a different sort -- shows up as names in the wrong order rather than as
  // an error, so the tests have to actually execute it.
  function chipParts(f) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const a = page.slice(page.indexOf('function keyOf'), page.indexOf('  function chip('));
    const b = page.slice(page.indexOf('function pickName()'), page.indexOf('  function render()'));
    ok(a.length > 200 && b.length > 200, 'the chip functions were not found on the page');
    const D = { tasks: [], asOf: '2026-11-12' };
    const state = (d) => cDue(d, '2026-11-12');
    const make = new Function('NOBODY', 'f', 'D', 'state',
      a + b + ';return {keyOf,tagged,overdue,picked,peopleRows,pickName,settle,hueOf,HUES,D};');
    return make('(unassigned)', f, D, state);
  }

  const person = (w) => (typeof w === 'string'
    ? { name: w, email: w.toLowerCase() + '@jettylife.com' } : w);
  const task = (name, deadline, who, extra) => Object.assign({
    name, deadline, campaign: 'C', division: 'D', review: false, priority: false,
    executor: (who || []).map(person),
    supporters: [],
    assignees: (who || []).map(person),
  }, extra || {});

  it('lines the people up by who is due first', () => {
    const P = chipParts({ pick: 'overview', q: '' });
    // Deliberately back-to-front alphabetically: sorted by name this comes
    // out Arlynn | Zoe, which is not what was asked for and would otherwise
    // pass unnoticed.
    const rows = P.peopleRows([
      task('a', '2026-12-20', ['Arlynn']),
      task('b', '2026-11-14', ['Zoe']),
      task('c', '2026-11-30', ['Arlynn']),
      task('d', '2026-11-02', []),
    ]);
    eq(rows.map((r) => r.name).join(' | '),
       'Zoe | Arlynn | Nobody assigned',
       'the chips are not in deadline order with the gap at the end');
    // Arlynn is on two tasks, appears once, dated by the SOONER of them.
    eq(rows[1].next, '2026-11-30');
    // And the gap stays last even though its deadline is the soonest of all.
    eq(rows[2].next, '2026-11-02');
  });

  it('keeps two people with one name apart', () => {
    const P = chipParts({ pick: 'overview', q: '' });
    const one = { name: 'Taylor', email: 'taylor@jettylife.com' };
    const two = { name: 'Taylor', email: 'taylor.b@outside.com' };
    const all = [task('a', '2026-11-14', [one]), task('b', '2026-11-15', [two])];
    eq(P.peopleRows(all).length, 2, 'two different Taylors collapsed into one chip');
    eq(P.tagged(all[0], P.keyOf(one)), true);
    eq(P.tagged(all[0], P.keyOf(two)), false, 'a chip pulled in the other Taylor\u2019s work');
  });

  it('shows the picked chip and nothing else', () => {
    const f = { pick: 'overview', q: '' };
    const P = chipParts(f);
    const all = [
      task('late one', '2026-11-01', ['Arlynn']),
      task('soon', '2026-11-14', ['Cory']),
      task('orphan', '2026-11-03', []),
    ];
    // Overview looks forward: today onward, nothing already late.
    eq(P.picked(all).map((t) => t.name).join(','), 'soon',
       'Overview is still leading with work whose date has gone');
    f.pick = 'late';
    eq(P.picked(all).map((t) => t.name).sort().join(','), 'late one,orphan',
       'Past deadline is not showing exactly what is overdue');
    // A person's own list is NOT trimmed -- what they owe late is the
    // first thing they need to see, and theirs is the view that says so.
    f.pick = 'arlynn@jettylife.com';
    eq(P.picked(all).map((t) => t.name).join(','), 'late one',
       'a person\u2019s own overdue work was hidden from their own list');
    f.pick = 'cory@jettylife.com';
    eq(P.picked(all).map((t) => t.name).join(','), 'soon');
    f.pick = '(unassigned)';
    eq(P.picked(all).map((t) => t.name).join(','), 'orphan',
       'the unassigned chip does not find work with nobody on it');
  });

  // Finish your last task and your chip leaves the board. The page was
  // standing on it; without settle() it shows an empty list and no lit chip.
  it('steps off a chip that is no longer there', () => {
    const f = { pick: 'cory@jettylife.com', q: '' };
    const P = chipParts(f);
    P.D.tasks = [task('a', '2026-11-14', ['Arlynn'])];
    P.settle();
    eq(f.pick, 'overview', 'the page is stuck on a person who has no work');

    f.pick = 'arlynn@jettylife.com';
    P.settle();
    eq(f.pick, 'arlynn@jettylife.com', 'settle() threw away a pick that was fine');
    eq(P.pickName(), 'Arlynn');
    f.pick = 'late';
    P.settle();
    eq(f.pick, 'late', 'settle() does not know its own view chips');
  });

  // The row is drawn from every task, the counts from what the search left.
  // Drawn from the search, a chip would delete itself the moment its last
  // task stopped matching -- and the row would reshuffle as you typed.
  it('builds the chip row from the whole board, not the search', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const draw = page.slice(page.indexOf('function drawChips('), page.indexOf('function filtered('));
    ok(/peopleRows\(all\)/.test(draw), 'the chip row is built from the searched list');
    ok(/hits\.filter/.test(draw), 'the counts ignore the search');
    const render = page.slice(page.indexOf('function render() {'), page.indexOf('function stamp('));
    ok(/var hits = all\.filter\(hit\)/.test(render), 'render no longer separates the two');
    ok(/drawChips\(all, hits\)/.test(render), 'render hands drawChips the wrong list');
    // drawFlat no longer needs to know whose list it is -- the base tells
    // the two roles apart now, so nothing is inferred from who is looking.
    // What it does need is the heading and the hue lookup.
    ok(/drawFlat\(show, pickName\(\), hueFor\)/.test(render),
       'render is not handing drawFlat its heading and hues');
    ok(!/f\.pick === 'late' \? '' : f\.pick/.test(render),
       'render still works out a "whose list is this" that nothing reads');
    // Every pill on every row has to agree with the chip above it, so the
    // lookup is built once here and handed down rather than re-derived.
    ok(/var keys = peopleRows\(all\)/.test(render) && /drawBoard\(show, hueFor\)/.test(render),
       'the rows colour their pills from a different list than the chips');
  });

  it('dresses a lit chip so you can see which one it is', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.css'), 'utf8');
    const on = css.slice(css.indexOf('.fchip.on{'), css.indexOf('.fchip.on{') + 160);
    ok(/background:var\(--primary\)/.test(on), 'a picked chip is not filled');
    ok(/color:#fff/.test(on), 'a picked chip keeps dark text on a dark fill');
    ok(/\.fchip\{/.test(css) && /\.fhint\{/.test(css), 'the chip bar is not styled');
    // The dash has no --cell. An unknown token voids the whole declaration.
    ok(!/var\(--cell\)/.test(css), 'the chips reach for a calendar token');
    const html = fs.readFileSync(path.join(here, '..', 'public/campaign.html'), 'utf8');
    ok(/id="fView"/.test(html) && /id="fWho"/.test(html), 'the chip rows are not on the page');
    ok(!/fDiv/.test(html), 'the old division dropdown is still there');
  });

  // Found by a test stub that handed this a Date and watched every deadline
  // come back 'none'. A board where nothing is ever late looks calm.
  it('reads a date whichever way it is handed one', () => {
    eq(cDue('2026-11-01', new Date('2026-11-12T00:00:00Z')), 'overdue');
    eq(cDue('2026-11-01', '2026-11-12'), 'overdue');
    eq(cDue('2026-11-12', new Date('2026-11-12T12:00:00Z')), 'today');
    eq(cDue('2026-11-01', new Date('nonsense')), 'none');
  });

  // Taking the viewer's own name off their rows is easy to get wrong in the
  // direction that loses information: hide the only name and an unassigned
  // task stops announcing itself, or strip the wrong person and a shared
  // task looks like it is one person's alone.
  function rowMaker() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const cut = (a, b) => {
      const t = page.slice(page.indexOf(a), page.indexOf(b));
      ok(t.length > 40, 'could not find ' + a);
      return t;
    };
    const src = cut('function esc(', '  function api(')
      + cut('function days(', '  // \u2500\u2500 filtering')
      + cut('function keyOf', '  function chip(')
      + cut('function headRow(', '  // One flat list');
    const made = new Function('D', src + ';return {taskRow,headRow};')({ asOf: '2026-11-12' });
    // A stand-in for the real lookup: enough to prove the pill carries
    // whatever hue it is handed, keyed by the person.
    const hueFor = (k) => 'var(--ph'
      + (([...k].reduce((n, c) => n + c.charCodeAt(0), 0) % 8) + 1) + ')';
    return (t) => made.taskRow(t, hueFor);
  }

  // Two roles, two columns, straight from the base. Nobody's name is
  // stripped from their own list any more -- that was a guess standing in
  // for a distinction Airtable did not record, and now it does.
  it('keeps the executor and the supporters in columns of their own', () => {
    const taskRow = rowMaker();
    const kate = { name: 'Katie Hehl', email: 'k.hehl@jettylife.com' };
    const kyle = { name: 'Kyle G', email: 'kyle@jettyrockfoundation.org' };
    // Cut at the NEXT column, not at the next closing tag -- two pills in
    // one column close a span between them, and cutting there read half
    // the column and reported the other half missing.
    const names = (html, c) => {
      const open = html.indexOf('class="' + c + '"');
      if (open < 0) return '?';
      const after = c === 'cp-exec' ? html.indexOf('class="cp-sup"') : html.length;
      const seg = html.slice(open, after > open ? after : html.length);
      return [...seg.matchAll(/class="cp-ex[^"]*"[^>]*>(?:<[^>]*>)*([^<]*)</g)]
        .map((x) => x[1]).join(',');
    };
    const both = taskRow(task('t', '2026-11-20', [kate], { supporters: [kyle] }));
    eq(names(both, 'cp-exec'), 'Katie Hehl', 'the executor column is wrong');
    eq(names(both, 'cp-sup'), 'Kyle G', 'the supporters column is wrong');

    // The base allows more than one executor and really does hold two or
    // three on some rows, whatever it was set up to mean.
    eq(names(taskRow(task('t', '2026-11-20', [kate, kyle])), 'cp-exec'),
       'Katie Hehl,Kyle G', 'a second executor was dropped');

    // No supporters is an empty column, not the word "none": most rows
    // have none, and a column of "none" is a column of noise.
    eq(names(taskRow(task('t', '2026-11-20', [kate])), 'cp-sup'), '',
       'an empty supporters column is being filled in');
    // Nobody executing it IS worth saying.
    eq(names(taskRow(task('t', '2026-11-20', [])), 'cp-exec'), 'Nobody assigned');

    const hues = [...both.matchAll(/--who:(var\(--ph\d\))/g)].map((m) => m[1]);
    eq(hues.length, 2, 'the two roles are not individually coloured');
    ok(hues[0] !== hues[1], 'the two roles were painted the same colour');
  });

  // The column order was asked for explicitly: date, how late, campaign,
  // what it is, who else. Pinned, because a refactor can shuffle five
  // string concatenations without anything else noticing.
  it('lays the row out in the order it was asked for, in every view', () => {
    const taskRow = rowMaker();
    const kate = { name: 'Katie Hehl', email: 'k@j.com' };
    const kyle = { name: 'Kyle G', email: 'kyle@j.org' };
    const html = taskRow(task('Staff web fixes', '2026-11-05', [kate],
      { campaign: 'Datmos Website Re-Launch (2026)', supporters: [kyle], priority: true }));
    eq([...html.matchAll(/class="(cp-[a-z]+)/g)].map((m) => m[1]).join(' > '),
       'cp-task > cp-when > cp-status > cp-prio > cp-star > cp-camp > cp-what'
       + ' > cp-exec > cp-ex > cp-sup > cp-ex',
       'the columns are not in the order they were asked for');
    const one = (c) => (new RegExp('class="' + c + '[^"]*"[^>]*>([^<]*)<').exec(html) || [])[1];
    eq(one('cp-when'), '5 Nov', 'the date column is carrying something other than the date');
    eq(one('cp-status'), '7d late', 'the deadline\u2019s state did not get its own column');
    eq(one('cp-camp'), 'Datmos Website Re-Launch (2026)');
    eq(one('cp-what'), 'Staff web fixes');

    // Out for review goes BEFORE the crew columns. Trailing them it took
    // its width out of the row and dragged them left on that row alone.
    const reviewed = taskRow(task('A Frame', '2026-11-16', [kate], { review: true }));
    const order = [...reviewed.matchAll(/class="(cp-[a-z]+)/g)].map((m) => m[1]);
    ok(order.indexOf('cp-rev') < order.indexOf('cp-exec'),
       'the review badge is not in front of the crew columns');
  });

  // The star only appears when the box is ticked. A column of empty boxes
  // is noise; a column with four stars in it is a list of what matters.
  it('shows the priority star only on a priority task', () => {
    const taskRow = rowMaker();
    ok(/class="cp-star"/.test(taskRow(task('t', '2026-11-20', [], { priority: true }))),
       'a priority task has no star');
    const plain = taskRow(task('t', '2026-11-20', []));
    ok(!/cp-star/.test(plain), 'an ordinary task was given a star');
    // The cell is still there, so the column stays a column.
    ok(/class="cp-prio"/.test(plain), 'the priority column vanishes on ordinary rows');
  });

  it('reads the same way round for every value in the status column', () => {
    const taskRow = rowMaker();
    const st = (ymd) => (/class="cp-status[^"]*"[^>]*>([^<]*)</.exec(
      taskRow(task('t', ymd, []), '')) || [])[1];
    eq(st('2026-10-26'), '17d late');
    eq(st('2026-11-11'), '1d late');
    eq(st('2026-11-12'), 'Due today');
    eq(st('2026-11-13'), 'Due tomorrow');
    // "Due this week" said the same thing six days apart, and on a Friday
    // it meant tonight. The number is the whole point of the column.
    eq(st('2026-11-14'), 'Due in 2 days');
    eq(st('2026-11-19'), 'Due in 7 days');
    ok(!/this week/.test([st('2026-11-14'), st('2026-11-19')].join(' ')),
       'the column still says "this week" instead of how many days');
    // Past a week there is no state worth naming, and "49d" in a column
    // beside "17d late" is the ambiguity this was built to remove.
    eq(st('2026-11-20'), '');
    eq(st('2026-12-31'), '');
    // Nothing in here may be a bare number of days: that is the shape that
    // reads as lateness whichever end of the deadline it is on.
    for (const d of ['2026-11-12', '2026-11-13', '2026-11-19']) {
      ok(!/^\d+d$/.test(st(d)), 'a bare day count is back in the status column');
    }
  });

  // Anything late is marked on the row itself, not just in its date, so
  // the stylesheet can reach the whole row if it ever needs to.
  it('marks an overdue row as overdue', () => {
    const taskRow = rowMaker();
    ok(/class="cp-task isLate"/.test(taskRow(task('t', '2026-10-01', []), false, '')));
    ok(!/isLate/.test(taskRow(task('t', '2026-12-01', []), false, '')));
    ok(!/isLate/.test(taskRow(task('t', '2026-11-12', []), false, '')),
       'work due today is being marked as already late');
  });

  // The Showing row, the way the calendar carries it: which filters are
  // on, what they leave, and a way out of EACH one -- a single Clear is no
  // use when two are on and you only wanted rid of one.
  it('says which filters are on and lets each one off separately', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const fn = page.slice(page.indexOf('function drawShowing('), page.indexOf('function render() {'));
    ok(fn.length > 200, 'drawShowing was not found');
    ok(/f\.pick !== 'overview'/.test(fn), 'the picked view is not shown as a filter');
    ok(/f\.q \|\| ''\)\.trim\(\)/.test(fn), 'the search is not shown as a filter');
    ok(/data-drop="/.test(fn), 'the tokens cannot be taken off one at a time');
    ok(/of ' \+ all\.length \+ ' tasks/.test(fn), 'it does not say how many of how many');
    ok(/nothing matches all of these/.test(fn), 'an empty result says nothing');
    ok(/fltReset/.test(fn), 'there is no Clear all');
    // With no filters on there is nothing to say, and an empty row would
    // sit above the board taking space and meaning nothing.
    ok(/if \(!on\.length\)[\s\S]{0,80}innerHTML = ''/.test(fn),
       'the Showing row is drawn even when nothing is filtered');

    // Each token has to actually remove its own filter and nothing else.
    const h = page.slice(page.indexOf("$('#showing').addEventListener"),
                         page.indexOf("$('#filters').addEventListener"));
    ok(/data-drop'\) === 'q'[\s\S]{0,60}f\.q = ''/.test(h),
       'dropping the search token does not clear the search');
    ok(/else f\.pick = 'overview'/.test(h),
       'dropping the view token does not return to Overview');
    ok(/fltReset[\s\S]{0,160}f\.q = ''/.test(h), 'Clear all does not clear the search');
  });

  it('matches the calendar\u2019s Showing row rather than inventing one', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.css'), 'utf8');
    const cal = fs.readFileSync(path.join(here, '..', '..', 'calendar/public/assets/calendar.css'), 'utf8');
    for (const c of ['.flt-status', '.fs-lead', '.fs-tok', '.fs-x', '.fs-count', '.fs-clear']) {
      ok(css.includes(c + '{'), 'campaign.css is missing ' + c);
      ok(cal.includes(c + '{'), c + ' is not what the calendar actually uses');
    }
    // The "nothing matches" state is the one that has to be read rather
    // than glanced at, and it is easy to leave behind when copying.
    ok(/\.flt-status\.none \.fs-count\{/.test(css), 'the no-matches state was not carried over');
  });

  // The columns are labelled, in both views. A card read on its own should
  // not need the one above it to be legible.
  it('labels its columns everywhere', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const head = page.slice(page.indexOf('function headRow('), page.indexOf('function exPill('));
    for (const label of ['Due date', 'Status', 'Campaign', 'Task description',
                         'Executor', 'Supporters']) {
      ok(head.includes('>' + label + '<'), 'the header row does not name ' + label);
    }
    // The labels must sit in the same column classes as the data, or they
    // line up with nothing.
    eq([...head.matchAll(/class="(cp-[a-z]+)"/g)].map((m) => m[1]).join(' '),
       'cp-when cp-status cp-prio cp-camp cp-what cp-exec cp-sup',
       'the labels are not in the columns they label');
    // Priority is marked with the star rather than the word: "Priority" is
    // wider than every cell under it.
    ok(/cp-prio" title="Priority">\\u2605/.test(head) || /cp-prio[^>]*>\u2605/.test(head),
       'the priority column is not marked');
    const flat = page.slice(page.indexOf('function drawFlat('), page.indexOf('function drawBoard('));
    const board = page.slice(page.indexOf('function drawBoard('), page.indexOf('function drawStrip('));
    ok(/headRow\(/.test(board), 'Overview has no column labels');
    ok(/headRow\(/.test(flat), 'a person\u2019s list has no column labels');
  });

  // A third view beside Overview and Past deadline: what is starred.
  it('gives the priority star a view of its own', () => {
    const f = { pick: 'overview', q: '' };
    const P2 = chipParts(f);
    const all = [
      Object.assign(task('late and starred', '2026-11-01', ['Arlynn']), { priority: true }),
      Object.assign(task('soon and starred', '2026-11-14', ['Cory']), { priority: true }),
      task('soon, not starred', '2026-11-15', ['Cory']),
    ];
    f.pick = 'priority';
    // NOT forward-only. Overview hides what is already late because it
    // answers "what is coming"; this answers "what matters", and a starred
    // task three weeks late is the best example of something that matters.
    eq(P2.picked(all).map((t) => t.name).sort().join(','),
       'late and starred,soon and starred',
       'the priority view is not showing exactly what is starred');
    eq(P2.pickName(), 'Priority');
    // It is a view, not a person: settle() must not throw it away.
    P2.D.tasks = all;
    P2.settle();
    eq(f.pick, 'priority', 'settle() dropped the priority view');
  });

  it('puts the priority chip beside Past deadline, counting stars', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const draw = page.slice(page.indexOf('function drawChips('), page.indexOf('function filtered('));
    const view = draw.slice(draw.indexOf("$('#fView')"), draw.indexOf("$('#fWho')"));
    eq([...view.matchAll(/chip\('([a-z]+)'/g)].map((m) => m[1]).join(' '),
       'overview late priority', 'the priority chip is not beside Past deadline');
    ok(/t\.priority/.test(view), 'the priority chip is not counting stars');
    // The star is a ::before on the chip, not text in the label: the chip
    // is inline-flex, and ::first-letter -- the obvious way -- does not
    // apply to one at all, so the star rendered in plain ink and a probe
    // in the browser measured it that way.
    const here2 = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.join(here2, '..', 'public/assets/campaign.css'), 'utf8');
    ok(css.includes(".fchip.prio::before{content:'") && css.includes('2605'),
       'the chip does not carry the star the rows do');
    ok(css.includes('color:var(--cp-star)'), 'the chip star is not the row star colour');
    ok(css.includes('.fchip.prio.on::before{color:#fff}'),
       'the star stays red on a filled chip');
    // A RULE, not the word -- the comment above it explains why not to.
    ok(!css.includes('::first-letter{'),
       '::first-letter does not apply to an inline-flex chip');
  });

  // Overdue used to be a colour you had to already be looking for.
  it('puts a wash behind an overdue date, not just a colour on it', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.css'), 'utf8');
    const block = css.slice(css.indexOf('.cp-task.isLate .cp-when,'));
    ok(/background:color-mix\(in srgb, var\(--cp-late\)/.test(block),
       'the overdue cells have no wash behind them');
    // The two cells are separate columns; without closing the row gap the
    // wash is two boxes with a stripe of card showing between them.
    ok(/margin-left:-11px;padding-left:11px/.test(block),
       'the two halves of the wash do not join up');
    // The wash is made OF --cp-late, so --cp-late ON it measured 4.28:1.
    // Pinned to the BASE rule, not just somewhere in the file -- the
    // light-theme override further down also names it, and matching that
    // let the base rule be reverted without a word.
    ok(/\.cp-task\.isLate \.cp-when,\s*\.cp-task\.isLate \.cp-status\{color:#9C3A24\}/.test(css),
       'the overdue text was left at the colour the wash is made of');
    ok(/:root\[data-theme="dark"\][\s\S]{0,200}isLate/.test(css)
       || /data-theme="dark"\] \.cp-task\.isLate/.test(css),
       'the dark theme has no overdue ink of its own');
    // Due-this-week is NOT washed: the box is what marks a thing as late.
    ok(!/\.cp-when\.due\{[^}]*background/.test(css),
       'work that is merely due soon is being washed as if it were late');
  });

  // Every id the page reaches for has to exist in the markup. This is here
  // because it did not: the Clear button was dropped from the bar during a
  // rewrite, $('#clr') came back null, and the TypeError was swallowed by
  // the load() catch -- which then drew the "could not load" notice over a
  // board that had in fact loaded perfectly. Nothing else noticed.
  it('only reaches for elements that are on the page', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = fs.readFileSync(path.join(here, '..', 'public/assets/campaign.js'), 'utf8');
    const html = fs.readFileSync(path.join(here, '..', 'public/campaign.html'), 'utf8');
    const want = [...page.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
    ok(want.length >= 6, 'no element lookups were found to check');
    for (const id of [...new Set(want)]) {
      ok(html.includes('id="' + id + '"'), 'the page reads #' + id + ', which is not in the markup');
    }
  });

  it('refuses to shape an unbounded pile', () => {
    const many = [];
    for (let i = 0; i < cMAX + 50; i++) many.push(rec({ id: 'r' + i }));
    eq(cShapeAll(many, CAMPS).length, cMAX);
  });
});


describe('Music Monday: what a week has to look like', () => {
  const good = { date: '2026-11-09', artist: 'Ratboys', song: 'Anywhere', by: 'Jerm' };

  it('takes a plain week', () => {
    const out = cleanPick(good);
    eq(out.errors, undefined);
    eq(out.row.date, '2026-11-09');
    eq(out.row.artist, 'Ratboys');
  });

  it('will not file a week with no artist, which is what froze the archive', () => {
    ok(cleanPick({ ...good, artist: '   ' }).errors.length > 0);
  });

  it('refuses a date that is not a date', () => {
    eq(mDate('2026-02-31'), '');
    eq(mDate('2026-13-01'), '');
    eq(mDate('9 Nov 2026'), '');
    eq(mDate('2026-11-09'), '2026-11-09');
  });

  it('refuses a year before Music Monday existed', () => {
    eq(mDate('2012-12-31'), '');
    eq(mDate('2013-02-01'), '2013-02-01');
  });

  it('files a pick under the Monday of its week, whatever day it was posted', () => {
    eq(mondayOf('2026-11-09'), '2026-11-09');  // the Monday itself
    eq(mondayOf('2026-11-14'), '2026-11-09');  // Saturday
    eq(mondayOf('2026-11-15'), '2026-11-09');  // Sunday belongs to the Monday BEFORE
    eq(mondayOf('2026-11-16'), '2026-11-16');  // next Monday
  });

  it('digs the video id out of whatever was copied', () => {
    const id = 'KYUMoL9FrIA';
    eq(youtubeId('https://www.youtube.com/watch?v=' + id), id);
    eq(youtubeId('https://www.youtube.com/watch?v=' + id + '&t=42s'), id);
    eq(youtubeId('https://youtu.be/' + id), id);
    eq(youtubeId('https://www.youtube.com/embed/' + id), id);
    eq(youtubeId('https://www.youtube.com/shorts/' + id), id);
    eq(youtubeId(id), id);
    eq(youtubeId(''), '');
  });

  it('leaves a SoundCloud link as a link rather than calling it a video id', () => {
    const out = cleanPick({ ...good, watch: 'https://soundcloud.com/x/y' });
    eq(out.row.youtube, '');
    eq(out.row.video, 'https://soundcloud.com/x/y');
  });

  it('says so when a YouTube link has no id in it, rather than losing the player', () => {
    const out = cleanPick({ ...good, watch: 'https://www.youtube.com/watch?v=short' });
    ok(out.errors && out.errors.some((e) => /video id/.test(e)));
    ok(isYouTube('https://youtu.be/abc'));
    eq(isYouTube('https://soundcloud.com/x'), false);
  });

  it('refuses a link that is not a link', () => {
    ok(cleanPick({ ...good, watch: 'just some words' }).errors.length > 0);
  });

  it('only says "this week" when it is this week', () => {
    eq(weekLabel('2026-11-09', '2026-11-14'), 'This week');   // same Monday
    eq(weekLabel('2026-11-02', '2026-11-14'), 'Latest pick'); // a fortnight back
    eq(weekLabel('2026-11-09', '2026-11-15'), 'This week');   // Sunday, still that week
    eq(weekLabel('2026-11-09', '2026-11-16'), 'Latest pick'); // next Monday: stale
  });

  it('names the Mondays with nothing filed against them', () => {
    const have = ['2026-11-02', '2026-10-19', '2026-10-12'];
    const gaps = missingMondays(have, '2026-11-14', 4);
    // 9 Nov and 26 Oct are the holes; 2 Nov and 19 Oct are filled.
    eq(gaps.join(','), '2026-11-09,2026-10-26');
  });

  it('names nothing when every recent Monday is filed', () => {
    eq(missingMondays(['2026-11-09', '2026-11-02'], '2026-11-14', 2).length, 0);
  });

  it('counts a pick filed mid-week as filling that Monday', () => {
    // Posted on the Wednesday, stored under its Monday: not a gap.
    eq(missingMondays(['2026-11-11'], '2026-11-14', 1).length, 0);
  });
});

describe('Music Monday: the page and the worker agree', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const page = fs.readFileSync(path.join(HERE, '..', 'public/assets/music.js'), 'utf8');

  it('the page keeps a copy of weekLabel that answers the same', () => {
    // The copy is duplicated on purpose, the same as the rest of the portal.
    // Lifted out and run so the two cannot drift apart unnoticed.
    const src = page.slice(page.indexOf('function mondayOf'), page.indexOf('function watchUrl'));
    ok(src.includes('function weekLabel'), 'the page has no weekLabel to check');
    // eslint-disable-next-line no-new-func
    const copy = new Function(src + '; return { mondayOf: mondayOf, weekLabel: weekLabel };')();
    for (const [d, t] of [
      ['2026-11-09', '2026-11-14'], ['2026-11-02', '2026-11-14'],
      ['2026-11-09', '2026-11-16'], ['2026-11-09', '2026-11-15'],
      ['2013-02-01', '2026-11-14'],
    ]) {
      eq(copy.weekLabel(d, t), weekLabel(d, t));
      eq(copy.mondayOf(d), mondayOf(d));
    }
  });

  it('every element the page reads is in the markup', () => {
    const html = fs.readFileSync(path.join(HERE, '..', 'public/music.html'), 'utf8');
    // Ids the page itself draws before reading them again.
    const drawn = new Set([...page.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
    const want = [...page.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
    ok(want.length >= 5, 'no element lookups were found to check');
    for (const id of [...new Set(want)]) {
      ok(html.includes('id="' + id + '"') || drawn.has(id),
        'the page reads #' + id + ', which is neither in the markup nor drawn by it');
    }
  });


  it('reaches the artwork route before handing off to the files on disk', () => {
    const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');
    const art = idx.indexOf("url.pathname.startsWith('/music/photo/')");
    const assets = idx.indexOf("return env.ASSETS.fetch(request)");
    ok(art > 0, 'the artwork route is gone');
    ok(assets > 0, 'the asset hand-off is gone');
    // Below the hand-off the route is unreachable and every cover 404s --
    // which the page hides with an onerror, so it fails in total silence.
    ok(art < assets,
      'the artwork route sits below the asset hand-off, where it can never run');
  });


  it('the rebuild script reads a YouTube link exactly as the dash does', () => {
    // rebuild_music.py writes the archive and worker/music.js reads it. If
    // they disagree about what an id is, a rebuilt row loses its player --
    // silently, because a pick with no id is a perfectly normal pick.
    const py = fs.readFileSync(path.join(HERE, '..', 'rebuild_music.py'), 'utf8');
    const js = fs.readFileSync(path.join(HERE, '..', 'worker', 'music.js'), 'utf8');
    const bodies = (src, re) => [...src.matchAll(re)]
      .map((m) => m[1].replace(/\\\//g, '/'));   // JS escapes the slash; Python does not
    const inPy = bodies(py, /re\.compile\(r"([^"]+)"\)/g);
    const inJs = bodies(js, /^\s*\/(.+?)\/,\s*\/\//gm);
    ok(inPy.length >= 5, 'the rebuild script has no link patterns to compare');
    eq(inJs.length, inPy.length);
    eq(inJs.join('\n'), inPy.join('\n'));
  });

  it('the picture the page sends is one the photo route will serve back', () => {
    const idx = fs.readFileSync(path.join(HERE, '..', 'worker', 'index.js'), 'utf8');
    // The upload names the key <date>.<ext>; the serving route only answers
    // for that shape. A change to either that forgets the other is silence.
    const route = idx.match(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\\\.\(([a-z|]+)\)/);
    ok(route, 'the photo route no longer pins a key shape');
    for (const ext of ['webp', 'jpg', 'png']) {
      ok(route[1].split('|').includes(ext), ext + ' can be uploaded but not served back');
    }
    ok(page.includes("'image/webp'"), 'the page no longer shrinks to webp');
  });
});

// Nothing is reported until every async test has actually finished.
await Promise.all(pending);
console.log('\n' + ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
