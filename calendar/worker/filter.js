// Which events a feed carries.
//
// The same rule the calendar's own chips follow, so a link built from what is
// on screen returns what is on screen: values on one axis are alternatives,
// different axes narrow together, and an axis nobody asked about does not
// filter at all.
//
// Worker-side and shared by the feed, so "subscribe to what I am looking at"
// cannot drift from what the page showed.

const AXES = [
  { param: 'dept', of: (it) => [it.department].concat(split(it.departments)) },
  { param: 'kind', of: (it) => [it.event_type] },
  { param: 'sub', of: (it) => split(it.sub_types) },
  { param: 'veh', of: (it) => split(it.vehicles) },
  { param: 'status', of: (it) => [it.status] },
];

function split(v) {
  return v ? String(v).split(',').filter(Boolean) : [];
}

/** Read the axes out of a URL's query string. */
export function readFilters(params) {
  const out = {};
  for (const axis of AXES) {
    const raw = params.get(axis.param);
    if (raw) out[axis.param] = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

export function matches(item, filters) {
  for (const axis of AXES) {
    const want = filters[axis.param];
    if (!want || !want.length) continue;
    const have = axis.of(item).filter(Boolean);
    // "none" asks for the events with nothing on this axis -- the one question
    // a list of values cannot express, and how Unassigned works on the page.
    if (!have.length) {
      if (!want.includes('none')) return false;
      continue;
    }
    if (!have.some((v) => want.includes(v))) return false;
  }
  return true;
}

/** A name Google can show in its sidebar, built from what was asked for. */
export function feedName(filters, labelFor) {
  const parts = [];
  for (const axis of AXES) {
    const want = filters[axis.param];
    if (want && want.length) parts.push(want.map((k) => labelFor(axis.param, k)).join(' / '));
  }
  return parts.length ? 'Jetty — ' + parts.join(' · ') : 'Jetty Company Calendar';
}
