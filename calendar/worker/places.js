// Places the calendar has already been.
//
// There is no locations table, and deliberately so. A place is not a thing
// anybody maintains -- it is a side effect of having put an event somewhere,
// and a list kept separately from the events would go stale the first time
// nobody remembered to tidy it. So the list is derived from the events every
// time it is asked for: use a venue once and it is on the dropdown, stop
// using it and it stays there as history, which is what you want from a
// calendar that goes back years.
//
// Pure, and in its own file, because index.js imports schema.sql through a
// wrangler rule and cannot be loaded in Node -- the same reason blanks.js and
// products.js are their own files.

const tidy = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

// Two spellings of the same place have to collapse, or the dropdown fills up
// with "Taylor Ave Waterfront", "Taylor Ave. Waterfront" and "taylor ave
// waterfront" -- which is how a convenience turns into a mess.
//
// Punctuation and case are dropped for the comparison only. What is SHOWN is
// whatever was typed most recently, because the latest spelling is the one
// somebody has most recently thought was right.
const fold = (s) => tidy(s).toLowerCase().replace(/[.,'"]/g, '').replace(/\s+/g, ' ');

export const FIELDS = ['venue', 'address', 'city', 'state', 'zip'];

/** A stable id for a place, from its parts. Safe in a value attribute. */
export function placeKey(p) {
  return FIELDS.map((f) => fold(p && p[f])).join('|');
}

/** What the dropdown reads. Venue first, because that is what people call it. */
export function placeLabel(p) {
  const venue = tidy(p && p.venue);
  const address = tidy(p && p.address);
  const city = tidy(p && p.city);
  const state = tidy(p && p.state).toUpperCase();
  const head = venue || address || city || 'Untitled place';
  const where = [city, state].filter(Boolean).join(', ');
  // The address is only worth showing when it is not already the headline --
  // otherwise two thirds of the list reads "123 Main St -- 123 Main St".
  const tail = [venue && address ? address : '', where].filter(Boolean).join(' · ');
  return tail ? head + ' — ' + tail : head;
}

/** True once there is enough of a place to be worth offering again. */
export function hasPlace(p) {
  return FIELDS.some((f) => tidy(p && p[f]) !== '');
}

/**
 * Every distinct place in a set of events, most used first.
 *
 * `rows` are events carrying the five address columns and a start_date. They
 * arrive newest first, which is what makes "the most recent spelling wins"
 * a matter of not overwriting rather than of comparing dates.
 */
export function rollPlaces(rows, limit) {
  const seen = new Map();

  for (const r of rows || []) {
    if (!hasPlace(r)) continue;
    const key = placeKey(r);
    const at = tidy(r.start_date);
    const got = seen.get(key);
    if (!got) {
      seen.set(key, {
        key,
        venue: tidy(r.venue), address: tidy(r.address), city: tidy(r.city),
        state: tidy(r.state).toUpperCase(), zip: tidy(r.zip),
        n: 1, last: at,
      });
      continue;
    }
    got.n++;
    if (at > got.last) got.last = at;
  }

  const out = [...seen.values()];
  // Most used first, then most recent. A venue booked forty times belongs at
  // the top of a list somebody is scanning rather than in date order with
  // everywhere else they went once.
  out.sort((a, b) => (b.n - a.n) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)
    || (placeLabel(a) < placeLabel(b) ? -1 : 1));
  return out.map((p) => ({ ...p, label: placeLabel(p) }))
    .slice(0, limit || out.length);
}
