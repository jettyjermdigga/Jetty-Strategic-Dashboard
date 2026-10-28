// Pure logic, run in Node. No browser, no network, no packages -- this is
// what gates the deploy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  cents, netInvoice, commissionBase, amountDue, isUnallocated, cleanAllocation,
  cleanPaid, totals, repKey, MAX_PCT,
} from '../worker/commission.js';
import { cleanIncoming, cleanDate } from '../worker/ingest.js';
import { sqlStatements } from '../worker/sql.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = (p) => path.join(HERE, '..', p);

let failed = 0;
let ran = 0;
let group = '';
const describe = (name, fn) => { group = name; console.log(name); fn(); };
const it = (name, fn) => {
  ran += 1;
  try { fn(); console.log('  ok   ' + name); } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
};
// JSON.stringify renders Infinity and NaN as "null", so a check that a guard
// returned null passes whether or not the guard exists. Both are spelled out.
const show = (v) => JSON.stringify(v, (k, x) =>
  (typeof x === 'number' && !Number.isFinite(x) ? '<' + String(x) + '>' : x));
const eq = (a, b, msg) => {
  if (show(a) !== show(b)) {
    throw new Error((msg ? msg + ': ' : '') + show(a) + ' !== ' + show(b));
  }
};
const ok = (v, msg) => { if (!v) throw new Error(msg || 'not ok'); };

// ── What a commission is worth ─────────────────────────────────────────

describe('the three formulas', () => {
  it('nets an invoice down by credits and freight', () => {
    eq(netInvoice({ gross: 1000, credits: -100, freight: 25 }), 875);
    eq(netInvoice({ gross: 6479.55 }), 6479.55);
  });
  // The Airtable formula ADDS credits, because a credit is entered negative.
  // A sign flip here would overpay on every invoice that carried one.
  it('adds credits rather than subtracting them, as they are entered', () => {
    eq(netInvoice({ gross: 1000, credits: -100 }), 900);
    eq(netInvoice({ gross: 1000, credits: 100 }), 1100,
       'a positive credit was treated as a deduction');
  });
  it('pays nobody commission on shipping', () => {
    eq(netInvoice({ gross: 1000, freight: 120 }), 880);
  });
  it('works the commission out of the net, not the gross', () => {
    eq(amountDue({ gross: 1000, freight: 120, commission_pct: 10 }), 88);
  });
  // A CAD row is invoiced in CAD and settled in USD. Paying on the CAD net
  // would hand the rep the exchange rate as a bonus.
  it('pays a Canadian row on its USD net', () => {
    eq(commissionBase({ cad: 1, usd_net: 1000, gross: 1400 }), 1000);
    eq(amountDue({ cad: 1, usd_net: 1000, gross: 1400, commission_pct: 7 }), 70);
  });
  it('pays a row that is not Canadian on its own net', () => {
    eq(commissionBase({ cad: 0, usd_net: 1000, gross: 1400 }), 1400);
  });
  it('rounds to the cent', () => {
    eq(amountDue({ gross: 1234.56, commission_pct: 7.5 }), 92.59);
    eq(cents(1234.5600000000002), 1234.56);
  });
  it('reads money however it was typed', () => {
    eq(netInvoice({ gross: '$6,479.55' }), 6479.55);
    eq(netInvoice({ gross: '' }), 0);
    eq(netInvoice({ gross: 'lots' }), 0);
    eq(netInvoice(null), 0);
  });
  it('is zero until somebody sets a rate', () => {
    eq(amountDue({ gross: 1000 }), 0);
  });
});

