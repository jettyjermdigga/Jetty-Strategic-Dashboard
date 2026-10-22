// What the budget builder decides, with no database and no network in it.
//
// Pure, and in its own file for the same reason clean.js is: store.js imports
// schema.sql through a wrangler rule and cannot be loaded in Node, so anything
// left in there is untestable. Every number the page shows is computed here.
//
// The shape of the thing: 2026 is the baseline and is READ ONLY (budget-seed.js,
// a committed snapshot). 2027 is a set of decisions -- a figure, a note, and a
// flag -- stored one row per line, and only for lines somebody has actually
// decided. A line with no decision shows the baseline, greyed, which is why
// "n of 77 set" is a real count rather than a guess.

import { LINES, BASELINE_YEAR } from './budget-seed.js';
import { periods, weekCounts } from './retail.js';

export { LINES, BASELINE_YEAR };

export const GROUPS = [
  { key: 'rev', label: 'Revenue' },
  { key: 'cogs', label: 'Cost of goods' },
  { key: 'opex', label: 'Operating expenses' },
];

// Which 2026 column a blank 2027 cell falls back to.
export const BASES = [
  { key: 'proj', label: '2026 projected' },
  { key: 'act', label: '2026 actual YTD' },
  { key: 'plan', label: '2026 plan' },
];

export const CADENCES = ['year', 'qtr', 'month', 'week'];

// The first year that can be budgeted here. 2026 is the baseline and is not
// editable; budgeting the year you are quoting against would be circular.
export const FIRST_YEAR = BASELINE_YEAR + 1;
export const LAST_YEAR = BASELINE_YEAR + 9;

// ── The seasonality curve ───────────────────────────────────────────────
//
// PLACEHOLDER, and labelled as one on the page. It is a plausible apparel
// year -- quiet January, a build through spring, a peak in late November --
// but it is not OUR year. The real one is 52 weeks of 2026 revenue, which
// the Strategic Dashboard has in the workbook and does not yet publish in
// facts.json.
//
// Until it does, this is the one number in here that is made up, so it is
// the one number that is isolated: swap this array and nothing else changes.
// Sums to 1, which spread() relies on -- a curve summing to 0.98 would quietly
// lose two percent of every line.
export const CURVE_IS_PLACEHOLDER = true;
export const WEEK_CURVE = [
  0.012680, 0.013187, 0.013863, 0.014370, 0.014877, 0.015216, 0.016061, 0.016906,
  0.017751, 0.018259, 0.018597, 0.018935, 0.018597, 0.018935, 0.019442, 0.019949,
  0.020287, 0.020626, 0.021133, 0.021640, 0.021978, 0.022316, 0.022823, 0.023331,
  0.022823, 0.021978, 0.021640, 0.021978, 0.022316, 0.021640, 0.020287, 0.019442,
  0.018597, 0.017751, 0.016906, 0.016568, 0.016061, 0.015554, 0.015216, 0.015554,
  0.016061, 0.016906, 0.017751, 0.018597, 0.020287, 0.022823, 0.025359, 0.027388,
  0.028741, 0.026205, 0.020287, 0.013525,
];

/** A year this builder will answer for, or 0. */
export function cleanYear(v) {
  const y = Math.trunc(Number(v));
  return Number.isFinite(y) && y >= FIRST_YEAR && y <= LAST_YEAR ? y : 0;
}

export const cleanCadence = (v) => (CADENCES.includes(String(v)) ? String(v) : 'year');
export const cleanBase = (v) => (BASES.some((b) => b.key === v) ? String(v) : 'proj');

/**
 * Every line, in seed order, carrying both the 2026 baseline and whatever
 * has been decided for the budget year.
 *
 * `amount` is null for a line nobody has touched. The page draws the
 * baseline in its place, greyed -- but it is NOT written into the row, so
 * "not decided" and "decided to match 2026" stay different facts.
 */
export function rows(saved) {
  const s = saved || {};
  return LINES.map((l) => {
    const d = s[l.k] || {};
    return {
      k: l.k, g: l.g, n: l.n,
      plan: l.plan, act: l.act, proj: l.proj,
      amount: d.amount == null ? null : Number(d.amount),
      note: d.note || '',
      flagged: Boolean(d.flagged),
      by: d.by || '', at: d.at || '',
    };
  });
}

/** What a line is worth in the budget year: the decision, or the baseline. */
export const value = (row, base) => (row.amount == null ? row[base] : row.amount);

