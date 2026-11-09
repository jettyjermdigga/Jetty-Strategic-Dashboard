// The calendar's directory page.
//
// Reads /api/people, which already works out `channel` and `source` for each
// row -- the page does not decide how somebody is reached, it only shows
// what the Worker decided. Two places deciding that is two places to get it
// wrong, and only one of them is the one that actually sends.
(function () {
  'use strict';

  var sub = document.getElementById('sub');
  var notice = document.getElementById('notice');
  var bar = document.getElementById('bar');
  var list = document.getElementById('list');
  var form = document.getElementById('form');
  var filter = document.getElementById('filter');
  var fName = document.getElementById('f-name');
  var fEmail = document.getElementById('f-email');
  var fSlack = document.getElementById('f-slack');
  var err = document.getElementById('err');

  var people = [];
  var outside = [];
  var slackOn = false;
  var mailOn = false;
  var canEdit = false;

  function say(msg, bad) {
    notice.innerHTML = '';
    if (!msg) return;
    var p = document.createElement('p');
    p.className = bad ? 'pp-warn' : 'pp-hint';
    p.textContent = msg;
    notice.appendChild(p);
  }

  function via(p) {
    if (p.channel === 'slack') return ['Slack', 'pp-via-slack'];
    if (p.channel === 'none') return ['Not notified', 'pp-via-none'];
    return ['Email', 'pp-via-email'];
  }

  function matches(p) {
    var f = filter.value;
    if (f === 'all') return true;
    if (f === 'typed') return p.source === 'typed here';
    if (f === 'feed') return Boolean(p.feed);
    return p.channel === f;
  }

  function draw() {
    list.innerHTML = '';
    var shown = people.filter(matches);
    if (!shown.length) {
      var e = document.createElement('p');
      e.className = 'pp-empty';
      e.textContent = 'Nobody matches that.';
      list.appendChild(e);
      return;
    }
    shown.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'pp-person' + (p.channel === 'none' ? ' pp-off' : '');

      var name = document.createElement('div');
      name.className = 'pp-name';
      name.textContent = p.name || '(no name)';
      row.appendChild(name);

      var mail = document.createElement('div');
      mail.className = 'pp-email';
      mail.textContent = p.email;
      row.appendChild(mail);

      var sp = document.createElement('div');
      sp.className = 'pp-spacer';
      row.appendChild(sp);

      var v = via(p);
      var tag = document.createElement('span');
      tag.className = 'pp-via ' + v[1];
      tag.textContent = v[0];
      row.appendChild(tag);

      var src = document.createElement('div');
      src.className = 'pp-src';
      src.textContent = 'from ' + p.source;
      row.appendChild(src);

      // The calendar feed. Shown for everybody who holds one because it is
      // the one credential that is not behind Access and does not go
      // through their mailbox -- so it is the one that quietly outlives an
      // offboarding.
      if (p.feed) {
        var feed = document.createElement('span');
        feed.className = 'pp-feed';
        feed.textContent = 'Calendar feed';
        feed.title = 'They hold a subscription link. It works without signing in.';
        row.appendChild(feed);
      }

      // Built now, appended last: it is full-width and would otherwise push
      // the buttons onto a line of their own.
      var warn = null;
      if (outside.indexOf(p.email) >= 0) {
        warn = document.createElement('div');
        warn.className = 'pp-warn';
        warn.textContent = 'Cloudflare Access does not admit this domain. Reminders '
          + 'still reach them, but they cannot open the event one is about.';
      }
      if (!canEdit) {
        if (warn) row.appendChild(warn);
        list.appendChild(row);
        return;
      }

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'pp-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', function () { open(p); });
      row.appendChild(edit);

      // "Not notified" rather than "Remove": the row may well stay, because
      // one that came from Slack comes straight back on the next refresh.
      // Revoking on its own: a lost laptop is not an offboarding, and
      // somebody can need a new link without being switched off.
      if (p.feed) {
        var cut = document.createElement('button');
        cut.type = 'button';
        cut.className = 'pp-drop';
        cut.textContent = 'Revoke feed';
        cut.addEventListener('click', function () { revoke(p); });
        row.appendChild(cut);
      }

      var drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'pp-drop';
      drop.textContent = p.channel === 'none' ? 'Turn back on' : 'Stop notifying';
      // Said before it happens, not after. Switching somebody off also cuts
      // their calendar link, and that is not what the words on the button
      // say on their own.
      drop.title = p.channel === 'none' ? 'Start notifying them again.'
        : (p.feed ? 'Stops reminders AND revokes their calendar feed link.'
                  : 'Stops reminders. They keep whatever access Access gives them.');
      drop.addEventListener('click', function () { toggle(p); });
      row.appendChild(drop);

      if (warn) row.appendChild(warn);
      list.appendChild(row);
    });
  }

  function open(p) {
    err.textContent = '';
    fName.value = (p && p.name) || '';
    fEmail.value = (p && p.email) || '';
    fSlack.value = (p && p.slack_id) || '';
    form.hidden = false;
    (p ? fName : fEmail).focus();
  }

  function post(body) {
    return fetch('/api/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    });
  }

  function revoke(p) {
    post({ email: p.email, revokeFeed: true }).then(function (r) {
      if (!r.ok) { say((r.body && r.body.error) || 'That did not save.', true); return; }
      say(r.body.note || '', !r.body.feedRevoked);
      load();
    });
  }

  function toggle(p) {
    if (p.channel !== 'none') {
      post({ email: p.email, remove: true }).then(function (r) {
        if (!r.ok) { say((r.body && r.body.error) || 'That did not save.', true); return; }
        say(r.body.note || ('Stopped notifying ' + p.email + '.'), false);
        load();
      });
      return;
    }
    post({ name: p.name, email: p.email, slack_id: p.slack_id || '', active: true })
      .then(function (r) {
        if (!r.ok) { say((r.body && r.body.error) || 'That did not save.', true); return; }
        load();
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    post({ name: fName.value, email: fEmail.value, slack_id: fSlack.value })
      .then(function (r) {
        if (!r.ok) { err.textContent = (r.body && r.body.error) || 'That did not save.'; return; }
        form.hidden = true;
        load();
      });
  });

  document.getElementById('add').addEventListener('click', function () { open(null); });
  document.getElementById('cancel').addEventListener('click', function () {
    form.hidden = true;
    err.textContent = '';
  });
  filter.addEventListener('change', draw);

  function load() {
    return fetch('/api/people').then(function (r) { return r.json(); }).then(function (d) {
      people = d.people || [];
      outside = d.outsideAccess || [];
      slackOn = Boolean(d.slackConfigured);
      mailOn = Boolean(d.mailConfigured);
      canEdit = Boolean(d.canEdit);
      bar.hidden = false;
      // A reader sees the directory and changes nothing. Hidden rather than
      // disabled: a button that exists and refuses reads as a fault.
      document.getElementById('add').hidden = !canEdit;
      if (!canEdit) form.hidden = true;

      var n = people.length;
      var onSlack = people.filter(function (p) { return p.channel === 'slack'; }).length;
      sub.textContent = n + (n === 1 ? ' person' : ' people') + ', '
        + onSlack + ' reachable on Slack';

      // Said once, at the top, rather than on every row: a calendar that can
      // reach nobody is one fact about the Worker, not a fact about people.
      if (!slackOn && !mailOn) {
        say('Nothing can be sent yet: there is no Slack token and no mail '
          + 'service configured, so reminders will record why and send nothing.', true);
      } else if (!slackOn) {
        say('No Slack token, so everybody is reached by email.', false);
      } else if (!mailOn) {
        say('No mail service configured yet, so anybody without a Slack ID '
          + 'cannot be reached. Everybody on Slack is fine.', false);
      } else {
        say('', false);
      }
      draw();
    }).catch(function () {
      sub.textContent = 'Could not load';
      say('The directory did not load. Reload the page.', true);
    });
  }

  load();
}());
