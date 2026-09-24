-- Company calendar store. Applied lazily by the Worker on first request, so
-- there is no separate migration step to run or forget.
--
-- Year, Week, Start (Week), End (Week), Month and Day are deliberately absent:
-- all six are functions of start_date and are derived on read. See worker/retail.js.
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,              -- Name

  event_types TEXT,                       -- Event Type: comma-separated keys, peers, no
                                          -- primary. Stored in taxonomy order so that
                                          -- "Box Truck,JRF" and "JRF,Box Truck" are the
                                          -- same value.
  sub_types   TEXT,                       -- comma-separated sub-type keys, each scoped to
                                          -- one of the event types above
  needs       TEXT,                       -- comma-separated need keys: mobile bar, social
                                          -- permit, sound tech, branded beer
  status      TEXT NOT NULL DEFAULT 'Pending',
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
  created_by  TEXT,
  created_at  TEXT,
  updated_by  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_start ON items(start_date);
CREATE INDEX IF NOT EXISTS idx_items_end   ON items(end_date);
