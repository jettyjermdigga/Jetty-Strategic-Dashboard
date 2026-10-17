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
import { TILES, HUBS, CATEGORIES, GROUPS, EVERYONE, CAT_MOVES, GROUP_MOVES, linkCats } from './tiles.js';
import { cleanKey, cleanUrl, cleanTile, cleanPerson, cleanLink } from './clean.js';
import { PEOPLE } from './people.js';

// Re-exported so callers have one import for "the store", while the rules
// themselves stay in a file Node can load.
export { cleanKey, cleanUrl, cleanTile, cleanPerson, cleanLink };
export { linkSections } from './tiles.js';

const SEED_KEY = 'seeded-from-repo-2026-10';
const CATS_KEY = 'categories-by-department-2026-10';
const MERGE_KEY = 'groups-merged-into-departments-2026-10';
const ASSIGN_KEY = 'tiles-assigned-to-people-2026-10';
const LABEL_KEY = 'category-labels-2026-10b';
const HUBS_KEY = 'airtable-hubs-2026-10';
// Bumped when a category gains an icon, so backfillIcons runs again. It
// only ever touches rows still holding the default, so re-running is safe.
const ICONS_KEY = 'category-icons-2026-10b';

let ready = false;

// Columns added after the first deploy. CREATE TABLE IF NOT EXISTS does not
// revisit a table that already exists, so a new column has to be added by
// hand -- and the "duplicate column" error is the expected answer on every
// run after the first.
const ADDED_COLUMNS = [
  ['categories', 'icon TEXT NOT NULL DEFAULT \'link\''],
  ['tiles', 'everyone INTEGER NOT NULL DEFAULT 0'],
  ['people', 'tiles TEXT NOT NULL DEFAULT \'\''],
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
  await assignTiles(db);
  await renameCategories(db);
  await seedHubs(db);
  await backfillIcons(db);
  ready = true;
}

// Give every category the icon its seed always said it had.
//
// A bug worth writing down, because it is the third of its shape. The
// categories table was created without an icon column; the column was added
// later through ADDED_COLUMNS as `icon TEXT NOT NULL DEFAULT 'link'`. That
// ALTER gave every existing row the default. syncCategories, which does know
// the right icons, had already run and set its guard -- and a guarded
// migration never revisits. So every category in a database older than that
// column has been drawing the generic chain link ever since, and the only
// place it looked correct was the screenshot fixture, which reads CATEGORIES
// out of the repo rather than the database.
//
// The lesson, now stated three times in this file: adding a column with a
// DEFAULT does not backfill it, and the guarded sync that knows the real
// value will not run again to help.
//
// Only rows still holding the default are touched. 'link' is a legitimate
// choice somebody might pick in Setup, but nobody has picked it yet, and a
// migration that overwrites a deliberate edit is worse than one that does
// nothing.
async function backfillIcons(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(ICONS_KEY).first();
  if (done) return;

  const put = db.prepare(
    "UPDATE categories SET icon = ? WHERE cat_key = ? AND (icon = 'link' OR icon = '')");
  const batch = CATEGORIES
    .filter((c) => c.icon && c.icon !== 'link')
    .map((c) => put.bind(c.icon, c.key));
  if (batch.length) await db.batch(batch);

  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(ICONS_KEY, String(batch.length), new Date().toISOString()).run();
}

// The hubs that already exist in Airtable, added as tiles.
//
// INSERT OR IGNORE, so a hub somebody has already created by hand keeps their
// wording and this adds only what is missing. Run once and never again.
//
// The two placeholders the repo shipped with -- Wholesale Hub and Ambassador
// Hub, both with no address -- are retired here, because the real thing now
// exists under its own key. They go only if they are STILL empty: an address
// typed into one since means somebody built it, and that wins.
//
// Retiring a tile means taking its key off everybody who holds it, in the
// same breath. A key left behind in a person's row matches no tile, and
// cleanPerson refuses to save a row that names one -- so leaving it would
// quietly break the People tab for whoever had it. That is the same bug the
// groups merge shipped once already.
const RETIRED = ['wholesale', 'ambassadors'];

