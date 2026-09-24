"""Pull the Jetty Hub calendar out of Airtable as CSV the calendar can import.

    export AIRTABLE_API_KEY=pat...
    python tools/airtable_import.py --from-year 2026 -o events.csv

Then paste events.csv into Import on the calendar.

This is a **one-time backfill**, not a sync. Airtable stops being the source once
the rows are in; nothing here writes back, and running it twice would duplicate
events rather than update them.

The script deliberately does very little mapping. Airtable's own labels -- "Box
Truck", "JRF", "Event", "JBC" -- are exactly the values worker/taxonomy.js
already recognises, so they pass through untouched and the Worker resolves them.
That keeps the taxonomy in one file instead of two that can drift.

What it does handle:

* **Times are plain text in Airtable** ("1:00", "6pm", "9:30am"), so the missing
  am/pm starts there rather than in Excel. The rule from tools/sheet_to_csv.py
  applies unchanged: a start between 7 and 11 is morning, everything else is
  afternoon or evening.
* **Three Event Type values belong on other axes.** JBC is a need (branded beer)
  and Ambassador is a sub-type; the Worker knows both, but they are listed here
  so the reason is written down.
* **Four Event Type values are retired** -- Brand, Deadline, Window and Women's.
  They carry one 2026 record between them, and that record is also tagged JRF, so
  dropping them loses nothing. Each drop is reported.
* **Needs live in three different Airtable fields**: Setup Needs, plus a Yes/No
  for the social permit and another for insurance. They are merged into one.
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet_to_csv import to_time, clean, to_zip          # noqa: E402  same rules, one place

BASE_ID = "appJbKBr1gHkPtd8a"
TABLE_ID = "tbly10cgK3QL9drFX"          # Calendar & Events 🗓
API = "https://api.airtable.com/v0"

DATE_START = "Event \U0001F680"
DATE_END = "Event \U0001F6D1"
TIME_START = "Start ⌚"
TIME_END = "End ⌚"

FIELDS = [
    "Name", DATE_START, DATE_END, "Event Type", "Type", "Booked",
    TIME_START, TIME_END, "Name (from Venue)", "Address", "City", "State", "Zip",
    "Setup Needs", "Do we need a social permit?",
    "Do we need insurance or an insurance cert?", "Notes", "Link",
]

OUT_COLUMNS = [
    "Name", "Booked", "Event Type", "Sub-type", "Needs",
    DATE_START, DATE_END, TIME_START, TIME_END,
    "Venue", "Address", "City", "State", "Zip", "Notes", "URL",
]

# Event Type values that belong on a different axis. The Worker resolves the
# names either way; this decides which column they leave in.
MOVE_TO_NEEDS = {"jbc"}
MOVE_TO_SUBTYPE = {"ambassador"}

# Retired: one 2026 record between them, and it is tagged JRF as well.
DROP_EVENT_TYPES = {"brand", "deadline", "window", "women's", "womens"}


def get(path, token, params):
    url = API + path + "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as err:
            if err.code == 429 and attempt < 4:       # Airtable rate limit
                time.sleep(2 ** attempt)
                continue
            body = err.read().decode(errors="replace")
            if err.code in (401, 403):
                sys.exit("Airtable rejected the token (HTTP %d). It needs read access to the "
                         "JETTY HUB base.\n%s" % (err.code, body))
            sys.exit("Airtable error %d: %s" % (err.code, body))
    sys.exit("Airtable kept rate-limiting the request.")


def fetch(token, from_year):
    records = []
    params = {
        "pageSize": 100,
        "fields[]": FIELDS,
        "filterByFormula": "AND({%s} != BLANK(), YEAR({%s}) >= %d)"
                           % (DATE_START, DATE_START, from_year),
    }
    offset = None
    while True:
        if offset:
            params["offset"] = offset
        page = get("/" + BASE_ID + "/" + TABLE_ID, token, params)
        records.extend(page.get("records", []))
        offset = page.get("offset")
        if not offset:
            return records


def first(v):
    """Lookup fields come back as arrays even when they hold one value."""
    if isinstance(v, list):
        return v[0] if v else ""
    return v if v is not None else ""


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def convert(records):
    rows, problems, notes = [], [], []

    for rec in records:
        f = rec.get("fields", {})
        name = clean(f.get("Name"))
        if not name:
            problems.append("%s: no name" % rec["id"])
            continue

        start = clean(f.get(DATE_START))
        if not start:
            problems.append("%s (%s): no start date" % (rec["id"], name))
            continue
        end = clean(f.get(DATE_END)) or start
        if end < start:
            problems.append("%s (%s): end date %s is before the start date %s"
                            % (rec["id"], name, end, start))
            continue

        try:
            st = to_time(clean(f.get(TIME_START)) or None, False)
            et = to_time(clean(f.get(TIME_END)) or None, True)
        except ValueError as err:
            problems.append("%s (%s): %s" % (rec["id"], name, err))
            continue
        if st and et and start == end and et <= st:
            problems.append("%s (%s): end time %s is not after the start time %s"
                            % (rec["id"], name, et, st))
            continue

        types, subs, needs = [], [], []

        for raw in as_list(f.get("Event Type")):
            label = clean(raw)
            low = label.lower()
            if low in DROP_EVENT_TYPES:
                notes.append("%s (%s): dropped retired Event Type %s" % (rec["id"], name, label))
            elif low in MOVE_TO_NEEDS:
                needs.append(label)
            elif low in MOVE_TO_SUBTYPE:
                subs.append(label)
            else:
                types.append(label)

        sub = clean(f.get("Type"))
        if sub and sub not in subs:
            subs.append(sub)

        for raw in as_list(f.get("Setup Needs")):
            n = clean(raw)
            if n:
                needs.append(n)
        if clean(f.get("Do we need a social permit?")).lower() == "yes":
            needs.append("Social Permit")
        if clean(f.get("Do we need insurance or an insurance cert?")).lower() == "yes":
            needs.append("Insurance")

        if not types and any(clean(x).lower().startswith("meeting") for x in subs):
            # 15 records carry no Event Type at all. Eleven of them say
            # Type = Meeting, which names a calendar outright -- that is the
            # record telling us where it belongs, not a guess. The rest (an
            # Event, and some blanks) name no calendar and stay out.
            types = ["Meetings"]
            notes.append("%s (%s): no Event Type, but Type says Meeting -- filed under Meetings"
                         % (rec["id"], name))

        if not types:
            notes.append("%s (%s): no Event Type and nothing to infer one from; skipped"
                         % (rec["id"], name))
            continue

        rows.append({
            "Name": name,
            "Booked": "checked" if f.get("Booked") else "",
            "Event Type": ",".join(types),
            "Sub-type": ",".join(dict.fromkeys(subs)),
            "Needs": ",".join(dict.fromkeys(needs)),
            DATE_START: start,
            DATE_END: end,
            TIME_START: st or "",
            TIME_END: et or "",
            "Venue": clean(first(f.get("Name (from Venue)"))),
            "Address": clean(first(f.get("Address"))),
            "City": clean(first(f.get("City"))),
            "State": clean(first(f.get("State"))).upper(),
            "Zip": to_zip(first(f.get("Zip"))),
            "Notes": clean(f.get("Notes")),
            "URL": clean(f.get("Link")),
        })

    rows.sort(key=lambda r: (r[DATE_START], r["Name"]))
    return rows, problems, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-year", type=int, default=2026,
                    help="earliest calendar year to pull (default 2026)")
    ap.add_argument("-o", "--out", help="write CSV here instead of stdout")
    args = ap.parse_args()

    token = os.environ.get("AIRTABLE_API_KEY", "").strip()
    if not token:
        sys.exit("AIRTABLE_API_KEY is not set.")

    records = fetch(token, args.from_year)
    print("Fetched %d records dated %d or later." % (len(records), args.from_year),
          file=sys.stderr)

    rows, problems, notes = convert(records)

    handle = open(args.out, "w", newline="", encoding="utf-8") if args.out else sys.stdout
    writer = csv.DictWriter(handle, fieldnames=OUT_COLUMNS)
    writer.writeheader()
    writer.writerows(rows)
    if args.out:
        handle.close()

    print("\n%d rows converted." % len(rows), file=sys.stderr)
    if problems:
        print("\n%d record(s) left out:" % len(problems), file=sys.stderr)
        for p in problems[:40]:
            print("  " + p, file=sys.stderr)
    if notes:
        print("\n%d note(s):" % len(notes), file=sys.stderr)
        for n in notes[:40]:
            print("  " + n, file=sys.stderr)


if __name__ == "__main__":
    main()
