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

Five axes, from the decision tree.

**Event Type** is what kind of item this is. Exactly one per item, and it decides
which questions the form asks.

| | |
|---|---|
| Events & Marketing | Anything that happens in the world, and the marketing around it |
| Meetings & Deadlines | Internal. Asks for far less — who, when, and nothing more |

**Departments** are whose calendar it is. One is the **primary** — it owns the
event and gives it its colour — and any number of others come along for the ride,
shown as small dots rather than colour. The Long Branch Spring Cleaning Sale is a
store event that Marketing promotes, not a joint one.

| | |
|---|---|
| Box Truck | Mobile store and/or tent setup selling Jetty/JRF apparel |
| Flagship Store | Events at our brick-and-mortar store |
| Long Branch Store | Events at our brick-and-mortar store |
| Jetty Rock Foundation | Fundraising events/initiatives involving our nonprofit |
| Jetty INK | Live screenprinting and/or non-brand apparel sales |
| Wholesale | Tradeshows, sales trips and other industry events |
| Marketing | MKG-specific work the team plans against |
| Logistics | |
| Product Development | |
| Culture | Team-building |
| Finance | |

Meetings is no longer a department: a meeting is an Event Type, and it still
belongs to whichever department called it.

**Sub-types** belong to a department. Only two have any — Wholesale has
Tradeshow, and Marketing has Campaign, Promotion, Email, SMS, Photo/Video,
Collab, Ambassador, Influencer and Website. The form offers the sub-types of
**every** department on the event, not only the primary one, so a store sale that
Marketing promotes can still be a Promotion without Marketing having to own it.

**Needs** are what an event requires, asked by the department that answers for
them: **Extra staff needed** (Box Truck, with a count) and **Social Permit** and
**Sound** (Jetty Rock Foundation). They are offered as soon as that department is
on the event, primary or not — the Box Truck still needs its staff when it is
working someone else's event.

**Vehicles** — Box Truck, INK Van, Brand Transit — are unscoped. Whose event it
is has no bearing on what has to be driven there.

**Status** is Booked, Pending or Cancelled. A cancelled event stays on the
calendar struck through rather than being deleted, so the day it was meant to
happen still answers "what happened to that?".

## Adding an item

Adding is an interview: one question at a time, in the decision tree's order,
with later questions shaped by earlier answers. Editing is not — every answer
already exists, so the whole form is shown at once.

1. What kind of item is this?
2. What is it called?
3. Whose is it? *(the primary department)*
4. Anyone else involved?
5. What kind of item is it for them? *(skipped when no department on the event has sub-types)*
6. When is it? *(retail week, month and day are derived on screen from the start date)*
7. Where is it?
8. What does it need? *(needs, the staff count if asked for, and vehicles)*
9. Anything else? *(status, link, notes)*

A **Meetings & Deadlines** item takes the short form — steps 1, 2, 3, 6 and 9 —
and the fields it skips are cleared on write rather than merely hidden, so what
is stored matches what the form showed.

**Required**: name, primary department, a start date. Everything else can be
filled in later.

There are two ways in: the **+ Add event** button, or clicking open space in the
calendar — an empty month cell, or the add row on a day in week and day view. All
of them are editors-only.

## Fields

| Field | Notes |
|---|---|
| Event name | required |
| Event Type | exactly one; defaults to Events & Marketing |
| Department | the primary one — required, sets the colour |
| Also involved | any number of other departments |
| Sub-type | scoped to the departments on the event |
| Needs | scoped to the department that answers for them |
| Extra staff | a count, only when that need is ticked |
| Vehicles | unscoped |
| Status | Booked (the default), Pending or Cancelled |
| Start / end date | required start |
| Start / end time | 24-hour on the way in |
| Venue, Address, City, State, Zip | events only |
| Notes, Link | |

## Filtering

Each section in the sidebar asks one question, and the sections narrow together:
an event shows when it passes every section that is asking something.

A section with **nothing ticked has stopped asking**, so it stops narrowing — its
summary reads `any`. Without that, clearing one section blanked the whole
calendar however much was ticked in the others, which is a dead end you can only
get out of by guessing which section did it. "Show me the ones with none" is a
row of its own in each section, so "nothing ticked" has no second job to do.

Within a section, an event passes if **any** of its values is ticked. Untick
Marketing and you lose the campaigns Marketing owns, but you keep the store sale
it only promotes — that event is still the store's.

Each person's ticks are remembered in their own browser. What is stored is the
set of boxes turned **off**, so a department added later starts on for everybody
rather than being invisible to whoever was here first.

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

Each event carries **one colour, its primary department's** — the department that
owns it. The other departments involved show as small dots beside the title, so
the event still reads as one department's at a glance while saying who else turns
up. An event with no department at all is grey rather than borrowing somebody's.

Colour always means department. Pending items are marked by a faded band and an
italic title, cancelled ones by a strikethrough — so colour never has two jobs.

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

