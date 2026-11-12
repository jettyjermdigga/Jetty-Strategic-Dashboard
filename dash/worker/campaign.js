// The Campaign Manager board: what is actually owed, and when.
//
// Reads the Campaign Tasks table of the Airtable base somebody is already
// keeping up to date. It does NOT read Campaign Overview's Launch/End
// dates, and that is deliberate: of 240 campaigns marked open there, only
// 79 carry a launch date at all, half of those are 2024 campaigns nobody
// ever closed, and at least one ends before it starts. The tasks are the
// part of that base that people actually maintain, so the tasks are what
// this draws.
//
// An ACTIVE task is one that is not ticked Complete, not flagged Hide From
// View, and has a Deadline. Everything here is about those.

/** Not a provider limit -- the blast radius of a bad filter. The live set
 *  is around a hundred; a run that suddenly wants a thousand is a bug. */
export const MAX_TASKS = 600;

/** How long a fetched board stays good. Deadlines move in days, not
 *  seconds, and this is a page people leave open. */
export const CACHE_MS = 5 * 60 * 1000;

const DAY = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD, or '' for anything that is not one. */
export function ymd(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function daysBetween(from, to) {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY);
}

/**
 * How a deadline stands relative to today.
 *
 * 'overdue' is kept rather than hidden. An open task whose date has passed
 * is the most urgent thing on the board, and a view of "what is coming"
 * that drops it is a view that hides the problem.
 */
export function dueState(deadline, today) {
  const d = ymd(deadline);
  const t = ymd(today);
  if (!d || !t) return 'none';
  const n = daysBetween(t, d);
  if (n == null) return 'none';
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  if (n <= 7) return 'week';
  return 'later';
}

/** One person off an Airtable collaborator cell. */
function person(c) {
  const email = String((c && c.email) || '').toLowerCase();
  const name = String((c && c.name) || '').trim();
  return { email, name: name || email || 'Unnamed' };
}

/** The first value of a lookup cell, which Airtable hands back as an array
 *  of whatever the looked-up field was. */
function firstName(v) {
  return names(v)[0] || '';
}

function names(v) {
  // Lookups nest: a lookup of a multipleSelects field comes back as an
  // array OF arrays, one per linked record. Flattened rather than read at
  // one level, because the one-level read silently produces '[object
  // Object]' and nobody notices until it is on screen.
  const flat = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const s = typeof x === 'string' ? x : String((x && x.name) || '');
    if (s.trim()) flat.push(s.trim());
  };
  walk(v);
  const out = [];
  for (const s of flat) if (out.indexOf(s) < 0) out.push(s);
  return out;
}

/**
 * An Airtable record as this board wants it.
 *
 * Returns null for anything that is not an active task, so one shape does
 * the filtering and the mapping and there is no second place for the two
 * to disagree about what "active" means.
 */
export function shape(rec, campaignNames) {
  const f = (rec && rec.fields) || {};
  if (f.Complete === true) return null;
  if (f['Hide From View'] === true) return null;
  const deadline = ymd(f.Deadline);
  if (!deadline) return null;

  const who = Array.isArray(f.Assignee) ? f.Assignee.map(person).filter((p) => p.email || p.name) : [];
  return {
    id: String((rec && rec.id) || ''),
    name: String(f['Task Name'] || '').trim() || 'Untitled task',
    deadline,
    assignees: who,
    // A linked-record cell comes back from the REST API as an array of
    // RECORD IDS, not names -- so this needs the campaigns fetched too.
    // Without the map it would read 'recx3PtJyw3prjmBO' on screen, which is
    // the sort of thing that looks like a styling bug rather than a
    // missing join.
    campaign: campaignName(f.Campaign, campaignNames),
    division: firstName(f['MKG Division']) || '',
    types: names(f['Task Type']),
    review: f['Out for Review'] === true,
    link: String(f['Asset Drive Link'] || '').trim(),
  };
}

/** A linked Campaign cell, resolved through the id -> name map. An id with
 *  no name left in the map is shown as unknown rather than as its id. */
