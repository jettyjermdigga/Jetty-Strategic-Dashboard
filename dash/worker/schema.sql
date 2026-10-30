-- The dash's own store. Four tables, all of them lists somebody maintains:
-- what tools exist, what kinds of work there are, what the permissions are
-- called, and who holds them.
--
-- Everything here was a file in the repo first. It moved into a database the
-- moment it needed to be edited by somebody who is not editing the repo.

-- A tool on the portal. `tile_key` is a stable handle so a tile can be renamed
-- without anything that references it breaking.
CREATE TABLE IF NOT EXISTS tiles (
  tile_key    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  blurb       TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'link',
  category    TEXT NOT NULL DEFAULT 'company',
  -- 1 when the tile is open to every member of staff, so the Company
  -- Calendar does not have to be ticked onto twenty people one at a time.
  everyone    INTEGER NOT NULL DEFAULT 0,
  -- Historical: who-can-see-it used to live here as a list of group keys.
  -- It is set per person now, on the person. Kept so old rows still read.
  groups      TEXT NOT NULL DEFAULT '',
  -- 'live' is drawn; anything else is kept and never sent. See tiles.js.
  status      TEXT NOT NULL DEFAULT 'soon',
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  updated_by  TEXT
);

-- What kind of work a tool belongs to. Headings on the page, in `sort` order.
CREATE TABLE IF NOT EXISTS categories (
  cat_key   TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  icon      TEXT NOT NULL DEFAULT 'link',
  sort      INTEGER NOT NULL DEFAULT 0
);

-- A permission, named for the door it opens rather than the job somebody
-- holds. See the note in tiles.js for why that distinction is load-bearing.
CREATE TABLE IF NOT EXISTS groups (
  group_key TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT '',
  sort      INTEGER NOT NULL DEFAULT 0
);

-- Who is in what. Email is the key because that is what Access verifies and
-- hands the Worker; it is stored lowercased, which is also how it is looked up.
CREATE TABLE IF NOT EXISTS people (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  -- The tiles this person has been given, comma-separated. A list rather
  -- than a join table: it is read whole on every page load and written whole
  -- by one row of one form.
  tiles      TEXT NOT NULL DEFAULT '',
  -- Historical: the departments they were in, before tiles were assigned
  -- directly. Kept so old rows still read.
  groups     TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by TEXT
);

-- Bookkeeping: which one-time jobs have run.
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  applied_at TEXT
);

