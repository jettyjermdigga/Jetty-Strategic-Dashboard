// Labor planning: what next year's people cost, person by person.
//
// Pure, and in its own file for the reason clean.js and budget.js are:
// store.js imports schema.sql through a wrangler rule and cannot be loaded
// in Node, so a rule left in there is a rule nothing ever checks.
//
// The same shape as the budget tab. The ROSTER is a committed snapshot of
// who is here (labor-seed.js, org facts only -- no pay). The PLAN is a set
// of decisions typed into the page and kept in D1: how somebody is paid,
// the figure, and why. A person with no decision has no row, which is what
// makes "31 of 96 set" a real count.
//
// Three things it does NOT do:
//
//   It does not write back to Airtable. The Staff base stays the roster of
//   record; this is a plan for a year that has not happened.
//
//   It does not hold anybody's pay in the repo. See labor-seed.js.
//
//   It does not set the budget's Labor line. It shows what it adds up to
//   beside what the budget currently says, and leaves the two to a person.

import { PEOPLE, ROSTER_AS_OF } from './labor-seed.js';
import { LINES } from './budget.js';

export { PEOPLE, ROSTER_AS_OF };

// How somebody is paid, and therefore which figures their line asks for and
// which budget line their cost lands on.
//
// Payroll is salary + hourly, and that is the pair that answers the Labor
// line. Commissions and partner draws are real money and real people, but
// they are their own budget lines -- adding them into payroll would double
// count them the moment anybody compared the two.
export const PAY_TYPES = [
  { key: 'salary', label: 'Salary', asks: 'salary', roll: 'payroll' },
  { key: 'hourly', label: 'Hourly', asks: 'rate', roll: 'payroll' },
  { key: 'commission', label: 'Commission', asks: 'salary', roll: 'commission' },
  { key: 'guaranteed', label: 'Guaranteed payments', asks: 'salary', roll: 'guaranteed' },
  { key: 'contract', label: 'Contract', asks: 'salary', roll: 'other' },
  { key: 'unpaid', label: 'Unpaid', asks: 'none', roll: 'other' },
];

/**
 * Where a payroll person's cost belongs in the P&L.
 *
 * An accounting judgement, not a fact about the roster -- the same job
 * title can be direct in one company and G&A in another, and Airtable has
 * never recorded it. So it starts blank for everybody and is set here, by
 * department where that is the honest answer and person by person where it
 * is not.
 */
export const CLASSES = [
  { key: 'direct', label: 'Direct labor', roll: 'direct' },
  { key: 'gna', label: 'Salaries \u2014 G&A', roll: 'gna' },
];

export const ROLLUPS = [
  { key: 'direct', label: 'Direct labor', line: 'labor-total' },
  { key: 'gna', label: 'Salaries \u2014 G&A', line: 'salaries-g-a' },
  // Payroll that has not been split yet. It has no budget line, on purpose:
  // leaving it out of the totals would hide the work still to do, and
  // putting it in either half would be a guess with somebody's wages in it.
  { key: 'unclassified', label: 'Not yet split', line: '' },
  { key: 'commission', label: 'Commissions', line: 'sales-commissions-brand' },
  { key: 'guaranteed', label: 'Guaranteed payments', line: 'guaranteed-payments-partners' },
  { key: 'other', label: 'Other', line: '' },
];

// A full-time year at 40 hours. Offered as the placeholder on an hourly
// line and never stored, so the page can suggest it without it counting as
// a decision somebody made.
export const FULL_TIME_HOURS = 2080;

const payType = (k) => PAY_TYPES.find((p) => p.key === k) || null;
const classOf = (k) => CLASSES.find((c) => c.key === k) || null;

/**
 * Which total a person falls into.
 *
 * Takes the whole row rather than the pay type, because payroll is the one
 * bucket that splits again: salary and hourly both land in direct labor or
 * in G&A depending on what somebody decided about that person, and until
 * they decide, in neither.
 */
