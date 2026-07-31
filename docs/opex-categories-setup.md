# OpEx Categories — Setup

`scripts/build_dashboard.py` renders the Operating Expenses section as one
card per category (with a subtotal row each) instead of one flat table, and
lets specific line items carry a ★ callout (e.g. Photography). Both are
driven by an optional **"Categories"** tab in `data/budget.xlsb` — if that
tab doesn't exist, the script falls back to today's flat "OpEx by category"
table, so this is safe to leave unset.

## 1. Add the "Categories" tab

In the Google Sheet that backs `budget.xlsb`, add a new tab named exactly
`Categories` with these columns (header row required):

| Line Item | Category | Highlight | Callout Label |
|---|---|---|---|
| `MKG - Photography` | `Advertising & Marketing` | `Y` | `Photography` |
| `Advertising` | `Advertising & Marketing` | | |
| ... | ... | | |

- **Line Item** must match the sheet name used internally in the
  `Actual`/`Budget` tabs exactly (this is the second value in each tuple in
  `opex_map` inside `build_dashboard.py`, not the prettified display label —
  e.g. `MKG - Photography`, not "MKG — photography").
- **Category** is any free-text label. The dashboard uses this fixed
  display order for known names, and appends anything else alphabetically
  after:
  `Advertising & Marketing`, `Facilities & Permits`,
  `Selling, Travel & Team`, `Equipment, Fleet & Warehouse`,
  `Software, Admin & Payroll`.
- **Highlight**: `Y` to mark a line item with a ★ callout in its category
  card (it still rolls up into that category's subtotal — nothing is
  double-counted or excluded).
- **Callout Label**: optional short text shown next to a highlighted row
  (only used when Highlight is `Y`).

`docs/opex_categories_template.csv` in this repo has a starter mapping for
every line item currently in `opex_map` — paste it into the new tab and
edit the `Category`/`Highlight` columns as needed.

## 2. Uncategorized / unallocated lines

Any `opex_map` line item not present in the Categories tab lands in an
"Uncategorized" card. Separately, since `opex_map` only itemizes a subset of
the sheet's real OpEx rows, the dashboard also shows an "Unallocated" card
for the gap between the sum of itemized lines and the sheet's official Total
OpEx figure — add more rows to `opex_map` (and the Categories tab) to shrink
that gap.
