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
* **Checking Xero**, from the line above the queue. It asks for a token and
  names the organisation that answered. What the last run did is shown there
  too, including why it failed.

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
3. **Make a Xero Custom Connection** -- not a Web app. A Custom Connection is
   machine-to-machine: it signs in as itself rather than as a person, holds
   one organisation, and has no consent screen, no callback and no refresh
   token to go stale. There is nobody whose leaving breaks the pull.

   Give it these three scopes, all read-only:

       accounting.invoices.read    the invoices and their line items
       accounting.payments.read    the payments on them
       accounting.settings.read    the chart of accounts, to find the codes

   A Custom Connection and a Web app do not share a scope vocabulary, and
   only the Web app's is in the OpenAPI spec. The spec's `securitySchemes`
   list umbrella scopes -- `accounting.transactions` covers invoices,
   payments, credit notes and bank transactions between them -- and a
   Custom Connection has no `accounting.transactions` at all. It is granted
   `accounting.invoices`, `accounting.payments`,
   `accounting.banktransactions` and `accounting.manualjournals` separately,
   each with a `.read` variant. Ask a Custom Connection for the umbrella
   name and it is refused.

   Pick them when you create the connection. They are fixed from then on:
   Xero does not let an existing Custom Connection be widened, so a missing
   scope means making a new one.

   **Nothing calls `GET /connections`.** That is the documented way to find
   the tenant id, and a Custom Connection cannot use it: it wants a
   `xero-tenant-id` or `xero-user-id` header to filter by and answers 400
   without one -- *Xero-User-Id and/or Xero-Tenant-Id header must be
   supplied* -- while the tenant id is the very thing we would be calling it
   to learn. There is no user on a Custom Connection, so there is no way out
   of that circle.

   There is no need to be in it. A Custom Connection reaches exactly one
   organisation and its token is bound to that organisation, so no call
   carries a tenant header at all and `GET /Organisation` simply answers for
   whichever one it is. That is both the name the page shows and proof the
   credentials reach real books.

   **The token request names no scope at all.** That is deliberate and it is
   not an oversight. A Custom Connection already knows its grant, and asking
   Xero to narrow it was refused here for every scope name alike -- with two
   different messages, *Client credentials scope validation failed* and *No
   valid scopes remaining after filtering for grant type*, neither of which
   depends on the name being right -- while the request naming nothing
   returned a token. So the connection's own grant decides, and what it
   decided is read back off the token's `scope` claim rather than assumed.
   `heldScopes` does that reading and `missingScopes` checks it, before the
   first API call rather than after.

   That check matters more than it looks. A missing scope does not refuse
   the call: it returns invoices with an empty `Payments` array, or an empty
   chart of accounts. That reads as a quiet month rather than as a
   permissions problem, which is the worst way for this to be wrong.

   Put its client id in `XERO_CLIENT_ID` in `wrangler.toml` and its secret
   where secrets go:

       cd commissions && npx wrangler secret put XERO_CLIENT_SECRET

   Not in `[vars]`: a deploy overwrites every var in that file and leaves
   secrets alone.

   If it will not start, open `/api/xero/probe`. It asks for a token naming
   no scope, reports what that token carries and what is missing, then asks
   about each scope separately, and says in a sentence what the numbers
   mean. A bare request that is itself refused is the app or the
   credentials rather than the scopes -- `client_credentials` works on a
   Custom Connection and nothing else.

   Then press **Check Xero**, which asks for a token and reports which
   organisation answered. Open `/api/xero/accounts` to see the chart of
   accounts, and set `XERO_ACCOUNTS` to the code or codes that mean wholesale
   revenue. Until `XERO_ACCOUNTS` is set a pull refuses outright rather than
   quietly importing nothing.

   Nothing is stored: every run asks for a fresh token, so there is no
   credential in the database to leak and nothing to re-authorise in sixty
   days' time.
4. **Import the history.** Run the *Import commissions from Airtable*
   workflow. Leave `apply` unticked for a dry run; it reports what it would
   write without touching D1. It is keyed on Airtable record ids, so running
   it twice imports nothing the second time.

## Tests

    node tests/unit.mjs      # pure logic -- gates the deploy
    node tests/worker.mjs    # the real Worker against node:sqlite
    node tests/browser.mjs   # the page in Chromium, including a contrast sweep

The last two skip rather than fail when esbuild or Playwright is missing.
