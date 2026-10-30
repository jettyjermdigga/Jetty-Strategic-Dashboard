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

  // A figure in a box, as it should read on the way back out.
  //
  // A rate always carries its cents. $19.10 an hour is the rate somebody is
  // on, and rounding it to $19 on screen is not a display choice: the next
  // edit starts from what is shown, so the ten pence would be typed over
  // and lost the first time anybody corrected the hours next to it.
  //
  // Everything else is whole unless it is not -- a salary of $54,500 should
  // not read $54,500.00, and one of $54,500.50 should not read $54,501.
  function fig(v, field) {
    if (v == null || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return '';
    if (field === 'rate') {
      return n.toLocaleString(undefined, { minimumFractionDigits: 2,
                                           maximumFractionDigits: 2 });
    }
    var r = Math.round(n * 100) / 100;
    return r % 1 === 0 ? comma(r)
      : r.toLocaleString(undefined, { minimumFractionDigits: 2,
                                      maximumFractionDigits: 2 });
  }

  var D = null;
  // Every way the sheet is narrowed, in one place. Empty means that field
  // asks nothing, which is why an untouched bar shows everybody.
  var f = { q: '', division: '', dept: '', pay: '', cls: '', show: 'all' };
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
  //
  // Mirrors matches() in worker/labor.js. The sheet has to narrow as you
  // type, which it cannot do by asking the server -- so the rule lives in
  // both places and the tests check the two agree, the same arrangement
  // asks() and roll() are under.
  function keep(p) {
    var q = (f.q || '').trim().toLowerCase();
    if (q) {
      var hay = [p.n, p.t, p.d, p.v].map(function (x) {
        return String(x == null ? '' : x).toLowerCase();
      });
      var hit = hay.some(function (x) { return x.indexOf(q) >= 0; });
      if (!hit) return false;
    }
    if (f.division && String(p.v || '') !== f.division) return false;
    if (f.dept && String(p.d || '') !== f.dept) return false;
    if (f.pay && String(p.pay || '') !== f.pay) return false;
    if (f.cls) {
      var want = f.cls === '-' ? '' : f.cls;
      if (String(p.cls || '') !== want) return false;
    }
    if (f.show === 'todo' && cost(p) != null) return false;
    if (f.show === 'base-todo' && p.prior && p.prior.cost != null) return false;
    if (f.show === 'tbh' && !p.tbh) return false;
    if (f.show === 'payroll' && !splits(p)) return false;
    if (f.show === 'unsplit' && !(splits(p) && !p.cls)) return false;
    return true;
  }

  function shown() {
    return D.people.filter(keep).sort(function (a, b) {
      // Write-ins last, then alphabetical. The sheet is one list now, so
      // the department is a column and a filter rather than a band.
      if (a.added !== b.added) return a.added ? 1 : -1;
      return a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1;
    });
  }

  var filtered = function () {
    return Boolean(f.q || f.division || f.dept || f.pay || f.cls
      || (f.show && f.show !== 'all'));
  };

  // ── Drawing ───────────────────────────────────────────────────────────

  var COLS = 17;

  function head() {
    return '<tr>'
      + '<th>Person</th><th>Division</th><th>Department</th><th>Hours</th>'
      + '<th>Paid</th><th>Direct or G&amp;A</th>'
      + '<th class="lb-y1">' + D.baseYear + ' paid</th>'
      + '<th class="lb-y1">' + D.baseYear + ' rate <span>$/hr</span></th>'
      + '<th class="lb-y1">' + D.baseYear + ' hours</th>'
      + '<th class="lb-y1">' + D.baseYear + ' salary</th>'
      + '<th class="lb-y1 lb-tot">' + D.baseYear + ' total</th>'
      + '<th>' + D.year + ' rate <span>$/hr</span></th>'
      + '<th>' + D.year + ' hours</th>'
      + '<th>' + D.year + ' salary</th>'
      + '<th class="lb-tot">' + D.year + ' total</th>'
      + '<th>Note</th><th></th></tr>';
  }

  // Part-time used to be a chip beside the name. It is a column now, so
  // saying it twice would be two places to read the same thing and one
  // place to change it.
  function chips(p) {
    return p.tbh ? '<span class="lb-chip tbh">' + (p.added ? 'NEW' : 'TBH') + '</span>' : '';
  }

  // A cell for a figure this way of being paid does not ask for. Drawn as a
  // dash rather than left blank, so an empty column reads as "not asked"
  // instead of "not filled in".
  //
  // `yr` says which of the two years the cell belongs to, and the baseline
  // asks against ITS OWN pay type: somebody hourly last year and salaried
  // this year is ordinary, and the row would otherwise ask for a salary
  // they were never on.
  function cell(p, field, yr, cls, ph) {
    var base = yr === D.baseYear;
    var pay = base ? (p.prior && p.prior.pay) || p.pay : p.pay;
    var a = asks(pay);
    var wanted = !a || a === 'none' ? false
      : a === 'rate' ? (field === 'rate' || field === 'hours')
      : field === 'salary';
    var td = '<td' + (base ? ' class="lb-y1"' : '') + '>';
    if (!wanted) return td + '<span class="lb-na">\u2014</span></td>';
    var v = base ? (p.prior ? p.prior[field] : null) : p[field];
    return td + '<input class="bd-in lb-in ' + cls + (v != null ? ' set' : '')
      + '" data-f="' + field + '" data-y="' + yr + '"'
      // A numeric keypad with no decimal point on it is no use for a rate.
      + ' inputmode="' + (field === 'rate' ? 'decimal' : 'numeric') + '"'
      + ' aria-label="' + esc(p.n) + ' ' + yr + ' ' + field + '"'
      + ' value="' + esc(fig(v, field)) + '"'
      + ' placeholder="' + ph + '"></td>';
  }

  // Marked rather than counted. These used to be found by position, and
  // the day a column was inserted to their left the running total started
  // being written over the salary box next door -- destroying the input it
  // landed in. A cell that says what it is cannot be miscounted.
  function totalCell(c, base) {
    return '<td class="bd-n lb-tot' + (base ? ' lb-y1' : '')
      + (c == null ? ' bd-base' : '') + '" data-tot="' + (base ? 'base' : 'plan') + '">'
      + (c == null ? '\u2014' : money(c)) + '</td>';
  }

  // Only payroll splits. A commission rep or a partner has a budget line of
  // its own, so offering the choice would invite an answer that goes
  // nowhere -- the dash reads as "not asked", the same as the figures a pay
  // type does not want.
  function clsCell(p) {
    if (!splits(p)) return '<span class="lb-na">\u2014</span>';
    return '<select class="lb-sel lb-cls' + (p.cls ? ' set' : '') + '" data-f="cls"'
      + ' aria-label="Is ' + esc(p.n) + ' direct labor or G&amp;A?">'
      + '<option value="">\u2014</option>'
      + D.classes.map(function (c) {
        return '<option value="' + c.key + '"' + (c.key === p.cls ? ' selected' : '')
          + '>' + esc(c.label) + '</option>';
      }).join('') + '</select>';
  }

  // Picked from a list rather than typed, so two spellings of the same
  // department cannot end up as two departments -- which would split the
  // filter, the totals and the classifier three ways.
  //
  // The roster is where these start and not where they are fixed: moving
  // somebody for next year is a decision about the plan, and the Staff base
  // is still right about today.
  function pick(p, field, value, opts, label, none) {
    return '<td><select class="lb-sel lb-pick" data-f="' + field + '"'
      + ' aria-label="' + esc(label) + '">'
      + '<option value="">' + esc(none) + '</option>'
      + opts.map(function (o) {
        return '<option value="' + esc(o) + '"'
          + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select></td>';
  }

  // Every department on the plan, so one that only a write-in uses is
  // still pickable, plus Unassigned for a post that has no home yet.
  function deptOptions() {
    var seen = {};
    D.people.forEach(function (p) { if (p.d) seen[p.d] = true; });
    seen.Unassigned = true;
    return Object.keys(seen).sort();
  }

  // How somebody was paid in the baseline year, which is not always how
  // they are paid now -- five people on this roster are hourly in the
  // Staff base and were on a salary all year. Without this the 2026 block
  // asks them for a rate and has nowhere to put what they actually earned.
  function payCell(p, yr) {
    var base = yr === D.baseYear;
    var v = base ? (p.prior && p.prior.pay) || p.pay : p.pay;
    return '<td' + (base ? ' class="lb-y1"' : '') + '>'
      + '<select class="lb-sel' + (v ? ' set' : '') + '" data-f="pay" data-y="' + yr + '"'
      + ' aria-label="How ' + esc(p.n) + ' was paid in ' + yr + '">'
      + '<option value="">\u2014</option>'
      + D.payTypes.map(function (t) {
        return '<option value="' + t.key + '"' + (t.key === v ? ' selected' : '')
          + '>' + esc(t.label) + '</option>';
      }).join('') + '</select></td>';
  }

  function row(p) {
    var c = cost(p);
    var pc = p.prior ? p.prior.cost : null;
    var nameCell = p.added
      ? '<input class="bd-note" data-f="name" value="' + esc(p.n) + '" '
        + 'aria-label="Name of this post" placeholder="what the post is called">'
      : '<span>' + esc(p.n) + '</span>';
    var titleCell = p.added
      ? '<input class="bd-note" data-f="title" value="' + esc(p.t) + '" '
        + 'aria-label="Job title" placeholder="job title">'
      : '<span class="lb-title">' + esc(p.t || '\u2014') + '</span>';

    return '<tr data-k="' + esc(p.k) + '"' + (p.added ? ' class="lb-new"' : '') + '>'
      + '<td><span class="lb-who"><span class="lb-name">' + chips(p) + nameCell + '</span>'
        + titleCell + '</span></td>'
      + pick(p, 'division', p.v, D.divisions || [], 'Division for ' + p.n, '\u2014')
      + pick(p, 'dept', p.d, deptOptions(), 'Department for ' + p.n, 'Unassigned')
      + pick(p, 'ft', p.ft, D.ftTypes || [], 'Full or part time for ' + p.n, '\u2014')
      + payCell(p, D.year)
      + '<td>' + clsCell(p) + '</td>'
      + payCell(p, D.baseYear)
      + cell(p, 'rate', D.baseYear, '', '')
      + cell(p, 'hours', D.baseYear, 'hrs', comma(D.fullTimeHours))
      + cell(p, 'salary', D.baseYear, '', '')
      + totalCell(pc, true)
      + cell(p, 'rate', D.year, '', '')
      + cell(p, 'hours', D.year, 'hrs', comma(D.fullTimeHours))
      + cell(p, 'salary', D.year, '', '')
      + totalCell(c, false)
      + '<td><input class="bd-note" data-f="note" value="' + esc(p.note) + '"'
        + ' aria-label="Note about ' + esc(p.n) + '" placeholder="why / when"></td>'
      + '<td><button class="lb-x" type="button" title="Take off the plan"'
        + ' aria-label="Take ' + esc(p.n) + ' off the plan">\u00d7</button></td>'
      + '</tr>';
  }

  // One list, so the totals under it are the totals of what is on screen.
  // Filtering to a department and reading its payroll off the bottom is
  // what the department bands used to be for.
  function footRow(list) {
    var base = 0;
    var plan = 0;
    list.forEach(function (p) {
      base += (p.prior && p.prior.cost) || 0;
      plan += cost(p) || 0;
    });
    return '<tr class="lb-foot"><td colspan="10">' + list.length
      + (list.length === 1 ? ' person' : ' people')
      + (filtered() ? ' shown' : '') + '</td>'
      + '<td class="bd-n lb-tot lb-y1">' + money(base) + '</td>'
      + '<td colspan="3"></td>'
      + '<td class="bd-n lb-tot">' + money(plan) + '</td><td colspan="2"></td></tr>';
  }

  function render() {
    var list = shown();
    var body = list.length
      ? list.map(row).join('') + footRow(list)
      : '<tr><td colspan="' + COLS + '" class="pane-empty">Nobody matches that.</td></tr>';
    $('#t').innerHTML = '<thead>' + head() + '</thead><tbody>' + body + '</tbody>';
    $('#wrap').hidden = false;
    renderBar(list);
    chrome();
  }

  // The filter bar, drawn from what is actually on the plan rather than
  // from a fixed list: a department nobody is in is a dead option, and a
  // department added as a write-in would otherwise be unfilterable.
  function fill(el, opts, value, none) {
    if (!el) return;
    el.innerHTML = '<option value="">' + esc(none) + '</option>'
      + opts.map(function (o) {
        return '<option value="' + esc(o.key) + '"'
          + (o.key === value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('');
  }

  function uniq(get) {
    var seen = {};
    D.people.forEach(function (p) {
      var v = get(p);
      if (v) seen[v] = true;
    });
    return Object.keys(seen).sort().map(function (v) { return { key: v, label: v }; });
  }

  function renderBar(list) {
    fill($('#fDiv'), uniq(function (p) { return p.v; }), f.division, 'Any division');
    fill($('#fDept'), uniq(function (p) { return p.d; }), f.dept, 'Any department');
    fill($('#fPay'), D.payTypes.map(function (t) {
      return { key: t.key, label: t.label };
    }), f.pay, 'Any pay type');
    fill($('#fCls'), D.classes.map(function (c) {
      return { key: c.key, label: c.label };
    }).concat([{ key: '-', label: 'Not split yet' }]), f.cls, 'Direct or G&A');
    // The two year-specific ones are named here rather than in the Worker,
    // which would have to send the same label twice with a year in it.
    fill($('#filter'), (D.shows || []).filter(function (x) { return x.key !== 'all'; })
      .map(function (x) {
        return {
          key: x.key,
          label: x.key === 'todo' ? 'No ' + D.year + ' total'
            : x.key === 'base-todo' ? 'No ' + D.baseYear + ' total'
            : x.label,
        };
      }), f.show === 'all' ? '' : f.show, 'Everybody');
    $('#clr').hidden = !filtered();
    if ($('#q').value !== f.q) $('#q').value = f.q;

    // Set direct-or-G&A on everybody on screen. Ninety-six dropdowns is
    // not a decision anybody makes carefully by the fortieth one, and the
    // filters are how the sheet is narrowed now.
    //
    // How many are on payroll and how many are still unsplit is already in
    // the line above, so it is not said again here.
    var mine = list.filter(splits);
    var bulk = $('#bulkSet');
    bulk.hidden = !mine.length;
    if (!mine.length) return;
    bulk.innerHTML = '<option value="">Set all shown\u2026</option>'
      + D.classes.map(function (c) {
        return '<option value="' + c.key + '">All ' + esc(c.label.toLowerCase()) + '</option>';
      }).join('')
      + '<option value="clear">Clear all</option>';
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
    var backfilled = D.people.filter(function (p) {
      return p.prior && p.prior.cost != null;
    }).length;
    $('#prog').innerHTML = '<b>' + D.people.length + '</b> on the plan · <b>'
      + backfilled + '</b> with ' + D.baseYear + ' · <b>'
      + set + '</b> costed for ' + D.year + ' · <b>' + unsplit + '</b> not split · <b>'
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
    // Where the roster came from, on the one line that was already there.
    // The paragraph under it said the same at length and is gone -- but a
    // plan that is quietly two people short is one somebody reconciles
    // against payroll and cannot make agree, so what was left out is still
    // said, and still said on the page rather than in a tooltip.
    var sub = $('#sub');
    sub.textContent = D.baseYear + ' \u2192 ' + D.year + ' \u00b7 '
      + D.people.length + ' people \u00b7 Staff base ' + D.rosterAsOf
      + (D.separate ? ' \u00b7 ' + D.separate + ' separate' : '');
    sub.title = 'Active and to-be-hired on the Staff base as of ' + D.rosterAsOf
      + ' (' + D.rosterSize + ' people), plus anything added here'
      + (D.separate ? '. ' + D.separate + ' is a separate entity with its own '
        + 'books and is left off' : '');
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

  // The plan year's own line. Everything the row knows about the person
  // goes with it, because the row is the record.
  function save(p, redraw) {
    send('/api/labor/person', {
      year: D.year,
      key: p.k, added: p.added, name: p.n, title: p.t,
      dept: p.d, division: p.v, ft: p.ft, pay: p.pay, cls: p.cls,
      rate: p.rate, salary: p.salary, hours: p.hours, note: p.note,
    }, redraw ? function () { render(); } : null);
  }

  // The baseline year's line: what they were actually paid. Only the three
  // figures and the facts that identify the row -- the note, the split and
  // the pay type belong to the year being planned, and writing them onto
  // the baseline as well would have one edit quietly change two years.
  //
  // The pay type does go, because the baseline costs against its own: it
  // starts as a copy of this year's and is the thing to change when
  // somebody moved from hourly to salary.
  function saveBase(p) {
    var b = p.prior || {};
    send('/api/labor/person', {
      year: D.baseYear,
      key: p.k, added: p.added, name: p.n, title: p.t,
      dept: p.d, division: p.v, ft: p.ft, pay: b.pay || p.pay,
      rate: b.rate, salary: b.salary, hours: b.hours,
    });
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  // Which of the two years an input belongs to, and the object its figure
  // is kept on. The baseline keeps its figures under .prior, so the row
  // holds both years at once without two lists to keep in step.
  function holder(p, input) {
    var base = Number(input.dataset.y) === D.baseYear;
    if (!base) return p;
    if (!p.prior) p.prior = { pay: p.pay, rate: null, salary: null, hours: null, cost: null };
    return p.prior;
  }

  function readNum(input, p, field) {
    var on = holder(p, input);
    var raw = input.value.replace(/[,$\s]/g, '');
    if (raw === '') on[field] = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) on[field] = Number(raw);
    else return false;
    input.classList.toggle('set', on[field] != null);
    if (p.prior) p.prior.cost = cost({ pay: p.prior.pay || p.pay, rate: p.prior.rate,
                                       salary: p.prior.salary, hours: p.prior.hours });
    var tr = input.closest('tr');
    paint(tr.querySelector('[data-tot="base"]'), p.prior ? p.prior.cost : null, true);
    paint(tr.querySelector('[data-tot="plan"]'), cost(p), false);
    return true;
  }

  function paint(td, c, base) {
    if (!td) return;
    td.textContent = c == null ? '\u2014' : money(c);
    td.className = 'bd-n lb-tot' + (base ? ' lb-y1' : '') + (c == null ? ' bd-base' : '');
  }

  function bind() {
    var t = $('#t');

    t.addEventListener('input', function (e) {
      var tr = e.target.closest('tr[data-k]');
      if (!tr) return;
      var p = person(tr.dataset.k);
      if (!p) return;
      var fld = e.target.dataset.f;
      if (fld === 'rate' || fld === 'salary' || fld === 'hours') {
        readNum(e.target, p, fld); chrome();
      }
      if (fld === 'note' || fld === 'name' || fld === 'title'
          || fld === 'dept' || fld === 'division') {
        if (fld === 'note') p.note = e.target.value;
        if (fld === 'name') p.n = e.target.value;
        if (fld === 'title') p.t = e.target.value;
        if (fld === 'dept') p.d = e.target.value;
        if (fld === 'division') p.v = e.target.value;
        clearTimeout(timers[p.k]);
        timers[p.k] = setTimeout(function () { save(p); }, 900);
      }
    });

    t.addEventListener('change', function (e) {
      var tr = e.target.closest('tr[data-k]');
      if (!tr) return;
      var p = person(tr.dataset.k);
      if (!p) return;
      var fld = e.target.dataset.f;
      if (fld === 'dept' || fld === 'ft' || fld === 'division') {
        if (fld === 'dept') p.d = e.target.value;
        else if (fld === 'division') p.v = e.target.value;
        else p.ft = e.target.value;
        // A department changed is a row that may have just left the filter
        // it was found under, so the sheet is drawn again rather than
        // patched -- and the department list itself may have grown.
        save(p, true);
        return;
      }
      if (fld === 'cls') {
        p.cls = e.target.value;
        e.target.classList.toggle('set', Boolean(p.cls));
        save(p);
        return;
      }
      if (fld === 'pay') {
        if (Number(e.target.dataset.y) === D.baseYear) {
          if (!p.prior) p.prior = { rate: null, salary: null, hours: null, cost: null };
          p.prior.pay = e.target.value;
          p.prior.cost = cost({ pay: p.prior.pay, rate: p.prior.rate,
                                salary: p.prior.salary, hours: p.prior.hours });
          saveBase(p);
        } else {
          p.pay = e.target.value;
          save(p);
        }
        // Which figures that half of the row asks for has just changed, so
        // it is drawn again rather than patched.
        render();
        return;
      }
      if (fld === 'rate' || fld === 'salary' || fld === 'hours') {
        if (!readNum(e.target, p, fld)) return;
        var on = holder(p, e.target);
        e.target.value = fig(on[fld], fld);
        if (Number(e.target.dataset.y) === D.baseYear) saveBase(p); else save(p);
      }
    });

    t.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('lb-in')) e.target.blur();
    });

    t.addEventListener('click', function (e) {
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

    // Everybody the filters are showing, which is what the bar says it
    // will do. Read off the filter rather than off the table so a long
    // list is not limited to what has been scrolled to.
    $('#bulkSet').addEventListener('change', function (e) {
      var want = e.target.value;
      e.target.value = '';
      if (!want) return;
      var keys = shown().filter(splits).map(function (p) { return p.k; });
      if (!keys.length) return;
      send('/api/labor/classify', { keys: keys, cls: want === 'clear' ? '' : want },
           function () { render(); });
    });

    var narrow = function (field, value) { f[field] = value; render(); };
    $('#filter').addEventListener('change', function (e) {
      narrow('show', e.target.value || 'all');
    });
    $('#fDiv').addEventListener('change', function (e) { narrow('division', e.target.value); });
    $('#fDept').addEventListener('change', function (e) { narrow('dept', e.target.value); });
    $('#fPay').addEventListener('change', function (e) { narrow('pay', e.target.value); });
    $('#fCls').addEventListener('change', function (e) { narrow('cls', e.target.value); });
    $('#q').addEventListener('input', function (e) { narrow('q', e.target.value); });
    $('#clr').addEventListener('click', function () {
      f = { q: '', division: '', dept: '', pay: '', cls: '', show: 'all' };
      $('#q').value = '';
      render();
      $('#q').focus();
    });

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
      // The comparison panel is built after the data arrives so the page has
      // nothing in it to misread while it is still loading.
      var vs = document.createElement('div');
      vs.className = 'lb-vs';
      vs.id = 'vs';
      $('#bar').after(vs);
      bind();
      render();
    })
    .catch(function () {
      $('#sub').textContent = 'Unavailable';
      say('The plan did not load. That is this page failing to reach the server, '
        + 'not anything wrong with the plan itself.');
    });
}());
