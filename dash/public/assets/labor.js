(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    var v = Math.round(Number(n) || 0);
    return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString();
  }
  var comma = function (n) { return Math.round(Number(n) || 0).toLocaleString(); };

  var D = null;
  var show = 'all';
  var shut = {};          // departments folded away
  var saving = 0;
  var timers = {};

  // Mirrors labor.js. The sheet has to redraw the instant a figure is typed,
  // which it cannot do by asking the server -- so the rule lives in both
  // places, and the tests check the two agree.
  function asks(pay) {
    var t = (D.payTypes || []).filter(function (p) { return p.key === pay; })[0];
    return t ? t.asks : null;
  }
  // Payroll is the one bucket that splits again: salary and hourly land in
  // direct labor or in G&A depending on what was decided about that person,
  // and until it is decided, in neither. Mirrors rollOf in labor.js.
  function roll(p) {
    var t = (D.payTypes || []).filter(function (x) { return x.key === p.pay; })[0];
    if (!t) return 'other';
    if (t.roll !== 'payroll') return t.roll;
    var c = (D.classes || []).filter(function (x) { return x.key === p.cls; })[0];
    return c ? c.roll : 'unclassified';
  }
  var splits = function (p) {
    var t = (D.payTypes || []).filter(function (x) { return x.key === p.pay; })[0];
    return Boolean(t && t.roll === 'payroll');
  };
  function cost(p) {
    var a = asks(p.pay);
    if (!a || a === 'none') return null;
    if (a === 'rate') {
      return p.rate == null || p.hours == null ? null : p.rate * p.hours;
    }
    return p.salary == null ? null : p.salary;
  }

  // ── Which people are on screen ────────────────────────────────────────

  function keep(p) {
    if (show === 'todo') return cost(p) == null;
    if (show === 'tbh') return p.tbh;
    if (show === 'payroll') return splits(p);
    if (show === 'unsplit') return splits(p) && !p.cls;
    return true;
  }

  function depts() {
    var out = [];
    var at = {};
    D.people.filter(keep).forEach(function (p) {
      if (!(p.d in at)) { at[p.d] = out.length; out.push({ dept: p.d, people: [] }); }
      out[at[p.d]].people.push(p);
    });
    out.sort(function (a, b) {
      var au = a.dept.toLowerCase() === 'unassigned';
      var bu = b.dept.toLowerCase() === 'unassigned';
      if (au !== bu) return au ? 1 : -1;
      return a.dept.toLowerCase() < b.dept.toLowerCase() ? -1 : 1;
    });
    out.forEach(function (g) {
      g.people.sort(function (a, b) {
        if (a.added !== b.added) return a.added ? 1 : -1;
        return a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1;
      });
      g.total = g.people.reduce(function (a, p) { return a + (cost(p) || 0); }, 0);
    });
    return out;
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  var COLS = 9;

  function head() {
    return '<tr><th>Person</th><th>Paid</th><th>Direct or G&amp;A</th><th>Rate ($/hr)</th>'
      + '<th>Salary <span>annual</span></th><th>Hours <span>annual, est.</span></th>'
      + '<th>' + D.year + ' projection</th><th>Note</th><th></th></tr>';
  }

  function chips(p) {
    var out = '';
    if (p.tbh) out += '<span class="lb-chip tbh">' + (p.added ? 'NEW' : 'TBH') + '</span>';
    if (p.v) out += '<span class="lb-chip">' + esc(p.v) + '</span>';
    if (p.ft === 'Part-time') out += '<span class="lb-chip">PT</span>';
    return out;
  }

  // A cell for a figure this way of being paid does not ask for. Drawn as a
  // dash rather than left blank, so an empty column reads as "not asked"
  // instead of "not filled in".
  function cell(p, field, cls, ph) {
    var a = asks(p.pay);
    var wanted = !a ? false
      : a === 'none' ? false
      : a === 'rate' ? (field === 'rate' || field === 'hours')
      : field === 'salary';
    if (!wanted) return '<td><span class="lb-na">—</span></td>';
    var v = p[field];
    return '<td><input class="bd-in lb-in ' + cls + (v != null ? ' set' : '')
      + '" data-f="' + field + '" inputmode="numeric"'
      + ' aria-label="' + esc(p.n) + ' ' + field + '"'
      + ' value="' + (v == null ? '' : comma(v)) + '"'
      + ' placeholder="' + ph + '"></td>';
  }

  // Only payroll splits. A commission rep or a partner has a budget line of
  // its own, so offering the choice would invite an answer that goes
  // nowhere -- the dash reads as "not asked", the same as the figures a pay
  // type does not want.
  function clsCell(p) {
    if (!splits(p)) return '<span class="lb-na">—</span>';
    return '<select class="lb-sel lb-cls' + (p.cls ? ' set' : '') + '" data-f="cls"'
      + ' aria-label="Is ' + esc(p.n) + ' direct labor or G&amp;A?">'
      + '<option value="">—</option>'
      + D.classes.map(function (c) {
        return '<option value="' + c.key + '"' + (c.key === p.cls ? ' selected' : '')
          + '>' + esc(c.label) + '</option>';
      }).join('') + '</select>';
  }

  function row(p) {
    var c = cost(p);
    var nameCell = p.added
      ? '<input class="bd-note" data-f="name" value="' + esc(p.n) + '" '
        + 'aria-label="Name of this post" placeholder="what the post is called">'
      : '<span>' + esc(p.n) + '</span>';
    var titleCell = p.added
      ? '<input class="bd-note" data-f="title" value="' + esc(p.t) + '" '
        + 'aria-label="Job title" placeholder="job title">'
      : '<span class="lb-title">' + esc(p.t || '—') + '</span>';

    return '<tr data-k="' + esc(p.k) + '"' + (p.added ? ' class="lb-new"' : '') + '>'
      + '<td><span class="lb-who"><span class="lb-name">' + chips(p) + nameCell + '</span>'
        + titleCell + '</span></td>'
      + '<td><select class="lb-sel' + (p.pay ? ' set' : '') + '" data-f="pay"'
        + ' aria-label="How ' + esc(p.n) + ' is paid">'
        + '<option value="">—</option>'
        + D.payTypes.map(function (t) {
          return '<option value="' + t.key + '"' + (t.key === p.pay ? ' selected' : '')
            + '>' + esc(t.label) + '</option>';
        }).join('') + '</select></td>'
      + '<td>' + clsCell(p) + '</td>'
      + cell(p, 'rate', '', '')
      + cell(p, 'salary', '', '')
      + cell(p, 'hours', 'hrs', comma(D.fullTimeHours))
      + '<td class="bd-n' + (c == null ? ' bd-base' : '') + '">'
        + (c == null ? '—' : money(c)) + '</td>'
      + '<td><input class="bd-note" data-f="note" value="' + esc(p.note) + '"'
        + ' aria-label="Note about ' + esc(p.n) + '" placeholder="why / when"></td>'
      + '<td><button class="lb-x" type="button" title="Take off the plan"'
        + ' aria-label="Take ' + esc(p.n) + ' off the plan">×</button></td>'
      + '</tr>';
  }

  // Ninety-six dropdowns is not a decision anybody makes carefully by the
  // fortieth one, and department is how this judgement is actually made.
  // Shown only where there is payroll in the department to split.
  function deptSetter(g) {
    var mine = g.people.filter(splits);
    if (!mine.length) return '';
    var left = mine.filter(function (p) { return !p.cls; }).length;
    return '<select class="lb-dsel" data-dept="' + esc(g.dept) + '"'
      + ' aria-label="Set direct or G&amp;A for everybody in ' + esc(g.dept) + '">'
      + '<option value="">' + (left ? left + ' to split…' : 'all split') + '</option>'
      + D.classes.map(function (c) {
        return '<option value="' + c.key + '">All ' + esc(c.label.toLowerCase()) + '</option>';
      }).join('')
      + '<option value="clear">Clear all</option></select>';
  }

  function render() {
    var gs = depts();
    var out = [];
    gs.forEach(function (g) {
      var folded = shut[g.dept];
      out.push('<tr class="lb-dept" data-d="' + esc(g.dept) + '">'
        + '<td colspan="5"><span class="lb-head">'
        + '<button class="lb-caret" type="button" aria-expanded="' + (!folded)
        + '" aria-label="' + (folded ? 'Show' : 'Hide') + ' ' + esc(g.dept) + '">'
        + (folded ? '▸' : '▾') + '</button>'
        + esc(g.dept) + '<span class="lb-n">' + g.people.length + '</span>'
        + deptSetter(g) + '</span></td>'
        + '<td class="lb-sum">' + (g.total ? money(g.total) : '') + '</td>'
        + '<td></td><td></td></tr>');
      if (!folded) g.people.forEach(function (p) { out.push(row(p)); });
    });

    if (!out.length) {
      out.push('<tr><td colspan="' + COLS + '" class="pane-empty">'
        + 'Nobody matches that.</td></tr>');
    }

    $('#t').innerHTML = '<thead>' + head() + '</thead><tbody>' + out.join('') + '</tbody>';
    $('#wrap').hidden = false;
    chrome();
  }

  function chrome() {
    var by = {};
    D.rollups.forEach(function (r) { by[r.key] = { cost: 0, heads: 0 }; });
    var set = 0;
    var open = 0;
    D.people.forEach(function (p) {
      var b = by[roll(p)];
      b.heads++;
      var c = cost(p);
      if (c != null) { b.cost += c; set++; }
      if (p.tbh) open++;
    });
    var all = D.rollups.reduce(function (a, r) { return a + by[r.key].cost; }, 0);

    $('#pl').innerHTML = D.rollups.map(function (r) {
      return '<div class="bd-m">' + esc(r.label)
        + '<b>' + money(by[r.key].cost) + '</b></div>';
    }).join('')
      + '<div class="bd-m">Everybody<b>' + money(all) + '</b></div>'
      + '<div class="bd-saved" id="saved">'
      + (saving ? 'Saving…' : 'Saved as you type') + '</div>';
    $('#pl').hidden = false;

    var unsplit = D.people.filter(function (p) { return splits(p) && !p.cls; }).length;
    $('#prog').innerHTML = '<b>' + D.people.length + '</b> on the plan · <b>'
      + set + '</b> costed · <b>' + unsplit + '</b> not split · <b>'
      + open + '</b> to be hired';

    // Against the budget. Recomputed locally from the same rollups, so it
    // moves with the sheet rather than lagging a round trip behind.
    var vs = $('#vs');
    if (vs) {
      vs.innerHTML = (D.against || []).map(function (a) {
        var plan = by[a.key] ? by[a.key].cost : 0;
        var gap = a.budget == null ? null : plan - a.budget;
        return '<div><div class="lb-vs-k">' + esc(a.label) + '</div>'
          + '<div class="lb-vs-v">' + money(plan)
          + (a.budget == null ? ''
            : ' <span class="gap ' + (gap > 0 ? 'over' : 'under') + '">'
              + (gap > 0 ? '+' : '−') + money(Math.abs(gap)).replace('−', '')
              + ' vs budget</span>')
          + '</div>'
          // A line with no 2026 behind it cannot also be "still the 2026
          // baseline". Saying both at once is how a reader concludes the
          // page is confused rather than that the line is new.
          + '<div class="lb-vs-n">' + esc(a.lineName) + ': '
          + (a.budget == null
            ? 'new for ' + D.year + ', so there is no 2026 to compare'
            : money(a.budget) + (a.decided ? '' : ' (still the 2026 baseline)'))
          + '</div></div>';
      }).join('');
      vs.hidden = !(D.against || []).length;
    }

    $('#dl').href = '/api/labor.csv?year=' + D.year;
    $('#sub').textContent = D.year + ' · ' + D.people.length + ' people';
    $('#rc').textContent = 'Roster from the Staff base as of ' + D.rosterAsOf
      + ' · Active and to-be-hired · ' + D.rosterSize + ' people'
      + (D.separate ? ' · ' + D.separate + ' excluded, separate entity' : '');
  }

  // ── Saving ────────────────────────────────────────────────────────────

  function person(k) {
    return D.people.filter(function (p) { return p.k === k; })[0];
  }
  function mark() {
    var el = $('#saved');
    if (el) el.textContent = saving ? 'Saving…' : 'Saved as you type';
  }
  function say(msg) {
    $('#notice').innerHTML = '<div class="notice">' + esc(msg) + '</div>';
  }

  function send(path, body, after) {
    saving++;
    mark();
    fetch(path + '?year=' + D.year, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return { errors: ['The server did not answer in JSON.'] }; });
    }).then(function (out) {
      if (out && out.errors) return say(out.errors.join(' '));
      $('#notice').innerHTML = '';
      if (out && out.against) D.against = out.against;
      if (out && out.people) {
        // Anybody whose row the cursor is in keeps what is on screen: a
        // reply about the cell you just left must not overwrite the one you
        // are typing in now.
        var busy = document.activeElement && document.activeElement.closest
          ? document.activeElement.closest('tr[data-k]') : null;
        var hold = busy ? busy.dataset.k : '';
        var mine = {};
        D.people.forEach(function (p) { mine[p.k] = p; });
        D.people = out.people.map(function (fresh) {
          return fresh.k === hold && mine[hold] ? mine[hold] : fresh;
        });
      }
      if (after) after(out);
    }).catch(function () {
      say('That did not save. Nothing was lost from the page — the figure is '
        + 'still here — but it has not reached the server.');
    }).then(function () {
      saving = Math.max(0, saving - 1);
      mark();
      chrome();
    });
  }

  function save(p, redraw) {
    send('/api/labor/person', {
      key: p.added ? p.k : p.k, added: p.added, name: p.n, title: p.t,
      dept: p.d, division: p.v, pay: p.pay, cls: p.cls,
      rate: p.rate, salary: p.salary, hours: p.hours, note: p.note,
    }, redraw ? function () { render(); } : null);
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  function readNum(input, p, field) {
    var raw = input.value.replace(/[,$\s]/g, '');
    if (raw === '') p[field] = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) p[field] = Number(raw);
    else return false;
    input.classList.toggle('set', p[field] != null);
    var td = input.closest('tr').children[6];
    var c = cost(p);
    td.textContent = c == null ? '—' : money(c);
    td.className = 'bd-n' + (c == null ? ' bd-base' : '');
    return true;
  }

  function bind() {
    var t = $('#t');

    t.addEventListener('input', function (e) {
      var tr = e.target.closest('tr[data-k]');
      if (!tr) return;
      var p = person(tr.dataset.k);
      if (!p) return;
      var f = e.target.dataset.f;
      if (f === 'rate' || f === 'salary' || f === 'hours') { readNum(e.target, p, f); chrome(); }
      if (f === 'note' || f === 'name' || f === 'title') {
        if (f === 'note') p.note = e.target.value;
        if (f === 'name') p.n = e.target.value;
        if (f === 'title') p.t = e.target.value;
        clearTimeout(timers[p.k]);
        timers[p.k] = setTimeout(function () { save(p); }, 900);
      }
    });

    t.addEventListener('change', function (e) {
      var tr = e.target.closest('tr[data-k]');
      if (!tr) return;
      var p = person(tr.dataset.k);
      if (!p) return;
      var f = e.target.dataset.f;
      if (f === 'cls') {
        p.cls = e.target.value;
        e.target.classList.toggle('set', Boolean(p.cls));
        save(p);
        return;
      }
      if (f === 'pay') {
        p.pay = e.target.value;
        // Which figures the row asks for has just changed, so the row is
        // drawn again rather than patched.
        save(p, true);
        return;
      }
      if (f === 'rate' || f === 'salary' || f === 'hours') {
        if (!readNum(e.target, p, f)) return;
        e.target.value = p[f] == null ? '' : comma(p[f]);
        save(p);
      }
    });

    t.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('lb-in')) e.target.blur();
    });

    t.addEventListener('click', function (e) {
      var fold = e.target.closest('.lb-caret');
      if (fold) {
        var d = fold.closest('tr').dataset.d;
        shut[d] = !shut[d];
        render();
        return;
      }
      var x = e.target.closest('.lb-x');
      if (!x) return;
      var p = person(x.closest('tr').dataset.k);
      if (!p) return;
      // Asked rather than undoable: there is no bin on this page, and a
      // write-in struck off is gone for good.
      if (!window.confirm('Take ' + p.n + ' off the ' + D.year + ' labor plan?'
        + (p.added ? '\n\nThis post exists only here, so it will be gone.'
          : '\n\nThey stay in the Staff base — this only takes them off the plan.'))) return;
      send('/api/labor/person/remove', { key: p.k, added: p.added },
           function () { render(); });
    });

    // The department-wide setter lives on a heading row, which has no
    // data-k, so it is handled on the capture pass -- before the per-person
    // branch above can look for one.
    t.addEventListener('change', function (e) {
      if (!e.target.classList.contains('lb-dsel')) return;
      var want = e.target.value;
      if (!want) return;
      var dept = e.target.dataset.dept;
      var keys = D.people.filter(function (p) { return p.d === dept && splits(p); })
        .map(function (p) { return p.k; });
      send('/api/labor/classify', { keys: keys, cls: want === 'clear' ? '' : want },
           function () { render(); });
    }, true);

    $('#filter').addEventListener('change', function (e) { show = e.target.value; render(); });

    $('#add').addEventListener('click', function () {
      var name = window.prompt('What is the post called?\n\n'
        + 'A job title is fine — it does not need a person yet.');
      if (!name || !name.trim()) return;
      send('/api/labor/person', { added: true, name: name.trim(), title: name.trim() },
        function (out) {
          render();
          // Straight into the pay picker, which is the next thing to answer.
          var row = out && out.key && document.querySelector('tr[data-k="' + out.key + '"]');
          if (row) {
            row.scrollIntoView({ block: 'center' });
            var sel = row.querySelector('.lb-sel');
            if (sel) sel.focus();
          }
        });
    });
  }

  fetch('/api/labor', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.status === 404 ? { shut: true } : r.json(); })
    .then(function (data) {
      if (data.shut) {
        $('#sub').textContent = 'Not open to you';
        return say('Labor planning is not open to this address. It holds every '
          + 'person’s pay by name, so it sits behind the same list as the budget '
          + 'rather than riding on who can see the tile. Ask Jeremy to add you.');
      }
      if (data.error) { $('#sub').textContent = 'Unavailable'; return say(data.error); }
      D = data;
      $('#bar').hidden = false;
      $('#say').innerHTML = 'Everybody on the Staff base with a status of Active or '
        + 'to-be-hired, plus anything added here. Salaried people need a salary; '
        + 'hourly people need a rate <b>and</b> hours — a rate on its own is not a cost, '
        + 'so the projection stays blank until both are in. '
        + 'Nobody’s pay is stored anywhere but here.';
      // The comparison panel is built after the data arrives so the page has
      // nothing in it to misread while it is still loading.
      var vs = document.createElement('div');
      vs.className = 'lb-vs';
      vs.id = 'vs';
      $('#say').after(vs);
      bind();
      render();
    })
    .catch(function () {
      $('#sub').textContent = 'Unavailable';
      say('The plan did not load. That is this page failing to reach the server, '
        + 'not anything wrong with the plan itself.');
    });
}());
