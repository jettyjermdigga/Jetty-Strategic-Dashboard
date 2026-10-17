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