/**
 * One line's annual figure spread across a cadence's periods.
 *
 * Weekly first, then summed by how many weeks each period holds -- which is
 * the whole reason the retail calendar is in here. Under 4-4-5 the March,
 * June, September and December periods are five weeks long, so an even
 * twelfth each would overstate the four-week months and understate the
 * five-week ones, every year, on every line.
 */
export function spread(total, cadence) {
  const weekly = WEEK_CURVE.map((c) => total * c);
  if (cadence === 'week') return weekly;
  const out = [];
  let i = 0;
  for (const n of weekCounts(cadence)) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += weekly[i + j];
    i += n;
    out.push(sum);
  }
  return out;
}

/** The P&L the footer shows, plus how far through the exercise we are. */
export function summary(rs, base) {
  const sum = (g) => rs.filter((r) => r.g === g)
    .reduce((a, r) => a + value(r, base), 0);
  const rev = sum('rev');
  const cogs = sum('cogs');
  const opex = sum('opex');
  return {
    rev, cogs, opex,
    gross: rev - cogs,
    // Guarded: a budget with every revenue line cleared to zero is a thing
    // somebody can do on the way to typing the real ones in, and NaN% in
    // the footer reads as the page being broken rather than the budget.
    grossPct: rev ? ((rev - cogs) / rev) * 100 : 0,
    net: rev - cogs - opex,
    set: rs.filter((r) => r.amount != null).length,
    flagged: rs.filter((r) => r.flagged).length,
    total: rs.length,
  };
}

/** The retail calendar for a year, every cadence, as the page needs it. */
export function calendar(year) {
  const out = {};
  for (const c of CADENCES) out[c] = periods(year, c);
  return out;
}

/**
 * What somebody typed into a line. Returns { row } or { errors }.
 *
 * Here rather than in store.js for the reason clean.js exists: store.js
 * imports schema.sql through a wrangler rule and cannot be loaded in Node,
 * so a rule left in there is a rule nothing ever checks.
 *
 * Two of these matter more than they look:
 *
 *   An amount of 0 is a DECISION -- "we are not spending on this next year"
 *   -- and must not fall back to the 2026 baseline. Anything written as
 *   `amount || baseline` gets that wrong and quietly budgets last year's
 *   figure for a line somebody deliberately zeroed.
 *
 *   An empty amount with no note and no flag is an UNDECIDED line, and the
 *   row is removed rather than stored as a null, so the progress count
 *   stays a count of real decisions.
 */
export function cleanLine(input) {
  const typed = input && input.amount != null ? String(input.amount) : '';
  const raw = typed.replace(/[,$\s]/g, '');
  if (raw !== '' && !/^-?\d+(\.\d+)?$/.test(raw)) {
    return { errors: ['"' + typed.slice(0, 30) + '" is not a number.'] };
  }
  const amount = raw === '' ? null : Number(raw);
  if (amount !== null && !Number.isFinite(amount)) {
    return { errors: ['That is not a number.'] };
  }
  const note = String((input && input.note) || '').trim().slice(0, 500);
  const flagged = input && input.flagged ? 1 : 0;
  return { row: { amount, note, flagged, clear: amount === null && !note && !flagged } };
}

// ── Download ────────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * The budget as a spreadsheet.
 *
 * Carries the baseline columns and the note as well as the figure, because
 * the figure on its own is the part somebody could have got from anywhere --
 * the note is why it is that number.
 */
export function csv(rs, base, cadence, year) {
  const ps = periods(year, cadence);
  const label = GROUPS.reduce((m, g) => ({ ...m, [g.key]: g.label }), {});
  const head = ['Group', 'Line', String(BASELINE_YEAR) + ' plan',
                String(BASELINE_YEAR) + ' actual', String(BASELINE_YEAR) + ' projected'];
  if (cadence === 'year') head.push(year + ' budget');
  else for (const p of ps) head.push(p.label + ' (' + p.start + '–' + p.end + ')');
  head.push(year + ' total', 'Decided', 'Flagged', 'Note');

  const lines = [head.map(cell).join(',')];
  for (const r of rs) {
    const v = value(r, base);
    const out = [label[r.g] || r.g, r.n, r.plan, r.act, r.proj];
    if (cadence === 'year') out.push(Math.round(v));
    else for (const n of spread(v, cadence)) out.push(Math.round(n));
    out.push(Math.round(v), r.amount == null ? 'baseline' : 'yes', r.flagged ? 'yes' : '', r.note);
    lines.push(out.map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}