async function seedHubs(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(HUBS_KEY).first();
  if (done) return;

  const now = new Date().toISOString();
  const batch = [];

  const tile = db.prepare(
    'INSERT OR IGNORE INTO tiles (tile_key, name, blurb, url, icon, category, everyone, '
    + 'status, sort, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  HUBS.forEach((t, i) => batch.push(tile.bind(
    t.key, t.name, t.blurb, t.url, t.icon, t.category, 0, t.status, 100 + i, now, 'hubs')));

  const drop = db.prepare("DELETE FROM tiles WHERE tile_key = ? AND url = ''");
  for (const k of RETIRED) batch.push(drop.bind(k));

  if (batch.length) await db.batch(batch);

  // Only the ones that actually went. A placeholder somebody filled in is
  // still a live tile and must stay on the people holding it.
  const left = await db.prepare('SELECT tile_key FROM tiles').all();
  const live = new Set((left.results || []).map((r) => r.tile_key));
  const gone = RETIRED.filter((k) => !live.has(k));
  if (gone.length) {
    const rows = await db.prepare('SELECT email, tiles FROM people').all();
    const fix = db.prepare('UPDATE people SET tiles = ? WHERE email = ?');
    const edits = [];
    for (const r of rows.results || []) {
      const had = String(r.tiles || '').split(',').map((x) => x.trim()).filter(Boolean);
      const keep = had.filter((k) => !gone.includes(k));
      if (keep.length !== had.length) edits.push(fix.bind(keep.join(','), r.email));
    }
    if (edits.length) await db.batch(edits);
  }

  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(HUBS_KEY, String(HUBS.length), now).run();
}

// Renaming a category after it has been seeded.
//
// syncCategories is guarded and has already run, so changing the label in
// tiles.js alone never reaches a database that exists. This is the narrow
// version: rename this one key, and only if it still holds the exact old
// label. Somebody who has already renamed it by hand in Setup keeps their
// wording -- a migration that overwrites a deliberate edit is worse than one
// that does nothing.
const LABEL_FIXES = [
  ['general', 'General / Staff / Culture', 'General'],
];

async function renameCategories(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(LABEL_KEY).first();
  if (done) return;

  const put = db.prepare('UPDATE categories SET label = ? WHERE cat_key = ? AND label = ?');
  const batch = LABEL_FIXES.map(([key, from, to]) => put.bind(to, key, from));
  if (batch.length) await db.batch(batch);

  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(LABEL_KEY, String(batch.length), new Date().toISOString()).run();
}

