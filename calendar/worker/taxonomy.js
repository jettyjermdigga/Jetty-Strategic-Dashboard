// One source of truth for the calendar's structure. The Worker validates writes
// against it and serves it at /api/taxonomy, so the filter sidebar, the add
// form, the colour coding and the Google Calendar descriptions are all built
// from this file and nothing else.
//
// Adding a department or a category is a line in an array here.

// Type -- the top-level calendar. Only one so far; meetings, marketing and the
// rest land here as they are defined.
export const CATEGORIES = [
  {
    key: 'box-truck-events',
    label: 'Box Truck & Events',
    sheetValues: ['Event \u{1F3AA}', 'Event', 'Box Truck & Event', 'Box Truck & Events'],
    color: '#43575E',
    // Whose calendar this is. An event on it is owned by this department unless
    // it says otherwise, and every other department on it is tagged in.
    defaultOwner: 'box-truck',
  },
];

// Event Type on the sheet -- which Jetty departments have a role in the event.
// An event can have several, so this is a multi-select rather than a level of
// the category tree.
//
// One department owns an event -- the one that put it on the calendar -- and any
// others are tagged in, which is what makes the event show up on their calendar
// too. Box Truck adds Coquina Jam and tags in JRF and INK; all three see it, and
// it stays a Box Truck & Events item.
export const DEPARTMENTS = [
  { key: 'box-truck',    label: 'Box Truck',     color: '#43575E' },
  { key: 'jrf',          label: 'JRF',           color: '#2F7A5C' },
  { key: 'ink',          label: 'INK',           color: '#6B5B95' },
  { key: 'jbc',          label: 'JBC',           color: '#C6803B' },
  { key: 'mkg-specific', label: 'MKG-specific',  color: '#B4482F' },
];

// Booked is the sheet's checkbox; anything unchecked is still being worked on.
export const STATUSES = ['Booked', 'Pending'];

// Retail week 1 of 2026 runs Sun 4 Jan to Sat 10 Jan, taken from the 2026 box
// truck calendar. Other years step 364 days (52 weeks) from this anchor, which
// holds until a 53-week year comes along -- add that year explicitly here when
// it does.
export const RETAIL_EPOCH = '2026-01-04';
export const RETAIL_EPOCH_YEAR = 2026;

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);

export function categoryByKey(key) {
  return CATEGORIES.find((c) => c.key === key) || null;
}
export function departmentByKey(key) {
  return DEPARTMENTS.find((d) => d.key === key) || null;
}

export const TAXONOMY = {
  categories: CATEGORIES.map(({ key, label, color, defaultOwner }) =>
    ({ key, label, color, defaultOwner })),
  departments: DEPARTMENTS,
  statuses: STATUSES,
  retailEpoch: RETAIL_EPOCH,
  retailEpochYear: RETAIL_EPOCH_YEAR,
};