// The same arithmetic is written three times -- here, as generated columns in
// schema.sql, and again in the page so the preview can move as a rate is
// typed. Three copies that can disagree is three chances to pay the wrong
// amount, so they are run against each other rather than trusted.
describe('the database works it out the same way', () => {
  const db = new DatabaseSync(':memory:');
  for (const stmt of sqlStatements(fs.readFileSync(root('worker/schema.sql'), 'utf8'))) {
    db.exec(stmt);
  }
  const CASES = [
    { gross: 6479.55, credits: 0, freight: 0, cad: 0, usd_net: null, commission_pct: 10 },
    { gross: 1000, credits: -100, freight: 25, cad: 0, usd_net: null, commission_pct: 7.5 },
    { gross: 1400, credits: 0, freight: 0, cad: 1, usd_net: 1000, commission_pct: 7 },
    { gross: 180, credits: 0, freight: 0, cad: 0, usd_net: null, commission_pct: null },
    { gross: 0.07, credits: 0, freight: 0, cad: 0, usd_net: null, commission_pct: 33.3 },
    { gross: 99999.99, credits: -1234.56, freight: 78.9, cad: 0, usd_net: null, commission_pct: 12.5 },
    { gross: 2130, credits: 0, freight: 0, cad: 1, usd_net: 0, commission_pct: 10 },
  ];
  const ins = db.prepare(
    'INSERT INTO payments (id, paid_on, gross, credits, freight, cad, usd_net, commission_pct) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  CASES.forEach((c, i) => ins.run('c' + i, '2026-01-01', c.gross, c.credits, c.freight,
                                  c.cad, c.usd_net, c.commission_pct));

  it('agrees with worker/commission.js on every figure', () => {
    const rows = db.prepare('SELECT id, net_invoice, amount_due FROM payments ORDER BY id').all();
    eq(rows.length, CASES.length);
    rows.forEach((r) => {
      const c = CASES[Number(r.id.slice(1))];
      eq(r.net_invoice, netInvoice(c), r.id + ' net');
      eq(r.amount_due, amountDue(c), r.id + ' due');
    });
  });
  // The page cannot ask the Worker on every keystroke, so it has its own
  // copy. This is the check that stops the two drifting.
  it('agrees with the copy the page uses', () => {
    const src = fs.readFileSync(root('public/assets/commissions.js'), 'utf8');
    const body = src.slice(src.indexOf('function num(v)'), src.indexOf('// ── drawing'));
    ok(/function netInvoice/.test(body) && /function amountDue/.test(body),
       'the page no longer carries its own copy');
    // eslint-disable-next-line no-new-func
    const page = new Function(body + '; return { netInvoice: netInvoice, amountDue: amountDue };')();
    for (const c of CASES) {
      eq(page.netInvoice(c), netInvoice(c), 'page net ' + c.gross);
      eq(page.amountDue(c), amountDue(c), 'page due ' + c.gross);
    }
  });
});

// ── The queue ──────────────────────────────────────────────────────────

describe('what is waiting to be allocated', () => {
  it('is everything with no rep on it', () => {
    eq(isUnallocated({ rep_key: null }), true);
    eq(isUnallocated({ rep_key: '' }), true);
    eq(isUnallocated({ rep_key: '   ' }), true);
    eq(isUnallocated({ rep_key: 'nathan-zelena' }), false);
    eq(isUnallocated(null), true);
  });
  it('adds up what is sitting in it', () => {
    const rows = [
      { gross: 1000, commission_pct: 10, rep_key: 'a', paid: 0 },
      { gross: 500, commission_pct: 10, rep_key: 'a', paid: 1 },
      { gross: 300, rep_key: null },
    ];
    eq(totals(rows), { rows: 3, gross: 1800, due: 150, unallocated: 1, unpaid: 100 });
  });
  it('copes with nothing at all', () => {
    eq(totals([]), { rows: 0, gross: 0, due: 0, unallocated: 0, unpaid: 0 });
    eq(totals(null).rows, 0);
  });
});

