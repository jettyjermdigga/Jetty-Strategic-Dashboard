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

import { PEOPLE as ON_STAFF, ROSTER_AS_OF } from './labor-seed.js';
import { LINES } from './budget.js';

export { ROSTER_AS_OF };

/**
 * Divisions that are not this company.
 *
 * The Jetty Rock Foundation is its own 501(c)(3): its own books, its own
 * payroll, its own board. Its people are in the Staff base because that is
 * where the whole org chart lives, and they belong there -- but budgeting
 * their wages against Jetty's Labor line would put another entity's costs
 * into this company's P&L.
 *
 * Done here rather than by cutting rows out of labor-seed.js, for two
 * reasons. The seed is a snapshot of the Staff base and quietly missing
 * people would make it untrue. And this is a rule about how the business
 * is structured, which is worth being able to read -- and to test -- in
 * one named place rather than inferring it from a list that is two people
 * shorter than it should be.
 */
export const SEPARATE_DIVISIONS = ['NONPROFIT'];

const ours = (p) => !SEPARATE_DIVISIONS.includes(String(p.v || '').toUpperCase());

/** The roster this plan covers: the Staff base, less the separate entities. */
export const PEOPLE = ON_STAFF.filter(ours);

/** Everybody the Staff base had, for anything that needs the whole org. */
export { ON_STAFF };

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

// The divisions a person on this plan can belong to.
//
// Taken from the roster rather than written out, so it cannot drift from
// the Staff base -- and with the separate entities left out, because
// offering one here would let somebody be labelled as belonging to a
// company this plan deliberately does not budget for. They would stay on
// the sheet and in every total while reading as though they were not.
export const DIVISIONS = [...new Set(PEOPLE.map((p) => p.v).filter(Boolean))]
  .filter((v) => !SEPARATE_DIVISIONS.includes(v)).sort();

// Full or part time. From the Staff base to begin with and editable here,
// because the plan is next year and somebody going part-time in March is a
// budget decision rather than a correction to the roster.
//
// The empty string is a real answer and stays available: an outsourced
// supplier or a contract firm is neither.
export const FT_TYPES = ['Full-time', 'Part-time'];

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
      k: p.k, n: p.n, t: p.t, type: p.type, tbh: p.tbh,
      added: false,
      // The roster is where these start, not where they are fixed. A
      // department moved or an hours change for next year is a decision
      // about the plan, and the plan is what this table holds -- the Staff
      // base is still right about today either way.
      d: (d && d.dept) || p.d,
      v: (d && d.division) || p.v,
      ft: d && d.ft != null && d.ft !== '' ? d.ft : p.ft,
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
      v: d.division || '', ft: d.ft || '', type: 'w2', tbh: true, added: true,
      pay: d.pay || '', cls: d.cls || '', rate: d.rate == null ? null : d.rate,
      salary: d.salary == null ? null : d.salary,
      hours: d.hours == null ? null : d.hours,
      note: d.note || '',
    });
  }

  return out;
}

/**
 * The same people with last year's figures alongside.
 *
 * Two rows in the labor table, one per year, joined on the person. Not two
 * sets of columns on one row: a year is a year, the second one is next
 * year's, and a sixth year would otherwise be six more columns on a table
 * that already has thirteen.
 *
 * The prior year keeps its OWN pay type. Somebody hourly in 2026 and
 * salaried in 2027 is an ordinary thing, and costing their 2026 against a
 * 2027 salary would be nonsense in the one column meant to be the fact.
 */
export function withPrior(rs, priorSaved) {
  const s = priorSaved || {};
  return (rs || []).map((r) => {
    const d = s[r.k] || null;
    const prior = {
      pay: (d && d.pay) || r.pay,
      rate: d && d.rate != null ? d.rate : null,
      salary: d && d.salary != null ? d.salary : null,
      hours: d && d.hours != null ? d.hours : null,
    };
    prior.cost = cost(prior);
    return { ...r, prior };
  });
}

/**
 * The ways of narrowing the sheet, and what each one asks.
 *
 * Here rather than on the page because two of them are arithmetic -- what
 * counts as decided is the same question cost() answers -- and a rule the
 * page re-implements is a rule that drifts.
 */
export const SHOWS = [
  { key: 'all', label: 'Everybody' },
  { key: 'todo', label: 'No plan-year total' },
  { key: 'base-todo', label: 'No baseline total' },
  { key: 'tbh', label: 'To be hired' },
  { key: 'payroll', label: 'Payroll only' },
  { key: 'unsplit', label: 'Not split yet' },
];

