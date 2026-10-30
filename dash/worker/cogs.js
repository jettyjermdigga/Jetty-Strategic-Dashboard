// COGS planning: what a season's goods cost, season by season.
//
// Same rule as the budget and the labor plan above it -- only what
// somebody DECIDED is stored. There is no seeded figure anywhere in here
// and there is no import: every number on this sheet was typed into the
// page, which is why a blank is a blank and not a zero somebody might
// mistake for a decision.
//
// A row is a season and a kind of buy. Four seasons a year, three things
// that are not seasons but are bought like them, and each of those bought
// twice over: the bulk production run, and the salesman samples that go
// out ahead of it. Fourteen lines for 2027, and whatever prior seasons get
// added behind them.
//
// Pure, and in its own file, because index.js imports schema.sql through a
// wrangler rule and cannot be loaded in Node.

/**
 * The seasons this plans for.
 *
 * The four 2027 seasons, then the three that do not sit on the seasonal
 * calendar at all -- a collab lands when the partner is ready, a special
 * drop when somebody decides, Starboard runs to its own rhythm. They are
 * bought the same way and costed the same way, so they are seasons here
 * even though a merchandiser would not call them that.
 *
 * Prior seasons are not listed. They are added on the page when there is
 * something to put against them, which is what keeps this list the plan
 * rather than a calendar going back to 2019.
 */
export const SEASONS = [
  { key: 'sp27', label: 'SP27', note: 'Spring 2027' },
  { key: 'su27', label: 'SU27', note: 'Summer 2027' },
  { key: 'f27', label: 'F27', note: 'Fall 2027' },
  { key: 'h27', label: 'H27', note: 'Holiday 2027' },
  { key: 'collab', label: 'Collab', note: 'Lands when the partner is ready' },
  { key: 'special-drops', label: 'Special Drops', note: 'Off-calendar by design' },
  { key: 'starboard', label: 'Starboard', note: 'Runs to its own rhythm' },
];

/**
 * The two ways a season is bought.
 *
 * Bulk is the production run. SMS is the salesman samples that go out
 * ahead of it -- a real cost, months earlier, against the same season, and
 * the thing that gets forgotten when a season is costed as one number.
 * Keeping them apart is most of why this sheet exists.
 */
export const KINDS = [
  { key: 'bulk', label: 'Bulk', note: 'The production run' },
  { key: 'sms', label: 'SMS', note: 'Salesman samples, ahead of the bulk' },
];

/** The lines the sheet starts with: every season, bought both ways. */
export const SEED = SEASONS.flatMap(
  (s) => KINDS.map((k) => ({ season: s.key, kind: k.key })),
);

const seasonOf = (k) => SEASONS.find((s) => s.key === k) || null;
const kindOf = (k) => KINDS.find((x) => x.key === k) || null;

/** The id a line is stored under. Season and kind, so the sheet's own
 *  lines keep the same id whoever is looking and however often it boots. */
export const lineId = (season, kind) => String(season || '') + ':' + String(kind || '');

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/**
 * A season key as somebody types a new one.
 *
 * Prior seasons are added by hand -- SP26, F25 -- so this has to accept a
 * name nobody has seen before while refusing one that would collide with
 * the machinery: an empty key, or one with a colon in it, which is what
 * separates the two halves of a line id.
 */
export function cleanSeasonKey(s) {
  const k = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
  return KEY_RE.test(k) ? k : '';
}

const text = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

