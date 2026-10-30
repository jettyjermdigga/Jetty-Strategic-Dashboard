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
  // Every way the sheet is narrowed, in one place. Empty means that field
  // asks nothing, which is why an untouched bar shows everything.
  var f = { q: '', season: '', kind: '', show: 'all' };
  var saving = 0;
  var timers = {};

  var SIGNED_OUT = 'Your sign-in has expired. Reload the page.';

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
    }, opts || {})).then(function (res) {
      if (res.type === 'opaqueredirect' || res.redirected || res.status === 0) {
        throw new Error(SIGNED_OUT);
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          throw new Error((body.errors && body.errors.join(' ')) || body.error
            || ('Request failed (' + res.status + ')'));
        }
        return body;
      });
    });
  }

  function say(msg) {
    $('#notice').innerHTML = '<div class="notice">' + esc(msg) + '</div>';
  }

  // ── Which lines are on screen ─────────────────────────────────────────
  //
  // Mirrors matches() in worker/cogs.js. The sheet has to narrow as you
  // type, which it cannot do by asking the server -- so the rule lives in
  // both places and the tests check the two agree.
  function keep(r) {
    var q = (f.q || '').trim().toLowerCase();
    if (q) {
      var hay = [r.seasonLabel, r.season, r.kind, r.note].map(function (x) {
        return String(x == null ? '' : x).toLowerCase();
      });
      if (!hay.some(function (x) { return x.indexOf(q) >= 0; })) return false;
    }
    if (f.season && String(r.season || '') !== f.season) return false;
    if (f.kind && String(r.kind || '') !== f.kind) return false;
    if (f.show === 'todo' && r.amount != null) return false;
    if (f.show === 'costed' && r.amount == null) return false;
    return true;
  }

  // The planned seasons in the order the Worker lists them, then anything
  // added behind -- so a prior season backfilled later does not shuffle
  // itself into the middle of next year.
  function shown() {
    var at = {};
    (D.seasons || []).forEach(function (s, i) { at[s.key] = i; });
    var kindAt = {};
    (D.kinds || []).forEach(function (k, i) { kindAt[k.key] = i; });
    return D.lines.filter(keep).sort(function (a, b) {
      var sa = at[a.season] == null ? 999 : at[a.season];
      var sb = at[b.season] == null ? 999 : at[b.season];
      if (sa !== sb) return sa - sb;
      return (kindAt[a.kind] || 0) - (kindAt[b.kind] || 0);
    });
  }

  var filtered = function () {
    return Boolean(f.q || f.season || f.kind || (f.show && f.show !== 'all'));
  };

  // ── Drawing ───────────────────────────────────────────────────────────

  var COLS = 5;

  function head() {
    return '<tr><th>Season</th><th>Bulk or SMS</th><th class="lb-tot">Total COGS</th>'
      + '<th>Note</th><th></th></tr>';
  }

  function seasonCell(r) {
    var opts = (D.seasons || []).map(function (s) {
      return '<option value="' + esc(s.key) + '"'
        + (s.key === r.season ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    }).join('');
    return '<td><select class="lb-sel' + (r.season ? ' set' : '') + '" data-f="season"'
      + ' aria-label="Which season this line is">'
      + '<option value="">—</option>' + opts + '</select></td>';
  }

  function kindCell(r) {
    return '<td><select class="lb-sel' + (r.kind ? ' set' : '') + '" data-f="kind"'
      + ' aria-label="Bulk or samples">'
      + '<option value="">—</option>'
      + (D.kinds || []).map(function (k) {
        return '<option value="' + esc(k.key) + '"'
          + (k.key === r.kind ? ' selected' : '') + '>' + esc(k.label) + '</option>';
      }).join('') + '</select></td>';
  }

  function row(r) {
    return '<tr data-id="' + esc(r.id) + '"' + (r.added ? ' class="lb-new"' : '') + '>'
      + seasonCell(r)
      + kindCell(r)
      + '<td><input class="bd-in lb-in cg-amt' + (r.amount != null ? ' set' : '')
        + '" data-f="amount" inputmode="numeric"'
        + ' aria-label="Total COGS for ' + esc(r.seasonLabel || r.season) + ' '
        + esc(r.kind) + '"'
        + ' value="' + (r.amount == null ? '' : comma(r.amount)) + '"'
        + ' placeholder="—"></td>'
      + '<td><input class="bd-note" data-f="note" value="' + esc(r.note) + '"'
        + ' aria-label="Note" placeholder="what is in it / who is making it"></td>'
      + '<td><button class="lb-x" type="button" title="Take off the sheet"'
        + ' aria-label="Take this line off the sheet">×</button></td>'
      + '</tr>';
  }

  // The totals of what is on screen. Filtering to one season and reading
  // its bulk and samples off the bottom is most of what the filters are
  // for.
  function footRow(list) {
    var total = list.reduce(function (a, r) { return a + (r.amount || 0); }, 0);
    return '<tr class="lb-foot"><td colspan="2">' + list.length
      + (list.length === 1 ? ' line' : ' lines') + (filtered() ? ' shown' : '')
      + '</td><td class="bd-n lb-tot">' + money(total) + '</td>'
      + '<td colspan="2"></td></tr>';
  }

  function render() {
    var list = shown();
    var body = list.length
      ? list.map(row).join('') + footRow(list)
      : '<tr><td colspan="' + COLS + '" class="pane-empty">Nothing matches that.</td></tr>';
    $('#t').innerHTML = '<thead>' + head() + '</thead><tbody>' + body + '</tbody>';
    $('#wrap').hidden = false;
    renderBar();
    chrome();
  }

  function fill(el, opts, value, none) {
    if (!el) return;
    el.innerHTML = '<option value="">' + esc(none) + '</option>'
      + opts.map(function (o) {
        return '<option value="' + esc(o.key) + '"'
          + (o.key === value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('');
  }

  function renderBar() {
    fill($('#fSeason'), D.seasons || [], f.season, 'Any season');
    fill($('#fKind'), D.kinds || [], f.kind, 'Bulk and SMS');
    fill($('#filter'), (D.shows || []).filter(function (x) { return x.key !== 'all'; }),
         f.show === 'all' ? '' : f.show, 'Every line');
    $('#clr').hidden = !filtered();
    if ($('#q').value !== f.q) $('#q').value = f.q;
  }

  function chrome() {
    var s = D.summary || { byKind: {}, total: 0, decided: 0, lines: 0 };
    var vs = $('#vs');
    vs.innerHTML = (D.kinds || []).map(function (k) {
      var b = s.byKind[k.key] || { cost: 0, decided: 0, lines: 0 };
      return '<div class="bd-m" title="' + esc(k.note) + '">' + esc(k.label)
        + '<b>' + money(b.cost) + '</b>'
        + '<span class="lb-gap">' + b.decided + ' of ' + b.lines + ' costed</span>'
        + '</div>';
    }).join('')
      + '<div class="bd-m">Everything<b>' + money(s.total) + '</b>'
      + '<span class="lb-gap">' + s.decided + ' of ' + s.lines + ' costed</span></div>'
      + '<div class="bd-saved" id="saved">'
      + (saving ? 'Saving…' : 'Saved as you type') + '</div>';
    vs.hidden = false;

    // A season bought bulk twice is either two real commitments or one
    // typed in twice, and the sheet cannot tell which. It can say so,
    // which is the difference between a total somebody trusts and one
    // that is quietly double counted.
    var dupes = D.duplicates || [];
    $('#notice').innerHTML = dupes.length
      ? '<div class="notice">' + dupes.map(function (d) {
        return esc(d.season) + ' ' + esc(d.kind) + ' is on the sheet '
          + d.count + ' times';
      }).join('; ') + '. Both are in the total, so one of them is counted twice '
        + 'unless they are two real commitments.</div>'
      : '';

    $('#prog').innerHTML = '<b>' + s.lines + '</b> lines · <b>' + s.decided
      + '</b> costed · <b>' + Object.keys(s.bySeason || {}).length + '</b> seasons';
    $('#sub').textContent = (D.lines || []).length + ' lines · '
      + money(s.total) + ' planned';
  }

  // ── Saving ────────────────────────────────────────────────────────────

  function line(id) {
    return D.lines.filter(function (r) { return r.id === id; })[0];
  }
  function mark() {
    var el = $('#saved');
    if (el) el.textContent = saving ? 'Saving…' : 'Saved as you type';
  }

  function send(path, body, after) {
    saving++;
    mark();
    api(path, { method: 'POST', body: JSON.stringify(body) })
      .then(function (out) {
        $('#notice').innerHTML = '';
        if (out && out.lines) {
          // Whichever line the cursor is in keeps what is on screen: a
          // reply about the cell you just left must not overwrite the one
          // you are typing in now.
          var busy = document.activeElement && document.activeElement.closest
            ? document.activeElement.closest('tr[data-id]') : null;
          var hold = busy ? busy.dataset.id : '';
          var mine = {};
          D.lines.forEach(function (r) { mine[r.id] = r; });
          D.lines = out.lines.map(function (fresh) {
            return fresh.id === hold && mine[hold] ? mine[hold] : fresh;
          });
          D.seasons = out.seasons || D.seasons;
          D.summary = out.summary || D.summary;
          D.duplicates = out.duplicates || [];
        }
        if (after) after(out);
      })
      .catch(function (err) { say(err.message || 'That did not save.'); })
      .then(function () {
        saving = Math.max(0, saving - 1);
        mark();
        chrome();
      });
  }

  function save(r, redraw) {
    send('/api/cogs/line', {
      id: r.id, added: r.added, season: r.season, kind: r.kind,
      seasonLabel: r.seasonLabel, amount: r.amount, note: r.note,
    }, redraw ? function () { render(); } : null);
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  function readNum(input, r) {
    var raw = input.value.replace(/[,$\s]/g, '');
    if (raw === '') r.amount = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) r.amount = Number(raw);
    else return false;
    input.classList.toggle('set', r.amount != null);
    return true;
  }

  function bind() {
    var t = $('#t');

    t.addEventListener('input', function (e) {
      var tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      var r = line(tr.dataset.id);
      if (!r) return;
      var fld = e.target.dataset.f;
      if (fld === 'amount') { readNum(e.target, r); }
      if (fld === 'note') {
        r.note = e.target.value;
        clearTimeout(timers[r.id]);
        timers[r.id] = setTimeout(function () { save(r); }, 900);
      }
    });

    t.addEventListener('change', function (e) {
      var tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      var r = line(tr.dataset.id);
      if (!r) return;
      var fld = e.target.dataset.f;
      if (fld === 'season' || fld === 'kind') {
        if (fld === 'season') {
          r.season = e.target.value;
          var s = (D.seasons || []).filter(function (x) { return x.key === r.season; })[0];
          r.seasonLabel = s ? s.label : r.season;
        } else {
          r.kind = e.target.value;
        }
        // The line's id follows its season and kind, so the row has to be
        // drawn again rather than patched -- and it may have just sorted
        // itself somewhere else.
        save(r, true);
        return;
      }
      if (fld === 'amount') {
        if (!readNum(e.target, r)) return;
        e.target.value = r.amount == null ? '' : comma(r.amount);
        save(r);
      }
    });

    t.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('lb-in')) e.target.blur();
    });

    t.addEventListener('click', function (e) {
      var x = e.target.closest('.lb-x');
      if (!x) return;
      var r = line(x.closest('tr').dataset.id);
      if (!r) return;
      // Asked rather than undoable: there is no bin on this page.
      if (!window.confirm('Take ' + (r.seasonLabel || r.season) + ' '
        + (r.kind || '') + ' off the sheet?'
        + (r.added ? '\n\nThis line exists only here, so it will be gone.'
          : '\n\nIt comes back if you ever want it, by adding the season again.'))) return;
      send('/api/cogs/line/remove', { id: r.id, added: r.added },
           function () { render(); });
    });

    var narrow = function (field, value) { f[field] = value; render(); };
    $('#fSeason').addEventListener('change', function (e) { narrow('season', e.target.value); });
    $('#fKind').addEventListener('change', function (e) { narrow('kind', e.target.value); });
    $('#filter').addEventListener('change', function (e) {
      narrow('show', e.target.value || 'all');
    });
    $('#q').addEventListener('input', function (e) { narrow('q', e.target.value); });
    $('#clr').addEventListener('click', function () {
      f = { q: '', season: '', kind: '', show: 'all' };
      $('#q').value = '';
      render();
      $('#q').focus();
    });

    // A prior season, almost always. Both kinds at once, because a season
    // backfilled with only its bulk is a season whose samples look like
    // they cost nothing rather than like nobody has said yet.
    $('#add').addEventListener('click', function () {
      var name = window.prompt('Which season?\n\n'
        + 'SP26, F25 — whatever you call it. Both Bulk and SMS lines are added.');
      if (!name || !name.trim()) return;
      var label = name.trim();
      var key = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 39);
      if (!key) return say('"' + label + '" is not a season name this can use.');
      if ((D.seasons || []).some(function (s) { return s.key === key; })) {
        return say(label + ' is already on the sheet.');
      }
      var left = (D.kinds || []).length;
      (D.kinds || []).forEach(function (k) {
        send('/api/cogs/line', { added: true, season: key, seasonLabel: label,
                                 kind: k.key, amount: null },
          function () { if (--left <= 0) render(); });
      });
    });
  }

  api('/api/cogs')
    .then(function (data) {
      D = data;
      D.lines = data.lines || [];
      $('#bar').hidden = false;
      bind();
      render();
    })
    .catch(function (err) {
      $('#sub').textContent = 'Not open to you';
      say(/Unknown endpoint|No such endpoint|404/.test(err.message)
        ? 'COGS planning is not open to this address. It is next year’s cost '
          + 'of goods before any of it is committed, so it sits behind the same '
          + 'list as the budget. Ask Jeremy to add you.'
        : (err.message || 'The sheet did not load.'));
    });
}());
