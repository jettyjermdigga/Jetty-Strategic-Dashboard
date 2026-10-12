# Jetty stack map

A working map of Jetty: who does what, the software and outside partners,
how money moves, and what has already left Airtable. It is the starting
point for moving systems over one at a time. Update it every time something
moves.

**Sources:**
- The Airtable bases `Software & Accounting Stack` and `JETTY HUB → Active Staff` (the org chart).
- This repo's code and docs.
- `notes/2026/wk40.md`.

**Status:** first draft, 2026-10-12. Anything marked **?** is a gap or an
assumption that still needs checking.

---

## 1. The map at a glance

```
                         ┌──────────────── Board of Directors ────────────────┐
                         │ Craig Clifford · Paul Clifford (board-level)       │
                         └─────────────────────────┬──────────────────────────┘
          Operating partners: Jeremy DeFilippis (CEO/CMO) · Cory Higgins (CCO) · John Clifford (CBO)
                                                   │
   ┌──────────────┬──────────────┬─────────────────┼────────────────┬───────────────┬──────────────┐
 BRAND: DTC    BRAND: WHSL    BRAND: ProDev &   JETTY INK       LOGISTICS       MARKETING      JRF
 Jettylife.com  Retailers +   Merch Planning    (screen print,  700 S Main      (in-house +    (nonprofit)
 Flagship       rep network                     private label)  warehouse       agencies)
 Long Branch
 Box Truck
     │              │               │                │              │               │             │
  Shopify Plus   Elastic +       Airtable          Printavo      Apparel Magic   Attentive     Shopify (JRF)
  Shop Pay       Apparel Magic   (PLM / Product    Printavo      Airtable WMS    Sunnyside     Stripe (JRF)
  Markets PRO    Stripe, GoCard. Mothership)       Payments      bases           Datmos (web)  CardPointe /
                                                                                               Give Smart
     └──────────────┴───────────────┴────────┬───────┴──────────────┴───────────────┴─────────────┘
                                             ▼
                        Xero (accounting source of truth) ← RAMP (cards, bill pay)
                        Banks: Columbia (operating + credit line) · BOA (cash) · TD Bank (JRF)
                                             ▼
                   Claude-built layer: Strategic Dashboard · Company Calendar · Ledger email sync
                   (GitHub Actions → Cloudflare Workers / D1 / R2 behind Cloudflare Access)
```

---

## 2. Entities and locations

| Entity | What it is | Domain / store |
|---|---|---|
| **Jetty Life, LLC**, the "Brand" side | Apparel and lifestyle brand: DTC plus Wholesale | jettylife.com · jettylife.myshopify.com |
| **Jetty INK**, under the same LLC | Private-label screen printing. It also runs client web stores (Playa Bowls, Ben Gravy) | JettyInk.com |
| **Jetty Rock Foundation (JRF)** | Nonprofit (environmental work, oysters/shell recycling, events). Has its own ledger, budget, bank and Shopify | jettyrockfoundation.org |
| Sub-brands and lines | Women's, YTI, Accessories, JBC / Brewing Co. (branded beer), Jetty Extracts **?** | |

| Location | Who works there |
|---|---|
| **176 E Bay, Manahawkin**, Flagship / HQ | Leadership, Marketing, ProDev, Merch Planning, Flagship Store, JRF |
| **700 S Main, West Creek**, warehouse | Logistics (eComm and WHSL outbound), Receiving, Inventory, CX, Events / Box Truck, in-house sales |
| **509 N Main, Manahawkin**, INK shop | INK sales, production, operations, post-production |
| **80 & 82 Ocean Dr, Pier Village, Long Branch** | Long Branch Store (opened mid-2025) |
| Remote | Accounting, WHSL sales director, rep network, INK design |

---

## 3. People and org chart

There are 107 "Active" rows in `JETTY HUB → Active Staff`. That count
includes department rows and outside firms as well as people. 93 more rows are
marked Quit / Not Active. The tree below follows the **Direct Supervisor**
field.

### Leadership
| Person | Role |
|---|---|
| Jeremy DeFilippis | CEO / CMO, operating partner. Owns Finance, Accounting, JRF, INK, Marketing (with John), Culture |
| Cory Higgins | Chief Commercial Officer, operating partner. Owns Logistics, Wholesale sales, Wholesale marketing |
| John Clifford | Chief Brand Officer, operating partner. Owns Product Development, Marketing (with Jeremy) |
| Craig Clifford, Paul Clifford | Board-level partners |

