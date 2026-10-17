// Reading and writing the dash's four lists.
//
// The catalogue used to be tiles.js and the roster used to be people.js. Both
// are still there, and are still the only place the defaults are written down
// -- but they are now a seed rather than the live answer. The database is the
// live answer, because somebody who is not editing the repo has to be able to
// change it.
//
// Nothing here trusts what it is handed. Every write goes through the same
// cleaning the seed went through, so a row keyed in by hand cannot be shaped
// differently from a row that came from the file.

import schema from './schema.sql';
import { sqlStatements } from './sql.js';
import { TILES, CATEGORIES, GROUPS, EVERYONE, CAT_MOVES, GROUP_MOVES } from './tiles.js';
import { cleanKey, cleanUrl, cleanTile, cleanPerson } from './clean.js';
import { PEOPLE } from './people.js';

// Re-exported so callers have one import for "the store", while the rules
// themselves stay in a file Node can load.
export { cleanKey, cleanUrl, cleanTile, cleanPerson };

const SEED_KEY = 'seeded-from-repo-2026-10';
const CATS_KEY = 'categories-by-department-2026-10';
const MERGE_KEY = 'groups-merged-into-departments-2026-10';

let ready = false;

// Columns added after the first deploy. CREATE TABLE IF NOT EXISTS does not
// revisit a table that already exists, so a new column has to be added by
// hand -- and the "duplicate column" error is the expected answer on every
// run after the first.
const ADDED_COLUMNS = [
  ['categories', 'icon TEXT NOT NULL DEFAULT \'link\''],
];

