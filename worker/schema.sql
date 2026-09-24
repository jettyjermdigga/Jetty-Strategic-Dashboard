-- Company calendar store. Applied lazily by the Worker on first request, so
-- there is no separate migration step to run or forget.
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  type        TEXT,
  division    TEXT,
  start_date  TEXT NOT NULL,              -- YYYY-MM-DD
  end_date    TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  all_day     INTEGER NOT NULL DEFAULT 1,
  start_time  TEXT,                       -- HH:MM, local, only when all_day = 0
  end_time    TEXT,
  location    TEXT,
  owner       TEXT,
  status      TEXT NOT NULL DEFAULT 'Confirmed',
  notes       TEXT,
  url         TEXT,
  created_by  TEXT,
  created_at  TEXT,
  updated_by  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_start ON items(start_date);
CREATE INDEX IF NOT EXISTS idx_items_end   ON items(end_date);
