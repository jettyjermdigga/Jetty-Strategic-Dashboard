# Retail sales commissions

Jeremy logs a retailer payment. Amy says which rep it belongs to and at what
rate. At month end the rep is paid and a statement goes out.

Those are three separate days, which is why they are three separate actions
rather than one status somebody drags along: a payment is allocated when it
arrives and paid at the end of the month, and conflating the two is how a rep
gets paid twice.

Its own Worker, its own database, its own Access application. Two people use
this and it decides what the sales reps get paid, so it shares nothing with
the calendar or the dashboard.

## Where the numbers come from

    Jeremy's Ledger  ->  /api/ingest  ->  the queue  ->  Amy allocates  ->  paid
                                                                        ->  statement

Three formulas, which are the ones the Airtable base has always used:

    Net Invoice = Original Invoice + Credits - Freight
    Amount Due  = Net Invoice x Commission % / 100
    a Canadian row is paid on its USD net, not its CAD net

Credits are **added**, because a credit is entered negative. A sign flip there
would overpay on every invoice that carried one.

That arithmetic is written three times -- in `worker/commission.js`, as
generated columns in `worker/schema.sql`, and again in `public/assets/
commissions.js` so the preview can move as a rate is typed without a round
trip per keystroke. `tests/unit.mjs` runs all three over the same rows and
fails if they ever disagree.

## What is built

* **The allocation queue.** Everything with no rep on it, oldest first.
  `rep_key IS NULL` is the whole definition -- the Airtable view was "Sales
  Rep is empty" and this is the same rule, in one place rather than in a view
  somebody can edit.
* **The feed.** `POST /api/ingest`, keyed on the sender's own record id, which
  is UNIQUE. A replay writes nothing the second time; a duplicate payment here
  is a duplicate commission.

## What is not built yet

* Marking a month's commission paid (`cleanPaid` exists and is tested; nothing
  calls it).
* The monthly statement: the `.xlsx` per rep, R2 storage and the email.
  `statements` exists and the import fills it in.
* Moving the historic report files out of Airtable. Their attachment URLs
  expire, so copying them into R2 is its own job; the import keeps the
  filenames so a statement can be matched up by hand until then.

## Setting it up

1. **Deploy.** Push to `main`; `.github/workflows/commissions.yml` creates the
   D1 database and deploys the Worker.
2. **Put Cloudflare Access in front of it**, as its own application --
   separate from the calendar's and the dashboard's. Paste the application's
   Audience tag into `ACCESS_AUD` in `wrangler.toml`.

   Until that is done **nobody can use the module**, including the addresses
   in `COMMISSION_USERS`. That is deliberate: `access.js` only grants access
   on a verified Access token, and with a team domain set and no audience
   there is nothing to verify against. It fails closed rather than falling
   back to trusting a header anyone can send.
3. **Set the feed key**, which is the only credential that can write a payment
   without an Access identity:

       cd commissions && npx wrangler secret put INGEST_KEY

   Then point the existing Zap at `POST /api/ingest` with that value in an
   `x-ingest-key` header. Until the key is set the endpoint answers 503 to
   everything -- an unset secret must not mean an open endpoint.
4. **Import the history.** Run the *Import commissions from Airtable*
   workflow. Leave `apply` unticked for a dry run; it reports what it would
   write without touching D1. It is keyed on Airtable record ids, so running
   it twice imports nothing the second time.

## Tests

    node tests/unit.mjs      # pure logic -- gates the deploy
    node tests/worker.mjs    # the real Worker against node:sqlite
    node tests/browser.mjs   # the page in Chromium, including a contrast sweep

The last two skip rather than fail when esbuild or Playwright is missing.