const isPayroll = (r) => {
  const t = payType(r.pay);
  return Boolean(t && t.roll === 'payroll');
};

/**
 * Whether one person survives the filter bar.
 *
 * Every field is AND: picking Brand and then Finance means Brand Finance,
 * not Brand or Finance. An empty field asks nothing, which is why an
 * untouched bar shows everybody.
 */
export function matches(row, f) {
  const r = row || {};
  const q = String((f && f.q) || '').trim().toLowerCase();
  if (q) {
    const hay = [r.n, r.t, r.d, r.v].map((x) => String(x || '').toLowerCase());
    if (!hay.some((x) => x.indexOf(q) >= 0)) return false;
  }
  if (f && f.division && String(r.v || '') !== f.division) return false;
  if (f && f.dept && String(r.d || '') !== f.dept) return false;
  if (f && f.pay && String(r.pay || '') !== f.pay) return false;
  // '-' means the ones nobody has split yet, which is a real answer and
  // not the same as asking nothing.
  if (f && f.cls) {
    const want = f.cls === '-' ? '' : f.cls;
    if (String(r.cls || '') !== want) return false;
  }
  const show = (f && f.show) || 'all';
  if (show === 'todo' && cost(r) != null) return false;
  if (show === 'base-todo' && r.prior && r.prior.cost != null) return false;
  if (show === 'tbh' && !r.tbh) return false;
  if (show === 'payroll' && !isPayroll(r)) return false;
  if (show === 'unsplit' && !(isPayroll(r) && !r.cls)) return false;
  return true;
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

  // Empty means "as the roster has it", which is why these are not
  // defaulted here: storing the seeded value as an override would make
  // every row look edited and freeze it against a later roster.
  const dept = text(input && input.dept, 60);
  const division = text(input && input.division, 20);
  const ft = text(input && input.ft, 20);
  if (ft && !FT_TYPES.includes(ft)) errors.push('No such kind of hours: ' + ft);
  // A write-in brings its own division and so may be anything; a person
  // the roster knows can only be moved between the divisions this plan
  // budgets for.
  if (division && !added && !DIVISIONS.includes(division)) {
    errors.push('No such division: ' + division);
  }

  if (errors.length) return { errors };
  return {
    row: {
      added,
      name: added ? name : '',
      title: added ? text(input && input.title, 80) : '',
      dept: added ? (dept || 'Unassigned') : dept,
      division, ft,
      pay, cls,
      rate: figures.rate, salary: figures.salary, hours: figures.hours,
      note: text(input && input.note, 300),
      // A seeded person with nothing on their line is simply undecided, and
      // the row goes rather than sitting there as a set of nulls. A write-in
      // always keeps its row: it IS the only record that the post exists.
      clear: !added && !pay && !cls && !dept && !division && !ft
        && figures.rate == null && figures.salary == null
        && figures.hours == null && !text(input && input.note, 300),
    },
  };
}

// ── Download ────────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function csv(rs, year, baseYear) {
  const label = (k) => (payType(k) || { label: '' }).label;
  // The baseline columns only when there is a baseline to put in them, so
  // a download of the plan alone is not six empty columns wide.
  const withBase = Boolean(baseYear) && rs.some((r) => r.prior);
  const head = ['Department', 'Name', 'Job title', 'Status', 'Division', 'Full/part time',
                'Paid', 'Direct or G&A'];
  if (withBase) {
    head.push(baseYear + ' rate ($/hr)', baseYear + ' hours', baseYear + ' salary',
              baseYear + ' total');
  }
  head.push(year + ' rate ($/hr)', year + ' hours', year + ' salary',
            year + ' projection', 'Rolls into', 'Note');
  const out = [head.map(cell).join(',')];
  const n = (v) => (v == null ? '' : v);
  for (const g of byDepartment(rs)) {
    for (const r of g.people) {
      const c = cost(r);
      const line = [
        g.dept, r.n, r.t, r.tbh ? 'To be hired' : 'Active', r.v, r.ft,
        label(r.pay), (classOf(r.cls) || { label: '' }).label,
      ];
      if (withBase) {
        const p = r.prior || {};
        line.push(n(p.rate), n(p.hours), n(p.salary),
                  p.cost == null ? '' : Math.round(p.cost));
      }
      line.push(n(r.rate), n(r.hours), n(r.salary),
                c == null ? '' : Math.round(c),
                (ROLLUPS.find((x) => x.key === rollOf(r)) || {}).label || '',
                r.note);
      out.push(line.map(cell).join(','));
    }
  }
  return out.join('\n') + '\n';
}