-- A link is a bookmark, not a tool: an address somebody should be able to
-- find, with no dashboard behind it. The Model Inquiry Form is the shape of
-- it -- Marketing has a tile for the model database and, separately, a link
-- to the form a prospective model fills in.
--
-- Links are shown to every member of staff. They are addresses, and the thing
-- on the far end sets its own access the same way a tile's tool does, so
-- there is nothing here worth assigning person by person. If that turns out
-- to be wrong, links can take the same treatment tiles got.
CREATE TABLE IF NOT EXISTS links (
  link_key   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT 'general',
  sort       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

-- Music Monday. One pick a week since February 2013, lifted out of a
-- hundred-column Airtable table that also held social, PR, blog and events.
--
-- The date is the key: there is one pick per Monday, so a re-import cannot
-- duplicate a week and a correction overwrites cleanly.
--
-- Most of the archive is text and always will be. Photos exist from 2022 and
-- videos from 2024 (plus a scattering in 2015-17), so anything drawn here has
-- to read well with neither.
CREATE TABLE IF NOT EXISTS music (
  pick_date   TEXT PRIMARY KEY,
  artist      TEXT NOT NULL,
  song        TEXT NOT NULL DEFAULT '',
  chosen_by   TEXT NOT NULL DEFAULT '',
  -- Split so the page can embed a player for YouTube and simply link out
  -- for the eighteen SoundCloud ones.
  youtube     TEXT NOT NULL DEFAULT '',
  video_url   TEXT NOT NULL DEFAULT '',
  -- Filled in when the photos move to R2; Airtable's own urls are signed
  -- and short-lived, so they cannot be stored.
  photo_key   TEXT NOT NULL DEFAULT '',
  updated_at  TEXT,
  updated_by  TEXT
);

-- The 2027 budget, and the years after it.
--
-- Only what somebody DECIDED is stored: the figure they typed, why, and
-- whether it needs another look. The 2026 baseline it was decided against
-- lives in budget-seed.js, a committed snapshot -- so a dashboard rebuild
-- cannot move the ground under a half-finished budget, and the note beside
-- a line stays true to the number it was written about.
--
-- A row only exists once a line has been decided. An untouched line has no
-- row, which is what makes "6 of 77 set" a real count rather than a guess.
CREATE TABLE IF NOT EXISTS budget (
  year        INTEGER NOT NULL,
  line_key    TEXT NOT NULL,
  -- The annual figure. Weeks, months and quarters are spread from it on the
  -- seasonality curve; they are a view, not twelve more things to maintain.
  amount      REAL,
  -- The point of the whole exercise: what nobody else knows about this line.
  note        TEXT NOT NULL DEFAULT '',
  flagged     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  updated_by  TEXT,
  PRIMARY KEY (year, line_key)
);

-- The labor plan: what next year's people cost, person by person.
--
-- Same rule as the budget above -- only what somebody DECIDED is stored.
-- The roster it hangs on lives in labor-seed.js, and deliberately holds no
-- pay at all: every figure in this table was typed into the page, and this
-- is the only place any of it exists.
--
-- `added` marks a write-in: a post somebody keyed in rather than a person
-- the roster already had. Those rows carry their own name and title,
-- because nothing else knows about them.
--
-- `removed` strikes a seeded person off. It has to be stored rather than
-- simply deleted, because the roster is re-read on every boot and would
-- otherwise put them straight back -- which is the bug this codebase has
-- now had six times.
CREATE TABLE IF NOT EXISTS labor (
  year        INTEGER NOT NULL,
  person_key  TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  dept        TEXT NOT NULL DEFAULT '',
  division    TEXT NOT NULL DEFAULT '',
  -- Full or part time. Empty means "as the roster has it", which is not the
  -- same as a blank: an outsourced supplier is neither, and storing the
  -- seeded value on every row would freeze each one against a later roster.
  ft          TEXT NOT NULL DEFAULT '',
  pay_type    TEXT NOT NULL DEFAULT '',
  -- Direct labor or G&A. An accounting judgement rather than a fact about
  -- the roster, so it starts empty for everybody and is never guessed.
  cls         TEXT NOT NULL DEFAULT '',
  rate        REAL,
  salary      REAL,
  hours       REAL,
  note        TEXT NOT NULL DEFAULT '',
  added       INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  updated_by  TEXT,
  PRIMARY KEY (year, person_key)
);

-- COGS planning: what a season's goods cost, season by season.
--
-- Same rule as the budget and the labor plan -- only what somebody DECIDED
-- is stored, and there is no seeded figure anywhere. The fourteen lines
-- the sheet opens with live in worker/cogs.js and carry no money at all;
-- every number in this table was typed into the page.
--
-- The id is season:kind, so the sheet's own lines keep one id however
-- often the Worker boots. `added` marks a line somebody keyed in -- a
-- prior season, almost always -- which carries its own season and label
-- because nothing else knows about it. `removed` strikes a seeded line
-- off, and has to be stored rather than deleted: the seed runs on every
-- boot and would otherwise put it straight back.
CREATE TABLE IF NOT EXISTS cogs (
  id            TEXT PRIMARY KEY,
  season        TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT '',
  season_label  TEXT NOT NULL DEFAULT '',
  amount        REAL,
  note          TEXT NOT NULL DEFAULT '',
  added         INTEGER NOT NULL DEFAULT 0,
  removed       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT,
  updated_by    TEXT
);
