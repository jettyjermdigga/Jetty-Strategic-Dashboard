(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var OUT = ' target="_blank" rel="noopener noreferrer"';

  var PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M6 4.5 19 12 6 19.5z"/></svg>';

  // 2026-10-19 reads as the Monday it went out, and that is how everybody
  // refers to these. Built from the parts rather than through Date, which
  // would shift the day backwards for anyone west of UTC.
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
             'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function nice(d) {
    var p = String(d || '').split('-');
    if (p.length !== 3) return d || '';
    return Number(p[2]) + ' ' + (MON[Number(p[1]) - 1] || '') + ' ' + p[0];
  }

  function watchUrl(p) {
    if (p.yt) return 'https://www.youtube.com/watch?v=' + p.yt;
    return p.url || '';
  }

  function rowHtml(p) {
    var link = watchUrl(p);
    return '<div class="mu-row">'
      + '<span class="mu-d">' + esc(nice(p.date)) + '</span>'
      + '<span class="mu-a">' + esc(p.artist) + '</span>'
      + '<span class="mu-song">' + esc(p.song) + '</span>'
      + '<span class="mu-by">' + esc(p.by) + '</span>'
      + (link
          ? '<a class="mu-play"' + OUT + ' href="' + esc(link) + '" '
            + 'aria-label="Play ' + esc(p.song || p.artist) + '">' + PLAY + '</a>'
          : '<span></span>')
      + '</div>';
  }

  // Grouped by year, newest first. Thirteen years in one scroll needs a
  // handhold, and the year is the one everybody actually remembers by.
  function listHtml(picks) {
    if (!picks.length) return '<div class="mu-none">Nothing matches that.</div>';
    var out = [];
    var year = '';
    picks.forEach(function (p) {
      var y = String(p.date).slice(0, 4);
      if (y !== year) { year = y; out.push('<div class="mu-year">' + esc(y) + '</div>'); }
      out.push(rowHtml(p));
    });
    return out.join('');
  }



  function nowHtml(p) {
    if (!p) return '';
    var vid = p.yt
      ? '<div class="now-vid"><iframe src="https://www.youtube-nocookie.com/embed/' + esc(p.yt)
        + '" title="' + esc(p.artist + ' — ' + p.song) + '" allowfullscreen '
        + 'referrerpolicy="strict-origin-when-cross-origin" '
        + 'allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"></iframe></div>'
      : '';
    var link = watchUrl(p);
    return '<div class="now-in' + (vid ? ' has-vid' : '') + '">'
      + '<div class="now-txt">'
        + '<p class="now-k">This week &middot; ' + esc(nice(p.date)) + '</p>'
        + '<h1 class="now-a">' + esc(p.artist) + '</h1>'
        + (p.song ? '<p class="now-s">' + esc(p.song) + '</p>' : '')
        + (p.by ? '<p class="now-by">Picked by ' + esc(p.by) + '</p>' : '')
        + (!vid && link
            ? '<p class="now-by"><a' + OUT + ' href="' + esc(link) + '">Listen &rarr;</a></p>'
            : '')
      + '</div>' + vid + '</div>';
  }

  var ALL = [];

  function paint() {
    var q = ($('#q').value || '').trim().toLowerCase();
    var shown = !q ? ALL : ALL.filter(function (p) {
      return (p.artist + ' ' + p.song).toLowerCase().indexOf(q) !== -1;
    });
    $('#list').innerHTML = listHtml(shown);
    $('#count').textContent = shown.length === ALL.length
      ? ALL.length + ' picks'
      : shown.length + ' of ' + ALL.length;
  }

  function failed(msg) {
    $('#notice').innerHTML = '<div class="notice"><strong>The archive could not load.</strong> '
      + esc(msg) + '</div>';
  }

  fetch('/api/music', { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) {
        return r.json().then(function (b) {
          throw new Error((b && b.error) || 'The server answered ' + r.status + '.');
        }, function () { throw new Error('The server answered ' + r.status + '.'); });
      }
      return r.json();
    })
    .then(function (d) {
      // Picks are scheduled weeks ahead. Those are next Monday's reveal,
      // not history, so they stay out of the archive -- the hero already
      // only shows a pick whose Monday has arrived.
      var today = new Date().toISOString().slice(0, 10);
      ALL = (d.picks || []).filter(function (p) { return p.date <= today && p.artist; });
      if (!ALL.length) {
        $('#notice').innerHTML = '<div class="notice"><strong>Nothing to show.</strong> '
          + esc(d.reason || 'The archive is empty.') + '</div>';
        return;
      }
      var now = ALL[0] || null;
      $('#now').innerHTML = nowHtml(now);
      $('#now').hidden = !now;
      paint();
      $('#foot').textContent = 'Every Monday since ' + nice(ALL[ALL.length - 1].date) + '.';
    })
    .catch(function (err) { failed(err.message); });

  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'q') paint();
  });
})();
