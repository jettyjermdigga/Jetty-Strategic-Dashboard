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
import {
  msDate, accountCodes, isWholesale, rowsFromInvoice, rowsFromPage,
  pageQuery, sinceHeader, SALES, XERO_SCOPES, revenueAccounts,
} from '../worker/xero.js';
import { sqlStatements } from '../worker/sql.js';
import { buildWhere, monthRange, cleanYear, cleanLimit, STATUS_KEYS } from '../worker/filters.js';

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
  it('accepts the shorter field names too', () => {
    eq(cleanIncoming({ id: 'p9', date: '2026-01-02', amount: '1,000.00' }).row.gross, 1000);
    eq(cleanIncoming({ id: 'p9', date: '2026-01-02', amount: 5 }).row.source_ref, 'p9');
  });
  // Facts about the payment, which Xero knows and Amy should not have to
  // retype.
  it('carries what settled, in what currency, and whether it cleared', () => {
    const r = inc({ usd_net: 1000, partial: 1, currency: 'cad', cad: 1 }).row;
    eq([r.usd_net, r.partial, r.currency, r.cad], [1000, 1, 'CAD', 1]);
  });
  // A feed that could set a rate would be a way to pay somebody without
  // anybody deciding to.
  it('cannot set a rep, a rate or anything that pays out', () => {
    const r = inc({ rep_key: 'nathan-zelena', commission_pct: 99, paid: 1, credits: -500 }).row;
    eq(Object.keys(r).sort(),
       ['cad', 'cc_fee', 'currency', 'customer', 'gross', 'invoice_no', 'paid_on',
        'partial', 'payment_method', 'retailer', 'source', 'source_ref',
        'usd_net', 'xero_invoice_id']);
    ok(!('rep_key' in r) && !('commission_pct' in r) && !('paid' in r),
       'the feed can set something that pays out');
  });
  it('defaults the source and refuses one it does not know', () => {
    eq(inc().row.source, 'xero');
    eq(inc({ source: 'ledger' }).row.source, 'ledger');
    ok(inc({ source: 'somewhere' }).errors);
  });
});

// ── Which payments a view is asking for ─────────────────────
//
// The Airtable base answered this with forty-odd saved views. One filter bar
// instead, and this is what each setting means.