export async function ensureSchema(db) {
  if (ready) return;
  for (const stmt of sqlStatements(schema)) await db.prepare(stmt).run();
  for (const [table, col] of ADDED_COLUMNS) {
    try {
      await db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + col).run();
    } catch (err) {
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  await seed(db);
  await syncCategories(db);
  await mergeGroups(db);
  ready = true;
}

// One-time: who-can-see-it used to be its own list of names -- financials,
// retail, ambassadors -- separate from the departments a tile sat under. Two
// lists with overlapping names is one too many, and the dash is not a lock
// anyway: each tool decides who actually gets in. So there is one list now,
// and this moves everybody and every tile onto it.
//
// Everyone also picks up 'general', which is the section every member of
// staff belongs to. It changes nothing they can see -- the tools open to
// everyone already are -- but it makes the Setup page read honestly.
async function mergeGroups(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(MERGE_KEY).first();
  if (done) return;

  const live = new Set(GROUPS.map((g) => g.key));
  const remap = (csv, addGeneral) => {
    const out = [];
    for (const raw of String(csv || '').split(',').map((x) => x.trim().toLowerCase())) {
      if (!raw) continue;
      const moved = GROUP_MOVES[raw] || raw;
      // EVERYONE is not a department and must survive the move untouched.
      if (moved !== EVERYONE && !live.has(moved)) continue;
      if (!out.includes(moved)) out.push(moved);
    }
    if (addGeneral && !out.includes('general')) out.unshift('general');
    return out.join(',');
  };

  const batch = [];
  const people = await db.prepare('SELECT email, groups FROM people').all();
  const pStmt = db.prepare('UPDATE people SET groups = ? WHERE email = ?');
  for (const r of people.results || []) batch.push(pStmt.bind(remap(r.groups, true), r.email));

  const tiles = await db.prepare('SELECT tile_key, groups FROM tiles').all();
  const tStmt = db.prepare('UPDATE tiles SET groups = ? WHERE tile_key = ?');
  for (const r of tiles.results || []) batch.push(tStmt.bind(remap(r.groups, false), r.tile_key));

  if (batch.length) await db.batch(batch);
  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(MERGE_KEY, String(batch.length), new Date().toISOString()).run();
}

// One-time: the first categories were shapes of work -- Company, Finance,
// Sales, Community. They are now the parts of the business, matching the
// calendar's departments, so there is one vocabulary across both tools.
// Where each old one went is CAT_MOVES, in tiles.js.
//
// The seed only ever runs once, so changing the list in tiles.js would have
// left the live rows alone. This is what moves them. Guarded by meta, like
// the calendar's migrations, so it runs once and never again -- a category
// somebody later renames or deletes stays renamed or deleted.

async function syncCategories(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(CATS_KEY).first();
  if (done) return;

  const batch = [];
  const put = db.prepare(
    'INSERT INTO categories (cat_key, label, icon, sort) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(cat_key) DO UPDATE SET label = excluded.label, '
    + 'icon = excluded.icon, sort = excluded.sort');
  CATEGORIES.forEach((c, i) => batch.push(put.bind(c.key, c.label, c.icon || 'link', i)));

  // Tiles move before the old categories go, so none is left pointing at a
  // heading that no longer exists -- which would drop it off the page while
  // still counting it.
  const move = db.prepare('UPDATE tiles SET category = ? WHERE category = ?');
  for (const [from, to] of Object.entries(CAT_MOVES)) batch.push(move.bind(to, from));

  const keep = CATEGORIES.map((c) => c.key);
  const old = await db.prepare('SELECT cat_key FROM categories').all();
  const drop = db.prepare('DELETE FROM categories WHERE cat_key = ?');
  for (const r of old.results || []) {
    if (!keep.includes(r.cat_key)) batch.push(drop.bind(r.cat_key));
  }

  await db.batch(batch);
  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(CATS_KEY, String(CATEGORIES.length), new Date().toISOString()).run();
}

// The files become the first rows, once. Guarded by meta rather than by "is
// the table empty", because an account that deliberately deletes every tile
// should stay deleted rather than having the defaults walk back in.
async function seed(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(SEED_KEY).first();
  if (done) return;

  const now = new Date().toISOString();
  const batch = [];

  const cat = db.prepare(
    'INSERT OR IGNORE INTO categories (cat_key, label, icon, sort) VALUES (?, ?, ?, ?)');
  CATEGORIES.forEach((c, i) => batch.push(cat.bind(c.key, c.label, c.icon || 'link', i)));

  const grp = db.prepare(
    'INSERT OR IGNORE INTO groups (group_key, label, note, sort) VALUES (?, ?, ?, ?)');
  GROUPS.forEach((g, i) => batch.push(grp.bind(g.key, g.label, g.note || '', i)));

  const tile = db.prepare(
    'INSERT OR IGNORE INTO tiles (tile_key, name, blurb, url, icon, category, groups, '
    + 'status, sort, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  TILES.forEach((t, i) => batch.push(tile.bind(
    t.key, t.name, t.blurb, t.url || '', t.icon || 'link', t.category,
    (t.groups || []).join(','), t.status, i, now, 'seed')));

  const per = db.prepare(
    'INSERT OR IGNORE INTO people (email, name, groups, updated_at, updated_by) '
    + 'VALUES (?, ?, ?, ?, ?)');
  for (const email of Object.keys(PEOPLE)) {
    per.bind; // keep the shape obvious
    batch.push(per.bind(email.toLowerCase(), '', (PEOPLE[email] || []).join(','), now, 'seed'));
  }

  const BATCH = 100;
  for (let i = 0; i < batch.length; i += BATCH) await db.batch(batch.slice(i, i + BATCH));

  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(SEED_KEY, String(batch.length), now).run();
}

// ── reading ────────────────────────────────────────────────────────────────

const splitList = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export async function readCatalogue(db) {
  const [tiles, cats, grps] = await Promise.all([
    db.prepare('SELECT * FROM tiles ORDER BY sort, name').all(),
    db.prepare('SELECT * FROM categories ORDER BY sort, label').all(),
    db.prepare('SELECT * FROM groups ORDER BY sort, label').all(),
  ]);
  return {
    tiles: (tiles.results || []).map((r) => ({
      key: r.tile_key, name: r.name, blurb: r.blurb, url: r.url, icon: r.icon,
      category: r.category, groups: splitList(r.groups), status: r.status, sort: r.sort,
    })),
    categories: (cats.results || []).map((r) => ({
      key: r.cat_key, label: r.label, icon: r.icon || 'link', sort: r.sort,
    })),
    groups: (grps.results || []).map((r) => ({
      key: r.group_key, label: r.label, note: r.note, sort: r.sort,
    })),
  };
}

