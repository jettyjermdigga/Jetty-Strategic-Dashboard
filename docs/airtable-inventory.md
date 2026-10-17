# Airtable inventory — 17 Oct 2026

Run to answer one question: should Jetty's Airtable forms move into the Jetty
Dash, and does that start with rebuilding the CRM?

Short answer: **no, and no.** The forms are a symptom. What follows is the map.

---

## 1. The number

**209 bases.**

That is the finding. Not "a lot of forms" — 209 separate databases, each with
its own tables, its own permissions, and no connection to any of the others
unless somebody built one by hand.

| | count |
|---|---|
| Total bases | 209 |
| Opened by you at some point in 2026 | 48 |
| Never opened by you at all | 116 |
| Sitting in a duplicate/near-duplicate cluster | 36 |
| Explicitly named OLD / Copy / Archive / Sandbox / Testing | 20 |

### A caveat that matters

The "opened" dates are **your** view timestamps, not the company's. A base
Cory or Tyler uses every morning shows nothing here if you have not opened it.
So read the 116 as *"you are not the one keeping these alive"*, **not** as
*"these are dead."* Deciding which are genuinely dead needs the other seven or
eight people who use Airtable, not me.

---

## 2. Duplicate clusters (verified, by name)

36 bases sit in one of these. Each cluster is at minimum a question about
which copy is authoritative.

| cluster | copies |
|---|---|
| 700 WMS | `(In Progress)`, `(In Progress) (Copy)`, `(Testing)(V3)` |
| Product Mothership | `Product Mothership`, `(Copy)`, `(Copy)` |
| PTO Request Form | `PTO Request Form`, `(November 3, 2022)` |
| Campaign Manager | `Campaign Manager`, `(NEW)` |
| THE BUDGET | `THE BUDGET`, `(NEW)` |
| JRF BUDGET | two bases, identical name |
| Marketing Campaign Tracking | two bases, identical name |
| Merch Planning | two bases, identical name |
| Competitive Set | two bases, identical name |
| NRI Supply Inventory | two bases, identical name |
| Timed Tasks | two bases, identical name |
| S20 Sell Through | two bases, identical name |
| Inventory Hub | `Inventory Hub`, `(Copy)` |
| eComm Picking | `eComm Picking`, `(Copy)` |
| Jetty INK Operations | `Jetty INK Operations`, `(Copy)` |
| 2023 Project Tracker | `2023 Project Tracker`, `Archive -`, `Sketch` |
| Penn National | `(2023)`, `(2025)` — probably legitimately annual |

Seven clusters are **two bases with the exact same name**. Nobody can tell
those apart from a list; you have to open both.

---

## 3. Where the forms actually are

This is the part that changes the plan.

Airtable has two kinds of form, and yours are the older kind:

- **Interface forms** — live in an Interface, enumerable through the API.
- **Classic form views** — a view on a table, like a grid or calendar view.

I checked the PTO base. Its form is `PTO Request + Sick Time`, **type: form**,
sitting as the second of eight views on the table. That is a classic form
view. The base has **no interfaces at all.**

Interface forms I did confirm:

- **`2026 Jetty Summer Internship Application`** (base: Summer Intern
  Application) — writes to an `Intern Applications` table.
- **`Model Inquiry Form`** (base: Model Database) — writes to a `Models`
  table. This is the one already linked from the dash.

**What this means:** a complete form census needs one API call per *table*,
not per base — several hundred calls. I was rate-limited partway through and
stopped rather than hammer it. Finishing it is mechanical and I can do it on
whatever subset you name.

---

## 4. The form-shaped fracture, in one example

The PTO base is the whole problem on one screen:

- `Employee Name` is a **plain text box.** Not a link to the Staff table —
  which is in a different base entirely. Nothing joins a PTO request to a
  person.
- Its newest columns are `2022 PTO`, `2022 Used PTO`, `2022 Used Sick`.
  `Sick Time Counter 2022`, `Sick Time Counter 2023` are separate views.
- A second base, `PTO Request Form (November 3, 2022)`, sits beside it.

Somebody needed a form. They made a base. The data landed on an island and
the island drifted.

---

## 5. Where contact records live

### Wholesale — healthy, do not touch

`Commercial Sales New` is a real CRM and by far your most developed one:

| table | fields |
|---|---|
| Shop Name | **258** |
| Contact | **147** |
| Salesperson | **103** |
| Daily Order Log | 45 |
| Order Portal | 44 |
| Weekly Order Log | 40 |
| POP | 36 |
| + 18 more (Territory, State, Promo, ReSale Certs, Ink Retailers…) | |

