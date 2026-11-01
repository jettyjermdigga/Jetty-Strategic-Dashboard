-- Retail sales commissions. Applied lazily by the Worker on first request, so
-- there is no separate migration step to run or forget.
--
-- One row per retailer payment that may earn a rep commission. Jeremy logs
-- the payment; Amy allocates it to a rep and a rate; at month end the rep is
-- paid and a statement goes out. Those are three separate days, which is why
-- they are three separate columns rather than one status.

CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,

  -- Where the row came in from, and its id at that source. UNIQUE on
  -- source_ref is what stops the same payment arriving twice when a feed is
  -- replayed -- a duplicate payment is a duplicate commission.
  source        TEXT,                 -- ledger | zapier | airtable | manual
  source_ref    TEXT UNIQUE,

  paid_on       TEXT NOT NULL,        -- the day the retailer's money landed, YYYY-MM-DD
  invoice_no    TEXT,
  retailer      TEXT,
  customer      TEXT,
  territory     TEXT,
  jetty_line    TEXT,
  payment_method TEXT,

  -- What Amy allocates. rep_key NULL is the whole definition of the queue.
  rep_key       TEXT,
  commission_pct REAL,                -- whole numbers: 10 means 10%

  gross         REAL,                 -- the invoice before credits and freight
  credits       REAL,                 -- entered as it reads, negative on a credit
  freight       REAL,                 -- nobody earns commission on shipping

  -- A Canadian row is invoiced in CAD and settled in USD, so it carries its
  -- own USD figure and the rep is paid on that.
  cad           INTEGER NOT NULL DEFAULT 0,
  usd_net       REAL,

  cc_fee        INTEGER NOT NULL DEFAULT 0,   -- the retailer paid the 3% card fee
  partial       INTEGER NOT NULL DEFAULT 0,   -- part payment of a larger invoice

  -- Screen printing rather than wholesale. Its own section on the statement
  -- and its own rate -- the reps earn 10% on the brand and 2% on Ink -- so
  -- it is a flag on the payment rather than something inferred from a rate
  -- or spelled into jetty_line.
  ink           INTEGER NOT NULL DEFAULT 0,
  paid          INTEGER NOT NULL DEFAULT 0,   -- the REP has been paid, not the retailer
  paid_at       TEXT,
  paid_by       TEXT,

  credit_memo   TEXT,
  notes         TEXT,

  -- What Xero said this was raised in, and which invoice it came off.
  -- Neither is needed to pay anybody; both are what a query three months
  -- from now is answered with.
  currency      TEXT,
  xero_invoice_id TEXT,

  -- The two figures everything reads, worked out by the database rather than
  -- by whoever is writing. worker/commission.js does the same arithmetic for
  -- the page, and a test runs both over the same rows and fails if they ever
  -- disagree.
  net_invoice   REAL GENERATED ALWAYS AS (
    ROUND(COALESCE(gross, 0) + COALESCE(credits, 0) - COALESCE(freight, 0), 2)
  ) VIRTUAL,
  amount_due    REAL GENERATED ALWAYS AS (
    ROUND(
      (CASE WHEN cad = 1 THEN COALESCE(usd_net, 0)
            ELSE ROUND(COALESCE(gross, 0) + COALESCE(credits, 0) - COALESCE(freight, 0), 2)
       END) * COALESCE(commission_pct, 0) / 100.0, 2)
  ) VIRTUAL,

  created_by    TEXT,
  created_at    TEXT,
  updated_by    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pay_paid_on ON payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_pay_rep     ON payments(rep_key);
-- The queue, which is the screen opened most: every row with no rep yet.
CREATE INDEX IF NOT EXISTS idx_pay_queue   ON payments(rep_key, paid_on) WHERE rep_key IS NULL;

-- Who can be allocated to. A list rather than free text: typed names are how
-- one person becomes three spellings and a statement comes up short.
CREATE TABLE IF NOT EXISTS reps (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  default_pct REAL,                   -- offered on allocation, never applied silently
  territory   TEXT,
  notes       TEXT,
  created_at  TEXT,
  updated_at  TEXT
);

-- The monthly run: one per rep per month, which is what the Ledger's Reps tab
-- has always been. The report is an object in R2; this is the index.
CREATE TABLE IF NOT EXISTS statements (
  id          TEXT PRIMARY KEY,
  rep_key     TEXT NOT NULL,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL,       -- 1-12
  amount      REAL,
  report_key  TEXT,                   -- R2 object key
  report_name TEXT,
  lines       INTEGER,                -- how many payments are on it
  -- When the file was last built. On its own it says nothing; next to
  -- sent_at it says whether the rep is holding the statement the books
  -- currently support, which is the question a correction raises.
  built_at    TEXT,
  sent_at     TEXT,
  sent_by     TEXT,
  notes       TEXT,
  created_at  TEXT,
  updated_at  TEXT,
  UNIQUE (rep_key, year, month)
);
CREATE INDEX IF NOT EXISTS idx_stmt_period ON statements(year, month);

-- The Xero connection. One row, because there is one Xero organisation.
--
-- The refresh token lives here, and it is the credential: this is a Web
-- app, so somebody signed in once and Xero handed back a token that is
-- traded for a half-hour access token whenever one is needed.
--
-- Xero ROTATES the refresh token on every refresh. The one just used is
-- dead and the new one comes back in the same response, so it is written
-- back before anything else happens -- a failed write-back makes the
-- connection work exactly once and then fail, which has happened here.
CREATE TABLE IF NOT EXISTS xero (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id     TEXT,
  tenant_name   TEXT,
  refresh_token TEXT,
  -- One-time CSRF state for the connect flow, and when it was issued. A
  -- callback carrying anything else is somebody else's.
  oauth_state   TEXT,
  oauth_at      TEXT,
  connected_by  TEXT,
  connected_at  TEXT,
  -- When the access token was last refreshed. Xero rotates the refresh
  -- token on every refresh, so this is also when refresh_token last
  -- changed -- and a date far in the past is how a connection that has
  -- quietly stopped running looks.
  refreshed_at  TEXT,
  -- How far the last pull got, as a Xero UpdatedDateUTC. The next pull asks
  -- only for what changed after it, which is the difference between a nightly
  -- run and re-reading every invoice ever raised.
  watermark     TEXT,
  last_run_at   TEXT,
  last_result   TEXT
);

-- Which one-time migrations have run. Same shape as the calendar's, and read
-- the same way: a key is claimed with INSERT OR IGNORE before any work, so
-- two isolates cannot both decide the work is theirs.
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  applied_at TEXT
);
