// What each kind of item does not store.
//
// A form that hides a question and a row that keeps the old answer disagree,
// and the row is the one everything else reads -- the export, the feed, the
// detail panel. So the rules live here, apply on write, and are the same rules
// whether the save came from the form, the API or a backfill.
//
// Pulled out of index.js because that file imports schema.sql through a
// wrangler rule and cannot be loaded in Node, which left these rules as the
// one part of the write path with no tests on it.

// Meetings and deadlines take the short form: who, when, and nothing else.
export const MEETING_BLANKS = ['sub_types', 'needs', 'staff_count', 'vehicles',
                               'venue', 'address', 'city', 'state', 'zip', 'products'];

// A post happens online. It keeps its sub-types -- a Collab or an Ambassador
// post really is one -- and its product highlights, which is half the point of
// a product post.
export const SOCIAL_BLANKS = ['needs', 'staff_count', 'vehicles',
                              'venue', 'address', 'city', 'state', 'zip'];
export const SOCIAL_ONLY = ['social_type', 'channels', 'pillar', 'production',
                            'caption', 'tags'];

// Marketing can have a place -- a shoot happens somewhere -- but staff, permits
// and vans are an Event's concern.
export const MARKETING_BLANKS = ['needs', 'staff_count', 'vehicles'];

// Reported after the fact, and only on something that actually sold.
export const RESULTS_ONLY = ['event_fee', 'orders', 'net_revenue'];

// The sub-types that clear anything, and only on a Marketing item.
//
// Scoped to the kind on purpose. An Event can carry an Email sub-type because
// there is a campaign about it -- HopSauce and Coquina Jam both do -- and that
// festival still happens at a real beach. An earlier version of this rule
// keyed on the sub-type alone and wiped both of their venues.
//
// Both halves of the old Email/SMS key, because a text message has no venue
// either; splitting the key was about deadlines, not about places.
export const SENDS = ['email', 'sms'];
export const EMAIL_SMS_BLANKS = ['venue', 'address', 'city', 'state', 'zip', 'products'];

// Mutates `out` in place and returns it, which is how the caller uses it.
export function applyBlanks(out, subs) {
  const kind = out.event_type;
  const isShort = kind === 'meeting' || kind === 'deadline';

  if (isShort) for (const k of MEETING_BLANKS) out[k] = null;
  if (kind === 'social') for (const k of SOCIAL_BLANKS) out[k] = null;
  else for (const k of SOCIAL_ONLY) out[k] = null;
  if (kind === 'marketing') for (const k of MARKETING_BLANKS) out[k] = null;
  // Marketing only -- see EMAIL_SMS_BLANKS. This mirrors exactly what the form
  // stops asking, so no row holds what its own form never showed.
  if (kind === 'marketing' && (subs || []).some((k) => SENDS.includes(k))) {
    for (const k of EMAIL_SMS_BLANKS) out[k] = null;
  }
  // Only an Event takes money at the door.
  if (kind !== 'event') for (const k of RESULTS_ONLY) out[k] = null;
  // A deadline is a point, not a span: it ends the day it falls on.
  if (kind === 'deadline') out.end_date = out.start_date;

  return out;
}
