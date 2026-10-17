// What the dash decides, tested without a browser or a network.
//
// The one rule worth guarding: not knowing somebody's groups must show less,
// never more. A portal that falls open when an endpoint times out is a worse
// failure than one that goes quiet.

import { visibleTiles, tileSections, greeting, TILES, GROUPS, CATEGORIES, CAT_MOVES, GROUP_MOVES, EVERYONE } from '../worker/tiles.js';
import { groupsFor, roster, PEOPLE } from '../worker/people.js';
import { cleanTile, cleanPerson, cleanKey, cleanUrl } from '../worker/clean.js';

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
  it('shows the everyone tiles to somebody in no groups', () => {
    eq(keys([]), ['calendar']);
  });
  it('adds a tile when the group matches', () => {
    ok(keys(['finance']).includes('strategic'), 'Finance should see the Strategic Dashboard');
  });
  it('does not show it to somebody who is not in that group', () => {
    ok(!keys(['wholesale']).includes('strategic'), 'Wholesale should not see it');
  });

  // Amy needs the numbers without being a director. Departments are
  // sections of the portal, not ranks, so she is simply in finance.
  it('lets somebody see the finance tools without being a director', () => {
    const amy = groupsFor('amy@jettylife.com');
    ok(amy.includes('finance'), 'Amy is in finance');
    ok(keys(amy).includes('strategic'), 'and she sees the Strategic Dashboard');
  });
  it('matches group names whatever the case', () => {
    eq(keys(['FINANCE']), keys(['finance']));
    eq(keys(['  Finance  ']), keys(['finance']));
  });
  // A tile's section is now the only thing that decides who sees it: the
  // department answers the question, so there is no second list to disagree
  // with it. The fixture is here because the real catalogue has one tile per
  // live section.
  it('shows a tile to the department it sits in, and nobody else', () => {
    const fx = [{
      key: 'wh', name: 'Wholesale thing', blurb: '-', url: 'https://example.test',
      icon: 'link', category: 'wholesale',
    }];
    eq(visibleTiles(['wholesale'], fx).map((t) => t.key), ['wh']);
    eq(visibleTiles(['marketing'], fx).map((t) => t.key), []);
    eq(visibleTiles([], fx).map((t) => t.key), []);
  });
  it('shows a General tile to everybody, placed or not', () => {
    const fx = [{
      key: 'g', name: 'Handbook', blurb: '-', url: 'https://example.test',
      icon: 'link', category: 'general',
    }];
    eq(visibleTiles([], fx).map((t) => t.key), ['g']);
    eq(visibleTiles(null, fx).map((t) => t.key), ['g'], 'even an unknown visitor');
  });

  // The failure mode that matters.
  it('shows only the open tiles when membership is unknown', () => {
    eq(keys(null), ['calendar']);
  });
  it('never shows more when unknown than when known to be in none', () => {
    const unknown = keys(null);
    const none = keys([]);
    ok(unknown.length <= none.length, 'unknown must not be a wider view than empty');
  });

  // The rule the page is built on: nothing is drawn that cannot be opened.
  it('never returns a tile that is not built, to anybody', () => {
    const everyGroup = GROUPS.map((g) => g.key);
    const soon = TILES.filter((t) => t.status !== 'live').map((t) => t.key);
    ok(soon.length, 'the fixture needs an unbuilt tile for this to mean anything');
    for (const k of visibleTiles(everyGroup).map((t) => t.key)) {
      ok(!soon.includes(k), k + ' is not built and must not be drawn');
    }
  });
  it('gives every tile it does return somewhere to go', () => {
    for (const t of visibleTiles(GROUPS.map((g) => g.key))) {
      ok(t.url, t.key + ' was drawn without a url');
    }
  });
  it('leaks nothing about a tile somebody cannot see', () => {
    const seen = JSON.stringify(visibleTiles([]));
    ok(!seen.includes('jetty-strategic'), 'the Strategic Dashboard address must not be in the payload');
  });
});

describe('the catalogue itself', () => {
  it('gives every tile a key, a name and a blurb', () => {
    for (const t of TILES) {
      ok(t.key && t.name && t.blurb, 'incomplete tile: ' + JSON.stringify(t.key));
    }
  });
  it('uses no key twice', () => {
    eq(new Set(TILES.map((t) => t.key)).size, TILES.length);
  });
  it('gives every live tile a url and every other tile none', () => {
    for (const t of TILES) {
      if (t.status === 'live') ok(t.url, t.key + ' is live without a url');
      else eq(t.url, '', t.key + ' is not live and should carry no url');
    }
  });
  it('mentions no unbuilt tile in what it sends', () => {
    const sent = JSON.stringify(visibleTiles(GROUPS.map((g) => g.key)));
    for (const t of TILES) {
      if (t.status !== 'live') ok(!sent.includes(t.name), t.name + ' leaked into the payload');
    }
  });
  it('names only groups that exist', () => {
    const known = new Set(GROUPS.map((g) => g.key).concat([EVERYONE]));
    for (const t of TILES) {
      for (const g of t.groups || []) {
        ok(known.has(g), t.key + ' names a group that is not in GROUPS: ' + g);
      }
    }
  });
  it('puts every tile in at least one group', () => {
    for (const t of TILES) ok((t.groups || []).length, t.key + ' is in no group, so nobody sees it');
  });
  it('uses only statuses the catalogue knows about', () => {
    for (const t of TILES) ok(['live', 'soon'].includes(t.status), t.key);
  });
  it('puts every tile in a category that exists', () => {
    const known = new Set(CATEGORIES.map((c) => c.key));
    for (const t of TILES) ok(known.has(t.category), t.key + ' is in an unknown category: ' + t.category);
  });
});