export function campaignName(cell, map) {
  const ids = Array.isArray(cell) ? cell : (cell ? [cell] : []);
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw : String((raw && raw.id) || '');
    if (!id) continue;
    const got = map && (map instanceof Map ? map.get(id) : map[id]);
    if (got) return String(got).trim();
    // Some shapes hand back the name alongside the id; take it if it is
    // there rather than printing a record id at somebody.
    const inline = String((raw && raw.name) || '').trim();
    if (inline) return inline;
  }
  return '';
}

export function shapeAll(records, campaignNames) {
  const out = [];
  for (const r of records || []) {
    const t = shape(r, campaignNames);
    if (t) out.push(t);
    if (out.length >= MAX_TASKS) break;
  }
  out.sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
  return out;
}

/**
 * Everyone with active work, and what each of them owes.
 *
 * Tasks with nobody on them are NOT dropped. An unassigned deadline is
 * nobody's, which is worse than an overloaded person and is the thing this
 * view should surface rather than quietly leave out.
 */
export const NOBODY = '(unassigned)';

export function byPerson(tasks, today) {
  const by = new Map();
  const add = (key, label, task) => {
    if (!by.has(key)) by.set(key, { key, name: label, tasks: [], overdue: 0, week: 0 });
    const row = by.get(key);
    row.tasks.push(task);
    const st = dueState(task.deadline, today);
    if (st === 'overdue') row.overdue += 1;
    else if (st === 'today' || st === 'week') row.week += 1;
  };
  for (const t of tasks || []) {
    if (!t.assignees.length) { add(NOBODY, NOBODY, t); continue; }
    for (const p of t.assignees) add(p.email || p.name, p.name, t);
  }
  // Most overdue first, then most due this week, then most work. Whoever is
  // furthest behind is the one worth looking at.
  return [...by.values()].sort((a, b) => b.overdue - a.overdue
    || b.week - a.week || b.tasks.length - a.tasks.length
    || String(a.name).localeCompare(String(b.name)));
}

/**
 * The timeline: one bar per campaign, spanning the active work on it.
 *
 * The span is the first open deadline to the last. A campaign whose tasks
 * all share one date -- 31 December is used across this base as "sometime
 * this year" -- comes back with `point: true` rather than a bar of no
 * width, so it can be drawn as the marker it actually is.
 */
export function timeline(tasks, today) {
  const by = new Map();
  for (const t of tasks || []) {
    const key = t.campaign || NOBODY;
    if (!by.has(key)) {
      by.set(key, { key, name: key, division: t.division || '', from: t.deadline,
                    to: t.deadline, tasks: 0, overdue: 0 });
    }
    const row = by.get(key);
    if (t.deadline < row.from) row.from = t.deadline;
    if (t.deadline > row.to) row.to = t.deadline;
    if (!row.division && t.division) row.division = t.division;
    row.tasks += 1;
    if (dueState(t.deadline, today) === 'overdue') row.overdue += 1;
  }
  const out = [...by.values()].map((r) => ({ ...r, point: r.from === r.to,
                                             days: daysBetween(r.from, r.to) }));
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1
    : String(a.name).localeCompare(String(b.name))));
  return out;
}

/** The window the timeline has to cover, padded to whole weeks so the
 *  gridlines land on Mondays rather than wherever the data happens to start. */