describe('the filter bar', () => {
  const w = (p) => buildWhere(p);

  // The screen is opened to do the allocating.
  it('shows what needs a rep unless asked otherwise', () => {
    eq(w({}).status, 'needs');
    eq(w({}).sql, ' WHERE rep_key IS NULL');
    eq(w({ status: 'nonsense' }).status, 'needs');
  });
  it('shows everything when asked', () => {
    eq(w({ status: 'all' }).sql, '');
  });
  it('separates allocated from paid', () => {
    ok(w({ status: 'allocated' }).sql.includes('rep_key IS NOT NULL'));
    ok(w({ status: 'unpaid' }).sql.includes('paid = 0'));
    ok(w({ status: 'paid' }).sql.includes('paid = 1'));
  });
  // One per rep is what the Airtable base needed twenty-five views for.
  it('narrows to one rep', () => {
    const r = w({ status: 'all', rep: 'nathan-zelena' });
    ok(r.sql.includes('rep_key = ?'));
    eq(r.binds, ['nathan-zelena']);
  });
  it('narrows to a month, as a half-open range', () => {
    eq(monthRange('2026-10'), { from: '2026-10-01', to: '2026-11-01' });
    // December has to roll the year, which is the one a hand-written range
    // gets wrong.
    eq(monthRange('2026-12'), { from: '2026-12-01', to: '2027-01-01' });
    eq(w({ status: 'all', month: '2026-10' }).binds, ['2026-10-01', '2026-11-01']);
  });
  // A month that silently means all of time is worse than no month at all.
  it('ignores a month it cannot read rather than guessing one', () => {
    eq(monthRange('2026-13'), null);
    eq(monthRange('2026-00'), null);
    eq(monthRange('October'), null);
    eq(monthRange(''), null);
    eq(w({ status: 'all', month: 'October' }).sql, '');
  });
  it('narrows to a year', () => {
    eq(w({ status: 'all', year: '2025' }).binds, ['2025-01-01', '2026-01-01']);
    eq(cleanYear('1066'), null);
    eq(cleanYear('abcd'), null);
  });
  it('lets the month win over the year rather than applying both', () => {
    eq(w({ status: 'all', month: '2026-03', year: '2025' }).binds,
       ['2026-03-01', '2026-04-01']);
  });
  it('narrows to a territory, a line and the Canadian rows', () => {
    eq(w({ status: 'all', territory: 'HI' }).binds, ['HI']);
    eq(w({ status: 'all', line: 'SS26' }).binds, ['SS26']);
    ok(w({ status: 'all', cad: '1' }).sql.includes('cad = 1'));
  });
  // Everything is bound. A retailer called O'Neill must not be able to end
  // a statement early.
  it('binds every value rather than writing it into the SQL', () => {
    for (const p of [{ rep: "x' OR 1=1 --" }, { territory: "'" }, { q: "';DROP--" },
                     { status: 'all', line: "'" }]) {
      const r = w(Object.assign({ status: 'all' }, p));
      ok(!r.sql.includes("'" ) || /ESCAPE/.test(r.sql),
         'a value reached the SQL: ' + r.sql);
    }
  });
  // Typed wildcards would make "100%" match everything and "_" match any
  // character -- and without ESCAPE, escaping them leaves backslashes in the
  // pattern that stop it matching at all.
  it('escapes the wildcards somebody types into the search box', () => {
    const r = w({ status: 'all', q: '100%' });
    ok(r.sql.includes("ESCAPE '\\'"), 'there is no ESCAPE clause, so the escaping does nothing');
    eq(r.binds[0], '%100\\%%');
  });
  it('searches the three things somebody would type', () => {
    const r = w({ status: 'all', q: 'Maui' });
    ok(/retailer LIKE/.test(r.sql) && /invoice_no LIKE/.test(r.sql)
       && /customer LIKE/.test(r.sql));
    eq(r.binds.length, 3);
  });
  // Oldest first while allocating; newest first once it is a record being
  // read rather than a job being worked.
  it('sorts for the job the view is for', () => {
    ok(w({}).order.includes('ASC'));
    ok(w({ status: 'all' }).order.includes('DESC'));
    ok(w({ status: 'paid' }).order.includes('DESC'));
  });
  it('caps how much one request can ask for', () => {
    eq(cleanLimit('9999'), 500);
    eq(cleanLimit('abc'), 200);
    eq(cleanLimit('-1'), 200);
    eq(cleanLimit('50'), 50);
  });
  it('offers the page a status for every one it understands', () => {
    for (const k of STATUS_KEYS) eq(buildWhere({ status: k }).status, k);
  });
});

describe('the filters run against the real table', () => {
  const db = new DatabaseSync(':memory:');
  for (const stmt of sqlStatements(fs.readFileSync(root('worker/schema.sql'), 'utf8'))) {
    db.exec(stmt);
  }
  const ins = db.prepare(
    'INSERT INTO payments (id, source_ref, paid_on, retailer, gross, rep_key, '
    + 'commission_pct, paid, territory) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  [['a', '2026-09-30', '100% Off Surf', 1000, null, null, 0, 'HI'],
   ['b', '2026-10-01', 'East of Maui', 2000, 'rep-one', 10, 0, 'HI'],
   ['c', '2026-10-31', 'A_B Shop', 3000, 'rep-one', 10, 1, 'NJ'],
   ['d', '2026-11-01', 'AXB Shop', 4000, 'rep-two', 5, 0, 'NJ'],
  ].forEach((r) => ins.run(r[0], r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]));

  const find = (p) => {
    const w = buildWhere(p);
    return db.prepare('SELECT id FROM payments' + w.sql + w.order)
      .all(...w.binds).map((r) => r.id);
  };

  it('finds what is waiting', () => eq(find({}), ['a']));
  it('finds one rep', () => eq(find({ status: 'all', rep: 'rep-one' }), ['c', 'b']));
  // The boundaries are the whole point of a half-open range.
  it('finds a month without catching its neighbours', () => {
    eq(find({ status: 'all', month: '2026-10' }), ['c', 'b']);
  });
  it('finds what is allocated and unpaid', () => eq(find({ status: 'unpaid' }), ['d', 'b']));
  it('finds what is paid', () => eq(find({ status: 'paid' }), ['c']));
  it('finds a rep in a month', () => {
    eq(find({ status: 'all', rep: 'rep-one', month: '2026-10' }), ['c', 'b']);
    eq(find({ status: 'all', rep: 'rep-two', month: '2026-10' }), []);
  });
  it('finds a territory', () => eq(find({ status: 'all', territory: 'NJ' }), ['d', 'c']));
  it('does not treat a typed wildcard as a wildcard', () => {
    eq(find({ status: 'all', q: '100%' }), ['a']);
    eq(find({ status: 'all', q: 'A_B' }), ['c']);
  });
});

