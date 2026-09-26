-- Company calendar store. Applied lazily by the Worker on first request, so
-- there is no separate migration step to run or forget.
--
-- Year, Week, Start (Week), End (Week), Month and Day are deliberately absent:
-- all six are functions of start_date and are derived on read. See worker/retail.js.
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,              -- Name

  event_type  TEXT,                       -- exactly one: events-marketing | meetings-deadlines
  department  TEXT,                       -- the primary department. Owns the event and
                                          -- gives it its colour.
  departments TEXT,                       -- the other departments involved, comma-separated
                                          -- keys in taxonomy order. Never repeats the primary.
  sub_types   TEXT,                       -- comma-separated sub-type keys, each scoped to the
                                          -- primary department
  needs       TEXT,                       -- comma-separated need keys, each scoped to a
                                          -- department on the event
  staff_count TEXT,                       -- the detail on "Extra staff needed"
  vehicles    TEXT,                       -- comma-separated vehicle keys
  status      TEXT NOT NULL DEFAULT 'Booked',
  start_date  TEXT NOT NULL,              -- Event, YYYY-MM-DD
  end_date    TEXT NOT NULL,              -- Event end, YYYY-MM-DD, inclusive
  all_day     INTEGER NOT NULL DEFAULT 1,
  start_time  TEXT,                       -- HH:MM, 24-hour, only when all_day = 0
  end_time    TEXT,
  venue       TEXT,
  address     TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  notes       TEXT,
  url         TEXT,
  event_types TEXT,                       -- retired. The pre-decision-tree "Event Type" axis,
                                          -- kept only so the one-time migration below has a
                                          -- source; nothing reads it afterwards.
  created_by  TEXT,
  created_at  TEXT,
  updated_by  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_start ON items(start_date);
CREATE INDEX IF NOT EXISTS idx_items_end   ON items(end_date);

-- Files attached to an event. The bytes live in R2; this is the index, so the
-- calendar can list and name them without reaching for object storage.
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL,
  name         TEXT NOT NULL,          -- as uploaded, shown on the event
  size         INTEGER,
  content_type TEXT,                   -- what the browser claimed; NOT what we serve back
  r2_key       TEXT NOT NULL,          -- object key, never derived from the filename
  uploaded_by  TEXT,
  uploaded_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_item ON attachments(item_id);

-- One row per person who has ever opened Subscribe: their own feed token and
-- what they want it to carry.
--
-- A token rather than one shared key, so a link that gets out can be reset for
-- that person alone. Filters live here rather than in the URL because a URL is
-- fixed the moment Google stores it -- settings can be changed afterwards and
-- the existing subscription simply starts carrying the new slice.
CREATE TABLE IF NOT EXISTS feeds (
  token      TEXT PRIMARY KEY,         -- unguessable; this IS the credential
  email      TEXT NOT NULL UNIQUE,
  filters    TEXT,                     -- JSON: { dept: [], kind: [], sub: [], status: [] }
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feeds_email ON feeds(email);

-- One row per applied migration, so a backfill that rewrites data runs once and
-- not on every cold start.
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  applied_at TEXT
);