// One-time: who sees what used to be a department somebody was in. It is now
// the tiles they have been given, which is one hop instead of two -- and it
// means a section appears on a dash because there is something in it, rather
// than because somebody was filed under its name.
//
// Nobody loses anything in the move: each person is given every tile that was
// in a department they were in, so their dash looks the same the morning
// after as it did the night before.
//
// Tiles in the General section become open-to-everyone, which is what that
// section already meant and what keeps the Company Calendar from having to be
// ticked onto twenty people one at a time.
async function assignTiles(db) {
  const done = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(ASSIGN_KEY).first();
  if (done) return;

  const tiles = await db.prepare('SELECT tile_key, category FROM tiles').all();
  const rows = tiles.results || [];
  const byCat = new Map();
  for (const t of rows) {
    const c = String(t.category || '').toLowerCase();
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(t.tile_key);
  }

  const batch = [];
  const everyone = db.prepare('UPDATE tiles SET everyone = 1 WHERE category = ?');
  batch.push(everyone.bind('general'));

  const people = await db.prepare('SELECT email, groups, tiles FROM people').all();
  const pStmt = db.prepare('UPDATE people SET tiles = ? WHERE email = ?');
  for (const r of people.results || []) {
    // Anything already assigned wins; this only fills in from the old shape.
    if (String(r.tiles || '').trim()) continue;
    const mine = [];
    for (const g of String(r.groups || '').split(',').map((x) => x.trim().toLowerCase())) {
      for (const key of byCat.get(g) || []) if (!mine.includes(key)) mine.push(key);
    }
    batch.push(pStmt.bind(mine.join(','), r.email));
  }

  if (batch.length) await db.batch(batch);
  await db.prepare('INSERT OR REPLACE INTO meta (key, value, applied_at) VALUES (?, ?, ?)')
    .bind(ASSIGN_KEY, String(batch.length), new Date().toISOString()).run();
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
    'INSERT OR IGNORE INTO tiles (tile_key, name, blurb, url, icon, category, everyone, '
    + 'status, sort, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  TILES.forEach((t, i) => batch.push(tile.bind(
    t.key, t.name, t.blurb, t.url || '', t.icon || 'link', t.category,
    t.everyone ? 1 : 0, t.status, i, now, 'seed')));

  // The seed roster is still written as departments, and assignTiles -- which
  // runs straight after -- turns those into the tiles each person holds. One
  // path for a fresh database and an existing one, rather than two that have
  // to agree.
  const per = db.prepare(
    'INSERT OR IGNORE INTO people (email, name, groups, updated_at, updated_by) '
    + 'VALUES (?, ?, ?, ?, ?)');
  for (const email of Object.keys(PEOPLE)) {
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
      category: r.category, everyone: Boolean(r.everyone), status: r.status, sort: r.sort,
    })),
    categories: (cats.results || []).map((r) => ({
      key: r.cat_key, label: r.label, icon: r.icon || 'link', sort: r.sort,
    })),
    groups: (grps.results || []).map((r) => ({
      key: r.group_key, label: r.label, note: r.note, sort: r.sort,
    })),
  };
}

// The tiles a verified address has been given. Somebody nobody has assigned
// anything to comes back as [] -- known, and given nothing -- which is
// different from the null meaning "we could not establish who this is", and
// which still leaves them everything that is open to everyone.
export async function tilesFor(db, email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  const row = await db.prepare('SELECT tiles FROM people WHERE email = ?').bind(key).first();
  if (!row) return [];
  return splitList(row.tiles);
}

// Links, grouped the way the page draws them: by category, in the order the
// categories are in, skipping any that holds none.
export async function readLinks(db) {
  const res = await db.prepare('SELECT * FROM links ORDER BY sort, name').all();
  return (res.results || []).map((r) => ({
    key: r.link_key, name: r.name, url: r.url, category: r.category, sort: r.sort,
    // Parsed for the Setup page, which edits them as a set of chips. The
    // raw comma-separated string stays on `category` for anything reading
    // the row as it is stored.
    cats: linkCats(r),
  }));
}

export async function saveLink(db, row, who) {
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO links (link_key, name, url, category, sort, updated_at, updated_by) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(link_key) DO UPDATE SET name = excluded.name, url = excluded.url, '
    + 'category = excluded.category, sort = excluded.sort, '
    + 'updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(row.key, row.name, row.url, row.category, row.sort, now, who).run();
}

export async function deleteLink(db, key) {
  const k = cleanKey(key);
  if (k) await db.prepare('DELETE FROM links WHERE link_key = ?').bind(k).run();
}

export async function readPeople(db) {
  const res = await db.prepare('SELECT * FROM people ORDER BY email').all();
  return (res.results || []).map((r) => ({
    email: r.email, name: r.name, tiles: splitList(r.tiles),
    updated_at: r.updated_at, updated_by: r.updated_by,
  }));
}

// ── writing ────────────────────────────────────────────────────────────────

export async function saveTile(db, row, who) {
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO tiles (tile_key, name, blurb, url, icon, category, everyone, status, sort, '
    + 'updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(tile_key) DO UPDATE SET name = excluded.name, blurb = excluded.blurb, '
    + 'url = excluded.url, icon = excluded.icon, category = excluded.category, '
    + 'everyone = excluded.everyone, status = excluded.status, sort = excluded.sort, '
    + 'updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(row.key, row.name, row.blurb, row.url, row.icon, row.category,
          row.everyone ? 1 : 0, row.status, row.sort, now, who).run();
}

