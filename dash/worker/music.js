// What a week's pick has to look like before it is allowed into the archive.
//
// Music Monday ran out of Airtable for thirteen years and then stopped: the
// import carried the history across, but nothing was ever built to add the
// NEXT Monday, so the page froze on the last row that came over. Everything
// here exists so a pick can be posted on the dash itself.
//
// Pure, and in the Worker rather than the page, so Node can test it. The
// page keeps its own copy of youtubeId and weekLabel -- duplicated on
// purpose, the same as the rest of this portal -- pinned by a mirror test.

/** A date the archive will accept: a real YYYY-MM-DD, not a typo'd month. */
export function cleanDate(s) {
  const v = String(s == null ? '' : s).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  // Round-trip through UTC: catches 31 February and the like, which the
  // range check above lets through.
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  // 2013 is the first Music Monday. A year beyond next is a slip of the
  // keyboard, not a pick scheduled very far ahead.
  if (y < 2013 || y > new Date().getUTCFullYear() + 1) return '';
  return v;
}

/** The Monday of the week a date falls in, so a pick posted on Wednesday
 *  still files under the Monday everybody refers to it by. */
export function mondayOf(date) {
  const v = cleanDate(date);
  if (!v) return '';
  const t = new Date(v + 'T00:00:00Z');
  // getUTCDay: 0 Sunday. Sunday belongs to the Monday before it, which is
  // six days back, not tomorrow.
  const back = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - back);
  return t.toISOString().slice(0, 10);
}

// Every shape a YouTube link arrives in. Nobody is going to dig the id out
// of the address bar by hand, so the field takes whatever was copied.
const YT = [
  /[?&]v=([A-Za-z0-9_-]{11})/,          // watch?v=
  /youtu\.be\/([A-Za-z0-9_-]{11})/,     // short link
  /\/embed\/([A-Za-z0-9_-]{11})/,       // embed
  /\/shorts\/([A-Za-z0-9_-]{11})/,      // shorts
  /\/live\/([A-Za-z0-9_-]{11})/,        // live
];

/** The eleven-character id, from a url of any shape or from the id itself.
 *  Empty when it is not YouTube -- a SoundCloud link is not a failure, it
 *  just belongs in video_url instead. */
export function youtubeId(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  for (const re of YT) {
    const m = v.match(re);
    if (m) return m[1];
  }
  return '';
}

/** Is this a YouTube address at all? A link that is but whose id we could
 *  not read is worth saying so about, rather than silently filing under
 *  "some other video" where no player will ever appear. */
export function isYouTube(s) {
  return /(^|\.|\/\/)(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i
    .test(String(s == null ? '' : s).trim());
}

/** A week ready for the database, or the reasons it is not. */
export function cleanPick(input) {
  const i = input && typeof input === 'object' ? input : {};
  const errors = [];

  const date = cleanDate(i.date);
  if (!date) errors.push('A pick needs a date, as YYYY-MM-DD.');

  const artist = String(i.artist == null ? '' : i.artist).trim().slice(0, 200);
  if (!artist) errors.push('A pick needs an artist.');

  const watch = String(i.watch == null ? '' : i.watch).trim().slice(0, 500);
  const youtube = youtubeId(watch);
  // A YouTube link we could not read is a typo worth catching: left alone it
  // would file as a plain link and quietly lose the embedded player.
  if (watch && !youtube && isYouTube(watch)) {
    errors.push('That looks like a YouTube link but has no video id in it.');
  }
  let video = '';
  if (watch && !youtube) {
    if (!/^https?:\/\//i.test(watch)) errors.push('A link has to start with http:// or https://.');
    else video = watch;
  }

  if (errors.length) return { errors };

  return {
    row: {
      date,
      artist,
      song: String(i.song == null ? '' : i.song).trim().slice(0, 200),
      by: String(i.by == null ? '' : i.by).trim().slice(0, 120),
      youtube,
      video,
    },
  };
}

/** What to call the newest pick on the page.
 *
 *  "This week" over a pick from a fortnight ago is the same lie the campaign
 *  board used to tell with "due this week", so it is only said when it is
 *  true: the pick's Monday is the Monday we are standing in.
 */
export function weekLabel(date, today) {
  const a = mondayOf(date);
  const b = mondayOf(today);
  if (!a || !b) return 'Latest pick';
  return a === b ? 'This week' : 'Latest pick';
}

/** Mondays in the recent past with no pick filed against them.
 *
 *  Takes the dates the archive actually holds rather than just the newest
 *  one: a week posted late leaves an older hole behind it, and a reminder
 *  that keeps naming a Monday already filled is a reminder people stop
 *  reading. Shown only to whoever may post.
 */
export function missingMondays(have, today, weeks = 8) {
  const to = mondayOf(today);
  if (!to) return [];
  const has = new Set((have || []).map(mondayOf).filter(Boolean));
  const out = [];
  const t = new Date(to + 'T00:00:00Z');
  for (let i = 0; i < weeks; i++) {
    const d = t.toISOString().slice(0, 10);
    if (!has.has(d)) out.push(d);
    t.setUTCDate(t.getUTCDate() - 7);
  }
  return out;
}