### Brand: DTC and retail (under Finance → Sales DTC)
- **David Bachowski**, Director of Jetty Retail
  - Flagship Store: **Brooke Carty** (Manager), then Tracy Harder (Lead), then Colin Fazio, Isabel Anderson, Italia La Placa, Kai Aceto
  - Long Branch Store: **Shawn Zappo** (Brand Experience Manager), then Maya Paco and Trevor Eyerkuss (leads), then Abigail Branstetter, Annabella Zolezzi, Brooke Wilbanks, Raul Pacheco
  - eCommerce Sales and eCommerce CX: **Luke Pacchia** (eComm CX Manager)
- Events / Box Truck: **Joe Mangino** (Sr. Director of Events), then Andrew Reiss (Event Lead)

### Brand: Wholesale (under Cory)
- **Paul Harvey**, Sr. Director of Wholesale Sales (remote)
  - In-house: **Dustin Henry** (In-house Account Manager), then Jordana Buchta
  - US reps (1099): AEZ Sales (Abbey Zito), Austin Olivares (SoCal), Brian Eskelson (PNW), Halcyon / Team Beach, Jim Compton (Rockies), LLM Sales (TOLA), NJP Associates (Midwest), Puerto Hermina (PR), Sandbox Metropolis (Northeast), Schulte Sales (SoCal), Skeleton Crew (NorCal), Stone Sales / Bouchard Group, T&L Action Agency (MINK), The Briones Group (W. Great Lakes)
  - Canada reps (1099): AgenC & Private Agent DnD (East), Dennis Regan (West)
- Wholesale CX: **Nicholas Miri**. Wholesale Outbound: **Michael Hambly**

### Brand: Product and merchandising
- **Lisa Joseph**, Director of Product Development and Women's Brand Director. Taylor Caruso (Associate Designer)
- **Colleen Schwarzenbach**, Sr. Director of Merchandise Planning (also co-owns Inventory Operations)

### Logistics (700 S Main, under Cory)
- **Joseph "JJ" McKenna**, Director of Logistics
  - eComm Outbound: **Courtney DeStefano**, then Katlynn Savi (eCommerce Manager)
  - Receiving and warehouse: **Adam Klimas** (Warehouse Lead), then Shane Biroc, Francis DeSena, Joshua Thomas
  - Inventory: **Tyler Minnich** (Inventory Control Manager)
  - Post-production: Matthew Johnson

### Marketing (under Jeremy and John)
- Social: **Arlynn Katz** (Social Media Manager)
- Video: **Kevin Lapsley** (Video Manager)
- Website and photography: **Katie Hehl** (Digital Design Manager)
- Content and PR: Black Sails Publications (Jon Coen, 1099)
- Agencies: see section 5

### Jetty INK (509 N Main, under Jeremy)
- **Bill McLennan**, Sr. Director of INK (operations)
  - Quality Control: Erik Schilling. Intern: Drew Bowker
- **Anthony Hediger**, Sr. Director of Sales (INK)
  - Dan Przygocki (Sr. Account Manager), then Frank Ritacco, then Collin Fredrickson
  - Showroom leads: Sarah Zavodsky, Matthew Moranz
- **Michael Eiche**, Sr. Director of Production
  - Troy Taylor (Production Manager), Jake Sudol (Press Operator), Brett Hunt (Lead Screen Tech)
  - Production associates: Hailey Klimas, Taryn Colfax, Joseph Latini, Michael Stingone, Mia Sisco, Isaac McLennan
- **Danny Morrin**, Sr. Director of Design (INK)
  - Karlee Dean (Graphic Design Manager), then Emma Homoki, plus Fresh Fish LLC (Beth Davis, freelance)

### Finance and accounting
- **Amy Delpriora**, Accounting Manager (remote), reporting to Jeremy

### Jetty Rock Foundation
- **Kyle Gronostajski**, Environmental Director (runs fundraising, events, design and marketing)
- **Jessica Petty**, Marketing Associate / Graphic Designer
- The Executive Director seat is open. Julia Tomelden is marked Quit.

