"""Rebuild the Music Monday archive from Airtable: the picks and the artwork.

Run once, by hand, from .github/workflows/music-rebuild.yml. Not on a
schedule -- a schedule would make Airtable load-bearing again, which is the
opposite of where this is going. The point is to get thirteen years across
in one pass and then post each Monday on the dash itself, after which this
script is never needed and the token can be deleted.

It replaces import_photos.py, which moved the pictures but not the picks.
That left the text frozen on a snapshot taken 17 Oct 2026, so two Mondays
went missing and one was written against the wrong artist entirely.

WHY THE TYPE FILTER MATTERS. MKG Comms holds social, PR, blog, events and
INK as well as music, and every Monday carries TWO rows: the MUSIC MONDAY
row, and a BUZZ digest row created in bulk months ahead that phrases the
same pick as '"Random Violence" by Hot Chip'. The first import did not
filter by type, so it picked up BUZZ rows and read the headline as an
artist name -- which is exactly how 2 Nov 2026 ended up filed under Snake
Mountain Revival, the artist from a fortnight earlier.

Safe to re-run, and it never deletes: keys are derived from the date, and
the SQL is an upsert, so a week corrected on the dash and then rebuilt is
overwritten with Airtable's version rather than duplicated. A week posted
on the dash that Airtable has never heard of is left alone.

Needs AIRTABLE_TOKEN (read-only, scoped to the JETTY HUB base).
Writes ./photos/*.webp for the workflow to put in R2, and ./music.sql for
it to run against D1.
"""

import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from PIL import Image

BASE = "appJbKBr1gHkPtd8a"
TABLE = "tblqcuoZfpA0m6vWR"

# Field IDs, not names: a column renamed in Airtable must not quietly break
# this the way `Assignee` -> `Executor` broke the campaign board.
F_DATE = "fldlPezsjQ9H76j7a"     # Launch
F_PHOTO = "fld2SzTSYNya3Xsw1"    # Artist/Band photo
F_ARTIST = "fldyId7Nd1AVRh71B"   # Artist
F_SONG = "fld2fYG7WUcoFaDAM"     # the headline; on a MUSIC MONDAY row, the song
F_BY = "fldWRIEGFBWNah4pW"       # who picked it
F_WATCH = "fldFKRuBX6usvpjsK"    # video url
F_TYPE = "fldJcls46gLb3g1w1"     # Type

# The choice ID rather than the word, so renaming the choice cannot silently
# empty the whole rebuild.
MUSIC_CHOICE = "selgjWYplNkEneMqC"
MUSIC_NAME = "MUSIC MONDAY"

FIELDS = [F_DATE, F_PHOTO, F_ARTIST, F_SONG, F_BY, F_WATCH, F_TYPE]

OUT = "photos"
SQL = "music.sql"

# Wide enough to look sharp in the hero on a retina screen, small enough
# that the whole archive is a few megabytes rather than two hundred.
MAX_EDGE = 900
QUALITY = 82

