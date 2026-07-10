# Accounting Email Sync — Setup

`scripts/sync_accounting_emails.py` reads Shopify, Stripe, CardPointe, and
GoCardless payout emails out of jeremy@jettylife.com's Gmail, logs a row per
payout into the "Ledger 💰" Airtable base (JTY Ledger or JRF Ledger,
depending on entity), then labels and archives the source email. It's meant
to run daily via `.github/workflows/sync_accounting_emails.yml`.

Rules (sender → table → field values) are derived from
`Accounting_Ledger_Email_Extraction_Rules.xlsx` and hardcoded in the script's
`SHOPIFY_STORES` / `STRIPE_ENTITIES` / `CARDPOINTE_RULE` / `GOCARDLESS_RULE`
dicts. Add a new email type by adding a new dict entry + parser function.

## 1. Google Workspace: domain-wide delegation

Gmail access requires a service account impersonating jeremy@jettylife.com
(personal OAuth won't work unattended in CI).

1. In Google Cloud Console, create (or reuse) a service account and enable
   the **Gmail API** for its project.
2. Generate a JSON key for the service account.
3. In the **Google Workspace Admin console** → Security → API Controls →
   Domain-wide Delegation → Add new:
   - Client ID: the service account's numeric client ID (from its JSON key
     or the Cloud Console credentials page).
   - Scope: `https://www.googleapis.com/auth/gmail.modify`
4. Set repo secrets:
   - `GMAIL_CREDENTIALS`: the full service account JSON (same shape as the
     existing `GDRIVE_CREDENTIALS` secret).
   - `GMAIL_DELEGATED_USER`: `jeremy@jettylife.com`

## 2. Airtable

1. Create a Personal Access Token (Airtable account → Developer Hub) scoped
   to the **Ledger 💰** base (`appW8jAfERj3iBzqt`) with `data.records:read`
   and `data.records:write`.
2. Set repo secret `AIRTABLE_API_KEY` to that token.

## 3. New tag values this will create

The script writes with `typecast=true`, so any value below that doesn't
already exist as a select option gets created automatically on first write.
Flagging these since they weren't pre-existing options at build time:

- JTY Ledger Vendor: `Stripe (DTC)`, `GoCardless`
- JTY Ledger Type: `ACH`
- JRF Ledger Vendor/Donee: `Shopify`, `Give Smart (Mobile Cause)`

Everything else (`Shopify`, `STRIPE (BRAND)`, `STRIPE (INK)`, `Stripe (JRF)`,
`Playa Bowls`, `CardPointe (Mobile Cause)`, `DTC - Shopify`, `Screen Printing
Revenue`, `Wholesale Revenue`, `DTC - Jettylife.com`, `Columbia`, `TD Bank -
Operating`, `Revenue`) matched existing options exactly.

## 4. Known risk: existing Zapier automation

Some rows already in JTY Ledger (e.g. Stripe — Ink payouts) appear to have
been entered by an existing Zapier integration, judging by Notes text and
the "Zapier" Gmail label. This script's own-duplicate check only recognizes
rows it wrote itself (it searches Notes for `Gmail msg: <id>`), so it will
**not** detect Zapier-authored rows and could create duplicates for any
payout Zapier already logged.

Plan: validate with dry runs first (below), confirm the parsing/routing
looks right, then have Jeremy turn off the overlapping Zaps, then enable the
daily schedule for real.

## 5. Testing before going live

`workflow_dispatch` defaults to `dry_run: true` — it parses real inbox
messages, checks Airtable for existing matches, and prints exactly what it
*would* write and which label it *would* apply, without calling the
Airtable write API or modifying any Gmail message. Run it manually from the
Actions tab (or `DRY_RUN=true python scripts/sync_accounting_emails.py`
locally with the secrets exported) and review the log output before
disabling Zapier and flipping to real runs (the daily `schedule` trigger
always runs for real — `DRY_RUN` only defaults true on manual dispatch).
