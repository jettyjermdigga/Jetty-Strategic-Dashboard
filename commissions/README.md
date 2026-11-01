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

    Xero  ->  the nightly pull  ->  the queue  ->  Amy allocates  ->  paid
                                                                  ->  statement

Straight from Xero. No Zapier.

The pull asks `GET /Invoices` for sales invoices that are AUTHORISED or PAID
-- AUTHORISED as well, because a part-paid invoice is still AUTHORISED and its
payments have already earned commission. With a `page` parameter Xero returns
each invoice **with its line items**, which is what makes an invoice knowable
as wholesale: any line item hitting an account code in `XERO_ACCOUNTS`.

Each payment on such an invoice becomes one queue row, keyed on Xero's
`PaymentID`. That key is UNIQUE here, so re-pulling an overlapping window
writes nothing the second time: a duplicate payment is a duplicate commission.

Two things about Xero that are easy to get wrong and are tested:

* **Dates are `/Date(1612137600000+0000)/`.** The number is already UTC
  milliseconds. Applying the offset as well moves an evening payment to the
  next day, which on the last of the month puts it on the wrong statement.
* **The refresh token rotates on every single refresh.** The old one dies the
  instant the new one is issued, so it is stored in the database -- before the
  pull runs, not after -- rather than in a secret nobody can rewrite. Store it
  late and the connection works exactly once.

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
* **The Xero pull.** Nightly on a cron trigger, and on demand from the Pull
  now button. Each run moves a watermark so the next one asks only for what
  changed -- except when it stopped early on a rate limit, where the watermark
  stays put so nothing is skipped.
* **Connecting Xero**, from the line above the queue: a sign-in, once.
  What the last run did is shown there too, including why it failed.

## What is not built yet

* Marking a month's commission paid (`cleanPaid` exists and is tested; nothing
  calls it).

* **The monthly statement.** The piece Amy actually does, and the reason the
  Reps tab in the Ledger still exists: one `.xlsx` per rep per month, kept,
  and sent to that rep when the payment goes out. `statements` is the index
  and the import has already filled it with the history; the R2 bucket is
  bound and empty.

  Four things it has to do, in her words: build a file per rep for a given
  month, store it, send it, and record that it went. Worth settling with her
  before building: what belongs on the sheet beyond the lines and the total,
  whether a statement can be re-sent or re-issued after a correction, and
  whether "paid" and "sent" are one act or two -- they are not the same
  question and this module currently answers neither.

* Moving the historic report files out of Airtable. Their attachment URLs
  expire, so copying them into R2 is its own job; the import keeps the
  filenames so a statement can be matched up by hand until then.

* **Reps imported from the Ledger carry record ids instead of names.** In
  the Ledger's Reps tab, Sales Rep is a linked-record field, so Airtable
  returns `rec...` ids rather than names. `scripts/import_commissions.py`
  takes that id for a name and slugifies it, which is why the rep list has
  entries like `rec4xy...` beside the real ones. The table carries a lookup
  field holding the actual name, which is what the script should read.

  Fixing it means two things, not one: reading the right field next time,
  and merging each junk rep into the real one so the statements already
  imported against it keep their history rather than being orphaned.

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
3. **Use the Xero app that exists, or make a Web app.** At
   developer.xero.com/app/manage. Its **OAuth 2.0 redirect URI** must be
   exactly `<this module's URL>/api/xero/callback` -- Xero refuses a sign-in
   whose redirect it does not recognise. Put the client id in
   `XERO_CLIENT_ID` in `wrangler.toml` and the secret where secrets go:

       cd commissions && npx wrangler secret put XERO_CLIENT_SECRET

   Not in `[vars]`: a deploy overwrites every var in that file and leaves
   secrets alone.

   Then press **Connect Xero**, sign in, and pick the organisation. That is
   the step that matters: an app with *0 of 5 connections* has never been
   authorised against any books, and a token it issues is real and reaches
   nothing. Which is what a 403 with an empty body turns out to mean.

   **This is a Web app, not a Custom Connection**, and the difference is
   not cosmetic. A Custom Connection is machine-to-machine: one
   organisation, no sign-in, `client_credentials`. A Web app signs a person
   in and hands back a refresh token. A Web app *will* issue a
   `client_credentials` token -- Xero uses those for App Store billing --
   and it carries the whole granted scope list while reaching no accounting
   data at all. An earlier version of this module read that scope list,
   concluded Custom Connection, and spent a day on an empty 403.

   The scopes are the ones **this app is permitted to request**, which is a
   list on its own Configuration page:

       accounting.invoices.read    the invoices and their line items
       accounting.payments.read    the payments on them
       accounting.settings.read    the chart of accounts, to find the codes

   plus `offline_access`, without which Xero's consent screen offers *Allow
   access for 30 minutes* and hands back no refresh token.

   **That list is not the OpenAPI spec's.** The spec's `securitySchemes`
   describe the API -- `accounting.transactions` covers invoices, payments,
   credit notes and bank transactions between them -- while an app carries
   its own list of what it may ask for. This app's is the granular
   vocabulary and has no `accounting.transactions` in it at all, so asking
   for the umbrella name is refused with `invalid_scope` on Xero's own
   error page, which does not say which scope it objected to. Both
   directions of that mistake have been made here.

   `/api/xero/connect?scope=...` asks for a narrower set and goes straight
   there, which is how to find out which one Xero is refusing without a
   deploy per guess. `&show=1` returns the URL instead of following it.

   No identity scopes. Nothing reads the identity, and a scope nobody uses
   is one that can only ever go wrong. No write scopes either: posting a
   manual journal would need `accounting.manualjournals`, which this app is
   permitted and has deliberately not been granted.

   Xero **rotates the refresh token on every refresh**: the one just used is
   dead and the new one comes back in the same response. It is written back
   before anything else happens, including in the probe. A refresh token
   also expires after sixty days unused, which the nightly cron prevents.

   If something will not start, open `/api/xero/probe`. It refreshes, says
   what the token holds and what is missing, then asks the API the same
   question several ways -- with the tenant header and without, across
   three endpoints -- and reports each answer with whatever body came back.

   Then open `/api/xero/accounts` to see the chart of accounts, and set
   `XERO_ACCOUNTS` to the code or codes that mean wholesale revenue. Until
   it is set a pull refuses outright rather than quietly importing nothing.

4. **Import the history.** Run the *Import commissions from Airtable*
   workflow. Leave `apply` unticked for a dry run; it reports what it would
   write without touching D1. It is keyed on Airtable record ids, so running
   it twice imports nothing the second time.

## Tests

    node tests/unit.mjs      # pure logic -- gates the deploy
    node tests/worker.mjs    # the real Worker against node:sqlite
    node tests/browser.mjs   # the page in Chromium, including a contrast sweep

The last two skip rather than fail when esbuild or Playwright is missing.
