// The campaign board.
//
// Everything it draws is worked out by the Worker (worker/campaign.js) and
// handed over shaped: the task list, the per-person grouping, the campaign
// spans and the counts. This file filters and draws. Two places deciding
// what "overdue" means is two places to get it wrong, and only one of them
// is the one the counts come from.
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var SIGNED_OUT = 'Your sign-in expired. Reload the page.';

  var D = null;
  var f = { div: '', q: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path) {
    return fetch(path, { headers: { 'content-type': 'application/json' },
                         redirect: 'manual' }).then(function (res) {
      if (res.type === 'opaqueredirect' || res.redirected || res.status === 0) {
        throw new Error(SIGNED_OUT);
      }
      return res.json().catch(function () { return null; }).then(function (body) {
        // A refusal has to be thrown, not returned. Returned, it arrives as
        // a board with no tasks on it -- and "you cannot see this" and
        // "there is nothing to see" look identical, which is the worse of
        // the two to get wrong.
        if (!res.ok) {
          throw new Error((body && (body.why || body.error))
            || ('Request failed (' + res.status + ')'));
        }
        return body;
      });
    });
  }

  function say(msg, cls) {
    $('#notice').innerHTML = msg
      ? '<div class="' + (cls || 'cp-why') + '">' + esc(msg) + '</div>' : '';
  }

  // ── reading a date ──────────────────────────────────────────────────────
  //
  // Mirrors dueState() in worker/campaign.js, and the tests check the two
  // agree. It is here as well because the page re-reads it per row as it
  // draws, and a round trip per row is not a thing.
  function days(from, to) {
    var a = Date.parse(from + 'T00:00:00Z');
    var b = Date.parse(to + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  function state(deadline) {
    var n = days(D.asOf, deadline);
    if (n == null) return 'none';
    if (n < 0) return 'overdue';
    if (n === 0) return 'today';
    if (n <= 7) return 'week';
    return 'later';
  }

  var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pretty(ymd) {
    var p = String(ymd || '').split('-');
    if (p.length !== 3) return String(ymd || '');
    return Number(p[2]) + ' ' + MONTH[Number(p[1]) - 1];
  }

  // How late, in words. "11 days late" is the thing somebody acts on; the
  // date alone makes them do the subtraction.
  function whenWords(deadline) {
    var n = days(D.asOf, deadline);
    if (n == null) return pretty(deadline);
    if (n < 0) return pretty(deadline) + ' · ' + (-n) + 'd late';
    if (n === 0) return pretty(deadline) + ' · today';
    if (n <= 7) return pretty(deadline) + ' · ' + n + 'd';
    return pretty(deadline);
  }

  function cls(st) {
    if (st === 'overdue') return 'late';
    if (st === 'today' || st === 'week') return 'due';
    return '';
  }

  // ── filtering ───────────────────────────────────────────────────────────
  function keep(t) {
    if (f.div && t.division !== f.div) return false;
    var q = (f.q || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [t.name, t.campaign, t.division,
               (t.assignees || []).map(function (p) { return p.name; }).join(' ')]
      .join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function filtered() { return Boolean(f.div || (f.q || '').trim()); }

  // ── deadlines by campaign ───────────────────────────────────────────────
  //
  // One card per campaign, its open work underneath in date order, soonest
  // campaign first. The assignees sit on the row rather than in a view of
  // their own: who owes a thing is a property of the thing, and splitting
  // them apart meant reading two pages to answer one question.
  function drawBoard(tasks) {
    var box = $('#board');

    var by = {};
    var order = [];
    tasks.forEach(function (t) {
      var key = t.campaign || 'No campaign';
      if (!by[key]) {
        by[key] = { name: key, division: t.division || '', tasks: [], late: 0, due: 0 };
        order.push(key);
      }
      var r = by[key];
      if (!r.division && t.division) r.division = t.division;
      r.tasks.push(t);
      var st = state(t.deadline);
      if (st === 'overdue') r.late += 1;
      else if (st === 'today' || st === 'week') r.due += 1;
    });

    var rows = order.map(function (k) {
      var r = by[k];
      r.tasks.sort(function (a, b) {
        return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
      });
      r.next = r.tasks[0].deadline;
      return r;
    }).sort(function (a, b) {
      // Soonest next deadline first. This is a deadline board: what is
      // closest to being due is what belongs at the top, and sorting by
      // how late a campaign already is buries the thing due on Friday
      // under something that slipped in March.
      return a.next < b.next ? -1 : a.next > b.next ? 1
        : String(a.name).localeCompare(String(b.name));
    });

    if (!rows.length) {
      box.innerHTML = '<p class="cp-empty">' + (filtered()
        ? 'Nothing matches that.' : 'Nothing is open.') + '</p>';
      return;
    }

    box.innerHTML = '<div class="cp-people">' + rows.map(function (r) {
      return '<section class="cp-person">'
        + '<div class="cp-phead">'
        + '<span class="cp-pname">' + esc(r.name) + '</span>'
        + (r.division ? '<span class="cp-div">' + esc(r.division) + '</span>' : '')
        + '<span class="cp-pcount">' + r.tasks.length
        + (r.tasks.length === 1 ? ' task' : ' tasks') + '</span>'
        + (r.late ? '<span class="cp-pflag late">' + r.late + ' late</span>' : '')
        + (r.due ? '<span class="cp-pflag due">' + r.due + ' this week</span>' : '')
        + '</div>'
        + r.tasks.map(function (t) {
          var c = cls(state(t.deadline));
          var who = (t.assignees || []).map(function (p) { return p.name; }).join(', ');
          return '<div class="cp-task">'
            + '<span class="cp-when ' + c + '">' + esc(whenWords(t.deadline)) + '</span>'
            + '<span class="cp-what">' + esc(t.name) + '</span>'
            + '<span class="cp-who' + (who ? '' : ' none') + '">'
            + esc(who || 'Nobody assigned') + '</span>'
            + (t.review ? '<span class="cp-rev">Out for review</span>' : '')
            + '</div>';
        }).join('')
        + '</section>';
    }).join('') + '</div>';
  }

  function drawStrip(tasks) {
    var late = 0;
    var due = 0;
    var un = 0;
    var camps = {};
    tasks.forEach(function (t) {
      var st = state(t.deadline);
      if (st === 'overdue') late += 1;
      else if (st === 'today' || st === 'week') due += 1;
      if (!t.assignees.length) un += 1;
      if (t.campaign) camps[t.campaign] = true;
    });
    var cell = function (k, v, c) {
      return '<div><div class="cp-k">' + esc(k) + '</div>'
        + '<div class="cp-v ' + (c || '') + '">' + esc(String(v)) + '</div></div>';
    };
    $('#strip').innerHTML = cell('Open', tasks.length)
      + cell('Overdue', late, late ? 'late' : '')
      + cell('Due this week', due, due ? 'due' : '')
      + cell('Nobody assigned', un, un ? 'due' : '')
      + cell('Campaigns', Object.keys(camps).length);
    $('#strip').hidden = false;
  }

  function render() {
    var tasks = (D.tasks || []).filter(keep);
    drawStrip(tasks);
    drawBoard(tasks);
    $('#clr').hidden = !filtered();
    $('#sub').textContent = tasks.length + (tasks.length === 1 ? ' open task' : ' open tasks')
      + (filtered() ? ' shown' : '');
  }

  function fillDivisions() {
    var seen = {};
    (D.tasks || []).forEach(function (t) { if (t.division) seen[t.division] = true; });
    var opts = Object.keys(seen).sort();
    $('#fDiv').innerHTML = '<option value="">Every division</option>'
      + opts.map(function (d) {
        return '<option value="' + esc(d) + '"' + (d === f.div ? ' selected' : '')
          + '>' + esc(d) + '</option>';
      }).join('');
  }

  function stamp(d) {
    if (!d.cached) return 'live';
    var at = d.cachedAt ? new Date(d.cachedAt) : null;
    if (!at || isNaN(at.getTime())) return 'cached';
    var mins = Math.round((Date.now() - at.getTime()) / 60000);
    return mins <= 0 ? 'just now' : mins + 'm ago';
  }

  function load(fresh) {
    return api('/api/campaign' + (fresh ? '?fresh=1' : '')).then(function (d) {
      D = d || {};
      D.tasks = D.tasks || [];
      D.asOf = D.asOf || new Date().toISOString().slice(0, 10);
      $('#bar').hidden = false;
      $('#stamp').textContent = stamp(D);
      // A board that cannot be read says why, and says it where somebody is
      // looking rather than in a log.
      say(D.ok === false || D.why ? D.why : '');
      fillDivisions();
      render();
    }).catch(function (err) {
      var msg = err.message || '';
      // The Worker answers an address that is not on the list with a flat
      // 404, which is right for an outsider and useless to the person
      // reading it. Say what it means for them.
      if (/Unknown endpoint|No such endpoint|404/.test(msg)) {
        $('#sub').textContent = 'Not open to you';
        $('#strip').hidden = true;
        say('The Campaign Board is not open to this address. It shows every '
          + 'person\u2019s deadlines, including who is behind, so it sits behind '
          + 'a list of its own. Ask Jeremy to add you to CAMPAIGN_USERS.');
        return;
      }
      $('#sub').textContent = 'Could not load';
      $('#strip').hidden = true;
      say(msg || 'The board did not load.');
    });
  }

  $('#bar').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#refresh')) {
      $('#stamp').textContent = 'reading…';
      return load(true);
    }
    if (e.target.closest && e.target.closest('#clr')) {
      f.div = '';
      f.q = '';
      $('#q').value = '';
      $('#fDiv').value = '';
      return render();
    }
  });
  $('#fDiv').addEventListener('change', function (e) { f.div = e.target.value; render(); });
  $('#q').addEventListener('input', function (e) { f.q = e.target.value; render(); });

  load(false);
}());