# Every shape a YouTube link arrives in. Kept in step with youtubeId() in
# worker/music.js -- the dash and this script have to agree on what an id is
# or a rebuilt row loses its player.
YT = [
    re.compile(r"[?&]v=([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"/embed/([A-Za-z0-9_-]{11})"),
    re.compile(r"/shorts/([A-Za-z0-9_-]{11})"),
    re.compile(r"/live/([A-Za-z0-9_-]{11})"),
]


def youtube_id(url):
    s = (url or "").strip()
    if not s:
        return ""
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    for pat in YT:
        m = pat.search(s)
        if m:
            return m.group(1)
    return ""


def airtable(token, offset=None):
    # returnFieldsByFieldId is not optional here. Airtable accepts field IDs
    # in the fields[] selector but keys the RESPONSE by field NAME unless it
    # is asked otherwise -- so every lookup by ID comes back empty and the
    # run reports a table with nothing in it. The importer this replaces had
    # the same bug and was never run, so it was never found.
    q = [("pageSize", "100"), ("returnFieldsByFieldId", "true")]
    for f in FIELDS:
        q.append(("fields[]", f))
    if offset:
        q.append(("offset", offset))
    url = "https://api.airtable.com/v0/%s/%s?%s" % (BASE, TABLE, urllib.parse.urlencode(q))
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def fetch(url):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def text(v):
    """Airtable hands back a bare string for text and an object for a select."""
    if isinstance(v, dict):
        return str(v.get("name") or "").strip()
    if isinstance(v, list):
        return ", ".join(text(x) for x in v if x)
    return str(v or "").strip()


def is_music(rec):
    v = rec.get("fields", {}).get(F_TYPE)
    if isinstance(v, dict):
        return v.get("id") == MUSIC_CHOICE or v.get("name") == MUSIC_NAME
    return text(v) == MUSIC_NAME


def q(s):
    """A SQL string literal. Doubling the quote is the whole of the escaping
    SQLite needs, and nothing here is ever interpolated into an identifier."""
    return "'" + str(s or "").replace("'", "''") + "'"


def main():
    token = os.environ.get("AIRTABLE_TOKEN", "")
    if not token:
        print("::error::AIRTABLE_TOKEN is not set. Add it as a repository secret.")
        sys.exit(1)
    dry = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")

    rows, offset = [], None
    while True:
        page = airtable(token, offset)
        rows.extend(page.get("records", []))
        offset = page.get("offset")
        if not offset:
            break
    print("Read %d rows from MKG Comms." % len(rows))

    music = [r for r in rows if is_music(r)]
    print("Of those, %d are MUSIC MONDAY (the rest are BUZZ, social, PR, blog, events)."
          % len(music))
    if not music:
        print("::error::No MUSIC MONDAY rows matched.")
        # Say what WAS there. A bare count of zero cannot tell the difference
        # between a renamed choice and a response keyed the other way.
        sample = next((r for r in rows if r.get("fields")), None)
        if sample:
            print("A record's field keys look like: %s"
                  % ", ".join(sorted(sample.get("fields", {}).keys())))
            print("Expected the Type field at %s. If those are names rather "
                  "than fld... ids, returnFieldsByFieldId is not being sent."
                  % F_TYPE)
        seen = {}
        for r in rows:
            seen[text(r.get("fields", {}).get(F_TYPE))] = seen.get(
                text(r.get("fields", {}).get(F_TYPE)), 0) + 1
        print("Types seen: %s" % sorted(seen.items(), key=lambda kv: -kv[1])[:8])
        sys.exit(1)

    # One row per Monday. Where Airtable has more than one, the one with an
    # artist wins; a tie goes to whichever was created last, on the grounds
    # that it is the correction.
    picks = {}
    dupes = blank = 0
    for rec in music:
        f = rec.get("fields", {})
        date = text(f.get(F_DATE))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            continue
        # Mondays are created in Airtable weeks ahead and filled in later.
        # An empty one is not a pick: the page hides it anyway, and filing it
        # would tell the dash that week is done, silencing the very reminder
        # that is supposed to chase it.
        if not text(f.get(F_ARTIST)):
            blank += 1
            continue
        cur = picks.get(date)
        if cur:
            dupes += 1
            better = bool(text(f.get(F_ARTIST))) and not text(cur["f"].get(F_ARTIST))
            newer = rec.get("createdTime", "") > cur["rec"].get("createdTime", "")
            if not (better or (newer and bool(text(f.get(F_ARTIST))))):
                continue
        picks[date] = {"f": f, "rec": rec}

    print("%d distinct Mondays (%d duplicates resolved, %d empty weeks left alone)."
          % (len(picks), dupes, blank))

    # ── the artwork ────────────────────────────────────────────────────
    os.makedirs(OUT, exist_ok=True)
    art, failed, saved = set(), 0, 0
    wanted = [(d, p) for d, p in sorted(picks.items()) if p["f"].get(F_PHOTO)]
    print("\n%d Mondays have artwork." % len(wanted))

    for date, p in wanted:
        if dry:
            art.add(date)
            continue
        shots = p["f"].get(F_PHOTO) or []
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
        art.add(date)
        saved += os.path.getsize(path)
        if len(art) % 25 == 0:
            print("  %d done…" % len(art))

    if not dry:
        print("Wrote %d files to ./%s (%.1f MB)." % (len(art), OUT, saved / 1024 / 1024))

    # ── the picks ──────────────────────────────────────────────────────
    #
    # photo_key is only claimed for a picture that actually came down. A row
    # that says it has artwork when R2 has none renders a broken image the
    # page then hides, which is the failure that went unnoticed for a year.
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = []
    for date, p in sorted(picks.items()):
        f = p["f"]
        watch = text(f.get(F_WATCH))
        yt = youtube_id(watch)
        lines.append(
            "INSERT INTO music (pick_date, artist, song, chosen_by, youtube, video_url, "
            "photo_key, updated_at, updated_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, "
            "'airtable-rebuild') ON CONFLICT(pick_date) DO UPDATE SET artist=excluded.artist, "
            "song=excluded.song, chosen_by=excluded.chosen_by, youtube=excluded.youtube, "
            "video_url=excluded.video_url, photo_key=excluded.photo_key, "
            "updated_at=excluded.updated_at, updated_by=excluded.updated_by;" % (
                q(date), q(text(f.get(F_ARTIST))), q(text(f.get(F_SONG))),
                q(text(f.get(F_BY))), q(yt), q("" if yt else watch),
                q(date + ".webp" if date in art else ""), q(now),
            ))

    with open(SQL, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\nWrote %d upserts to ./%s." % (len(lines), SQL))

    # The newest dozen, printed so the run log shows what it is about to do
    # rather than only how many of it there were.
    print("\nThe twelve most recent, as they will be filed:")
    for date, p in sorted(picks.items())[-12:]:
        f = p["f"]
        print("  %s  %-34s %-30s %-18s %s%s" % (
            date, text(f.get(F_ARTIST))[:34], text(f.get(F_SONG))[:30],
            text(f.get(F_BY))[:18],
            "yt" if youtube_id(text(f.get(F_WATCH))) else "--",
            " art" if date in art else ""))

    if failed:
        print("::warning::%d pictures could not be fetched or read." % failed)
    if dry:
        print("\nDRY RUN: nothing was downloaded and nothing will be written to D1.")


if __name__ == "__main__":
    main()
