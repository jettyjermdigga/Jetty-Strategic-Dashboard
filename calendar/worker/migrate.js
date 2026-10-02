// Moving a stored row off the pre-decision-tree shape: one "Event Type" list
// with no primary, onto Event Type + primary department + the rest.
//
// Kept apart from the Worker so it can be run against a row without a runtime,
// which is the only way to check a migration that rewrites a live table.

import { PRIMACY, SUB_TYPE_KEYS, NEED_KEYS } from './taxonomy.js';

// Eight of the old keys are departments under a new name; "meetings" was never
// a department at all -- it described the kind of item, which is what Event
// Type means now.
export const OLD_TYPE_TO_DEPT = {
  'box-truck-events': 'box-truck',
  'flagship-store': 'flagship-store',
  'long-branch-store': 'long-branch-store',
  'jrf': 'jrf',
  'jetty-ink': 'jetty-ink',
  'wholesale': 'wholesale',
  'marketing': 'marketing',
  'logistics': 'logistics',
  'prodev': 'product-development',
  'culture': 'culture',
};

// Two old needs were really vehicles. The rest -- Drifting Buoy, JBC, Insurance
// and both tent setups -- have no home in the new structure and are dropped, as
// are the Event, Meeting, Blog Post and Seasonal sub-types.
export const OLD_NEED_TO_VEHICLE = { 'box-truck-rig': 'box-truck', 'van': 'ink-van' };

// Comma or semicolon only. A slash is NOT a delimiter: real values contain one.
function splitList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : String(v).split(/[,;]+/))
    .map((x) => String(x).trim()).filter(Boolean);
}

// What one old row becomes. Pure: no database, no clock, no ids.
export function planMigration(row) {
  const oldTypes = splitList(row.event_types);
  const isMeeting = oldTypes.some((t) => t === 'meetings');

  const depts = [];
  for (const t of oldTypes) {
    const d = OLD_TYPE_TO_DEPT[t];
    if (d && !depts.includes(d)) depts.push(d);
  }
  // The old model had no primary, so one has to be chosen. PRIMACY encodes
  // which department is likelier to own an event it shares.
  depts.sort((a, b) => PRIMACY.indexOf(a) - PRIMACY.indexOf(b));

  // Old rows still spell these the unmerged way; fold them before checking the
  // key is real, or a row that never reached the merge migration would lose its
  // sub-type instead of gaining the merged one.
  const subs = [];
  for (const raw of splitList(row.sub_types)) {
    const k = SUB_TYPE_MERGES[raw] || raw;
    if (SUB_TYPE_KEYS.includes(k) && !subs.includes(k)) subs.push(k);
  }

  const needs = [];
  const vehicles = [];
  for (const n of splitList(row.needs)) {
    if (OLD_NEED_TO_VEHICLE[n]) {
      if (!vehicles.includes(OLD_NEED_TO_VEHICLE[n])) vehicles.push(OLD_NEED_TO_VEHICLE[n]);
    } else if (NEED_KEYS.includes(n)) {
      needs.push(n);
    }
  }

  return {
    event_type: isMeeting ? 'meeting' : 'event',
    department: depts[0] || null,
    departments: depts.length > 1 ? depts.slice(1).join(',') : null,
    sub_types: subs.length ? subs.join(',') : null,
    needs: needs.length ? needs.join(',') : null,
    vehicles: vehicles.length ? vehicles.join(',') : null,
    guessedPrimary: depts.length > 1,
  };
}

// Sub-types that turned out to name the same thing, folded onto one key.
//
// Email and SMS carry the same products, categories, SKUs and promotions and
// differ only in which day of the week they land on. A promotion is how a
// campaign reaches people rather than a different kind of item.
//
// Every merged key maps to itself, which is what makes this idempotent: a
// second pass over an already-migrated row writes back what is already there
// instead of duplicating it. Add a pair here and the migration picks it up.
export const SUB_TYPE_MERGES = {
  email: 'email-sms', sms: 'email-sms', 'email-sms': 'email-sms',
  campaign: 'campaign-promotion', promotion: 'campaign-promotion',
  'campaign-promotion': 'campaign-promotion',
};

export function mergeSubTypes(subTypes) {
  const out = [];
  for (const raw of splitList(subTypes)) {
    const key = SUB_TYPE_MERGES[raw] || raw;
    if (!out.includes(key)) out.push(key);
  }
  return out.length ? out.join(',') : null;
}

// The same merge over a saved calendar-sync selection, which is JSON rather
// than a comma list. Returns null when nothing changed, so a feed row that
// never mentioned either is left alone.
export function mergeFeedFilters(filtersJson) {
  let parsed;
  try { parsed = JSON.parse(filtersJson || '{}'); } catch (e) { return null; }
  if (!parsed || !Array.isArray(parsed.sub)) return null;
  const before = parsed.sub.join(',');
  const after = [];
  for (const raw of parsed.sub) {
    const key = SUB_TYPE_MERGES[raw] || raw;
    if (!after.includes(key)) after.push(key);
  }
  if (after.join(',') === before) return null;
  return JSON.stringify({ ...parsed, sub: after });
}

// Social stopped being a Marketing sub-type and became an event type of its own.
// Pure and idempotent: a row already carrying event_type 'social' and no social
// sub-type comes back unchanged.
export function promoteSocial(row) {
  const subs = splitList(row.sub_types);
  if (!subs.includes('social')) return null;
  const kept = subs.filter((k) => k !== 'social');
  return {
    event_type: 'social',
    sub_types: kept.length ? kept.join(',') : null,
  };
}

// Event and Marketing were one kind, as were Meeting and Deadline. Splitting
// them means deciding which half each stored row belongs to.
//
// The evidence, in order: an item with a place is an Event, whatever else is
// true of it -- a photo shoot at the flagship store is still something
// happening somewhere. Otherwise, an item carrying a Marketing sub-type is
// Marketing. Everything else is an Event, which is the safer default: an Event
// form asks more questions than a Marketing one, so nothing is hidden by being
// put there.
//
// Deadlines are not guessed at. Nothing stored says which meetings were really
// deadlines, and inventing it from a title would be worse than leaving them
// where they are for somebody to re-tag.
const MARKETING_SUBS = ['campaign-promotion', 'email-sms', 'photo-video', 'collab',
                        'ambassador', 'influencer', 'website'];

export function splitKind(row) {
  const was = (row.event_type || '').trim();
  if (was === 'meetings-deadlines') return 'meeting';
  if (was !== 'events-marketing') return null;   // social, or already split
  if ((row.venue || '').trim() || (row.address || '').trim() || (row.city || '').trim()) {
    return 'event';
  }
  const subs = splitList(row.sub_types);
  return subs.some((k) => MARKETING_SUBS.includes(k)) ? 'marketing' : 'event';
}