// A figure as somebody types one. Null for an empty cell, undefined for
// something that is not a number at all -- which the caller turns into an
// error rather than storing as NaN.
export function num(v) {
  if (v == null) return null;
  const raw = String(v).replace(/[,$\s]/g, '');
  if (raw === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The sheet: the seeded lines plus anything added, minus anything struck
 * off.
 *
 * A line struck off stays struck off. The seed runs on every boot and
 * would otherwise put it back, which is the bug this codebase has now had
 * six times.
 */
export function rows(saved) {
  const s = saved || {};
  const out = [];
  const seen = new Set();

  for (const line of SEED) {
    const id = lineId(line.season, line.kind);
    const d = s[id];
    if (d && d.removed) continue;
    seen.add(id);
    out.push({
      id,
      season: line.season,
      kind: line.kind,
      seasonLabel: (seasonOf(line.season) || {}).label || line.season,
      added: false,
      amount: d && d.amount != null ? d.amount : null,
      note: (d && d.note) || '',
    });
  }

  // Prior seasons, and anything else somebody put on the sheet by hand.
  for (const id of Object.keys(s)) {
    const d = s[id];
    if (!d || !d.added || d.removed || seen.has(id)) continue;
    out.push({
      id,
      season: d.season || '',
      kind: d.kind || '',
      seasonLabel: (seasonOf(d.season) || {}).label || d.seasonLabel || d.season || '',
      added: true,
      amount: d.amount == null ? null : d.amount,
      note: d.note || '',
    });
  }

  return out;
}

/**
 * Every season the sheet knows about, in the order it should be offered.
 *
 * The planned ones first, in calendar order, then whatever has been added
 * behind them -- so a dropdown opened to pick SP27 does not start in 2024.
 */
export function seasonOptions(rs) {
  const out = SEASONS.map((s) => ({ key: s.key, label: s.label, note: s.note }));
  const have = new Set(out.map((s) => s.key));
  for (const r of rs || []) {
    if (!r.season || have.has(r.season)) continue;
    have.add(r.season);
    out.push({ key: r.season, label: r.seasonLabel || r.season, note: 'Added here' });
  }
  return out;
}

/**
 * The totals under the sheet.
 *
 * By kind, because bulk against samples is the split the sheet is for, and
 * by season, because that is the line somebody actually argues about.
 * `decided` counts lines with a figure rather than lines that exist: a
 * season nobody has costed is not a season costing nothing.
 */
export function summary(rs) {
  const byKind = {};
  for (const k of KINDS) byKind[k.key] = { cost: 0, lines: 0, decided: 0 };
  const bySeason = {};
  let total = 0;
  let decided = 0;

  for (const r of rs || []) {
    const k = byKind[r.kind] || (byKind[r.kind] = { cost: 0, lines: 0, decided: 0 });
    k.lines += 1;
    if (!bySeason[r.season]) {
      bySeason[r.season] = { label: r.seasonLabel || r.season, cost: 0, decided: 0 };
    }
    const s = bySeason[r.season];
    if (r.amount != null) {
      k.cost += r.amount;
      k.decided += 1;
      s.cost += r.amount;
      s.decided += 1;
      total += r.amount;
      decided += 1;
    }
  }
  return { byKind, bySeason, total, decided, lines: (rs || []).length };
}

/**
 * Lines that say the same thing twice.
 *
 * A season bought bulk twice is either two real commitments or one typed
 * in twice, and the sheet cannot tell which. It can say so, which is the
 * difference between a total somebody trusts and one that is quietly
 * double counted.
 */
export function duplicates(rs) {
  const at = {};
  for (const r of rs || []) {
    const id = lineId(r.season, r.kind);
    (at[id] = at[id] || []).push(r);
  }
  return Object.keys(at).filter((k) => at[k].length > 1).map((k) => ({
    season: at[k][0].seasonLabel || at[k][0].season,
    kind: (kindOf(at[k][0].kind) || {}).label || at[k][0].kind,
    count: at[k].length,
  }));
}

/**
 * Whether one line survives the filter bar.
 *
 * Every field is AND, the same as the labor sheet: picking F27 and then
 * SMS means F27 samples, not everything in F27 plus every sample.
 */
export function matches(row, f) {
  const r = row || {};
  const q = String((f && f.q) || '').trim().toLowerCase();
  if (q) {
    const hay = [r.seasonLabel, r.season, r.kind, r.note]
      .map((x) => String(x || '').toLowerCase());
    if (!hay.some((x) => x.indexOf(q) >= 0)) return false;
  }
  if (f && f.season && String(r.season || '') !== f.season) return false;
  if (f && f.kind && String(r.kind || '') !== f.kind) return false;
  const show = (f && f.show) || 'all';
  if (show === 'todo' && r.amount != null) return false;
  if (show === 'costed' && r.amount == null) return false;
  return true;
}

export const SHOWS = [
  { key: 'all', label: 'Every line' },
  { key: 'todo', label: 'Not costed yet' },
  { key: 'costed', label: 'Costed' },
];

/**
 * One line, cleaned.
 *
 * A seeded line with nothing on it is simply undecided, and the row goes
 * rather than sitting there as a set of nulls. An added line always keeps
 * its row: it IS the only record that the season exists on this sheet.
 */
export function cleanLine(input, existing) {
  const errors = [];
  const added = Boolean(input && input.added) || Boolean(existing && existing.added);

  const season = cleanSeasonKey(input && input.season);
  if (!season) errors.push('Pick a season.');
  // A season nobody has heard of is fine on an added line -- that is how a
  // prior season gets here -- and wrong on a seeded one, where it would
  // mean the line had been pointed at something that does not exist.
  if (season && !added && !seasonOf(season)) {
    errors.push('No such season: ' + season);
  }

  const kind = text(input && input.kind, 20);
  if (!kind) errors.push('Bulk or SMS?');
  else if (!kindOf(kind)) errors.push('No such kind of buy: ' + kind);

  const amount = num(input ? input.amount : null);
  if (amount === undefined) {
    errors.push('"' + String(input.amount).slice(0, 20) + '" is not a number.');
  } else if (amount != null && amount < 0) {
    errors.push('A cost cannot be negative.');
  }

  // Only on an added line, and only to show in a dropdown: a season's own
  // list entry is what names it everywhere else.
  const seasonLabel = text(input && input.seasonLabel, 40);

  if (errors.length) return { errors };
  return {
    row: {
      added,
      season,
      kind,
      seasonLabel: added ? (seasonLabel || season.toUpperCase()) : '',
      amount,
      note: text(input && input.note, 300),
      clear: !added && amount == null && !text(input && input.note, 300),
    },
  };
}

// ── Download ────────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function csv(rs) {
  const head = ['Season', 'Bulk or SMS', 'Total COGS', 'Note'];
  const out = [head.map(cell).join(',')];
  for (const r of rs || []) {
    out.push([
      r.seasonLabel || r.season,
      (kindOf(r.kind) || { label: '' }).label,
      r.amount == null ? '' : r.amount,
      r.note,
    ].map(cell).join(','));
  }
  return out.join('\n') + '\n';
}
