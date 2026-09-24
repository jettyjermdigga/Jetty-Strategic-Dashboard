"""Assemble the static half of the site into output/.

build_dashboard.py produces one self-contained page from the master budget.
This adds everything around it: the landing page, the calendar's HTML/CSS/JS,
and the shared design-system assets those two link to rather than inline.

The dashboard keeps its inlined copy of the fonts and CSS because it is meant to
be printed and saved as a single file. The other pages link to /assets/ instead,
so the 670 KB font bundle is downloaded once and cached, not once per page.
"""

import base64
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
ASSETS = os.path.join(ROOT, "scripts", "assets")
OUT = os.path.join(ROOT, "output")
OUT_ASSETS = os.path.join(OUT, "assets")

# Files under site/ that are pages rather than assets. Everything else in the
# directory is copied into output/assets/ and referenced as /assets/<name>.
PAGES = {"index.html", "calendar.html"}


def main():
    os.makedirs(OUT_ASSETS, exist_ok=True)

    for name in sorted(os.listdir(SITE)):
        src = os.path.join(SITE, name)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(OUT if name in PAGES else OUT_ASSETS, name)
        shutil.copyfile(src, dst)
        print("  " + os.path.relpath(dst, ROOT))

    for name in ("fonts.css", "rc_system.css"):
        shutil.copyfile(os.path.join(ASSETS, name), os.path.join(OUT_ASSETS, name))
        print("  output/assets/" + name)

    # The logo lives in the repo as a data URI because the dashboard inlines it.
    # The linked pages want a real file, so decode it once here.
    with open(os.path.join(ASSETS, "logo_base64.txt")) as fh:
        payload = fh.read().strip().split(",", 1)[-1]
    with open(os.path.join(OUT_ASSETS, "logo.png"), "wb") as fh:
        fh.write(base64.b64decode(payload))
    print("  output/assets/logo.png")

    print("Site assembled in output/")


if __name__ == "__main__":
    main()
