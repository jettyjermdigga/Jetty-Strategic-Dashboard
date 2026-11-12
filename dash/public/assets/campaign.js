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
  // One pick at a time: 'overview', 'late', or a person's key.
  var f = { pick: 'overview', q: '' };
  var NOBODY = '(unassigned)';

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

  // ── filtering ──────────────────────────────────────────────────────
  //
  // The search narrows whatever view is picked; the chips pick the view.
  // They are separate questions and they compose: search "lookbook" while
  // standing on Past deadline and you get the late lookbook work.
  function hit(t) {
    var q = (f.q || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [t.name, t.campaign, t.division,
               (t.assignees || []).map(function (p) { return p.name; }).join(' ')]
      .join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  // Same key the Worker groups people by, so a chip and the Worker's own
  // per-person counts can never disagree about who two rows are.
  function keyOf(p) { return p.email || p.name; }

  function tagged(t, key) {
    if (key === NOBODY) return !(t.assignees || []).length;
    return (t.assignees || []).some(function (p) { return keyOf(p) === key; });
  }

  function overdue(t) { return state(t.deadline) === 'overdue'; }

  // Which tasks the picked chip is asking for.
  function picked(tasks) {
    if (f.pick === 'overview') return tasks;
    if (f.pick === 'late') return tasks.filter(overdue);
    return tasks.filter(function (t) { return tagged(t, f.pick); });
  }

  // ── who is on the board ─────────────────────────────────────────
  //
  // Built from the WHOLE task list, never the searched one -- a chip row
  // that reshuffles itself under your finger as you type is unusable, and
  // a person whose last task the search just hid would take their own chip
  // away with them. Counts come from the search; the row does not.
  //
  // Left to right by soonest deadline, so whoever is up next is nearest the
  // left edge. Ties go alphabetical so the row is the same every load.
  function peopleRows(all) {
    var by = {};
    var add = function (key, label, t) {
      if (!by[key]) by[key] = { key: key, name: label, next: t.deadline };
      else if (t.deadline < by[key].next) by[key].next = t.deadline;
    };
    all.forEach(function (t) {
      if (!(t.assignees || []).length) { add(NOBODY, 'Nobody assigned', t); return; }
      t.assignees.forEach(function (p) { add(keyOf(p), p.name, t); });
    });
    return Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) {
        // Nobody assigned sits at the end whatever its dates say: it is a
        // gap to fill, not a person to go and ask.
        if ((a.key === NOBODY) !== (b.key === NOBODY)) return a.key === NOBODY ? 1 : -1;
        return a.next < b.next ? -1 : a.next > b.next ? 1
          : String(a.name).localeCompare(String(b.name));
      });
  }

  function chip(key, label, n, extra) {
    return '<button type="button" class="fchip' + (f.pick === key ? ' on' : '')
      + (n ? '' : ' empty') + (extra ? ' ' + extra : '')
      + '" data-pick="' + esc(key) + '" aria-pressed="' + (f.pick === key) + '">'
      + esc(label) + '<span class="fn">' + n + '</span></button>';
  }

  function drawChips(all, hits) {
    // Nothing to filter, nothing to show. An empty chip bar over an error
    // notice is just furniture, and on the no-key page it was the only thing
    // with any ink in it.
    if (!all.length) { $('#filters').hidden = true; return; }
    $('#fView').innerHTML =
      chip('overview', 'Overview', hits.length)
      + chip('late', 'Past deadline', hits.filter(overdue).length, 'late');

    $('#fWho').innerHTML = peopleRows(all).map(function (r) {
      var n = hits.filter(function (t) { return tagged(t, r.key); }).length;
      return chip(r.key, r.name, n);
    }).join('');
    $('#filters').hidden = false;
  }

  function filtered() { return Boolean(f.pick !== 'overview' || (f.q || '').trim()); }

  // ── deadlines by campaign ───────────────────────────────────────────────
  //
  // One card per campaign, its open work underneath in date order, soonest
  // campaign first. The assignees sit on the row rather than in a view of
  // their own: who owes a thing is a property of the thing, and splitting
  // them apart meant reading two pages to answer one question.
  // `mine` is the person whose list this is, if any. Their own name comes off
  // every row: it is already the heading, and repeated down the right-hand
  // side it crowds out the one thing that column is worth reading for --
  // who ELSE is on the task with them.
  function taskRow(t, showCamp, mine) {
    var c = cls(state(t.deadline));
    var all = t.assignees || [];
    var show = mine ? all.filter(function (p) { return keyOf(p) !== mine; }) : all;
    var who = show.map(function (p) { return p.name; }).join(', ');
    if (mine && !who) who = all.length ? '' : 'Nobody assigned';
    return '<div class="cp-task">'
      + '<span class="cp-when ' + c + '">' + esc(whenWords(t.deadline)) + '</span>'
      + '<span class="cp-what">' + esc(t.name) + '</span>'
      + (showCamp ? '<span class="cp-camp">' + esc(t.campaign || '') + '</span>' : '')
      + '<span class="cp-who' + (who && who !== 'Nobody assigned' ? '' : ' none') + '">'
      + esc(mine ? who : (who || 'Nobody assigned')) + '</span>'
      + (t.review ? '<span class="cp-rev">Out for review</span>' : '')
      + '</div>';
  }

  // One flat list in date order, for a person or for what is already late.
  // No campaign grouping here on purpose: the question a person chip asks
  // is "what do I do next", and that is one sequence, not a set of piles.
  // The campaign moves onto the row instead, so nothing is lost by it.
  function drawFlat(tasks, head, mine) {
    var rows = tasks.slice().sort(function (a, b) {
      return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
    });
    if (!rows.length) {
      $('#board').innerHTML = '<p class="cp-empty">' + esc(head)
        + ' has nothing open' + ((f.q || '').trim() ? ' matching that.' : '.') + '</p>';
      return;
    }
    var late = rows.filter(overdue).length;
    $('#board').innerHTML = '<div class="cp-people"><section class="cp-person">'
      + '<div class="cp-phead">'
      + '<span class="cp-pname">' + esc(head) + '</span>'
      + '<span class="cp-pcount">' + rows.length
      + (rows.length === 1 ? ' task' : ' tasks') + '</span>'
      // "2 tasks \u00b7 2 late" says it twice. The flag is only worth ink when
      // it picks some of the list out from the rest, which on the Past
      // deadline view it never does.
      + (late && late < rows.length
          ? '<span class="cp-pflag late">' + late + ' late</span>' : '')
      + '</div>'
      + rows.map(function (t) { return taskRow(t, true, mine); }).join('')
      + '</section></div>';
  }

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
        + r.tasks.map(function (t) { return taskRow(t, false); }).join('')
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

  // What the picked chip is called, for the heading over a flat list.
  function pickName() {
    if (f.pick === 'late') return 'Past deadline';
    var rows = peopleRows(D.tasks || []);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === f.pick) return rows[i].name;
    }
    return 'Nobody';
  }

  // A chip can go away under you: finish your last task, reload, and the
  // person you were standing on is no longer on the board. Without this the
  // page sits on a key nothing matches and shows an empty list with no lit
  // chip to explain it.
  function settle() {
    if (f.pick === 'overview' || f.pick === 'late') return;
    var rows = peopleRows(D.tasks || []);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === f.pick) return;
    }
    f.pick = 'overview';
  }

  function render() {
    settle();
    var all = D.tasks || [];
    var hits = all.filter(hit);
    drawChips(all, hits);

    var show = picked(hits);
    // The strip counts everything the search left, not the picked slice --
    // it is the headline for the board, and a headline that changes every
    // time you click a name is not one.
    drawStrip(hits);

    if (f.pick === 'overview') drawBoard(show);
    else drawFlat(show, pickName(), f.pick === 'late' ? '' : f.pick);

    $('#clr').hidden = !filtered();
    $('#sub').textContent = show.length
      + (show.length === 1 ? ' open task' : ' open tasks')
      + (filtered() ? ' shown' : '');
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
      render();
    }).catch(function (err) {
      var msg = err.message || '';
      // The Worker answers an address that is not on the list with a flat
      // 404, which is right for an outsider and useless to the person
      // reading it. Say what it means for them.
      if (/Unknown endpoint|No such endpoint|404/.test(msg)) {
        $('#sub').textContent = 'Not open to you';
        $('#strip').hidden = true;
        $('#filters').hidden = true;
        say('The Campaign Board is not open to this address. It shows every '
          + 'person\u2019s deadlines, including who is behind, so it sits behind '
          + 'a list of its own. Ask Jeremy to add you to CAMPAIGN_USERS.');
        return;
      }
      $('#sub').textContent = 'Could not load';
      $('#strip').hidden = true;
      $('#filters').hidden = true;
      say(msg || 'The board did not load.');
    });
  }

  $('#bar').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#refresh')) {
      $('#stamp').textContent = 'reading\u2026';
      return load(true);
    }
    if (e.target.closest && e.target.closest('#clr')) {
      f.pick = 'overview';
      f.q = '';
      $('#q').value = '';
      return render();
    }
  });

  // One handler on the bar rather than one per chip: the chips are redrawn
  // on every render, and listeners bound to them would be thrown away with
  // them each time.
  $('#filters').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.fchip');
    if (!b) return;
    f.pick = b.getAttribute('data-pick');
    render();
  });

  $('#q').addEventListener('input', function (e) { f.q = e.target.value; render(); });

  load(false);
}());