// Taking a tile off everybody who had it, in the same breath. Otherwise the
// key sits in their row forever, matching nothing.
export async function deleteTile(db, key) {
  const k = cleanKey(key);
  if (!k) return;
  const held = await db.prepare('SELECT email, tiles FROM people WHERE tiles LIKE ?')
    .bind('%' + k + '%').all();
  const batch = [db.prepare('DELETE FROM tiles WHERE tile_key = ?').bind(k)];
  const stmt = db.prepare('UPDATE people SET tiles = ? WHERE email = ?');
  for (const r of held.results || []) {
    const left = splitList(r.tiles).filter((x) => x !== k);
    if (left.length !== splitList(r.tiles).length) batch.push(stmt.bind(left.join(','), r.email));
  }
  await db.batch(batch);
}

export async function savePerson(db, row, who) {
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO people (email, name, tiles, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(email) DO UPDATE SET name = excluded.name, tiles = excluded.tiles, '
    + 'updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(row.email, row.name, row.tiles, now, who).run();
}

export async function deletePerson(db, email) {
  await db.prepare('DELETE FROM people WHERE email = ?')
    .bind(String(email || '').trim().toLowerCase()).run();
}

export async function saveCategory(db, input) {
  const key = cleanKey(input && input.key) || cleanKey(input && input.label);
  const label = String(input && input.label || '').trim().slice(0, 60);
  if (!key || !label) return { errors: ['A category needs a name.'] };
  const sort = Number.isFinite(Number(input && input.sort)) ? Number(input.sort) : 0;

  // Setup no longer asks for an icon: they are chosen in tiles.js and
  // backfilled. So an absent icon means LEAVE IT, and the update must not
  // name the column at all -- `icon = excluded.icon` with nothing supplied
  // would reset every category to the chain link the first time anybody
  // renamed one, which is precisely the bug backfillIcons just repaired.
  const icon = cleanKey(input && input.icon);
  if (icon) {
    await db.prepare(
      'INSERT INTO categories (cat_key, label, icon, sort) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(cat_key) DO UPDATE SET label = excluded.label, '
      + 'icon = excluded.icon, sort = excluded.sort')
      .bind(key, label, icon, sort).run();
  } else {
    await db.prepare(
      'INSERT INTO categories (cat_key, label, icon, sort) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(cat_key) DO UPDATE SET label = excluded.label, sort = excluded.sort')
      .bind(key, label, 'link', sort).run();
  }
  return { ok: true };
}

// Deleting a section.
//
// It refuses while tiles still sit in it. Allowing it would not lose them --
// dashCategories gathers anything orphaned into an Other bucket -- but
// "Other" is where things go to be forgotten, and silently moving somebody's
// tools there is not what anybody means by deleting an empty section. The
// count comes back so the message can say what is in the way.
//
// Links are different: a link can sit in several categories, so the key is
// simply taken off them. One left with none falls into Other, which for a
// bookmark is the honest answer rather than a loss.
export async function deleteCategory(db, key) {
  const k = cleanKey(key);
  if (!k) return { errors: ['No such section.'] };

  const used = await db.prepare('SELECT COUNT(*) AS n FROM tiles WHERE category = ?')
    .bind(k).first();
  const n = (used && used.n) || 0;
  if (n) {
    return { errors: [n + (n === 1 ? ' tile is' : ' tiles are') + ' still in this section.'
      + ' Move them to another one first, then delete it.'] };
  }

  const rows = await db.prepare('SELECT link_key, category FROM links').all();
  const edits = [];
  const fix = db.prepare('UPDATE links SET category = ? WHERE link_key = ?');
  for (const r of rows.results || []) {
    const had = linkCats(r);
    const keep = had.filter((c) => c !== k);
    if (keep.length !== had.length) edits.push(fix.bind(keep.join(','), r.link_key));
  }
  if (edits.length) await db.batch(edits);

  await db.prepare('DELETE FROM categories WHERE cat_key = ?').bind(k).run();
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