export function span(rows, today) {
  const dates = [];
  for (const r of rows || []) { if (r.from) dates.push(r.from); if (r.to) dates.push(r.to); }
  const t = ymd(today);
  if (t) dates.push(t);
  if (!dates.length) return null;
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

/** The headline counts, worked out once so the page and any summary agree. */
export function totals(tasks, today) {
  const out = { tasks: 0, overdue: 0, today: 0, week: 0, unassigned: 0, campaigns: 0 };
  const camps = new Set();
  for (const t of tasks || []) {
    out.tasks += 1;
    if (!t.assignees.length) out.unassigned += 1;
    if (t.campaign) camps.add(t.campaign);
    const st = dueState(t.deadline, today);
    if (st === 'overdue') out.overdue += 1;
    else if (st === 'today') { out.today += 1; out.week += 1; }
    else if (st === 'week') out.week += 1;
  }
  out.campaigns = camps.size;
  return out;
}

// ── Fetching it ───────────────────────────────────────────────────────────
//
// Straight at the Airtable REST API. `get` is passed in rather than reaching
// for fetch, so every path through here is testable without a network and
// without a key -- the same shape the calendar's mail module uses, for the
// same reason.

export const BASE_ID = 'appcZk8czidqIxfhs';
export const TASKS_TABLE = 'tblKwqnHg2mpu4gfg';
export const CAMPAIGNS_TABLE = 'tbl1wcjWu4in0Pamk';

/** Whether this Worker can reach Airtable at all. */
export function canFetch(env) {
  return Boolean(env && env.AIRTABLE_API_KEY);
}

/** Why it cannot, in words for the page rather than a boolean. */
export function whyNotFetching(env) {
  if (canFetch(env)) return '';
  return 'The AIRTABLE_API_KEY secret is not set on this Worker, so the '
    + 'board cannot be read. Set it with: cd dash && npx wrangler secret put '
    + 'AIRTABLE_API_KEY';
}

/**
 * Only what is still owed, asked for at the source.
 *
 * Done as a formula rather than by pulling three thousand rows and throwing
 * most away: the live set is about a hundred, and the difference is the
 * whole request. shape() applies the same rule again on the way in, because
 * a filter at the far end of a network is not a guarantee.
 */
export const ACTIVE_FORMULA =
  "AND(NOT({Complete}), NOT({Hide From View}), {Deadline} != '')";

const FIELDS = ['Task Name', 'Deadline', 'Assignee', 'Campaign', 'MKG Division',
                'Task Type', 'Out for Review', 'Asset Drive Link'];

/** A simple one-value-per-key URL. The task fetch repeats `fields[]` and
 *  builds its own. */
function url(table, params) {
  const q = new URLSearchParams(params);
  return 'https://api.airtable.com/v0/' + BASE_ID + '/' + table + '?' + q.toString();
}

async function page(get, key, link) {
  const res = await get(link, { headers: { authorization: 'Bearer ' + key } });
  if (!res || !res.ok) {
    const status = (res && res.status) || 0;
    // 401/403 is a key problem and 404 is a base or table problem, and they
    // want different fixes -- so the page is told which rather than "it did
    // not work".
    const why = status === 401 || status === 403
      ? 'Airtable refused the key (' + status + '). Check AIRTABLE_API_KEY has '
        + 'read access to the Campaign Manager base.'
      : status === 404
        ? 'Airtable could not find the base or table (404).'
        : status === 429
          ? 'Airtable is rate-limiting this Worker (429). It will come back.'
          : 'Airtable answered ' + (status || 'nothing') + '.';
    throw new Error(why);
  }
  return await res.json();
}

/** Every campaign id mapped to its name, so a linked cell can be read. */
export async function fetchCampaignNames(key, get) {
  const out = {};
  let offset = '';
  for (let i = 0; i < 20; i++) {
    const params = { pageSize: '100', 'fields[]': 'Campaign Name (Year)' };
    if (offset) params.offset = offset;
    const body = await page(get, key, url(CAMPAIGNS_TABLE, params));
    for (const r of (body && body.records) || []) {
      const name = String((r.fields || {})['Campaign Name (Year)'] || '').trim();
      if (r.id && name) out[r.id] = name;
    }
    offset = (body && body.offset) || '';
    if (!offset) break;
  }
  return out;
}

/** The active tasks, already shaped. */
export async function fetchBoard(key, get, today) {
  const names = await fetchCampaignNames(key, get);
  const records = [];
  let offset = '';
  for (let i = 0; i < 10; i++) {
    // Built with append, not from an object: a repeated key in an object
    // keeps only the last value, which would ask Airtable for one field and
    // quietly return rows with nothing on them.
    const q = new URLSearchParams({ pageSize: '100', filterByFormula: ACTIVE_FORMULA });
    for (const f of FIELDS) q.append('fields[]', f);
    if (offset) q.append('offset', offset);
    const body = await page(get, key,
      'https://api.airtable.com/v0/' + BASE_ID + '/' + TASKS_TABLE + '?' + q.toString());
    for (const r of (body && body.records) || []) records.push(r);
    offset = (body && body.offset) || '';
    if (!offset || records.length >= MAX_TASKS) break;
  }
  const tasks = shapeAll(records, names);
  return {
    asOf: ymd(today) || '',
    tasks,
    people: byPerson(tasks, today),
    campaigns: timeline(tasks, today),
    totals: totals(tasks, today),
  };
}
