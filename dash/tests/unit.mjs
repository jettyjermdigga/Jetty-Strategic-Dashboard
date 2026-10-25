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
  rows as budgetRows, value, spread, summary, csv, cleanLine, cleanYear,
  calendar, WEEK_CURVE, CURVE_IS_PLACEHOLDER, LINES as BUDGET_LINES, NEW_LINES,
  BASELINE_YEAR, FIRST_YEAR, GROUPS as BUDGET_GROUPS, CADENCES,
} from '../worker/budget.js';
import { periods, weekCounts, weekStart } from '../worker/retail.js';
import { LINES as SEED_LINES } from '../worker/budget-seed.js';
import {
  rows as laborRows, cost, decided, byDepartment, summary as laborSummary,
  against, cleanPerson as cleanLaborPerson, cleanKey as laborKey, csv as laborCsv,
  num, rollOf, PEOPLE as ROSTER, ON_STAFF, SEPARATE_DIVISIONS,
  PAY_TYPES, CLASSES, ROLLUPS, FULL_TIME_HOURS, ROSTER_AS_OF,
} from '../worker/labor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ran = 0;
let failed = 0;
let group = '';

function describe(name, fn) { group = name; console.log(name); fn(); }
function it(label, fn) {
  ran++;
  try { fn(); console.log('  ok   ' + label); }
  catch (err) { failed++; console.log('  FAIL ' + label + '\n         ' + err.message); }
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
    ok(!/'direct'|'gna'/.test(page), 'the page hardcodes a class, which will drift');
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

console.log('\n' + ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