// ── Reading paid invoices out of Xero ──────────────────────
//
// Shapes taken from Xero's own OpenAPI spec, not from memory: GET /Invoices
// with a page parameter returns up to 100 invoices WITH their line items,
// each carrying Contact, CurrencyCode, Total and a Payments array.

describe('Xero dates', () => {
  // /Date(1612137600000+0000)/ is what comes back on the wire. A payment made
  // in the evening, shifted by an offset that was already applied, lands on
  // the next day -- in the wrong month, and therefore on the wrong statement.
  it('reads the Microsoft date format Xero actually sends', () => {
    eq(msDate('/Date(1612137600000+0000)/'), '2021-02-01');
    // 20:00 UTC: add a +1300 offset that Xero has already applied and this
    // payment moves to the 2nd -- into the next month on the last day of
    // January, and onto the wrong statement.
    eq(msDate('/Date(1612209600000+1300)/'), '2021-02-01',
       'the offset was applied twice');
    eq(msDate('/Date(1612209600000-0500)/'), '2021-02-01',
       'a negative offset was applied twice');
    eq(msDate('/Date(-86400000+0000)/'), '1969-12-31');
  });
  it('takes a plain date or a timestamp as well', () => {
    eq(msDate('2026-10-27'), '2026-10-27');
    eq(msDate('2026-10-27T23:50:00Z'), '2026-10-27');
  });
  it('gives nothing for anything else', () => {
    eq(msDate(''), '');
    eq(msDate(null), '');
    eq(msDate('/Date(nonsense)/'), '');
    eq(msDate('last tuesday'), '');
  });
});

describe('which invoices are wholesale', () => {
  const inv = (x) => Object.assign({
    Type: SALES, InvoiceID: 'inv-1', InvoiceNumber: '22183', Total: 610,
    CurrencyCode: 'USD', Contact: { Name: 'CINNAMON RAINBOWS' },
    LineItems: [{ AccountCode: '400' }, { AccountCode: '200' }],
    Payments: [{ PaymentID: 'pay-1', Date: '/Date(1793232000000+0000)/',
                 Amount: 610, Reference: 'Direct Debit', Status: 'AUTHORISED' }],
  }, x || {});

  it('is one whose line items hit a wholesale account', () => {
    eq(isWholesale(inv(), ['200']), true);
    eq(isWholesale(inv(), ['400', '999']), true);
    eq(isWholesale(inv(), ['999']), false);
  });
  // A bill we owe is not a retailer paying us.
  it('is never a bill or a credit note', () => {
    eq(isWholesale(inv({ Type: 'ACCPAY' }), ['200']), false);
    eq(isWholesale(inv({ Type: 'ACCRECCREDIT' }), ['200']), false);
  });
  // Empty config must import nothing rather than everything.
  it('is nothing at all when no accounts are configured', () => {
    eq(isWholesale(inv(), []), false);
    eq(isWholesale(inv(), null), false, 'an unset list was read as a match');
    eq(isWholesale(inv(), undefined), false);
    eq(accountCodes(''), []);
    eq(accountCodes(null), []);
    eq(accountCodes(' 200 , 201 ,,'), ['200', '201']);
  });
});

