# Airtable — brief for the rep call

Prepared 17 Oct 2026. Call: Monday 19 Oct (est). Source: invoice INV10052470
and the Staff base.

---

## Where we stand

| | |
|---|---|
| Plan | Enterprise Scale |
| Paid seats | **40** |
| Editors actually assigned | **36** (4 unassigned) |
| Billed | **$8,400 / quarter** |
| Annual | **$33,600** |
| Per seat | **$840 / year** ($70 / month) |
| Contract term | **10/07/2026 – 10/06/2027** |
| Frequency | Quarterly, Net 30 |
| Renewed | 9 days before this brief |

**Active staff in the Staff base: 146.** So 36 editors is ~25% of active
headcount, not the whole company.

---

## The single strongest card

Airtable's published **Business** tier is **$45/seat/month** billed annually:

| | 40 seats / year |
|---|---|
| Business, list price | **$21,600** |
| What we pay (Enterprise Scale) | **$33,600** |
| **Premium we are paying** | **$12,000 / year** |

**Ask: "What am I getting for the $12,000 a year premium over Business?"**

Legitimate answers exist — SSO/SCIM provisioning, the Enterprise admin API,
audit logs, granular permissions, enterprise key management, support SLA. If
we use those, the premium may be fair. If the answer is vague, that is
leverage, and "move us to Business" is a $12,000 saving that needs no
engineering and no change to how anybody works.

Worth knowing before the call which of those features we actually depend on.

---

## Questions to ask, in order

**1. Can we reduce seats mid-term, or only at renewal?**
Do not assume we are locked for twelve months. Some enterprise agreements
allow a true-down at a quarterly or anniversary checkpoint. If we can reduce
mid-term, savings start now rather than next October.

**2. What are we getting for the premium over Business?**
See above. The $12,000 question.

**3. Is one service account serving many users through the API permitted
under our agreement?**
This is the one that decides our roadmap. The plan is for the Jetty Dash to
read from Airtable with a single service token and show it to staff who hold
no seat. Some vendors treat that as seat circumvention. **Get the answer in
writing by email after the call** — a verbal yes from a rep is not a contract
term.

**4. What are our actual API limits on this plan?**
Specifically calls per month and requests per second per base. The published
Team limit is 100,000 calls/month and 5 req/sec per base. If Enterprise Scale
lifts the monthly cap, the dash can read freely; if not, everything needs
caching.

**5. Are read-only and commenter seats free on our plan?**
If read-only is free, we can start moving people off Editor immediately for
the workflow benefit, even though the bill will not change until renewal.

**6. Price at 25, 15 and 10 seats — in writing.**
Enterprise pricing is often non-linear and there may be a floor below which
they push us to a different tier. Better to know the curve now than to build
toward a number that turns out not to exist.

---

## Posture

**Signal the reduction now.** Saying "we are planning to reduce substantially
at renewal" in month two gets a different response than saying it in month
eleven. Reps have room to move when there is time to save the account.

**Be careful about term extensions offered as discounts.** A lower per-seat
price in exchange for a two or three year commitment at 40 seats is worse
than our current deal if we are about to need 15 seats. Any discount should
be evaluated against the seat count we expect to land on, not today's.

**Do not commit to a reduction number on this call.** We have not yet
classified the 36. Say the direction, not the figure.

---

## What we do not know yet

The 36 editors have not been classified. The plan is three buckets:

1. **Glance-only** — given Editor because it was easier than setting
   permissions. Downgrade to read-only, free.
2. **Small structured edits** — status changes, marking complete, adding a
   note. These are what the dash can take over.
3. **Lives in the grid** — bulk edits, filtering, building views. Keep the
   seat; a dashboard will never replace a grid for them.

**A caution on the optimism here.** 36 editors out of 146 active staff is
already selective — roughly the office and management layer rather than
everybody. That makes it less likely that bucket 1 is large. The audit is
still worth doing, but it may yield fewer easy downgrades than a 40-seat
company where everyone was handed Editor by default.

Bucket 3 is the floor. The honest answer to "how low can we go" is
"bucket 3 plus a few admins", and we will not know that number until the 36
are classified.

---

## Free money regardless

**4 unassigned seats = $3,360 / year.** No analysis needed, no workflow
change. Raise it on the call.
