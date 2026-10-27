// Boxy Bucks: who turned up, and what they have earned for it.
//
// Two tables behind this, and the split matters. `attendance` is the record
// of who was at an event and in what capacity -- it is worth having on its
// own, and it happens to be where points are earned. `boxy_ledger` is
// everything else that moves a balance: merch taken, samples taken, a
// correction. Keeping them apart means deleting somebody off an event
// removes the points they earned for it and leaves what they have already
// spent alone, which is the behaviour anybody would expect and would be
// fiddly in one table.
//
// Pure, and in its own file, because index.js imports schema.sql through a
// wrangler rule and cannot be loaded in Node.

import { STAFF, ROSTER_AS_OF } from './boxy-seed.js';

export { STAFF, ROSTER_AS_OF };

/**
 * How somebody was involved, and what it is worth by default.
 *
 * Worked is a shift. Volunteered is turning up to something that was not
 * asked of you. Attended is being there.
 *
 * Worked and volunteered are both worth 2, deliberately. Working an event
 * is part of the job, so it is not worth more than volunteering for one --
 * but most of these events are nights and weekends, and that is the thing
 * being rewarded either way.
 *
 * These are a starting point. Every event can override them, because a
 * tent-sale weekend is not a two-hour thing and pretending otherwise is how
 * a reward scheme stops meaning anything.
 */
export const ROLES = [
  { key: 'worked', label: 'Worked', points: 2 },
  { key: 'volunteered', label: 'Volunteered', points: 2 },
  { key: 'attended', label: 'Attended', points: 1 },
];

export const ROLE_KEYS = ROLES.map((r) => r.key);
const role = (k) => ROLES.find((r) => r.key === k) || null;

/** What a role is worth, before any per-event override. */
export const defaultPoints = (k) => (role(k) || { points: 0 }).points;

/**
 * Read the defaults out of config, so they can be changed without a deploy
 * of the page. "worked:5,volunteered:3,attended:1". Anything missing or
 * unparseable keeps the built-in value rather than becoming zero -- a
 * typo in config should not silently stop an event being worth anything.
 */