describe('what an invoice is worth to the queue', () => {
  const inv = (x) => Object.assign({
    Type: SALES, InvoiceID: 'inv-1', InvoiceNumber: '22183', Total: 610,
    CurrencyCode: 'USD', Contact: { Name: 'CINNAMON RAINBOWS' },
    LineItems: [{ AccountCode: '200' }],
    Payments: [{ PaymentID: 'pay-1', Date: '/Date(1793232000000+0000)/',
                 Amount: 610, Reference: 'Direct Debit', Status: 'AUTHORISED' }],
  }, x || {});
  const one = (x) => rowsFromInvoice(inv(x), ['200'])[0];

  it('is one row per payment, not one per invoice', () => {
    const r = rowsFromInvoice(inv({ Payments: [
      { PaymentID: 'a', Date: '/Date(1793232000000+0000)/', Amount: 300, Status: 'AUTHORISED' },
      { PaymentID: 'b', Date: '/Date(1793318400000+0000)/', Amount: 310, Status: 'AUTHORISED' },
    ] }), ['200']);
    eq(r.length, 2);
    eq(r.map((x) => x.gross), [300, 310]);
  });
  // PaymentID is what makes a re-pull write nothing the second time.
  it('is keyed on the payment, so a re-pull is harmless', () => {
    eq(one().source_ref, 'pay-1');
    eq(one().source, 'xero');
  });
  it('carries the retailer, the invoice number and how it was paid', () => {
    eq([one().retailer, one().invoice_no, one().payment_method],
       ['CINNAMON RAINBOWS', '22183', 'Direct Debit']);
  });
  // A reversed payment that still earned commission is the kind of thing
  // nobody notices until a rep queries it.
  it('leaves a deleted payment out', () => {
    eq(rowsFromInvoice(inv({ Payments: [
      { PaymentID: 'a', Date: '/Date(1793232000000+0000)/', Amount: 5, Status: 'DELETED' },
    ] }), ['200']).length, 0);
  });
  it('leaves out a payment with no id, no date or no amount', () => {
    const bad = [
      { Date: '/Date(1793232000000+0000)/', Amount: 5, Status: 'AUTHORISED' },
      { PaymentID: 'b', Amount: 5, Status: 'AUTHORISED' },
      { PaymentID: 'c', Date: '/Date(1793232000000+0000)/', Status: 'AUTHORISED' },
      { PaymentID: 'd', Date: '/Date(1793232000000+0000)/', Amount: 0, Status: 'AUTHORISED' },
    ];
    eq(rowsFromInvoice(inv({ Payments: bad }), ['200']).length, 0);
  });
  it('marks a payment that did not clear the invoice', () => {
    eq(one().partial, 0);
    eq(rowsFromInvoice(inv({ Payments: [
      { PaymentID: 'a', Date: '/Date(1793232000000+0000)/', Amount: 300, Status: 'AUTHORISED' },
    ] }), ['200'])[0].partial, 1);
  });
  // Paying on the foreign net would hand the rep the exchange rate as a
  // bonus. BankAmount is what it actually settled for.
  it('takes a foreign invoice at what it settled for', () => {
    const r = rowsFromInvoice(inv({ CurrencyCode: 'CAD', Total: 1400, Payments: [
      { PaymentID: 'a', Date: '/Date(1793232000000+0000)/', Amount: 1400,
        BankAmount: 1000, Status: 'AUTHORISED' },
    ] }), ['200'])[0];
    eq([r.cad, r.usd_net, r.gross, r.currency], [1, 1000, 1400, 'CAD']);
  });
  it('leaves a USD invoice alone', () => {
    eq([one().cad, one().usd_net], [0, null]);
  });
  // A foreign invoice with no BankAmount has to reach Amy rather than be
  // priced at zero.
  it('leaves the USD figure empty rather than guessing it', () => {
    const r = rowsFromInvoice(inv({ CurrencyCode: 'GBP', Payments: [
      { PaymentID: 'a', Date: '/Date(1793232000000+0000)/', Amount: 500, Status: 'AUTHORISED' },
    ] }), ['200'])[0];
    eq([r.cad, r.usd_net], [1, null]);
  });
  it('reads a whole page, and copes with an empty one', () => {
    eq(rowsFromPage({ Invoices: [inv(), inv({ InvoiceID: 'i2' })] }, ['200']).length, 2);
    eq(rowsFromPage({ Invoices: [] }, ['200']).length, 0);
    eq(rowsFromPage({}, ['200']).length, 0);
    eq(rowsFromPage(null, ['200']).length, 0);
  });
  // Everything the mapper produces has to survive the gate everything else
  // entering the queue goes through.
  it('produces rows the feed gate accepts unchanged', () => {
    const r = one();
    const { row, errors } = cleanIncoming(r);
    ok(!errors, show(errors));
    eq([row.source_ref, row.gross, row.retailer, row.paid_on],
       [r.source_ref, r.gross, r.retailer, r.paid_on]);
  });
});

