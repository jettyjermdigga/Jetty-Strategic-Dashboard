"""Turn a Jetty calendar spreadsheet into CSV the calendar's importer accepts.

    python tools/sheet_to_csv.py "Calendar & Events - BOX TRUCK.xlsx" -o events.csv

Three things in the sheets need handling before the rows are usable, and doing
them by hand 112 times is how mistakes get in:

* **Times have lost their meridiem.** Excel stores them as a 12-hour clock with
  no am/pm, so a 1:00 start reads as one in the morning. The handful of cells
  that survived as text ("6pm", "9:30am", "11am") give the rule: a start between
  7 and 11 is morning, everything else is afternoon or evening. That rule
  produces an end after the start on every row of the 2026 box truck sheet.
* **Zips have lost their leading zero.** Stored as numbers, so 08260 comes back
  as 8260. Every New Jersey zip is affected.
* **Some cells arrive wrapped in quote marks**, where the value contains a
  comma. The quotes are stripped and the change is reported.
* **Six columns restate the event date.** Year, Week, Start (Week), End (Week),
  Month and Day are all functions of it. They are checked against the date and
  reported, not exported -- the calendar derives them.

Anything that cannot be read is reported and the row is left out, so a bad cell
never becomes a silently wrong event.
"""

import argparse
import csv
import datetime
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  pip install openpyxl")

OUT_COLUMNS = [
    "Name", "Booked", "Type", "Event Type", "Event \U0001F680", "Event \U0001F6D1",
    "Start ⌚", "End ⌚", "Venue", "Address", "City", "State", "Zip",
]

MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
              "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
DOW_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

RETAIL_EPOCH = datetime.date(2026, 1, 4)   # Sunday starting retail week 1 of 2026
RETAIL_EPOCH_YEAR = 2026

TEXT_TIME = re.compile(r"^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*$", re.I)
BARE_TIME = re.compile(r"^\s*(\d{1,2})(?::(\d{2}))?\s*$")


def retail_week(d):
    idx = (d - RETAIL_EPOCH).days // 7
    year_offset = idx // 52
    start = RETAIL_EPOCH + datetime.timedelta(days=idx * 7)
    return (RETAIL_EPOCH_YEAR + year_offset,
            idx - year_offset * 52 + 1,
            start,
            start + datetime.timedelta(days=6))


def to_date(v):
    if v in (None, ""):
        return None
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.datetime.strptime(str(v).strip(), fmt).date()
        except ValueError:
            pass
    raise ValueError("cannot read %r as a date" % (v,))


def to_time(v, is_end):
    """Return HH:MM on a 24-hour clock, or None."""
    if v in (None, ""):
        return None
    if isinstance(v, datetime.datetime):
        v = v.time()
    if isinstance(v, str):
        v = v.strip()
        if not v:
            return None
        m = TEXT_TIME.match(v)
        if m:
            h, minute, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3).lower()
            if ap == "p" and h != 12:
                h += 12
            if ap == "a" and h == 12:
                h = 0
            return "%02d:%02d" % (h, minute)
        # Airtable stores these as plain text, so most arrive with no meridiem at
        # all -- "1:00", "9:30", "11". Same clock, same rule as a spreadsheet time.
        bare = BARE_TIME.match(v)
        if bare:
            v = datetime.time(int(bare.group(1)) % 24, int(bare.group(2) or 0))
        else:
            raise ValueError("cannot read %r as a time" % (v,))
    if isinstance(v, datetime.time):
        h, minute = v.hour, v.minute
        # No meridiem was stored. Starts between 7 and 11 are the only ones that
        # read as morning on an events calendar; ends are always later in the day.
        afternoon = (h != 12) if is_end else not (7 <= h <= 11)
        if afternoon and h != 12:
            h += 12
        return "%02d:%02d" % (h, minute)
    raise ValueError("cannot read %r as a time" % (v,))


def clean(v):
    if v is None:
        return ""
    return " ".join(str(v).split())


def unquote(v, label, row, name, notes):
    """Strip quote marks a spreadsheet left wrapped around a whole cell.

    Three Venue cells on the 2026 box truck sheet read \'"Ventnor, NJ"\' -- the
    quotes are an artifact of a cell containing a comma, not part of the name,
    and they would otherwise show up in Google Calendar. Stripped, but reported,
    because quietly editing someone\'s data is how you lose their trust in it.
    """
    s = clean(v)
    if len(s) > 1 and s[0] == '"' and s[-1] == '"' and '"' not in s[1:-1]:
        notes.append("Row %d (%s): %s was wrapped in quote marks; stored as %s"
                     % (row, name, label, s[1:-1]))
        return s[1:-1]
    return s


