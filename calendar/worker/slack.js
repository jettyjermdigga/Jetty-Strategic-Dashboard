// Slack delivery for @mentions on an event comment.
//
// One direction only, by design: the calendar tells Slack that somebody was
// mentioned and links back. A reply typed in Slack does NOT come back here --
// that would mean Slack POSTing into this Worker, which sits behind Cloudflare
// Access and would bounce Slack's servers exactly as it bounced Google's ICS
// fetcher. It would take a third Worker outside Access verifying Slack's
// request signatures, which is not worth it to save a click.
//
// Mentions are delivered as DMs rather than a channel post. A <@U123> in a
// channel only notifies people who are in that channel, so a channel message is
// a notice that may or may not reach anyone; a DM always does.
//
// Everything that builds a message is pure and tested. Everything that talks to
// Slack is below it, fails quietly, and never costs the comment: the comment is
// already stored by the time any of this runs.

// Slack reserves these three in message text. A comment containing "A < B"
// renders as a broken entity otherwise.
export function escapeSlack(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A name to put on the message when the roster has nothing better. The local
// part of a work address is a person's name often enough to beat showing them
// the whole address.
export function displayName(email, name) {
  const n = String(name || '').trim();
  if (n) return n;
  const local = String(email || '').split('@')[0];
  if (!local) return 'Someone';
  return local.replace(/[._-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function eventWhen(item) {
  if (!item) return '';
  const from = item.start_date || '';
  const to = item.end_date || from;
  const span = to && to !== from ? from + ' – ' + to : from;
  if (item.all_day || !item.start_time) return span;
  return span + ' at ' + item.start_time;
}

// The DM. Deliberately short: who, where, what they said, and the way back.
// The body is quoted rather than inlined so a comment that starts with a slash
// or an @ cannot read as a command or a mention of somebody else.
export function commentMessage({ authorName, item, body, url }) {
  const title = escapeSlack(item && item.title ? item.title : 'an event');
  const when = escapeSlack(eventWhen(item));
  const quoted = escapeSlack(body).split('\n').map((l) => '> ' + l).join('\n');
  const link = url ? '\n\n<' + url + '|Open it on the Jetty calendar to reply>' : '';
  return escapeSlack(authorName) + ' mentioned you on *' + title + '*'
    + (when ? ' (' + when + ')' : '') + ':\n\n' + quoted + link;
}

// Deep link back to the event. The origin comes off the request rather than
// config, so it is right on whichever hostname the person is actually using.
export function eventUrl(origin, itemId) {
  if (!origin || !itemId) return '';
  return origin.replace(/\/$/, '') + '/?event=' + encodeURIComponent(itemId);
}

async function slackCall(token, method, payload) {
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(method + ': ' + (body.error || res.status));
  return body;
}

// Everyone in the workspace who has an email, so the picker can offer anyone
// without a list maintained by hand. Bots and deactivated accounts are left
// out -- nobody means to mention them.
export async function fetchSlackPeople(token) {
  const people = [];
  let cursor = '';
  // Bounded rather than "until Slack stops": a pagination bug should not turn
  // into an unbounded loop inside a Worker's CPU budget.
  for (let page = 0; page < 20; page++) {
    const body = await slackCall(token, 'users.list',
      cursor ? { limit: 200, cursor } : { limit: 200 });
    for (const u of body.members || []) {
      const email = u.profile && u.profile.email;
      if (!email || u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      people.push({
        email: String(email).toLowerCase(),
        name: displayName(email, (u.profile.real_name || u.real_name || u.name)),
        slack_id: u.id,
      });
    }
    cursor = (body.response_metadata && body.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  return people;
}

// Returns { sent, errors } rather than throwing. One bad recipient -- a missing
// scope, an account deactivated since the roster was cached -- must not stop
// the rest, and must not cost the comment, which is already stored.
//
// The errors are kept and reported. A mention that silently fails to deliver is
// indistinguishable from a calendar that is working, which is worse than a
// mention that was never offered: people rely on the ping and never learn it is
// not arriving.
export async function dmMentions(token, targets, text) {
  const out = { sent: 0, errors: [] };
  for (const t of targets) {
    if (!t.slack_id) {
      out.errors.push({ email: t.email, error: 'no Slack account for that address' });
      continue;
    }
    try {
      const im = await slackCall(token, 'conversations.open', { users: t.slack_id });
      const channel = im.channel && im.channel.id;
      if (!channel) throw new Error('conversations.open: no channel returned');
      await slackCall(token, 'chat.postMessage', { channel, text, mrkdwn: true });
      out.sent++;
    } catch (e) {
      out.errors.push({ email: t.email, error: String((e && e.message) || e) });
    }
  }
  return out;
}

// Slack's own error strings, turned into the thing to actually go and do.
export function slackHint(error) {
  const e = String(error || '');
  if (/missing_scope/.test(e)) {
    return 'The Slack app is missing a scope. Add chat:write and im:write under '
      + 'OAuth & Permissions, then reinstall the app -- a scope added after '
      + 'installation does nothing until you do.';
  }
  if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(e)) {
    return 'The Slack token is no longer valid. Regenerate it and update the '
      + 'SLACK_BOT_TOKEN secret on the calendar Worker.';
  }
  if (/no Slack account/.test(e)) {
    return 'That address has no Slack account. Their Slack email probably '
      + 'differs from the one the calendar knows them by.';
  }
  if (/ratelimited/.test(e)) return 'Slack is rate limiting us. It should settle on its own.';
  return '';
}