### Org-chart data problems found
Several departments still list people marked **Quit / Not Active** as their head:
| Department | Listed head (inactive) |
|---|---|
| Flagship MKG, Long Branch MKG, Women's MKG, INK MKG, JRF MKG | Greg Waters, Marketing Communications Director |
| Advertising, Email / SMS | Joe Hodnicki, Sr. Advertising Director |
| Receiving | Tom Wilhelm, Director of Commercial Operations |
| Culture | Lee Byrd, President |
| PR, Ambassadors | Sean Loeben, Marketing Content Manager |
| INK production associates | Benjamin Wright, Lead Screen Tech |
| Women's | Sandra Vargas, Kate Santus |

**Question:** who owns Advertising, Email/SMS and Marketing Communications
today? Is it Jeremy directly, or through Sunnyside?

---

## 4. Software stack

Costs are from the `Software & Accounting Stack` base where it lists them.

### Systems of record
| Tool | Used for | Division | Annual cost | Owner **?** |
|---|---|---|---|---|
| **Shopify Plus** | jettylife.com (all eComm) and the POS for the stores and Box Truck **?**. Also hosts INK client stores, JettyInk.com and jettyrockfoundation.org | Brand, INK, JRF | $24,000 | |
| **Apparel Magic** | Inventory for branded merch and Wholesale invoicing | Brand | $12,000 | |
| **Elastic** | Wholesale B2B catalogs and ordering. Syncs to Apparel Magic inventory | Brand | $29,496 | |
| **Printavo** | INK work orders, invoices and payments | INK | $8,000 | |
| **Xero** | Accounting source of truth for Jetty Life, LLC (Brand and INK) | All | **?** | Amy / Jeremy |
| **Airtable** | Purchasing, PLM, ledgers, commissions, CX, ambassadors, meetings, calendar and more (about 230 bases, see section 7) | All | $21,600 | Jeremy |

### Money movement
| Rail | Flow |
|---|---|
| Shopify Payments, Shop Pay Installments, Markets PRO | DTC eComm (each one pays out separately, daily). Also INK client stores |
| Stripe (Brand) | Wholesale credit-card payments through Xero invoices |
| GoCardless ($3,500/yr) | Wholesale ACH through Xero |
| Printavo Payments ("Merchpay") | INK customer payments. Printavo requires it. Stripe (Ink) is legacy |
| Cash and check | Stores and Box Truck cash go to BOA. Wholesale still sends hundreds of checks a month. Some INK checks |
| RAMP cards and RAMP Bill Pay | Staff cards and most bill pay. Both sync to Xero |
| Chase United cards | Partners only (3 cards) |
| Columbia Bank | Primary operating account, credit line, mortgages, equipment loans |
| Bank of America | Secondary account for local cash deposits |
| TD Bank | JRF operating account |
| CardPointe / Give Smart / Mobile Cause | JRF donations and event batches |

### Communication and productivity
| Tool | Used for |
|---|---|
| Google Workspace (Gmail, Drive, Calendar) | Email, the budget workbooks (Drive .xlsb), calendar subscriptions |
| Slack | Team chat. Airtable automations and the new calendar DM people by Slack ID |
| Canva **?** | Design (a connector is enabled for it) |
| Zapier | Legacy glue: logs Stripe-Ink payouts to the ledger. Being retired in favour of the email sync |

### Marketing tech
| Tool | Used for |
|---|---|
| Attentive | SMS (campaigns, journeys, subscribers are tracked in DTC Daily) |
| Email platform **?** | Klaviyo or Shopify Email? Not recorded anywhere |
| Boxy **?** | Appears in DTC Daily as "Boxy Net Sales / AOV". Is it a channel or a tool? |
| SimilarWeb | Impression and traffic benchmarks |
| Meta / Instagram / TikTok / YouTube / LinkedIn | Social and boosted posts |

### The Claude-built layer (this repo)
| System | What it does | Runs on |
|---|---|---|
| **Strategic Dashboard** (`scripts/build_dashboard.py`) | Weekly P&L, revenue by channel, COGS, inventory, labor, OpEx, cash, events, JRF. Rebuilds within 5 minutes of a workbook change | GitHub Actions, then the Cloudflare Worker `jetty-strategic` behind Cloudflare Access |
| **Company Calendar** (`calendar/`) | Replaced Airtable for planning events, meetings, marketing and social. Has comments with Slack DMs, attachments, and per-person Google/Apple calendar feeds | Cloudflare Worker `jetty-calendar` with D1 and R2, plus `jetty-calendar-feed` |
| **Accounting email sync** (`scripts/sync_accounting_emails.py`) | Parses Shopify, Stripe, GoCardless, Printavo and CardPointe payout emails into the Airtable Ledger, then labels and archives them in Gmail | GitHub Actions, every 5 minutes |