`worker/taxonomy.js` is the only place the five axes and Status are defined. The
filter sidebar, the add form's questions, the colour coding and the Google
Calendar descriptions are all generated from it. Adding a department is one line
— though a new department also needs a colour, and the palette is a validated
set, so run it back through the validator rather than picking one by eye. The
order of `DEPARTMENTS` is load-bearing: separation is measured between
neighbours in that list, and at eleven colours only a few positions are free.

Scoping is data, not code: a sub-type or need names its `department`, and the
form works out which questions to ask from that.

## Airtable after the backfill

The Airtable calendar is retired for **planning**: events, meetings and
marketing items are entered here from now on, and nothing syncs between the two.

It is **not** retired for **results**. `scripts/build_dashboard.py` reads event
revenue, orders and fees from the same `Calendar & Events 🗓` table to build the
Strategic Dashboard's Events tab, so after an event runs, its takings still get
recorded in Airtable. Planning here, results there.

One thing to watch: the dashboard matches events by name and date, and the
existing data already spells the same event several ways — *Rocking the Docks*
and *Rocking The Docks* both appear. With planning and results now in two
systems, a name typed differently in each is the way they quietly stop lining
up. Copying the name from the calendar is worth the second it takes.

## Backfilling from Airtable

`Calendar & Events 🗓` in the JETTY HUB base holds 14,279 records going back to
2013, 594 of them dated in 2026. That is the backfill source:

```
export AIRTABLE_API_KEY=pat...
python tools/airtable_import.py --from-year 2026 -o events.csv
```

Then paste `events.csv` into **Import**.

This is a **one-time backfill, not a sync.** Airtable stops being the source once
the rows are in; nothing writes back, and running it twice duplicates events
rather than updating them.

The script maps as little as it can. Airtable's own labels — `Box Truck`, `JRF`,
`WHSL`, `Event`, `JBC` — are the values `worker/taxonomy.js` already recognises,
so they pass through untouched and the Worker resolves them. That keeps the
taxonomy in one file rather than two that drift. What it does handle:

* **Times are plain text in Airtable** (`1:00`, `6pm`, `9:30am`), so the missing
  am/pm starts there, not in Excel. Same rule either way: a start between 7 and
  11 is morning, everything else afternoon or evening.
* **Two Event Type values belong on other axes** — JBC is a need, Ambassador is
  a sub-type.
* **Four Event Type values are retired**: Brand, Deadline, Window, Women's. They
  carry one 2026 record between them, and it is tagged JRF as well, so dropping
  them loses nothing. Each drop is reported.
* **Needs come from three fields** — `Setup Needs` plus the two Yes/No questions
  — and are merged into one.

A record left with no Event Type after mapping is reported and skipped, never
guessed at.

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
page is signed in. The calendar is meant to be shared beyond staff — SunnySide
and other outside partners included.

- **Everyone** who gets in sees the **whole calendar** and can subscribe to the
  feed.
- **Editors** — the emails in `CALENDAR_EDITORS` in `wrangler.toml` — also see
  *Add event* and *Import*, and can edit and delete.

**There is no per-person scoping, and that is a deliberate choice.** The Event
Type filters are a view, not a permission: they change what is on screen, not
what the API returns. Anyone you add to the Access application can see every
calendar — JRF board meetings, staff and culture events, venue addresses, and
the permit, insurance and equipment needs on every event. The ICS feed is the
same: one key, the whole calendar, and anyone holding the link needs no sign-in
at all.

So the control is **who you add**, and adding someone is the whole decision.
If that ever stops being true — something goes on here that an agency should
not see — scoping has to be built before the next external login, not after.

Every event records who created it and who last changed it. Writes are checked
on the server, not merely hidden in the UI.

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

### How Access is attached, and why it took three tries

Access is set on the **Worker's own Access tab** — Workers & Pages →
`jetty-calendar` → **Access** → *Protect this Worker behind Access*, scoped to
**all traffic** rather than the "Previews only" default, which leaves production
public and is easy to miss.

A self-hosted application matched to the `jettycalendar.com` **hostname** does
not do this job. It authenticates the visitor perfectly well — Cloudflare's own
`/cdn-cgi/access/get-identity` returns their identity — but no
`Cf-Access-Jwt-Assertion` or `Cf-Access-Authenticated-User-Email` header reaches
the Worker, so the Worker has nothing to verify and refuses everyone. Adding the
Worker as a *destination* on such an application does not fix it either.

That failure is invisible from the Cloudflare side and looks exactly like "no
Access application exists", which is why the fail-closed page reports what the
Worker actually saw rather than asserting a cause.

The Worker's Access tab also states the precedence, which is documented nowhere
else this repo could reach:

1. Hostname policies
2. Worker policies
3. Account policies

Most specific wins. That is what makes the feed possible: a **hostname** policy
on `jettycalendar.com/calendar.ics` with action **Bypass** and include
**Everyone** beats the Worker-wide policy, so Google's fetchers get the feed
while everything else still needs a sign-in.

Do not use the account-wide Access toggle on the Workers & Pages sidebar. It
applies one policy across every Worker in the account, including the Strategic
Dashboard, which has its own.

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
