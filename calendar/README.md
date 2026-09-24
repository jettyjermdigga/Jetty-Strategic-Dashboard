# Jetty Company Calendar

A standalone Cloudflare Worker. It shares nothing with the Strategic Dashboard —
separate Worker, separate hostname, separate database, separate deploy workflow.
Calendar work cannot disturb the dashboard, and a dashboard rebuild cannot touch
the calendar.

| | Strategic Dashboard | Company Calendar |
|---|---|---|
| Worker | `jetty-strategic` | `jetty-calendar` |
| Deploys on | the budget workbook changing | pushes to `calendar/**` |
| Workflow | `.github/workflows/update.yml` | `.github/workflows/calendar.yml` |
| Data | rebuilt from the workbook every time | typed in by people, stored in D1 |

The dashboard's Events tab still reads Airtable for historical event revenue.
That is untouched and stays where it is.

## Layout

```
calendar/
  wrangler.toml          Worker config (D1 id is injected at deploy time)
  provision_d1.py        creates the database, injects its id
  worker/
    index.js             routing, items API, ICS feed, the Access gate
    access.js            works out who is making a request
    taxonomy.js          categories, types, divisions -- one source of truth
    ics.js               ICS generation
    schema.sql           the items table, applied on the Worker's first request
  public/                served as static assets; no build step
    index.html
    assets/              calendar.js/.css, brand CSS, fonts, logo
```

There is no build step. `public/` is deployed as-is.

## Changing the categories

`worker/taxonomy.js` is the only place any of it is defined. The filter sidebar,
the add form, the colour coding and the Google Calendar descriptions are all
generated from it. Adding an event type is one line in one array.

The categories currently in there are a **placeholder** — a plausible starting
set, not Jetty's real one. They get replaced once the real definitions arrive.

## Who can do what

Cloudflare Access sits in front of the whole Worker, so anyone who loads the
page is signed in.

- **Everyone** who gets in can read the calendar and subscribe to the feed.
- **Editors** — the emails in `CALENDAR_EDITORS` in `wrangler.toml` — also see
  *Add item* and *Import*, and can edit and delete.

Every item records who created it and who last changed it. Writes are checked on
the server, not merely hidden in the UI.

The Worker **fails closed**: a request that arrives with no Access identity gets
nothing but a page explaining what is missing. A new `workers.dev` hostname is
reachable by anyone until an Access application is put in front of it, and the
calendar should not be readable during that window. `/calendar.ics` is the one
exemption, because Google's fetchers carry no session; its unguessable key is
what protects it.

## Setup in Cloudflare

**1. Give this Worker its own Access application.** The dashboard's application
covers the dashboard's hostname only. Zero Trust → Access → Applications → add a
self-hosted application for the calendar's hostname, then add the people who
should be able to open it. Until this exists the calendar serves nothing.

**2. Add a Bypass policy for `/calendar.ics`** on that application, so Google
Calendar can read the feed without a session.

**3. Set the feed key.** From this directory:

```
wrangler secret put ICS_KEY      # any long random string
```

Without it `/calendar.ics` returns 503; with a wrong key it returns 404.

**4. Let the deploy token create the database.** `provision_d1.py` runs before
`wrangler deploy`: it creates the `jetty_calendar` D1 database the first time and
writes its id into `wrangler.toml` on every run after that, so no id is ever
committed. It needs `D1:Edit` on the token stored as `CLOUDFLARE_API_TOKEN`
(Cloudflare dashboard → My Profile → API Tokens). If the token cannot do it, the
script strips the binding and warns rather than failing the deploy — the calendar
loads and says its database is not connected.

**5. Verify identity properly.** Fill in `ACCESS_TEAM_DOMAIN` (your Zero Trust
team domain, e.g. `jetty.cloudflareaccess.com`) and `ACCESS_AUD` (the Application
Audience tag on the application from step 1) in `wrangler.toml`. The Worker then
verifies the signed Access token against Cloudflare's public keys instead of
trusting the header it sets. Until both are filled in, the page says so.

**6. Add the editors.** `CALENDAR_EDITORS` in `wrangler.toml`, comma-separated.

## Google Calendar

*Subscribe* hands out a URL to paste into Google Calendar under
Other calendars → **+** → **From URL**.

Google refreshes subscribed calendars on its own schedule — often a few hours,
sometimes longer. The feed asks for hourly, but Google treats that as a hint. The
page is always current; the Google copy lags. Treat the subscribe link like a
password: anyone holding it can read the calendar without signing in.

## Importing

*Import* takes a CSV paste — copy straight out of a spreadsheet. First row is
headers. Recognised columns:

```
title, category, type, division, start date, end date, all day,
start time, end time, location, owner, status, notes, url
```

Only `title`, `category` and `start date` are required. Dates are `YYYY-MM-DD`,
times are `HH:MM` on a 24-hour clock. A blank end date means a one-day item.
`category` and `division` accept either the label or the key — `Events` and
`events` both work.

Everything is validated before anything is written. If one row is wrong, nothing
is imported and the error names the spreadsheet row. A half-applied import is
worse than a rejected one, because you cannot tell what landed.

## Local development

```
npx wrangler@4 dev --local
```

Set `REQUIRE_IDENTITY = "false"` in a local config copy, or send a
`Cf-Access-Authenticated-User-Email` header, or the Access gate will refuse
every request.
