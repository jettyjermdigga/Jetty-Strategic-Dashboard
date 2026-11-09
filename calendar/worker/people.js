// The calendar's directory of people.
//
// WHAT THIS IS NOT: permission. A row here lets nobody in. Cloudflare Access
// decides who reaches the calendar at all, and CALENDAR_EDITORS decides who
// may change anything once they are in. This table answers a different
// question -- "who can be named, mentioned and reminded, and how do we reach
// them" -- and answering it for somebody Access does not admit produces a
// person who can be tagged on a deadline and cannot open the event it is on.
// listPeople() flags that rather than letting it look fine.
//
// Most of it maintains itself. refreshRoster() pulls the whole Slack
// workspace in every six hours, which is where names and Slack IDs come from
// for everybody who is in Slack -- including guests, which is how an agency
// gets reached. This module is the part that cannot be automatic: the people
// Slack does not know about, and the addresses Slack knows under a different
// name.

/** Deliberately the same shape the deadline form accepts. */
export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

/**
 * A Slack user ID: U for an ordinary workspace, W on Enterprise Grid.
 *
 * Checked because this is the one field somebody has to copy by hand, and a
 * wrong one fails at send time -- a day later, to somebody who is not
 * watching. Better to refuse it where it is typed.
 */
export const SLACK_ID_RE = /^[UW][A-Z0-9]{6,20}$/;

export const MAX_NAME = 80;

/** Upper-cased and trimmed, or '' if it is not one. Slack IDs are not case
 *  sensitive in practice but are always shown upper, and a lower-case paste
 *  that silently did not match would be invisible. */
export function cleanSlackId(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  return SLACK_ID_RE.test(s) ? s : '';
}

/**
 * One row as a person typed it, or null with a reason pushed onto `errors`.
 *
 * The email is the key, so it is the one field with no default. A blank
 * Slack ID is fine and common -- it means "reach them by email" -- but a
 * NON-blank one that is not an ID is a typo, and is refused rather than
 * dropped, because dropping it looks identical to saving it.
 */
export function cleanPerson(input, errors) {
  const say = (m) => { if (errors) errors.push(m); return null; };
  const raw = input || {};

  const email = String(raw.email == null ? '' : raw.email).trim().toLowerCase();
  if (!email) return say('An email address is required.');
  if (!EMAIL_RE.test(email)) return say(email + ' is not an email address.');

  const typedId = String(raw.slack_id == null ? '' : raw.slack_id).trim();
  const slackId = cleanSlackId(typedId);
  if (typedId && !slackId) {
    return say(typedId + ' is not a Slack ID. It looks like U0123ABCD -- '
      + 'open their Slack profile, then "Copy member ID".');
  }

  return {
    email,
    name: String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_NAME),
    slack_id: slackId || null,
    active: raw.active === false || raw.active === 0 || raw.active === '0' ? 0 : 1,
  };
}

/**
 * How a reminder would actually reach this person.
 *
 * 'none' is a real answer and the important one: somebody switched off is
 * still tagged on whatever deadlines already named them, and quietly sending
 * them nothing is how an offboarded account keeps looking like it is covered.
 */
export function channelFor(person) {
  const p = person || {};
  if (p.active === 0 || p.active === false) return 'none';
  return p.slack_id ? 'slack' : 'email';
}

/** Why, in words, for the page. '' when it is going somewhere. */
export function whyNoChannel(person) {
  return channelFor(person) === 'none'
    ? 'Switched off in the directory -- they are not notified.'
    : '';
}

/**
 * Where each address on a deadline would be reached.
 *
 * An address nobody has ever heard of is NOT an error. The whole point of
 * typing addresses rather than picking them is that the person who needs
 * telling may be outside this company entirely, so an unknown address falls
 * back to email -- which is the one channel that works without anybody
 * having been set up first.
 */
export function resolveRecipients(emails, roster) {
  const by = new Map();
  for (const p of roster || []) {
    const key = String(p && p.email || '').toLowerCase();
    if (key) by.set(key, p);
  }
  const out = [];
  const seen = new Set();
  for (const raw of emails || []) {
    const email = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const known = by.get(email);
    if (!known) {
      out.push({ email, name: '', slack_id: null, channel: 'email',
                 why: '', known: false });
      continue;
    }
    out.push({
      email,
      name: known.name || '',
      slack_id: known.slack_id || null,
      channel: channelFor(known),
      // Worked out HERE, from the directory row, because the target this
      // returns does not carry `active` -- so asking channelFor() about the
      // target later gets a confident wrong answer rather than an error.
      why: whyNoChannel(known),
      known: true,
    });
  }
  return out;
}

/** The same list, split by how it goes out. */
export function splitChannels(targets) {
  const out = { slack: [], email: [], none: [] };
  for (const t of targets || []) (out[t.channel] || out.email).push(t);
  return out;
}

/**
 * Where a directory row came from, for the page.
 *
 * Worth showing: a name that came from Slack goes stale on its own and will
 * be corrected on the next refresh, where a hand-typed one will not, and
 * somebody looking at a wrong name needs to know which they are fixing.
 */
export function sourceOf(person) {
  const p = person || {};
  if (p.manual === 1 || p.manual === true) return 'typed here';
  if (p.slack_id) return 'Slack';
  return 'seen in the calendar';
}

/**
 * Addresses in the directory that Cloudflare Access will not admit.
 *
 * The same check CALENDAR_EDITORS already gets, for the same reason: a person
 * who can be tagged and cannot sign in is a row that looks right and leaves
 * somebody staring at a sign-in wall with no idea who to ask. Reminders still
 * reach them -- a reminder is mail, not a page -- so this is a warning and
 * not a refusal.
 */
export function outsideAccess(people, accessDomains) {
  const allowed = String(accessDomains || '').split(',')
    .map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return [];
  return (people || [])
    .map((p) => String(p && p.email || '').toLowerCase())
    .filter((e) => e && !allowed.includes(e.split('@')[1] || ''));
}
