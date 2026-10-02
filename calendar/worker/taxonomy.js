// The calendar's whole structure, from the decision tree. The Worker validates
// writes against it and serves it at /api/taxonomy, so the filter sidebar, the
// add form, the colour and the Google Calendar descriptions are all built from
// this file and nothing else.
//
// Five axes:
//
//   EVENT_TYPES  what kind of item this is. Two, and exactly one per item. It
//                decides which form you get: an event asks about venues and
//                vehicles, a meeting does not.
//   DEPARTMENTS  whose calendar it is. One primary -- the department that owns
//                the event and gives it its colour -- plus any number of others
//                along for the ride. The Spring Cleaning Sale is a store event
//                that Marketing promotes, not a joint one.
//   SUB_TYPES    what kind of item, scoped to one department. Only Wholesale
//                and Marketing have any.
//   NEEDS        what an event requires. Unscoped: any event can need any of
//                them, whoever is running it. A need can carry a detail -- how
//                many extra staff.
//   VEHICLES     what has to be driven there. Unscoped: any event can need any.

// Colours are a validated categorical palette: both modes pass the lightness
// band, the chroma floor and the normal-vision separation floor, and dark mode
// clears 3:1 against the surface.
//
// The ORDER below is load-bearing. Separation is checked between neighbours in
// this list, and only three positions in it can take an eleventh colour without
// dropping a pair under the floor -- Finance is in one of them. Reordering the
// list, or adding a twelfth department, means running the set back through the
// dataviz palette validator in both modes rather than picking a colour by eye.
//
// Eleven categorical colours is past the point where colour alone separates
// every pair, which is why nothing here relies on colour by itself: every chip
// carries its name, and the detail panel names the department outright.
export const EVENT_TYPES = [
  { key: 'event', label: 'Event',
    note: 'Something happening in the world. Asks where, and what it needs.' },
  { key: 'marketing', label: 'Marketing',
    note: 'A campaign, promo, send or shoot. Asks what kind, and where if it has one.' },
  { key: 'social', label: 'Social',
    note: 'A post, story or reel. Asks about channel, caption and assets.' },
  { key: 'meeting', label: 'Meeting',
    note: 'Internal. Who and when, and nothing else.' },
  { key: 'deadline', label: 'Deadline',
    note: 'A date something is due. One date, no end.' },
];

// Only ever one of these on a post.
export const SOCIAL_TYPES = [
  { key: 'post',     label: 'Post' },
  { key: 'carousel', label: 'Carousel' },
  { key: 'story',    label: 'Story' },
  { key: 'reel',     label: 'Reel' },
];

// Where it goes out. Several at once is normal -- the same cut runs on
// Instagram and Facebook.
export const CHANNELS = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'linkedin',  label: 'LinkedIn' },
  { key: 'tiktok',    label: 'TikTok' },
  { key: 'youtube',   label: 'YouTube' },
  { key: 'blog',      label: 'Blog' },
];

// What the post is about, as the MKG Comms sheet's Category column already
// used them -- minus LinkedIn, which was a channel filed in with the subjects.
export const PILLARS = [
  { key: 'community',   label: 'Community',   sheetValues: ['COMMUNITY'] },
  { key: 'buzz',        label: 'Buzz',        sheetValues: ['BUZZ'] },
  { key: 'environment', label: 'Environment', sheetValues: ['ENVIRONMENT'] },
  { key: 'product',     label: 'Product',     sheetValues: ['Product'] },
  { key: 'sea',         label: 'Sea',         sheetValues: ['SEA'] },
  { key: 'land',        label: 'Land',        sheetValues: ['LAND'] },
  { key: 'ink',         label: 'Ink',         sheetValues: ['INK'] },
  { key: 'everything-else', label: 'Everything Else', sheetValues: ['EVERYTHING ELSE'] },
];

// How far along the work is -- which is not the same question as whether the
// post is happening. "Needs Caption" is about the asset; Booked is about the
// date. Several at once, as the sheet already recorded them.
export const PRODUCTION = [
  { key: 'pending-review',   label: 'Pending Review' },
  { key: 'needs-caption',    label: 'Needs Caption' },
  { key: 'missing-assets',   label: 'Missing Assets' },
  { key: 'needs-scheduling', label: 'Approved \u2014 Needs Scheduling',
    sheetValues: ['Approved, Needs Scheduling'] },
  { key: 'scheduled',        label: 'Scheduled' },
];

export const DEPARTMENTS = [
  { key: 'box-truck',           label: 'Box Truck',                color: '#0b7aa8', colorDark: '#2790bd',
    sheetValues: ['Box Truck', 'Box Truck & Events'] },
  { key: 'flagship-store',      label: 'Flagship Store',           color: '#eb6834', colorDark: '#d95926' },
  { key: 'long-branch-store',   label: 'Long Branch Store',        color: '#4a3aa7', colorDark: '#9085e9',
    sheetValues: ['Long Branch'] },
  { key: 'jrf',                 label: 'Jetty Rock Foundation',    color: '#008300', colorDark: '#008300',
    sheetValues: ['JRF', 'Jetty Rock Foundation (JRF)'] },
  { key: 'jetty-ink',           label: 'Jetty INK',                color: '#e34948', colorDark: '#e66767',
    sheetValues: ['INK'] },
  { key: 'wholesale',           label: 'Wholesale',                color: '#2a78d6', colorDark: '#3987e5',
    sheetValues: ['WHSL'] },
  { key: 'marketing',           label: 'Marketing',                color: '#eda100', colorDark: '#c98500',
    sheetValues: ['MKG-specific', 'MKG'] },
  { key: 'logistics',           label: 'Logistics',                color: '#1baf7a', colorDark: '#199e70' },
  { key: 'product-development', label: 'ProDev',                    color: '#c05fd6', colorDark: '#c05fd6',
    sheetValues: ['ProDev', 'Product Development'] },
  { key: 'culture',             label: 'Culture',                  color: '#7d8a3c', colorDark: '#8b9645',
    sheetValues: ['Team Building / Culture / Building', 'Team Building / Culture', 'Team Building'] },
  { key: 'finance',             label: 'Finance',                  color: '#a34a8f', colorDark: '#c06aab' },
];