export function pointsFromConfig(raw) {
  const out = {};
  for (const r of ROLES) out[r.key] = r.points;
  for (const bit of String(raw || '').split(',')) {
    const [k, v] = bit.split(':').map((x) => String(x || '').trim());
    if (!role(k)) continue;
    // Number('') is 0, and 0 is finite and not negative -- so "volunteered:"
    // with nothing after it used to set that role to zero, which is the exact
    // failure this function exists to avoid. An empty value is a typo, not a
    // deliberate nil; "worked:0" still means nothing, as it should.
    if (v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
  }
  return out;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export function cleanKey(s) {
  const k = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
  return KEY_RE.test(k) ? k : '';
}

const byKey = new Map(STAFF.map((p) => [p.k, p]));
export const staffMember = (k) => byKey.get(cleanKey(k)) || null;

/** Everybody, for the picker: name, who they are, and where. */
export function pickable() {
  return STAFF.map((p) => ({ ...p })).sort((a, b) => {
    const an = a.n.toLowerCase();
    const bn = b.n.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * What somebody typed when adding a person to an event.
 *
 * Points are optional: left blank the role's default applies, and the
 * default is recorded on the row rather than looked up later. An event
 * costed when the defaults said 3 should not silently become worth 5
 * because somebody changed the config a month afterwards.
 */
export function cleanEntry(input, defaults) {
  const errors = [];
  const key = cleanKey(input && input.person);
  if (!key || !staffMember(key)) errors.push('Pick somebody on the staff list.');

  const r = String((input && input.role) || '').trim();
  if (!role(r)) errors.push('Pick how they were involved.');

  let points = null;
  const raw = input && input.points != null ? String(input.points).trim() : '';
  if (raw !== '') {
    const n = Number(raw.replace(/[,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) errors.push('Points have to be a number, and not negative.');
    else if (n > 1000) errors.push('That is more Boxy Bucks than any one event is worth.');
    else points = Math.round(n);
  }

  if (errors.length) return { errors };
  const d = defaults || {};
  return {
    row: {
      person: key,
      role: r,
      points: points == null ? (d[r] == null ? defaultPoints(r) : d[r]) : points,
      note: String((input && input.note) || '').trim().slice(0, 200),
    },
  };
}

/**
 * One Boxy Buck is one free sample. So a balance is not an abstract score --
 * it is how many samples somebody may take, and a spend is a checkout: how
 * many, on what day, handed over by whom.
 */
export const SAMPLE_PER_POINT = 1;

/** Who may hand samples over, from config. Falls back to nobody, not to
 *  everybody: an empty list should stop a checkout being recorded against a
 *  name nobody can be held to, rather than let any name through. */
export function checkoutNames(raw) {
  return String(raw || '').split(',').map((x) => x.trim())
    .filter(Boolean).slice(0, 20);
}

export function cleanDate(v) {
  const d = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/**
 * A spend or a correction. Spends arrive positive and are stored negative.
 *
 * A spend now carries the day the samples were taken and who handed them
 * over, which between them explain the entry better than a free-text note
 * ever did -- so the note is no longer required, only offered.
 */
export function cleanLedger(input, checkout) {
  const errors = [];
  const key = cleanKey(input && input.person);
  if (!key || !staffMember(key)) errors.push('Pick somebody on the staff list.');

  const kind = String((input && input.kind) || '').trim();
  if (kind !== 'spend' && kind !== 'adjust') errors.push('That is not a kind of entry.');

  const n = Number(String((input && input.points) != null ? input.points : '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n === 0) {
    errors.push(kind === 'spend' ? 'How many samples?' : 'How many Boxy Bucks?');
  } else if (!Number.isInteger(n)) {
    errors.push('Samples come whole.');
  } else if (Math.abs(n) > 100000) {
    errors.push('That is not a plausible number.');
  }

  const names = checkoutNames(checkout);
  const by = String((input && input.checkedBy) || '').trim();
  // Only on a spend: a correction is bookkeeping, not a handover.
  if (kind === 'spend') {
    if (!by) errors.push('Who checked them out?');
    else if (!names.includes(by)) errors.push('"' + by.slice(0, 40) + '" is not on the checkout list.');
  }

  // Defaults to today, because that is the answer nearly every time -- but
  // it is a field rather than a stamp, so a checkout entered on Monday for
  // something taken on Saturday says Saturday.
  const on = kind === 'spend'
    ? (cleanDate(input && input.onDate) || new Date().toISOString().slice(0, 10))
    : '';
  if (kind === 'spend' && input && input.onDate && !cleanDate(input.onDate)) {
    errors.push('That is not a date.');
  }

  const note = String((input && input.note) || '').trim().slice(0, 200);

  if (errors.length) return { errors };
  return {
    row: {
      person: key,
      kind,
      // A spend is entered as a positive number and stored as a debit, so
      // nobody has to remember to type a minus sign. A correction is signed
      // however it was typed, because it can go either way.
      points: kind === 'spend' ? -Math.abs(Math.round(n)) : Math.round(n),
      note,
      onDate: on,
      checkedBy: kind === 'spend' ? by : '',
    },
  };
}

/**
 * The leaderboard.
 *
 * `earned` are attendance rows, `moved` are ledger rows. Everybody on the
 * roster appears, including people on nothing yet -- a leaderboard that
 * only lists the people already on it cannot be used to notice who is
 * being left out of events, which is half of what it is good for.
 */
export function leaderboard(earned, moved) {
  const rows = new Map(STAFF.map((p) => [p.k, {
    k: p.k, name: p.n, dept: p.d, division: p.v, loc: p.loc,
    earned: 0, spent: 0, balance: 0, events: 0,
    byRole: Object.fromEntries(ROLE_KEYS.map((r) => [r, 0])),
  }]));

  for (const e of earned || []) {
    const row = rows.get(e.person);
    if (!row) continue;                 // somebody who has left the roster
    const pts = Number(e.points) || 0;
    row.earned += pts;
    row.events++;
    if (row.byRole[e.role] != null) row.byRole[e.role]++;
  }

  for (const m of moved || []) {
    const row = rows.get(m.person);
    if (!row) continue;
    const pts = Number(m.points) || 0;
    // A correction upward is earned, not un-spent. Keeping the two columns
    // meaningful matters more than which bucket a negative adjustment lands
    // in, and "spent" reading higher than what they actually took would be
    // the confusing half.
    if (pts < 0) row.spent += -pts;
    else row.earned += pts;
  }

  const out = [...rows.values()];
  for (const r of out) r.balance = r.earned - r.spent;
  // Most earned first -- the leaderboard is about turning up, and a balance
  // ordering would put whoever has spent least on top.
  out.sort((a, b) => (b.earned - a.earned)
    || (b.events - a.events)
    || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  return out;
}

/** Totals for the strip above the table. */
export function standings(board) {
  const rows = board || [];
  return {
    people: rows.length,
    onTheBoard: rows.filter((r) => r.events > 0).length,
    earned: rows.reduce((a, r) => a + r.earned, 0),
    spent: rows.reduce((a, r) => a + r.spent, 0),
    outstanding: rows.reduce((a, r) => a + r.balance, 0),
  };
}

/**
 * One person's story: what they turned up to, and what has moved their
 * balance since.
 *
 * Both halves, because the question "why is this number 14" is not answered
 * by the events alone the moment anybody has spent anything.
 *
 * Events come back newest first. A leaderboard is about recent effort, and
 * scrolling to the bottom to find out what somebody did last month is the
 * wrong way round.
 */
export function personSummary(events, ledger) {
  const evs = (events || []).slice().sort((a, b) =>
    (String(b.start_date || '') < String(a.start_date || '') ? -1
      : String(b.start_date || '') > String(a.start_date || '') ? 1 : 0));

  const byRole = Object.fromEntries(ROLE_KEYS.map((r) => [r, { events: 0, points: 0 }]));
  let earned = 0;
  for (const e of evs) {
    const pts = Number(e.points) || 0;
    earned += pts;
    if (byRole[e.role]) { byRole[e.role].events++; byRole[e.role].points += pts; }
  }

  const moves = (ledger || []).slice().sort((a, b) =>
    (String(b.at || '') < String(a.at || '') ? -1
      : String(b.at || '') > String(a.at || '') ? 1 : 0));

  let spent = 0;
  for (const m of moves) {
    const pts = Number(m.points) || 0;
    // Same rule as the board: an upward correction is earned, not un-spent.
    if (pts < 0) spent += -pts;
    else earned += pts;
  }

  return { events: evs, ledger: moves, byRole, earned, spent, balance: earned - spent };
}

// ── Download ────────────────────────────────────────────────────────────

const cell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function csv(board) {
  const head = ['Name', 'Department', 'Division', 'Based', 'Events',
                ...ROLES.map((r) => r.label), 'Earned', 'Spent', 'Balance'];
  const lines = [head.map(cell).join(',')];
  for (const r of board || []) {
    lines.push([r.name, r.dept, r.division, r.loc, r.events,
                ...ROLE_KEYS.map((k) => r.byRole[k]),
                r.earned, r.spent, r.balance].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}
