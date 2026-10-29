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
  var sort = 'balance';
  var q = '';
  // Whose detail is open, and what we have already fetched. Cached so
  // opening and closing the same person does not go back to the server.
  var open = '';
  var detail = {};
  // Whose form is open, which of the two it is, and what has been typed
  // into it. Kept out here rather than read off the inputs, because every
  // render rebuilds the table and would otherwise throw away a half-filled
  // form. One at a time: a spend and an add on the same row would be two
  // ways to change the same balance, both half-written.
  var formFor = '';
  var formKind = 'spend';
  var form = {};

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
    // Sorting a copy, which filter() has already given us. The board
    // arrives ordered by what people earned, and that order is what the
    // rank column counts -- so this changes what is on screen and leaves
    // the standings alone.
    return want.sort(sort === 'name' ? byName : byBalance);
  }

  function byName(a, b) {
    var x = String(a.name || '').toLowerCase();
    var y = String(b.name || '').toLowerCase();
    return x < y ? -1 : (x > y ? 1 : 0);
  }

  // Most to least. Earned breaks a tie before the name does, so two people
  // level on balance sit in the order the board already had them.
  function byBalance(a, b) {
    return (b.balance - a.balance) || (b.earned - a.earned) || byName(a, b);
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
          // The day the samples were taken, when we have it. Rows written
          // before that was asked for fall back to the day they were typed.
          var on = m.on || when(m.at);
          var hands = m.checkedBy
            ? 'Checked out by ' + m.checkedBy
            : (m.note || (m.kind === 'spend' ? 'Spent' : 'Correction'));
          return '<tr>'
            + '<td class="bx-d-when">' + esc(on) + '</td>'
            + '<td>' + esc(hands)
            + (m.checkedBy && m.note
                ? ' <span class="bx-d-st">' + esc(m.note) + '</span>' : '')
            + (m.by ? ' <span class="bx-d-st">entered by ' + esc(m.by) + '</span>' : '')
            + '</td>'
            + '<td class="bx-d-role">'
            + esc(m.kind === 'spend'
                  ? Math.abs(m.points) + (Math.abs(m.points) === 1 ? ' sample' : ' samples')
                  : 'Correction')
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
      + '<span class="bx-d-k">Balance <b>' + d.balance + '</b>'
      + '<span class="bx-d-u">free samples</span></span></div>'
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

  // The spend form. One Boxy Buck is one free sample, so this asks the
  // three things a checkout actually has: how many went out, the day they
  // went, and who handed them over.
  function formHtml(k, name, span) {
    return formKind === 'add' ? addHtml(k, name, span) : spendHtml(k, name, span);
  }

  // Putting Boxy Bucks on somebody by hand -- an event the calendar never
  // saw, a prize, a correction upwards. The amount and the reason are both
  // required: money appearing on a balance with nothing said about it is
  // the thing nobody can explain three months later.
  //
  // Who entered it is not a field. It is whoever is signed in, which is
  // what gets stored, and a box to type a name in is a box to type the
  // wrong name in.
  function addHtml(k, name, span) {
    var f = form[k] || {};
    var bal = ((D.board || []).filter(function (r) { return r.k === k; })[0] || {}).balance;
    return '<tr class="bx-frow"><td colspan="' + span + '">'
      + '<form class="bx-f bx-f-add" data-for="' + esc(k) + '">'
      + '<span class="bx-f-who">' + esc(name)
      + '<span class="bx-f-bal">' + (bal == null ? '' : bal + ' now') + '</span></span>'
      + '<label class="bx-f-l">Boxy Bucks to add'
      + '<input class="bx-f-i bx-f-n" type="number" name="n" min="1" step="1" '
      + 'inputmode="numeric" value="' + esc(f.n == null ? '1' : f.n) + '"></label>'
      + '<label class="bx-f-l bx-f-grow">Reason'
      + '<input class="bx-f-i" type="text" name="note" maxlength="200" '
      + 'value="' + esc(f.note || '') + '" placeholder="What they are for"></label>'
      + '<span class="bx-f-l bx-f-by">Entered by'
      + '<span class="bx-f-i bx-f-fixed">' + esc(D.you || 'you') + '</span></span>'
      + '<span class="bx-f-go">'
      + '<button class="bx-f-save" type="submit">Add</button>'
      + '<button class="bx-f-x" type="button" data-cancel="1">Cancel</button></span>'
      + (f.error ? '<span class="bx-f-err">' + esc(f.error) + '</span>' : '')
      + '</form></td></tr>';
  }

  function spendHtml(k, name, span) {
    var f = form[k] || {};
    var people = D.checkout || [];
    var bal = ((D.board || []).filter(function (r) { return r.k === k; })[0] || {}).balance;
    var opts = ['<option value="">Checked out by\u2026</option>'].concat(
      people.map(function (p) {
        return '<option value="' + esc(p) + '"'
          + (f.by === p ? ' selected' : '') + '>' + esc(p) + '</option>';
      })).join('');

    return '<tr class="bx-frow"><td colspan="' + span + '">'
      + '<form class="bx-f" data-for="' + esc(k) + '">'
      + '<span class="bx-f-who">' + esc(name)
      + '<span class="bx-f-bal">' + (bal == null ? '' : bal + ' to spend') + '</span></span>'
      + '<label class="bx-f-l">Date'
      + '<input class="bx-f-i" type="date" name="on" value="'
      + esc(f.on == null ? (D.today || '') : f.on) + '"></label>'
      + '<label class="bx-f-l">Samples'
      + '<input class="bx-f-i bx-f-n" type="number" name="n" min="1" step="1" '
      + 'inputmode="numeric" value="' + esc(f.n == null ? '1' : f.n) + '"></label>'
      + '<label class="bx-f-l">Checked out by'
      + '<select class="bx-f-i" name="by"' + (people.length ? '' : ' disabled')
      + '>' + opts + '</select></label>'
      + '<label class="bx-f-l bx-f-grow">What they took <i>(optional)</i>'
      + '<input class="bx-f-i" type="text" name="note" maxlength="200" '
      + 'value="' + esc(f.note || '') + '" placeholder="Samples"></label>'
      + '<span class="bx-f-go">'
      + '<button class="bx-f-save" type="submit">Record</button>'
      + '<button class="bx-f-x" type="button" data-cancel="1">Cancel</button></span>'
      + (people.length ? ''
         : '<span class="bx-f-err">Nobody is set up to check samples out. '
           + 'Set BOXY_CHECKOUT.</span>')
      + (f.error ? '<span class="bx-f-err">' + esc(f.error) + '</span>' : '')
      + '</form></td></tr>';
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
            + '<td class="bx-acts">'
            + '<button class="bx-give" type="button" data-person="' + esc(r.k) + '"'
            + ' data-name="' + esc(r.name) + '">Spend</button>'
            + '<button class="bx-add" type="button" data-person="' + esc(r.k) + '"'
            + ' data-name="' + esc(r.name) + '">Add $$$</button></td></tr>'
            + (formFor === r.k
                ? formHtml(r.k, r.name, roles.length + 7) : '')
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
      }).join(' · ') + ' by default, overridable per event · '
      + '1 Boxy Buck = ' + (D.samplePerPoint || 1) + ' free sample';
    $('#sub').textContent = s.onTheBoard + ' on the board · '
      + s.outstanding + ' outstanding';
  }

  // ── Spending ──────────────────────────────────────────────────────────

  // Opening the form on somebody the current view is hiding would put it
  // nowhere, so the view gives way to the form rather than the other way round.
  function openForm(k, kind) {
    formFor = k;
    formKind = kind || 'spend';
    var visible = rows().some(function (r) { return r.k === k; });
    if (!visible) {
      show = 'all'; q = '';
      $('#filter').value = 'all';
      $('#q').value = '';
    }
    render();
    var el = document.querySelector('.bx-f [name="n"]');
    if (el) el.focus();
  }

  function record(personKey) {
    var f = form[personKey] || {};
    var body = formKind === 'add'
      ? { person: personKey, kind: 'adjust', points: f.n,
          note: (f.note || '').trim() }
      : { person: personKey, kind: 'spend', points: f.n,
          onDate: f.on == null ? (D.today || '') : f.on,
          checkedBy: f.by, note: (f.note || '').trim() };
    api('/api/boxy/ledger', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(function (r) {
      D.board = r.board;
      D.standings = r.standings;
      formFor = '';
      delete form[personKey];
      // A balance that just moved is worth re-reading, not re-showing stale.
      delete detail[personKey];
      if (open === personKey) load(personKey);
      $('#notice').innerHTML = '';
      render();
    }).catch(function (err) {
      form[personKey] = Object.assign({}, f,
        { error: err.message || 'That did not save.' });
      render();
    });
  }

  function bind() {
    $('#t').addEventListener('click', function (e) {
      var b = e.target.closest('.bx-give') || e.target.closest('.bx-add');
      if (b) {
        var pk = b.dataset.person;
        var kind = b.classList.contains('bx-add') ? 'add' : 'spend';
        // The same button again closes it; the other one swaps the form
        // over rather than leaving the first one open underneath.
        if (formFor === pk && formKind === kind) { formFor = ''; render(); return; }
        delete form[pk];
        openForm(pk, kind);
        return;
      }
      if (e.target.closest('[data-cancel]')) {
        formFor = ''; render(); return;
      }
      var o = e.target.closest('.bx-open');
      if (!o) return;
      var k = o.dataset.open;
      // One at a time. Several open at once turns the leaderboard into a
      // list of detail panels, which is not what anybody came for.
      open = open === k ? '' : k;
      if (open) load(open); else render();
    });
    // Typing into the form has to survive the next render, so each keystroke
    // is kept rather than read back off the inputs later.
    $('#t').addEventListener('input', function (e) {
      var f = e.target.closest('.bx-f');
      if (!f || !e.target.name) return;
      var k = f.dataset.for;
      form[k] = form[k] || {};
      form[k][e.target.name] = e.target.value;
    });
    $('#t').addEventListener('change', function (e) {
      var f = e.target.closest('.bx-f');
      if (!f || e.target.name !== 'by') return;
      form[f.dataset.for] = form[f.dataset.for] || {};
      form[f.dataset.for].by = e.target.value;
    });
    $('#t').addEventListener('submit', function (e) {
      var f = e.target.closest('.bx-f');
      if (!f) return;
      e.preventDefault();
      record(f.dataset.for);
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
      openForm(hits[0].k);
    });
    // Filtering or searching away the open person would leave their detail
    // attached to nothing.
    $('#filter').addEventListener('change', function (e) {
      show = e.target.value; open = ''; formFor = ''; render();
    });
    $('#sort').addEventListener('change', function (e) {
      sort = e.target.value; open = ''; formFor = ''; render();
    });
    $('#q').addEventListener('input', function (e) {
      q = e.target.value.trim(); open = ''; formFor = ''; render();
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