It also carries its own graveyard inside it: `x Old Contact x` (80 fields),
`x Shop x` (65 fields), `Order Archive`, plus `Old Retailers` and
`XX Commercial Sales Old` as separate bases.

**This is years of accumulated structure and your team edits it in a grid
every day. Rebuilding this is not on the table.**

### Staff — two copies of the same people, including the sensitive parts

The `Staff` base has three tables, and two of them are near-identical:

- **`Staff`** — ~130 fields
- **`Org Chart (2027)`** — ~95 fields, overwhelmingly the *same* fields

Both contain `SS#`, `I-9 Documents`, `Address`, `DOB`, salary history
(`2021`–`2025`), `Health Plan`, `401K`, and `Marital Status`.

**Two copies of staff social security numbers and I-9 attachments, in two
tables, in one base.** That is worth dealing with regardless of anything in
this document, and it is not a forms problem.

The `Staff` table has also absorbed form answers as columns:

- `2024 - What problems are you or your department facing?`
- `2024 - What can Jetty do better?`
- `2024 - Reaction to compensation?`
- `Are you willing to participate as a fit model…?`
- `Are you okay with being featured on Jetty's social media channels?`

That is the other half of the fracture: survey responses glued onto the master
record as year-stamped columns, so next year needs new columns.

And `HR Tracker` is a **separate base** from `Staff`.

### Community — scattered

No single place for a person who is not staff and not a retailer. At minimum:
`Ambassador`, `Model Database`, `Sponsors & Planned Giving`,
`Sponsors/Donors List & Countertop Donations`, `JRF Donations Tracker`,
`Summer Intern Application`, `Career Application`, `Job Application (OLD)`,
`Fit Model Survey`, `JRF Photo/Video Release`, plus a person-holding table in
most of the ~15 event bases (Chowderfest, Clam Jam, Shellabration,
Crabbin' for a Cause, HopSauce, Coquina Jam, Bridge Walk, Paws for a Cause…).

---

## 6. What I would actually do

**Not** rebuild the CRM, and **not** port the forms.

1. **Fix the duplicated PII first.** Two tables holding SS numbers and I-9
   documents is the only item here with real exposure. It is independent of
   everything else and it is a morning's work.

2. **Name the three spines.** Retailers (`Commercial Sales New` — exists,
   leave it), Staff (`Staff` vs `Org Chart (2027)` vs `HR Tracker` — pick
   one), Community (does not exist — this is the real build).

3. **Re-point forms, don't rebuild them.** Keep the Airtable form. Change
   `Employee Name` from a text box to a linked record against Staff. Roughly
   an afternoon per form, and it is most of the value.

4. **The dash is the front door.** Each form becomes a Link. That is what the
   Links section was built for last week.

5. **Only then**, move the handful of forms where the dash genuinely wins —
   see below.

### Where the dash beats an Airtable form

One thing, and it is narrow but real: **the dash already knows who you are.**
Cloudflare Access verified the identity before the page rendered.

A PTO form on the dash never asks "Employee Name." It stamps the signed-in
address, which cannot be mistyped, left blank, or filled in for somebody else
— the exact failure in the PTO base today.

That applies only to **staff-facing** forms: PTO, gear allowance, expenses, IT
requests, reviews. Maybe 5–10 forms. For the Model Inquiry Form there is no
identity to use, so Airtable stays better.

**The sweet spot:** the dash hosts those forms and writes **into Airtable** via
the API. Identity-stamped submissions landing in the spine, and nothing new
fractures.

---

## 7. What is verified vs. inferred

Being explicit, because some of the above is a name-pattern guess.

**Verified by reading the actual schema:**
- The 209-base list and every name/ID in it
- `Commercial Sales New` — all 25 tables and field counts
- `PTO Request Form` — both tables, all fields, all eight views
- `Staff` — all three tables and all fields
- Interface forms in: Summer Intern Application, Model Database,
  JRF Photo/Video Release (none), JETTY HUB (dashboard only, no forms),
  PTO Request Form (none)

**Inferred from names and your view timestamps only:**
- Which bases are dead
- The duplicate clusters (names match; I did not diff their contents)
- Which of the ~190 unexamined bases hold contacts or forms

**Not done:** the full form census. It needs a call per table across 209
bases, and Airtable rate-limited me partway. Say the word and I will grind
through whatever subset you care about.
