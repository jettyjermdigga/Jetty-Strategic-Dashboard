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

  // Duplicated from worker/music.js and pinned by a mirror test, the same
  // as everything else shared across this portal.
  function mondayOf(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
    var t = new Date(date + 'T00:00:00Z');
    if (isNaN(t)) return '';
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.toISOString().slice(0, 10);
  }

  // "This week" over a pick from a fortnight ago is the same lie the
  // campaign board used to tell with "due this week". Only said when true.
  function weekLabel(date, today) {
    var a = mondayOf(date), b = mondayOf(today);
    if (!a || !b) return 'Latest pick';
    return a === b ? 'This week' : 'Latest pick';
  }

  function watchUrl(p) {
    if (p.yt) return 'https://www.youtube.com/watch?v=' + p.yt;
    return p.url || '';
  }

  // onerror rather than a check: the key is derived from the date, so the
  // page believes a picture exists before R2 confirms it. A week whose
  // upload failed collapses the thumbnail instead of showing a broken one.
  var HIDE = ' onerror="this.style.display=&quot;none&quot;"';

  function art(p, cls) {
    if (!p.photo) return '';
    return '<img class="' + cls + '" loading="lazy" alt=""' + HIDE
      + ' src="/music/photo/' + esc(p.photo) + '">';
  }

  function rowHtml(p) {
    var link = watchUrl(p);
    return '<div class="mu-row' + (p.photo ? ' has-art' : '') + '">'
      + '<span class="mu-d">' + esc(nice(p.date)) + '</span>'
      + (p.photo ? art(p, 'mu-art') : '<span class="mu-art-gap"></span>')
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
    var cover = p.photo
      ? '<div class="now-art">' + art(p, 'now-img') + '</div>'
      : '';
    var vid = p.yt
      ? '<div class="now-vid"><iframe src="https://www.youtube-nocookie.com/embed/' + esc(p.yt)
        + '" title="' + esc(p.artist + ' — ' + p.song) + '" allowfullscreen '
        + 'referrerpolicy="strict-origin-when-cross-origin" '
        + 'allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"></iframe></div>'
      : '';
    var link = watchUrl(p);
    return '<div class="now-in' + (vid ? ' has-vid' : '') + '">'
      + '<div class="now-txt">' + cover
        + '<p class="now-k">' + esc(weekLabel(p.date, today())) + ' &middot; '
          + esc(nice(p.date)) + '</p>'
        + '<h1 class="now-a">' + esc(p.artist) + '</h1>'
        + (p.song ? '<p class="now-s">' + esc(p.song) + '</p>' : '')
        + (p.by ? '<p class="now-by">Picked by ' + esc(p.by) + '</p>' : '')
        + (!vid && link
            ? '<p class="now-by"><a' + OUT + ' href="' + esc(link) + '">Listen &rarr;</a></p>'
            : '')
      + '</div>' + vid + '</div>';
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  var ALL = [];    // what the archive shows
  var EVERY = [];  // every pick the server holds, future ones included
  var CAN = false;


  // ── Posting the week ──────────────────────────────────────────────────
  //
  // The archive ran out of Airtable for thirteen years and then simply
  // stopped, because the import was built and the next Monday never was.
  // This is that missing half. Shown only to whoever may post; everybody
  // else gets the page exactly as it was.

  function opt(d) {
    return '<button type="button" class="mu-gap" data-d="' + esc(d) + '">'
      + esc(nice(d)) + '</button>';
  }

  // A week already filed means this post is a correction, and a correction
  // must not ping the channel again. Checked against EVERY rather than the
  // archive: next Monday's pick is filed but deliberately not on show yet.
  function filed(date) {
    for (var i = 0; i < EVERY.length; i++) {
      if (EVERY[i].date === date && EVERY[i].artist) return true;
    }
    return false;
  }

  function syncNotify() {
    var box = $('#f-tell');
    var d = $('#f-date').value;
    if (!box) return;
    var correction = filed(d);
    box.checked = !correction;
    $('#f-tell-l').lastChild.nodeValue = correction
      ? ' Tell Slack (this week is already filed \u2014 a correction)'
      : ' Tell Slack';
  }

  function postHtml(missing) {
    var mon = mondayOf(today());
    return '<form id="post-f" class="mu-post">'
      + '<div class="mu-post-h">Post a pick</div>'
      + (missing.length
          ? '<div class="mu-gaps"><span>No pick filed for</span>'
            + missing.map(opt).join('') + '</div>'
          : '')
      + '<div class="mu-f">'
        + '<label class="mu-l mu-l-d">Monday'
          + '<input id="f-date" type="date" value="' + esc(mon) + '" required></label>'
        + '<label class="mu-l mu-l-a">Artist'
          + '<input id="f-artist" type="text" required autocomplete="off"></label>'
        + '<label class="mu-l mu-l-s">Song'
          + '<input id="f-song" type="text" autocomplete="off"></label>'
        + '<label class="mu-l mu-l-b">Picked by'
          + '<input id="f-by" type="text" autocomplete="off"></label>'
        + '<label class="mu-l mu-l-w">Link'
          + '<input id="f-watch" type="url" autocomplete="off" '
          + 'placeholder="YouTube, SoundCloud, anywhere"></label>'
        + '<label class="mu-l mu-l-p">Picture'
          + '<input id="f-photo" type="file" accept="image/*"></label>'
      + '</div>'
      + '<div class="mu-post-go">'
        + '<button id="f-go" type="submit" class="mu-save">Post it</button>'
        + '<label id="f-tell-l" class="mu-tell">'
          + '<input id="f-tell" type="checkbox" checked> Tell Slack</label>'
        + '<span id="f-say" class="mu-say" role="status"></span>'
      + '</div>'
    + '</form>';
  }

  // Shrunk here rather than on the way in: the thirteen years already in the
  // bucket were resized to 900px by the importer, and a 4MB phone photo
  // dropped in beside them would be the one row that costs a second to load.
  function shrink(file) {
    return new Promise(function (ok, no) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        var max = 900;
        if (w > max) { h = Math.round(h * (max / w)); w = max; }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(function (b) {
          if (b) ok(b);
          else no(new Error('That picture could not be read.'));
        }, 'image/webp', 0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        no(new Error('That picture could not be read.'));
      };
      img.src = url;
    });
  }

  function say(msg, bad) {
    var el = $('#f-say');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'mu-say' + (bad ? ' bad' : '');
  }

  // The archive, the hero and the gap list all come back from the server
  // together, so one answer redraws the page rather than the page guessing
  // at what it just sent.
  function absorb(d) {
    CAN = Boolean(d.canPick);
    var t = today();
    EVERY = d.picks || [];
    ALL = EVERY.filter(function (p) { return p.date <= t && p.artist; });
    var now = ALL[0] || null;
    $('#now').innerHTML = nowHtml(now);
    $('#now').hidden = !now;
    if (CAN) {
      var keep = $('#f-by') ? $('#f-by').value : '';
      $('#post').innerHTML = postHtml(d.missing || []);
      $('#f-by').value = keep || store('mu-by') || '';
      syncNotify();
    }
    paint();
    if (ALL.length) {
      $('#foot').textContent = 'Every Monday since ' + nice(ALL[ALL.length - 1].date) + '.';
    }
  }

  // Who picked it is almost always the same person two weeks running, and
  // typing a full name every Monday is the kind of friction that ends with
  // the field left empty.
  function store(k, v) {
    try {
      if (v === undefined) return window.localStorage.getItem(k) || '';
      window.localStorage.setItem(k, v);
    } catch (e) { /* private window; the field simply starts empty */ }
    return v || '';
  }

  function post(e) {
    e.preventDefault();
    var go = $('#f-go');
    if (go.disabled) return;
    var date = $('#f-date').value;
    var file = $('#f-photo').files[0];
    go.disabled = true;
    say('Posting\u2026');

    fetch('/api/music', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        date: date,
        artist: $('#f-artist').value,
        song: $('#f-song').value,
        by: $('#f-by').value,
        watch: $('#f-watch').value,
        notify: $('#f-tell') ? $('#f-tell').checked : false,
      }),
    })
      .then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok) throw new Error((b.errors && b.errors.join(' ')) || b.error
            || ('The server answered ' + r.status + '.'));
          return b;
        });
      })
      // The pick is filed before the picture goes up, because the row has to
      // exist for the key to be written against it. A picture that fails
      // therefore loses the picture, never the pick.
      .then(function (b) {
        store('mu-by', $('#f-by').value);
        if (!file) return b;
        say('Posted. Sending the picture\u2026');
        return shrink(file)
          .then(function (blob) {
            return fetch('/api/music/photo?date=' + encodeURIComponent(date), {
              method: 'POST',
              headers: { 'content-type': 'image/webp' },
              body: blob,
            });
          })
          .then(function (r) {
            return r.json().then(function (p) {
              if (!r.ok) throw new Error(p.error || ('The picture got ' + r.status + '.'));
              return p;
            });
          })
          .catch(function (err) {
            // Named plainly rather than swallowed: the pick IS up, and
            // somebody who thinks the whole thing failed will post it twice.
            absorb(b);
            throw new Error('The pick is up, but the picture did not go: ' + err.message);
          });
      })
      .then(function (b) {
        absorb(b);
        // Named, not assumed. A pick that went up while the channel was
        // never told is the failure this whole move was meant to prevent,
        // so it is said out loud rather than left to be discovered.
        if (b.slack && b.slack.told) say('Posted, and Slack told.');
        else if (b.slack && b.slack.why) say('Posted. Slack was NOT told: ' + b.slack.why, true);
        else say('Posted.');
      })
      .catch(function (err) { say(err.message, true); })
      .then(function () { if ($('#f-go')) $('#f-go').disabled = false; });
  }

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
      absorb(d);
      if (!ALL.length) {
        $('#notice').innerHTML = '<div class="notice"><strong>Nothing to show.</strong> '
          + esc(d.reason || 'The archive is empty.') + '</div>';
      }
    })
    .catch(function (err) { failed(err.message); });

  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'q') paint();
    if (e.target && e.target.id === 'f-date') syncNotify();
  });

  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'post-f') post(e);
  });

  // A missing Monday fills the date rather than explaining itself.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.mu-gap') : null;
    if (!b) return;
    $('#f-date').value = b.getAttribute('data-d');
    syncNotify();
    $('#f-artist').focus();
  });
})();
