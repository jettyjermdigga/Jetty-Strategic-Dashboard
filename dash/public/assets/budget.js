(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // A minus sign, not a hyphen: these sit in a tabular-figure column and the
  // hyphen is half the width, so a column of negatives wanders.
  function money(n) {
    var v = Math.round(Number(n) || 0);
    return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString();
  }
  function kay(n) {
    var v = Math.round((Number(n) || 0) / 1000);
    return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString() + 'K';
  }
  // 2027-04-03 reads as 4/3. Built from the parts rather than through Date,
  // which would shift the day backwards for anyone west of UTC.
  function md(d) {
    var p = String(d || '').split('-');
    return p.length === 3 ? Number(p[1]) + '/' + Number(p[2]) : '';
  }

  var D = null;             // what the server last told us
  var view = 'year';
  var base = 'proj';
  var saving = 0;
  var noteTimer = {};

  var VIEWS = [
    { k: 'year', label: 'Year' }, { k: 'qtr', label: 'Quarter' },
    { k: 'month', label: 'Month' }, { k: 'week', label: 'Week' },
  ];

  var SAY = {
    year: 'Type a figure for next year, or leave it and the 2026 baseline carries. '
      + 'The note is the point — it is what nobody else knows about that line.',
    qtr: 'Retail quarters: thirteen weeks each, not calendar quarters. '
      + 'Rolled up from the weekly curve, so it is a view of the annual figure rather than '
      + 'somewhere to type one.',
    month: 'Retail months, 4-4-5. March, June, September and December carry more because they '
      + 'are five weeks long, not because of seasonality.',
    week: '77 lines across 52 weeks is 4,004 cells, which is not something anybody budgets by '
      + 'hand. The annual figure is spread on the seasonality curve instead.',
  };

  // ── What a line is worth ──────────────────────────────────────────────

  function val(l) { return l.amount == null ? l[base] : l.amount; }

  // The same spread the Worker does, kept here as well so the sheet redraws
  // the instant a figure is typed rather than after a round trip. The curve
  // and the week counts both come from the server, so the two cannot drift.
  function weeksIn(cadence) {
    return D.periods[cadence].map(function (p) { return p.weeks || 1; });
  }
  function spread(total, cadence) {
    var weekly = D.curve.map(function (c) { return total * c; });
    if (cadence === 'week') return weekly;
    var out = [];
    var i = 0;
    weeksIn(cadence).forEach(function (n) {
      var sum = 0;
      for (var j = 0; j < n; j++) sum += weekly[i + j];
      i += n;
      out.push(sum);
    });
    return out;
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  function dot(l) {
    return '<i class="bd-dot' + (l.flagged ? ' flag' : l.amount != null ? ' set' : '')
      + '" title="' + (l.flagged ? 'Flagged for another look'
        : l.amount != null ? 'Decided' : 'Not decided yet') + '"></i>';
  }

  function head() {
    if (view === 'year') {
      return '<tr><th>Line</th>'
        + '<th>' + D.baselineYear + ' plan</th>'
        + '<th>' + D.baselineYear + ' actual</th>'
        + '<th>' + D.baselineYear + ' projected</th>'
        + '<th>' + D.year + ' budget</th><th>Δ</th><th>Flag</th>'
        + '<th>Note / assumption</th></tr>';
    }
    return '<tr><th>Line</th>'
      + D.periods[view].map(function (p) {
        return '<th>' + esc(p.label) + '<span>' + md(p.start) + '–' + md(p.end)
          + (view !== 'week' ? ' · ' + p.weeks + 'w' : '') + '</span></th>';
      }).join('')
      + '<th>' + D.year + ' total</th></tr>';
  }

  // A 2026 figure, or a note that there isn't one. Nothing and zero are
  // different answers, and "$0K" in three columns would read as a line we
  // spent nothing on rather than one that did not exist.
  function was(v) {
    return v == null ? '<span class="bd-new">new</span>' : kay(v);
  }

  function annualRow(l) {
    var baseline = l[base];
    var v = val(l);
    // No baseline means no percentage: there is nothing to be a percentage
    // of, and dividing by the 1 the guard supplies would print +340000%.
    var d = l.amount == null || baseline == null ? null
      : (l.amount - baseline) / Math.max(1, Math.abs(baseline)) * 100;
    // Up is good on revenue and bad on everything else, so the colour is
    // decided by the group rather than by the sign.
    var good = d == null ? '' : (l.g === 'rev' ? d > 0 : d < 0) ? 'bd-dn' : 'bd-up';
    return '<tr data-k="' + esc(l.k) + '">'
      + '<td><span class="bd-name">' + dot(l) + '<span>' + esc(l.n) + '</span></span></td>'
      + '<td class="bd-n bd-base">' + was(l.plan) + '</td>'
      + '<td class="bd-n bd-base">' + was(l.act) + '</td>'
      + '<td class="bd-n' + (base === 'proj' ? '' : ' bd-base') + '">' + was(l.proj) + '</td>'
      + '<td><input class="bd-in bd-amt' + (l.amount != null ? ' set' : '') + '" inputmode="numeric"'
        + ' aria-label="' + esc(l.n) + ' budget for ' + D.year + '"'
        + ' value="' + (l.amount == null ? '' : Math.round(l.amount).toLocaleString()) + '"'
        + ' placeholder="' + (baseline == null ? '' : Math.round(baseline).toLocaleString()) + '"></td>'
      + '<td class="bd-n ' + good + '">'
        + (d == null ? '—' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '%') + '</td>'
      + '<td><button class="bd-flag" type="button" aria-pressed="' + (l.flagged ? 'true' : 'false')
        + '" title="Flag this line for another look">' + (l.flagged ? '⚑' : '⚐') + '</button></td>'
      + '<td><input class="bd-note" value="' + esc(l.note) + '"'
        + ' aria-label="Assumption behind ' + esc(l.n) + '"'
        + ' placeholder="why this number…"></td>'
      + '</tr>';
  }

  function periodRow(l) {
    var v = val(l);
    var dim = l.amount == null ? ' bd-base' : '';
    return '<tr data-k="' + esc(l.k) + '">'
      + '<td><span class="bd-name">' + dot(l) + '<span>' + esc(l.n) + '</span></span></td>'
      + spread(v, view).map(function (n) {
        return '<td class="bd-n' + dim + '">' + kay(n) + '</td>';
      }).join('')
      + '<td class="bd-n"><b>' + kay(v) + '</b></td></tr>';
  }

  function render() {
    var span = view === 'year' ? 8 : D.periods[view].length + 2;
    var rows = [];
    var last = '';
    D.lines.forEach(function (l) {
      if (l.g !== last) {
        last = l.g;
        var g = D.groups.filter(function (x) { return x.key === l.g; })[0];
        rows.push('<tr class="bd-grp"><td colspan="' + span + '">'
          + esc(g ? g.label : l.g) + '</td></tr>');
      }
      rows.push(view === 'year' ? annualRow(l) : periodRow(l));
    });

    var t = $('#t');
    t.innerHTML = '<thead>' + head() + '</thead><tbody>' + rows.join('') + '</tbody>';
    t.classList.toggle('ro', view !== 'year');
    $('#wrap').hidden = false;
    chrome();
  }

  // Everything round the sheet that changes with a figure: the P&L, the
  // count, and the sentence saying what this view is.
  function chrome() {
    var sum = function (g) {
      return D.lines.filter(function (l) { return l.g === g; })
        .reduce(function (a, l) { return a + val(l); }, 0);
    };
    var rev = sum('rev');
    var cogs = sum('cogs');
    var opex = sum('opex');
    var gm = rev - cogs;
    var net = gm - opex;
    var set = D.lines.filter(function (l) { return l.amount != null; }).length;
    var flagged = D.lines.filter(function (l) { return l.flagged; }).length;

    var m = function (label, v, extra) {
      return '<div class="bd-m">' + label + '<b' + (v < 0 ? ' class="neg"' : '') + '>'
        + money(v) + (extra || '') + '</b></div>';
    };
    $('#pl').innerHTML = m('Revenue', rev) + m('Cost of goods', cogs)
      + m('Gross margin', gm, '<span class="pct"> · '
        + (rev ? (gm / rev * 100).toFixed(1) : '0.0') + '%</span>')
      + m('Operating expenses', opex) + m('Net income', net)
      + '<div class="bd-saved" id="saved">' + (saving ? 'Saving…' : 'Saved as you type')
      + '</div>';
    $('#pl').hidden = false;

    $('#prog').innerHTML = '<b>' + set + '</b> of ' + D.lines.length + ' lines set · <b>'
      + flagged + '</b> flagged';

    var yr = D.periods.year[0];
    $('#rc').textContent = 'Retail ' + D.year + ' · 52 weeks · ' + yr.start
      + ' to ' + yr.end + ' · 4-4-5 (March, June, September and December are five weeks)';

    // Said on the page rather than left for somebody to find out: the weekly
    // shape is the only made-up number in here.
    $('#say').innerHTML = SAY[view]
      + (view !== 'year' && D.curvePlaceholder
        ? ' <b>The curve is a placeholder</b> — a plausible apparel year, not ours. '
          + 'Annual and quarterly totals are sound; the shape within them is not, '
          + 'until 2026’s weekly revenue is published.'
        : '');

    $('#dl').href = '/api/budget.csv?year=' + D.year + '&base=' + base + '&view=' + view;
    $('#sub').textContent = D.year + ' · against ' + D.baselineYear;
  }

  // ── Saving ────────────────────────────────────────────────────────────

  function line(k) {
    return D.lines.filter(function (l) { return l.k === k; })[0];
  }

  function mark() {
    var el = $('#saved');
    if (el) el.textContent = saving ? 'Saving…' : 'Saved as you type';
  }

  // One line at a time, and the whole set back. There is no "save the
  // budget" button: a budget built over weeks must not depend on anybody
  // remembering to press one.
  function save(l) {
    saving++;
    mark();
    fetch('/api/budget/line?year=' + D.year, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: l.k, amount: l.amount, note: l.note, flagged: l.flagged }),
    }).then(function (r) {
      return r.json().catch(function () { return { errors: ['The server did not answer in JSON.'] }; });
    }).then(function (out) {
      if (out && out.lines) {
        // Kept rather than replaced: somebody typing in a second field while
        // this was in flight would otherwise watch their own keystrokes be
        // overwritten by a reply about the first.
        out.lines.forEach(function (fresh) {
          var mine = line(fresh.k);
          if (mine && document.activeElement
              && document.activeElement.closest
              && document.activeElement.closest('tr[data-k="' + fresh.k + '"]')) return;
          if (mine) { mine.amount = fresh.amount; mine.note = fresh.note; mine.flagged = fresh.flagged; }
        });
      }
      if (out && out.errors) say(out.errors.join(' '));
    }).catch(function () {
      say('That did not save. Check the connection and try again — nothing was lost '
        + 'from the page, so the figure is still here.');
    }).then(function () {
      saving = Math.max(0, saving - 1);
      mark();
      chrome();
    });
  }

  function say(msg) {
    $('#notice').innerHTML = '<div class="notice">' + esc(msg) + '</div>';
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  function onAmount(input, l) {
    var raw = input.value.replace(/[,$\s]/g, '');
    if (raw === '') l.amount = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) l.amount = Number(raw);
    else return;                              // half-typed; leave it alone
    input.classList.toggle('set', l.amount != null);
    var row = input.closest('tr');
    var d = row && row.querySelector('.bd-dot');
    if (d) d.className = 'bd-dot' + (l.flagged ? ' flag' : l.amount != null ? ' set' : '');
    chrome();                                 // the P&L moves as you type
  }

  function bind() {
    var t = $('#t');

    t.addEventListener('input', function (e) {
      var l = e.target.closest('tr') && line(e.target.closest('tr').dataset.k);
      if (!l) return;
      if (e.target.classList.contains('bd-amt')) onAmount(e.target, l);
      if (e.target.classList.contains('bd-note')) {
        l.note = e.target.value;
        // Debounced: a note is a sentence, and a POST per keystroke would be
        // forty writes for one assumption.
        clearTimeout(noteTimer[l.k]);
        noteTimer[l.k] = setTimeout(function () { save(l); }, 900);
      }
    });

    // The figure commits when you leave the cell, so an abandoned keystroke
    // never becomes next year's budget.
    t.addEventListener('change', function (e) {
      var l = e.target.closest('tr') && line(e.target.closest('tr').dataset.k);
      if (!l || !e.target.classList.contains('bd-amt')) return;
      onAmount(e.target, l);
      e.target.value = l.amount == null ? '' : Math.round(l.amount).toLocaleString();
      save(l);
    });

    t.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('bd-amt')) e.target.blur();
    });

    t.addEventListener('click', function (e) {
      var b = e.target.closest('.bd-flag');
      if (!b) return;
      var l = line(b.closest('tr').dataset.k);
      l.flagged = !l.flagged;
      b.setAttribute('aria-pressed', l.flagged ? 'true' : 'false');
      b.textContent = l.flagged ? '⚑' : '⚐';
      var d = b.closest('tr').querySelector('.bd-dot');
      d.className = 'bd-dot' + (l.flagged ? ' flag' : l.amount != null ? ' set' : '');
      save(l);
    });

    $('#seg').innerHTML = VIEWS.map(function (v) {
      return '<button type="button" data-v="' + v.k + '" aria-pressed="'
        + (v.k === view) + '">' + v.label + '</button>';
    }).join('');
    $('#seg').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      view = b.dataset.v;
      [].forEach.call(e.currentTarget.children, function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      render();
    });

    $('#base').innerHTML = D.bases.map(function (b) {
      return '<option value="' + b.key + '"' + (b.key === base ? ' selected' : '') + '>'
        + esc(b.label) + '</option>';
    }).join('');
    $('#base').addEventListener('change', function (e) { base = e.target.value; render(); });
  }

  fetch('/api/budget', { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (r.status === 404) return { shut: true };
      return r.json();
    })
    .then(function (data) {
      if (data.shut) {
        $('#sub').textContent = 'Not open to you';
        return say('The Budget Builder is not open to this address. It holds next year’s '
          + 'payroll, partner draws and margin line by line, so it has a list of its own '
          + 'rather than riding on who can see the tile. Ask Jeremy to add you.');
      }
      if (data.error) { $('#sub').textContent = 'Unavailable'; return say(data.error); }
      D = data;
      base = (D.bases[0] || {}).key || 'proj';
      $('#bar').hidden = false;
      bind();
      render();
    })
    .catch(function () {
      $('#sub').textContent = 'Unavailable';
      say('The budget did not load. That is this page failing to reach the server, '
        + 'not anything wrong with the budget itself.');
    });
}());
