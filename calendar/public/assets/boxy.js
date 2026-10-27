(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var D = null;
  var show = 'earning';
  var q = '';
  // Whose detail is open, and what we have already fetched. Cached so
  // opening and closing the same person does not go back to the server.
  var open = '';
  var detail = {};

  var SIGNED_OUT = 'Your sign-in has expired. Reload the page.';

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
    }, opts || {})).then(function (res) {
      if (res.type === 'opaqueredirect' || res.redirected || res.status === 0) {
        throw new Error(SIGNED_OUT);
      }
      if ((res.headers.get('content-type') || '').indexOf('application/json') < 0) {
        throw new Error(res.ok ? SIGNED_OUT : 'The page answered with an error ('
          + res.status + ').');
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          var e = new Error((body.errors && body.errors.join(' ')) || body.error
            || ('Request failed (' + res.status + ')'));
          throw e;
        }
        return body;
      });
    });
  }

  function say(msg) {
    $('#notice').innerHTML = '<div class="notice">' + esc(msg) + '</div>';
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  function rows() {
    var want = (D.board || []).filter(function (r) {
      if (show === 'earning') return r.events > 0;
      if (show === 'owed') return r.balance !== 0;
      return true;
    });
    if (q) {
      var needle = q.toLowerCase();
      want = want.filter(function (r) {
        return (r.name + ' ' + r.dept + ' ' + r.loc).toLowerCase().indexOf(needle) >= 0;
      });
    }
    return want;
  }

  function when(iso) { return String(iso || '').slice(0, 10); }

  function detailHtml(k) {
    var d = detail[k];
    if (!d) return '<div class="bx-d-load">Loading\u2026</div>';
    if (d.error) return '<div class="bx-d-load">' + esc(d.error) + '</div>';

    var roles = {};
    (d.roles || []).forEach(function (r) { roles[r.key] = r.label; });

    var ev = d.events.length
      ? '<table class="bx-d-t"><tbody>' + d.events.map(function (e) {
          return '<tr>'
            + '<td class="bx-d-when">' + esc(when(e.start_date)) + '</td>'
            + '<td><a href="/?event=' + esc(e.item_id) + '" target="_blank" '
            + 'rel="noopener">' + esc(e.title || 'An event') + '</a>'
            + (e.status && e.status !== 'Booked'
                ? ' <span class="bx-d-st">' + esc(e.status) + '</span>' : '')
            + '</td>'
            + '<td class="bx-d-role">' + esc(roles[e.role] || e.role) + '</td>'
            + '<td class="bx-d-p">+' + esc(e.points) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="bx-d-none">Not on any event yet.</p>';

    var led = d.ledger.length
      ? '<table class="bx-d-t"><tbody>' + d.ledger.map(function (m) {
          return '<tr>'
            + '<td class="bx-d-when">' + esc(when(m.at)) + '</td>'
            + '<td>' + esc(m.note || (m.kind === 'spend' ? 'Spent' : 'Correction'))
            + (m.by ? ' <span class="bx-d-st">' + esc(m.by) + '</span>' : '') + '</td>'
            + '<td class="bx-d-role">' + esc(m.kind === 'spend' ? 'Spent' : 'Correction')
            + '</td>'
            + '<td class="bx-d-p' + (m.points < 0 ? ' neg' : '') + '">'
            + (m.points > 0 ? '+' : '\u2212') + esc(Math.abs(m.points)) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '';

    var tally = (d.roles || []).map(function (r) {
      var b = d.byRole[r.key] || { events: 0, points: 0 };
      return '<span class="bx-d-k">' + esc(r.label) + ' <b>' + b.events + '</b>'
        + (b.points ? ' \u00b7 ' + b.points : '') + '</span>';
    }).join('');

    return '<div class="bx-d">'
      + '<div class="bx-d-tally">' + tally
      + '<span class="bx-d-k">Earned <b>' + d.earned + '</b></span>'
      + '<span class="bx-d-k">Spent <b>' + d.spent + '</b></span>'
      + '<span class="bx-d-k">Balance <b>' + d.balance + '</b></span></div>'
      + '<h4 class="bx-d-h">Where they turned up</h4>' + ev
      + (led ? '<h4 class="bx-d-h">What has moved the balance</h4>' + led : '')
      + '</div>';
  }

  function load(k) {
    if (detail[k]) { render(); return; }
    api('/api/boxy/person?key=' + encodeURIComponent(k))
      .then(function (r) { detail[k] = r; if (open === k) render(); })
      .catch(function (err) {
        detail[k] = { error: err.message || 'Could not load that person.' };
        if (open === k) render();
      });
    render();
  }

  function render() {
    var list = rows();
    var roles = D.roles || [];

    var head = '<tr><th></th><th>Person</th>'
      + roles.map(function (r) { return '<th>' + esc(r.label) + '</th>'; }).join('')
      + '<th>Events</th><th>Earned</th><th>Spent</th><th>Balance</th><th></th></tr>';

    // Rank is the standing on the whole board, not the position in a
    // filtered list -- "3rd" has to mean the same thing whatever is on
    // screen, or it means nothing.
    var rank = {};
    (D.board || []).forEach(function (r, i) { rank[r.k] = i + 1; });

    var body = list.length
      ? list.map(function (r) {
          return '<tr' + (rank[r.k] <= 3 && r.events ? ' class="top"' : '') + '>'
            + '<td class="bx-rank">' + (r.events ? rank[r.k] : '') + '</td>'
            + '<td><button class="bx-open" type="button" data-open="' + esc(r.k) + '"'
            + ' aria-expanded="' + (open === r.k) + '">'
            + '<span class="bx-name">' + esc(r.name) + '</span>'
            + '<span class="bx-who">' + esc(r.dept)
            + (r.loc ? ' · ' + esc(r.loc) : '') + '</span></button></td>'
            + roles.map(function (x) {
                var n = r.byRole[x.key] || 0;
                return '<td class="bx-n' + (n ? '' : ' bx-zero') + '">' + n + '</td>';
              }).join('')
            + '<td class="bx-n' + (r.events ? '' : ' bx-zero') + '">' + r.events + '</td>'
            + '<td class="bx-n' + (r.earned ? '' : ' bx-zero') + '">' + r.earned + '</td>'
            + '<td class="bx-n' + (r.spent ? '' : ' bx-zero') + '">' + r.spent + '</td>'
            + '<td class="bx-bal' + (r.balance ? '' : ' bx-zero') + '">' + r.balance + '</td>'
            + '<td><button class="bx-give" type="button" data-person="' + esc(r.k) + '"'
            + ' data-name="' + esc(r.name) + '">Spend</button></td></tr>'
            + (open === r.k
                ? '<tr class="bx-drow"><td colspan="' + (roles.length + 7) + '">'
                  + detailHtml(r.k) + '</td></tr>'
                : '');
        }).join('')
      : '<tr><td colspan="' + (roles.length + 7) + '" class="bx-none">'
        + (q ? 'Nobody matches that.' : 'Nobody has earned anything yet.') + '</td></tr>';

    $('#t').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    $('#wrap').hidden = false;
    chrome();
  }

  function chrome() {
    var s = D.standings || {};
    $('#strip').innerHTML = [
      ['On the board', s.onTheBoard + ' of ' + s.people],
      ['Earned', s.earned],
      ['Spent', s.spent],
      ['Outstanding', s.outstanding],
    ].map(function (p) {
      return '<div><div class="bx-k">' + esc(p[0]) + '</div>'
        + '<div class="bx-v">' + esc(p[1]) + '</div></div>';
    }).join('');
    $('#strip').hidden = false;

    var pts = D.points || {};
    $('#rc').textContent = 'Staff from the Employee Headcount view as of '
      + D.rosterAsOf + ' · ' + (D.roles || []).map(function (r) {
        return r.label + ' ' + (pts[r.key] == null ? r.points : pts[r.key]);
      }).join(' · ') + ' by default, overridable per event';
    $('#sub').textContent = s.onTheBoard + ' on the board · '
      + s.outstanding + ' outstanding';
  }

  // ── Spending ──────────────────────────────────────────────────────────

  function record(personKey, personName) {
    var what = window.prompt('What did ' + personName + ' take?\n\n'
      + 'A note is required — a balance nobody can explain in three months '
      + 'is worse than no balance.');
    if (what == null || !what.trim()) return;

    var n = window.prompt('How many Boxy Bucks?\n\n'
      + 'Enter it as a positive number; it is recorded as a debit.');
    if (n == null || !String(n).trim()) return;

    api('/api/boxy/ledger', {
      method: 'POST',
      body: JSON.stringify({ person: personKey, kind: 'spend',
                             points: n, note: what.trim() }),
    }).then(function (r) {
      D.board = r.board;
      D.standings = r.standings;
      $('#notice').innerHTML = '';
      render();
    }).catch(function (err) { say(err.message || 'That did not save.'); });
  }

  function bind() {
    $('#t').addEventListener('click', function (e) {
      var b = e.target.closest('.bx-give');
      if (b) { record(b.dataset.person, b.dataset.name); return; }
      var o = e.target.closest('.bx-open');
      if (!o) return;
      var k = o.dataset.open;
      // One at a time. Several open at once turns the leaderboard into a
      // list of detail panels, which is not what anybody came for.
      open = open === k ? '' : k;
      if (open) load(open); else render();
    });
    $('#spend').addEventListener('click', function () {
      var name = window.prompt('Whose balance?\n\nType part of their name.');
      if (!name || !name.trim()) return;
      var needle = name.trim().toLowerCase();
      var hits = (D.board || []).filter(function (r) {
        return r.name.toLowerCase().indexOf(needle) >= 0;
      });
      if (!hits.length) return say('Nobody on the staff list matches "' + name.trim() + '".');
      if (hits.length > 1) {
        return say('That matches ' + hits.length + ' people: '
          + hits.slice(0, 6).map(function (r) { return r.name; }).join(', ')
          + '. Be more specific, or use the Spend button on their row.');
      }
      record(hits[0].k, hits[0].name);
    });
    // Filtering or searching away the open person would leave their detail
    // attached to nothing.
    $('#filter').addEventListener('change', function (e) {
      show = e.target.value; open = ''; render();
    });
    $('#q').addEventListener('input', function (e) {
      q = e.target.value.trim(); open = ''; render();
    });
  }

  api('/api/boxy')
    .then(function (data) {
      D = data;
      $('#bar').hidden = false;
      bind();
      render();
    })
    .catch(function (err) {
      $('#sub').textContent = 'Not open to you';
      // A 404 is what somebody not on the list gets, on purpose.
      say(/Unknown endpoint|404/.test(err.message)
        ? 'Boxy Bucks is not open to this address. It is kept to whoever runs '
          + 'the rewards rather than to everyone who can edit the calendar.'
        : (err.message || 'The leaderboard did not load.'));
    });
}());
