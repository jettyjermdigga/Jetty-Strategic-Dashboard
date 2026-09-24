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
| Data | rebuilt from the workbook every time | entered by people, stored in D1 |

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
    taxonomy.js          Type, Event Type, Status -- one source of truth
    retail.js            the retail calendar
    ics.js               ICS generation
    schema.sql           the items table, applied on the Worker's first request
  tools/
    sheet_to_csv.py      turns a Jetty calendar spreadsheet into importable CSV
  public/                served as static assets; no build step
    index.html
    assets/              calendar.js/.css, brand CSS, fonts, logo
```

There is no build step. `public/` is deployed as-is.

## Structure

Three axes, because the menu spreadsheet's second level held three different
kinds of thing.

**Event Types** are the calendars themselves, and they are **peers** — no
primary, no owner. Coquina Jam is a JRF event that the Box Truck always works,
and naming either one the owner would misdescribe how it runs. An event carries
every Event Type involved and shows on each of their calendars.

| | |
|---|---|
| Box Truck & Events | Mobile store and/or tent setup selling Jetty/JRF apparel |
| Flagship Store | Events at our brick-and-mortar store |
| Long Branch Store | Events at our brick-and-mortar store |
| Jetty Rock Foundation (JRF) | Fundraising events/initiatives involving our nonprofit |
| Jetty INK | Live screenprinting and/or non-brand apparel sales |
| Wholesale | Tradeshows, sales trips and other industry events |
| Marketing | MKG-specific events the team plans against |
| Meetings | Milestone meetings with mixed departments |
| Logistics, ProDev | from the menu's Meetings sub-list |
| Culture | Team-building |

A meeting for one department is tagged **Meetings + that department**, so it
lands on both calendars. That is why the menu's Meetings sub-list has no separate
existence here: six of its eight entries were already Event Types.

**Sub-types** say what kind of item it is and are scoped to one Event Type.
Only Marketing has them so far — Ambassador, Influencer, Promotion, Campaign,
Email/SMS, Photo/Video, Collab — and they are only offered once Marketing is
ticked.

**Needs** are what an event requires, and cut across every calendar: Drifting
Buoy, Social Permit, Sound, Jetty Brewing Company. "Do we need the mobile bar?"
is a fair question of a box truck event and a JRF event alike, which is why
Drifting Buoy appeared under two parents on the menu sheet. JBC arrived in the
sheet's Event Type column but is a need too — a reminder that the event wants our
own branded beer — so the import routes it here rather than making it a calendar.

## Fields

| Field | Sheet column | Notes |
|---|---|---|
| Event name | Name | required |
| Status | Booked | the checkbox: ticked is **Booked**, blank is **Pending** |
| Event Type | Event Type | one or more, all peers — at least one required |
| Sub-type | — | scoped to its Event Type |
| Needs | — | cross-cutting |
| Start / end date | Event 🚀 / Event 🛑 | |
| Start / end time | Start ⌚ / End ⌚ | 24-hour on the way in |
| Venue, Address, City, State, Zip | same | |
| Notes, Link | — | additions, not on the sheet |

The sheet's `Type` column held one value for the whole calendar; Event Type
carries that now, so the column is read and discarded rather than reported as an
unrecognised header.

## The retail calendar

Week 1 of 2026 runs Sunday 4 January to Saturday 10 January, anchored in
`worker/taxonomy.js`. Other years step 364 days from it; a 53-week year will need
its own entry.

**Year, Week, Start (Week), End (Week), Month and Day are derived, not stored.**
All six are functions of the event date, and the calendar computes them on read.
Retail-week filtering works exactly as before — a Week view, a `Wk` box in the
toolbar that jumps to any week, the week on every event — without anyone typing
a week number.

That is not only tidier. The 2026 sheet already disagrees with itself in three
places: one week number off by one, and two weekday labels that do not match
their own dates. That is what happens when the same fact is entered twice. An
import reports such disagreements and then ignores those columns.

## Colour

Each event's chip carries **one colour band per Event Type**, so an event that is
both a JRF event and a Box Truck event says so instead of being forced into one
colour. Events with a single Event Type get a solid band, so a calendar still
reads as one thing. *Colour by* can be switched to Status.

The palette is a validated categorical set, not a hand-picked one. Both modes
pass the lightness band, the chroma floor, the normal-vision separation floor and
— in dark — 3:1 contrast against the surface. Two adjacent pairs sit in the 6–8
CVD separation band, which is only legal because colour is never the sole
encoding here: every day, week and agenda row prints the Event Type names, the
sidebar pairs each dot with its label, and the detail view lists them as labelled
chips.

The light and dark steps are declared as CSS custom properties, so the two modes
swap in one place. **The order of `EVENT_TYPES` is the order bands stack in, and
the palette was validated on exactly that adjacency — reordering that array means
revalidating it.**

Event Types are stored in taxonomy order, not the order the sheet lists them.
That matters because the sheet has both `Box Truck,JRF` and `JRF,Box Truck`;
sorting makes those the same value, which is what they always meant.

## Changing the structure

`worker/taxonomy.js` is the only place Type, Event Type and Status are defined.
The filter sidebar, the add form, the colour coding and the Google Calendar
descriptions are all generated from it. Adding a department is one line.

## Loading a spreadsheet

```
python tools/sheet_to_csv.py "Calendar & Events - BOX TRUCK.xlsx" -o events.csv
```

Then paste `events.csv` into **Import** on the calendar.

The converter handles three things that are easy to get wrong by hand:

* **Times have lost their meridiem.** Excel stores them as a 12-hour clock with
  no am/pm, so a 1:00 start reads as one in the morning. The cells that survived
  as text (`6pm`, `9:30am`, `11am`) give the rule: a start between 7 and 11 is
  morning, everything else is afternoon or evening. That rule puts the end after
  the start on every row of the 2026 sheet.
* **Zips have lost their leading zero** — stored as numbers, so 08260 comes back
  as 8260. Every New Jersey zip is affected.
* **Cells containing a comma** sometimes arrive wrapped in quote marks, which
  would otherwise show up in Google Calendar.

Everything it changes or ignores is printed, so nothing is altered silently.

You can also paste the raw sheet straight into **Import** — the recognised
headers include the sheet's own spellings, emoji and all. Either way every row is
validated before anything is written: if one row is wrong, nothing is imported
and the error names the spreadsheet row. A half-applied import is worse than a
rejected one, because you cannot tell what landed.

## Who can do what

Cloudflare Access sits in front of the whole Worker, so anyone who loads the
page is signed in.

- **Everyone** who gets in can read the whole calendar and subscribe to the feed.
  The Event Type filters narrow the view; they are not access control.
- **Editors** — the emails in `CALENDAR_EDITORS` in `wrangler.toml` — also see
  *Add event* and *Import*, and can edit and delete.

Every event records who created it and who last changed it. Writes are checked on
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

## Local development

```
npx wrangler@4 dev --local
```

Set `REQUIRE_IDENTITY = "false"` in a local config copy, or send a
`Cf-Access-Authenticated-User-Email` header, or the Access gate will refuse
every request.
