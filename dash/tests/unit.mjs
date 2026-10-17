// What the dash decides, tested without a browser or a network.
//
// The one rule worth guarding: not knowing somebody's groups must show less,
// never more. A portal that falls open when an endpoint times out is a worse
// failure than one that goes quiet.

import { visibleTiles, greeting, TILES, GROUPS, EVERYONE } from '../worker/tiles.js';
import { groupsFor, roster, PEOPLE } from '../worker/people.js';

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
  it('shows a tile to any one of the groups that own it', () => {
    ok(keys(['ambassadors']).includes('ambassadors'));
    ok(keys(['marketing']).includes('ambassadors'), 'Marketing is on that tile too');
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

  it('hands no url to a tile that is not built', () => {
    for (const t of visibleTiles(['financials', 'wholesale', 'ambassadors', 'marketing'])) {
      if (t.status !== 'live') eq(t.url, '', t.key + ' is ' + t.status + ' and must not link');
    }
  });
  it('hands a url to every live tile', () => {
    for (const t of visibleTiles(['financials'])) {
      if (t.status === 'live') ok(t.url, t.key + ' is live and needs somewhere to go');
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
  it('uses only statuses the page knows how to draw', () => {
    for (const t of TILES) ok(['live', 'soon', 'planned'].includes(t.status), t.key);
  });
});

describe('groupsFor', () => {
  it('gives somebody their groups', () => {
    eq(groupsFor('jeremy@jettylife.com'),
       ['financials', 'leadership', 'marketing', 'wholesale', 'retail', 'jrf']);
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