describe('allocating a payment', () => {
  const REPS = ['nathan-zelena', 'agenc-ani-caron'];
  const at = (x) => cleanAllocation(Object.assign(
    { rep_key: 'nathan-zelena', commission_pct: '10' }, x || {}), REPS);

  it('takes a rep off the list and a rate', () => {
    eq(at().row.rep_key, 'nathan-zelena');
    eq(at().row.commission_pct, 10);
  });
  // Typed names are how one rep becomes three spellings and a statement
  // comes up short.
  it('refuses a rep who is not on the list', () => {
    ok(at({ rep_key: 'Nathan Zelena' }).errors);
    ok(at({ rep_key: 'somebody-else' }).errors);
  });
  // A rep with no rate earns nothing and silently leaves the queue, which is
  // the one outcome worse than it staying in.
  it('will not take a rep without a rate', () => {
    ok(at({ commission_pct: '' }).errors);
    ok(at({ commission_pct: null }).errors);
  });
  it('lets a row be filled in before a rep is known', () => {
    const out = cleanAllocation({ retailer: 'East of Maui', territory: 'HI' }, REPS);
    ok(!out.errors, show(out.errors));
    eq(out.row.rep_key, null);
  });
  // Far likelier to be 1500 typed for 15.00 than a real deal.
  it('refuses a rate that is not plausible', () => {
    ok(at({ commission_pct: '1500' }).errors);
    ok(at({ commission_pct: '-5' }).errors);
    ok(at({ commission_pct: 'ten' }).errors);
    ok(!at({ commission_pct: String(MAX_PCT) }).errors, 'the ceiling itself was refused');
  });
  it('reads a rate with a percent sign on it', () => {
    eq(at({ commission_pct: '12.5%' }).row.commission_pct, 12.5);
  });
  // A Canadian row priced off a blank USD figure pays zero, which looks like
  // a rate problem rather than a missing number.
  it('will not allocate a Canadian row with no USD net', () => {
    ok(at({ cad: 1 }).errors);
    ok(!at({ cad: 1, usd_net: '1000' }).errors);
  });
  it('leaves a Canadian row alone until somebody allocates it', () => {
    ok(!cleanAllocation({ cad: 1 }, REPS).errors);
  });
  it('refuses money that is not a number', () => {
    ok(at({ credits: 'some' }).errors);
    ok(at({ freight: 'x' }).errors);
  });
  it('keeps an empty box empty rather than calling it zero', () => {
    eq(at({ credits: '' }).row.credits, null);
    eq(at({ credits: '0' }).row.credits, 0);
  });
  it('stores the ticks as ticks', () => {
    eq([at({ cc_fee: true }).row.cc_fee, at({}).row.cc_fee], [1, 0]);
    eq(at({ partial: 1 }).row.partial, 1);
  });
});

// Allocation and payment are separate days. Conflating them is how a rep
// gets paid twice.
describe('marking commission paid', () => {
  it('takes a list of rows', () => {
    eq(cleanPaid({ ids: ['a', 'b'], paid: true }).row, { ids: ['a', 'b'], paid: 1 });
  });
  it('refuses an empty run', () => {
    ok(cleanPaid({ ids: [] }).errors);
    ok(cleanPaid({}).errors);
    ok(cleanPaid({ ids: [1, 2] }).errors, 'ids that are not strings went through');
  });
  it('refuses a run bigger than a month could be', () => {
    ok(cleanPaid({ ids: new Array(2001).fill('x') }).errors);
  });
});

describe('a rep key', () => {
  it('is one key however the name is typed', () => {
    eq(repKey('Stone Sales Inc. (Bouchard Group)'), 'stone-sales-inc-bouchard-group');
    eq(repKey('  Nathan   Zelena LLC '), 'nathan-zelena-llc');
    eq(repKey("O'Brien Sales"), 'obrien-sales');
    eq(repKey('T&L Action Agency'), 't-l-action-agency');
  });
  it('gives nothing for nothing', () => {
    eq(repKey(''), '');
    eq(repKey(null), '');
  });
});

// ── The feed ───────────────────────────────────────────────────────────

describe('a payment arriving from outside', () => {
  const inc = (x) => cleanIncoming(Object.assign(
    { source_ref: 'rec123', paid_on: '2026-10-27', gross: 610 }, x || {}));

  it('takes what the money was', () => {
    const r = inc({ retailer: 'CINNAMON RAINBOWS', invoice_no: '22183' }).row;
    eq([r.source_ref, r.paid_on, r.gross, r.retailer, r.invoice_no],
       ['rec123', '2026-10-27', 610, 'CINNAMON RAINBOWS', '22183']);
  });
  // Without a ref there is nothing to recognise a replay by, and a replay
  // would pay a rep twice.
  it('will not take a payment with no id of its own', () => {
    ok(inc({ source_ref: '' }).errors);
    ok(cleanIncoming({ paid_on: '2026-10-27', gross: 10 }).errors);
  });
  // "10/27/2026" is ambiguous the world over and would file half a year in
  // the wrong month without ever looking wrong.
  it('takes one date format and refuses the rest', () => {
    eq(cleanDate('2026-10-27'), '2026-10-27');
    eq(cleanDate('10/27/2026'), '');
    eq(cleanDate('27 Oct 2026'), '');
    eq(cleanDate(''), '');
    ok(inc({ paid_on: '10/27/2026' }).errors);
  });
  it('insists on an amount, and will not take zero', () => {
    ok(inc({ gross: '' }).errors);
    ok(inc({ gross: 0 }).errors);
    ok(inc({ gross: 'none' }).errors);
    eq(inc({ gross: '-120.50' }).row.gross, -120.5, 'a refund could not come through');
  });
  it('accepts the field names a Zap is likely to send', () => {
    eq(cleanIncoming({ id: 'rec9', date: '2026-01-02', amount: '1,000.00' }).row.gross, 1000);
    eq(cleanIncoming({ id: 'rec9', date: '2026-01-02', amount: 5 }).row.source_ref, 'rec9');
  });
  // A feed that could set a rate would be a way to pay somebody without
  // anybody deciding to.
  it('cannot set a rep, a rate or anything that pays out', () => {
    const r = inc({ rep_key: 'nathan-zelena', commission_pct: 99, paid: 1, credits: -500 }).row;
    eq(Object.keys(r).sort(),
       ['cad', 'cc_fee', 'customer', 'gross', 'invoice_no', 'paid_on',
        'payment_method', 'retailer', 'source', 'source_ref']);
  });
  it('defaults the source and refuses one it does not know', () => {
    eq(inc().row.source, 'zapier');
    eq(inc({ source: 'ledger' }).row.source, 'ledger');
    ok(inc({ source: 'somewhere' }).errors);
  });
});

