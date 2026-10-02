"""Turns the MKG Comms export into the rows the calendar stores.

Run by hand, not in CI: the export is a one-off and the output is committed, so
the backfill migration has something to read without the Worker fetching
anything at run time.

    python3 calendar/backfill/build_social.py <export.csv> > calendar/backfill/social.json

Only rows that can actually go on a calendar come out: Type is Social, the
Launch date parses, and that date is 2026 or later -- which is what was asked
for, and keeps 851 rows of 2025 history off a calendar nobody will edit it on.
"""
import csv, json, re, sys, uuid, datetime

# A fixed namespace, so every run of this script gives a row the same id. That
# is what lets the backfill use INSERT OR IGNORE and be safe to re-run even if
# the meta guard were lost: a second pass collides on the primary key rather
# than making a second copy of 398 posts.
NAMESPACE = uuid.UUID('6f9619ff-8b86-d011-b42d-00c04fc964ff')

# The sheet's Division column is a business unit, not the product division on a
# highlight row. Brand is the main account, so it reads as Marketing; JBC folds
# into Marketing too, by instruction.
DIVISION_TO_DEPT = {
    'brand': 'marketing', 'jbc': 'marketing',
    'jrf': 'jrf', "women's": 'womens', 'womens': 'womens',
    'ink': 'jetty-ink', 'long branch': 'long-branch-store',
    'flagship store': 'flagship-store', 'box truck': 'box-truck',
}
# Which department owns an item tagged with several. Mirrors PRIMACY.
PRIMACY = ['jrf', 'box-truck', 'flagship-store', 'long-branch-store', 'wholesale',
           'jetty-ink', 'culture', 'logistics', 'product-development', 'womens',
           'finance', 'marketing']

SOCIAL_TYPE = {'post': 'post', 'carousel': 'carousel', 'story': 'story', 'reel': 'reel'}

# Category held two different things: a channel, and what the post is about.
CATEGORY_CHANNEL = {'linkedin': 'linkedin'}
CATEGORY_PILLAR = {
    'community': 'community', 'buzz': 'buzz', 'environment': 'environment',
    'product': 'product', 'sea': 'sea', 'land': 'land', 'ink': 'ink',
    'everything else': 'everything-else',
}
PRODUCTION = {
    'scheduled': 'scheduled', 'pending review': 'pending-review',
    'needs caption': 'needs-caption', 'missing assets': 'missing-assets',
    'approved, needs scheduling': 'needs-scheduling',
}

def cell(row, key):
    v = (row.get(key) or '').strip()
    return '' if v in ('NaN', '$0.00') else v

def parse_date(s):
    try:
        return datetime.datetime.strptime(s, '%m/%d/%Y').date()
    except ValueError:
        return None

def split_multi(v):
    # Airtable writes multi-selects comma-separated, and quotes a value that
    # contains its own comma -- "Approved, Needs Scheduling" is ONE value.
    return [x.strip() for x in re.findall(r'"[^"]*"|[^,]+', v or '') if x.strip()]

def clean_time(v):
    m = re.match(r'^(\d{1,2}):(\d{2})$', v or '')
    if not m:
        return ''
    h, mi = int(m.group(1)), int(m.group(2))
    return '%02d:%02d' % (h, mi) if 0 <= h < 24 and 0 <= mi < 60 else ''

def main(path):
    rows = list(csv.DictReader(open(path, encoding='utf-8-sig')))
    out, skipped = [], {'not_social': 0, 'no_date': 0, 'too_old': 0, 'empty': 0}

    for r in rows:
        if cell(r, 'Type') != 'Social':
            skipped['not_social'] += 1
            continue
        when = parse_date(cell(r, 'Launch \U0001F680'))
        if not when:
            skipped['no_date'] += 1
            continue
        if when.year < 2026:
            skipped['too_old'] += 1
            continue

        depts = []
        for d in split_multi(cell(r, 'Division')):
            key = DIVISION_TO_DEPT.get(d.strip().strip('"').lower())
            if key and key not in depts:
                depts.append(key)
        depts.sort(key=lambda k: PRIMACY.index(k))

        category = cell(r, 'Category')
        channels = []
        chan = CATEGORY_CHANNEL.get(category.lower())
        if chan:
            channels.append(chan)
        pillar = CATEGORY_PILLAR.get(category.lower(), '')

        production = []
        for v in split_multi(cell(r, 'Social Status')):
            key = PRODUCTION.get(v.strip().strip('"').lower())
            if key and key not in production:
                production.append(key)

        stype = SOCIAL_TYPE.get(cell(r, 'Social Type').lower(), '')

        # A row with no name, no caption, no division and no shape is a blank
        # line in the sheet. It would land as "Social Post -- Mar 24" with
        # nothing behind it, which is worse than not being on the calendar.
        if not (cell(r, 'Name') or cell(r, 'Caption') or depts or stype
                or cell(r, 'Notes') or category):
            skipped['empty'] += 1
            continue

        title = cell(r, 'Name')
        if not title:
            # 160 rows have no name. A caption is the next best thing it was
            # actually called; failing that, say what it is and when, which is
            # at least findable.
            cap = cell(r, 'Caption')
            if cap:
                title = cap.splitlines()[0][:80]
            else:
                shape = (stype or 'post').title()
                who = depts[0].replace('-', ' ').title() if depts else 'Social'
                title = '%s %s — %s' % (who, shape, when.strftime('%b %-d'))

        time = clean_time(cell(r, 'Post Time'))
        out.append({
            # Shape and department are in the key because the same recap can
            # legitimately run twice on a day as a post and as a story.
            'id': str(uuid.uuid5(NAMESPACE, '%s|%s|%s|%s|%s' % (
                when.isoformat(), title[:200], cell(r, 'Caption')[:120],
                stype, depts[0] if depts else ''))),
            'title': title[:200],
            'event_type': 'social',
            'department': depts[0] if depts else None,
            'departments': ','.join(depts[1:]) or None,
            'sub_types': 'collab' if cell(r, 'Collab') else None,
            'status': 'Booked',
            'start_date': when.isoformat(),
            'end_date': when.isoformat(),
            'all_day': 0 if time else 1,
            'start_time': time or None,
            'social_type': stype or None,
            'channels': ','.join(channels) or None,
            'pillar': pillar or None,
            'production': ','.join(production) or None,
            'caption': cell(r, 'Caption')[:4000] or None,
            'tags': cell(r, 'Tag(s)')[:500] or None,
            'notes': cell(r, 'Notes')[:4000] or None,
            'url': cell(r, 'Link')[:500] or None,
        })

    out.sort(key=lambda x: (x['start_date'], x['title']))
    sys.stderr.write('kept %d; skipped %r\n' % (len(out), skipped))
    print(json.dumps(out, ensure_ascii=False, indent=0, separators=(',', ':')))

if __name__ == '__main__':
    main(sys.argv[1])