---

## 5. Agencies and outside partners

| Partner | What they do | Status |
|---|---|---|
| **Sunnyside Collective** | Paid ads and influencer agency. Owns the Advertising and Influencer departments. "Sunny ROAS/CPC/CVR" metrics in DTC Daily | Active |
| **Datmos** (formerly The ZaneRay Group) | Website agency for Shopify | Active |
| **Attentive Mobile** | SMS marketing (platform plus managed service **?**) | Active |
| **Black Sails Publications** (Jon Coen) | Content producer, PR and ambassadors (1099) | Active |
| **Fresh Fish LLC** (Beth Davis) | Freelance INK graphic design | Active |
| Outsourced photography | Product and lifestyle photography **?** who | Active |
| Wholesale rep agencies (16) | Commissioned regional sales. See section 3 | Active |
| **CNS** | Overseas cut-and-sew manufacturer. Biggest A/P line: $235K carries into 2027 | Active |
| **S&S Activewear** | Blank garments for INK | Active |
| Playa Bowls, Ben Gravy | INK private-label clients that have their own Shopify stores | Active |
| Momentum Media PR | PR agency | Former |
| Vinyl Media LLC | Website agency | Former |
| Playa 3PL **?** | There is an Airtable base called "Playa 3PL". Is it fulfillment done for Playa Bowls? | **?** |

---

## 6. How data and money flow today

1. **DTC sale:** Shopify. The payout email goes to Gmail, then the email sync writes it to the Airtable Ledger (JTY). The payout lands in Columbia (eComm) or BOA (Box Truck) and gets reconciled in Xero.
2. **Wholesale order:** Elastic (B2B ordering) feeds Apparel Magic (inventory and invoice), then Xero. The retailer pays by Stripe, GoCardless or check, and the payout email feeds the Ledger.
3. **INK job:** Printavo (work order, invoice, Printavo Payments). The deposit email feeds the Ledger as "A/R - Jetty INK", then Xero.
4. **Spend:** RAMP card or bill pay, synced to Xero. Vendor A/P (CNS, etc.) is tracked in Airtable `Ledger → A/P - CNS` and shown on the dashboard.
5. **Planning and reporting:** the budget workbook (Drive .xlsb) plus Airtable (Ledger, Brand Production, JETTY HUB DTC Daily and Calendar & Events) feed the Strategic Dashboard. Xero GL and AR aging are pasted into the workbook **by hand**.
6. **Events:** planned in the new Calendar. Results (revenue, orders, fees) are still entered in Airtable `Calendar & Events`. Events are matched by name and date, so names must match exactly.

---

## 7. Airtable inventory: what still lives there

There are about 230 bases. The ones below are favorited or opened in the last
few months, grouped by function, with a first guess at their migration status.
"Old", "Copy" and one-off event bases are listed separately at the end.

