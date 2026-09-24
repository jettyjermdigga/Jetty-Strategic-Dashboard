# Company calendar

The calendar is the first thing on this site that stores data of its own. The
financial dashboard is a pure build artifact — it is regenerated from the master
budget on every deploy, so nothing typed into it could survive. Calendar items
are typed in by people, so they live in a Cloudflare D1 database behind a Worker.

## Shape of the site

`wrangler.toml` used to be assets-only. It now also has a Worker script, so the
site has three URLs instead of one:

| URL | Served by | What it is |
|---|---|---|
| `/` | `output/index.html` | Landing page listing the internal tools |
| `/dashboard` | `output/dashboard.html` | The financial dashboard (was at `/`) |
| `/calendar` | `output/calendar.html` | The calendar app |
| `/api/*` | `worker/index.js` | Calendar read/write API |
| `/calendar.ics` | `worker/index.js` | Feed for Google Calendar |

Static paths are served by the assets binding without the Worker running. Only
`/api/*` and `/calendar.ics` reach the script.

Anyone with the old bookmark lands on the landing page and is one click from the
dashboard.

## Where the pieces live

- `worker/index.js` — routing, the items API, the ICS endpoint
- `worker/access.js` — works out who is making a request
- `worker/taxonomy.js` — categories, types, divisions; the one source of truth
- `worker/ics.js` — ICS generation
- `worker/schema.sql` — the `items` table, applied lazily on the Worker's first
  request, so there is no migration step to run
- `site/` — the landing page and calendar front end, copied into `output/` by
  `scripts/build_site.py`

Adding a category or a type means editing `worker/taxonomy.js` and nothing else.
The filter sidebar, the add form and the ICS descriptions are all built from it.

## Who can do what

Cloudflare Access already sits in front of the whole site, so anyone who can
load the page is signed in. On top of that:

- **Everyone** who gets in can read the calendar and subscribe to the feed.
- **Editors** — the emails in `CALENDAR_EDITORS` in `wrangler.toml` — also see
  the *Add item* and *Import* buttons, and can edit and delete.

Every item records who created it and who last changed it.

Writes are checked on the server, not just hidden in the UI. By default the
Worker reads the email out of the `Cf-Access-Authenticated-User-Email` header,
which only Access sets. That header is trustworthy exactly as far as Access is
the only way to reach the Worker — so the Worker can also verify the signed
Access JWT instead, which does not depend on that assumption. See setup below.
Until it is switched on, the calendar shows a notice saying so.

## Setup still to do in Cloudflare

Nothing here blocks a deploy — the site ships without any of it and the calendar
explains what is missing.

**1. Let the deploy token create the database.** `scripts/provision_d1.py` runs
before `wrangler deploy`: it creates the `jetty_calendar` D1 database the first
time and writes its id into `wrangler.toml` on every run after that, so no id is
ever committed. It needs `D1:Edit` on the token stored as `CLOUDFLARE_API_TOKEN`
(Cloudflare dashboard → My Profile → API Tokens). If the token cannot do it, the
script strips the D1 binding and logs a warning rather than failing the deploy —
the dashboard and the site still ship, and the calendar reports that its database
is not connected.

**2. Turn on the Google Calendar feed.** Set the `ICS_KEY` secret on the Worker:

```
wrangler secret put ICS_KEY      # any long random string
```

Without it `/calendar.ics` returns 503, and with the wrong key it returns 404.

**3. Let Google fetch the feed.** Google's servers have no Access session, so
`/calendar.ics` needs a **Bypass** policy on that path in Zero Trust → Access →
Applications. The key in the URL is what protects it, which is why it should be
long and random. Treat the subscribe link like a password: anyone holding it can
read the calendar without signing in.

Google refreshes subscribed calendars on its own schedule — often a few hours,
sometimes longer. The feed advertises a one-hour refresh interval, but Google
treats that as a hint. The page itself is always current; the Google copy lags.

**4. Verify identity properly.** Fill in `ACCESS_TEAM_DOMAIN` (your Zero Trust
team domain, e.g. `jetty.cloudflareaccess.com`) and `ACCESS_AUD` (the Application
Audience tag on the Access application in front of this Worker) in
`wrangler.toml`. The Worker then verifies the signed Access token against
Cloudflare's public keys instead of trusting the header.

**5. Add the people who should be able to add items.** `CALENDAR_EDITORS` in
`wrangler.toml`, comma-separated, matched case-insensitively.

## Importing a batch

*Import* takes a CSV paste — copy straight out of a spreadsheet. The first row
must be headers. Recognised columns:

```
title, category, type, division, start date, end date, all day,
start time, end time, location, owner, status, notes, url
```

Only `title`, `category` and `start date` are required. Dates are `YYYY-MM-DD`,
times are `HH:MM` on a 24-hour clock. A blank end date means a one-day item.
`category` and `division` take either the label or the key — `Events` and
`events` both work, as do `Company-wide` and `company-wide`.

Everything is validated before anything is written. If one row is wrong, nothing
is imported and the error names the spreadsheet row. That is deliberate: a
half-applied import is worse than a rejected one, because you cannot tell what
landed.

## Deploys

`.github/workflows/update.yml` now also runs on pushes to `main` that touch
`worker/`, `site/`, `scripts/`, `wrangler.toml` or the workflow itself. Before
this, deploys only happened when the budget workbook changed — which would have
left calendar and Worker changes sitting undeployed.