def to_zip(v):
    if v in (None, ""):
        return ""
    s = str(v).strip()
    if s.endswith(".0"):
        s = s[:-2]
    return s.zfill(5) if s.isdigit() and len(s) <= 5 else s


def convert(path, sheet=None):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        sys.exit("The sheet is empty.")

    header = [clean(h) for h in rows[0]]
    idx = {h: i for i, h in enumerate(header) if h}

    def cell(row, *names):
        for n in names:
            if n in idx and idx[n] < len(row):
                return row[idx[n]]
        return None

    out, problems, notes = [], [], []

    for n, row in enumerate(rows[1:], start=2):
        if not any(c not in (None, "") for c in row):
            continue
        name = clean(cell(row, "Name", "Event Name", "Title"))
        if not name:
            problems.append("Row %d: no event name" % n)
            continue
        try:
            start = to_date(cell(row, "Event \U0001F680", "Start", "Start Date", "Date"))
            if start is None:
                raise ValueError("no start date")
            end = to_date(cell(row, "Event \U0001F6D1", "End", "End Date")) or start
            st = to_time(cell(row, "Start ⌚", "Start Time"), False)
            et = to_time(cell(row, "End ⌚", "End Time"), True)
        except ValueError as err:
            problems.append("Row %d (%s): %s" % (n, name, err))
            continue

        if end < start:
            problems.append("Row %d (%s): end date %s is before the start date %s"
                            % (n, name, end, start))
            continue
        if st and et and start == end and et <= st:
            problems.append("Row %d (%s): end time %s is not after the start time %s"
                            % (n, name, et, st))
            continue

        # The six derived columns: report disagreements, do not export them.
        year, week, wk_start, wk_end = retail_week(start)
        for label, given, actual in (
            ("Year", cell(row, "Year"), year),
            ("Week", cell(row, "Week"), week),
            ("Start (Week)", to_date(cell(row, "Start (Week)")) if cell(row, "Start (Week)") else None, wk_start),
            ("End (Week)", to_date(cell(row, "End (Week)")) if cell(row, "End (Week)") else None, wk_end),
            ("Month", cell(row, "Month"), MONTH_ABBR[start.month - 1]),
            ("Day", cell(row, "Day"), DOW_ABBR[(start.weekday() + 1) % 7]),
        ):
            g = clean(given)
            if g and g.upper() != str(actual).upper():
                notes.append("Row %d (%s): %s says %s, but %s is %s"
                             % (n, name, label, g, start, actual))

        out.append({
            "Name": name,
            "Booked": clean(cell(row, "Booked", "Status")),
            "Type": clean(cell(row, "Type", "Category")),
            "Event Type": clean(cell(row, "Event Type", "Departments")),
            "Event \U0001F680": start.isoformat(),
            "Event \U0001F6D1": end.isoformat(),
            "Start ⌚": st or "",
            "End ⌚": et or "",
            "Venue": unquote(cell(row, "Venue"), "Venue", n, name, notes),
            "Address": unquote(cell(row, "Address"), "Address", n, name, notes),
            "City": clean(cell(row, "City")),
            "State": clean(cell(row, "State")).upper(),
            "Zip": to_zip(cell(row, "Zip")),
        })

    return out, problems, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("-o", "--out", help="write CSV here instead of stdout")
    ap.add_argument("-s", "--sheet", help="sheet name (default: the first one)")
    args = ap.parse_args()

    rows, problems, notes = convert(args.workbook, args.sheet)

    handle = open(args.out, "w", newline="", encoding="utf-8") if args.out else sys.stdout
    writer = csv.DictWriter(handle, fieldnames=OUT_COLUMNS)
    writer.writeheader()
    writer.writerows(rows)
    if args.out:
        handle.close()

    report = sys.stderr
    print("\n%d rows converted." % len(rows), file=report)
    if problems:
        print("\n%d row(s) left out:" % len(problems), file=report)
        for p in problems:
            print("  " + p, file=report)
    if notes:
        print("\n%d note(s). The events are fine; this is what was cleaned up or"
              " ignored:" % len(notes), file=report)
        for x in notes:
            print("  " + x, file=report)


if __name__ == "__main__":
    main()