// ── Config and the copied file ─────────────────────────────────────────

describe('who can open this', () => {
  const toml = fs.readFileSync(root('wrangler.toml'), 'utf8');
  const list = (name) => ((toml.match(new RegExp('^' + name + ' = "([^"]*)"', 'm')) || ['', ''])[1])
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

  it('is a short list of real addresses', () => {
    const users = list('COMMISSION_USERS');
    ok(users.length >= 1, 'nobody can open it');
    for (const who of users) {
      ok(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who), '"' + who + '" is not an address');
      eq(who, who.toLowerCase(), who + ' is not lower case');
    }
  });
  // A user on a domain Access blocks is a line of config that looks right
  // and does nothing: they meet a sign-in wall with no clue who to ask.
  it('only names people Cloudflare Access will let in', () => {
    const domains = list('ACCESS_DOMAINS');
    ok(domains.length, 'ACCESS_DOMAINS is missing');
    for (const who of list('COMMISSION_USERS')) {
      ok(domains.includes(who.split('@')[1]), who + ' is on a domain Access does not admit');
    }
  });
  // The secret that can write a payment without an Access identity must not
  // be committed, whatever else is in here.
  it('keeps the ingest key out of the file', () => {
    ok(!/^INGEST_KEY\s*=/m.test(toml), 'the ingest key is committed in wrangler.toml');
    ok(/INGEST_KEY is NOT here/.test(toml), 'nothing says where the key lives');
  });
  it('reads its own allowlist, not the calendar\'s', () => {
    const access = fs.readFileSync(root('worker/access.js'), 'utf8');
    ok(/env\.COMMISSION_USERS/.test(access), 'it still reads CALENDAR_EDITORS');
    ok(!/env\.CALENDAR_EDITORS/.test(access), 'the calendar list is still wired in');
  });
});

// access.js is a copy. Copied rather than imported because these are separate
// Workers with separate deploys and a shared module would mean a calendar
// change could stop Amy being paid -- but a copy nobody compares is a copy
// that rots.
describe('the copied Access check', () => {
  const mine = fs.readFileSync(root('worker/access.js'), 'utf8');
  const theirs = fs.readFileSync(root('../calendar/worker/access.js'), 'utf8');
  const strip = (s) => s.replace(/^\/\/.*$/gm, '')
    .replace(/CALENDAR_EDITORS|COMMISSION_USERS/g, 'ALLOWLIST')
    .replace(/\s+/g, ' ').trim();

  it('is the calendar\'s, with the allowlist renamed and nothing else', () => {
    eq(strip(mine), strip(theirs),
       'the two Access checks have drifted; copy the calendar\'s across again');
  });
  it('still verifies the Access token rather than trusting the header', () => {
    ok(/verifyJwt/.test(mine), 'JWT verification is gone');
    ok(/verified && editors\.includes/.test(mine), 'an unverified header could edit');
  });
});

console.log('');
console.log(ran + ' checks, ' + (failed ? failed + ' FAILED' : 'all passed'));
process.exit(failed ? 1 : 0);