// Returns the groups for a verified address, or [] for somebody nobody has
// placed yet -- which is different from the null the caller uses for "we could
// not establish who this is at all".
export async function groupsFor(db, email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const row = await db.prepare('SELECT groups FROM people WHERE email = ?').bind(key).first();
  if (!row) return [];
  return splitList(row.groups);
}

export async function readPeople(db) {
  const res = await db.prepare('SELECT * FROM people ORDER BY email').all();
  return (res.results || []).map((r) => ({
    email: r.email, name: r.name, groups: splitList(r.groups),
    updated_at: r.updated_at, updated_by: r.updated_by,
  }));
}

// ── writing ────────────────────────────────────────────────────────────────

export async function saveTile(db, row, who) {
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO tiles (tile_key, name, blurb, url, icon, category, groups, status, sort, '
    + 'updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(tile_key) DO UPDATE SET name = excluded.name, blurb = excluded.blurb, '
    + 'url = excluded.url, icon = excluded.icon, category = excluded.category, '
    + 'groups = excluded.groups, status = excluded.status, sort = excluded.sort, '
    + 'updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(row.key, row.name, row.blurb, row.url, row.icon, row.category, row.groups,
          row.status, row.sort, now, who).run();
}

export async function deleteTile(db, key) {
  await db.prepare('DELETE FROM tiles WHERE tile_key = ?').bind(cleanKey(key)).run();
}

export async function savePerson(db, row, who) {
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO people (email, name, groups, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(email) DO UPDATE SET name = excluded.name, groups = excluded.groups, '
    + 'updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(row.email, row.name, row.groups, now, who).run();
}

export async function deletePerson(db, email) {
  await db.prepare('DELETE FROM people WHERE email = ?')
    .bind(String(email || '').trim().toLowerCase()).run();
}

export async function saveCategory(db, input) {
  const key = cleanKey(input && input.key) || cleanKey(input && input.label);
  const label = String(input && input.label || '').trim().slice(0, 60);
  if (!key || !label) return { errors: ['A category needs a name.'] };
  const icon = cleanKey(input && input.icon) || 'link';
  const sort = Number.isFinite(Number(input && input.sort)) ? Number(input.sort) : 0;
  await db.prepare(
    'INSERT INTO categories (cat_key, label, icon, sort) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(cat_key) DO UPDATE SET label = excluded.label, '
    + 'icon = excluded.icon, sort = excluded.sort')
    .bind(key, label, icon, sort).run();
  return { ok: true };
}

export async function saveGroup(db, input) {
  const key = cleanKey(input && input.key);
  const label = text(input && input.label, 60);
  if (!key || !label) return { errors: ['A group needs a key and a label.'] };
  if (key === EVERYONE) return { errors: ['"everyone" is reserved: it means anybody Access let in.'] };
  await db.prepare(
    'INSERT INTO groups (group_key, label, note, sort) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(group_key) DO UPDATE SET label = excluded.label, note = excluded.note, '
    + 'sort = excluded.sort')
    .bind(key, label, text(input && input.note, 200), Number(input.sort) || 0).run();
  return { ok: true };
}

// Deleting a group would otherwise leave its key on tiles and people, where it
// would quietly match nothing forever. Taken off both in the same breath.
export async function deleteGroup(db, key) {
  const k = cleanKey(key);
  if (!k) return;
  const strip = (val) => splitList(val).filter((g) => g !== k).join(',');

  const tiles = await db.prepare('SELECT tile_key, groups FROM tiles WHERE groups LIKE ?')
    .bind('%' + k + '%').all();
  const people = await db.prepare('SELECT email, groups FROM people WHERE groups LIKE ?')
    .bind('%' + k + '%').all();

  const batch = [db.prepare('DELETE FROM groups WHERE group_key = ?').bind(k)];
  const tStmt = db.prepare('UPDATE tiles SET groups = ? WHERE tile_key = ?');
  for (const r of tiles.results || []) batch.push(tStmt.bind(strip(r.groups), r.tile_key));
  const pStmt = db.prepare('UPDATE people SET groups = ? WHERE email = ?');
  for (const r of people.results || []) batch.push(pStmt.bind(strip(r.groups), r.email));

  await db.batch(batch);
}
