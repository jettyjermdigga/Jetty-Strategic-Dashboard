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
  -- Comma-separated group keys, or the single word 'everyone'. A list rather
  -- than a join table: it is read whole on every page load and written whole
  -- by one form, and a join table would buy nothing but a second place to go
  -- out of step.
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