// Scoped: the form offers a department's sub-types once that department is the
// primary one, and offers none at all for the eight that have none.
// How the line is cut when an item is about product. Fixed, short, and the
// only required part of a product highlight -- everything else about a
// highlight is free text, because there is no product feed to pick from.
export const DIVISIONS = [
  { key: 'mens',        label: "Men's" },
  { key: 'womens',      label: "Women's" },
  { key: 'yti',         label: 'Youth / Toddler / Infant', short: 'YTI' },
  { key: 'accessories', label: 'Accessories' },
];

export const SUB_TYPES = [
  { key: 'tradeshow',   label: 'Tradeshow',   department: 'wholesale' },
  // Same reasoning as Email/SMS below: a promotion is how a campaign reaches
  // people, not a different kind of thing to put on a calendar.
  { key: 'campaign-promotion', label: 'Campaign/Promo', department: 'marketing',
    sheetValues: ['Campaign', 'Promotion', 'Promo', 'Campaign/Promo', 'Campaign/Promotion'] },
  // One axis value, not two. The same products, categories, SKUs and
  // promotions go out on both -- they are staggered across the week, which is
  // scheduling, not a difference in what the item is about.
  { key: 'email-sms',   label: 'Email/SMS',   department: 'marketing',
    sheetValues: ['Email', 'SMS', 'Email/SMS', 'Email / SMS'] },
  { key: 'photo-video', label: 'Photo/Video', department: 'marketing' },
  { key: 'collab',      label: 'Collab',      department: 'marketing' },
  { key: 'ambassador',  label: 'Ambassador',  department: 'marketing' },
  { key: 'influencer',  label: 'Influencer',  department: 'marketing' },
  { key: 'website',     label: 'Website',     department: 'marketing' },
];

// Unscoped. These were once tied to the department that answers for them --
// extra staff to the Box Truck, permits and sound to JRF -- which meant most
// events could not record a need at all, and the form said so where the
// question should have been. Any event can want any of them.
export const NEEDS = [
  { key: 'extra-staff',   label: 'Extra staff needed',
    detail: { key: 'staff_count', label: 'How many?', placeholder: 'e.g. 3' } },
  { key: 'social-permit', label: 'Social Permit' },
  { key: 'sound',         label: 'Sound' },
];

// Unscoped: whose event it is has no bearing on what has to be driven there.
export const VEHICLES = [
  { key: 'box-truck',     label: 'Box Truck' },
  { key: 'ink-van',       label: 'INK Van' },
  { key: 'brand-transit', label: 'Brand Transit' },
];

// Cancelled is kept rather than deleted so the calendar still answers "what
// happened to that?" -- it shows struck through, and can be filtered out.
export const STATUSES = ['Booked', 'Pending', 'Cancelled'];

// Retail week 1 of 2026 runs Sun 4 Jan to Sat 10 Jan, taken from the 2026 box
// truck calendar. Other years step 364 days from this anchor, which holds until
// a 53-week year comes along -- add that year explicitly here when it does.
export const RETAIL_EPOCH = '2026-01-04';
export const RETAIL_EPOCH_YEAR = 2026;

export const EVENT_TYPE_KEYS = EVENT_TYPES.map((e) => e.key);
export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);
export const DIVISION_KEYS = DIVISIONS.map((d) => d.key);
export const SOCIAL_TYPE_KEYS = SOCIAL_TYPES.map((x) => x.key);
export const CHANNEL_KEYS = CHANNELS.map((x) => x.key);
export const PILLAR_KEYS = PILLARS.map((x) => x.key);
export const PRODUCTION_KEYS = PRODUCTION.map((x) => x.key);
export const SUB_TYPE_KEYS = SUB_TYPES.map((s) => s.key);
export const NEED_KEYS = NEEDS.map((n) => n.key);
export const VEHICLE_KEYS = VEHICLES.map((v) => v.key);

export function departmentByKey(key) { return DEPARTMENTS.find((d) => d.key === key) || null; }
export function subTypesFor(dept) { return SUB_TYPES.filter((s) => s.department === dept); }

// Which department owns an event that names several. Used once, by the
// migration off the old no-primary model: Marketing and INK support other
// people's events far more often than they run their own, and a JRF fundraiser
// stays a JRF fundraiser whoever turns up to work it. Anything this gets wrong
// is one dropdown to fix, and every event it touched is listed in the commit.
export const PRIMACY = [
  'jrf', 'box-truck', 'flagship-store', 'long-branch-store', 'wholesale',
  'jetty-ink', 'culture', 'logistics', 'product-development', 'finance', 'marketing',
];

export const TAXONOMY = {
  eventTypes: EVENT_TYPES,
  departments: DEPARTMENTS,
  divisions: DIVISIONS,
  socialTypes: SOCIAL_TYPES,
  channels: CHANNELS,
  pillars: PILLARS,
  production: PRODUCTION,
  subTypes: SUB_TYPES,
  needs: NEEDS,
  vehicles: VEHICLES,
  statuses: STATUSES,
  retailEpoch: RETAIL_EPOCH,
  retailEpochYear: RETAIL_EPOCH_YEAR,
};
