// What a commission is worth, and what has to be true before it can be paid.
//
// Pure: no database, no clock, no ids. The same three formulas the Airtable
// base has always used, written once here so the page, the API and the
// monthly statement all agree:
//
//   Net Invoice = Original Invoice + Credits - Freight
//   Amount Due  = Net Invoice x Commission % / 100
//   USD Commission (on a Canadian row) = USD Net Invoice x Commission % / 100
//
// Credits are stored as they are entered. In the Airtable base they are
// negative on a credit and the formula adds them, which is why this adds
// rather than subtracts -- a sign flip here would quietly overpay on every
// invoice that carried a credit.
//
// Freight is subtracted because nobody earns commission on shipping.

/** Money, to the cent. Two multiplications of a float can land on
 *  1234.5600000000002, and a statement that does not foot is a statement
 *  somebody has to check by hand. */
export function cents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function num(v) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function netInvoice(row) {
  return cents(num(row && row.gross) + num(row && row.credits) - num(row && row.freight));
}

/** The base the commission is worked out on. A Canadian row is invoiced in
 *  CAD and settled in USD, so it carries its own USD figure and that is what
 *  the rep is paid on -- using the CAD net would pay them the exchange rate
 *  as a bonus. */
export function commissionBase(row) {
  if (row && row.cad) return cents(num(row.usd_net));
  return netInvoice(row);
}

export function amountDue(row) {
  const pct = row == null ? 0 : num(row.commission_pct);
  return cents((commissionBase(row) * pct) / 100);
}

/** Nothing to allocate once a rep is on it. This is the whole definition of
 *  the queue -- the Airtable view was "Sales Rep is empty" and this is the
 *  same rule, in one place rather than in a view somebody can edit. */
export function isUnallocated(row) {
  return !(row && String(row.rep_key || '').trim());
}

export const MAX_PCT = 50;

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/**
 * What Amy fills in on a payment.
 *
 * `reps` is the list of rep keys that exist. A rep typed in free text is the
 * thing that turns one person into three spellings and a statement that is
 * short, so the only way to set one is to pick one.
 */
export function cleanAllocation(input, reps) {
  const errors = [];
  const i = input || {};

  const rep = text(i.rep_key, 60);
  if (rep && !(reps || []).includes(rep)) errors.push('That is not a rep on the list.');

  const pctRaw = i.commission_pct;
  let pct = null;
  if (pctRaw !== '' && pctRaw != null) {
    const n = Number(String(pctRaw).replace(/[%\s]/g, ''));
    if (!Number.isFinite(n)) errors.push('The commission rate is not a number.');
    else if (n < 0) errors.push('A commission rate cannot be negative.');
    // A rate over 50% is far likelier to be 1500 typed for 15.00 than a real
    // deal, and the cost of catching it is one message.
    else if (n > MAX_PCT) errors.push('That rate is over ' + MAX_PCT + '%. Check it.');
    else pct = cents(n);
  }

  // A rep without a rate earns nothing and silently leaves the queue, which
  // is the one outcome worse than it staying in.
  if (rep && pct == null) errors.push('Set the commission rate as well as the rep.');

  const money = (k, label) => {
    const v = i[k];
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(/[,$\s]/g, ''));
    if (!Number.isFinite(n)) { errors.push(label + ' is not a number.'); return null; }
    return cents(n);
  };

  const row = {
    rep_key: rep || null,
    commission_pct: pct,
    retailer: text(i.retailer, 120) || null,
    customer: text(i.customer, 120) || null,
    territory: text(i.territory, 60) || null,
    jetty_line: text(i.jetty_line, 60) || null,
    payment_method: text(i.payment_method, 60) || null,
    invoice_no: text(i.invoice_no, 60) || null,
    credit_memo: text(i.credit_memo, 60) || null,
    notes: text(i.notes, 500) || null,
    credits: money('credits', 'Credits'),
    freight: money('freight', 'Freight'),
    usd_net: money('usd_net', 'The USD net'),
    cc_fee: i.cc_fee ? 1 : 0,
    cad: i.cad ? 1 : 0,
    partial: i.partial ? 1 : 0,
  };

  // A Canadian row priced off a blank USD figure pays zero, which looks like
  // a rate problem rather than a missing number.
  if (row.cad && row.usd_net == null && rep) {
    errors.push('A Canadian row needs its USD net before it can be allocated.');
  }

  if (errors.length) return { errors };
  return { row };
}

/** Marking commission paid. Separate from allocation because they are
 *  separate days: a payment is allocated when it arrives and paid at the end
 *  of the month, and conflating them is how a rep gets paid twice. */
export function cleanPaid(input) {
  const i = input || {};
  const ids = Array.isArray(i.ids) ? i.ids.filter((x) => typeof x === 'string' && x) : [];
  if (!ids.length) return { errors: ['Nothing was selected.'] };
  if (ids.length > 2000) return { errors: ['That is more rows than one run should take.'] };
  return { row: { ids, paid: i.paid ? 1 : 0 } };
}

/** Totals for a set of rows, for the strip above the queue and for a
 *  statement. Works on whatever it is handed so the page and the monthly run
 *  cannot disagree about what a month came to. */
export function totals(rows) {
  const out = { rows: 0, gross: 0, due: 0, unallocated: 0, unpaid: 0 };
  for (const r of rows || []) {
    out.rows += 1;
    out.gross = cents(out.gross + netInvoice(r));
    out.due = cents(out.due + amountDue(r));
    if (isUnallocated(r)) out.unallocated += 1;
    else if (!r.paid) out.unpaid = cents(out.unpaid + amountDue(r));
  }
  return out;
}

/** A stable key for a rep, so "Stone Sales Inc. (Bouchard Group)" is one rep
 *  however it is typed after this. */
export function repKey(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
