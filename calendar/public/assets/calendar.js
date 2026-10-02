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
    comments: [],      // likewise
    people: [],        // the mention roster, fetched once
    slack: { configured: false, status: null },
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

  // Every key the taxonomy still recognises on an axis. Saved selections are
  // checked against this: when a value is merged away or renamed -- Email and
  // SMS becoming Email/SMS -- a browser that remembers the old key would
  // otherwise come back to a calendar filtered to nothing, with a chip lit for
  // a category that no longer exists.
  function axisKeys(axis) {
    if (axis === 'kinds') return tax('eventTypes').map(function (x) { return x.key; });
    if (axis === 'subs') return tax('subTypes').map(function (x) { return x.key; });
    if (axis === 'vehicles') return tax('vehicles').map(function (x) { return x.key; });
    if (axis === 'stats') return tax('statuses').slice();
    return tax('departments').map(function (x) { return x.key; }).concat([NO_DEPT]);
  }

  function applyPrefs() {
    var p = readPrefs();
    if (!p) return;
    AXES.forEach(function (axis) {
      var saved = p.sel && p.sel[axis];
      if (!Array.isArray(saved)) return;
      var known = axisKeys(axis);
      state.sel[axis] = saved.filter(function (k) { return known.indexOf(k) >= 0; });
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

  // Product highlights are JSON rather than a comma list -- a row is five
  // fields, not one key. A column holding anything else costs the event its
  // highlights, never its page.
  function productsOf(item) {
    if (!item || !item.products) return [];
    try {
      var list = JSON.parse(item.products);
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function divLabel(k) { return labelIn(tax('divisions'), k); }
  function productLine(p) {
    return [divLabel(p.division), p.category, p.sku].filter(Boolean).join(' \u203a ');
  }
  // Good enough to name a row and short enough to live in an R2 object key.
  function rowId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
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
  // Four levels, narrowing as you go down. Each level asks one question, so at
  // most one chip is lit per row -- within a row the chips are alternatives.
  // Between rows they are conditions that combine: Marketing + JRF + Pending is
  // three questions, not three competing answers.
  function chipRows() {
    var kinds = tax('eventTypes').map(function (e) {
      // "Events" reads better than "Event" on a filter, where every other chip
      // names a set rather than one thing.
      return { axis: 'kinds', key: e.key, label: e.key === 'event' ? 'Events' : e.label };
    });

    var depts = tax('departments').map(function (d) {
      return { axis: 'depts', key: d.key, label: d.label, color: deptVar(d.key) };
    });
    // Without this there is no way to find an event that has no department, and
    // no way to tell "nothing is tagged Finance" from "Finance is broken".
    depts.push({ axis: 'depts', key: NO_DEPT, label: 'Unassigned' });

    // Wholesale's single Tradeshow sub-type stays with Wholesale rather than
    // earning a place on Marketing's row.
    var marketing = tax('subTypes')
      .filter(function (st) { return st.department === 'marketing'; })
      .map(function (st) { return { axis: 'subs', key: st.key, label: st.label }; });

    var vehicles = tax('vehicles').map(function (v) {
      return { axis: 'vehicles', key: v.key, label: v.label, icon: VEHICLE_ICONS[v.key] };
    });

    // Not a level: it asks what state something is in rather than what kind of
    // thing it is. Sits at the end of the last row, behind a separator.
    var pending = [{ axis: 'stats', key: 'Pending', label: 'Pending' }];

    return [
      { label: 'Kind', chips: kinds },
      { label: 'Department', chips: depts },
      { label: 'Marketing', chips: marketing },
      { label: 'Vehicle schedule', chips: [].concat(vehicles, [null], pending) },
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

    el.innerHTML = rows.map(function (r) {
      return '<div class="frow">'
        + '<span class="fhint">' + esc(r.label) + '</span>'
        + row(r.chips) + '</div>';
    }).join('');
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

  // ── people and comments ────────────────────────────────────────────────

  // The mention roster: everyone in Slack when a token is configured, plus
  // anyone who has used the calendar. Fetched once per page rather than per
  // event -- it is the same list every time, and the picker has to feel
  // instant to be worth using.
  var peopleLoaded = null;
  function loadPeople() {
    if (!peopleLoaded) {
      peopleLoaded = api('/api/people')
        .then(function (r) {
          state.people = r.people || [];
          state.slack = { configured: !!r.slackConfigured, status: r.slackStatus || null };
          return state.people;
        })
        .catch(function () { state.people = []; return state.people; });
    }
    return peopleLoaded;
  }

  function personName(email) {
    var p = state.people.filter(function (x) { return x.email === email; })[0];
    return p ? p.name : (String(email || '').split('@')[0] || email);
  }

  function commentMentions(c) {
    return c.mentions ? c.mentions.split(',').filter(Boolean) : [];
  }

  function whenStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return iso.slice(0, 10);
    return MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate()
      + ', ' + hhmm(pad(d.getHours()) + ':' + pad(d.getMinutes()));
  }

  // A mention that quietly fails to deliver is indistinguishable from a
  // calendar that is working -- people come to rely on the ping and never learn
  // it stopped arriving. If the last attempt had a problem, say so where the
  // next one is about to be written.
  function slackWarnHtml() {
    var st = state.slack.status;
    if (!state.slack.configured || !st || !st.errors || !st.errors.length) return '';
    var first = st.errors[0];
    return '<div class="cmt-warn"><strong>Slack mentions are not being delivered.</strong> '
      + esc(first.email ? first.email + ': ' + first.error : first.error)
      + (st.hint ? '<br>' + esc(st.hint) : '') + '</div>';
  }

  function commentHtml(c) {
    var mine = c.author === state.me.email;
    var mentions = commentMentions(c);
    return '<div class="cmt" data-cmt="' + esc(c.id) + '">'
      + '<div class="cmt-head">'
      + '<span class="cmt-who">' + esc(personName(c.author)) + '</span>'
      + '<span class="cmt-when">' + esc(whenStamp(c.created_at)) + '</span>'
      + ((mine || state.me.canEdit)
          ? '<button type="button" class="cmt-x" data-cmt="' + esc(c.id)
            + '" title="Delete this comment">×</button>'
          : '')
      + '</div>'
      + '<div class="cmt-body">' + esc(c.body) + '</div>'
      + (mentions.length
          ? '<div class="cmt-tags">' + mentions.map(function (m) {
              return '<span class="cmt-tag">@' + esc(personName(m)) + '</span>';
            }).join('') + '</div>'
          : '')
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
    add('Shape', it.social_type ? esc(labelIn(tax('socialTypes'), it.social_type)) : '');
    add('Channels', chips(listOf(it, 'channels'), tax('channels'), false));
    add('About', it.pillar ? esc(labelIn(tax('pillars'), it.pillar)) : '');
    add('Work', chips(listOf(it, 'production'), tax('production'), false));
    add('Caption', it.caption ? '<span class="det-notes">' + esc(it.caption) + '</span>' : '');
    add('Tags', esc(it.tags || ''));
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
    var prods = productsOf(it);
    add('Product highlights', prods.length
      ? '<div class="det-prods">' + prods.map(function (p) {
          var line = esc(productLine(p));
          return '<div class="det-prod">'
            + (p.url ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + line + '</a>'
                     : '<span>' + line + '</span>')
            + '</div>';
        }).join('') + '</div>'
      : '');
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
      + (stamp ? '<div class="det-stamp">' + stamp + '</div>' : '')
      // Anyone who can open the calendar can post: a comment changes no event
      // data, and a calendar only seven people may ask a question on is a
      // noticeboard rather than a conversation.
      + '<div class="cmt-wrap">'
      + '<h4 class="cmt-h">Comments</h4>'
      + '<div class="cmt-list" id="cmtList"><span class="muted">Loading\u2026</span></div>'
      + '<div id="cmtWarn"></div>'
      + (state.me.email
          ? '<div class="cmt-new">'
            + '<textarea id="cmtBody" maxlength="4000" rows="2" '
            + 'placeholder="Add a comment. Type @ to notify someone."></textarea>'
            + '<div class="cmt-pick" id="cmtPick" hidden></div>'
            + '<div class="cmt-foot">'
            + '<span class="cmt-note" id="cmtNote"></span>'
            + '<button type="button" class="cal-btn small primary" id="cmtPost">Post</button>'
            + '</div></div>'
          : '')
      + '</div>';

    var foot = state.me.canEdit
      ? '<button class="cal-btn danger" data-act="delete" data-id="' + esc(it.id) + '">Delete</button>'
        + '<div class="grow"></div>'
        + '<button class="cal-btn" data-act="close">Close</button>'
        + '<button class="cal-btn primary" data-act="edit" data-id="' + esc(it.id) + '">Edit</button>'
      : '<div class="grow"></div><button class="cal-btn" data-act="close">Close</button>';

    openModal('Event', body, foot);

    state.comments = [];
    function paintComments() {
      var box = $('#cmtList');
      if (!box) return;
      box.innerHTML = state.comments.length
        ? state.comments.map(commentHtml).join('')
        : '<p class="hint">No comments yet.</p>';
    }
    // The roster first, so a comment never renders a raw address for a second
    // and then swaps it for a name.
    loadPeople()
      .then(function () {
        var warn = $('#cmtWarn');
        if (warn) warn.innerHTML = slackWarnHtml();
        return api('/api/items/' + id + '/comments');
      })
      .then(function (r) { state.comments = r.comments || []; paintComments(); })
      .catch(function () {
        var box = $('#cmtList');
        if (box) box.innerHTML = '<p class="hint">Comments could not be loaded.</p>';
      });

    wireComments(id, paintComments);
  }

  // Mentions are picked, never parsed out of the text: a typed "@amy" is a
  // string, and guessing which Amy it meant is how the wrong person gets
  // pinged. Picking from the list is what puts an address on the comment.
  function wireComments(itemId, paintComments) {
    var box = $('#cmtBody');
    var picked = [];

    function note() {
      var el = $('#cmtNote');
      if (!el) return;
      el.innerHTML = picked.length
        ? 'Notifying ' + picked.map(function (e) {
            return '<span class="cmt-tag">@' + esc(personName(e))
              + '<button type="button" class="cmt-untag" data-who="' + esc(e) + '">\u00d7</button></span>';
          }).join('')
        : '';
    }

    function closePicker() {
      var p = $('#cmtPick');
      if (p) { p.hidden = true; p.innerHTML = ''; }
    }

    function openPicker(term) {
      var p = $('#cmtPick');
      if (!p) return;
      var hits = state.people.filter(function (x) {
        return picked.indexOf(x.email) < 0
          && (x.name.toLowerCase().indexOf(term) >= 0 || x.email.indexOf(term) >= 0);
      }).slice(0, 8);
      if (!hits.length) return closePicker();
      p.innerHTML = hits.map(function (x) {
        return '<button type="button" class="cmt-opt" data-who="' + esc(x.email) + '">'
          + '<span class="cmt-opt-n">' + esc(x.name) + '</span>'
          + '<span class="cmt-opt-e">' + esc(x.email) + '</span>'
          + (x.slack_id ? '<span class="cmt-opt-s" title="Will be sent a Slack DM">Slack</span>' : '')
          + '</button>';
      }).join('');
      p.hidden = false;
    }

    if (box) {
      box.oninput = function () {
        // The @ being typed right now: the last one with no space after it.
        var upto = box.value.slice(0, box.selectionStart);
        var m = upto.match(/@([^\s@]*)$/);
        if (!m) return closePicker();
        openPicker(m[1].toLowerCase());
      };
      box.onblur = function () { setTimeout(closePicker, 150); };
    }

    $('#modalBody').onclick = function (e) {
      var opt = e.target.closest('.cmt-opt');
      if (opt) {
        e.preventDefault();
        if (picked.indexOf(opt.dataset.who) < 0) picked.push(opt.dataset.who);
        // Take the half-typed @term back out -- the mention is on the comment
        // now, so leaving "@am" in the text would read as a second one.
        if (box) {
          var upto = box.value.slice(0, box.selectionStart);
          box.value = upto.replace(/@[^\s@]*$/, '') + box.value.slice(box.selectionStart);
          box.focus();
        }
        closePicker();
        return note();
      }
      var untag = e.target.closest('.cmt-untag');
      if (untag) {
        e.preventDefault();
        picked = picked.filter(function (x) { return x !== untag.dataset.who; });
        return note();
      }
      var post = e.target.closest('#cmtPost');
      if (post) {
        e.preventDefault();
        var text = box ? box.value.trim() : '';
        if (!text) return;
        post.disabled = true;
        api('/api/items/' + itemId + '/comments', {
          method: 'POST',
          body: JSON.stringify({ body: text, mentions: picked }),
        }).then(function (r) {
          state.comments = state.comments.concat([r.comment]);
          box.value = '';
          picked = [];
          note();
          paintComments();
        }).catch(function (err) {
          alert(err.message);
        }).then(function () { post.disabled = false; });
        return;
      }
      var del = e.target.closest('.cmt-x');
      if (del) {
        e.preventDefault();
        if (!confirm('Delete this comment?')) return;
        del.disabled = true;
        api('/api/comments/' + del.dataset.cmt, { method: 'DELETE' })
          .then(function () {
            state.comments = state.comments.filter(function (c) { return c.id !== del.dataset.cmt; });
            paintComments();
          })
          .catch(function (err) { del.disabled = false; alert(err.message); });
      }
    };
  }

  // ── add / edit form ────────────────────────────────────────────────────

  // Adding is an interview: one question at a time, in the order of the
  // decision tree, with later questions shaped by earlier answers. Editing is
  // not -- every answer already exists, so the whole form is shown at once and
  // you go straight to the field you came to change.
  function showForm(existing, defaultDate) {
    var it = existing || {
      title: '', event_type: 'event', department: '', departments: '',
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

      // Social asks an entirely different set of questions from an event, so it
      // gets a step of its own rather than more optional boxes bolted onto
      // "Anything else?". Everything here is cleared on save for a kind that
      // never showed it.
      + sect('social', 'What is the post?', '',
          '<div class="fld"><label>Shape</label><div class="chk-grid">'
          + tax('socialTypes').map(function (x) {
              return '<label class="fld-inline"><input type="radio" name="f-stype" class="f-stype" '
                + 'value="' + esc(x.key) + '"' + (x.key === it.social_type ? ' checked' : '') + '>'
                + esc(x.label) + '</label>';
            }).join('')
          + '</div></div>'
          + '<div class="fld"><label>Channels <span class="lbl-note">one or several</span></label>'
          + '<div class="chk-grid">'
          + tax('channels').map(function (x) {
              return '<label class="fld-inline"><input type="checkbox" class="f-chan" value="'
                + esc(x.key) + '"' + (listOf(it, 'channels').indexOf(x.key) >= 0 ? ' checked' : '')
                + '>' + esc(x.label) + '</label>';
            }).join('')
          + '</div></div>'
          + '<div class="fld"><label for="f-pillar">What is it about? <span class="lbl-note">optional</span></label>'
          + '<select id="f-pillar"><option value="">\u2014</option>'
          + tax('pillars').map(function (x) {
              return '<option value="' + esc(x.key) + '"'
                + (x.key === it.pillar ? ' selected' : '') + '>' + esc(x.label) + '</option>';
            }).join('')
          + '</select></div>'
          + '<div class="fld"><label for="f-caption">Caption</label>'
          + '<textarea id="f-caption" maxlength="4000" placeholder="The copy that goes out.">'
          + esc(it.caption || '') + '</textarea></div>'
          + '<div class="fld"><label for="f-tags">Tags and handles <span class="lbl-note">optional</span></label>'
          + '<input type="text" id="f-tags" maxlength="500" value="' + esc(it.tags || '')
          + '" placeholder="#TheJettyLife @someone"></div>'
          + '<h4 class="step-q sub">Where the work stands '
          + '<span class="lbl-note">not whether it is happening \u2014 that is Status</span></h4>'
          + '<div class="chk-grid">'
          + tax('production').map(function (x) {
              return '<label class="fld-inline"><input type="checkbox" class="f-prod" value="'
                + esc(x.key) + '"' + (listOf(it, 'production').indexOf(x.key) >= 0 ? ' checked' : '')
                + '>' + esc(x.label) + '</label>';
            }).join('')
          + '</div>')

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
          // Product highlights sit in step 9 rather than a step of their own:
          // most events have none, and an interview question that is usually
          // skipped is worse than a section you can ignore. Hidden outright on
          // a meeting, which stores none.
          + '<div class="fld" id="prodWrap">'
          + '<label>Product highlights <span class="lbl-note">optional</span></label>'
          + '<div class="hint">Division is the only required part. Category and SKU are '
          + 'free text \u2014 there is no product list to pick from \u2014 and the link points '
          + 'at the category or product page on jettylife.com.</div>'
          + '<div class="prod-rows" id="prodRows"></div>'
          + '<button type="button" class="cal-btn small" id="prodAdd">+ Add a highlight</button>'
          + '</div>'
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
          + '<div class="att-queue" id="attQueue"></div>'
          + '<label class="att-pick"><input type="file" id="f-files" multiple>'
          + '<span>Choose files\u2026</span></label>'
          + '<span class="att-drop-note">or drop them here</span>'
          + '<div class="hint">Up to 10 MB each. Everyone who can open the calendar can '
          + 'download them; only editors can add or remove.</div>'
          + '</div></div>');

    openModal(existing ? 'Edit event' : 'Add event', body, '');

    // ── what the answers so far make relevant ────────────────────────────
    function kind() {
      var el = document.querySelector('.f-kind:checked');
      return el ? el.value : 'event';
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
    // Five kinds, five sets of questions. Each one asks what that kind actually
    // has and nothing else -- a post has no venue, a deadline has no end date,
    // a meeting has neither.
    function activeSteps() {
      var k = kind();
      if (k === 'meeting' || k === 'deadline') return ['kind', 'title', 'dept', 'when', 'final'];

      var out = ['kind', 'title', 'dept', 'extra'];
      if (subsAvailable().length) out.push('subs');

      // Online only: no venue, no van, no extra staff. It keeps its sub-types,
      // because a Collab post really is a collab, and it keeps the product
      // highlights, which is half of why a product post exists.
      if (k === 'social') { out.push('social', 'when', 'final'); return out; }

      // A shoot happens somewhere, so Marketing is asked where -- but staff,
      // permits and vans are an Event's concern.
      if (k === 'marketing') { out.push('when', 'where', 'final'); return out; }

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

      var prodWrap = $('#prodWrap');
      var k = kind();
      if (prodWrap) prodWrap.hidden = k === 'meeting' || k === 'deadline';

      // A deadline falls on a day; it does not run until one. The end date is
      // hidden and kept in step with the start rather than left to disagree.
      var endWrap = $('#f-end') ? $('#f-end').closest('.fld') : null;
      if (endWrap) endWrap.hidden = k === 'deadline';
      if (k === 'deadline' && $('#f-end') && $('#f-start')) $('#f-end').value = $('#f-start').value;

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
    // The example images cannot go up until the event has an id, exactly like
    // the general attachments. The save path collects them from here.
    showForm.pendingImages = function () { return prodImages; };
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
      // The example images belong to their highlight row, not to the general
      // list -- showing them twice would offer two Remove buttons for one file.
      var loose = state.attachments.filter(function (a) { return !a.slot; });
      box.innerHTML = loose.length
        ? attachHtml(loose, true)
        : '<p class="hint">Nothing attached yet.</p>';
    }
    if (existing) {
      state.attachments = [];
      paintFiles();
      api('/api/items/' + existing.id).then(function (r) {
        state.attachments = r.attachments || [];
        paintFiles();
        paintProds();
      }).catch(function () {});
    }

    // ── product highlights ───────────────────────────────────────────────

    // Rows live here rather than being read back out of the DOM on every
    // keystroke: a row carries an id that an example image names before either
    // of them has been saved, and repainting must not invent a new one.
    var prodRows = productsOf(it).map(function (p) {
      return { id: p.id || rowId(), division: p.division || '', category: p.category || '',
               sku: p.sku || '', url: p.url || '' };
    });
    // rowId -> File, waiting for the event to exist before it can be uploaded.
    var prodImages = {};

    function readProdRows() {
      Array.prototype.forEach.call(document.querySelectorAll('.prod-row'), function (el) {
        var row = prodRows.filter(function (r) { return r.id === el.dataset.row; })[0];
        if (!row) return;
        row.division = el.querySelector('.p-div').value;
        row.category = el.querySelector('.p-cat').value.trim();
        row.sku = el.querySelector('.p-sku').value.trim();
        row.url = el.querySelector('.p-url').value.trim();
      });
      return prodRows;
    }

    // An image already uploaded against this row. Served as a download rather
    // than shown inline: attachments come back as octet-stream with a
    // disposition header on purpose, and relaxing that to render a thumbnail
    // would undo the one thing keeping an uploaded file from running in the
    // calendar's own origin. A file not yet uploaded is a local File, so it
    // previews safely.
    function savedImage(id) {
      return state.attachments.filter(function (a) { return a.slot === id; })[0];
    }

    function prodImageHtml(row) {
      var pending = prodImages[row.id];
      if (pending) {
        return '<span class="prod-img-has">'
          + '<img src="' + URL.createObjectURL(pending) + '" alt="">'
          + '<span class="prod-img-n">' + esc(pending.name) + '</span>'
          + '<button type="button" class="prod-img-x" data-row="' + esc(row.id) + '">\u00d7</button>'
          + '</span>';
      }
      var saved = savedImage(row.id);
      if (saved) {
        return '<span class="prod-img-has">'
          + '<a href="/api/attachments/' + esc(saved.id) + '">' + esc(saved.name) + '</a>'
          + '<button type="button" class="att-x prod-img-x" data-att="' + esc(saved.id) + '">\u00d7</button>'
          + '</span>';
      }
      return '<label class="prod-img"><input type="file" class="p-img" accept="image/*" '
        + 'data-row="' + esc(row.id) + '"><span>Example\u2026</span></label>';
    }

    function paintProds() {
      var box = $('#prodRows');
      if (!box) return;
      box.innerHTML = prodRows.map(function (row) {
        return '<div class="prod-row" data-row="' + esc(row.id) + '">'
          + '<select class="p-div">'
          + '<option value="">Division\u2026</option>'
          + tax('divisions').map(function (d) {
              return '<option value="' + esc(d.key) + '"'
                + (d.key === row.division ? ' selected' : '') + '>' + esc(d.label) + '</option>';
            }).join('')
          + '</select>'
          + '<input type="text" class="p-cat" maxlength="120" placeholder="Category" value="'
          + esc(row.category) + '">'
          + '<input type="text" class="p-sku" maxlength="120" placeholder="SKU / style" value="'
          + esc(row.sku) + '">'
          + '<input type="url" class="p-url" maxlength="500" placeholder="jettylife.com link" value="'
          + esc(row.url) + '">'
          + prodImageHtml(row)
          + '<button type="button" class="prod-x" data-row="' + esc(row.id) + '" '
          + 'title="Remove this highlight">\u00d7</button>'
          + '</div>';
      }).join('') || '<p class="hint">None yet.</p>';
    }

    // Hoisting makes paintProds callable earlier than this; prodRows above is a
    // var, so it would still be undefined. Paint once the state exists.
    paintProds();

    // Files picked or dropped but not yet uploaded. The file input is the one
    // source of truth -- the save path reads it -- so a drop writes into it via
    // DataTransfer rather than keeping a second list that could disagree.
    //
    // Before this, choosing files gave no feedback at all: you picked three,
    // the box looked exactly the same, and you found out what you had attached
    // after saving.
    function queued() {
      var input = $('#f-files');
      return input ? Array.prototype.slice.call(input.files) : [];
    }

    function setQueue(files) {
      var input = $('#f-files');
      if (!input || typeof DataTransfer === 'undefined') return false;
      var dt = new DataTransfer();
      files.forEach(function (f) { dt.items.add(f); });
      input.files = dt.files;
      paintQueue();
      return true;
    }

    function paintQueue() {
      var box = $('#attQueue');
      if (!box) return;
      var files = queued();
      box.innerHTML = files.map(function (f, i) {
        return '<span class="att-q"><span class="att-qn">' + esc(f.name) + '</span>'
          + '<span class="att-qs">' + fileSize(f.size) + '</span>'
          + '<button type="button" class="att-qx" data-q="' + i + '" '
          + 'title="Do not attach this one">\u00d7</button></span>';
      }).join('');
    }

    var dropBox = $('#attBox');
    if (dropBox) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dropBox.addEventListener(ev, function (e) {
          e.preventDefault();
          dropBox.classList.add('drag');
        });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        dropBox.addEventListener(ev, function (e) {
          // Moving over a child fires dragleave on the box; only a pointer that
          // has actually left it should drop the highlight.
          if (e.target !== dropBox && dropBox.contains(e.relatedTarget)) return;
          dropBox.classList.remove('drag');
        });
      });
      dropBox.addEventListener('drop', function (e) {
        e.preventDefault();
        dropBox.classList.remove('drag');
        var dropped = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
        if (!dropped.length) return;
        if (!setQueue(queued().concat(dropped))) {
          formError('This browser cannot take dropped files. Use "Choose files" instead.');
        }
      });
    }

    // Assigned rather than added: #modalBody outlives the form, so
    // addEventListener stacks a fresh handler every time the form is opened.
    // Three opens meant one click on a remove button firing three deletes.
    $('#modalBody').onclick = function (e) {
      var drop = e.target.closest('.att-qx');
      if (drop) {
        e.preventDefault();
        var keep = queued().filter(function (f, i) { return i !== Number(drop.dataset.q); });
        setQueue(keep);
        return;
      }
      if (e.target.closest('#prodAdd')) {
        e.preventDefault();
        readProdRows();
        prodRows.push({ id: rowId(), division: '', category: '', sku: '', url: '' });
        paintProds();
        return;
      }
      var rm = e.target.closest('.prod-x');
      if (rm) {
        e.preventDefault();
        readProdRows();
        prodRows = prodRows.filter(function (r) { return r.id !== rm.dataset.row; });
        delete prodImages[rm.dataset.row];
        paintProds();
        return;
      }
      var unpick = e.target.closest('.prod-img-x');
      if (unpick && unpick.dataset.row) {
        e.preventDefault();
        readProdRows();
        delete prodImages[unpick.dataset.row];
        paintProds();
        return;
      }

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
          paintProds();
        })
        .catch(function (err) { x.disabled = false; formError(err.message); });
    };

    $('#modalBody').onchange = function (e) {
      if (e.target.classList.contains('f-kind')) return paint();
      if (e.target.classList.contains('f-dept')) { paintExtras(); paintScoped(); return paint(); }
      if (e.target.classList.contains('f-extra')) { paintScoped(); return paint(); }
      if (e.target.classList.contains('f-need')) return paintStaff();
      if (e.target.id === 'f-allday') { $('#timeRow').hidden = e.target.checked; return; }
      if (e.target.id === 'f-start') {
        if (kind() === 'deadline' && $('#f-end')) $('#f-end').value = e.target.value;
        return startChanged(e.target);
      }
      if (e.target.id === 'f-files') return paintQueue();
      if (e.target.classList.contains('p-img')) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        readProdRows();
        prodImages[e.target.dataset.row] = f;
        return paintProds();
      }
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
    // Read straight off the rows: each carries its own id, which an example
    // image already names, so there is no second copy to drift out of step.
    var products = Array.prototype.map.call(document.querySelectorAll('.prod-row'),
      function (el) {
        return {
          id: el.dataset.row,
          division: el.querySelector('.p-div').value,
          category: el.querySelector('.p-cat').value,
          sku: el.querySelector('.p-sku').value,
          url: el.querySelector('.p-url').value,
        };
      });
    return {
      products: products,
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
      social_type: one('.f-stype:checked'),
      channels: vals('.f-chan:checked'),
      pillar: $('#f-pillar') ? $('#f-pillar').value : '',
      production: vals('.f-prod:checked'),
      caption: $('#f-caption') ? $('#f-caption').value : '',
      tags: $('#f-tags') ? $('#f-tags').value : '',
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

  // ── export ─────────────────────────────────────────────────────────────

  // The chips are the filter. Whatever is on screen is what leaves in the file,
  // so there is no second filtering language to learn and no way for the export
  // to disagree with the calendar it was taken from.
  //
  // This exists for partners -- Sunnyside pulling a slice into their own
  // systems -- so the columns carry labels rather than internal keys, and the
  // file is plain CSV every spreadsheet and ad platform already reads.
  var EXPORT_RANGES = [
    { key: 'all',   label: 'Every date in the calendar' },
    { key: 'year',  label: 'This year' },
    { key: 'month', label: 'The month on screen' },
    { key: 'ahead', label: 'From today onwards' },
  ];

  function exportWindow(key) {
    var c = state.cursor;
    if (key === 'month') {
      return { from: ymd(new Date(c.getFullYear(), c.getMonth(), 1)),
               to:   ymd(new Date(c.getFullYear(), c.getMonth() + 1, 0)) };
    }
    if (key === 'year') {
      return { from: c.getFullYear() + '-01-01', to: c.getFullYear() + '-12-31' };
    }
    if (key === 'ahead') return { from: todayYmd(), to: '' };
    return { from: '', to: '' };
  }

  // An event counts as inside the window when it overlaps it, not when it
  // starts in it -- the same rule the month grid uses, so a festival already
  // running on the first of the month is not silently dropped.
  function exportRows(rangeKey) {
    var w = exportWindow(rangeKey);
    return visible().filter(function (it) {
      if (w.from && it.end_date < w.from) return false;
      if (w.to && it.start_date > w.to) return false;
      return true;
    });
  }

  var EXPORT_COLS = [
    ['Name',               function (it) { return it.title; }],
    ['Status',             function (it) { return it.status; }],
    ['Event Type',         function (it) { return labelIn(tax('eventTypes'), it.event_type); }],
    ['Department',         function (it) { return it.department ? deptLabel(it.department) : ''; }],
    ['Also Involved',      function (it) { return extraDeptsOf(it).map(deptLabel).join('; '); }],
    ['Sub-types',          function (it) {
      return subsOf(it).map(function (k) { return labelIn(tax('subTypes'), k); }).join('; '); }],
    ['Needs',              function (it) {
      return needsOf(it).map(function (k) { return labelIn(tax('needs'), k); }).join('; '); }],
    ['Staff Needed',       function (it) { return it.staff_count || ''; }],
    ['Vehicles',           function (it) {
      return vehiclesOf(it).map(function (k) { return labelIn(tax('vehicles'), k); }).join('; '); }],
    ['Start Date',         function (it) { return it.start_date; }],
    ['End Date',           function (it) { return it.end_date; }],
    ['All Day',            function (it) { return it.all_day ? 'Yes' : 'No'; }],
    ['Start Time',         function (it) { return it.all_day ? '' : hhmm(it.start_time); }],
    ['End Time',           function (it) { return it.all_day ? '' : hhmm(it.end_time); }],
    ['Venue',              function (it) { return it.venue; }],
    ['Address',            function (it) { return it.address; }],
    ['City',               function (it) { return it.city; }],
    ['State',              function (it) { return it.state; }],
    ['Zip',                function (it) { return it.zip; }],
    ['Retail Year',        function (it) { return it.retail ? it.retail.year : ''; }],
    ['Retail Week',        function (it) { return it.retail ? it.retail.week : ''; }],
    ['Notes',              function (it) { return it.notes; }],
    ['URL',                function (it) { return it.url; }],
    ['Shape',              function (it) { return labelIn(tax('socialTypes'), it.social_type); }],
    ['Channels',           function (it) {
      return listOf(it, 'channels').map(function (k) {
        return labelIn(tax('channels'), k); }).join('; '); }],
    ['About',              function (it) { return labelIn(tax('pillars'), it.pillar); }],
    ['Work',               function (it) {
      return listOf(it, 'production').map(function (k) {
        return labelIn(tax('production'), k); }).join('; '); }],
    ['Caption',            function (it) { return it.caption; }],
    ['Tags',               function (it) { return it.tags; }],
    ['Product Highlights', function (it) {
      return productsOf(it).map(productLine).join('; '); }],
    ['Product Links',      function (it) {
      return productsOf(it).map(function (p) { return p.url; }).filter(Boolean).join('; '); }],
    ['Attachments',        function (it) { return it.attachment_count || 0; }],
  ];

  // A cell opening with = + - @ is a formula to Excel and Sheets, not text, and
  // this file is going to somebody outside the company. Quote it so it is read
  // as what it says.
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /["\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv(rows) {
    var lines = [EXPORT_COLS.map(function (c) { return csvCell(c[0]); }).join(',')];
    rows.forEach(function (it) {
      lines.push(EXPORT_COLS.map(function (c) { return csvCell(c[1](it)); }).join(','));
    });
    // The BOM is what makes Excel read this as UTF-8 rather than mangling an
    // accented venue name.
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function exportName(rangeKey) {
    var bits = ['jetty-calendar'];
    AXES.forEach(function (axis) {
      state.sel[axis].forEach(function (key) {
        bits.push(slug(selLabel(axis, key)));
      });
    });
    if (rangeKey !== 'all') bits.push(rangeKey);
    bits.push(todayYmd());
    return bits.join('-') + '.csv';
  }

  function slug(v) {
    return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Freed on the next tick -- revoking it straight away races the download in
    // some browsers and produces an empty file.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportScopeText() {
    var active = [];
    AXES.forEach(function (axis) {
      state.sel[axis].forEach(function (key) { active.push(selLabel(axis, key)); });
    });
    return active.length
      ? 'Filtered to <strong>' + esc(active.join(' + ')) + '</strong>.'
      : 'No filters are on, so this is the whole calendar. '
        + 'Set the chips first if the partner only needs a slice.';
  }

  function renderExportCounts() {
    var picked = $('input[name="xrange"]:checked');
    var key = picked ? picked.value : 'all';
    var el = $('#xCount');
    if (!el) return;
    var n = exportRows(key).length;
    el.textContent = n === 1 ? '1 event' : n + ' events';
    var btn = $('#xGo');
    if (btn) btn.disabled = !n;
  }

  function showExport() {
    var body = '<p class="modal-lede">' + exportScopeText() + ' '
      + 'The file is CSV — one row per event, with the same labels the calendar '
      + 'shows. Nothing leaves the building until you send it.</p>'
      + '<div class="fld"><label>Dates</label><div class="chk-grid">'
      + EXPORT_RANGES.map(function (r, i) {
          return '<label class="fld-inline"><input type="radio" name="xrange" value="'
            + r.key + '"' + (i ? '' : ' checked') + '> ' + esc(r.label) + '</label>';
        }).join('')
      + '</div></div>'
      + '<div class="fld"><label>What comes out<span class="lbl-note" id="xCount">—</span></label>'
      + '<div class="sub-url">' + EXPORT_COLS.map(function (c) { return esc(c[0]); }).join(', ')
      + '</div></div>';
    var foot = '<div class="grow"></div>'
      + '<button class="cal-btn" data-act="close">Cancel</button>'
      + '<button class="cal-btn primary" id="xGo" data-act="export">Download CSV</button>';
    openModal('Export events', body, foot);
    // Assigned, not added: #modalBody outlives every modal opened in it, so
    // addEventListener would stack a handler per open.
    $('#modalBody').onchange = renderExportCounts;
    renderExportCounts();
  }

  // Calendar sync is a setting, not a snapshot of the chips. The chips change
  // a dozen times an hour; a subscription is something you set once. So each
  // person gets one stable link and a saved choice of what it carries -- edit
  // the settings and the subscription Google already has starts delivering the
  // new slice, with nothing to re-add.
  //
  // Subscribing to all 588 events, a hundred of them emails and a hundred SMS
  // sends, buries the reader's own diary. That is the problem this solves.
  var syncState = { url: '', filters: {} };
  var SYNC_AXES = [
    { param: 'dept', title: 'Departments', list: function () { return tax('departments'); } },
    { param: 'kind', title: 'Kind', list: function () { return tax('eventTypes'); } },
    { param: 'sub', title: 'Marketing sub-types', list: function () { return tax('subTypes'); } },
    { param: 'status', title: 'Status',
      list: function () {
        return tax('statuses').map(function (st) { return { key: st, label: st }; });
      } },
  ];

  function syncPicked(param) {
    var v = syncState.filters[param];
    return Array.isArray(v) ? v : [];
  }

  function syncBody() {
    return SYNC_AXES.map(function (axis) {
      var picked = syncPicked(axis.param);
      return '<div class="fld"><label>' + esc(axis.title)
        + '<span class="lbl-note">'
        + (picked.length ? picked.length + ' chosen' : 'nothing ticked \u2014 everything')
        + '</span></label><div class="chk-grid">'
        + axis.list().map(function (x) {
            return '<label class="fld-inline"><input type="checkbox" class="sync-opt" '
              + 'data-param="' + axis.param + '" value="' + esc(x.key) + '"'
              + (picked.indexOf(x.key) >= 0 ? ' checked' : '') + '>'
              + esc(x.label) + '</label>';
          }).join('')
        + '</div></div>';
    }).join('');
  }

  function readSync() {
    var out = {};
    Array.prototype.forEach.call(document.querySelectorAll('.sync-opt:checked'), function (el) {
      (out[el.dataset.param] = out[el.dataset.param] || []).push(el.value);
    });
    return out;
  }

  function paintSync() {
    var box = $('#syncBox');
    if (!box) return;
    var any = SYNC_AXES.some(function (a) { return syncPicked(a.param).length; });
    box.innerHTML =
      '<p class="modal-lede">This link is yours and it does not change. What it '
      + 'carries is set here &mdash; change it later and the calendar you have already added to '
      + 'Google simply starts showing the new selection.</p>'
      + '<div class="sub-url" id="feedUrl">' + esc(syncState.url || '') + '</div>'
      + (any
          ? ''
          : '<p class="sub-scope warn"><strong>Nothing ticked means everything</strong> &mdash; all '
            + state.items.length + ' events, including every Email/SMS send. That is a lot to '
            + 'put in a personal calendar. Tick the departments you work in.</p>')
      + '<p class="hint">Nothing ticked in a section means that section does not narrow anything. '
      + 'Ticking Box Truck and Meetings gives you both.</p>'
      + syncBody()
      + '<ol class="sub-steps">'
      + '<li>Copy the link.</li>'
      + '<li>Google Calendar &rarr; <strong>Other calendars</strong> &rarr; <strong>+</strong> '
      + '&rarr; <strong>From URL</strong>.</li>'
      + '<li>Paste and <strong>Add calendar</strong>. Google refreshes on its own schedule, often '
      + 'a few hours &mdash; this page is always current.</li>'
      + '</ol>'
      + '<p class="hint">Treat the link like a password: anyone holding it can read your slice '
      + 'without signing in. <strong>Reset link</strong> issues a new one and stops the old one '
      + 'working, for you alone.</p>';
  }

  function showSubscribe() {
    openModal('Your calendar sync',
      '<div id="syncBox"><p class="modal-lede">Loading\u2026</p></div>',
      '<button class="cal-btn danger" data-act="feed-reset">Reset link</button>'
      + '<div class="grow"></div>'
      + '<button class="cal-btn" data-act="copy">Copy link</button>'
      + '<button class="cal-btn primary" data-act="close">Done</button>');

    api('/api/feed').then(function (r) {
      if (!r.url) {
        $('#syncBox').innerHTML = '<p class="modal-lede">Calendar sync is not switched on yet. '
          + 'It needs <code>FEED_ORIGIN</code> set on this Worker and the feed Worker deployed.</p>';
        return;
      }
      syncState = { url: r.url, filters: r.filters || {} };
      paintSync();
    }).catch(function (err) {
      $('#syncBox').innerHTML = '<p class="modal-lede">' + esc(err.message) + '</p>';
    });
  }

  // Saved as you tick, so there is no Save button to forget and no way to close
  // the panel believing a change took when it did not.
  function saveSync() {
    syncState.filters = readSync();
    paintSync();
    api('/api/feed', {
      method: 'PUT',
      body: JSON.stringify({ filters: syncState.filters }),
    }).catch(function (err) {
      var box = $('#syncBox');
      if (box) box.insertAdjacentHTML('afterbegin',
        '<p class="form-err" style="display:block">Could not save that: ' + esc(err.message) + '</p>');
    });
  }

  // ── API ────────────────────────────────────────────────────────────────

  // A Cloudflare Access session expires while the page stays open. The next
  // save is then redirected to a sign-in page on another origin, the browser
  // refuses to let us read it, and fetch rejects with a bare "Failed to fetch"
  // -- which tells the person nothing and looks like the calendar is broken.
  // Both that and an HTML response where JSON was expected mean the same thing,
  // and both get an answer someone can act on.
  var SIGNED_OUT = 'Your sign-in has expired. Reload the page \u2014 your changes are still '
    + 'in this form until you do.';

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'content-type': 'application/json' },
      // Do not quietly follow Access's redirect to the login page; a redirect
      // here is the signal, not something to chase.
      redirect: 'manual',
    }, opts || {}))
      .then(function (res) {
        if (res.type === 'opaqueredirect' || res.redirected
            || res.status === 0 || res.status === 302) {
          throw new Error(SIGNED_OUT);
        }
        var type = res.headers.get('content-type') || '';
        if (type.indexOf('application/json') < 0) {
          throw new Error(res.ok ? SIGNED_OUT
            : 'The calendar answered with an error (' + res.status + ').');
        }
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) {
            var err = new Error(body.error || ('Request failed (' + res.status + ')'));
            err.problems = body.problems;
            throw err;
          }
          return body;
        });
      }, function (err) {
        // fetch itself rejected: no response at all. Offline, or the redirect
        // above blocked before we could look at it.
        throw new Error(navigator.onLine === false
          ? 'You appear to be offline. The change has not been saved.'
          : SIGNED_OUT);
      });
  }

  // One at a time rather than in parallel: a handful of 10 MB files fired at
  // once is the sort of thing that gets a Worker rate-limited, and the order
  // they arrive in is the order they were picked.
  function uploadFiles(itemId, entries) {
    return entries.reduce(function (chain, entry) {
      var file = entry.file;
      return chain.then(function () {
        var headers = {
          'X-File-Name': encodeURIComponent(file.name).replace(/%20/g, ' '),
          'content-type': file.type || 'application/octet-stream',
        };
        // Which product highlight this one illustrates. Absent on an ordinary
        // attachment, which belongs to the event rather than to a row.
        if (entry.slot) headers['X-File-Slot'] = entry.slot;
        return fetch('/api/items/' + itemId + '/attachments', {
          method: 'POST',
          headers: headers,
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
    $('#exportBtn').addEventListener('click', showExport);

    // One handler for every chip: each carries the axis it belongs to and the
    // value it selects, so there are no special cases and a new chip is a line
    // in chipRows() rather than another listener here.
    $('#filterBar').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var axis = btn.dataset.axis;
      var key = btn.dataset.key;
      if (!axis || !state.sel[axis]) return;
      // One answer per level. A second chip on the same row replaces the first,
      // because they are alternatives; a chip on another row is kept, because
      // the levels narrow together. Clicking the lit one turns that level off.
      state.sel[axis] = state.sel[axis].indexOf(key) >= 0 ? [] : [key];
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

    // The sync panel lives in the modal body, which showForm also uses -- so
    // this listens on the modal itself and checks what was clicked.
    $('#modalBody').addEventListener('change', function (e) {
      if (e.target.classList && e.target.classList.contains('sync-opt')) saveSync();
    });

    $('#modalX').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    $('#modalFoot').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.dataset.act;

      if (act === 'close') return closeModal();

      // A new token: the old link stops working, for this person only.
      if (act === 'feed-reset') {
        if (!confirm('Issue a new link? The one you have already given out stops working.')) return;
        b.disabled = true;
        api('/api/feed', { method: 'POST' }).then(function (r) {
          syncState = { url: r.url, filters: r.filters || {} };
          paintSync();
          b.disabled = false;
        }).catch(function (err) { b.disabled = false; alert(err.message); });
        return;
      }

      // The interview rebuilds this footer on every step, so Back and Next are
      // handled here rather than bound to buttons that stop existing.
      if (act === 'next') return showForm.step(1);
      if (act === 'back') return showForm.step(-1);

      if (act === 'copy') {
        navigator.clipboard.writeText(syncState.url || '').then(function () {
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
        var picked = ($('#f-files') ? Array.prototype.slice.call($('#f-files').files) : [])
          .map(function (f) { return { file: f }; });
        var images = showForm.pendingImages ? showForm.pendingImages() : {};
        Object.keys(images).forEach(function (slot) {
          picked.push({ file: images[slot], slot: slot });
        });
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

      if (act === 'export') {
        var picked = $('input[name="xrange"]:checked');
        var key = picked ? picked.value : 'all';
        download(exportName(key), exportCsv(exportRows(key)));
        closeModal();
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
      }
      wire();
      return loadItems();
    })
    .then(function () {
      // The Slack DM links to /?event=<id>. Open it, and move the calendar to
      // the month it is in -- landing on today's month with the event off
      // screen behind a modal is worse than not linking at all.
      var want = new URLSearchParams(location.search).get('event');
      if (!want) return;
      var it = state.items.filter(function (x) { return x.id === want; })[0];
      if (!it) return;
      state.cursor = fromYmd(it.start_date);
      render();
      showDetail(want);
    })
    .catch(function (err) {
      $('#view').innerHTML = emptyHtml('The calendar could not load', esc(err.message));
    });
})();