describe('tileSections', () => {
  it('puts a tile under its own category', () => {
    const s = tileSections(['finance']);
    const finance = s.find((x) => x.key === 'finance');
    ok(finance, 'there should be a Finance section');
    eq(finance.tiles.map((t) => t.key), ['strategic']);
  });
  it('leaves out a heading nothing lands under', () => {
    for (const s of tileSections(['finance'])) ok(s.tiles.length, s.key + ' is empty');
  });
  it('keeps the categories in the order they are declared', () => {
    const order = tileSections(GROUPS.map((g) => g.key)).map((s) => s.key);
    const want = CATEGORIES.map((c) => c.key).filter((k) => order.includes(k));
    eq(order, want);
  });
  it('accounts for every visible tile exactly once', () => {
    for (const who of [null, [], ['finance'], GROUPS.map((g) => g.key)]) {
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
  it('gives every tile somebody who can see it, except the ones we know about', () => {
    const all = roster().map((p) => p.groups);
    for (const t of TILES) {
      const want = (t.groups || []);
      if (want.includes(EVERYONE)) continue;
      const seen = all.some((mine) => want.some((g) => mine.includes(g)));
      if (!seen) eq(t.key, 'ambassadors', t.key + ' is visible to nobody on the roster');
    }
  });
});

// What the Setup page is allowed to save. Everything typed in by hand goes
// through the same cleaning the seeded rows went through, so a row keyed in
// cannot be shaped differently from a row that came from the file.
describe('cleanTile', () => {
  const cats = [{ key: 'finance' }, { key: 'general' }];
  const good = {
    name: 'Hub', blurb: 'A hub.', url: 'https://hub.test/',
    category: 'finance', icon: 'box',
  };

  it('accepts the five answers the form asks for', () => {
    const out = cleanTile(good, cats, [], []);
    ok(!out.errors, JSON.stringify(out.errors));
    eq([out.row.name, out.row.category, out.row.icon], ['Hub', 'finance', 'box']);
  });

  // An address is what makes a tile real, so there is no separate "show it"
  // to disagree with. One without an address is kept and never drawn.
  it('derives whether it is shown from whether it has an address', () => {
    eq(cleanTile(good, cats, [], []).row.status, 'live');
    eq(cleanTile({ ...good, url: '' }, cats, [], []).row.status, 'soon');
  });
  it('keeps an unfinished tile rather than refusing it', () => {
    ok(!cleanTile({ ...good, url: '' }, cats, [], []).errors);
  });
  it('says so when an address was typed and is not one', () => {
    const out = cleanTile({ ...good, url: 'wholesale hub' }, cats, [], []);
    ok(out.errors && out.errors.some((e) => /web address/i.test(e)));
  });

  // The category is who sees it, so it is the one answer that must be real.
  it('refuses a category that does not exist', () => {
    ok(cleanTile({ ...good, category: 'made-up' }, cats, [], []).errors);
  });
  it('files who-sees-it under the category, with nothing else to disagree', () => {
    eq(cleanTile(good, cats, [], []).row.groups, 'finance');
  });

  it('makes a key out of the name', () => {
    eq(cleanTile({ ...good, name: 'Wholesale Hub' }, cats, [], []).row.key, 'wholesale-hub');
  });
  it('does not collide with a key already taken', () => {
    eq(cleanTile({ ...good, name: 'Hub' }, cats, [], ['hub']).row.key, 'hub-2');
    eq(cleanTile({ ...good, name: 'Hub' }, cats, [], ['hub', 'hub-2']).row.key, 'hub-3');
  });
  it('keeps the key an existing tile already has, so renaming is safe', () => {
    eq(cleanTile({ ...good, key: 'original', name: 'Renamed' }, cats, [], []).row.key, 'original');
  });
  it('refuses a tile with no name', () => {
    ok(cleanTile({ ...good, name: '  ' }, cats, [], []).errors);
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
  const grps = [{ key: 'financials' }];
  it('accepts an address and the groups it is given', () => {
    const out = cleanPerson({ email: ' Amy@JettyLife.com ', groups: ['financials'] }, grps);
    ok(!out.errors);
    eq(out.row.email, 'amy@jettylife.com', 'stored lowercased, which is how it is looked up');
  });
  it('accepts somebody in no groups, which is a real state', () => {
    ok(!cleanPerson({ email: 'new@jettylife.com', groups: [] }, grps).errors);
  });
  it('refuses something that is not an address', () => {
    ok(cleanPerson({ email: 'nope', groups: [] }, grps).errors);
  });
  it('refuses a group that does not exist', () => {
    ok(cleanPerson({ email: 'a@b.test', groups: ['made-up'] }, grps).errors);
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
