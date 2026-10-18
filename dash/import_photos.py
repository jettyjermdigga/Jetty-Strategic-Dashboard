"""Pull Music Monday artwork out of Airtable, resize it, and write it to R2.

Run from .github/workflows/music-photos.yml, by hand, not on a schedule.
A schedule would make Airtable load-bearing again, which is the opposite of
where this is going: the point is to get the history across once and then
upload each week's picture on the dash.

It is safe to re-run. Keys are derived from the date -- one pick a week, so
`2026-10-12.webp` is the only name that week's picture can have -- and
re-running simply overwrites with the same thing.

Why resize: what is in Airtable totals 195MB across 243 files, and the
largest single one is 31.6MB. That is an album cover, and nobody should
wait on 31MB of it over a phone connection.

Needs AIRTABLE_TOKEN (read-only, scoped to the JETTY HUB base).
Writes files to ./photos/ for the workflow to upload with wrangler.
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request

from PIL import Image

BASE = "appJbKBr1gHkPtd8a"
TABLE = "tblqcuoZfpA0m6vWR"
F_DATE = "fldlPezsjQ9H76j7a"     # Launch
F_PHOTO = "fld2SzTSYNya3Xsw1"    # Artist/Band photo
OUT = "photos"

# Wide enough to look sharp in the hero on a retina screen, small enough
# that the whole archive is a few megabytes rather than two hundred.
MAX_EDGE = 900
QUALITY = 82


def airtable(token, offset=None):
    url = "https://api.airtable.com/v0/%s/%s?pageSize=100&fields%%5B%%5D=%s&fields%%5B%%5D=%s" % (
        BASE, TABLE, F_DATE, F_PHOTO)
    if offset:
        url += "&offset=" + offset
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def fetch(url):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def main():
    token = os.environ.get("AIRTABLE_TOKEN", "")
    if not token:
        print("::error::AIRTABLE_TOKEN is not set. Add it as a repository secret.")
        sys.exit(1)

    os.makedirs(OUT, exist_ok=True)

    rows, offset = [], None
    while True:
        page = airtable(token, offset)
        rows.extend(page.get("records", []))
        offset = page.get("offset")
        if not offset:
            break
    print("Read %d rows from Airtable." % len(rows))

    done = skipped = failed = 0
    saved_bytes = 0
    for rec in rows:
        f = rec.get("fields", {})
        date = f.get(F_DATE)
        shots = f.get(F_PHOTO) or []
        if not date or not shots:
            continue

        try:
            raw = fetch(shots[0]["url"])
        except Exception as err:                              # noqa: BLE001
            print("  ! %s download failed: %s" % (date, err))
            failed += 1
            continue

        try:
            im = Image.open(io.BytesIO(raw))
            # Flatten anything with transparency onto white; a PNG cover with
            # an alpha channel otherwise turns black when saved as WebP.
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im, mask=im.split()[-1])
                im = flat
            else:
                im = im.convert("RGB")
            im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
            path = os.path.join(OUT, date + ".webp")
            im.save(path, "WEBP", quality=QUALITY, method=6)
        except Exception as err:                              # noqa: BLE001
            print("  ! %s could not be read as an image: %s" % (date, err))
            failed += 1
            continue

        size = os.path.getsize(path)
        saved_bytes += size
        done += 1
        if done % 25 == 0:
            print("  %d done…" % done)

    print("\nWrote %d files to ./%s (%.1f MB total)." % (done, OUT, saved_bytes / 1024 / 1024))
    if skipped:
        print("Skipped %d." % skipped)
    if failed:
        print("::warning::%d could not be fetched or read." % failed)
    if not done:
        print("::error::Nothing was written.")
        sys.exit(1)


if __name__ == "__main__":
    main()
