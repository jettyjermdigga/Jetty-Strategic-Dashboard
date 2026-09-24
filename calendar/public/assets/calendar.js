/* Jetty Company Calendar.
 *
 * The whole item list is fetched once and filtered in the browser. A company
 * calendar is a few thousand rows at most, so paging it per view would buy
 * nothing and would make switching between month and year feel slow. The API
 * takes from/to if that ever stops being true.
 */
(function () {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var UNASSIGNED = '—unassigned—';

  // A month grid is unreadable at phone width -- there is no room for titles.
  // Agenda shows the same information in a form that survives the narrow column.
  var NARROW = window.matchMedia('(max-width: 820px)').matches;

  var state = {
    view: NARROW ? 'agenda' : 'month',
    cursor: new Date(),
    items: [],
    tax: null,
    me: { canEdit: false, email: '' },
    colorBy: 'category',
    cats: {},       // catKey -> { on: bool, types: { typeName: bool } }
    divs: {},       // divKey (or UNASSIGNED) -> bool
    stats: { Confirmed: true, Tentative: true, Cancelled: false },
  };

  // ── small helpers ──────────────────────────────────────────────────────

  var $ = function (sel) { return document.querySelector(sel); };
  var pad = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
  var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

  // Dates are built component-wise on purpose: new Date('2026-09-15') parses as
  // UTC midnight and renders as the 14th west of Greenwich.
  function fromYmd(s) {
    var p = String(s).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function sameDay(a, b) { return ymd(a) === ymd(b); }
  function todayYmd() { return ymd(new Date()); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hhmm(t) {
    if (!t) return '';
    var p = t.split(':');
    var h = Number(p[0]);
    var suffix = h >= 12 ? 'pm' : 'am';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (p[1] === '00' ? '' : ':' + p[1]) + suffix;
  }

  function catOf(key) {
    if (!state.tax) return null;
    for (var i = 0; i < state.tax.categories.length; i++) {
      if (state.tax.categories[i].key === key) return state.tax.categories[i];
    }
    return null;
  }
  function divOf(key) {
    if (!state.tax) return null;
    for (var i = 0; i < state.tax.divisions.length; i++) {
      if (state.tax.divisions[i].key === key) return state.tax.divisions[i];
    }
    return null;
  }

  function colorFor(item) {
    if (state.colorBy === 'division') {
      var d = divOf(item.division);
      return d ? d.color : '#8A8F98';
    }
    var c = catOf(item.category);
    return c ? c.color : '#8A8F98';
  }

  function labelFor(item) {
    var c = catOf(item.category);
    return (c ? c.label : item.category) + (item.type ? ' · ' + item.type : '');
  }

  // ── filtering ──────────────────────────────────────────────────────────

  function passes(item) {
    var cat = state.cats[item.category];
    if (!cat || !cat.on) return false;
    if (item.type && cat.types.hasOwnProperty(item.type) && !cat.types[item.type]) return false;
    var dkey = item.division || UNASSIGNED;
    if (state.divs.hasOwnProperty(dkey) && !state.divs[dkey]) return false;
    if (!state.stats[item.status]) return false;
    return true;
  }

  function visible() { return state.items.filter(passes); }

  // Items covering a given day, sorted so all-day entries sit above timed ones.
  function itemsOn(dateStr, pool) {
    return (pool || visible())
      .filter(function (it) { return it.start_date <= dateStr && it.end_date >= dateStr; })
      .sort(function (a, b) {
        if (a.all_day !== b.all_day) return b.all_day - a.all_day;
        if (a.all_day) return a.title.localeCompare(b.title);
        return (a.start_time || '').localeCompare(b.start_time || '') || a.title.localeCompare(b.title);
      });
  }

  // ── chrome ─────────────────────────────────────────────────────────────

  function renderNotice() {
    var bits = [];
    if (state.me.email && !state.me.accessConfigured) {
      bits.push('<strong>Identity is not verified yet.</strong> The calendar is trusting the '
        + 'sign-in header Cloudflare Access sets. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD in '
        + 'wrangler.toml to verify the signed token instead.');
    }
    if (!state.me.editorsConfigured) {
      bits.push('<strong>No editors configured.</strong> Nobody can add items until '
        + 'CALENDAR_EDITORS is set in wrangler.toml.');
    }
    $('#notice').innerHTML = bits.length
      ? '<div class="site-note">' + bits.join('<br><br>') + '</div>' : '';
  }

  function renderWho() {
    if (!state.me.email) { $('#who').textContent = ''; return; }
    $('#who').textContent = state.me.email + (state.me.canEdit ? '' : ' · read only');
  }

  function periodLabel() {
    var c = state.cursor;
    if (state.view === 'day') return DOW_LONG[c.getDay()] + ', ' + MONTHS[c.getMonth()] + ' ' + c.getDate();
    if (state.view === 'year') return String(c.getFullYear());
    if (state.view === 'agenda') return 'Next 6 months';
    return MONTHS[c.getMonth()] + ' ' + c.getFullYear();
  }

  // ── filter sidebar ─────────────────────────────────────────────────────

  function countsBy() {
    var byCat = {}, byType = {}, byDiv = {};
    state.items.forEach(function (it) {
      byCat[it.category] = (byCat[it.category] || 0) + 1;
      if (it.type) {
        var k = it.category + '::' + it.type;
        byType[k] = (byType[k] || 0) + 1;
      }
      var d = it.division || UNASSIGNED;
      byDiv[d] = (byDiv[d] || 0) + 1;
    });
    return { byCat: byCat, byType: byType, byDiv: byDiv };
  }

  function renderFilters() {
    if (!state.tax) return;
    var n = countsBy();

    $('#catTree').innerHTML = state.tax.categories.map(function (c) {
      var st = state.cats[c.key];
      var used = c.types.filter(function (t) { return n.byType[c.key + '::' + t]; });
      var rows = used.map(function (t) {
        return '<label><input type="checkbox" data-cat="' + esc(c.key) + '" data-type="' + esc(t) + '"'
          + (st.types[t] === false ? '' : ' checked') + '>'
          + '<span>' + esc(t) + '</span>'
          + '<span class="count">' + n.byType[c.key + '::' + t] + '</span></label>';
      }).join('');
      return '<div class="flt-group">'
        + '<div class="flt-head">'
        + '<label><input type="checkbox" data-cat="' + esc(c.key) + '"' + (st.on ? ' checked' : '') + '>'
        + '<i class="dot" style="background:' + c.color + '"></i>'
        + '<span class="name">' + esc(c.label) + '</span></label>'
        + '<span class="count">' + (n.byCat[c.key] || 0) + '</span>'
        + (rows ? '<button class="flt-toggle" data-expand="' + esc(c.key) + '" aria-expanded="false" aria-label="Show types">&#9656;</button>' : '')
        + '</div>'
        + (rows ? '<div class="flt-types" id="types-' + esc(c.key) + '">' + rows + '</div>' : '')
        + '</div>';
    }).join('');

    var divKeys = state.tax.divisions.map(function (d) { return d.key; });
    if (n.byDiv[UNASSIGNED]) divKeys.push(UNASSIGNED);
    $('#divTree').innerHTML = divKeys.map(function (k) {
      var d = divOf(k);
      var label = d ? d.label : 'No division';
      var color = d ? d.color : '#8A8F98';
      return '<label class="flt-row"><input type="checkbox" data-div="' + esc(k) + '"'
        + (state.divs[k] === false ? '' : ' checked') + '>'
        + '<i class="dot" style="background:' + color + '"></i>'
        + '<span>' + esc(label) + '</span>'
        + '<span class="count">' + (n.byDiv[k] || 0) + '</span></label>';
    }).join('');

    $('#statTree').innerHTML = state.tax.statuses.map(function (s) {
      return '<label class="flt-row"><input type="checkbox" data-stat="' + esc(s) + '"'
        + (state.stats[s] ? ' checked' : '') + '>'
        + '<span>' + esc(s) + '</span></label>';
    }).join('');
  }

  // ── views ──────────────────────────────────────────────────────────────

  function chipHtml(it, dateStr) {
    var cls = 'chip' + (it.status === 'Tentative' ? ' tentative' : '')
      + (it.status === 'Cancelled' ? ' cancelled' : '');
    var cont = it.start_date < dateStr ? '→ ' : '';
    var time = (!it.all_day && it.start_time && it.start_date === dateStr)
      ? '<span class="t">' + esc(hhmm(it.start_time)) + '</span>' : '';
    return '<div class="' + cls + '" style="--chip:' + colorFor(it) + '" data-id="' + esc(it.id) + '" '
      + 'title="' + esc(it.title + ' — ' + labelFor(it)) + '">'
      + time + '<span class="n">' + esc(cont + it.title) + '</span></div>';
  }

  function renderMonth() {
    var c = state.cursor;
    var first = new Date(c.getFullYear(), c.getMonth(), 1);
    var start = addDays(first, -first.getDay());
    var pool = visible();
    var today = todayYmd();

    var head = '<div class="mo-head">' + DOW.map(function (d) { return '<div>' + d + '</div>'; }).join('') + '</div>';
    var cells = '';
    for (var i = 0; i < 42; i++) {
      var day = addDays(start, i);
      var ds = ymd(day);
      var on = itemsOn(ds, pool);
      var out = day.getMonth() !== c.getMonth() ? ' out' : '';
      var isToday = ds === today ? ' today' : '';
      var shown = on.slice(0, 3).map(function (it) { return chipHtml(it, ds); }).join('');
      var more = on.length > 3
        ? '<div class="mo-more" data-day="' + ds + '">+' + (on.length - 3) + ' more</div>' : '';
      cells += '<div class="mo-cell' + out + isToday + '" data-day="' + ds + '">'
        + '<span class="mo-num">' + day.getDate() + '</span>' + shown + more + '</div>';
    }
    return head + '<div class="mo-grid">' + cells + '</div>';
  }

  function spanLabel(it) {
    var s = fromYmd(it.start_date);
    var e = fromYmd(it.end_date);
    var days = Math.round((e - s) / 86400000) + 1;
    return MONTHS[s.getMonth()].slice(0, 3) + ' ' + s.getDate() + ' \u2013 '
      + MONTHS[e.getMonth()].slice(0, 3) + ' ' + e.getDate() + ' (' + days + ' days)';
  }

  // One row renderer for the day view and the agenda. The agenda used to reuse
  // the month chip, which is a single line with nowhere to put the category,
  // division or location -- so its rows read as empty colour bars.
  function rowHtml(it) {
    var when = it.all_day ? 'All day'
      : hhmm(it.start_time) + (it.end_time ? '\u2013' + hhmm(it.end_time) : '');
    var meta = [labelFor(it)];
    var d = divOf(it.division); if (d) meta.push(d.label);
    if (it.start_date !== it.end_date) meta.push(spanLabel(it));
    if (it.location) meta.push(it.location);
    if (it.owner) meta.push(it.owner);
    if (it.status !== 'Confirmed') meta.push(it.status);
    var cls = 'day-item' + (it.status === 'Cancelled' ? ' cancelled' : '');
    return '<div class="' + cls + '" style="--chip:' + colorFor(it) + '" data-id="' + esc(it.id) + '">'
      + '<div class="day-when">' + esc(when) + '</div>'
      + '<div><div class="day-title">' + esc(it.title) + '</div>'
      + '<div class="day-meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('')
      + '</div></div></div>';
  }

  function renderDay() {
    var ds = ymd(state.cursor);
    var on = itemsOn(ds);
    if (!on.length) {
      return '<div class="cal-empty"><strong>Nothing scheduled</strong>'
        + 'No calendar items on this day match the current filters.</div>';
    }
    return '<div class="day-wrap"><div class="day-sub">' + on.length
      + (on.length === 1 ? ' item' : ' items') + '</div><div class="day-list">'
      + on.map(rowHtml).join('') + '</div></div>';
  }

  function renderYear() {
    var year = state.cursor.getFullYear();
    var pool = visible();
    var today = todayYmd();
    var out = '';
    for (var m = 0; m < 12; m++) {
      var first = new Date(year, m, 1);
      var start = addDays(first, -first.getDay());
      var count = 0;
      var days = DOW.map(function (d) { return '<div class="yr-dow">' + d[0] + '</div>'; }).join('');
      for (var i = 0; i < 42; i++) {
        var day = addDays(start, i);
        if (i >= 35 && day.getMonth() !== m) continue;
        var ds = ymd(day);
        var outside = day.getMonth() !== m;
        var on = outside ? [] : itemsOn(ds, pool);
        if (!outside) count += on.length;
        var seen = {}, dots = '';
        on.forEach(function (it) {
          var col = colorFor(it);
          if (seen[col]) return;
          seen[col] = 1;
          if (Object.keys(seen).length <= 4) dots += '<i style="background:' + col + '"></i>';
        });
        days += '<div class="yr-day' + (outside ? ' out' : '') + (ds === today ? ' today' : '')
          + '" data-day="' + ds + '">' + (outside ? '' : day.getDate())
          + '<span class="yr-dots">' + dots + '</span></div>';
      }
      out += '<div class="yr-mo"><h4 data-month="' + m + '">' + MONTHS[m]
        + '<span class="c">' + (count || '') + '</span></h4>'
        + '<div class="yr-days">' + days + '</div></div>';
    }
    return '<div class="yr-grid">' + out + '</div>';
  }

  function renderAgenda() {
    var from = ymd(state.cursor);
    var to = ymd(addMonths(state.cursor, 6));
    var pool = visible().filter(function (it) { return it.end_date >= from && it.start_date <= to; });
    if (!pool.length) {
      return '<div class="cal-empty"><strong>Nothing coming up</strong>'
        + 'No items in the next six months match the current filters.</div>';
    }
    // Group by the day each item starts, but surface anything already running.
    var byDay = {};
    pool.forEach(function (it) {
      var key = it.start_date < from ? from : it.start_date;
      (byDay[key] = byDay[key] || []).push(it);
    });
    var today = todayYmd();
    var rows = Object.keys(byDay).sort().map(function (ds) {
      var d = fromYmd(ds);
      var items = byDay[ds].sort(function (a, b) {
        if (a.all_day !== b.all_day) return b.all_day - a.all_day;
        return (a.start_time || '').localeCompare(b.start_time || '');
      });
      return '<div class="ag-day"><div class="ag-date' + (ds === today ? ' is-today' : '') + '">'
        + '<span class="d">' + d.getDate() + '</span>'
        + DOW[d.getDay()] + ' · ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear()
        + '</div><div class="ag-items">'
        + items.map(rowHtml).join('')
        + '</div></div>';
    }).join('');
    return '<div class="ag-wrap">' + rows + '</div>';
  }

  function render() {
    $('#period').textContent = periodLabel();
    Array.prototype.forEach.call($('#views').children, function (b) {
      b.setAttribute('aria-pressed', b.dataset.view === state.view ? 'true' : 'false');
    });
    var html = state.view === 'day' ? renderDay()
      : state.view === 'year' ? renderYear()
      : state.view === 'agenda' ? renderAgenda()
      : renderMonth();
    $('#view').innerHTML = html;
  }

  function renderAll() { renderFilters(); render(); }

  // ── modal ──────────────────────────────────────────────────────────────

  function openModal(title, body, foot) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalFoot').innerHTML = foot || '';
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }

  function whenText(it) {
    var s = fromYmd(it.start_date);
    var e = fromYmd(it.end_date);
    var one = it.start_date === it.end_date;
    var fmt = function (d) { return DOW_LONG[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); };
    if (one) {
      return fmt(s) + (it.all_day ? '' : ' · ' + hhmm(it.start_time)
        + (it.end_time ? '–' + hhmm(it.end_time) : ''));
    }
    var days = Math.round((e - s) / 86400000) + 1;
    return fmt(s) + ' – ' + fmt(e) + ' · ' + days + ' days';
  }

  function showDetail(id) {
    var it = state.items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    var c = catOf(it.category);
    var d = divOf(it.division);
    var rows = '';
    var add = function (k, v) { if (v) rows += '<dt>' + k + '</dt><dd>' + v + '</dd>'; };
    add('Type', esc(it.type || ''));
    add('Division', d ? esc(d.label) : '');
    add('Location', esc(it.location || ''));
    add('Owner', esc(it.owner || ''));
    if (it.status !== 'Confirmed') add('Status', esc(it.status));
    add('Link', it.url ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(it.url) + '</a>' : '');
    add('Notes', it.notes ? '<span class="det-notes">' + esc(it.notes) + '</span>' : '');

    var stamp = '';
    if (it.created_by) stamp += 'Added by ' + esc(it.created_by) + (it.created_at ? ' on ' + esc(it.created_at.slice(0, 10)) : '');
    if (it.updated_at && it.updated_at !== it.created_at) {
      stamp += '<br>Last edited by ' + esc(it.updated_by || '') + ' on ' + esc(it.updated_at.slice(0, 10));
    }

    var body = '<div class="det-cat" style="--chip:' + colorFor(it) + '"><i></i>'
      + esc(c ? c.label : it.category) + '</div>'
      + '<h3 class="det-title">' + esc(it.title) + '</h3>'
      + '<div class="det-when">' + esc(whenText(it)) + '</div>'
      + (rows ? '<dl class="det-grid">' + rows + '</dl>' : '')
      + (stamp ? '<div class="det-stamp">' + stamp + '</div>' : '');

    var foot = state.me.canEdit
      ? '<button class="cal-btn danger" data-act="delete" data-id="' + esc(it.id) + '">Delete</button>'
        + '<div class="grow"></div>'
        + '<button class="cal-btn" data-act="close">Close</button>'
        + '<button class="cal-btn primary" data-act="edit" data-id="' + esc(it.id) + '">Edit</button>'
      : '<div class="grow"></div><button class="cal-btn" data-act="close">Close</button>';

    openModal('Calendar item', body, foot);
  }

  function typeOptions(catKey, selected) {
    var c = catOf(catKey);
    if (!c) return '<option value="">—</option>';
    return '<option value="">— none —</option>' + c.types.map(function (t) {
      return '<option value="' + esc(t) + '"' + (t === selected ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
  }

  function showForm(existing, defaultDate) {
    var it = existing || {
      title: '', category: state.tax.categories[0].key, type: '', division: '',
      start_date: defaultDate || todayYmd(), end_date: defaultDate || todayYmd(),
      all_day: 1, start_time: '', end_time: '', location: '', owner: '',
      status: 'Confirmed', notes: '', url: '',
    };
    var timed = !it.all_day;

    var body = ''
      + '<div class="form-err" id="formErr" hidden></div>'
      + '<div class="fld"><label for="f-title">Title</label>'
      + '<input type="text" id="f-title" value="' + esc(it.title) + '" maxlength="200" placeholder="What is it?"></div>'

      + '<div class="fld-row">'
      + '<div class="fld"><label for="f-cat">Category</label><select id="f-cat">'
      + state.tax.categories.map(function (c) {
          return '<option value="' + esc(c.key) + '"' + (c.key === it.category ? ' selected' : '') + '>' + esc(c.label) + '</option>';
        }).join('')
      + '</select></div>'
      + '<div class="fld"><label for="f-type">Type</label><select id="f-type">'
      + typeOptions(it.category, it.type) + '</select></div>'
      + '</div>'

      + '<div class="fld-row">'
      + '<div class="fld"><label for="f-div">Division</label><select id="f-div">'
      + '<option value="">— none —</option>'
      + state.tax.divisions.map(function (d) {
          return '<option value="' + esc(d.key) + '"' + (d.key === it.division ? ' selected' : '') + '>' + esc(d.label) + '</option>';
        }).join('')
      + '</select></div>'
      + '<div class="fld"><label for="f-status">Status</label><select id="f-status">'
      + state.tax.statuses.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === it.status ? ' selected' : '') + '>' + esc(s) + '</option>';
        }).join('')
      + '</select></div>'
      + '</div>'

      + '<div class="fld-row">'
      + '<div class="fld"><label for="f-start">Starts</label><input type="date" id="f-start" value="' + esc(it.start_date) + '"></div>'
      + '<div class="fld"><label for="f-end">Ends</label><input type="date" id="f-end" value="' + esc(it.end_date) + '">'
      + '<div class="hint">Same as the start date for a one-day item.</div></div>'
      + '</div>'

      + '<div class="fld"><label class="fld-inline"><input type="checkbox" id="f-allday"'
      + (timed ? '' : ' checked') + '> All day</label></div>'

      + '<div class="fld-row" id="timeRow"' + (timed ? '' : ' hidden') + '>'
      + '<div class="fld"><label for="f-stime">Start time</label><input type="time" id="f-stime" value="' + esc(it.start_time || '') + '"></div>'
      + '<div class="fld"><label for="f-etime">End time</label><input type="time" id="f-etime" value="' + esc(it.end_time || '') + '"></div>'
      + '</div>'

      + '<div class="fld-row">'
      + '<div class="fld"><label for="f-loc">Location</label><input type="text" id="f-loc" value="' + esc(it.location || '') + '" maxlength="200"></div>'
      + '<div class="fld"><label for="f-owner">Owner</label><input type="text" id="f-owner" value="' + esc(it.owner || '') + '" maxlength="120" placeholder="Person or department"></div>'
      + '</div>'

      + '<div class="fld"><label for="f-url">Link</label><input type="url" id="f-url" value="' + esc(it.url || '') + '" placeholder="https://"></div>'
      + '<div class="fld"><label for="f-notes">Notes</label><textarea id="f-notes" maxlength="4000">' + esc(it.notes || '') + '</textarea></div>';

    var foot = '<div class="grow"></div>'
      + '<button class="cal-btn" data-act="close">Cancel</button>'
      + '<button class="cal-btn primary" data-act="save"' + (existing ? ' data-id="' + esc(existing.id) + '"' : '') + '>'
      + (existing ? 'Save changes' : 'Add to calendar') + '</button>';

    openModal(existing ? 'Edit item' : 'Add calendar item', body, foot);

    $('#f-cat').addEventListener('change', function () {
      $('#f-type').innerHTML = typeOptions(this.value, '');
    });
    $('#f-allday').addEventListener('change', function () {
      $('#timeRow').hidden = this.checked;
    });
    // Move the end date with the start date, keeping whatever span was already
    // set. Without this, picking a start date and leaving the end date on its
    // default silently produces a multi-day item -- and nothing on the form
    // says so, because the end field looks untouched.
    var lastStart = it.start_date;
    $('#f-start').addEventListener('change', function () {
      var end = $('#f-end');
      if (this.value && lastStart && end.value) {
        var span = Math.round((fromYmd(end.value) - fromYmd(lastStart)) / 86400000);
        if (span >= 0) end.value = ymd(addDays(fromYmd(this.value), span));
      }
      if (end.value < this.value) end.value = this.value;
      lastStart = this.value;
    });
    $('#f-title').focus();
  }

  function readForm() {
    var allDay = $('#f-allday').checked;
    return {
      title: $('#f-title').value,
      category: $('#f-cat').value,
      type: $('#f-type').value,
      division: $('#f-div').value,
      status: $('#f-status').value,
      start_date: $('#f-start').value,
      end_date: $('#f-end').value || $('#f-start').value,
      all_day: allDay ? 1 : 0,
      start_time: allDay ? '' : $('#f-stime').value,
      end_time: allDay ? '' : $('#f-etime').value,
      location: $('#f-loc').value,
      owner: $('#f-owner').value,
      url: $('#f-url').value,
      notes: $('#f-notes').value,
    };
  }

  function formError(msg, list) {
    var box = $('#formErr');
    if (!box) { alert(msg); return; }
    box.innerHTML = esc(msg)
      + (list && list.length ? '<ul>' + list.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '');
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
  }

  function showImport() {
    var body = '<div class="form-err" id="formErr" hidden></div>'
      + '<p style="font-family:var(--body);font-size:14px;line-height:1.6;margin:0 0 14px">'
      + 'Paste rows straight out of a spreadsheet, saved as CSV. The first row must be the '
      + 'column headers. Everything is checked before anything is written &mdash; if one row is '
      + 'wrong, nothing is imported.</p>'
      + '<div class="fld"><label>Recognised columns</label>'
      + '<div class="sub-url">title, category, type, division, start date, end date, all day, '
      + 'start time, end time, location, owner, status, notes, url</div>'
      + '<div class="hint">Only <strong>title</strong>, <strong>category</strong> and '
      + '<strong>start date</strong> are required. Dates are YYYY-MM-DD, times are HH:MM. '
      + 'Category accepts either the label or the key &mdash; "Events" and "events" both work.</div></div>'
      + '<div class="fld"><label for="f-csv">CSV</label>'
      + '<textarea id="f-csv" style="min-height:190px;font-family:var(--mono);font-size:12px" '
      + 'placeholder="title,category,type,division,start date,end date&#10;'
      + 'Rocking the Docks,events,Box Truck,brand,2026-09-12,2026-09-13"></textarea></div>';
    var foot = '<div class="grow"></div>'
      + '<button class="cal-btn" data-act="close">Cancel</button>'
      + '<button class="cal-btn primary" data-act="import">Import</button>';
    openModal('Import calendar items', body, foot);
    $('#f-csv').focus();
  }

  function showSubscribe() {
    var url = state.me.feedUrl || '';
    var body;
    if (!url) {
      body = '<p style="font-family:var(--body);font-size:14.5px;line-height:1.7;margin:0">'
        + 'The calendar feed is not switched on yet. Set the <code>ICS_KEY</code> secret on the '
        + 'Worker and add a Cloudflare Access bypass policy for <code>/calendar.ics</code>, and '
        + 'this panel will hand out a subscribe link.</p>';
    } else {
      body = '<p style="font-family:var(--body);font-size:14.5px;line-height:1.7;margin:0 0 4px">'
        + 'Add this calendar to Google Calendar and it shows up alongside your own. '
        + 'Google refreshes subscribed calendars on its own schedule, so a new item can take '
        + 'a few hours to appear there &mdash; this page is always current.</p>'
        + '<div class="sub-url" id="feedUrl">' + esc(url) + '</div>'
        + '<ol class="sub-steps">'
        + '<li>Copy the link above.</li>'
        + '<li>In Google Calendar, open <strong>Other calendars</strong> &rarr; '
        + '<strong>+</strong> &rarr; <strong>From URL</strong>.</li>'
        + '<li>Paste the link and choose <strong>Add calendar</strong>.</li>'
        + '</ol>'
        + '<p class="hint">Treat the link like a password &mdash; anyone who has it can read the '
        + 'calendar without signing in.</p>';
    }
    var foot = '<div class="grow"></div>'
      + (url ? '<button class="cal-btn" data-act="copy">Copy link</button>' : '')
      + '<button class="cal-btn primary" data-act="close">Done</button>';
    openModal('Subscribe in Google Calendar', body, foot);
  }

  // ── API ────────────────────────────────────────────────────────────────

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) {
            var err = new Error(body.error || ('Request failed (' + res.status + ')'));
            err.problems = body.problems;
            throw err;
          }
          return body;
        });
      });
  }

  function loadItems() {
    return api('/api/items').then(function (r) {
      state.items = r.items || [];
      renderAll();
    });
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  function shift(dir) {
    var c = state.cursor;
    if (state.view === 'day') state.cursor = addDays(c, dir);
    else if (state.view === 'year') state.cursor = new Date(c.getFullYear() + dir, c.getMonth(), 1);
    else if (state.view === 'agenda') state.cursor = addMonths(c, dir);
    else state.cursor = addMonths(c, dir);
    render();
  }

  function setView(v) { state.view = v; render(); }

  function wire() {
    $('#prev').addEventListener('click', function () { shift(-1); });
    $('#next').addEventListener('click', function () { shift(1); });
    $('#today').addEventListener('click', function () { state.cursor = new Date(); render(); });
    $('#views').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (b) setView(b.dataset.view);
    });
    $('#colorBy').addEventListener('change', function () { state.colorBy = this.value; render(); });
    $('#subscribe').addEventListener('click', showSubscribe);
    $('#addBtn').addEventListener('click', function () {
      showForm(null, state.view === 'day' ? ymd(state.cursor) : null);
    });
    $('#importBtn').addEventListener('click', showImport);

    // Filters
    document.querySelector('.cal-side').addEventListener('change', function (e) {
      var el = e.target;
      if (el.dataset.type) {
        state.cats[el.dataset.cat].types[el.dataset.type] = el.checked;
      } else if (el.dataset.cat) {
        state.cats[el.dataset.cat].on = el.checked;
      } else if (el.dataset.div) {
        state.divs[el.dataset.div] = el.checked;
      } else if (el.dataset.stat) {
        state.stats[el.dataset.stat] = el.checked;
      } else return;
      render();
    });
    document.querySelector('.cal-side').addEventListener('click', function (e) {
      var t = e.target.closest('.flt-toggle');
      if (t) {
        var panel = document.getElementById('types-' + t.dataset.expand);
        var open = panel.classList.toggle('open');
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    });
    $('#catAll').addEventListener('click', function () {
      Object.keys(state.cats).forEach(function (k) {
        state.cats[k].on = true;
        Object.keys(state.cats[k].types).forEach(function (t) { state.cats[k].types[t] = true; });
      });
      renderAll();
    });
    $('#catNone').addEventListener('click', function () {
      Object.keys(state.cats).forEach(function (k) { state.cats[k].on = false; });
      renderAll();
    });

    // Clicks inside the calendar surface
    $('#view').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-id]');
      if (chip) { showDetail(chip.dataset.id); return; }
      var more = e.target.closest('.mo-more');
      if (more) { state.cursor = fromYmd(more.dataset.day); setView('day'); return; }
      var mo = e.target.closest('h4[data-month]');
      if (mo) {
        state.cursor = new Date(state.cursor.getFullYear(), Number(mo.dataset.month), 1);
        setView('month');
        return;
      }
      var cell = e.target.closest('[data-day]');
      if (cell) {
        if (state.view === 'year') { state.cursor = fromYmd(cell.dataset.day); setView('day'); return; }
        if (state.me.canEdit && state.view === 'month') { showForm(null, cell.dataset.day); return; }
        state.cursor = fromYmd(cell.dataset.day);
        setView('day');
      }
    });

    // Modal actions
    $('#modalX').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    $('#modalFoot').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.dataset.act;

      if (act === 'close') return closeModal();

      if (act === 'copy') {
        var url = state.me.feedUrl || '';
        navigator.clipboard.writeText(url).then(function () {
          b.textContent = 'Copied';
          setTimeout(function () { b.textContent = 'Copy link'; }, 1600);
        });
        return;
      }

      if (act === 'edit') {
        var it = state.items.filter(function (x) { return x.id === b.dataset.id; })[0];
        if (it) showForm(it);
        return;
      }

      if (act === 'delete') {
        var target = state.items.filter(function (x) { return x.id === b.dataset.id; })[0];
        if (!target) return;
        if (!confirm('Delete "' + target.title + '"? This cannot be undone.')) return;
        b.disabled = true;
        api('/api/items/' + b.dataset.id, { method: 'DELETE' })
          .then(function () { closeModal(); return loadItems(); })
          .catch(function (err) { b.disabled = false; alert(err.message); });
        return;
      }

      if (act === 'save') {
        var payload = readForm();
        b.disabled = true;
        var id = b.dataset.id;
        api(id ? '/api/items/' + id : '/api/items', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        }).then(function () {
          closeModal();
          return loadItems();
        }).catch(function (err) {
          b.disabled = false;
          formError(err.message, err.problems);
        });
        return;
      }

      if (act === 'import') {
        var csv = $('#f-csv').value.trim();
        if (!csv) return formError('Paste some rows first.');
        b.disabled = true;
        api('/api/items/import', { method: 'POST', body: JSON.stringify({ csv: csv }) })
          .then(function (r) {
            closeModal();
            return loadItems().then(function () {
              alert('Imported ' + r.imported + (r.imported === 1 ? ' item.' : ' items.'));
            });
          })
          .catch(function (err) { b.disabled = false; formError(err.message, err.problems); });
      }
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────

  function initFilters() {
    state.tax.categories.forEach(function (c) {
      var types = {};
      c.types.forEach(function (t) { types[t] = true; });
      state.cats[c.key] = { on: true, types: types };
    });
    state.tax.divisions.forEach(function (d) { state.divs[d.key] = true; });
    state.divs[UNASSIGNED] = true;
  }

  Promise.all([api('/api/taxonomy'), api('/api/me').catch(function () { return {}; })])
    .then(function (r) {
      state.tax = r[0];
      state.me = r[1] || {};
      initFilters();
      renderWho();
      renderNotice();
      if (state.me.canEdit) {
        $('#addBtn').hidden = false;
        $('#importBtn').hidden = false;
      }
      wire();
      return loadItems();
    })
    .catch(function (err) {
      $('#view').innerHTML = '<div class="cal-empty"><strong>The calendar could not load</strong>'
        + esc(err.message) + '</div>';
    });
})();
