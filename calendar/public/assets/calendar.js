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

  // A month grid is unreadable at phone width -- there is no room for titles.
  // Agenda shows the same information in a form that survives the narrow column.
  var NARROW = window.matchMedia('(max-width: 820px)').matches;

  var state = {
    cursor: new Date(),
    items: [],
    tax: null,
    me: { canEdit: false, email: '' },
    // What is SELECTED on each axis. Empty means that axis is not asking a
    // question, which is why an untouched calendar shows everything and why
    // clicking one chip cannot be vetoed by an axis nobody has touched.
    sel: { kinds: [], depts: [], subs: [], vehicles: [], stats: [] },
    attachments: [],   // of the event currently open, fetched on demand
  };

  // ── remembered preferences ─────────────────────────────────────────────
  //
  // Per person, per browser. What gets stored is which chips are lit. Nothing
  // lit is the default, so a department added to the taxonomy next month simply
  // appears as another chip rather than being hidden by an old preference.
  //
  // Every read and write is guarded: private windows, cleared site data and
  // blocked storage all throw, and none of that should stop the calendar
  // rendering.

  var AXES = ['kinds', 'depts', 'subs', 'vehicles', 'stats'];
  // A department is a whole view, not one term in a query. "What is Wholesale
  // doing" means everything Wholesale is on -- its events, its marketing, its
  // meetings, whatever it has to drive there. Combining it with a chip from
  // another row silently subtracts from that, which is how a Finance count of
  // zero came to look like missing data instead of an active Email filter.
  //
  // So a department clears everything else, and anything else clears the
  // department. Chips on rows two and three still combine among themselves.
  var DEPT_AXIS = 'depts';
  var NO_DEPT = '\u2014none\u2014';
  // v3: preferences used to record what was switched OFF, which only made
  // sense when everything started on. Chips record what is switched ON, so an
  // older preference would mean the opposite of what it said.
  var PREFS_KEY = 'jetty-calendar-prefs-v3';

  function readPrefs() {
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ sel: state.sel }));
    } catch (e) { /* storage unavailable; the calendar still works */ }
  }

  function applyPrefs() {
    var p = readPrefs();
    if (!p) return;
    AXES.forEach(function (axis) {
      var saved = p.sel && p.sel[axis];
      if (Array.isArray(saved)) state.sel[axis] = saved.slice();
    });
  }

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
    var at = fromYmd(dateStr);
    // Matches worker/retail.js: a date this cannot parse returns null rather
    // than producing an Invalid Date that renders as "NaN".
    if (isNaN(at)) return null;
    var base = fromYmd(state.tax.retailEpoch);
    var idx = Math.floor((at - base) / (7 * DAY_MS));
    var yearOffset = Math.floor(idx / 52);
    var start = addDays(base, idx * 7);
    return {
      year: state.tax.retailEpochYear + yearOffset,
      week: idx - yearOffset * 52 + 1,
      start: ymd(start),
      end: ymd(addDays(start, 6)),
    };
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
  function tax(axis) { return (state.tax && state.tax[axis]) || []; }

  function listOf(item, field) {
    return item[field] ? item[field].split(',').filter(Boolean) : [];
  }
  function subsOf(item)     { return listOf(item, 'sub_types'); }
  function needsOf(item)    { return listOf(item, 'needs'); }
  function vehiclesOf(item) { return listOf(item, 'vehicles'); }

  // The primary department first, then everyone else along for the ride. The
  // filters treat all of them alike -- ticking Marketing should surface a store
  // sale Marketing promotes -- but only the first one gives the event a colour.
  function extraDeptsOf(item) { return listOf(item, 'departments'); }
  function deptsOf(item) {
    return (item.department ? [item.department] : []).concat(extraDeptsOf(item));
  }

  function labelIn(list, key) { var x = find(list, key); return x ? x.label : key; }
  function deptLabel(k) { return labelIn(tax('departments'), k); }
  function deptSummary(item) {
    var all = deptsOf(item);
    if (!all.length) return '';
    return all.map(deptLabel).join(' + ');
  }

  // Colours live in CSS custom properties so the light and dark steps swap in
  // one place rather than being recomputed per chip. The palette is validated
  // in both modes -- see worker/taxonomy.js.
  function injectPalette() {
    var light = [];
    var dark = [];
    state.tax.departments.forEach(function (d) {
      light.push('--dp-' + d.key + ':' + d.color + ';');
      dark.push('--dp-' + d.key + ':' + (d.colorDark || d.color) + ';');
    });
    var el = document.createElement('style');
    el.textContent = ':root{' + light.join('') + '}'
      + '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){' + dark.join('') + '}}'
      + ':root[data-theme="dark"]{' + dark.join('') + '}';
    document.head.appendChild(el);
  }

  function deptVar(key) { return 'var(--dp-' + key + ', #8A8F98)'; }

  // One colour, the primary department's. An event with no department at all
  // -- the company meetings that came across without one -- gets grey rather
  // than borrowing somebody's.
  function colorFor(item) {
    return item.department ? deptVar(item.department) : '#8A8F98';
  }

  function bandHtml(item) {
    return '<span class="bar"><i style="background:' + colorFor(item) + '"></i></span>';
  }

  // The departments along for the ride. Small marks rather than colour, so the
  // event still reads as one department's at a glance.
  function extraDotsHtml(item) {
    var extra = extraDeptsOf(item);
    if (!extra.length) return '';
    return '<span class="alsodots" title="Also involved: '
      + esc(extra.map(deptLabel).join(', ')) + '">'
      + extra.map(function (k) {
          return '<i style="background:' + deptVar(k) + '"></i>';
        }).join('') + '</span>';
  }

  // ── filtering ──────────────────────────────────────────────────────────

  // An axis with nothing selected has stopped asking a question, so it stops
  // narrowing. Axes that ARE asking narrow together: Box Truck plus Pending
  // means both. Within one axis the values are alternatives, so an event stays
  // while any of its departments is lit -- pick Marketing and you still get the
  // store sale Marketing only promotes, because that event is still the store's.
  function passesAxis(values, picked) {
    if (!picked.length) return true;
    // The "Unassigned" chip asks for the events with nothing on this axis,
    // which is the one question a list of values cannot express.
    if (!values.length) return picked.indexOf(NO_DEPT) >= 0;
    return values.some(function (k) { return picked.indexOf(k) >= 0; });
  }

  function passes(item) {
    return passesAxis(item.event_type ? [item.event_type] : [], state.sel.kinds)
      && passesAxis(item.status ? [item.status] : [], state.sel.stats)
      && passesAxis(deptsOf(item), state.sel.depts)
      && passesAxis(subsOf(item), state.sel.subs)
      && passesAxis(vehiclesOf(item), state.sel.vehicles);
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
    return MONTHS[c.getMonth()] + ' ' + c.getFullYear();
  }

  // ── the filter bar ─────────────────────────────────────────────────────
  //
  // Three rows of chips in place of six sections and forty checkboxes.
  //
  //   1  the departments, which is the question asked most
  //   2  Marketing, with its nine sub-types beside it -- they are only ever
  //      asked about together, and Marketing's row is where they belong
  //   3  the crosscutting ones: meetings, what has to be driven, what is
  //      still tentative
  //
  // Everything the taxonomy knows is still on the form when adding or editing;
  // this is the reading view, and it is narrower on purpose.

  // Line drawings rather than photographs: at 18px the only thing that
  // separates three white vans is silhouette, so the box, the cargo van and the
  // transit get different rooflines and different proportions.
  var VEHICLE_ICONS = {
    'box-truck':
      '<svg viewBox="0 0 34 20" aria-hidden="true">'
      + '<path d="M1 4h17v11H1z"/><path d="M18 7h7l5 5v3H18z"/>'
      + '<circle cx="8" cy="16.5" r="2.4"/><circle cx="25" cy="16.5" r="2.4"/></svg>',
    'ink-van':
      '<svg viewBox="0 0 34 20" aria-hidden="true">'
      + '<path d="M2 6h15l7 2 6 2v5H2z"/><path d="M17 7.5h5l3 2h-8z" class="win"/>'
      + '<circle cx="9" cy="16.5" r="2.4"/><circle cx="25" cy="16.5" r="2.4"/></svg>',
    'brand-transit':
      '<svg viewBox="0 0 34 20" aria-hidden="true">'
      + '<path d="M4 3h14l6 4 4 1v7H4z"/><path d="M7 5h9v4H7z" class="win"/>'
      + '<path d="M18 5.5h3l3.5 3.5H18z" class="win"/>'
      + '<circle cx="10" cy="15.5" r="2.4"/><circle cx="25" cy="15.5" r="2.4"/></svg>',
  };

  // Each chip names an axis and a value on it, so the click handler needs no
  // special cases and adding one later is a line in this function.
  function chipRows() {
    var depts = tax('departments').map(function (d) {
      return { axis: 'depts', key: d.key, label: d.label, color: deptVar(d.key) };
    });
    // Without this there is no way to find an event that has no department, and
    // no way to tell "nothing is tagged Finance" from "Finance is broken".
    depts.push({ axis: 'depts', key: NO_DEPT, label: 'Unassigned' });

    var meetings = tax('eventTypes')
      .filter(function (e) { return e.key === 'meetings-deadlines'; })
      .map(function (e) { return { axis: 'kinds', key: e.key, label: 'Meetings' }; });

    var vehicles = tax('vehicles').map(function (v) {
      return { axis: 'vehicles', key: v.key, label: v.label, icon: VEHICLE_ICONS[v.key] };
    });

    var pending = [{ axis: 'stats', key: 'Pending', label: 'Pending' }];

    // Marketing's nine. Wholesale's single Tradeshow sub-type sits with
    // Wholesale rather than earning a row of its own.
    var marketing = tax('subTypes')
      .filter(function (st) { return st.department === 'marketing'; })
      .map(function (st) { return { axis: 'subs', key: st.key, label: st.label }; });

    // Marketing leads its own row rather than sitting in the department list,
    // so its sub-types read as its sub-types. "(All)" because the nine chips
    // beside it are the parts.
    var marketingDept = depts.filter(function (d) { return d.key === 'marketing'; })
      .map(function (d) { return { axis: 'depts', key: d.key, label: 'Marketing (All)', color: d.color }; });

    return [
      depts.filter(function (d) { return d.key !== 'marketing'; }),
      [].concat(marketingDept, marketing),
      [].concat(meetings, [null], vehicles, [null], pending),
    ];
  }

  // A chip's count is worked out with its own axis ignored, so the numbers say
  // what you would get by clicking it rather than what you have already got.
  // Otherwise every chip on an active axis reads 0 and the bar looks broken.
  function chipCounts() {
    var out = {};
    AXES.forEach(function (axis) {
      var others = {};
      AXES.forEach(function (a) { others[a] = a === axis ? [] : state.sel[a]; });
      var pool = state.items.filter(function (it) {
        return passesAxis(it.event_type ? [it.event_type] : [], others.kinds)
          && passesAxis(it.status ? [it.status] : [], others.stats)
          && passesAxis(deptsOf(it), others.depts)
          && passesAxis(subsOf(it), others.subs)
          && passesAxis(vehiclesOf(it), others.vehicles);
      });
      var bucket = {};
      pool.forEach(function (it) {
        var vals = axis === 'kinds' ? [it.event_type]
          : axis === 'stats' ? [it.status]
          : axis === 'depts' ? deptsOf(it)
          : axis === 'subs' ? subsOf(it)
          : vehiclesOf(it);
        vals = vals.filter(Boolean);
        if (!vals.length) vals = [NO_DEPT];
        vals.forEach(function (k) { bucket[k] = (bucket[k] || 0) + 1; });
      });
      out[axis] = bucket;
    });
    return out;
  }

  function chipOn(c) { return state.sel[c.axis].indexOf(c.key) >= 0; }

  function renderFilters() {
    if (!state.tax) return;
    var el = $('#filterBar');
    if (!el) return;
    var n = chipCounts();
    var anyOn = AXES.some(function (a) { return state.sel[a].length; });

    var chipHtml = function (c) {
      var count = (n[c.axis] && n[c.axis][c.key]) || 0;
      return '<button type="button" class="fchip' + (chipOn(c) ? ' on' : '')
        + (count ? '' : ' empty') + '" data-axis="' + c.axis + '"'
        + ' data-key="' + esc(c.key) + '" aria-pressed="' + (chipOn(c) ? 'true' : 'false') + '">'
        + (c.icon ? '<span class="fveh">' + c.icon + '</span>' : '')
        + (c.color ? '<i class="dot" style="background:' + c.color + '"></i>' : '')
        + esc(c.label) + '<span class="fn">' + count + '</span></button>';
    };

    var rows = chipRows();
    var row = function (chips) {
      return chips.map(function (c) {
        return c ? chipHtml(c) : '<span class="fsep"></span>';
      }).join('');
    };

    el.innerHTML =
      '<div class="frow">'
      + '<span class="fhint">Choose one department</span>'
      + '<button type="button" class="fchip all' + (anyOn ? '' : ' on') + '" data-all="1">'
      + 'Everything<span class="fn">' + state.items.length + '</span></button>'
      + row(rows[0])
      + '</div>'
      + '<div class="frow">' + row(rows[1]) + '</div>'
      + '<div class="frow">' + row(rows[2]) + '</div>';
  }

  // What is selected, spelled out. Chips are spread over three rows and a lit
  // one is easy to miss, which makes the counts look wrong rather than
  // conditional: pick a Marketing sub-type, forget it is on, and every
  // department reads 0 because no department's events are also an Email. This
  // bar names every active filter, lets each be taken off on its own, and says
  // plainly when the combination matches nothing.
  function selLabel(axis, key) {
    if (axis === 'depts') return key === NO_DEPT ? 'Unassigned' : deptLabel(key);
    if (axis === 'kinds') return labelIn(tax('eventTypes'), key);
    if (axis === 'subs') return labelIn(tax('subTypes'), key);
    if (axis === 'vehicles') return labelIn(tax('vehicles'), key);
    return key;
  }

  function renderFilterStatus() {
    var el = $('#filterStatus');
    if (!el) return;
    var active = [];
    AXES.forEach(function (axis) {
      state.sel[axis].forEach(function (key) {
        active.push({ axis: axis, key: key, label: selLabel(axis, key) });
      });
    });
    if (!active.length) { el.innerHTML = ''; return; }

    var shown = visible().length;
    var total = state.items.length;
    el.innerHTML = '<div class="flt-status' + (shown ? '' : ' none') + '">'
      + '<span class="fs-lead">Showing</span>'
      + active.map(function (a) {
          return '<button type="button" class="fs-tok" data-axis="' + a.axis + '"'
            + ' data-key="' + esc(a.key) + '" title="Remove this filter">'
            + esc(a.label) + '<span class="fs-x">\u00d7</span></button>';
        }).join('')
      + '<span class="fs-count">'
      + (shown ? shown + ' of ' + total + ' events'
               : 'nothing matches all of these')
      + '</span>'
      + '<button type="button" class="fs-clear" id="fltReset">Clear all</button>'
      + '</div>';
  }

  // ── views ──────────────────────────────────────────────────────────────

  // With colour reserved for the calendar, these dots are the only at-a-glance
  // sign that an event also involves another department. The event's own
  // calendar department is left off -- on a box truck calendar every event is
  // Box Truck, and a dot on all 112 says nothing.
  function chipHtml(it, dateStr) {
    var cls = 'chip' + (it.status === 'Booked' ? '' : ' ' + it.status.toLowerCase());
    var cont = it.start_date < dateStr ? '→ ' : '';
    var time = (!it.all_day && it.start_time && it.start_date === dateStr)
      ? '<span class="t">' + esc(hhmm(it.start_time)) + '</span>' : '';
    var tip = it.title + ' \u2014 ' + (deptSummary(it) || 'no department')
      + ' · ' + it.status + (it.venue ? ' · ' + it.venue : '');
    return '<div class="' + cls + '" style="--chip:' + colorFor(it) + '" data-id="' + esc(it.id) + '" '
      + 'title="' + esc(tip) + '">'
      + bandHtml(it) + time + '<span class="n">' + esc(cont + it.title) + '</span>'
      + extraDotsHtml(it) + '</div>';
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
    var dl = deptSummary(it);
    if (dl) meta.push(dl);
    var subs = subsOf(it).map(function (k) { return labelIn(tax('subTypes'), k); });
    if (subs.length) meta.push(subs.join(', '));
    if (it.status !== 'Booked') meta.push(it.status);
    if (it.start_date !== it.end_date) meta.push(spanLabel(it));
    var where = placeLabel(it);
    if (where) meta.push(where);
    var nd = needsOf(it).map(function (k) { return labelIn(tax('needs'), k); });
    if (nd.length) meta.push('Needs: ' + nd.join(', ') + (it.staff_count ? ' (' + it.staff_count + ')' : ''));
    var vh = vehiclesOf(it).map(function (k) { return labelIn(tax('vehicles'), k); });
    if (vh.length) meta.push(vh.join(', '));
    var rcls = 'day-item' + (it.status === 'Booked' ? '' : ' ' + it.status.toLowerCase());
    return '<div class="' + rcls + '" style="--chip:' + colorFor(it) + '" data-id="' + esc(it.id) + '">'
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

  // The month grid answers "what is happening"; once you have narrowed to one
  // department it stops being the useful shape, because the answer is a handful
  // of events scattered over six rows of mostly empty cells. So a selection
  // opens a list beside it, in date order, and the grid gives up the width.
  function renderList() {
    var panel = $('#listPanel');
    if (!panel) return;
    var any = AXES.some(function (a) { return state.sel[a].length; });
    if (!any && !NARROW) { panel.hidden = true; $('#shell').classList.remove('split'); return; }

    var c = state.cursor;
    var from = ymd(new Date(c.getFullYear(), c.getMonth(), 1));
    var to = ymd(new Date(c.getFullYear(), c.getMonth() + 1, 0));
    var pool = visible()
      .filter(function (it) { return it.end_date >= from && it.start_date <= to; })
      .sort(function (a, b) {
        return a.start_date.localeCompare(b.start_date)
          || (b.all_day - a.all_day)
          || (a.start_time || '').localeCompare(b.start_time || '')
          || a.title.localeCompare(b.title);
      });

    panel.hidden = false;
    $('#shell').classList.toggle('split', !NARROW);

    var head = '<div class="cl-head">' + esc(periodLabel()) + '<span>'
      + pool.length + (pool.length === 1 ? ' event' : ' events') + '</span></div>';

    if (!pool.length) {
      panel.innerHTML = head
        + '<p class="cl-empty">Nothing this month matches what you have picked. '
        + 'Try another month, or take a filter off.</p>';
      return;
    }

    var last = '';
    panel.innerHTML = head + '<div class="cl-body">' + pool.map(function (it) {
      var d = fromYmd(it.start_date < from ? from : it.start_date);
      var key = ymd(d);
      var day = key === last ? '' : '<div class="cl-day">' + DOW[d.getDay()] + ' '
        + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + '</div>';
      last = key;
      return day + rowHtml(it);
    }).join('') + '</div>';
  }

  function render() {
    $('#period').textContent = periodLabel();
    renderFilterStatus();
    // A phone cannot read a month grid, so it gets the list on its own.
    $('#view').innerHTML = NARROW ? '' : renderMonth();
    $('#view').hidden = NARROW;
    renderList();
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

  function fileSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // Shown on the event and in the form. Downloads are links rather than
  // fetches, so the browser's own save dialog does the work.
  function attachHtml(list, withRemove) {
    if (!list || !list.length) return '';
    return list.map(function (a) {
      return '<div class="att-row">'
        + '<a class="att-name" href="/api/attachments/' + esc(a.id) + '" download>'
        + esc(a.name) + '</a>'
        + '<span class="att-size">' + fileSize(a.size) + '</span>'
        + (withRemove
            ? '<button type="button" class="att-x" data-att="' + esc(a.id)
              + '" title="Remove">\u00d7</button>'
            : '')
        + '</div>';
    }).join('');
  }

  // The attachment list is not carried on every event in the month -- only a
  // count is -- so the one being opened is fetched when it is opened.
  function showDetail(id) {
    var it = state.items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    state.attachments = [];
    if (it.attachment_count) {
      api('/api/items/' + id).then(function (r) {
        state.attachments = r.attachments || [];
        var slot = document.querySelector('#modalBody .att-slot');
        if (slot) slot.innerHTML = attachHtml(state.attachments);
      }).catch(function () {});
    }
    var r = it.retail || retailWeek(it.start_date);
    var rows = '';
    var add = function (k, v) { if (v) rows += '<dt>' + k + '</dt><dd>' + v + '</dd>'; };
    var chips = function (keys, list, colored) {
      return keys.map(function (k) {
        return '<span class="tag">'
          + (colored ? '<i style="background:' + deptVar(k) + '"></i>' : '')
          + esc(labelIn(list, k)) + '</span>';
      }).join(' ');
    };

    add('Event Type', esc(labelIn(tax('eventTypes'), it.event_type)));
    // The primary department is named on its own line: on this event it is not
    // one of several, it is the one whose calendar this is.
    add('Department', it.department
      ? '<span class="tag"><i style="background:' + deptVar(it.department) + '"></i>'
        + esc(deptLabel(it.department)) + '</span>' : '');
    add('Also involved', chips(extraDeptsOf(it), tax('departments'), true));
    add('Sub-type', chips(subsOf(it), tax('subTypes'), false));
    var pillCls = it.status === 'Booked' ? 'ok' : (it.status === 'Cancelled' ? 'off' : 'warn');
    add('Status', '<span class="pill ' + pillCls + '">'
      + esc(it.status) + '</span>');
    if (r) add('Retail week', 'Week ' + r.week + ' of ' + r.year + ' <span class="muted">('
      + esc(weekRangeLabel(r)) + ')</span>');
    add('Needs', chips(needsOf(it), tax('needs'), false)
      + (it.staff_count ? ' <span class="muted">' + esc(it.staff_count) + ' staff</span>' : ''));
    add('Vehicles', chips(vehiclesOf(it), tax('vehicles'), false));

    var addr = [it.address, [it.city, it.state].filter(Boolean).join(', '), it.zip]
      .filter(Boolean).join('<br>');
    add('Venue', esc(it.venue || ''));
    add('Address', addr);
    add('Link', it.url ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">'
      + esc(it.url) + '</a>' : '');
    add('Description / Notes', it.notes ? '<span class="det-notes">' + esc(it.notes) + '</span>' : '');
    if (it.attachment_count) {
      add('Attachments', '<div class="att-slot"><span class="muted">Loading\u2026</span></div>');
    }

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

  // Adding is an interview: one question at a time, in the order of the
  // decision tree, with later questions shaped by earlier answers. Editing is
  // not -- every answer already exists, so the whole form is shown at once and
  // you go straight to the field you came to change.
  function showForm(existing, defaultDate) {
    var it = existing || {
      title: '', event_type: 'events-marketing', department: '', departments: '',
      sub_types: '', needs: '', staff_count: '', vehicles: '',
      status: 'Booked', start_date: defaultDate || todayYmd(), end_date: defaultDate || todayYmd(),
      all_day: 1, start_time: '', end_time: '',
      venue: '', address: '', city: '', state: '', zip: '', notes: '', url: '',
    };
    var interview = !existing;
    var at = 0;

    var sect = function (key, head, note, inner) {
      return '<section class="step" data-step="' + key + '">'
        + (head ? '<h4 class="step-q">' + head
            + (note ? ' <span class="lbl-note">' + note + '</span>' : '') + '</h4>' : '')
        + inner + '</section>';
    };

    var body = ''
      + '<div class="form-err" id="formErr" hidden></div>'
      + '<div class="step-trail" id="stepTrail"></div>'

      + sect('kind', 'What kind of item is this?', '',
          '<div class="pick-grid">'
          + tax('eventTypes').map(function (e) {
              return '<label class="pick"><input type="radio" name="f-kind" class="f-kind" value="'
                + esc(e.key) + '"' + (e.key === it.event_type ? ' checked' : '') + '>'
                + '<span class="pick-b"><span class="pick-t">' + esc(e.label) + '</span>'
                + (e.note ? '<span class="pick-n">' + esc(e.note) + '</span>' : '')
                + '</span></label>';
            }).join('')
          + '</div>')

      + sect('title', 'What is it called?', '',
          '<div class="fld"><input type="text" id="f-title" value="' + esc(it.title)
          + '" maxlength="200" placeholder="Coquina Jam"></div>')

      + sect('dept', 'Whose is it?', 'the department that owns it — this sets the colour',
          '<div class="chk-grid" id="deptPick"></div>')

      + sect('extra', 'Anyone else involved?', 'optional — they show as dots, not colour',
          '<div class="chk-grid" id="extraPick"></div>')

      + sect('subs', 'What kind of item is it for them?', 'optional',
          '<div class="chk-grid" id="subPick"></div>')

      + sect('when', 'When is it?', '',
          '<div class="fld-row">'
          + '<div class="fld"><label for="f-start">Starts</label>'
          + '<input type="date" id="f-start" value="' + esc(it.start_date) + '"></div>'
          + '<div class="fld"><label for="f-end">Ends</label>'
          + '<input type="date" id="f-end" value="' + esc(it.end_date) + '">'
          + '<div class="hint">Same as the start date for a one-day event.</div></div>'
          + '</div>'
          + '<div class="fld"><div class="retail-readout" id="retailOut"></div></div>'
          + '<div class="fld"><label class="fld-inline"><input type="checkbox" id="f-allday"'
          + (it.all_day ? ' checked' : '') + '> All day</label></div>'
          + '<div class="fld-row" id="timeRow"' + (it.all_day ? ' hidden' : '') + '>'
          + '<div class="fld"><label for="f-stime">Start time</label>'
          + '<input type="time" id="f-stime" value="' + esc(it.start_time || '') + '"></div>'
          + '<div class="fld"><label for="f-etime">End time</label>'
          + '<input type="time" id="f-etime" value="' + esc(it.end_time || '') + '"></div>'
          + '</div>')

      + sect('where', 'Where is it?', 'optional',
          '<div class="fld"><label for="f-venue">Venue</label>'
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
          + '<input type="text" id="f-zip" value="' + esc(it.zip || '') + '" maxlength="10" '
          + 'inputmode="numeric"></div>'
          + '</div>')

      + sect('needs', 'What does it need?', 'optional',
          '<div class="chk-grid" id="needPick"></div>'
          + '<div class="fld" id="staffRow" hidden><label for="f-staff">How many extra staff?</label>'
          + '<input type="text" id="f-staff" value="' + esc(it.staff_count || '')
          + '" maxlength="20" inputmode="numeric" placeholder="e.g. 3"></div>'
          + '<h4 class="step-q sub">Vehicles <span class="lbl-note">optional</span></h4>'
          + '<div class="chk-grid">'
          + tax('vehicles').map(function (v) {
              return '<label class="fld-inline"><input type="checkbox" class="f-veh" value="'
                + esc(v.key) + '"' + (vehiclesOf(it).indexOf(v.key) >= 0 ? ' checked' : '') + '>'
                + esc(v.label) + '</label>';
            }).join('')
          + '</div>')

      + sect('final', 'Anything else?', '',
          '<div class="fld"><label for="f-status">Status</label><select id="f-status">'
          + tax('statuses').map(function (st) {
              return '<option value="' + esc(st) + '"' + (st === it.status ? ' selected' : '') + '>'
                + esc(st) + '</option>';
            }).join('')
          + '</select></div>'
          + '<div class="fld"><label for="f-url">Link</label>'
          + '<input type="url" id="f-url" value="' + esc(it.url || '') + '" placeholder="https://"></div>'
          + '<div class="fld"><label for="f-notes">Description / Notes</label>'
          + '<textarea id="f-notes" maxlength="4000" placeholder="What is it, what has to happen, '
          + 'anything the next person needs to know.">' + esc(it.notes || '') + '</textarea></div>'

          // Uploading needs an id to hang the file off, so a new event holds its
          // files until it has been saved and says so rather than failing.
          + '<div class="fld"><label>Attachments</label>'
          + '<div class="att-box" id="attBox">'
          + (existing
              ? '<div class="att-list" id="attList"></div>'
              : '<p class="hint" id="attPending">Files are attached once the event is saved.</p>')
          + '<label class="att-pick"><input type="file" id="f-files" multiple>'
          + '<span>Choose files\u2026</span></label>'
          + '<div class="hint">Up to 10 MB each. Everyone who can open the calendar can '
          + 'download them; only editors can add or remove.</div>'
          + '</div></div>');

    openModal(existing ? 'Edit event' : 'Add event', body, '');

    // ── what the answers so far make relevant ────────────────────────────
    function kind() {
      var el = document.querySelector('.f-kind:checked');
      return el ? el.value : 'events-marketing';
    }
    function primary() {
      var el = document.querySelector('.f-dept:checked');
      return el ? el.value : '';
    }
    function extras() {
      return Array.prototype.map.call(document.querySelectorAll('.f-extra:checked'),
        function (el) { return el.value; });
    }
    function onEvent() {
      var p = primary();
      return (p ? [p] : []).concat(extras());
    }
    function subsAvailable() {
      var on = onEvent();
      return tax('subTypes').filter(function (st) { return on.indexOf(st.department) >= 0; });
    }
    // Unscoped, so this is the whole list on every event.
    function needsAvailable() { return tax('needs'); }

    // A meeting takes the short form: who, when, and nothing else. A step with
    // nothing to ask -- no department on the event has any sub-type -- is not
    // shown at all rather than shown empty.
    function activeSteps() {
      if (kind() === 'meetings-deadlines') return ['kind', 'title', 'dept', 'when', 'final'];
      var out = ['kind', 'title', 'dept', 'extra'];
      if (subsAvailable().length) out.push('subs');
      out.push('when', 'where', 'needs', 'final');
      return out;
    }

    // ── the lists that depend on earlier answers ─────────────────────────
    function paintDepts() {
      var p = primary() || it.department;
      $('#deptPick').innerHTML = tax('departments').map(function (d) {
        return '<label class="fld-inline"><input type="radio" name="f-dept" class="f-dept" value="'
          + esc(d.key) + '"' + (d.key === p ? ' checked' : '') + '>'
          + '<i class="dot" style="background:' + deptVar(d.key) + '"></i>'
          + esc(d.label) + '</label>';
      }).join('');
    }

    function paintExtras() {
      var p = primary();
      var chosen = extras().length ? extras() : extraDeptsOf(it);
      $('#extraPick').innerHTML = tax('departments')
        .filter(function (d) { return d.key !== p; })
        .map(function (d) {
          return '<label class="fld-inline"><input type="checkbox" class="f-extra" value="'
            + esc(d.key) + '"' + (chosen.indexOf(d.key) >= 0 ? ' checked' : '') + '>'
            + '<i class="dot" style="background:' + deptVar(d.key) + '"></i>'
            + esc(d.label) + '</label>';
        }).join('');
    }

    // Sub-types and needs belong to departments, so both lists are rebuilt
    // whenever the departments change. Anything already ticked that no longer
    // applies drops off with the box it was on.
    function paintScoped() {
      var already = Array.prototype.map.call(document.querySelectorAll('.f-sub:checked'),
        function (el) { return el.value; });
      var chosenSubs = already.length ? already : subsOf(it);
      $('#subPick').innerHTML = subsAvailable().map(function (st) {
        return '<label class="fld-inline" title="' + esc(deptLabel(st.department)) + '">'
          + '<input type="checkbox" class="f-sub" value="' + esc(st.key) + '"'
          + (chosenSubs.indexOf(st.key) >= 0 ? ' checked' : '') + '>'
          + esc(st.label) + '</label>';
      }).join('') || '<p class="hint">Nothing on this event has sub-types.</p>';

      var hadNeeds = Array.prototype.map.call(document.querySelectorAll('.f-need:checked'),
        function (el) { return el.value; });
      var chosenNeeds = hadNeeds.length ? hadNeeds : needsOf(it);
      $('#needPick').innerHTML = needsAvailable().map(function (nd) {
        return '<label class="fld-inline">'
          + '<input type="checkbox" class="f-need" value="' + esc(nd.key) + '"'
          + (chosenNeeds.indexOf(nd.key) >= 0 ? ' checked' : '') + '>'
          + esc(nd.label) + '</label>';
      }).join('');
      paintStaff();
    }

    function paintStaff() {
      var on = document.querySelector('.f-need[value="extra-staff"]:checked');
      $('#staffRow').hidden = !on;
    }

    // ── the interview itself ─────────────────────────────────────────────
    function missing(step) {
      if (step === 'title' && !$('#f-title').value.trim()) return 'Give it a name first.';
      if (step === 'dept' && !primary()) return 'Pick the department that owns it.';
      if (step === 'when' && !$('#f-start').value) return 'Pick a start date.';
      return '';
    }

    function paint() {
      var active = activeSteps();
      if (at >= active.length) at = active.length - 1;
      Array.prototype.forEach.call(document.querySelectorAll('.step'), function (el) {
        var on = active.indexOf(el.dataset.step) >= 0;
        el.hidden = interview ? !(on && el.dataset.step === active[at]) : !on;
      });

      $('#stepTrail').innerHTML = !interview ? ''
        : '<span class="trail-n">Step ' + (at + 1) + ' of ' + active.length + '</span>'
          + active.map(function (k, i) {
              return '<i class="trail-p' + (i <= at ? ' on' : '') + '"></i>';
            }).join('');

      var last = at === active.length - 1;
      $('#modalFoot').innerHTML = !interview
        ? '<div class="grow"></div>'
          + '<button class="cal-btn" data-act="close">Cancel</button>'
          + '<button class="cal-btn primary" data-act="save" data-id="' + esc(it.id) + '">Save changes</button>'
        : (at > 0 ? '<button class="cal-btn" data-act="back">Back</button>' : '')
          + '<div class="grow"></div>'
          + '<button class="cal-btn" data-act="close">Cancel</button>'
          + (last
              ? '<button class="cal-btn primary" data-act="save">Add to calendar</button>'
              : '<button class="cal-btn primary" data-act="next">Next</button>');

      var first = document.querySelector('.step:not([hidden]) input:not([type=hidden]), '
        + '.step:not([hidden]) textarea');
      if (first && first.type !== 'date') first.focus();
    }

    function step(dir) {
      var active = activeSteps();
      if (dir > 0) {
        var why = missing(active[at]);
        if (why) { formError(why); return; }
        $('#formErr').hidden = true;
      }
      at = Math.max(0, Math.min(active.length - 1, at + dir));
      paint();
    }
    // wire() reads these off the modal footer, which is rebuilt on every step.
    showForm.step = step;
    showForm.atLastStep = function () {
      var active = activeSteps();
      return !interview || at === active.length - 1;
    };

    paintDepts();
    paintExtras();
    paintScoped();

    // Editing shows what is already attached, and removes one on the spot --
    // waiting for Save would mean a file the person has "deleted" coming back
    // if they then cancel.
    function paintFiles() {
      var box = $('#attList');
      if (!box) return;
      box.innerHTML = state.attachments.length
        ? attachHtml(state.attachments, true)
        : '<p class="hint">Nothing attached yet.</p>';
    }
    if (existing) {
      state.attachments = [];
      paintFiles();
      api('/api/items/' + existing.id).then(function (r) {
        state.attachments = r.attachments || [];
        paintFiles();
      }).catch(function () {});
    }

    // Assigned rather than added: #modalBody outlives the form, so
    // addEventListener stacks a fresh handler every time the form is opened.
    // Three opens meant one click on a remove button firing three deletes.
    $('#modalBody').onclick = function (e) {
      var x = e.target.closest('.att-x');
      if (!x) return;
      e.preventDefault();
      if (!confirm('Remove this file? It cannot be undone.')) return;
      x.disabled = true;
      api('/api/attachments/' + x.dataset.att, { method: 'DELETE' })
        .then(function () {
          state.attachments = state.attachments.filter(function (a) {
            return a.id !== x.dataset.att;
          });
          paintFiles();
        })
        .catch(function (err) { x.disabled = false; formError(err.message); });
    };

    $('#modalBody').onchange = function (e) {
      if (e.target.classList.contains('f-kind')) return paint();
      if (e.target.classList.contains('f-dept')) { paintExtras(); paintScoped(); return paint(); }
      if (e.target.classList.contains('f-extra')) { paintScoped(); return paint(); }
      if (e.target.classList.contains('f-need')) return paintStaff();
      if (e.target.id === 'f-allday') { $('#timeRow').hidden = e.target.checked; return; }
      if (e.target.id === 'f-start') return startChanged(e.target);
    };

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

    // Move the end date with the start date, keeping whatever span was already
    // set. Without this, picking a start date and leaving the end date on its
    // default silently produces a multi-day event.
    var lastStart = it.start_date;
    function startChanged(input) {
      var end = $('#f-end');
      if (input.value && lastStart && end.value) {
        var span = Math.round((fromYmd(end.value) - fromYmd(lastStart)) / DAY_MS);
        if (span >= 0) end.value = ymd(addDays(fromYmd(input.value), span));
      }
      if (end.value < input.value) end.value = input.value;
      lastStart = input.value;
      showRetail();
    }

    showRetail();
    paint();
  }

  function readForm() {
    var allDay = $('#f-allday').checked;
    var vals = function (sel) {
      return Array.prototype.map.call(document.querySelectorAll(sel),
        function (el) { return el.value; });
    };
    var one = function (sel) {
      var el = document.querySelector(sel);
      return el ? el.value : '';
    };
    return {
      title: $('#f-title').value,
      status: $('#f-status').value,
      event_type: one('.f-kind:checked'),
      department: one('.f-dept:checked'),
      departments: vals('.f-extra:checked'),
      sub_types: vals('.f-sub:checked'),
      needs: vals('.f-need:checked'),
      staff_count: $('#f-staff') ? $('#f-staff').value : '',
      vehicles: vals('.f-veh:checked'),
      start_date: $('#f-start').value,
      end_date: $('#f-end').value || $('#f-start').value,
      all_day: allDay ? 1 : 0,
      start_time: allDay ? '' : $('#f-stime').value,
      end_time: allDay ? '' : $('#f-etime').value,
      venue: $('#f-venue') ? $('#f-venue').value : '',
      address: $('#f-address') ? $('#f-address').value : '',
      city: $('#f-city') ? $('#f-city').value : '',
      state: $('#f-state') ? $('#f-state').value : '',
      zip: $('#f-zip') ? $('#f-zip').value : '',
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
      + '<div class="sub-url">Name, Booked, Event Type, Department, Sub-type, Needs, '
      + 'Vehicles, Event \u{1F680}, Event \u{1F6D1}, Start ⌚, End ⌚, Venue, Address, City, '
      + 'State, Zip, Notes, URL</div>'
      + '<div class="hint">Only <strong>Name</strong>, <strong>Department</strong> and a '
      + '<strong>start date</strong> are required. A Department column may list several; '
      + 'the first one that owns events becomes the primary. Year, Week, Start (Week), End (Week), Month and '
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

  // One at a time rather than in parallel: a handful of 10 MB files fired at
  // once is the sort of thing that gets a Worker rate-limited, and the order
  // they arrive in is the order they were picked.
  function uploadFiles(itemId, files) {
    return files.reduce(function (chain, file) {
      return chain.then(function () {
        return fetch('/api/items/' + itemId + '/attachments', {
          method: 'POST',
          headers: {
            'X-File-Name': encodeURIComponent(file.name).replace(/%20/g, ' '),
            'content-type': file.type || 'application/octet-stream',
          },
          body: file,
        }).then(function (res) {
          if (res.ok) return res.json();
          return res.json().catch(function () { return {}; }).then(function (body) {
            throw new Error(body.error || ('Could not upload ' + file.name));
          });
        });
      });
    }, Promise.resolve());
  }

  function loadItems() {
    return api('/api/items').then(function (r) {
      state.items = r.items || [];
      renderAll();
    });
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  function shift(dir) {
    state.cursor = addMonths(state.cursor, dir);
    render();
  }

  function wire() {
    $('#prev').addEventListener('click', function () { shift(-1); });
    $('#next').addEventListener('click', function () { shift(1); });
    $('#today').addEventListener('click', function () { state.cursor = new Date(); render(); });
    $('#subscribe').addEventListener('click', showSubscribe);
    $('#addBtn').addEventListener('click', function () {
      showForm(null, null);
    });
    $('#importBtn').addEventListener('click', showImport);

    // One handler for every chip: each carries the axis it belongs to and the
    // value it selects, so there are no special cases and a new chip is a line
    // in chipRows() rather than another listener here.
    $('#filterBar').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.all) {
        AXES.forEach(function (a) { state.sel[a] = []; });
      } else {
        var axis = btn.dataset.axis;
        var key = btn.dataset.key;
        if (!axis || !state.sel[axis]) return;
        var at = state.sel[axis].indexOf(key);
        if (at >= 0) {
          state.sel[axis].splice(at, 1);
        } else if (axis === DEPT_AXIS) {
          // A department replaces everything, including another department.
          AXES.forEach(function (a) { state.sel[a] = []; });
          state.sel[axis] = [key];
        } else {
          // And anything else lets the department go, rather than quietly
          // subtracting from it.
          state.sel[DEPT_AXIS] = [];
          state.sel[axis].push(key);
        }
      }
      savePrefs();
      renderAll();
    });

    $('#filterStatus').addEventListener('click', function (e) {
      if (e.target.closest('#fltReset')) {
        AXES.forEach(function (axis) { state.sel[axis] = []; });
      } else {
        var tok = e.target.closest('.fs-tok');
        if (!tok) return;
        var list = state.sel[tok.dataset.axis];
        var at = list ? list.indexOf(tok.dataset.key) : -1;
        if (at < 0) return;
        list.splice(at, 1);
      }
      savePrefs();
      renderAll();
    });

    // The grid and the list both render events, so both open them. Bound
    // separately rather than on the document, so a stray [data-id] elsewhere --
    // the modal's own buttons, say -- cannot open an event behind the modal.
    function openFromClick(e) {
      var adder = e.target.closest('[data-add]');
      if (adder && state.me.canEdit) { showForm(null, adder.dataset.add); return; }
      var chip = e.target.closest('[data-id]');
      if (chip) { showDetail(chip.dataset.id); return; }
      var cell = e.target.closest('[data-day]');
      if (cell && state.me.canEdit) showForm(null, cell.dataset.day);
    }
    $('#view').addEventListener('click', openFromClick);
    $('#listPanel').addEventListener('click', openFromClick);

    $('#modalX').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    $('#modalFoot').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.dataset.act;

      if (act === 'close') return closeModal();

      // The interview rebuilds this footer on every step, so Back and Next are
      // handled here rather than bound to buttons that stop existing.
      if (act === 'next') return showForm.step(1);
      if (act === 'back') return showForm.step(-1);

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
        var picked = $('#f-files') ? Array.prototype.slice.call($('#f-files').files) : [];
        api(id ? '/api/items/' + id : '/api/items', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(readForm()),
        }).then(function (r) {
          // A new event has no id until now, which is why its files wait.
          var target = id || (r.item && r.item.id);
          if (!picked.length || !target) return null;
          b.textContent = 'Uploading\u2026';
          return uploadFiles(target, picked);
        }).then(function () {
          closeModal();
          return loadItems();
        }).catch(function (err) {
          b.disabled = false;
          b.textContent = id ? 'Save changes' : 'Add to calendar';
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


  Promise.all([api('/api/taxonomy'), api('/api/me').catch(function () { return {}; })])
    .then(function (r) {
      state.tax = r[0];
      state.me = r[1] || {};
      injectPalette();
      applyPrefs();
      renderWho();
      renderNotice();
      if (state.me.canEdit) {
        document.body.classList.add('can-edit');
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
