// Which payments a view is asking for.
//
// The Airtable base answered this with forty-odd saved views -- one per rep,
// one for the unallocated queue, one for CAD, one per year. Forty views is
// forty things that can be edited by accident and forty places a rule can
// disagree with itself, which is how "Sales Rep is empty" ended up being the
// only definition of the queue that existed.
//
// One filter bar instead, and this is what it means. Pure: every value is
// bound, never interpolated, so a retailer called O'Neill cannot end a
// statement early.

export const STATUSES = [
  // The old "Amy D. - New Payments to be Allocated": Sales Rep is empty.
  { key: 'needs', label: 'Needs a rep' },
  { key: 'allocated', label: 'Has a rep' },
  { key: 'unpaid', label: 'Allocated, not paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'Everything' },
];

export const STATUS_KEYS = STATUSES.map((s) => s.key);

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 80);
}

/** YYYY-MM. Anything else is no filter rather than a guessed one: a month
 *  that silently means "all of time" is better than one that silently means
 *  the wrong month. */
export function monthRange(v) {
  const m = text(v, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return null;
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? (y + 1) + '-01' : y + '-' + String(mo + 1).padStart(2, '0');
  return { from: m + '-01', to: next + '-01' };
}

export function cleanYear(v) {
  const y = Number(text(v, 4));
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : null;
}

/**
 * A WHERE clause and its binds.
 *
 * `status` is the only one with a default, and the default is the queue:
 * the screen is opened to do the allocating, and anything else is asked for.
 */
export function buildWhere(params) {
  const p = params || {};
  const where = [];
  const binds = [];

  const status = STATUS_KEYS.includes(text(p.status)) ? text(p.status) : 'needs';
  if (status === 'needs') where.push('rep_key IS NULL');
  if (status === 'allocated') where.push('rep_key IS NOT NULL');
  if (status === 'unpaid') where.push('rep_key IS NOT NULL AND paid = 0');
  if (status === 'paid') where.push('paid = 1');

  const rep = text(p.rep, 60);
  if (rep) { where.push('rep_key = ?'); binds.push(rep); }

  // A month and a year together would be two ways of saying the same thing,
  // so the month wins where both arrive.
  const month = monthRange(p.month);
  const year = cleanYear(p.year);
  if (month) {
    where.push('paid_on >= ? AND paid_on < ?');
    binds.push(month.from, month.to);
  } else if (year) {
    where.push('paid_on >= ? AND paid_on < ?');
    binds.push(year + '-01-01', (year + 1) + '-01-01');
  }

  const territory = text(p.territory, 60);
  if (territory) { where.push('territory = ?'); binds.push(territory); }

  const rep0 = text(p.line, 60);
  if (rep0) { where.push('jetty_line = ?'); binds.push(rep0); }

  if (p.cad === '1' || p.cad === 1 || p.cad === true) where.push('cad = 1');

  const q = text(p.q, 80);
  if (q) {
    where.push("(retailer LIKE ? ESCAPE '\\' OR invoice_no LIKE ? ESCAPE '\\' "
      + "OR customer LIKE ? ESCAPE '\\')");
    // LIKE wildcards typed in the search box would make "100%" match
    // everything and "_" match any character.
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    binds.push(like, like, like);
  }

  return {
    status,
    sql: where.length ? ' WHERE ' + where.join(' AND ') : '',
    binds,
    // Oldest first while allocating -- the one that has waited longest is the
    // one to do. Newest first once there is a rep on it, because then it is
    // a record being read rather than a job being worked.
    order: status === 'needs'
      ? ' ORDER BY paid_on ASC, rowid ASC'
      : ' ORDER BY paid_on DESC, rowid DESC',
  };
}

export function cleanLimit(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback || 200;
  return Math.min(Math.round(n), 500);
}
