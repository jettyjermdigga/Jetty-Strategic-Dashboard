// Reading paid invoices out of Xero.
//
// Pure: no network, no database, no clock. Everything here is "given this
// invoice, what rows belong in the queue" -- which is the part worth testing,
// and the part that would otherwise only be checked by watching live money
// appear.
//
// Shapes taken from Xero's own OpenAPI spec (XeroAPI/Xero-OpenAPI,
// xero_accounting.yaml, v19.1.0), not from memory:
//
//   GET /Invoices?page=N  returns up to 100 invoices WITH their line items,
//                         each carrying Contact, CurrencyCode, Total and a
//                         Payments array of full Payment objects.
//   LineItem.AccountCode  is how an invoice is known to be wholesale.
//   Payment.PaymentID     is stable, which is what makes a re-pull idempotent.
//   Dates are msdate      -- /Date(1234567890000+0000)/ -- on Payment.Date,
//                         Invoice.Date and the rest. A plain string is
//                         accepted too, because the SDKs hand both out.

export const XERO_API = 'https://api.xero.com/api.xro/2.0';
export const XERO_AUTHORIZE = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS = 'https://api.xero.com/connections';

// offline_access is what makes a refresh token come back at all; without it
// the link dies in half an hour and nobody finds out until a Monday.
export const XERO_SCOPES = [
  'offline_access',
  'accounting.transactions.read',
  'accounting.settings.read',
].join(' ');

// A sales invoice. ACCPAY is a bill we owe and has no business here; the
// credit and prepayment types are not a retailer paying an invoice.
export const SALES = 'ACCREC';

/**
 * Xero's JSON dates: /Date(1612137600000+0000)/.
 *
 * The offset is deliberately ignored. The number is already milliseconds
 * since the epoch in UTC, and adding the offset again moves payments made in
 * the evening into the next day -- which lands them in the wrong month and
 * therefore on the wrong statement.
 */
export function msDate(v) {
  if (v == null) return '';
  const s = String(v);
  const m = s.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (m) {
    const d = new Date(Number(m[1]));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  // A plain YYYY-MM-DD, or an ISO timestamp.
  const plain = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return plain ? plain[1] : '';
}

/** The account codes that mean wholesale revenue, from config. Codes rather
 *  than names: an account can be renamed in Xero without anybody telling us,
 *  and a renamed account silently matching nothing is a month of commission
 *  that never arrives. */
export function accountCodes(raw) {
  return String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
}

export function isWholesale(invoice, codes) {
  if (!invoice || invoice.Type !== SALES) return false;
  if (!codes || !codes.length) return false;
  const lines = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
  return lines.some((l) => codes.includes(String((l && l.AccountCode) || '').trim()));
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * The queue rows one invoice is worth: one per payment applied to it.
 *
 * Per payment rather than per invoice because that is how a rep is paid --
 * commission follows the money arriving, and an invoice settled in three
 * instalments earns three times, when each one lands.
 *
 * DELETED payments are skipped. A reversed payment that still earned
 * commission is the kind of thing nobody notices until a rep queries it.
 */
export function rowsFromInvoice(invoice, codes) {
  if (!isWholesale(invoice, codes)) return [];
  const payments = Array.isArray(invoice.Payments) ? invoice.Payments : [];
  const total = money(invoice.Total);
  const currency = String(invoice.CurrencyCode || '').toUpperCase();
  const out = [];
  for (const p of payments) {
    if (!p || !p.PaymentID) continue;
    if (String(p.Status || '').toUpperCase() === 'DELETED') continue;
    const paidOn = msDate(p.Date);
    const gross = money(p.Amount);
    if (!paidOn || gross == null || gross === 0) continue;

    // Not USD means the invoice was raised in another currency and settled
    // into a USD account. BankAmount is that USD figure, and it is what the
    // rep is paid on -- paying on the foreign net would hand them the
    // exchange rate as a bonus.
    const foreign = Boolean(currency) && currency !== 'USD';
    const bank = money(p.BankAmount);

    out.push({
      source: 'xero',
      source_ref: String(p.PaymentID),
      paid_on: paidOn,
      invoice_no: String(invoice.InvoiceNumber || '').slice(0, 60) || null,
      retailer: String((invoice.Contact && invoice.Contact.Name) || '').slice(0, 120) || null,
      customer: null,
      // Xero's own words for how it was paid: "Direct Debit", a cheque
      // number, whatever was typed. Amy can tidy it; the point is that it
      // arrives rather than being left blank.
      payment_method: String(p.Reference || '').slice(0, 60) || null,
      gross,
      cad: foreign ? 1 : 0,
      usd_net: foreign ? bank : null,
      cc_fee: 0,
      // Part payment when this one did not clear the invoice. Read off the
      // invoice total rather than AmountDue, which is what is left NOW and
      // says nothing about what this payment was at the time.
      partial: total != null && Math.abs(gross) + 0.005 < Math.abs(total) ? 1 : 0,
      currency: currency || null,
      xero_invoice_id: String(invoice.InvoiceID || '') || null,
    });
  }
  return out;
}

/** Every row a page of invoices is worth. */
export function rowsFromPage(body, codes) {
  const invoices = (body && Array.isArray(body.Invoices)) ? body.Invoices : [];
  const out = [];
  for (const inv of invoices) out.push(...rowsFromInvoice(inv, codes));
  return out;
}

/**
 * The query for one page.
 *
 * Statuses rather than a where clause: Xero's own docs say the explicit
 * parameter is the faster path, and this runs over years of invoices.
 *
 * AUTHORISED is in there alongside PAID because a part-paid invoice is still
 * AUTHORISED, and its payments have already earned commission.
 */
export function pageQuery(page) {
  const params = new URLSearchParams();
  params.set('where', 'Type=="' + SALES + '"');
  params.set('Statuses', 'AUTHORISED,PAID');
  params.set('page', String(page || 1));
  params.set('order', 'UpdatedDateUTC ASC');
  return params.toString();
}

/** Xero wants If-Modified-Since as a plain UTC timestamp with no zone
 *  suffix. Undefined means "everything", which is what a first pull wants. */
export function sinceHeader(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}