describe('everything from Xero goes through the feed gate', () => {
  const idx = fs.readFileSync(root('worker/index.js'), 'utf8');
  const at = idx.indexOf('async function runPull');
  const body = idx.slice(at, idx.indexOf('\nconst QUEUE_FIELDS', at));

  // Today's mapper produces nothing cleanIncoming would reject, so no
  // behavioural check can tell whether the gate is wired in. This is the
  // weaker, structural kind on purpose -- the gate is what stops a later
  // change to the mapper quietly writing a rep or a rate.
  it('cleans every row rather than trusting the mapper', () => {
    ok(at > 0, 'there is no pull');
    ok(/cleanIncoming\(candidate\)/.test(body), 'rows go straight into the table');
    ok(/PAYMENT_COLS\.map/.test(body), 'the insert does not use the cleaned columns');
    const cols = idx.slice(idx.indexOf('const PAYMENT_COLS'), idx.indexOf('];', idx.indexOf('const PAYMENT_COLS')));
    for (const banned of ['rep_key', 'commission_pct', 'paid']) {
      ok(!cols.includes("'" + banned + "'"), 'a pull can write ' + banned);
    }
  });
  // Nothing is stored to be stolen or to go stale: a client_credentials
  // token lasts about half an hour and the next run asks for another.
  it('keeps no Xero credential in the database', () => {
    ok(!/SET refresh_token = \?/.test(idx), 'a refresh token is still being stored');
    ok(!/refreshAccess|exchangeCode/.test(idx), 'the sign-in flow is still wired in');
  });
  // One place that gets a token and the organisation, so the pull and the
  // chart of accounts cannot drift into asking for them differently.
  it('gets its token and its organisation in one place', () => {
    ok(/async function xeroSession\(env, db\)/.test(idx), 'there is no session helper');
    eq([...idx.matchAll(/await accessToken\(\{/g)].length, 1,
       'a token is asked for in more than one place');
    ok([...idx.matchAll(/await xeroSession\(env, db\)/g)].length >= 3,
       'the session helper is not used by every caller');
  });
  // A cached tenant id that has gone stale is a pull that writes nothing
  // and says it worked.
  it('reads the organisation each time rather than trusting a stored one', () => {
    const at = idx.indexOf('async function xeroSession');
    const fn = idx.slice(at, idx.indexOf('\nconst PAYMENT_COLS', at));
    ok(/await tenants\(\{/.test(fn), 'the tenant id is never read from Xero');
  });
  // Moving it after a run that stopped on a rate limit would skip whatever
  // was left behind.
  it('leaves the watermark alone when the run did not finish', () => {
    ok(/out\.more \? \(row\.watermark/.test(body),
       'the watermark moves even when the window was not finished');
  });
});

describe('picking the wholesale account', () => {
  const chart = { Accounts: [
    { Code: '201', Name: 'DTC Revenue', Class: 'REVENUE', Status: 'ACTIVE', Type: 'REVENUE' },
    { Code: '200', Name: 'Wholesale Revenue', Class: 'REVENUE', Status: 'ACTIVE', Type: 'REVENUE' },
    { Code: '090', Name: 'Business Bank', Class: 'ASSET', Status: 'ACTIVE' },
    { Code: '199', Name: 'Old Revenue', Class: 'REVENUE', Status: 'ARCHIVED' },
    { Code: '', Name: 'Unnumbered', Class: 'REVENUE', Status: 'ACTIVE' },
  ] };

  // A wholesale payment lands on an income account; a bank account is not a
  // choice and an archived one is not where this year's money is going.
  it('offers the active revenue accounts and nothing else', () => {
    eq(revenueAccounts(chart).map((a) => a.code), ['200', '201']);
  });
  // XERO_ACCOUNTS is a list of codes, so an account with none is no use.
  it('leaves out an account with no code', () => {
    ok(!revenueAccounts(chart).some((a) => !a.code));
  });
  it('sorts them, so the same chart reads the same way twice', () => {
    const codes = revenueAccounts(chart).map((a) => a.code);
    eq(codes, [...codes].sort());
  });
  it('copes with a chart that is not there', () => {
    eq(revenueAccounts({}), []);
    eq(revenueAccounts(null), []);
    eq(revenueAccounts({ Accounts: [] }), []);
  });
});

describe('what the pull asks Xero for', () => {
  it('asks for sales invoices only, by the fast parameter', () => {
    const q = new URLSearchParams(pageQuery(1));
    eq(q.get('where'), 'Type=="ACCREC"');
    // Xero's own docs: the explicit parameter is faster than an OR in where.
    eq(q.get('Statuses'), 'AUTHORISED,PAID');
  });
  // A part-paid invoice is still AUTHORISED, and its payments have already
  // earned commission.
  it('does not ask only for PAID, which would miss every part payment', () => {
    ok(new URLSearchParams(pageQuery(1)).get('Statuses').includes('AUTHORISED'));
  });
  it('pages, and orders so the watermark means something', () => {
    eq(new URLSearchParams(pageQuery(3)).get('page'), '3');
    eq(new URLSearchParams(pageQuery(1)).get('order'), 'UpdatedDateUTC ASC');
  });
  it('sends a timestamp Xero will take, or none at all', () => {
    eq(sinceHeader('2026-10-27T12:00:00.000Z'), '2026-10-27T12:00:00');
    eq(sinceHeader(null), null);
    eq(sinceHeader('not a date'), null);
  });
  // A Custom Connection is machine-to-machine: one organisation, no user
  // and no consent screen. Asking for the user-facing scopes is exactly
  // what Xero was refusing with invalid_scope.
  it("asks for a Custom Connection's scopes, not a sign-in's", () => {
    const scopes = XERO_SCOPES.split(' ');
    for (const x of ['openid', 'profile', 'email', 'offline_access']) {
      ok(!scopes.includes(x), x + ' is not a scope a Custom Connection has');
    }
    ok(!scopes.includes('accounting.transactions.read'),
       'the umbrella scope exists only for the user-facing flow');
  });
  // The payments arrive nested inside each invoice. Without the scope they
  // come back as an empty array, which reads as a quiet month rather than
  // as a permissions problem -- the worst way for this to be wrong.
  it('asks for the payments as well as the invoices', () => {
    const scopes = XERO_SCOPES.split(' ');
    ok(scopes.includes('accounting.invoices.read'));
    ok(scopes.includes('accounting.payments.read'),
       'invoices would come back with no payments on them');
    ok(scopes.includes('accounting.settings.read'), 'the chart of accounts needs this');
  });
  it('asks for nothing that could write the books', () => {
    for (const x of XERO_SCOPES.split(' ')) ok(x.endsWith('.read'), x + ' is not read-only');
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
  // The two credentials that could read the whole of Xero.
  it('keeps the Xero secret and the refresh token out of the file', () => {
    ok(!/^XERO_CLIENT_SECRET\s*=/m.test(toml), 'the Xero secret is committed');
    ok(!/refresh_token/i.test(toml), 'a refresh token is committed');
    ok(/set in Cloudflare rather than here/.test(toml),
       'nothing says where the secret lives');
  });
  // The Connect button goes nowhere without it, and the page says so
  // rather than failing on the redirect.
  it('names the Xero app it connects with', () => {
    ok(/^XERO_CLIENT_ID = "[A-Za-z0-9]{16,}"/m.test(toml),
       'XERO_CLIENT_ID is not set, so Connect Xero goes nowhere');
  });
  it('has an Access application to verify tokens against', () => {
    const aud = (toml.match(/^ACCESS_AUD = "([^"]*)"/m) || ['', ''])[1];
    ok(/^[0-9a-f]{64}$/.test(aud),
       'ACCESS_AUD is not an Application Audience tag, so nobody can get in');
    ok(/^ACCESS_TEAM_DOMAIN = "[^"]+\.cloudflareaccess\.com"/m.test(toml),
       'there is no team domain to check the token with');
  });
  it('pulls on a schedule rather than waiting to be asked', () => {
    ok(/^crons = \[/m.test(toml), 'nothing pulls from Xero on its own');
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
