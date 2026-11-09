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
  // What the CHART leaves out, as exclusions rather than a list of what to
  // include. A set of included keys would silently drop a season added
  // after it was saved -- the chart would quietly stop drawing money that
  // is on the sheet, which is the one thing it must never do. Nothing
  // excluded means everything is drawn.
  var OFF = function () { return { kind: {}, season: {}, year: {} }; };

  var f = { q: '', season: '', kind: '', show: 'all', year: 0, off: OFF(),
            graph: false, graphBy: 'season' };
  // The row at the bottom of the sheet that is not a row yet. Kept out here
  // because the table is redrawn under it on every keystroke, and half a
  // typed season disappearing is the whole reason the prompt was tolerable.
  var nu = { label: '', kind: 'bulk', years: {}, note: '' };
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

  // What a line holds in years the columns cannot show. Nothing is ever
  // hidden by the window: the total counts every year, and a line with
  // money off-screen says so rather than looking like it does not add up.
  function outside(r) {
    var on = {};
    (D.years || []).forEach(function (y) { on[y] = true; });
    var n = 0;
    Object.keys(r.years || {}).forEach(function (y) {
      if (!on[y]) n += Number(r.years[y]) || 0;
    });
    return n;
  }

  var filtered = function () {
    return Boolean(f.q || f.season || f.kind || (f.show && f.show !== 'all'));
  };

  /**
   * What the chart's own tick boxes have left out, in words.
   *
   * Kept apart from filtered(), which is about the TABLE and is used to
   * decide whether the sheet says "shown" -- unticking a season on the
   * chart does not hide a row.
   *
   * It exists for the download. A PNG goes into a deck with nothing around
   * it, so a chart drawn from four of nine seasons has to say so on its own
   * face; otherwise it is read as the whole year and nobody can tell.
   */
  function narrowWords() {
    var out = [];
    var offKinds = Object.keys(f.off.kind);
    if (offKinds.length) {
      var on = (D.kinds || []).filter(function (k) { return !f.off.kind[k.key]; });
      out.push(on.length ? on.map(function (k) { return k.label; }).join(' and ')
        + ' only' : 'nothing');
    }
    var offYears = Object.keys(f.off.year);
    if (offYears.length) {
      var ys = ((D.years || []).map(String)).filter(function (y) { return !f.off.year[y]; });
      if (ys.length) out.push(ys.join(', '));
    }
    if (Object.keys(f.off.season).length && chartOffered.seasons.length) {
      // Counted from the boxes that were actually offered, so the number
      // here is the number of ticks on screen. Counting every season on the
      // sheet would say "6 of 13" beside eight boxes.
      var on = chartOffered.seasons.filter(function (x) { return !f.off.season[x.key]; });
      out.push(on.length + ' of ' + chartOffered.seasons.length + ' seasons');
    }
    return out;
  }

  function chartSub() {
    var words = narrowWords();
    return (filtered() ? 'the lines on screen' : 'every line')
      + (words.length ? ' \u00b7 ' + words.join(' \u00b7 ') : '');
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  // Season, kind, three years, the total, the note and the ×.
  function cols() { return 5 + ((D && D.years) || []).length; }

  function head() {
    return '<tr><th>Season</th><th>Bulk or SMS</th>'
      + (D.years || []).map(function (y) {
        return '<th class="cg-y' + (Number(y) === D.year ? ' is-budget' : '') + '">'
          + esc(y) + '</th>';
      }).join('')
      + '<th class="lb-tot">Total COGS</th>'
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
      + (D.years || []).map(function (y) {
        var v = (r.years || {})[y];
        return '<td class="cg-y' + (Number(y) === D.year ? ' is-budget' : '') + '">'
          + '<input class="bd-in lb-in cg-amt' + (v != null ? ' set' : '')
          + '" data-f="year" data-y="' + esc(y) + '" inputmode="numeric"'
          + ' aria-label="' + esc(y) + ' cost for ' + esc(r.seasonLabel || r.season) + ' '
          + esc(r.kind) + '"'
          + ' value="' + (v == null ? '' : comma(v)) + '"'
          + ' placeholder="—"></td>';
      }).join('')
      // Derived, so it is read rather than typed. Typing into a total whose
      // parts are beside it is how two of them end up disagreeing.
      + '<td class="bd-n lb-tot' + (outside(r) ? ' cg-out' : '') + '"'
      + (outside(r) ? ' title="' + esc(money(outside(r))) + ' of this sits in a year'
         + ' outside these columns. Change the year above to see it."' : '')
      + '>' + (r.amount == null ? '<span class="lb-none">—</span>' : money(r.amount))
      + (outside(r) ? '<span class="cg-flag">+</span>' : '') + '</td>'
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
    var off = list.reduce(function (a, r) { return a + outside(r); }, 0);
    return '<tr class="lb-foot"><td colspan="2">' + list.length
      + (list.length === 1 ? ' line' : ' lines') + (filtered() ? ' shown' : '')
      + '</td>'
      + (D.years || []).map(function (y) {
        var n = list.reduce(function (a, r) {
          return a + (Number((r.years || {})[y]) || 0);
        }, 0);
        return '<td class="bd-n cg-y' + (Number(y) === D.year ? ' is-budget' : '') + '">'
          + (n ? money(n) : '') + '</td>';
      }).join('')
      + '<td class="bd-n lb-tot' + (off ? ' cg-out' : '') + '"'
      + (off ? ' title="' + esc(money(off)) + ' of this sits in years outside'
         + ' these columns."' : '')
      + '>' + money(total) + (off ? '<span class="cg-flag">+</span>' : '') + '</td>'
      + '<td colspan="2"></td></tr>';
  }

  // A season somebody is typing, matched to one already on the sheet so
  // "ss25" does not become a second SS25 sitting beside the first.
  function knownSeason(label) {
    var want = String(label || '').trim().toLowerCase();
    if (!want) return null;
    var hit = (D.seasons || []).filter(function (x) {
      return String(x.label).toLowerCase() === want || x.key === slug(label);
    })[0];
    return hit || null;
  }

  function slug(label) {
    return String(label || '').trim().toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
  }

  /**
   * The entry row.
   *
   * Always at the bottom, never filtered out, and it keeps its place after
   * a line lands so a run of seasons can be typed without reaching for
   * anything. Season is a text box rather than a dropdown because a season
   * being backfilled is by definition one the sheet has not heard of --
   * with a datalist behind it, so one already here is a keystroke.
   */
  function addRow() {
    var known = knownSeason(nu.label);
    return '<tr class="cg-add">'
      + '<td><input id="nuSeason" class="bd-in lb-in" list="cgSeasons"'
      + ' autocomplete="off" placeholder="SS27, F26\u2026"'
      + ' aria-label="Which season to add"'
      + ' value="' + esc(nu.label) + '"></td>'
      + '<td><select id="nuKind" class="lb-sel set" aria-label="Bulk, SMS or both">'
      + '<option value="bulk"' + (nu.kind === 'bulk' ? ' selected' : '') + '>Bulk</option>'
      + '<option value="sms"' + (nu.kind === 'sms' ? ' selected' : '') + '>SMS</option>'
      + '<option value="both"' + (nu.kind === 'both' ? ' selected' : '') + '>Both</option>'
      + '</select></td>'
      // Both makes two lines, and a figure typed once cannot belong to two
      // of them -- splitting it across bulk and samples would be inventing
      // a number nobody said. So the figures are not offered rather than
      // taken and quietly dropped.
      + (D.years || []).map(function (y) {
        return '<td class="cg-y' + (Number(y) === D.year ? ' is-budget' : '') + '">'
          + '<input class="bd-in lb-in cg-amt" data-nu="' + esc(y) + '"'
          + (two() ? ' disabled title="' + esc(TWO_WHY) + '"' : '')
          + ' inputmode="numeric" aria-label="' + esc(y) + ' cost for the new line"'
          + ' value="' + (nu.years[y] == null ? '' : comma(nu.years[y])) + '"'
          + ' placeholder="\u2014"></td>';
      }).join('')
      + '<td class="bd-n lb-tot">' + (nuTotal() == null
        ? '<span class="lb-none">\u2014</span>' : money(nuTotal())) + '</td>'
      + '<td><input id="nuNote" class="bd-note" value="' + esc(nu.note) + '"'
      + (two() ? ' disabled title="' + esc(TWO_WHY) + '"' : '')
      + ' aria-label="Note for the new line"'
      + ' placeholder="what is in it / who is making it"></td>'
      // Never disabled. A dead button is one more thing to read at 2.66:1,
      // and pressing it with nothing typed should put the cursor where the
      // typing goes, which is what addLine does with an empty season.
      + '<td><button class="lb-add cg-go" id="nuAdd" type="button"'
      + ' title="' + (nu.label.trim()
        ? (known ? 'Adds to ' + esc(known.label) : 'Adds a new season')
        : 'Type a season first') + '">Add</button></td>'
      + '</tr>';
  }

  function two() { return nu.kind === 'both'; }

  var TWO_WHY = 'Both makes two lines. Add them one at a time to cost them.';

  function nuTotal() {
    var n = 0;
    var any = false;
    Object.keys(nu.years).forEach(function (y) {
      var v = Number(nu.years[y]);
      if (isFinite(v)) { n += v; any = true; }
    });
    return any ? Math.round(n * 100) / 100 : null;
  }

  // ── the chart ─────────────────────────────────────────────────────────
  //
  // Whatever the filters leave behind, as stacked columns: one column per
  // season (or per year), split into the bulk run and the samples. Stacked
  // rather than side by side because the question the sheet is being
  // built to answer is what a season COST -- the split is the second
  // question, and it is on the column and in the tooltip.
  //
  // The sheet underneath is the table view. Every figure on the chart is in
  // a cell you can read without hovering over anything.

  var KIND_CLASS = { bulk: 'bulk', sms: 'sms' };

  /**
   * Where a season falls in time, from its own name.
   *
   * Spring, Summer, Fall, Holiday is the order within a year. SS is the
   * older naming, where Spring and Summer were bought as one -- SS26 covers
   * what SP26 and SU26 would, so it sits between them.
   *
   * A name this cannot read gets no date rather than a guessed one.
   */
  var SEASON_RANK = { sp: 1, ss: 2, su: 3, f: 4, h: 5 };

  function seasonWhen(key) {
    var m = /^([a-z]+)[-\s]?(\d{2})$/.exec(String(key || '').toLowerCase());
    if (!m || !SEASON_RANK[m[1]]) return null;
    return (2000 + Number(m[2])) * 10 + SEASON_RANK[m[1]];
  }

  /** Compact money for a column's cap. Full figures live in the tooltip
   *  and in the sheet; a chart in full is a chart of nine-digit strings. */
  function brief(n) {
    var v = Math.abs(Number(n) || 0);
    if (v >= 1000000) return '$' + round1(v / 1000000) + 'M';
    if (v >= 1000) return '$' + round1(v / 1000) + 'K';
    return '$' + Math.round(v);
  }

  /**
   * One unit for the whole axis, chosen by its top tick.
   *
   * Letting each tick pick its own gives an axis reading $500K, $1M, $1.5M
   * -- two styles on one scale, which is a thing the reader has to convert
   * in their head before they can compare two of them.
   */
  function axisFmt(top) {
    if (top >= 1000000) {
      return function (v) { return v ? '$' + (v / 1000000).toFixed(1) + 'M' : '$0'; };
    }
    if (top >= 1000) {
      return function (v) { return v ? '$' + Math.round(v / 1000) + 'K' : '$0'; };
    }
    return function (v) { return '$' + Math.round(v); };
  }
  function round1(v) {
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  /**
   * Clean tick values: 1, 2 or 5 times a power of ten, four steps or so.
   *
   * The last one is at or ABOVE the tallest column. Stopping at the last
   * clean step under the max leaves the scale shorter than the data and the
   * column draws straight out of the top of the plot -- which is exactly
   * what the first version of this did at $1.46M against a $1M top tick.
   */
  function ticks(max) {
    if (!(max > 0)) return [0];
    var raw = max / 4;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
      .filter(function (x) { return x >= raw; })[0] || 10 * mag;
    var top = Math.ceil(max / step) * step;
    var out = [];
    for (var v = 0; v <= top + step * 0.001; v += step) out.push(v);
    return out;
  }

  /**
   * The columns, from the rows on screen.
   *
   * By season keeps the sheet's own order, so a backfilled season stays
   * behind next year rather than sorting itself into the middle of it. By
   * year is chronological and covers every year anything is filed under,
   * not the five columns on screen -- the chart is where a history is read,
   * and a history cut off at the window is not one.
   */
  // A line's cost across the years still switched on. Null when it has no
  // figure left once they are taken out, which is different from zero: a
  // line costed at nothing is a column, a line with nothing in the years
  // on screen is not.
  function includedTotal(r) {
    var n = 0;
    var any = false;
    Object.keys((r && r.years) || {}).forEach(function (y) {
      if (f.off.year[y]) return;
      var v = Number(r.years[y]);
      if (isFinite(v)) { n += v; any = true; }
    });
    return any ? n : null;
  }

  // Everything the chart COULD draw, before the exclusions are applied --
  // so a box that is unticked is still on screen to tick again. Taken from
  // the lines the table filters left, because the chart cannot draw what
  // the sheet is not showing.
  function offerings(list) {
    var seasons = [];
    var seenS = {};
    var years = {};
    (list || []).forEach(function (r) {
      var has = false;
      Object.keys(r.years || {}).forEach(function (y) {
        var v = Number(r.years[y]);
        if (!isFinite(v) || !v) return;
        has = true;
        years[y] = true;
      });
      if (!has || seenS[r.season]) return;
      seenS[r.season] = true;
      seasons.push({ key: r.season, label: r.seasonLabel || r.season });
    });
    seasons.sort(function (a, b) {
      var wa = seasonWhen(a.key);
      var wb = seasonWhen(b.key);
      if (wa != null && wb != null) return wa - wb;
      if (wa != null) return -1;
      if (wb != null) return 1;
      return String(a.label).localeCompare(String(b.label));
    });
    return {
      seasons: seasons,
      years: Object.keys(years).sort(function (a, b) { return Number(a) - Number(b); }),
      kinds: (D.kinds || []).map(function (k) { return { key: k.key, label: k.label }; }),
    };
  }

  function columns(list) {
    var at = {};
    (D.seasons || []).forEach(function (x, i) { at[x.key] = i; });
    var by = {};
    var order = [];

    var put = function (key, label, kind, amount) {
      if (!by[key]) { by[key] = { key: key, label: label, parts: {}, total: 0 }; order.push(key); }
      by[key].parts[kind] = (by[key].parts[kind] || 0) + amount;
      by[key].total += amount;
    };

    list.forEach(function (r) {
      if (f.off.kind[r.kind] || f.off.season[r.season]) return;
      if (f.graphBy === 'year') {
        Object.keys(r.years || {}).forEach(function (y) {
          if (f.off.year[y]) return;
          var v = Number(r.years[y]);
          if (isFinite(v) && v) put(y, y, r.kind, v);
        });
        return;
      }
      // By season, the column is the season's own total -- but it has to be
      // rebuilt from the years still switched on. r.amount is every year
      // the line holds, so using it here would draw money the reader just
      // asked to take out and leave the column taller than its own parts.
      var a = includedTotal(r);
      if (a != null) put(r.season, r.seasonLabel || r.season, r.kind, a);
    });

    var cols = order.map(function (k) { return by[k]; });
    // Oldest on the left. A chart of a history that is not in time order is
    // not a history -- the sheet keeps its own order, where a backfilled
    // season stays behind next year's rather than shuffling into the middle
    // of it, but on the chart the axis IS the time.
    cols.sort(function (a, b) {
      if (f.graphBy === 'year') return Number(a.key) - Number(b.key);
      var wa = seasonWhen(a.key);
      var wb = seasonWhen(b.key);
      if (wa != null && wb != null) return wa - wb;
      // Collab, Special Drops and Starboard carry no season and no year and
      // never will, so they sit after the calendar in the sheet's order
      // rather than being given a date they do not have.
      if (wa != null) return -1;
      if (wb != null) return 1;
      var ia = at[a.key] == null ? 999 : at[a.key];
      var ib = at[b.key] == null ? 999 : at[b.key];
      return ia - ib;
    });
    return cols;
  }

  var BAR = 24;        // the cap: a column never fills its slot
  var GAP = 2;         // surface between stacked segments, one width throughout
  var BAND = 72;       // one column's slot; the leftover either side is air
  var BAND_WIDE = 150; // as wide as a slot gets before the chart looks thin
  var AIM = 900;       // the width one plot across the card reaches for
  var AIM_HALF = 420;  // and what each reaches for when there are two
  var MAX_PLOT = 1240; // past this the bands tighten rather than the card growing

  function chartSvg(cols, kind, aim) {
    var L = 60;
    var R = 12;
    var T = 22;
    var B = 34;
    var H = 250;
    // Sized to its columns rather than stretched across the card, and drawn
    // at 1:1 -- a 760-unit viewBox on a 1900px card scales every spec in
    // here by two and a half, so a 24px bar arrives 60px wide and a 9.5px
    // tick arrives at 24.
    // The band widens to fill the card when there are few columns and
    // tightens as a history grows, between a floor and a ceiling. Fixed at
    // the floor, four seasons sit in the corner of an empty card; fixed at
    // the ceiling, a dozen run off the end of it.
    var band = Math.max(BAND, Math.min(BAND_WIDE,
      (aim || AIM) / Math.max(1, cols.length)));
    var plotW = Math.min(MAX_PLOT, band * cols.length);
    var W = L + R + plotW;
    var plotH = H - T - B;

    var val = function (c) { return kind ? (c.parts[kind] || 0) : c.total; };
    var max = cols.reduce(function (a, c) { return Math.max(a, val(c)); }, 0);
    var tk = ticks(max);
    var top = tk[tk.length - 1] || 1;
    var fmt = axisFmt(top);
    var y = function (v) { return T + plotH - (v / top) * plotH; };

    var band = plotW / cols.length;
    var w = Math.min(BAR, band * 0.7);

    var out = [];
    // Gridlines first, so every mark sits on top of them.
    tk.forEach(function (v) {
      out.push('<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="'
        + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>');
      out.push('<text class="tick" x="' + (L - 8) + '" y="' + (y(v) + 3.5).toFixed(1)
        + '" text-anchor="end">' + esc(fmt(v)) + '</text>');
    });

    cols.forEach(function (c, i) {
      var cx = L + band * i + band / 2;
      var x = cx - w / 2;
      var base = y(0);
      var v = val(c);
      if (v) {
        var h = (v / top) * plotH;
        // Rounded at the data end, square at the baseline. One path rather
        // than a rect, because only the top two corners are round.
        out.push('<path class="seg" fill="var(--s-' + (kind || 'bulk') + ')" d="'
          + roundedTop(x, base - h, w, h, 4) + '"/>');
        // One label per column, on the cap.
        out.push('<text class="cap" x="' + cx.toFixed(1) + '" y="'
          + (y(v) - 6).toFixed(1) + '" text-anchor="middle">'
          + esc(brief(v)) + '</text>');
      }
      out.push('<text class="cat" x="' + cx.toFixed(1) + '" y="' + (base + 16).toFixed(1)
        + '" text-anchor="middle">' + esc(c.label) + '</text>');

      // The hit target is the whole band, not the painted pixels, so the
      // pointer never has to find a 24px column.
      out.push('<rect class="hit" data-layer="hit" x="' + (L + band * i).toFixed(1) + '" y="' + T
        + '" width="' + band.toFixed(1) + '" height="' + plotH + '" fill="transparent"'
        + ' tabindex="0" role="button" data-col="' + esc(c.key) + '"'
        + ' data-kind="' + esc(kind || '') + '"'
        + ' aria-label="' + esc(c.label + ', ' + money(v)) + '"/>');
      out.push('<rect class="lift" data-layer="lift" x="' + (L + band * i).toFixed(1) + '" y="' + T
        + '" width="' + band.toFixed(1) + '" height="' + plotH + '" rx="4"/>');
    });

    return '<svg class="cg-svg" width="' + W + '" height="' + H + '"'
      + ' viewBox="0 0 ' + W + ' ' + H + '" role="img"'
      + ' aria-label="' + esc(kindLabel(kind)) + ' cost of goods by '
      + (f.graphBy === 'year' ? 'year' : 'season') + '">' + out.join('') + '</svg>';
  }

  function roundedTop(x, y2, w, h, r) {
    var rr = Math.min(r, w / 2, h);
    return 'M' + x + ' ' + (y2 + h).toFixed(1)
      + 'V' + (y2 + rr).toFixed(1)
      + (rr ? 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' -' + rr : '')
      + 'h' + (w - rr * 2).toFixed(1)
      + (rr ? 'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr : '')
      + 'V' + (y2 + h).toFixed(1) + 'Z';
  }

  function kindLabel(k) {
    var hit = (D.kinds || []).filter(function (x) { return x.key === k; })[0];
    return hit ? hit.label : (k || 'Everything');
  }

  /**
   * One chart per kind, side by side.
   *
   * Samples run at a few per cent of the production run, so stacked into
   * one column they were a sliver nobody could read. Apart, each gets its
   * own scale -- and the two share their columns, in the same order, so a
   * season sits in the same place on both.
   *
   * SEPARATE SCALES, which is the thing to be careful about: a column on
   * the SMS chart is NOT comparable by height to one on the Bulk chart.
   * Each says its own total under its title, carries its own labelled axis
   * and is marked "own scale", so the magnitudes are on screen in words
   * and figures rather than left to the bar heights.
   */
  function chartPanel(kind, cols, aim) {
    var sum = cols.reduce(function (a, c) { return a + (c.parts[kind] || 0); }, 0);
    var any = cols.some(function (c) { return c.parts[kind]; });
    return '<div class="cg-panel">'
      // One series, so no legend box: the title is what names it.
      + '<h3 class="cg-ptitle"><i class="' + esc(KIND_CLASS[kind] || '') + '"></i>'
      + esc(kindLabel(kind)) + '</h3>'
      + '<p class="cg-psub">' + esc(money(sum)) + ' \u00b7 own scale</p>'
      + (any ? chartSvg(cols, kind, aim)
        : '<p class="cg-empty">Nothing costed here yet.</p>')
      + '</div>';
  }

  // ── taking the chart away ─────────────────────────────────────────────
  //
  // A PNG, because it is going into a deck or an email. Built by cloning
  // what is on screen and resolving every style onto the elements
  // themselves: an SVG in an <img> gets no stylesheet and no web fonts, so
  // anything left in a class attribute arrives black and unstyled.

  var LIFT_OUT = ['hit', 'lift'];
  var KEEP = ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size',
              'font-weight', 'text-anchor', 'opacity'];

  /**
   * Copy the live element's resolved styles onto its clone.
   *
   * Read from the ORIGINAL, which is in the document, and written to the
   * clone, which is not: getComputedStyle on a detached node resolves
   * nothing, so a first version of this read the clone and exported a
   * chart of black bars in a default serif.
   */
  function inlineStyles(live, clone, win) {
    var cs = win.getComputedStyle(live);
    KEEP.forEach(function (prop) {
      var v = cs.getPropertyValue(prop);
      if (!v || (prop === 'stroke' && v === 'none')) return;
      // A generic has to be last in the chain, because the rasteriser has
      // none of this page's web fonts.
      if (prop === 'font-family') v = v + ', sans-serif';
      clone.setAttribute(prop, v.trim());
    });
    clone.removeAttribute('class');
    clone.removeAttribute('tabindex');
    clone.removeAttribute('role');
    var kids = [].slice.call(live.children);
    var mine = [].slice.call(clone.children);
    for (var i = 0; i < kids.length && i < mine.length; i += 1) {
      inlineStyles(kids[i], mine[i], win);
    }
  }

  function exportSvg() {
    var panels = [].slice.call(document.querySelectorAll('.cg-panel'));
    var svgs = panels.map(function (el) { return el.querySelector('.cg-svg'); })
      .filter(Boolean);
    if (!svgs.length) return null;

    var PAD = 20;
    var GAPX = 34;
    var HEAD = 58;      // the chart's own title
    var PHEAD = 34;     // each panel's title and its scale note
    var card = getComputedStyle($('#chart'));
    var bg = card.backgroundColor;
    var ink = getComputedStyle(document.body).color;

    var widths = svgs.map(function (el) { return Number(el.getAttribute('width')); });
    var height = Math.max.apply(null, svgs.map(function (el) {
      return Number(el.getAttribute('height'));
    }));
    var W = PAD * 2 + widths.reduce(function (a, b) { return a + b; }, 0)
      + GAPX * (svgs.length - 1);
    var H = PAD * 2 + HEAD + PHEAD + height;

    var mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    var sans = 'system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
    var text = function (x, y, str, size, weight, fill, family) {
      return '<text x="' + x + '" y="' + y + '" font-family="' + (family || sans)
        + '" font-size="' + size + '" font-weight="' + (weight || 400)
        + '" fill="' + (fill || ink) + '">' + esc(str) + '</text>';
    };

    var out = ['<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + bg + '"/>'];
    out.push(text(PAD, PAD + 18, 'Cost of goods by '
      + (f.graphBy === 'year' ? 'year' : 'season'), 17, 600));
    out.push(text(PAD, PAD + 38,
      chartSub() + ' · ' + new Date().toISOString().slice(0, 10),
      11, 400, ink, mono));

    var x = PAD;
    panels.forEach(function (panel, i) {
      var svg = svgs[i];
      if (!svg) return;
      var title = panel.querySelector('.cg-ptitle');
      var sub = panel.querySelector('.cg-psub');
      var swatch = title ? getComputedStyle(title.querySelector('i')).backgroundColor : ink;
      var top = PAD + HEAD;
      out.push('<rect x="' + x + '" y="' + (top - 10) + '" width="11" height="11"'
        + ' rx="2" fill="' + swatch + '"/>');
      out.push(text(x + 18, top, title ? title.textContent.trim() : '', 13, 600));
      out.push(text(x + 18, top + 17, sub ? sub.textContent.trim() : '', 11, 400, ink, mono));

      // Styles first, while the clone still matches the live chart node for
      // node, and only then strip the interaction layers out of it.
      var clone = svg.cloneNode(true);
      inlineStyles(svg, clone, window);
      LIFT_OUT.forEach(function (cls) {
        [].slice.call(clone.querySelectorAll('[data-layer="' + cls + '"]'))
          .forEach(function (n) { n.parentNode.removeChild(n); });
      });
      clone.setAttribute('x', x);
      clone.setAttribute('y', PAD + HEAD + PHEAD);
      out.push(new XMLSerializer().serializeToString(clone));
      x += widths[i] + GAPX;
    });

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H
      + '" viewBox="0 0 ' + W + ' ' + H + '">' + out.join('') + '</svg>';
  }

  function downloadChart() {
    var markup = exportSvg();
    if (!markup) return;
    var name = 'jetty-cogs-by-' + (f.graphBy === 'year' ? 'year' : 'season')
      + '-' + new Date().toISOString().slice(0, 10) + '.png';
    var img = new Image();
    var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    img.onload = function () {
      // Twice the size, so it holds up pasted into a deck at any width.
      var c = document.createElement('canvas');
      c.width = img.width * 2;
      c.height = img.height * 2;
      var g = c.getContext('2d');
      g.scale(2, 2);
      g.drawImage(img, 0, 0);
      c.toBlob(function (blob) {
        if (!blob) return say('The chart could not be turned into a picture.');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      }, 'image/png');
    };
    img.onerror = function () { say('The chart could not be turned into a picture.'); };
    img.src = url;
  }

  // Three groups of tick boxes: which kinds, which years, which seasons.
  //
  // Boxes rather than another dropdown because the question is "these four
  // of the nine", which a one-at-a-time control cannot ask. Real checkboxes
  // rather than pressed buttons so they are reachable and announced as what
  // they are.
  function group(kind, label, items, idOf, labelOf) {
    if (!items.length) return '';
    var anyOff = items.some(function (x) { return f.off[kind][idOf(x)]; });
    return '<fieldset class="cg-pick">'
      + '<legend>' + esc(label) + '</legend>'
      + items.map(function (x) {
        var id = idOf(x);
        return '<label class="cg-tick"><input type="checkbox" data-off="' + kind + '"'
          + ' value="' + esc(id) + '"' + (f.off[kind][id] ? '' : ' checked') + '>'
          + '<span>' + esc(labelOf(x)) + '</span></label>';
      }).join('')
      + (anyOff ? '<button type="button" class="cg-all" data-all="' + kind
          + '">All</button>' : '')
      + '</fieldset>';
  }

  function picker(avail) {
    var id = function (x) { return x.key; };
    var lb = function (x) { return x.label; };
    var same = function (y) { return y; };
    return '<div class="cg-picks">'
      + group('kind', 'Show', avail.kinds, id, lb)
      + group('year', 'Years', avail.years, same, same)
      + group('season', 'Seasons', avail.seasons, id, lb)
      + '</div>';
  }

  // Kept across reloads, because re-ticking nine seasons every morning is
  // how a control stops being used. Safe to persist BECAUSE they are
  // exclusions shown as unticked boxes: something left out is visible on
  // the page as a box to tick, not as money that silently went missing.
  var OFF_KEY = 'jetty-cogs-graph-off';

  function saveOff() {
    try { localStorage.setItem(OFF_KEY, JSON.stringify(f.off)); }
    catch (err) { /* private mode */ }
  }

  function loadOff() {
    var got = null;
    try { got = JSON.parse(localStorage.getItem(OFF_KEY) || 'null'); }
    catch (err) { got = null; }
    if (!got || typeof got !== 'object') return OFF();
    var out = OFF();
    ['kind', 'season', 'year'].forEach(function (k) {
      if (got[k] && typeof got[k] === 'object') {
        Object.keys(got[k]).forEach(function (v) { if (got[k][v]) out[k][v] = true; });
      }
    });
    return out;
  }

  function renderChart(list) {
    var box = $('#chart');
    if (!box) return;
    box.hidden = !f.graph;
    if (!f.graph) { box.innerHTML = ''; return; }

    chartOffered = offerings(list);
    var cols = columns(list);
    var byYear = f.graphBy === 'year';
    var head = '<div class="cg-ctop">'
      + '<h2 class="cg-ctitle" id="chartTitle">Cost of goods by '
      + (byYear ? 'year' : 'season') + '</h2>'
      + '<span class="cg-csub">' + esc(chartSub())
      + (byYear ? ' \u00b7 by the year the money lands in' : '') + '</span>'
      + '<span class="cg-cby" role="group" aria-label="What the columns are">'
      + '<button type="button" data-by="season" aria-pressed="' + (!byYear) + '">Season</button>'
      + '<button type="button" data-by="year" aria-pressed="' + byYear + '">Year</button>'
      + '</span>'
      + '<button class="lb-add cg-dl" id="cgDown" type="button">Download PNG</button>'
      + '</div>'
      + picker(chartOffered);

    if (!cols.length) {
      var tight = chartOffered.seasons.length || chartOffered.years.length;
      box.innerHTML = head
        + '<p class="cg-empty">' + (tight
          ? 'Nothing is left to draw. Tick something back on above.'
          : 'Nothing on screen has a figure on it yet, so there is nothing to draw.')
        + '</p>';
      chartCols = [];
      return;
    }

    // Filtering to one kind leaves one chart, and it takes the width --
    // rather than a half-empty card sitting beside an empty one. Unticking
    // one does the same.
    var kinds = (D.kinds || []).map(function (k) { return k.key; })
      .filter(function (k) { return !f.kind || f.kind === k; })
      .filter(function (k) { return !f.off.kind[k]; });
    var aim = kinds.length > 1 ? AIM_HALF : AIM;

    box.innerHTML = head
      + '<div class="cg-panels">'
      + kinds.map(function (k) { return chartPanel(k, cols, aim); }).join('')
      + '</div>'
      + '<div class="cg-tip" id="cgTip" hidden></div>';
    chartCols = cols;
  }

  var chartCols = [];
  // What the picker last offered. chartSub() is called by the export too,
  // which has no list to work from, and a count that disagrees with the
  // boxes on screen is worse than no count.
  var chartOffered = { seasons: [], years: [], kinds: [] };

  // Labels come off the sheet, so they go in as text rather than as markup.
  //
  // The value leads and the label follows -- the reader already has the
  // series from the chart they are pointing at and wants the number. The
  // season's whole cost rides underneath, because the chart beside this one
  // is on a different scale and cannot be read across to.
  function showTip(key, host, kind) {
    var tip = $('#cgTip');
    var col = chartCols.filter(function (c) { return c.key === key; })[0];
    if (!tip || !col) return;
    tip.textContent = '';
    var head = document.createElement('div');
    head.appendChild(document.createTextNode(col.label + ' '));
    var b = document.createElement('b');
    b.textContent = money(kind ? (col.parts[kind] || 0) : col.total);
    head.appendChild(b);
    tip.appendChild(head);
    if (kind) {
      var one = document.createElement('div');
      one.className = 'r';
      var dot = document.createElement('i');
      dot.className = KIND_CLASS[kind] || '';
      one.appendChild(dot);
      one.appendChild(document.createTextNode(kindLabel(kind)
        + ' \u00b7 of ' + money(col.total) + ' for the season'));
      tip.appendChild(one);
    } else {
      (D.kinds || []).forEach(function (k) {
        if (!col.parts[k.key]) return;
        var row = document.createElement('div');
        row.className = 'r';
        var i = document.createElement('i');
        i.className = KIND_CLASS[k.key] || '';
        row.appendChild(i);
        row.appendChild(document.createTextNode(k.label + ' ' + money(col.parts[k.key])));
        tip.appendChild(row);
      });
    }
    var box = $('#chart').getBoundingClientRect();
    var at = host.getBoundingClientRect();
    tip.hidden = false;
    var left = at.left - box.left + at.width / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(4, Math.min(left, box.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, at.top - box.top - tip.offsetHeight - 6) + 'px';
  }

  function hideTip() {
    var tip = $('#cgTip');
    if (tip) tip.hidden = true;
  }

  function render() {
    var list = shown();
    var body = (list.length
      ? list.map(row).join('')
      : '<tr><td colspan="' + cols() + '" class="pane-empty">Nothing on the sheet'
        + (filtered() ? ' matches that' : ' yet') + '.</td></tr>')
      + addRow()
      + (list.length ? footRow(list) : '');
    renderChart(list);
    $('#t').innerHTML = '<thead>' + head() + '</thead><tbody>' + body + '</tbody>'
      + '<datalist id="cgSeasons">'
      + (D.seasons || []).map(function (x) {
        return '<option value="' + esc(x.label) + '"></option>';
      }).join('') + '</datalist>';
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
    var yr = $('#fYear');
    if (yr) {
      // Wide enough to backfill a season from a few years ago and to carry
      // a deposit for one a few years out. The columns reach three years
      // back from the pick and one forward.
      var opts = [];
      for (var y = (D.baselineYear || 2026) - 4; y <= (D.firstYear || 2027) + 4; y++) {
        opts.push('<option value="' + y + '"' + (y === D.year ? ' selected' : '')
          + '>' + y + '</option>');
      }
      yr.innerHTML = opts.join('');
    }
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

  // The row's own total, redrawn without redrawing the row -- which would
  // take the cursor out of the cell being typed in.
  function paint(tr, r) {
    var cell = tr.querySelector('.lb-tot');
    if (!cell) return;
    var off = outside(r);
    cell.innerHTML = (r.amount == null ? '<span class="lb-none">—</span>' : money(r.amount))
      + (off ? '<span class="cg-flag">+</span>' : '');
    cell.classList.toggle('cg-out', Boolean(off));
  }

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
    send('/api/cogs/line?year=' + encodeURIComponent(f.year), {
      id: r.id, added: r.added, season: r.season, kind: r.kind,
      seasonLabel: r.seasonLabel, years: r.years || {}, note: r.note,
    }, redraw ? function () { render(); } : null);
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  function total(r) {
    var n = 0;
    var any = false;
    Object.keys(r.years || {}).forEach(function (y) {
      var v = Number(r.years[y]);
      if (isFinite(v)) { n += v; any = true; }
    });
    return any ? Math.round(n * 100) / 100 : null;
  }

  // One year's cell. A cleared box deletes that year rather than storing a
  // zero -- nobody has said yet is not the same as nothing, which is the
  // rule the whole sheet is built on.
  function readYear(input, r, y) {
    var raw = input.value.replace(/[,$\s]/g, '');
    r.years = r.years || {};
    if (raw === '') delete r.years[y];
    else if (/^-?\d+(\.\d+)?$/.test(raw)) r.years[y] = Number(raw);
    else return false;
    r.amount = total(r);
    input.classList.toggle('set', r.years[y] != null);
    return true;
  }

  // What has been typed into the entry row so far. Read rather than
  // redrawn: redrawing the row would take the cursor out of the box being
  // typed in, which on an entry row is every keystroke.
  function nuInput(el) {
    if (el.id === 'nuSeason') { nu.label = el.value; return nuPaint(); }
    if (el.id === 'nuKind') {
      nu.kind = el.value;
      // Cleared rather than kept and ignored: a figure sitting in a box
      // that the add is about to throw away is worse than no figure.
      if (two()) { nu.years = {}; nu.note = ''; }
      return render();
    }
    if (el.id === 'nuNote') { nu.note = el.value; return; }
    var y = el.dataset.nu;
    if (!y) return;
    var raw = el.value.replace(/[,$\s]/g, '');
    if (raw === '') delete nu.years[y];
    else if (/^-?\d+(\.\d+)?$/.test(raw)) nu.years[y] = Number(raw);
    else return;
    el.classList.toggle('set', nu.years[y] != null);
    nuPaint();
  }

  // The running total, and whether Add is live, without redrawing the row.
  function nuPaint() {
    var tr = document.querySelector('.cg-add');
    if (!tr) return;
    var cell = tr.querySelector('.lb-tot');
    var n = nuTotal();
    if (cell) {
      cell.innerHTML = n == null ? '<span class="lb-none">\u2014</span>' : money(n);
    }
    var btn = $('#nuAdd');
    if (btn) {
      var known = knownSeason(nu.label);
      btn.title = !nu.label.trim() ? 'Type a season first'
        : (known ? 'Adds to ' + known.label : 'Adds a new season');
    }
  }

  /**
   * Turn what is in the entry row into a line, or two if Both.
   *
   * A season already on the sheet is reused rather than made again: typing
   * "ss25" when SS25 is already here must not leave two seasons a
   * character apart in every dropdown.
   */
  // Mirrors addCollision() in worker/cogs.js, and the tests check the two
  // agree. Said here as well as there so it is said before the round trip --
  // and before 'Both' sends two requests of which one lands and one is
  // refused, which is the one case the server cannot tidy up after.
  function collides(key, kinds) {
    for (var i = 0; i < kinds.length; i++) {
      var id = key + ':' + kinds[i];
      var hit = (D.lines || []).filter(function (r) { return r.id === id; })[0];
      if (!hit) continue;
      var k = (D.kinds || []).filter(function (x) { return x.key === hit.kind; })[0];
      var name = hit.seasonLabel || hit.season;
      return name + ' (' + ((k && k.label) || hit.kind) + ') is already on the '
        + 'sheet. Cost that line, or give this one a name of its own -- "'
        + name + ' 2" or "' + name + ' SP27" sits beside it as a separate line.';
    }
    return '';
  }

  function addLine() {
    var label = nu.label.trim();
    if (!label) { var box = $('#nuSeason'); if (box) box.focus(); return; }
    var known = knownSeason(label);
    var key = known ? known.key : slug(label);
    if (!key) return say('"' + label + '" is not a season name this can use.');
    var name = known ? known.label : label;

    var kinds = nu.kind === 'both'
      ? (D.kinds || []).map(function (k) { return k.key; })
      : [nu.kind];

    // Refused before anything is cleared, so what was typed is still there
    // to rename rather than typed again from memory.
    var clash = collides(key, kinds);
    if (clash) return say(clash);
    // Figures only go on when there is one line to put them on. Splitting a
    // typed total across bulk and samples would be inventing a number
    // nobody said.
    var years = two() ? {} : nu.years;
    var note = two() ? '' : nu.note;

    var left = kinds.length;
    nu = { label: '', kind: nu.kind, years: {}, note: '' };

    kinds.forEach(function (k) {
      send('/api/cogs/line?year=' + encodeURIComponent(f.year),
        { added: true, season: key, seasonLabel: name, kind: k,
          years: years, note: note },
        function () {
          if (--left > 0) return;
          render();
          // Straight back to the season box: building a history is one
          // season after another, not one trip to the mouse after another.
          var box = $('#nuSeason');
          if (box) box.focus();
        });
    });
  }

  function bind() {
    var t = $('#t');

    t.addEventListener('input', function (e) {
      if (e.target.closest('.cg-add')) return nuInput(e.target);
      var tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      var r = line(tr.dataset.id);
      if (!r) return;
      var fld = e.target.dataset.f;
      if (fld === 'year') {
        // The total is beside the cell being typed in, so it has to keep up
        // with the keystrokes rather than wait for the save to come back.
        if (readYear(e.target, r, e.target.dataset.y)) paint(tr, r);
      }
      if (fld === 'note') {
        r.note = e.target.value;
        clearTimeout(timers[r.id]);
        timers[r.id] = setTimeout(function () { save(r); }, 900);
      }
    });

    t.addEventListener('change', function (e) {
      if (e.target.closest('.cg-add')) return nuInput(e.target);
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
      if (fld === 'year') {
        if (!readYear(e.target, r, e.target.dataset.y)) return;
        var v = (r.years || {})[e.target.dataset.y];
        e.target.value = v == null ? '' : comma(v);
        paint(tr, r);
        save(r);
      }
    });

    t.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      // Enter anywhere in the entry row adds it. Typing a season and a
      // figure and then reaching for the mouse is the thing this row
      // exists to stop.
      if (e.target.closest('.cg-add')) { e.preventDefault(); return addLine(); }
      if (e.target.classList.contains('lb-in')) e.target.blur();
    });

    t.addEventListener('click', function (e) {
      if (e.target.closest('#nuAdd')) return addLine();
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

    $('#graph').addEventListener('click', function (e) {
      f.graph = !f.graph;
      e.currentTarget.setAttribute('aria-pressed', f.graph ? 'true' : 'false');
      try { localStorage.setItem('jetty-cogs-graph', f.graph ? '1' : ''); }
      catch (err) { /* private mode */ }
      render();
    });

    var box = $('#chart');
    box.addEventListener('change', function (e) {
      var tick = e.target.closest ? e.target.closest('[data-off]') : null;
      if (!tick) return;
      var kind = tick.dataset.off;
      if (tick.checked) delete f.off[kind][tick.value];
      else f.off[kind][tick.value] = true;
      saveOff();
      render();
    });
    box.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#cgDown')) return downloadChart();
      var all = e.target.closest ? e.target.closest('[data-all]') : null;
      if (all) {
        f.off[all.dataset.all] = {};
        saveOff();
        return render();
      }
      var b = e.target.closest ? e.target.closest('[data-by]') : null;
      if (!b) return;
      f.graphBy = b.dataset.by;
      try { localStorage.setItem('jetty-cogs-graph-by', f.graphBy); }
      catch (err) { /* private mode */ }
      render();
    });
    // Same details on focus as on hover, so the chart is reachable from the
    // keyboard rather than only from a pointer.
    ['pointerover', 'focusin'].forEach(function (ev) {
      box.addEventListener(ev, function (e) {
        var hit = e.target.closest ? e.target.closest('.hit') : null;
        if (hit) showTip(hit.dataset.col, hit, hit.dataset.kind);
      });
    });
    ['pointerleave', 'focusout'].forEach(function (ev) {
      box.addEventListener(ev, hideTip, true);
    });
    $('#fYear').addEventListener('change', function (e) {
      f.year = Number(e.target.value) || f.year;
      try { localStorage.setItem('jetty-cogs-year', String(f.year)); }
      catch (err) { /* private mode */ }
      load();
    });
    $('#clr').addEventListener('click', function () {
      f = { q: '', season: '', kind: '', show: 'all', year: f.year, off: OFF(),
            graph: f.graph, graphBy: f.graphBy };
      saveOff();
      $('#q').value = '';
      render();
      $('#q').focus();
    });

    // The button in the bar used to open a prompt that always made two
    // lines. The entry row at the bottom of the sheet does the same job
    // without a dialog, so the button only puts the cursor in it.
    var jump = $('#add');
    if (jump) {
      jump.addEventListener('click', function () {
        var el = $('#nuSeason');
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
      });
    }
  }

  function load() {
    return api('/api/cogs' + (f.year ? '?year=' + encodeURIComponent(f.year) : ''))
      .then(function (data) {
        D = data;
        D.lines = data.lines || [];
        f.year = D.year;
        $('#dl').href = '/api/cogs.csv?year=' + encodeURIComponent(f.year);
        $('#bar').hidden = false;
        $('#graph').setAttribute('aria-pressed', f.graph ? 'true' : 'false');
        $('#notice').innerHTML = '';
        render();
      });
  }

  try {
    var kept = Number(localStorage.getItem('jetty-cogs-year'));
    if (kept >= 2015 && kept <= 2100) f.year = kept;
    f.off = loadOff();
    f.graph = Boolean(localStorage.getItem('jetty-cogs-graph'));
    var by = localStorage.getItem('jetty-cogs-graph-by');
    if (by === 'year' || by === 'season') f.graphBy = by;
  } catch (err) { /* private mode */ }

  load()
    .then(function () { bind(); })
    .catch(function (err) {
      $('#sub').textContent = 'Not open to you';
      say(/Unknown endpoint|No such endpoint|404/.test(err.message)
        ? 'COGS planning is not open to this address. It is next year’s cost '
          + 'of goods before any of it is committed, so it sits behind the same '
          + 'list as the budget. Ask Jeremy to add you.'
        : (err.message || 'The sheet did not load.'));
    });
}());
