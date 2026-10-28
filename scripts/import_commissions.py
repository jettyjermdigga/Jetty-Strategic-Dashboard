"""One-time import of the two Airtable bases into the commissions module's D1.

Reads:
  Retail Sales Commission Tracker / Total Commissions  -> payments
  Ledger / Reps                                        -> statements
  the Sales Rep names used by both                     -> reps

Writes a .sql file. It is NOT committed: these are invoice amounts, commission
rates and what every rep earns, and none of that belongs in git. The workflow
pipes it straight into `wrangler d1 execute --remote` and deletes it.

Needs AIRTABLE_API_KEY. Run with --out to choose where the SQL lands.

The import is keyed on each Airtable record id, written to payments.source_ref,
which is UNIQUE -- so running this twice imports nothing the second time
rather than doubling every commission.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://api.airtable.com/v0"

COMMISSION_BASE = "appfFzOtFa2yxoj9l"
TOTAL_COMMISSIONS = "tblXwSFovCWyhPhww"
LEDGER_BASE = "appW8jAfERj3iBzqt"
REPS_TABLE = "tbl50U84eJuPAe1dv"

# Only so a failure can name the base rather than its id.
BASE_NAMES = {
    COMMISSION_BASE: "Retail Sales Commission Tracker",
    LEDGER_BASE: "Ledger",
}

MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
          "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def slug(name):
    """A stable key for a rep.

    Must stay in step with repKey() in commissions/worker/commission.js --
    the module compares what Amy picks against the keys this writes, and a
    different answer here means a rep who cannot be allocated to.
    """
    s = (name or "").lower()
    s = re.sub(r"[‘’']", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60]


assert slug("Stone Sales Inc. (Bouchard Group)") == "stone-sales-inc-bouchard-group"
assert slug("T&L Action Agency") == "t-l-action-agency"
assert slug("O'Brien Sales") == "obrien-sales"


class AccessDenied(Exception):
    """The token is real but may not read this base."""


def fetch(base, table, token, fields=None):
    """Every record in a table, following Airtable's pagination."""
    out = []
    offset = None
    where = "%s (%s)" % (BASE_NAMES.get(base, base), base)
    while True:
        params = {"pageSize": "100"}
        if offset:
            params["offset"] = offset
        url = "%s/%s/%s?%s" % (API, base, table, urllib.parse.urlencode(params))
        for field in fields or []:
            url += "&fields%5B%5D=" + urllib.parse.quote(field)
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    page = json.load(res)
                break
            except urllib.error.HTTPError as err:
                # 401 and 403 are answers, not hiccups. Retrying a
                # permissions error four times spends fifteen seconds
                # proving the same thing and buries the reason in a stack
                # trace. An Airtable token is scoped to named bases, so a
                # token that works for one base says nothing about another.
                if err.code in (401, 403):
                    raise AccessDenied(
                        "Airtable answered %d on %s.\n\n"
                        "AIRTABLE_API_KEY reached Airtable but may not read that base.\n"
                        "Airtable personal access tokens are scoped to the bases you "
                        "name when you make them, so a token that works for one base "
                        "says nothing about another.\n\n"
                        "Add %s to that token's bases at\n"
                        "  https://airtable.com/create/tokens\n"
                        "with the data.records:read scope, then run this again."
                        % (err.code, where, BASE_NAMES.get(base, base))) from None
                if attempt == 4:
                    raise
                # Airtable rate-limits at 5 requests a second per base and
                # answers 429; backing off is cheaper than failing a 22,000
                # row import three quarters of the way through.
                time.sleep(2 ** attempt)
                print("  retrying after %s" % err, file=sys.stderr)
            except Exception as err:          # noqa: BLE001 - retried below
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
                print("  retrying after %s" % err, file=sys.stderr)
        out.extend(page.get("records", []))
        offset = page.get("offset")
        if not offset:
            break
        print("  %d records..." % len(out), file=sys.stderr)
    return out


def one(value):
    """Airtable multi-selects come back as lists. These fields hold one value
    in practice; anything beyond the first is kept in the notes rather than
    dropped silently."""
    if isinstance(value, list):
        if not value:
            return None, []
        first = value[0]
        name = first.get("name") if isinstance(first, dict) else first
        rest = [v.get("name") if isinstance(v, dict) else v for v in value[1:]]
        return name, rest
    if isinstance(value, dict):
        return value.get("name"), []
    return value, []


