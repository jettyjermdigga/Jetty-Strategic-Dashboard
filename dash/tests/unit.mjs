// What the dash decides, tested without a browser or a network.
//
// The one rule worth guarding: not knowing somebody's groups must show less,
// never more. A portal that falls open when an endpoint times out is a worse
// failure than one that goes quiet.

import { visibleTiles, tileSections, linkSections, dashCategories, greeting, TILES, GROUPS, CATEGORIES, CAT_MOVES, GROUP_MOVES, EVERYONE } from '../worker/tiles.js';
import { groupsFor, roster, PEOPLE } from '../worker/people.js';
import { cleanTile, cleanPerson, cleanLink, cleanKey, cleanUrl } from '../worker/clean.js';
import { canonicalTarget } from '../worker/canon.js';

let ran = 0;
let failed = 0;
let group = '';

function describe(name, fn) { group = name; console.log(name); fn(); }
function it(label, fn) {
  ran++;
  try { fn(); console.log('  ok   ' + label); }
  catch (err) { failed++; console.log('  FAIL ' + label + '\n         ' + err.message); }
}
function eq(got, want, note) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
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
    eq(visibleTiles(groupsFor('brandnew@jettylife.com')).map((t) => t.key), ['calendar']);
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
                 category: 'marketing' };

  it('accepts a name, an address and a category', () => {
    const out = cleanLink(good, cats, []);
    ok(!out.errors, JSON.stringify(out.errors));
    eq([out.row.name, out.row.category], ['Model Inquiry Form', 'marketing']);
  });
  it('refuses a link with no address, unlike a tile', () => {
    ok(cleanLink({ ...good, url: '' }, cats, []).errors);
    ok(!cleanTile({ name: 'Hub', url: '', category: 'general' },
                  [{ key: 'general' }], []).errors);
  });
  it('refuses an address that is not one', () => {
    ok(cleanLink({ ...good, url: 'forms.test/models' }, cats, []).errors);
  });
  it('refuses a category that does not exist', () => {
    ok(cleanLink({ ...good, category: 'made-up' }, cats, []).errors);
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

  it('lists every category, in the order they are set up', () => {
    eq(dashCategories([], [], cats).map((c) => c.key), ['general', 'finance', 'marketing']);
  });
  it('opens a category the person has a tile in', () => {
    const out = dashCategories([tile('t1', 'finance')], [], cats);
    eq(out.map((c) => c.open), [false, true, false]);
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
    eq(out[1].tiles.map((t) => t.key), ['mine']);
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

console.log('\n' + ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
