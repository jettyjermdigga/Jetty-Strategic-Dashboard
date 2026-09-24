/* Jetty Company Calendar.
 *
 * The whole item list is fetched once and filtered in the browser. A company
 * calendar is a few thousand rows at most, so paging it per view would buy
 * nothing and would make switching between week and year feel slow. The API
 * takes from/to and week/year if that ever stops being true.
 */
(function () {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var NONE = '\u2014none\u2014';

  // A month grid is unreadable at phone width -- there is no room for titles.
  // Agenda shows the same information in a form that survives the narrow column.
  var NARROW = window.matchMedia('(max-width: 820px)').matches;

  var state = {
    view: NARROW ? 'agenda' : 'month',
    cursor: new Date(),
    items: [],
    tax: null,
    me: { canEdit: false, email: '' },
    colorBy: 'event-type',
    types: {},   // Event Type key -> shown
    subs: {},    // sub-type key   -> shown
    needs: {},   // need key       -> shown
    stats: {},   // status         -> shown
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

  // ── retail calendar (mirrors worker/retail.js) ─────────────────────────

  var DAY_MS = 86400000;
  function retailWeek(dateStr) {
    if (!state.tax || !dateStr) return null;
    var base = fromYmd(state.tax.retailEpoch);
    var idx = Math.floor((fromYmd(dateStr) - base) / (7 * DAY_MS));
    var yearOffset = Math.floor(idx / 52);
    var start = addDays(base, idx * 7);
    return {
      year: state.tax.retailEpochYear + yearOffset,
      week: idx - yearOffset * 52 + 1,
      start: ymd(start),
      end: ymd(addDays(start, 6)),
    };
  }
  function retailWeekStart(year, week) {
    if (!state.tax) return null;
    var idx = (Number(year) - state.tax.retailEpochYear) * 52 + (Number(week) - 1);
    return addDays(fromYmd(state.tax.retailEpoch), idx * 7);
  }
  function weekRangeLabel(r) {
    var s = fromYmd(r.start), e = fromYmd(r.end);
    return MONTHS[s.getMonth()].slice(0, 3) + ' ' + s.getDate() + ' – '
      + MONTHS[e.getMonth()].slice(0, 3) + ' ' + e.getDate();
  }

  // ── taxonomy lookups ───────────────────────────────────────────────────

  function find(list, key) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].key === key) return list[i];
    return null;
  }
  function typeOf(k) { return find(state.tax && state.tax.eventTypes, k); }
  function subOf(k)  { return find(state.tax && state.tax.subTypes, k); }
  function needOf(k) { return find(state.tax && state.tax.needs, k); }

  function listOf(item, field) {
    return item[field] ? item[field].split(',').filter(Boolean) : [];
  }
  function typesOf(item) { return listOf(item, 'event_types'); }
  function subsOf(item)  { return listOf(item, 'sub_types'); }
  function needsOf(item) { return listOf(item, 'needs'); }

  function labelIn(list, key) { var x = find(list, key); return x ? x.label : key; }
  function typeLabel(k) { return labelIn(state.tax && state.tax.eventTypes, k); }
  function typeSummary(item) { return typesOf(item).map(typeLabel).join(' + '); }

  // Colours live in CSS custom properties so the light and dark steps swap in
  // one place rather than being recomputed per chip. The palette is validated
  // in both modes -- see worker/taxonomy.js.
  function injectPalette() {
    var light = [];
    var dark = [];
    state.tax.eventTypes.forEach(function (e) {
      light.push('--et-' + e.key + ':' + e.color + ';');
      dark.push('--et-' + e.key + ':' + (e.colorDark || e.color) + ';');
    });
    light.push('--st-booked:#2F7A5C;--st-pending:#C6803B;');
    dark.push('--st-booked:#3d9670;--st-pending:#d9a05a;');
    var el = document.createElement('style');
    el.textContent = ':root{' + light.join('') + '}'
      + '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){' + dark.join('') + '}}'
      + ':root[data-theme="dark"]{' + dark.join('') + '}';
    document.head.appendChild(el);
  }

  function typeVar(key) { return 'var(--et-' + key + ', #8A8F98)'; }

  // One colour band per Event Type, so an event that is both a JRF event and a
  // Box Truck event says so rather than being forced into one of them.
  function bandColors(item) {
    if (state.colorBy === 'status') {
      return ['var(--st-' + (item.status === 'Booked' ? 'booked' : 'pending') + ')'];
    }
    var cols = typesOf(item).map(typeVar);
    return cols.length ? cols : ['#8A8F98'];
  }

  function bandHtml(item) {
    return '<span class="bar">' + bandColors(item).map(function (c) {
      return '<i style="background:' + c + '"></i>';
    }).join('') + '</span>';
  }

  function colorFor(item) { return bandColors(item)[0]; }

  // ── filtering ──────────────────────────────────────────────────────────

  // Each axis narrows independently. An item passes an axis when any of its
  // values on that axis is still shown -- or when it has none and the axis's
  // "not set" row is still shown, so an item without sub-types is not quietly
  // filtered out by a section that has nothing to do with it.
  function passesAxis(values, shown) {
    if (!values.length) return shown[NONE] !== false;
    return values.some(function (k) { return shown[k] !== false; });
  }

  function passes(item) {
    if (state.stats[item.status] === false) return false;
    return passesAxis(typesOf(item), state.types)
      && passesAxis(subsOf(item), state.subs)
      && passesAxis(needsOf(item), state.needs);
  }

  function visible() { return state.items.filter(passes); }

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
    if (state.view === 'day') {
      var r = retailWeek(ymd(c));
      return DOW_LONG[c.getDay()] + ', ' + MONTHS[c.getMonth()] + ' ' + c.getDate()
        + (r ? '  ·  Wk ' + r.week : '');
    }
    if (state.view === 'week') {
      var w = retailWeek(ymd(c));
      return w ? 'Week ' + w.week + '  ·  ' + weekRangeLabel(w) : '';
    }
    if (state.view === 'year') return String(c.getFullYear());
    if (state.view === 'agenda') return 'Next 6 months';
    return MONTHS[c.getMonth()] + ' ' + c.getFullYear();
  }

  // ── filter sidebar ─────────────────────────────────────────────────────

  function counts() {
    var by = { types: {}, subs: {}, needs: {}, stats: {} };
    var tally = function (bucket, values) {
      if (!values.length) { bucket[NONE] = (bucket[NONE] || 0) + 1; return; }
      values.forEach(function (k) { bucket[k] = (bucket[k] || 0) + 1; });
    };
    state.items.forEach(function (it) {
      by.stats[it.status] = (by.stats[it.status] || 0) + 1;
      tally(by.types, typesOf(it));
      tally(by.subs, subsOf(it));
      tally(by.needs, needsOf(it));
    });
    return by;
  }

  function checkRow(axis, key, label, color, count, shown, title) {
    return '<label class="flt-row"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<input type="checkbox" data-axis="' + axis + '" value="' + esc(key) + '"'
      + (shown === false ? '' : ' checked') + '>'
      + (color ? '<i class="dot" style="background:' + color + '"></i>' : '')
      + '<span>' + esc(label) + '</span>'
      + (count == null ? '' : '<span class="count">' + count + '</span>') + '</label>';
  }

  function renderFilters() {
    if (!state.tax) return;
    var n = counts();

    $('#typeTree').innerHTML = state.tax.eventTypes.map(function (e) {
      return checkRow('types', e.key, e.label, typeVar(e.key),
                      n.types[e.key] || 0, state.types[e.key], e.note);
    }).join('');

    // Sub-types are grouped under the Event Type they belong to, since that is
    // the only place they mean anything.
    var groups = [];
    state.tax.eventTypes.forEach(function (e) {
      var kids = state.tax.subTypes.filter(function (st) { return st.parent === e.key; });
      if (!kids.length) return;
      groups.push('<div class="flt-sub"><h4>' + esc(e.label) + '</h4>'
        + kids.map(function (st) {
            return checkRow('subs', st.key, st.label, null,
                            n.subs[st.key] || 0, state.subs[st.key], st.note);
          }).join('')
        + '</div>');
    });
    if (n.subs[NONE]) {
      groups.push(checkRow('subs', NONE, 'No sub-type', null, n.subs[NONE], state.subs[NONE]));
    }
    $('#subTree').innerHTML = groups.join('');

    var needRows = state.tax.needs.map(function (nd) {
      return checkRow('needs', nd.key, nd.label, null,
                      n.needs[nd.key] || 0, state.needs[nd.key], nd.note);
    });
    if (n.needs[NONE]) {
      needRows.push(checkRow('needs', NONE, 'Nothing needed', null,
                             n.needs[NONE], state.needs[NONE]));
    }
    $('#needTree').innerHTML = needRows.join('');

    $('#statTree').innerHTML = state.tax.statuses.map(function (st) {
      return checkRow('stats', st, st,
                      'var(--st-' + (st === 'Booked' ? 'booked' : 'pending') + ')',
                      n.stats[st] || 0, state.stats[st]);
    }).join('');
  }

  // ── views ──────────────────────────────────────────────────────────────

  // With colour reserved for the calendar, these dots are the only at-a-glance
  // sign that an event also involves another department. The event's own
  // calendar department is left off -- on a box truck calendar every event is
  // Box Truck, and a dot on all 112 says nothing.
  function chipHtml(it, dateStr) {
    var cls = 'chip' + (it.status === 'Pending' ? ' pending' : '');
    var cont = it.start_date < dateStr ? '→ ' : '';
    var time = (!it.all_day && it.start_time && it.start_date === dateStr)
      ? '<span class="t">' + esc(hhmm(it.start_time)) + '</span>' : '';
    var tip = it.title + ' — ' + (typeSummary(it) || 'no Event Type')
      + ' · ' + it.status + (it.venue ? ' · ' + it.venue : '');
    return '<div class="' + cls + '" style="--chip:' + colorFor(it) + '" data-id="' + esc(it.id) + '" '
      + 'title="' + esc(tip) + '">'
      + bandHtml(it) + time + '<span class="n">' + esc(cont + it.title) + '</span></div>';
  }

  function placeLabel(it) {
    var cityState = [it.city, it.state].filter(Boolean).join(', ');
    return [it.venue, cityState].filter(Boolean).join(' · ');
  }

  function spanLabel(it) {
    var s = fromYmd(it.start_date), e = fromYmd(it.end_date);
    var days = Math.round((e - s) / DAY_MS) + 1;
    return MONTHS[s.getMonth()].slice(0, 3) + ' ' + s.getDate() + ' – '
      + MONTHS[e.getMonth()].slice(0, 3) + ' ' + e.getDate() + ' (' + days + ' days)';
  }

  // One row renderer for the day, week and agenda views.
  function rowHtml(it) {
    var when = it.all_day ? 'All day'
      : hhmm(it.start_time) + (it.end_time ? '–' + hhmm(it.end_time) : '');
    var meta = [];
    var dl = typeSummary(it);
    if (dl) meta.push(dl);
    var subs = subsOf(it).map(function (k) { return labelIn(state.tax.subTypes, k); });
    if (subs.length) meta.push(subs.join(', '));
    if (it.status !== 'Booked') meta.push(it.status);
    if (it.start_date !== it.end_date) meta.push(spanLabel(it));
    var where = placeLabel(it);
    if (where) meta.push(where);
    var nd = needsOf(it).map(function (k) { return labelIn(state.tax.needs, k); });
    if (nd.length) meta.push('Needs: ' + nd.join(', '));
    return '<div class="day-item" style="--chip:' + colorFor(it) + '" data-id="' + esc(it.id) + '">'
      + bandHtml(it)
      + '<div class="day-when">' + esc(when) + '</div>'
      + '<div><div class="day-title">' + esc(it.title) + '</div>'
      + '<div class="day-meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('')
      + '</div></div></div>';
  }

  function emptyHtml(head, body) {
    return '<div class="cal-empty"><strong>' + head + '</strong>' + body + '</div>';
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

  function renderDay() {
    var ds = ymd(state.cursor);
    var on = itemsOn(ds);
    if (!on.length) {
      return emptyHtml('Nothing scheduled', 'No calendar items on this day match the current filters.');
    }
    return '<div class="day-wrap"><div class="day-sub">' + on.length
      + (on.length === 1 ? ' item' : ' items') + '</div><div class="day-list">'
      + on.map(rowHtml).join('') + '</div></div>';
  }

  // Retail weeks run Sunday to Saturday and are how the business plans, so they
  // get a view of their own rather than only a label.
  function renderWeek() {
    var r = retailWeek(ymd(state.cursor));
    if (!r) return emptyHtml('No week', '');
    var pool = visible();
    var today = todayYmd();
    var total = 0;
    var days = '';
    for (var i = 0; i < 7; i++) {
      var day = addDays(fromYmd(r.start), i);
      var ds = ymd(day);
      var on = itemsOn(ds, pool);
      total += on.length;
      days += '<div class="wk-day' + (ds === today ? ' is-today' : '') + '">'
        + '<div class="wk-date" data-day="' + ds + '"><span class="d">' + day.getDate() + '</span>'
        + DOW[day.getDay()] + ' · ' + MONTHS[day.getMonth()].slice(0, 3) + '</div>'
        + '<div class="wk-items">'
        + (on.length ? on.map(rowHtml).join('')
                     : '<div class="wk-none">—</div>')
        + '</div></div>';
    }
    return '<div class="wk-wrap"><div class="day-sub">Retail week ' + r.week + ' of ' + r.year
      + ' · ' + weekRangeLabel(r) + ' · ' + total
      + (total === 1 ? ' item' : ' items') + '</div>' + days + '</div>';
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
      return emptyHtml('Nothing coming up', 'No items in the next six months match the current filters.');
    }
    var byDay = {};
    pool.forEach(function (it) {
      var key = it.start_date < from ? from : it.start_date;
      (byDay[key] = byDay[key] || []).push(it);
    });
    var today = todayYmd();
    return '<div class="ag-wrap">' + Object.keys(byDay).sort().map(function (ds) {
      var d = fromYmd(ds);
      var r = retailWeek(ds);
      var items = byDay[ds].sort(function (a, b) {
        if (a.all_day !== b.all_day) return b.all_day - a.all_day;
        return (a.start_time || '').localeCompare(b.start_time || '');
      });
      return '<div class="ag-day"><div class="ag-date' + (ds === today ? ' is-today' : '') + '">'
        + '<span class="d">' + d.getDate() + '</span>'
        + DOW[d.getDay()] + ' · ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear()
        + (r ? '<span class="wk">Wk ' + r.week + '</span>' : '')
        + '</div><div class="ag-items">' + items.map(rowHtml).join('') + '</div></div>';
    }).join('') + '</div>';
  }

  function render() {
    $('#period').textContent = periodLabel();
    Array.prototype.forEach.call($('#views').children, function (b) {
      b.setAttribute('aria-pressed', b.dataset.view === state.view ? 'true' : 'false');
    });
    var r = retailWeek(ymd(state.cursor));
    if (r && $('#wkNum') !== document.activeElement) $('#wkNum').value = r.week;
    $('#view').innerHTML = state.view === 'day' ? renderDay()
      : state.view === 'week' ? renderWeek()
      : state.view === 'year' ? renderYear()
      : state.view === 'agenda' ? renderAgenda()
      : renderMonth();
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
    var s = fromYmd(it.start_date), e = fromYmd(it.end_date);
    var fmt = function (d) {
      return DOW_LONG[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    };
    var times = it.all_day ? '' : ' · ' + hhmm(it.start_time)
      + (it.end_time ? '–' + hhmm(it.end_time) : '');
    if (it.start_date === it.end_date) return fmt(s) + times;
    return fmt(s) + ' – ' + fmt(e) + ' · '
      + (Math.round((e - s) / DAY_MS) + 1) + ' days' + times;
  }

  function showDetail(id) {
    var it = state.items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    var r = it.retail || retailWeek(it.start_date);
    var rows = '';
    var add = function (k, v) { if (v) rows += '<dt>' + k + '</dt><dd>' + v + '</dd>'; };
    var chips = function (keys, list, colored) {
      return keys.map(function (k) {
        return '<span class="tag">'
          + (colored ? '<i style="background:' + typeVar(k) + '"></i>' : '')
          + esc(labelIn(list, k)) + '</span>';
      }).join(' ');
    };

    add('Event Type', chips(typesOf(it), state.tax.eventTypes, true));
    add('Sub-type', chips(subsOf(it), state.tax.subTypes, false));
    add('Status', '<span class="pill ' + (it.status === 'Booked' ? 'ok' : 'warn') + '">'
      + esc(it.status) + '</span>');
    if (r) add('Retail week', 'Week ' + r.week + ' of ' + r.year + ' <span class="muted">('
      + esc(weekRangeLabel(r)) + ')</span>');
    add('Needs', chips(needsOf(it), state.tax.needs, false));

    var addr = [it.address, [it.city, it.state].filter(Boolean).join(', '), it.zip]
      .filter(Boolean).join('<br>');
    add('Venue', esc(it.venue || ''));
    add('Address', addr);
    add('Link', it.url ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">'
      + esc(it.url) + '</a>' : '');
    add('Notes', it.notes ? '<span class="det-notes">' + esc(it.notes) + '</span>' : '');

    var stamp = '';
    if (it.created_by) stamp += 'Added by ' + esc(it.created_by)
      + (it.created_at ? ' on ' + esc(it.created_at.slice(0, 10)) : '');
    if (it.updated_at && it.updated_at !== it.created_at) {
      stamp += '<br>Last edited by ' + esc(it.updated_by || '') + ' on ' + esc(it.updated_at.slice(0, 10));
    }

    var body = '<div class="det-bands">' + bandHtml(it) + '</div>'
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

    openModal('Event', body, foot);
  }

  // ── add / edit form ────────────────────────────────────────────────────

  function showForm(existing, defaultDate) {
    var it = existing || {
      title: '', event_types: '', sub_types: '', needs: '',
      status: 'Pending', start_date: defaultDate || todayYmd(), end_date: defaultDate || todayYmd(),
      all_day: 1, start_time: '', end_time: '',
      venue: '', address: '', city: '', state: '', zip: '', notes: '', url: '',
    };
    var chosen = typesOf(it);
    var chosenSubs = subsOf(it);
    var chosenNeeds = needsOf(it);
    var timed = !it.all_day;

    var body = ''
      + '<div class="form-err" id="formErr" hidden></div>'
      + '<div class="fld"><label for="f-title">Event name</label>'
      + '<input type="text" id="f-title" value="' + esc(it.title) + '" maxlength="200"></div>'

      + '<div class="fld"><label>Event Type '
      + '<span class="lbl-note">everyone involved; the event shows on each of their calendars</span></label>'
      + '<div class="chk-grid">'
      + state.tax.eventTypes.map(function (e) {
          return '<label class="fld-inline"' + (e.note ? ' title="' + esc(e.note) + '"' : '') + '>'
            + '<input type="checkbox" class="f-type" value="' + esc(e.key) + '"'
            + (chosen.indexOf(e.key) >= 0 ? ' checked' : '') + '>'
            + '<i class="dot" style="background:' + typeVar(e.key) + '"></i>'
            + esc(e.label) + '</label>';
        }).join('')
      + '</div></div>'

      // Sub-types only exist under one Event Type, so each group appears only
      // once that Event Type is ticked.
      + '<div class="fld" id="subWrap"' + '><label>Sub-type</label>'
      + '<div id="subGrid"></div></div>'

      + '<div class="fld"><label>Needs '
      + '<span class="lbl-note">what this event requires</span></label>'
      + '<div class="chk-grid">'
      + state.tax.needs.map(function (nd) {
          return '<label class="fld-inline" title="' + esc(nd.note || '') + '">'
            + '<input type="checkbox" class="f-need" value="' + esc(nd.key) + '"'
            + (chosenNeeds.indexOf(nd.key) >= 0 ? ' checked' : '') + '>'
            + esc(nd.label) + '</label>';
        }).join('')
      + '</div></div>'

      + '<div class="fld"><label for="f-status">Status</label><select id="f-status">'
      + state.tax.statuses.map(function (st) {
          return '<option value="' + esc(st) + '"' + (st === it.status ? ' selected' : '') + '>'
            + esc(st) + '</option>';
        }).join('')
      + '</select></div>'

      + '<div class="fld-row">'
      + '<div class="fld"><label for="f-start">Starts</label>'
      + '<input type="date" id="f-start" value="' + esc(it.start_date) + '"></div>'
      + '<div class="fld"><label for="f-end">Ends</label>'
      + '<input type="date" id="f-end" value="' + esc(it.end_date) + '">'
      + '<div class="hint">Same as the start date for a one-day event.</div></div>'
      + '</div>'

      + '<div class="fld"><div class="retail-readout" id="retailOut"></div></div>'

      + '<div class="fld"><label class="fld-inline"><input type="checkbox" id="f-allday"'
      + (timed ? '' : ' checked') + '> All day</label></div>'

      + '<div class="fld-row" id="timeRow"' + (timed ? '' : ' hidden') + '>'
      + '<div class="fld"><label for="f-stime">Start time</label>'
      + '<input type="time" id="f-stime" value="' + esc(it.start_time || '') + '"></div>'
      + '<div class="fld"><label for="f-etime">End time</label>'
      + '<input type="time" id="f-etime" value="' + esc(it.end_time || '') + '"></div>'
      + '</div>'

      + '<div class="fld"><label for="f-venue">Venue</label>'
      + '<input type="text" id="f-venue" value="' + esc(it.venue || '') + '" maxlength="200"></div>'
      + '<div class="fld"><label for="f-address">Address</label>'
      + '<input type="text" id="f-address" value="' + esc(it.address || '') + '" maxlength="200"></div>'
      + '<div class="fld-row addr-row">'
      + '<div class="fld"><label for="f-city">City</label>'
      + '<input type="text" id="f-city" value="' + esc(it.city || '') + '" maxlength="120"></div>'
      + '<div class="fld"><label for="f-state">State</label>'
      + '<input type="text" id="f-state" value="' + esc(it.state || '') + '" maxlength="2" '
      + 'style="text-transform:uppercase"></div>'
      + '<div class="fld"><label for="f-zip">Zip</label>'
      + '<input type="text" id="f-zip" value="' + esc(it.zip || '') + '" maxlength="10" inputmode="numeric"></div>'
      + '</div>'

      + '<div class="fld"><label for="f-url">Link</label>'
      + '<input type="url" id="f-url" value="' + esc(it.url || '') + '" placeholder="https://"></div>'
      + '<div class="fld"><label for="f-notes">Notes</label>'
      + '<textarea id="f-notes" maxlength="4000">' + esc(it.notes || '') + '</textarea></div>';

    var foot = '<div class="grow"></div>'
      + '<button class="cal-btn" data-act="close">Cancel</button>'
      + '<button class="cal-btn primary" data-act="save"'
      + (existing ? ' data-id="' + esc(existing.id) + '"' : '') + '>'
      + (existing ? 'Save changes' : 'Add to calendar') + '</button>';

    openModal(existing ? 'Edit event' : 'Add event', body, foot);

    // Year / Week / Start (Week) / End (Week) / Month / Day are shown as they
    // will be derived, so you can see the retail week without typing it.
    function showRetail() {
      var v = $('#f-start').value;
      var r = v ? retailWeek(v) : null;
      var d = v ? fromYmd(v) : null;
      $('#retailOut').innerHTML = r
        ? '<span class="rl">Retail</span> Week ' + r.week + ' of ' + r.year
          + ' <span class="muted">(' + esc(weekRangeLabel(r)) + ')</span>'
          + ' · ' + MONTHS[d.getMonth()].slice(0, 3).toUpperCase()
          + ' · ' + DOW[d.getDay()].toUpperCase()
        : '<span class="muted">Pick a start date to see its retail week.</span>';
    }
    showRetail();

    $('#f-allday').addEventListener('change', function () { $('#timeRow').hidden = this.checked; });

    // Only offer the sub-types belonging to the Event Types actually ticked.
    function renderSubs() {
      var on = Array.prototype.map.call(
        document.querySelectorAll('.f-type:checked'), function (el) { return el.value; });
      var kept = Array.prototype.map.call(
        document.querySelectorAll('.f-sub:checked'), function (el) { return el.value; });
      var html = '';
      state.tax.eventTypes.forEach(function (e) {
        if (on.indexOf(e.key) < 0) return;
        var kids = state.tax.subTypes.filter(function (st) { return st.parent === e.key; });
        if (!kids.length) return;
        html += '<div class="chk-grid">' + kids.map(function (st) {
          var was = kept.indexOf(st.key) >= 0 || chosenSubs.indexOf(st.key) >= 0;
          return '<label class="fld-inline" title="' + esc(st.note || '') + '">'
            + '<input type="checkbox" class="f-sub" value="' + esc(st.key) + '"'
            + (was ? ' checked' : '') + '>' + esc(st.label) + '</label>';
        }).join('') + '</div>';
      });
      $('#subGrid').innerHTML = html;
      $('#subWrap').hidden = !html;
    }
    renderSubs();
    Array.prototype.forEach.call(document.querySelectorAll('.f-type'), function (el) {
      el.addEventListener('change', renderSubs);
    });

    // Year / Week / Start (Week) / End (Week) / Month / Day are shown as they
    // will be derived, so you can see the retail week without typing it.
    function showRetail() {
      var v = $('#f-start').value;
      var r = v ? retailWeek(v) : null;
      var d = v ? fromYmd(v) : null;
      $('#retailOut').innerHTML = r
        ? '<span class="rl">Retail</span> Week ' + r.week + ' of ' + r.year
          + ' <span class="muted">(' + esc(weekRangeLabel(r)) + ')</span>'
          + ' · ' + MONTHS[d.getMonth()].slice(0, 3).toUpperCase()
          + ' · ' + DOW[d.getDay()].toUpperCase()
        : '<span class="muted">Pick a start date to see its retail week.</span>';
    }
    showRetail();

    $('#f-allday').addEventListener('change', function () { $('#timeRow').hidden = this.checked; });

    // Only offer the sub-types belonging to the Event Types actually ticked.
    function renderSubs() {
      var on = Array.prototype.map.call(
        document.querySelectorAll('.f-type:checked'), function (el) { return el.value; });
      var kept = Array.prototype.map.call(
        document.querySelectorAll('.f-sub:checked'), function (el) { return el.value; });
      var html = '';
      state.tax.eventTypes.forEach(function (e) {
        if (on.indexOf(e.key) < 0) return;
        var kids = state.tax.subTypes.filter(function (st) { return st.parent === e.key; });
        if (!kids.length) return;
        html += '<div class="chk-grid">' + kids.map(function (st) {
          var was = kept.indexOf(st.key) >= 0 || chosenSubs.indexOf(st.key) >= 0;
          return '<label class="fld-inline" title="' + esc(st.note || '') + '">'
            + '<input type="checkbox" class="f-sub" value="' + esc(st.key) + '"'
            + (was ? ' checked' : '') + '>' + esc(st.label) + '</label>';
        }).join('') + '</div>';
      });
      $('#subGrid').innerHTML = html;
      $('#subWrap').hidden = !html;
    }
    renderSubs();
    Array.prototype.forEach.call(document.querySelectorAll('.f-type'), function (el) {
      el.addEventListener('change', renderSubs);
    });

    // Move the end date with the start date, keeping whatever span was already
    // set. Without this, picking a start date and leaving the end date on its
    // default silently produces a multi-day event.
    var lastStart = it.start_date;
    $('#f-start').addEventListener('change', function () {
      var end = $('#f-end');
      if (this.value && lastStart && end.value) {
        var span = Math.round((fromYmd(end.value) - fromYmd(lastStart)) / DAY_MS);
        if (span >= 0) end.value = ymd(addDays(fromYmd(this.value), span));
      }
      if (end.value < this.value) end.value = this.value;
      lastStart = this.value;
      showRetail();
    });
    $('#f-title').focus();
  }

  function readForm() {
    var allDay = $('#f-allday').checked;
    return {
      title: $('#f-title').value,
      status: $('#f-status').value,
      event_types: Array.prototype.map.call(
        document.querySelectorAll('.f-type:checked'), function (el) { return el.value; }),
      sub_types: Array.prototype.map.call(
        document.querySelectorAll('.f-sub:checked'), function (el) { return el.value; }),
      needs: Array.prototype.map.call(
        document.querySelectorAll('.f-need:checked'), function (el) { return el.value; }),
      start_date: $('#f-start').value,
      end_date: $('#f-end').value || $('#f-start').value,
      all_day: allDay ? 1 : 0,
      start_time: allDay ? '' : $('#f-stime').value,
      end_time: allDay ? '' : $('#f-etime').value,
      venue: $('#f-venue').value,
      address: $('#f-address').value,
      city: $('#f-city').value,
      state: $('#f-state').value,
      zip: $('#f-zip').value,
      url: $('#f-url').value,
      notes: $('#f-notes').value,
    };
  }

  function formError(msg, list) {
    var box = $('#formErr');
    if (!box) { alert(msg); return; }
    box.innerHTML = esc(msg)
      + (list && list.length
          ? '<ul>' + list.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>'
          : '');
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
  }

  function showImport() {
    var body = '<div class="form-err" id="formErr" hidden></div>'
      + '<p class="modal-lede">Paste rows straight out of the calendar spreadsheet, saved as CSV. '
      + 'The first row must be the column headers. Everything is checked before anything is '
      + 'written &mdash; if one row is wrong, nothing is imported.</p>'
      + '<div class="fld"><label>Columns it recognises</label>'
      + '<div class="sub-url">Name, Booked, Type, Event Type, Event \u{1F680}, Event \u{1F6D1}, '
      + 'Start ⌚, End ⌚, Venue, Address, City, State, Zip, Notes, URL</div>'
      + '<div class="hint">Only <strong>Name</strong>, <strong>Type</strong> and a '
      + '<strong>start date</strong> are required. Year, Week, Start (Week), End (Week), Month and '
      + 'Day are read if present and checked against the date, but not stored &mdash; the calendar '
      + 'works them out. Dates are YYYY-MM-DD, times are HH:MM on a 24-hour clock.</div></div>'
      + '<div class="fld"><label for="f-csv">CSV</label>'
      + '<textarea id="f-csv" style="min-height:190px;font-family:var(--mono);font-size:12px" '
      + 'placeholder="Name,Booked,Type,Event Type,Event \u{1F680},Start ⌚,End ⌚,Venue,City,State&#10;'
      + 'Rocking the Docks,checked,Event,Box Truck,2026-07-11,12:00,18:00,Dock Road,Beach Haven,NJ"></textarea></div>';
    var foot = '<div class="grow"></div>'
      + '<button class="cal-btn" data-act="close">Cancel</button>'
      + '<button class="cal-btn primary" data-act="import">Import</button>';
    openModal('Import events', body, foot);
    $('#f-csv').focus();
  }

  function showSubscribe() {
    var url = state.me.feedUrl || '';
    var body;
    if (!url) {
      body = '<p class="modal-lede">The calendar feed is not switched on yet. Set the '
        + '<code>ICS_KEY</code> secret on the Worker and add a Cloudflare Access bypass policy for '
        + '<code>/calendar.ics</code>, and this panel will hand out a subscribe link.</p>';
    } else {
      body = '<p class="modal-lede">Add this calendar to Google Calendar and it shows up alongside '
        + 'your own. Google refreshes subscribed calendars on its own schedule, so a new event can '
        + 'take a few hours to appear there &mdash; this page is always current.</p>'
        + '<div class="sub-url" id="feedUrl">' + esc(url) + '</div>'
        + '<ol class="sub-steps">'
        + '<li>Copy the link above.</li>'
        + '<li>In Google Calendar, open <strong>Other calendars</strong> &rarr; <strong>+</strong> '
        + '&rarr; <strong>From URL</strong>.</li>'
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
    else if (state.view === 'week') state.cursor = addDays(c, 7 * dir);
    else if (state.view === 'year') state.cursor = new Date(c.getFullYear() + dir, c.getMonth(), 1);
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
      showForm(null, (state.view === 'day' || state.view === 'week') ? ymd(state.cursor) : null);
    });
    $('#importBtn').addEventListener('click', showImport);

    // Jump straight to a retail week -- the number people actually quote.
    function jumpWeek() {
      var wk = Number($('#wkNum').value);
      if (!wk || wk < 1 || wk > 53) return;
      var cur = retailWeek(ymd(state.cursor));
      var d = retailWeekStart(cur ? cur.year : state.tax.retailEpochYear, wk);
      if (d) { state.cursor = d; setView('week'); }
    }
    $('#wkNum').addEventListener('change', jumpWeek);
    $('#wkNum').addEventListener('keydown', function (e) { if (e.key === 'Enter') jumpWeek(); });

    var side = document.querySelector('.cal-side');
    side.addEventListener('change', function (e) {
      var el = e.target;
      var axis = el.dataset.axis;
      if (!axis || !state[axis]) return;
      state[axis][el.value] = el.checked;
      render();
    });
    // Each section's All/None acts on that section only.
    Array.prototype.forEach.call(side.querySelectorAll('[data-all]'), function (btn) {
      btn.addEventListener('click', function () {
        var axis = btn.dataset.all;
        var on = btn.dataset.on === '1';
        Object.keys(state[axis]).forEach(function (k) { state[axis][k] = on; });
        renderAll();
      });
    });

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

    $('#modalX').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    $('#modalFoot').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.dataset.act;

      if (act === 'close') return closeModal();

      if (act === 'copy') {
        navigator.clipboard.writeText(state.me.feedUrl || '').then(function () {
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
        b.disabled = true;
        var id = b.dataset.id;
        api(id ? '/api/items/' + id : '/api/items', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(readForm()),
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
              var msg = 'Imported ' + r.imported + (r.imported === 1 ? ' event.' : ' events.');
              if (r.warnings && r.warnings.length) {
                msg += '\n\nThe sheet disagrees with itself on ' + r.warnings.length
                  + (r.warnings.length === 1 ? ' row' : ' rows')
                  + '. The events are in; these columns were ignored:\n\n'
                  + r.warnings.slice(0, 12).join('\n');
              }
              alert(msg);
            });
          })
          .catch(function (err) { b.disabled = false; formError(err.message, err.problems); });
      }
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────

  function initFilters() {
    state.tax.eventTypes.forEach(function (e) { state.types[e.key] = true; });
    state.tax.subTypes.forEach(function (st) { state.subs[st.key] = true; });
    state.tax.needs.forEach(function (nd) { state.needs[nd.key] = true; });
    state.tax.statuses.forEach(function (st) { state.stats[st] = true; });
    state.subs[NONE] = true;
    state.needs[NONE] = true;
    state.types[NONE] = true;
  }

  Promise.all([api('/api/taxonomy'), api('/api/me').catch(function () { return {}; })])
    .then(function (r) {
      state.tax = r[0];
      state.me = r[1] || {};
      injectPalette();
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
      $('#view').innerHTML = emptyHtml('The calendar could not load', esc(err.message));
    });
})();
