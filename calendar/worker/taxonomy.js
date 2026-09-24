// The calendar's whole structure, from the menu spreadsheet. The Worker
// validates writes against it and serves it at /api/taxonomy, so the filter
// sidebar, the add form, the colour bands and the Google Calendar descriptions
// are all built from this file and nothing else.
//
// Three axes, because the menu's second level turned out to hold three
// different kinds of thing:
//
//   EVENT_TYPES  the calendars themselves. Peers -- no primary, no owner. An
//                event carries every one involved and shows on each of their
//                calendars. Coquina Jam is a JRF event that the Box Truck
//                always works, and naming either the owner would misdescribe it.
//   SUB_TYPES    what kind of item it is, scoped to one Event Type. Only
//                Marketing has them so far.
//   NEEDS        what an event requires. Cross-cutting: "do we need the mobile
//                bar?" is a fair question of a JRF event and a box truck event
//                alike, which is why Drifting Buoy appeared under two parents
//                on the menu sheet.

// Colours are a validated categorical palette: both modes pass the lightness
// band, chroma floor, normal-vision separation and (in dark) 3:1 contrast. The
// order below is the order bands stack in, and the palette was validated on
// exactly that adjacency -- reordering this array means revalidating it.
//
// Two adjacent pairs sit in the 6-8 CVD separation band, which is legal only
// because colour is never the sole encoding here: every day, week and agenda
// row prints the Event Type names, the sidebar pairs each dot with its label,
// and the detail view lists them as labelled chips.
export const EVENT_TYPES = [
  { key: 'box-truck-events', label: 'Box Truck & Events', color: '#0b7aa8', colorDark: '#2790bd',
    note: 'Mobile store and/or tent setup selling Jetty/JRF apparel',
    sheetValues: ['Box Truck'] },
  { key: 'flagship-store', label: 'Flagship Store', color: '#eb6834', colorDark: '#d95926',
    note: 'Events at our brick-and-mortar store' },
  { key: 'long-branch-store', label: 'Long Branch Store', color: '#4a3aa7', colorDark: '#9085e9',
    note: 'Events at our brick-and-mortar store' },
  { key: 'jrf', label: 'Jetty Rock Foundation (JRF)', color: '#008300', colorDark: '#008300',
    note: 'Fundraising events/initiatives involving our nonprofit',
    sheetValues: ['JRF'] },
  { key: 'jetty-ink', label: 'Jetty INK', color: '#e34948', colorDark: '#e66767',
    note: 'Events involving live screenprinting and/or non-brand apparel sales',
    sheetValues: ['INK'] },
  { key: 'wholesale', label: 'Wholesale', color: '#2a78d6', colorDark: '#3987e5',
    note: 'Tradeshows, sales trips and other industry events affecting our retail network' },
  { key: 'marketing', label: 'Marketing', color: '#eda100', colorDark: '#c98500',
    note: 'MKG-specific events that our team uses as a guide to plan for',
    sheetValues: ['MKG-specific', 'MKG'] },
  { key: 'meetings', label: 'Meetings', color: '#a34a8f', colorDark: '#c06aab',
    note: 'Milestone meetings with mixed departments' },
  { key: 'logistics', label: 'Logistics', color: '#1baf7a', colorDark: '#199e70' },
  { key: 'prodev', label: 'ProDev', color: '#c05fd6', colorDark: '#c05fd6' },
  { key: 'culture', label: 'Culture', color: '#7d8a3c', colorDark: '#8b9645',
    note: 'Team-building' },
];

// A meeting for one department is tagged Meetings + that department, so it
// lands on both calendars. That is why the menu's Meetings sub-list needs no
// separate existence: six of its eight entries are Event Types already.
export const SUB_TYPES = [
  { key: 'ambassador',  label: 'Ambassador',  parent: 'marketing', note: 'MKG events/initiatives involving an ambassador' },
  { key: 'influencer',  label: 'Influencer',  parent: 'marketing', note: 'MKG events/initiatives involving an influencer' },
  { key: 'promotion',   label: 'Promotion',   parent: 'marketing', note: 'A campaign involving a sale, contest, etc.' },
  { key: 'campaign',    label: 'Campaign',    parent: 'marketing', note: 'A seasonal brand campaign highlighting products' },
  { key: 'email-sms',   label: 'Email/SMS',   parent: 'marketing', note: 'Product & promo-based themes for email/SMS lifecycle MKG' },
  { key: 'photo-video', label: 'Photo/Video', parent: 'marketing', note: 'Photo & video shoots' },
  { key: 'collab',      label: 'Collab',      parent: 'marketing', note: 'Campaigns involving a collab partner' },
];

// Each of these is a yes/no on any event, whatever its Event Type.
export const NEEDS = [
  { key: 'drifting-buoy',  label: 'Drifting Buoy',         note: 'Do we need the mobile bar?' },
  { key: 'social-permit',  label: 'Social Permit',         note: 'Do we need to apply for a social permit?' },
  { key: 'sound',          label: 'Sound',                 note: 'Do we need a sound tech?' },
  // Arrived in the sheet's Event Type column as "JBC"; it is a reminder that
  // the event wants our own branded beer, not a calendar of its own.
  { key: 'jetty-brewing',  label: 'Jetty Brewing Company', note: 'Do we need our own branded beer?',
    sheetValues: ['JBC'] },
];

// Booked is the sheet's checkbox; anything unchecked is still being chased.
export const STATUSES = ['Booked', 'Pending'];

// Retail week 1 of 2026 runs Sun 4 Jan to Sat 10 Jan, taken from the 2026 box
// truck calendar. Other years step 364 days from this anchor, which holds until
// a 53-week year comes along -- add that year explicitly here when it does.
export const RETAIL_EPOCH = '2026-01-04';
export const RETAIL_EPOCH_YEAR = 2026;

export const EVENT_TYPE_KEYS = EVENT_TYPES.map((e) => e.key);
export const SUB_TYPE_KEYS = SUB_TYPES.map((s) => s.key);
export const NEED_KEYS = NEEDS.map((n) => n.key);

export function eventTypeByKey(key) { return EVENT_TYPES.find((e) => e.key === key) || null; }
export function subTypeByKey(key) { return SUB_TYPES.find((s) => s.key === key) || null; }

export const TAXONOMY = {
  eventTypes: EVENT_TYPES,
  subTypes: SUB_TYPES,
  needs: NEEDS,
  statuses: STATUSES,
  retailEpoch: RETAIL_EPOCH,
  retailEpochYear: RETAIL_EPOCH_YEAR,
};
