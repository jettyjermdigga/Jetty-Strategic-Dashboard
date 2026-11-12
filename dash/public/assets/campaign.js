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
  var f = { view: 'people', div: '', q: '' };

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
      return res.json().then(function (body) {
        if (!res.ok && !body) throw new Error('Request failed (' + res.status + ')');
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

  // ── by person ───────────────────────────────────────────────────────────
  function drawPeople(tasks) {
    var box = $('#people');
    box.hidden = f.view !== 'people';
    if (box.hidden) { box.innerHTML = ''; return; }

    // Regrouped here rather than reusing D.people, because the filters cut
    // the task list and a person's count has to follow what is on screen.
    var by = {};
    var order = [];
    var put = function (key, name, t) {
      if (!by[key]) { by[key] = { name: name, tasks: [], late: 0, due: 0 }; order.push(key); }
      by[key].tasks.push(t);
      var st = state(t.deadline);
      if (st === 'overdue') by[key].late += 1;
      else if (st === 'today' || st === 'week') by[key].due += 1;
    };
    tasks.forEach(function (t) {
      if (!t.assignees.length) { put('(unassigned)', 'Nobody assigned', t); return; }
      t.assignees.forEach(function (p) { put(p.email || p.name, p.name, t); });
    });

    var rows = order.map(function (k) { return by[k]; }).sort(function (a, b) {
      return b.late - a.late || b.due - a.due || b.tasks.length - a.tasks.length
        || String(a.name).localeCompare(String(b.name));
    });

    if (!rows.length) {
      box.innerHTML = '<p class="cp-empty">' + (filtered()
        ? 'Nothing matches that.' : 'Nothing is open.') + '</p>';
      return;
    }

    box.innerHTML = '<div class="cp-people">' + rows.map(function (r) {
      var tasks = r.tasks.slice().sort(function (a, b) {
        return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
      });
      return '<section class="cp-person">'
        + '<div class="cp-phead">'
        + '<span class="cp-pname">' + esc(r.name) + '</span>'
        + '<span class="cp-pcount">' + r.tasks.length
        + (r.tasks.length === 1 ? ' task' : ' tasks') + '</span>'
        + (r.late ? '<span class="cp-pflag late">' + r.late + ' late</span>' : '')
        + (r.due ? '<span class="cp-pflag due">' + r.due + ' this week</span>' : '')
        + '</div>'
        + tasks.map(function (t) {
          var c = cls(state(t.deadline));
          return '<div class="cp-task">'
            + '<span class="cp-when ' + c + '">' + esc(whenWords(t.deadline)) + '</span>'
            + '<span class="cp-what">' + esc(t.name) + '</span>'
            + (t.campaign ? '<span class="cp-camp">' + esc(t.campaign) + '</span>' : '')
            + (t.review ? '<span class="cp-rev">Out for review</span>' : '')
            + '</div>';
        }).join('')
        + '</section>';
    }).join('') + '</div>';
  }

  // ── timeline ────────────────────────────────────────────────────────────
  function drawTimeline(tasks) {
    var box = $('#timeline');
    box.hidden = f.view !== 'timeline';
    if (box.hidden) { box.innerHTML = ''; return; }

    var by = {};
    var order = [];
    tasks.forEach(function (t) {
      var key = t.campaign || '(no campaign)';
      if (!by[key]) { by[key] = { name: key, from: t.deadline, to: t.deadline, n: 0, late: 0 }; order.push(key); }
      var r = by[key];
      if (t.deadline < r.from) r.from = t.deadline;
      if (t.deadline > r.to) r.to = t.deadline;
      r.n += 1;
      if (state(t.deadline) === 'overdue') r.late += 1;
    });
    var rows = order.map(function (k) { return by[k]; }).sort(function (a, b) {
      return a.from < b.from ? -1 : a.from > b.from ? 1
        : String(a.name).localeCompare(String(b.name));
    });

    if (!rows.length) {
      box.innerHTML = '<p class="cp-empty">' + (filtered()
        ? 'Nothing matches that.' : 'Nothing is open.') + '</p>';
      return;
    }

    // The window has to cover today as well as the work, or the today line
    // sits off the end and the reader cannot place anything against it.
    var lo = D.asOf;
    var hi = D.asOf;
    rows.forEach(function (r) {
      if (r.from < lo) lo = r.from;
      if (r.to > hi) hi = r.to;
    });
    var total = Math.max(1, days(lo, hi));
    var pct = function (d) { return (days(lo, d) / total) * 100; };

    // Month ticks across the window, so a bar can be placed without a
    // tooltip.
    var ticks = [];
    var cur = new Date(lo + 'T00:00:00Z');
    cur.setUTCDate(1);
    for (var i = 0; i < 36; i++) {
      var ds = cur.toISOString().slice(0, 10);
      if (ds > hi) break;
      // Apostrophe-year, so "Nov '26" cannot be read as the 26th of
      // November on a page that is entirely about dates.
      if (ds >= lo) {
        ticks.push({ at: pct(ds), label: MONTH[cur.getUTCMonth()]
          + ' \u2019' + String(cur.getUTCFullYear()).slice(2) });
      }
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }

    var todayAt = pct(D.asOf);
    box.innerHTML = '<div class="cp-tl">'
      + '<div class="cp-tl-axis"><span class="cp-tl-name"></span>'
      + '<span class="cp-tl-scale">' + ticks.map(function (t) {
        return '<span class="cp-tl-tick" style="left:' + t.at.toFixed(2) + '%">'
          + esc(t.label) + '</span>';
      }).join('') + '</span><span class="cp-tl-n"></span></div>'
      + rows.map(function (r) {
        var a = pct(r.from);
        var b = pct(r.to);
        var w = Math.max(0, b - a);
        var point = r.from === r.to;
        var c = r.late ? 'late' : (state(r.from) === 'today' || state(r.from) === 'week' ? 'due' : '');
        return '<div class="cp-tl-row">'
          + '<span class="cp-tl-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>'
          + '<span class="cp-tl-track">'
          + '<span class="cp-today" style="left:' + todayAt.toFixed(2) + '%"></span>'
          + '<span class="cp-tl-bar ' + c + (point ? ' point' : '') + '" style="left:'
          + a.toFixed(2) + '%;' + (point ? '' : 'width:' + w.toFixed(2) + '%')
          + '" title="' + esc(r.name + ' · ' + r.from + ' to ' + r.to) + '"></span>'
          + '</span>'
          + '<span class="cp-tl-n">' + r.n + (r.late ? ' · ' + r.late + ' late' : '') + '</span>'
          + '</div>';
      }).join('')
      + '</div>';
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
    drawPeople(tasks);
    drawTimeline(tasks);

    [].forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.view === f.view ? 'true' : 'false');
    });
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
      $('#sub').textContent = 'Could not load';
      say(err.message || 'The board did not load.');
    });
  }

  $('#bar').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-view]') : null;
    if (b) {
      f.view = b.dataset.view;
      try { localStorage.setItem('jetty-campaign-view', f.view); } catch (err) { /* private */ }
      return render();
    }
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

  try {
    var v = localStorage.getItem('jetty-campaign-view');
    if (v === 'people' || v === 'timeline') f.view = v;
  } catch (err) { /* private mode */ }

  load(false);
}());
