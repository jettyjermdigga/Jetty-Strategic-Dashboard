// One source of truth for the calendar's category tree. The Worker validates
// writes against it and serves it at /api/taxonomy so the filter sidebar and
// the add-item form are always built from the same list.
//
// Adding a type: drop a string into the `types` array. Adding a category:
// append an object here and pick a colour that is distinguishable from the
// others at small sizes -- these render as 10px dots in month view.

export const CATEGORIES = [
  {
    key: 'events',
    label: 'Events',
    color: '#43575E',           // Deep Sea -- the house colour, events lead
    types: [
      'Box Truck', 'Festival', 'Race / Endurance', 'Retail Pop-Up',
      'Wholesale / Trade Show', 'Community / Volunteer', 'Sponsorship', 'Other',
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    color: '#C6803B',
    types: [
      'Email', 'SMS', 'Promotion / Sale', 'Product Launch',
      'Social Campaign', 'Press / PR', 'Photo / Video Shoot', 'Other',
    ],
  },
  {
    key: 'meetings',
    label: 'Meetings',
    color: '#586D72',
    types: [
      'Weekly Kick-off', 'Strategy', 'Board / Investor',
      'Department', 'One-on-one', 'Review', 'Other',
    ],
  },
  {
    key: 'production',
    label: 'Production',
    color: '#6B5B95',
    types: [
      'Design Deadline', 'Sample Review', 'PO Cut-off', 'Delivery Window',
      'Screen Print Run', 'Embroidery Run', 'Other',
    ],
  },
  {
    key: 'finance',
    label: 'Finance',
    color: '#2F7A5C',
    types: [
      'Payroll', 'Payment Due', 'Reporting / Close',
      'Audit / Tax', 'Bank / Credit Line', 'Other',
    ],
  },
  {
    key: 'company',
    label: 'Company',
    color: '#B4482F',
    types: [
      'Holiday', 'PTO / Out of Office', 'Store Closure',
      'Training', 'Culture / Team', 'Other',
    ],
  },
];

// Divisions cut across every category, so they are a separate axis rather than
// a level of the tree -- a box truck event and an email can both be "INK".
export const DIVISIONS = [
  { key: 'company-wide', label: 'Company-wide', color: '#43575E' },
  { key: 'brand',        label: 'Brand',        color: '#2F7A5C' },
  { key: 'ink',          label: 'INK',          color: '#6B5B95' },
  { key: 'jrf',          label: 'JRF',          color: '#C6803B' },
  { key: 'wholesale',    label: 'Wholesale',    color: '#586D72' },
  { key: 'dtc',          label: 'DTC',          color: '#B4482F' },
  { key: 'retail',       label: 'Retail',       color: '#8A6D3B' },
  { key: 'operations',   label: 'Operations',   color: '#4A6FA5' },
];

export const STATUSES = ['Confirmed', 'Tentative', 'Cancelled'];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const DIVISION_KEYS = DIVISIONS.map((d) => d.key);

export function categoryByKey(key) {
  return CATEGORIES.find((c) => c.key === key) || null;
}

export const TAXONOMY = { categories: CATEGORIES, divisions: DIVISIONS, statuses: STATUSES };
