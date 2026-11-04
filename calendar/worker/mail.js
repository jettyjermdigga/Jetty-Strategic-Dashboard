// Sending one email.
//
// Through Resend, which is an HTTPS call -- a Worker has no sockets to
// speak SMTP over, and the alternative was an OAuth token against somebody's
// mailbox that quietly expires. This module is the whole of what knows the
// provider: swapping it is this file and one secret.
//
// `post` is passed in rather than reaching for fetch, so every path through
// here is testable without a network and without an API key. Same shape as
// the Xero calls in the commissions module, for the same reason.

export const RESEND_URL = 'https://api.resend.com/emails';

/**
 * As many reminders as one run will send.
 *
 * Not a provider limit. It is the blast radius of a bug: a mistake that
 * made everything look due sends fifty emails instead of every deadline
 * this calendar has ever held. A run that hits the cap says so and the next
 * one picks the rest up.
 */
export const MAX_PER_RUN = 50;

/** Whether the Worker is set up to send at all. */
export function canSend(env) {
  return Boolean(env && env.RESEND_KEY && env.REMINDER_FROM);
}

/**
 * Why it cannot, in words for the page rather than a boolean.
 *
 * Two different missing things with two different fixes: one is a secret
 * and one is a line of config, and "email is not configured" sends somebody
 * to read the wrong half of the README.
 */
export function whyNotSending(env) {
  const e = env || {};
  if (!e.RESEND_KEY && !e.REMINDER_FROM) {
    return 'No RESEND_KEY secret and no REMINDER_FROM address.';
  }
  if (!e.RESEND_KEY) return 'The RESEND_KEY secret is not set on this Worker.';
  if (!e.REMINDER_FROM) return 'REMINDER_FROM is not set in wrangler.toml.';
  return '';
}

/**
 * One email, sent.
 *
 * Returns { id } or throws with something a person can act on. Resend
 * answers 4xx with a JSON body naming what it objected to, and the common
 * one is a From address on a domain nobody has verified yet -- which is a
 * DNS job, not a code one, so the message has to survive to the page.
 */
export async function sendMail({ key, from, replyTo, to, subject, body, post }) {
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) throw new Error('No one to send it to.');
  if (!from) throw new Error('No From address is set.');

  const res = await post(RESEND_URL, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: list,
      subject,
      text: body,
      // Replies go to a person, not to the Worker. Without this a reply to
      // a reminder goes to whatever mailbox the From address is, which may
      // be one nobody reads.
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  const out = await res.json().catch(() => null);
  if (!res.ok) {
    const why = (out && (out.message || out.name)) || ('HTTP ' + res.status);
    throw new Error('The mail service refused it: ' + why);
  }
  return { id: (out && out.id) || '' };
}
