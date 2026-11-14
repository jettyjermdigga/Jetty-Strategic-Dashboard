// Posting to Slack.
//
// Duplicated from calendar/worker/slack.js rather than imported: these are
// separate Workers with separate bundles, the same as every other piece of
// code shared across this portal. A mirror test pins the two copies so they
// cannot drift apart unnoticed.

/**
 * A message in a channel.
 *
 * Throws on failure. The caller decides what a failure means -- here it
 * means the pick is up and the channel was not told, which is reported
 * rather than swallowed.
 */
export async function postToChannel(token, channel, text) {
  const body = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json; charset=utf-8',
    },
    // link_names so <!channel> is treated as the mention it is.
    body: JSON.stringify({ channel, text, mrkdwn: true, link_names: true }),
  }).then((r) => r.json()).catch(() => ({}));
  if (!body.ok) throw new Error('chat.postMessage: ' + (body.error || 'failed'));
  return body;
}
