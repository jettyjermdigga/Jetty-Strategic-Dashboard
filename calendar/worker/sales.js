// What an event did, announced once the numbers are in.
//
// The trigger is not "somebody pressed save". An event's results arrive in
// two pieces -- the figures typed into the form, and the export from the
// till attached beside them -- and they arrive in whichever order the
// person doing it happens to work. Announcing on the upload means a message
// with no numbers in it; announcing on the save means one with no report.
//
// So the announcement waits for the SET to be complete, and goes out on
// whichever of the two finishes it. Once. See postedAt on the item.
//
// Pure, and in its own file, because index.js imports schema.sql through a
// wrangler rule and cannot be loaded in Node.

import { escapeSlack } from './slack.js';

// The attachment slot the sales report lives in. The form has used this
// name since results were added; it is here so the Worker and the page
// cannot drift on it.
export const RESULTS_SLOT = 'results';

const n = (v) => {
  if (v == null || v === '') return null;
  const x = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(x) ? x : null;
};

/**
 * Average order value, or null.
 *
 * Null rather than zero or Infinity when there are no orders: an event
 * that took no orders has no average, and a $0.00 AOV in a channel
 * message reads as a number somebody measured.
 */
export function aov(orders, revenue) {
  const o = n(orders);
  const r = n(revenue);
  if (!o || o <= 0 || r == null) return null;
  return r / o;
}

/** Revenue less what it cost to be there, or null if either is missing. */
export function netOfFee(revenue, fee) {
  const r = n(revenue);
  const f = n(fee);
  return r == null || f == null ? null : r - f;
}

/** Is there a sales report on this event? */
export const hasReport = (attachments) =>
  (attachments || []).some((a) => a && a.slot === RESULTS_SLOT);

/**
 * Enough to announce: both figures AND the report itself.
 *
 * Orders has to be above zero. An event with the report attached and
 * "0 orders" typed in is a real outcome worth recording on the event, but
 * it is not what @channel is for.
 */
export function readyToPost(item, attachments) {
  if (!item || item.results_posted_at) return false;
  if (!hasReport(attachments)) return false;
  const o = n(item.orders);
  const r = n(item.net_revenue);
  return Boolean(o && o > 0 && r != null);
}

export function money(v) {
  const x = n(v);
  if (x == null) return '';
  const s = '$' + Math.abs(x).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x < 0 ? '−' + s : s;
}

/**
 * The @channel message.
 *
 * <!channel> is Slack's own syntax and has to survive escaping, so the
 * event's own text is escaped piece by piece rather than the whole string
 * at the end -- escaping the lot would turn the mention into literal text
 * and nobody would be notified at all.
 */
export function salesMessage({ item, url, mention }) {
  const title = escapeSlack((item && item.title) || 'An event');
  const when = escapeSlack((item && item.start_date) || '');
  const orders = n(item && item.orders);
  const revenue = n(item && item.net_revenue);
  const a = aov(orders, revenue);
  const net = netOfFee(revenue, item && item.event_fee);

  const head = (mention === false ? '' : '<!channel> ')
    + 'Sales report in for *' + title + '*' + (when ? ' (' + when + ')' : '') + '.';

  const lines = [
    'Orders: ' + orders.toLocaleString('en-US'),
    'Revenue: ' + money(revenue),
    'AOV: ' + (a == null ? '—' : money(a)),
  ];
  // Only when a fee was recorded. "Net of fee" equal to revenue would imply
  // the day was free, which is a different claim from not having been asked.
  if (net != null) lines.push('Net of fee: ' + money(net));

  const link = url ? '\n\n<' + url + '|Open it on the Jetty calendar>' : '';
  return head + '\n' + lines.map((l) => '• ' + l).join('\n') + link;
}

/**
 * Send it: the file with the numbers as its comment, or just the numbers.
 *
 * The sending itself is injected so the decision can be tested without a
 * Slack. That is not ceremony -- the branch that matters here is the one
 * where Slack REFUSES the upload, and it was wrong: the code fell back to
 * a plain post when there was no file to send and not when sending it
 * failed, so a missing files:write scope meant no message at all. The
 * comment beside it claimed otherwise, which is how it survived review.
 *
 * Returns { withFile, fileError }. A file that would not go is reported
 * rather than swallowed -- "posted, without the report" is a different
 * thing to have happened from "posted", and the person who pressed the
 * button is the one who can fix it.
 */
export async function deliver({ file, text, postFile, postText }) {
  if (file) {
    try {
      await postFile(file, text);
      return { withFile: true, fileError: '' };
    } catch (e) {
      // Fall through. The numbers are most of the value, and an attachment
      // that did not make it beats silence.
      const fileError = String((e && e.message) || e);
      await postText(text);
      return { withFile: false, fileError };
    }
  }
  await postText(text);
  return { withFile: false, fileError: '' };
}