export function rollOf(row) {
  const r = typeof row === 'string' ? { pay: row } : (row || {});
  const t = payType(r.pay);
  if (!t) return 'other';
  if (t.roll !== 'payroll') return t.roll;
  const c = classOf(r.cls);
  return c ? c.roll : 'unclassified';
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export function cleanKey(s) {
  const k = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
  return KEY_RE.test(k) ? k : '';
}

const text = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

// A figure as somebody types one. Returns null for an empty cell, or
// undefined for something that is not a number at all -- which the caller
// turns into an error rather than storing as NaN.
export function num(v) {
  if (v == null) return null;
  const raw = String(v).replace(/[,$\s]/g, '');
  if (raw === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * What one person costs for the year, or null if it has not been decided.
 *
 * Hourly is rate x hours, and BOTH are needed: a rate with no hours is not
 * a cost, it is half of one. Showing 2,080 as a placeholder and then
 * quietly using it would put a number nobody chose into the total.
 */
export function cost(row) {
  const t = payType(row.pay);
  if (!t || t.asks === 'none') return null;
  if (t.asks === 'rate') {
    if (row.rate == null || row.hours == null) return null;
    return row.rate * row.hours;
  }
  return row.salary == null ? null : row.salary;
}

/** True once a person's line carries enough to cost them. */
export const decided = (row) => cost(row) != null;

/**
 * The roster plus the plan, in one list.
 *
 * Seeded people keep their name and title from the repo; a write-in brings
 * its own. Anybody struck off stays struck off -- the seed runs on every
 * boot and would otherwise put them back, which is the bug this codebase
 * has now had six times.
 */
export function rows(saved) {
  const s = saved || {};
  const out = [];

  for (const p of PEOPLE) {
    const d = s[p.k];
    if (d && d.removed) continue;
    out.push({
      k: p.k, n: p.n, t: p.t, d: p.d, v: p.v, ft: p.ft, type: p.type, tbh: p.tbh,
      added: false,
      pay: d && d.pay ? d.pay : p.pay,
      cls: (d && d.cls) || '',
      rate: d && d.rate != null ? d.rate : null,
      salary: d && d.salary != null ? d.salary : null,
      hours: d && d.hours != null ? d.hours : null,
      note: (d && d.note) || '',
    });
  }

  // Write-ins: a post somebody has added by hand. They sort to the end of
  // their department rather than into the alphabet, so a list you are
  // adding to does not reshuffle under the cursor.
  for (const k of Object.keys(s)) {
    const d = s[k];
    if (!d || !d.added || d.removed) continue;
    out.push({
      k, n: d.name || 'New post', t: d.title || '', d: d.dept || 'Unassigned',
      v: d.division || '', ft: '', type: 'w2', tbh: true, added: true,
      pay: d.pay || '', cls: d.cls || '', rate: d.rate == null ? null : d.rate,
      salary: d.salary == null ? null : d.salary,
      hours: d.hours == null ? null : d.hours,
      note: d.note || '',
    });
  }

  return out;
}

/** The sheet as the page draws it: departments, each with its people. */
export function byDepartment(rs) {
  const seen = new Map();
  for (const r of rs) {
    if (!seen.has(r.d)) seen.set(r.d, []);
    seen.get(r.d).push(r);
  }
  // Alphabetical, with Unassigned last -- the same rule the dash's category
  // row follows for Other.
  const names = [...seen.keys()].sort((a, b) => {
    const au = a.toLowerCase() === 'unassigned';
    const bu = b.toLowerCase() === 'unassigned';
    if (au !== bu) return au ? 1 : -1;
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  });
  return names.map((d) => ({
    dept: d,
    people: seen.get(d).slice().sort((a, b) => {
      // Write-ins after the people who are already here.
      if (a.added !== b.added) return a.added ? 1 : -1;
      return a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1;
    }),
    total: seen.get(d).reduce((acc, r) => acc + (cost(r) || 0), 0),
  }));
}

/** Heads and money, split the way the budget's lines are. */
export function summary(rs) {
  const roll = {};
  for (const r of ROLLUPS) roll[r.key] = { cost: 0, heads: 0 };
  let decidedCount = 0;
  let open = 0;

  for (const r of rs) {
    const bucket = roll[rollOf(r)];
    bucket.heads++;
    const c = cost(r);
    if (c != null) { bucket.cost += c; decidedCount++; }
    if (r.tbh) open++;
  }

  return {
    roll,
    heads: rs.length,
    open,
    set: decidedCount,
    total: rs.length,
    cost: ROLLUPS.reduce((a, r) => a + roll[r.key].cost, 0),
  };
}

/**
 * What the budget currently has for the lines this sheet rolls up into.
 *
 * Read only, and shown beside the plan rather than written into it. The two
 * are built by the same person for the same year and they should agree --
 * but which one is wrong on any given day is a judgement, not arithmetic.
 */
export function against(summaryOut, budgetSaved, base) {
  const saved = budgetSaved || {};
  return ROLLUPS.filter((r) => r.line).map((r) => {
    const seed = LINES.find((l) => l.k === r.line);
    const d = saved[r.line];
    const budget = d && d.amount != null ? d.amount
      : seed ? seed[base || 'proj'] : null;
    const plan = summaryOut.roll[r.key].cost;
    return {
      key: r.key, label: r.label, line: r.line,
      lineName: seed ? seed.n : r.line,
      budget, plan,
      gap: budget == null ? null : plan - budget,
      decided: Boolean(d && d.amount != null),
    };
  });
}

/**
 * What somebody typed into a person's line. Returns { row } or { errors }.
 *
 * A write-in needs a name; a seeded person cannot be renamed here, because
 * their name belongs to the Staff base and a second copy of it that drifts
 * is how the duplicated-roster problem started in the first place.
 */
export function cleanPerson(input, existing) {
  const errors = [];
  const added = Boolean(input && input.added) || Boolean(existing && existing.added);

  const pay = text(input && input.pay, 20);
  if (pay && !payType(pay)) errors.push('No such way of being paid: ' + pay);

  const cls = text(input && input.cls, 20);
  if (cls && !classOf(cls)) errors.push('No such kind of labor: ' + cls);

  const figures = {};
  for (const f of ['rate', 'salary', 'hours']) {
    const v = num(input ? input[f] : null);
    if (v === undefined) errors.push('"' + String(input[f]).slice(0, 20) + '" is not a number.');
    else figures[f] = v;
  }
  if (figures.hours != null && (figures.hours < 0 || figures.hours > 8760)) {
    errors.push('There are 8,760 hours in a year.');
  }

  const name = text(input && input.name, 80);
  if (added && !name) errors.push('A post needs a name, even if it is just the job.');

  if (errors.length) return { errors };
  return {
    row: {
      added,
      name: added ? name : '',
      title: added ? text(input && input.title, 80) : '',
      dept: added ? (text(input && input.dept, 60) || 'Unassigned') : '',
      division: added ? text(input && input.division, 20) : '',
      pay, cls,
      rate: figures.rate, salary: figures.salary, hours: figures.hours,
      note: text(input && input.note, 300),
      // A seeded person with nothing on their line is simply undecided, and
      // the row goes rather than sitting there as a set of nulls. A write-in
      // always keeps its row: it IS the only record that the post exists.
      clear: !added && !pay && !cls && figures.rate == null && figures.salary == null
        && figures.hours == null && !text(input && input.note, 300),
    },
  };
}

// ── Download ────────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function csv(rs, year) {
  const label = (k) => (payType(k) || { label: '' }).label;
  const head = ['Department', 'Name', 'Job title', 'Status', 'Division', 'Full/part time',
                'Paid', 'Direct or G&A', 'Rate ($/hr)', 'Salary (annual)',
                'Est. hours (annual)', year + ' projection', 'Rolls into', 'Note'];
  const out = [head.map(cell).join(',')];
  for (const g of byDepartment(rs)) {
    for (const r of g.people) {
      const c = cost(r);
      out.push([
        g.dept, r.n, r.t, r.tbh ? 'To be hired' : 'Active', r.v, r.ft,
        label(r.pay), (classOf(r.cls) || { label: '' }).label,
        r.rate == null ? '' : r.rate,
        r.salary == null ? '' : r.salary, r.hours == null ? '' : r.hours,
        c == null ? '' : Math.round(c),
        (ROLLUPS.find((x) => x.key === rollOf(r)) || {}).label || '',
        r.note,
      ].map(cell).join(','));
    }
  }
  return out.join('\n') + '\n';
}
