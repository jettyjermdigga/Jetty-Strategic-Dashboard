// What the dash decides, tested without a browser or a network.
//
// The one rule worth guarding: not knowing somebody's groups must show less,
// never more. A portal that falls open when an endpoint times out is a worse
// failure than one that goes quiet.

import { visibleTiles, tileSections, greeting, TILES, GROUPS, CATEGORIES, EVERYONE } from '../worker/tiles.js';
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
    ok(keys(['financials']).includes('strategic'), 'Financials should see the Strategic Dashboard');
  });
  it('does not show it to somebody who is not in that group', () => {
    ok(!keys(['wholesale']).includes('strategic'), 'Wholesale should not see it');
  });

  // The case the group names were chosen around: Amy needs the numbers
  // without being a director. If this ever needs her in a group called
  // anything like Leadership to pass, the naming has slipped back.
  it('lets somebody see the financials without being leadership', () => {
    const amy = groupsFor('amy@jettylife.com');
    ok(amy.includes('financials'), 'Amy is in Financials');
    ok(!amy.includes('leadership'), 'Amy is not leadership');
    ok(keys(amy).includes('strategic'), 'and she sees the Strategic Dashboard');
  });
  it('matches group names whatever the case', () => {
    eq(keys(['FINANCIALS']), keys(['financials']));
    eq(keys(['  Financials  ']), keys(['financials']));
  });
  // Against a fixture, because hiding every unbuilt tile leaves no live tile
  // owned by two groups -- and this rule should not go untested until the day
  // somebody relies on it.
  it('shows a tile to any one of the groups that own it', () => {
    const shared = [{
      key: 'shared', name: 'Shared', blurb: '-', url: 'https://example.test',
      icon: 'link', category: 'company', groups: ['wholesale', 'retail'], status: 'live',
    }];
    eq(visibleTiles(['wholesale'], shared).map((t) => t.key), ['shared']);
    eq(visibleTiles(['retail'], shared).map((t) => t.key), ['shared']);
    eq(visibleTiles(['marketing'], shared).map((t) => t.key), []);
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
    const s = tileSections(['financials']);
    const finance = s.find((x) => x.key === 'finance');
    ok(finance, 'there should be a Finance section');
    eq(finance.tiles.map((t) => t.key), ['strategic']);
  });
  it('leaves out a heading nothing lands under', () => {
    for (const s of tileSections(['financials'])) ok(s.tiles.length, s.key + ' is empty');
  });
  it('keeps the categories in the order they are declared', () => {
    const order = tileSections(GROUPS.map((g) => g.key)).map((s) => s.key);
    const want = CATEGORIES.map((c) => c.key).filter((k) => order.includes(k));
    eq(order, want);
  });
  it('accounts for every visible tile exactly once', () => {
    for (const who of [null, [], ['financials'], GROUPS.map((g) => g.key)]) {
      const flat = tileSections(who).flatMap((s) => s.tiles.map((t) => t.key));
      eq(flat.slice().sort(), visibleTiles(who).map((t) => t.key).sort(),
         'sections and tiles disagree for ' + JSON.stringify(who));
      eq(new Set(flat).size, flat.length, 'a tile appeared twice');
    }
  });
});

describe('groupsFor', () => {
  it('gives somebody their groups', () => {
    eq(groupsFor('jeremy@jettylife.com'),
       ['financials', 'marketing', 'wholesale', 'retail', 'jrf']);
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
  it('has somebody in every group, so no group is a dead letter', () => {
    const used = new Set(roster().flatMap((p) => p.groups));
    const empty = GROUPS.filter((g) => !used.has(g.key)).map((g) => g.key);
    // Ambassadors is knowingly empty until somebody says who is in it. Any
    // other empty group is a tile nobody can see and nobody meant to hide.
    eq(empty, ['ambassadors'], 'unexpected empty groups: ' + empty.join(', '));
  });
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
  const cats = [{ key: 'finance' }, { key: 'company' }];
  const grps = [{ key: 'financials' }, { key: 'wholesale' }];
  const good = {
    key: 'hub', name: 'Hub', blurb: 'A hub.', url: 'https://hub.test/',
    category: 'finance', icon: 'box', groups: ['financials'], status: 'live',
  };

  it('accepts a complete tile', () => {
    const out = cleanTile(good, cats, grps);
    ok(!out.errors, JSON.stringify(out.errors));
    eq(out.row.key, 'hub');
  });

  // The rule the whole page rests on: nothing is drawn that cannot be opened.
  // A tile cannot be marked live without somewhere to go, or the dash would
  // put an empty link in front of somebody.
  it('refuses to call a tile live without an address', () => {
    const out = cleanTile({ ...good, url: '' }, cats, grps);
    ok(out.errors && out.errors.some((e) => /address/i.test(e)));
  });
  it('keeps an unfinished tile rather than refusing it', () => {
    const out = cleanTile({ ...good, url: '', status: 'soon' }, cats, grps);
    ok(!out.errors, 'an unbuilt tile is allowed, it is just never drawn');
    eq(out.row.status, 'soon');
  });
  it('refuses a tile nobody is given', () => {
    const out = cleanTile({ ...good, groups: [] }, cats, grps);
    ok(out.errors && out.errors.some((e) => /nobody/i.test(e)));
  });
  it('refuses a group or category that does not exist', () => {
    ok(cleanTile({ ...good, groups: ['made-up'] }, cats, grps).errors);
    ok(cleanTile({ ...good, category: 'made-up' }, cats, grps).errors);
  });
  it('allows everyone, which is not a group but is a valid answer', () => {
    ok(!cleanTile({ ...good, groups: ['everyone'] }, cats, grps).errors);
  });
  it('refuses a tile with no key or no name', () => {
    ok(cleanTile({ ...good, key: '' }, cats, grps).errors);
    ok(cleanTile({ ...good, name: '  ' }, cats, grps).errors);
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