def money(value):
    if value in (None, ""):
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def q(value):
    """A SQL literal. Single quotes doubled; nothing is interpolated raw."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="commissions-import.sql")
    ap.add_argument("--limit", type=int, default=0, help="stop after N payments (for a dry run)")
    args = ap.parse_args()

    token = os.environ.get("AIRTABLE_API_KEY", "").strip()
    if not token:
        print("AIRTABLE_API_KEY is not set.", file=sys.stderr)
        return 1

    try:
        print("Reading Total Commissions...", file=sys.stderr)
        commissions = fetch(COMMISSION_BASE, TOTAL_COMMISSIONS, token)
        print("  %d payments" % len(commissions), file=sys.stderr)

        print("Reading the Ledger's Reps tab...", file=sys.stderr)
        statements = fetch(LEDGER_BASE, REPS_TABLE, token)
        print("  %d monthly statements" % len(statements), file=sys.stderr)
    except AccessDenied as err:
        print("", file=sys.stderr)
        print(str(err), file=sys.stderr)
        return 1

    # Every rep named by either table, and an email wherever the Ledger has
    # one. A rep who only appears on old commissions still has to exist, or
    # those rows import with a key nothing matches.
    reps = {}

    def note_rep(name, email=None):
        if not name:
            return None
        key = slug(name)
        if not key:
            return None
        row = reps.setdefault(key, {"name": name, "email": None})
        if email and not row["email"]:
            row["email"] = email.strip()
        return key

    lines = [
        "-- Generated by scripts/import_commissions.py. Not committed.",
        "PRAGMA defer_foreign_keys = true;",
    ]

    stmt_rows = []
    for rec in statements:
        f = rec.get("fields", {})
        name, _ = one(f.get("Sales Rep"))
        emails = f.get("Email") or []
        email = emails[0] if isinstance(emails, list) and emails else None
        key = note_rep(name, email)
        if not key:
            continue
        month_name, _ = one(f.get("Month"))
        try:
            month = MONTHS.index((month_name or "").upper()[:3]) + 1
        except ValueError:
            month = None
        try:
            year = int(str(f.get("Year") or "").strip()[:4])
        except ValueError:
            year = None
        if not (year and month):
            continue
        attachments = f.get("Sales Report") or []
        stmt_rows.append({
            "id": rec["id"],
            "rep_key": key,
            "year": year,
            "month": month,
            "amount": money(f.get("Amount")),
            # The file itself stays in Airtable for now: the attachment URLs
            # expire, so copying them into R2 is its own job with its own
            # failure modes. The name is kept so a statement can be matched
            # up by hand until then.
            "report_name": (attachments[0].get("filename") if attachments else None),
            "sent_at": f.get("Date Sent"),
        })

    pay_rows = []
    for rec in commissions:
        f = rec.get("fields", {})
        rep_name, _ = one(f.get("Sales Rep"))
        rep_key = note_rep(rep_name)
        retailer, extra_retailers = one(f.get("Retailer"))
        customer, _ = one(f.get("Customer"))
        territory, _ = one(f.get("Territory"))
        line, _ = one(f.get("Jetty Line"))
        method, _ = one(f.get("Payment Type"))

        note = (f.get("Notes") or "").strip()
        if extra_retailers:
            note = (note + " | also: " + ", ".join(x for x in extra_retailers if x)).strip(" |")

        paid_on = f.get("Payment Date")
        if not paid_on:
            # Without a date it belongs to no month and no statement. Kept
            # out rather than filed under a guess.
            continue

        pay_rows.append({
            "id": rec["id"],
            "paid_on": paid_on,
            "invoice_no": (f.get("Invoice #") or None),
            "retailer": retailer,
            "customer": customer,
            "territory": territory,
            "jetty_line": line,
            "payment_method": method,
            "rep_key": rep_key,
            "commission_pct": money(f.get("Commission %")),
            "gross": money(f.get("Original Invoice")),
            "credits": money(f.get("Credits")),
            # The field really is called "Freight " in the base.
            "freight": money(f.get("Freight ") or f.get("Freight")),
            "cad": 1 if f.get("CAD") else 0,
            "usd_net": money(f.get("USD Net Invoice")),
            "cc_fee": 1 if f.get("3% CC Fee") else 0,
            "partial": 1 if f.get("Partial Payment") else 0,
            "paid": 1 if f.get("Paid") else 0,
            "credit_memo": (f.get("Credit Memo #") or None),
            "notes": note or None,
        })
        if args.limit and len(pay_rows) >= args.limit:
            break

    for key, row in sorted(reps.items()):
        lines.append(
            "INSERT OR IGNORE INTO reps (key, name, email, active, created_at) VALUES "
            "(%s, %s, %s, 1, datetime('now'));" % (q(key), q(row["name"]), q(row["email"])))

    cols = ("id, source, source_ref, paid_on, invoice_no, retailer, customer, territory, "
            "jetty_line, payment_method, rep_key, commission_pct, gross, credits, freight, "
            "cad, usd_net, cc_fee, partial, paid, credit_memo, notes, created_by, created_at")
    for row in pay_rows:
        values = ", ".join(q(v) for v in [
            row["id"], "airtable", row["id"], row["paid_on"], row["invoice_no"],
            row["retailer"], row["customer"], row["territory"], row["jetty_line"],
            row["payment_method"], row["rep_key"], row["commission_pct"], row["gross"],
            row["credits"], row["freight"], row["cad"], row["usd_net"], row["cc_fee"],
            row["partial"], row["paid"], row["credit_memo"], row["notes"], "import",
        ])
        lines.append("INSERT OR IGNORE INTO payments (%s) VALUES (%s, datetime('now'));"
                     % (cols, values))

    for row in stmt_rows:
        lines.append(
            "INSERT OR IGNORE INTO statements "
            "(id, rep_key, year, month, amount, report_name, sent_at, created_at) VALUES "
            "(%s, %s, %s, %s, %s, %s, %s, datetime('now'));"
            % (q(row["id"]), q(row["rep_key"]), q(row["year"]), q(row["month"]),
               q(row["amount"]), q(row["report_name"]), q(row["sent_at"])))

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    print("Wrote %s: %d reps, %d payments, %d statements"
          % (args.out, len(reps), len(pay_rows), len(stmt_rows)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