| Function | Live bases | Migration status |
|---|---|---|
| **Company hub and meetings** | JETTY HUB 🌊 (CRM, Task Manager, Strategy Meeting, Weekly Kick-off, Calendar & Events, MKG Comms, DTC Daily, Tracker, Competition) | Calendar planning ✅ moved. Results, DTC Daily and tasks ⬜ still in Airtable |
| **Finance** | Ledger 💰, Ledger (Jerm) 💸, Marketing Budget, Retail Sales Commission Tracker, Taxes | Ledger is now fed automatically ✅. Still the system of record ⬜ |
| **People and HR** | Staff 🤼, HR Tracker, Culture 🤝🏻, Summer Intern Application, PTO Request Form, 401K Tracker, Jetty Gear Allowance | ⬜ **Sensitive (SSNs, pay, I-9). Handle with care when moving** |
| **Partners (private)** | Partner Resources | ⬜ Highly sensitive. Keep it separate |
| **Product and production** | Brand Production ⚙ (Vendor List, WHSL payments), Product Mothership, ProDev (PLM), Apparel Dictionary, Model Database, Fit Model Survey, 2027 WHSL Range | Read by the dashboard ⬜ |
| **Supply, inventory and warehouse** | Supply Orders, Inventory Hub, Receiving Hub, Shipping & Receiving, 700 Logistics, 700 "WMS" (In Progress / Testing V3), Audit - Warehouse / Stores, New Restock | ⬜ The WMS is half-built in Airtable. A strong candidate to move |
| **eComm and CX** | Customer Service, eComm Picking, ECOMM TRACKING, eComm Cumulative Sales, Returns Analysis, Website / Shopify | ⬜ |
| **Wholesale** | Commercial Sales New, Jetty WHSL Resource Center, WHSL MKG, WHSL Outbound | ⬜ |
| **Marketing** | Campaign Manager, Social Media, Photo & Video, Ambassador, MKG Content Hub, Public Relations | Social calendar planning ✅ moved. The rest ⬜ |
| **Retail stores** | Long Branch Store, Long Branch Shop, Flagship Store (176 E Bay) | ⬜ |
| **Jetty INK** | Jetty INK 🎨, INK Operations, Production Tracker, Late Shift Scheduling, Pricing APP, Gallery, Brand | ⬜ (alongside Printavo) |
| **JRF** | JRF HUB 🦪, Oysters & Initiatives, Jetty Watershed 💧, LBT Shell Recycling Data, Grant Requests, Donations Tracker, Sponsors & Planned Giving, JRF BUDGET, Photo/Video Release | ⬜ |
| **Scheduling** | SCHEDULING, MASTER SCHEDULE, 700 Scheduler, Recurring Tasks, Timed Tasks | ⬜ |
| **Special events** | Special Events & Initiatives 🎈, Event Prep & Supplies, plus per-event bases (Chowderfest, HopSauce, Reggaefest, Clam Jam, Shellabration, Bridge Walk…) | Planning ✅ moved to the Calendar |
| **Brewing and other** | Brewing Co., Jetty Beer, Jetty Extracts, Gladstone **?** | ⬜ |
| **Personal (Jeremy)** | Jerm, Golf, MUSIC (JERM), 61 Birch Creek, BH Sui Pool, Hunger Foundation, trips | Out of scope |

Archive candidates: anything tagged (OLD) or (Copy), 2022–2024 project trackers,
S20/SS22 sell-through, Company Dash / Company Dashboard (replaced by the
Strategic Dashboard), Campaign Calendar (OLD), Merch Planning (×2), PLM (OLD).

Airtable automations have not been inventoried yet. Many Task Manager fields
look up Slack IDs, which suggests DM automations. That is the next thing to
enumerate.

---

## 8. Open questions (to fill in together)

1. **Owners:** who is the business owner and the admin for each tool in section 4?
2. **Costs:** what do Xero, Slack, Google Workspace, Attentive, Canva, Sunnyside, Datmos and Cloudflare cost each year? The stack base only covers six tools.
3. **POS:** is Shopify POS used at Flagship, Long Branch and the Box Truck? Or Lightspeed or something else?
4. **Email marketing:** which platform?
5. **Payroll and HR:** Gusto, ADP, Paychex? Which benefits and 401K provider? Nothing is recorded yet.
6. **Shipping:** ShipStation, Shopify Shipping, or carriers directly? The Playa 3PL relationship?
7. **Marketing ownership** after Greg Waters and Joe Hodnicki: who and which agency?
8. **Which Airtable automations** are still running, and what do they trigger?

---

## 9. How we go granular

Take one function at a time, in the same order every time:

1. **Inventory it.** List its Airtable bases, tables, automations, interfaces and forms, who uses each, and how often.
2. **Map the procedure.** Write down the steps people actually follow, then the inputs, outputs and handoffs.
3. **Decide each piece:** move to the Claude system, keep in Airtable, move to the system of record (Shopify, Apparel Magic, Xero, Printavo), or retire.
4. **Build and backfill.** Same pattern as the Calendar: build it, import the history, retire the old planning.
5. **Update this map.**

Suggested order, highest leverage first:
1. **Finance close.** Automate the Xero GL and AR pastes into the dashboard. The Ledger is already half there.
2. **Event results.** Close the "planning here, results there" split by recording results in the Calendar.
3. **Tasks and meetings.** Move JETTY HUB Task Manager, Strategy Meeting and Kick-off. Slack DMs already exist.
4. **Warehouse, inventory and supply orders.** Finish the stalled 700 "WMS" as a real app.
5. **People and HR.** Last and most careful, because of the sensitive data.
