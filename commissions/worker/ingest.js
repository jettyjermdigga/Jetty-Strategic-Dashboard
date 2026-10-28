// A payment arriving from outside: Zapier today, a direct pull from the
// Ledger later. Pure, so the shape of what the feed may write is testable
// without a database and without a live Zap.
//
// Deliberately small. The feed states only what the money was -- when, how
// much, from whom, against which invoice. Everything a rep gets paid on is
// Amy's to set, and a feed that could set a commission rate would be a way
// to pay somebody without anybody deciding to.

const SOURCES = ['ledger', 'zapier', 'airtable', 'manual'];

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function money(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** YYYY-MM-DD, and nothing else. A feed sending "10/27/2026" is ambiguous
 *  the world over and would file half a year of payments in the wrong month
 *  without ever looking wrong. */
export function cleanDate(v) {
  const d = text(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

export function cleanIncoming(input) {
  const errors = [];
  const i = input || {};

  // The feed's own id for this payment. Without one there is nothing to
  // recognise a replay by, and a replay would pay a rep twice.
  const ref = text(i.source_ref || i.id, 120);
  if (!ref) errors.push('source_ref is required.');

  const source = text(i.source, 20).toLowerCase() || 'zapier';
  if (!SOURCES.includes(source)) errors.push('"' + source + '" is not a source.');

  const paidOn = cleanDate(i.paid_on || i.date);
  if (!paidOn) errors.push('paid_on must be a date, as YYYY-MM-DD.');

  const gross = money(i.gross == null ? i.amount : i.gross);
  if (gross == null) errors.push('gross is required.');
  // A payment of zero is a reconciliation artefact, not money arriving.
  else if (gross === 0) errors.push('gross is zero.');

  if (errors.length) return { errors };
  return {
    row: {
      source,
      source_ref: ref,
      paid_on: paidOn,
      invoice_no: text(i.invoice_no || i.invoice, 60) || null,
      retailer: text(i.retailer, 120) || null,
      customer: text(i.customer, 120) || null,
      payment_method: text(i.payment_method || i.method, 60) || null,
      gross,
      cc_fee: i.cc_fee ? 1 : 0,
      cad: i.cad ? 1 : 0,
    },
  };
}
