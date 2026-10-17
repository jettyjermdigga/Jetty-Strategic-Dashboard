// What the dash decides, tested without a browser or a network.
//
// The one rule worth guarding: not knowing somebody's groups must show less,
// never more. A portal that falls open when an endpoint times out is a worse
// failure than one that goes quiet.

import { visibleTiles, greeting, TILES, GROUPS, EVERYONE } from '../worker/tiles.js';

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
    ok(keys(['directors']).includes('strategic'), 'Directors should see the Strategic Dashboard');
  });
  it('does not show it to somebody who is not in that group', () => {
    ok(!keys(['wholesale']).includes('strategic'), 'Wholesale should not see it');
  });
  it('matches group names whatever the case', () => {
    eq(keys(['DIRECTORS']), keys(['directors']));
    eq(keys(['  Directors  ']), keys(['directors']));
  });
  it('shows a tile to any one of the groups that own it', () => {
    ok(keys(['wholesale']).includes('wholesale'));
    ok(keys(['directors']).includes('wholesale'), 'Directors are on that tile too');
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
    for (const t of visibleTiles(['directors', 'wholesale', 'ambassadors', 'marketing'])) {
      if (t.status !== 'live') eq(t.url, '', t.key + ' is ' + t.status + ' and must not link');
    }
  });
  it('hands a url to every live tile', () => {
    for (const t of visibleTiles(['directors'])) {
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
