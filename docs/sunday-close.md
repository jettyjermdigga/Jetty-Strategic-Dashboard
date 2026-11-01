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

## 1. Post the prior week's INK revenue to Xero — **BLOCKED**

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

**What is blocking it.** The Xero Custom Connection answers 403 with an
empty body on every accounting call, with or without an empty
`xero-tenant-id` header. The token is good and its scopes are confirmed;
see `commissions/README.md` and `/api/xero/probe`. Until that is resolved
nothing can be posted to Xero by machine.

Worth knowing for when it is: the connection's grant already includes
`accounting.manualjournals` — write, not just read — so no new Xero app is
needed for this.

**Residual judgement:** none. The figure is given, the accounts never
change, and the dates follow the calendar.
