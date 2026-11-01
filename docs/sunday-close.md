# The Sunday close

What gets done each Sunday to close the prior retail week, update the
workbook, and leave the Strategic Dashboard telling the truth.

Written down while doing it, step by step, so the parts worth automating
can be told apart from the parts that are judgement.

Each step is tagged:

- **AUTOMATABLE** — a machine could do the whole thing today.
- **BLOCKED** — a machine could do it, but something has to be fixed first.
- **JUDGEMENT** — somebody has to decide. Automate the fetching around it,
  never the decision.

---

## Already automatic, for the avoidance of doubt

The published dashboard rebuilds itself. `.github/workflows/update.yml`
polls the workbook's Drive `modifiedTime` every five minutes and rebuilds
when it moves. Saving the `.xlsb` is the whole publish step; there is
nothing to press. See `docs/dashboard-auto-rebuild.md`.

---

## 1. Post the prior week's INK revenue to Xero — **BLOCKED**, by one scope

**What happens now.** An Airtable automation emails the booked INK revenue
for the week that just closed, every Sunday at about 02:30. Log into Xero,
go to Manual Journals, and post:

| | Account | Debit | Credit |
|---|---|---|---|
| | A/R - Jetty Ink (AR) | the figure | |
| | Screen Printing Revenue (292) | | the figure |

Two things have to be changed by hand on every entry, and they are the two
that are easy to get wrong:

- **The narration**, which reads `Weekly INK Sales MM/DD/YY to MM/DD/YY` and
  has to name the week that closed.
- **The date**, which is the **Saturday** the week ended, not the day the
  entry is posted. Posting on Sunday with Sunday's date puts the revenue in
  the wrong week, and the wrong month four times a year.

The retail calendar decides both. `dash/worker/retail.js` has it:
`weekStart(year, week)` returns the Sunday, and the Saturday is six days
later. Nothing has to be counted by hand.

**Why it is automatable.** Xero's `ManualJournals` endpoint creates exactly
this, and the figure already exists in Airtable — the email is a
notification of a record, not the record itself. So the whole step is:
read the closed week's booked revenue from Airtable, post one journal to
Xero, on a Sunday cron.

**What is blocking it.** One scope, and a consent screen.

The earlier blocker — 403 with an empty body on every accounting call — is
gone, and it was never about scopes. The app was a Web app with no
organisation authorised against it, and a `client_credentials` token on one
of those carries the full granted scope list while reaching no books at all.
It is connected to Jetty Life, LLC now and reads invoices, payments and the
chart of accounts.

What it holds is read-only: `accounting.invoices.read`,
`accounting.payments.read`, `accounting.settings.read`. Posting a journal
needs `accounting.manualjournals`, which the app **is permitted to request**
— it is on its Configuration page — and which was deliberately left out of
the consent, on the grounds that a module that can only read cannot write
anything wrong.

So unblocking this is one line in `XERO_SCOPES` and pressing Connect Xero
again to re-consent. Worth doing deliberately rather than in passing: it is
the moment this stops being a module that reads the books and becomes one
that writes them.

**Residual judgement:** none. The figure is given, the accounts never
change, and the dates follow the calendar.
