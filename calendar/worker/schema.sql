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
  event_fee   REAL,                       -- what it cost to be there, in dollars
  orders      INTEGER,                    -- how many orders the event took
  net_revenue REAL,                       -- net, in dollars. The sales report itself is
                                          -- an attachment whose slot is 'results'
  social_type TEXT,                       -- post | carousel | story | reel
  channels    TEXT,                       -- comma-separated channel keys
  pillar      TEXT,                       -- what the post is about; one of PILLARS
  production  TEXT,                       -- comma-separated production states. How far
                                          -- along the work is, NOT whether it is happening
  caption     TEXT,                       -- the copy that goes out, not the internal note
  tags        TEXT,                       -- hashtags and @handles, as typed
  products    TEXT,                       -- JSON list of product highlights:
                                          -- id, division, category, sku, url. See
                                          -- worker/products.js. An example image is an
                                          -- ordinary attachment whose slot is the row id.
  results_posted_at TEXT,                 -- when the sales report was announced in
                                          -- Slack. Set once; it is what stops the
                                          -- announcement firing again on every
                                          -- subsequent save of the same event.
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
  slot         TEXT,                   -- which product highlight row this illustrates;
                                       -- NULL for an ordinary attachment on the event
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

-- Comments on an event. Anyone who can open the calendar can post one; the
-- author is the Access identity, never anything the caller sends, so a comment
-- cannot be put in somebody else's mouth.
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  mentions   TEXT,                      -- comma-separated lowercased emails
  author     TEXT NOT NULL,             -- email, from the verified Access claims
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);

-- Who can be mentioned. Filled from Slack when a bot token is configured, so
-- there is no list to maintain by hand; anyone who has used the calendar is
-- offered too, so the picker works before Slack is wired up.
CREATE TABLE IF NOT EXISTS people (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  slack_id   TEXT,
  updated_at TEXT
);

-- When each person last looked at the comments that mention them.
--
-- One row per person, not one per comment. The question being asked is
-- "what is new since I last looked", and a timestamp answers it without a
-- table that grows with every comment ever written -- and without having to
-- write a row the moment anybody is mentioned, which would put a write on
-- the path of every save.
CREATE TABLE IF NOT EXISTS seen (
  email       TEXT PRIMARY KEY,
  mentions_at TEXT
);

-- Who was at an event, and in what capacity.
--
-- Worth having for its own sake -- "who worked Chowderfest" is a question
-- somebody asks -- and it is also where Boxy Bucks are earned.
--
-- The points are stored on the row rather than looked up from the role
-- later. An event costed when Worked was worth 3 must not silently become
-- worth 5 because the default changed a month afterwards.
CREATE TABLE IF NOT EXISTS attendance (
  item_id     TEXT NOT NULL,
  person_key  TEXT NOT NULL,          -- from boxy-seed.js, not an address
  role        TEXT NOT NULL,          -- worked | volunteered | attended
  points      INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  added_by    TEXT,
  added_at    TEXT,
  PRIMARY KEY (item_id, person_key)
);
CREATE INDEX IF NOT EXISTS idx_att_person ON attendance(person_key);

-- Everything else that moves a Boxy Bucks balance: merch and samples taken,
-- and corrections.
--
-- Kept apart from attendance so that taking somebody off an event removes
-- what they earned for it and leaves what they have already spent alone --
-- which is what anybody would expect, and would be fiddly in one table.
--
-- A spend is stored negative. Nothing is ever edited here; a mistake is
-- corrected with another row, so the history of a balance stays readable.
CREATE TABLE IF NOT EXISTS boxy_ledger (
  id          TEXT PRIMARY KEY,
  person_key  TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- spend | adjust
  points      INTEGER NOT NULL,       -- negative for a spend
  note        TEXT NOT NULL DEFAULT '',
  -- The day the samples were actually taken, which is not always the day
  -- somebody got round to entering it. added_at is the latter.
  on_date     TEXT,
  -- Who handed them over, from BOXY_CHECKOUT. Not the same as added_by:
  -- one of four people runs the cupboard, and any of them might be typed
  -- in by whoever is at a keyboard.
  checked_by  TEXT,
  added_by    TEXT,
  added_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_person ON boxy_ledger(person_key);
