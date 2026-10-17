(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Line art rather than emoji: emoji render differently on every machine and
  // carry a colour we do not control, which on a dark page is a coin toss.
  var ICONS = {
    calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    people: '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16.5 5.2a3.4 3.4 0 0 1 0 6.6M17.5 14.4c2.4.5 4 2.6 4 5.6"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6"/>',
  };

  function iconHtml(key) {
    var path = ICONS[key] || ICONS.link;
    return '<span class="tile-ico"><svg viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">' + path + '</svg></span>';
  }

  // Every tile on the page is a link, because the server only sends tiles the
  // person can actually open. There is no greyed-out state to draw.
  function tileHtml(t) {
    return '<a class="tile" href="' + esc(t.url) + '">'
      + '<div class="tile-top">' + iconHtml(t.icon)
      + '<span class="tile-name">' + esc(t.name) + '</span></div>'
      + '<p class="tile-blurb">' + esc(t.blurb) + '</p>'
      + '</a>';
  }

  // Categories down the left, each opening to the tiles inside it. Every
  // category somebody has something in is listed; one they have nothing in
  // is absent rather than empty, which is what makes the list worth reading.
  //
  // Open by default. A page that starts as eleven closed bars makes somebody
  // click to find out whether there is anything behind them.
  var SHUT = {};

  function tileLine(t) {
    return '<a class="tl" href="' + esc(t.url) + '">'
      + iconHtml(t.icon)
      + '<span class="tl-txt"><span class="tl-name">' + esc(t.name) + '</span>'
      + (t.blurb ? '<span class="tl-blurb">' + esc(t.blurb) + '</span>' : '')
      + '</span></a>';
  }

  function catsHtml(sections) {
    if (!sections.length) return '';
    return sections.map(function (s) {
      // Only an admin is sent these, and only while building the thing out:
      // a category nobody has a tile in, shown so the page has a shape.
      if (s.empty) {
        return '<section class="cat empty" data-cat="' + esc(s.key) + '">'
          + '<div class="cat-h">'
            + '<span class="cat-name">' + esc(s.label) + '</span>'
            + '<span class="cat-n">0</span>'
          + '</div></section>';
      }
      var shut = !!SHUT[s.key];
      return '<section class="cat' + (shut ? ' shut' : '') + '" data-cat="' + esc(s.key) + '">'
        + '<button type="button" class="cat-h" data-toggle="' + esc(s.key) + '" '
          + 'aria-expanded="' + (shut ? 'false' : 'true') + '">'
          + '<span class="cat-caret" aria-hidden="true">\u203a</span>'
          + '<span class="cat-name">' + esc(s.label) + '</span>'
          + '<span class="cat-n">' + s.tiles.length + '</span>'
        + '</button>'
        + '<div class="cat-body">' + s.tiles.map(tileLine).join('') + '</div>'
        + '</section>';
    }).join('');
  }

  // The far right. Links are bookmarks rather than tools -- an address with
  // nothing of ours behind it -- so they are listed compactly and go to
  // everybody.
  function linksHtml(sections, isAdmin) {
    // Nobody on staff should see an empty column where links will one day
    // be. The admin should, because otherwise there is nowhere on the page
    // that shows links exist at all.
    if (!sections || !sections.length) {
      if (!isAdmin) return '';
      return '<div class="links-head">Links</div>'
        + '<div class="lk-empty">No links yet. They are bookmarks rather than'
        + ' tools \u2014 a form, a doc, a vendor portal \u2014 and everybody sees'
        + ' them. Add them under Links in Setup.</div>';
    }
    return '<div class="links-head">Links</div>'
      + sections.map(function (s) {
          return '<div class="lk-group"><div class="lk-cat">' + esc(s.label) + '</div>'
            + s.links.map(function (l) {
                return '<a class="lk" href="' + esc(l.url) + '">' + esc(l.name) + '</a>';
              }).join('')
            + '</div>';
        }).join('');
  }

  function noticeHtml(me) {
    // Ordered by what the person should do about it, not by severity.
    if (!me.accessConfigured) {
      return '<div class="notice"><strong>This dash is not behind Access yet.</strong> '
        + 'Nobody is being identified, so only the tools open to everyone are shown. '
        + 'Set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code> on the Worker '
        + 'to turn sign-in on.</div>';
    }
    if (!me.verified) {
      // Nothing is shown in this state, so the notice is the whole page. It
      // says what is wrong rather than reassuring, because the usual cause is
      // a hostname missing from the Access application and no amount of
      // signing in again fixes that.
      return '<div class="notice"><strong>You are not signed in, so nothing is shown.</strong> '
        + esc(me.reason || '') + '</div>';
    }
    return '';
  }

  function subLine(me) {
    var n = me.tiles.length;
    if (!n) return 'Nothing is open to you yet.';
    return n === 1 ? 'One tool is open to you.' : n + ' tools are open to you.';
  }

  // Everything on this page is something the person can open, so the empty
  // case is the only one that needs explaining.

  function emptyHtml(me) {
    // Signed in and holding nothing is a real state, not a fault, and saying
    // so is the difference between "ask Jeremy" and "report a bug".
    if (me.verified) {
      return '<div class="tiles-empty"><strong>Nothing has been given to you yet.</strong><br>'
        + 'That is why this page is empty rather than anything being wrong with it. '
        + 'Ask Jeremy for the tools you need.</div>';
    }
    return '<div class="tiles-empty">Nothing to show yet.</div>';
  }

  function footHtml(me) {
    var all = me.sections || [];
    var live = all.filter(function (s) { return !s.empty; });
    if (!all.length) return '';
    // Sections, not groups. Which sections somebody has is a consequence of
    // the tiles they hold, so it is a description of their page rather than
    // a claim about their job -- which is how the old wording read.
    var out = live.length === 1 ? 'One section.' : live.length + ' sections.';
    var empty = all.length - live.length;
    // Said plainly, because an admin seeing eleven categories would
    // otherwise assume everybody else sees eleven categories.
    if (empty) {
      out += ' ' + empty + ' empty ' + (empty === 1 ? 'category is' : 'categories are')
        + ' shown dashed because you are an admin \u2014 nobody else sees them'
        + ' until something is assigned.';
    }
    return out;
  }

  var STATE = {};

  function render(me) {
    STATE = me;
    // The Setup link only appears for somebody who can actually use it; the
    // endpoints behind it answer 404 to everybody else, so this is tidiness
    // rather than the control.
    $('#who').innerHTML = (me.isAdmin ? '<a class="setup" href="/admin.html">Setup</a> \u00b7 ' : '')
      + esc(me.email ? me.email : 'not signed in');
    // Access is in front and this request did not come through it. The
    // notice is then the entire page: a greeting to nobody and two separate
    // lines saying nothing is here only bury the one sentence that explains
    // why and says how to fix it.
    var shutOut = me.accessConfigured && !me.verified;
    $('#greeting').textContent = shutOut ? '' : me.greeting;
    $('#sub').textContent = shutOut ? '' : subLine(me);
    $('#notice').innerHTML = noticeHtml(me);
    $('#cats').innerHTML = shutOut ? ''
      : (me.tiles.length ? catsHtml(me.sections || []) : emptyHtml(me));
    var links = linksHtml(me.links, me.isAdmin);
    $('#links').innerHTML = links;
    $('#links').hidden = !links;
    $('#shell').classList.toggle('split', Boolean(links));
    $('#foot').innerHTML = footHtml(me);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (!t) return;
    var key = t.dataset.toggle;
    SHUT[key] = !SHUT[key];
    var sect = t.closest('.cat');
    sect.classList.toggle('shut', SHUT[key]);
    t.setAttribute('aria-expanded', SHUT[key] ? 'false' : 'true');
  });

  fetch('/api/me', { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('The server answered ' + r.status + '.');
      return r.json();
    })
    .then(render)
    .catch(function (err) { failed(err.message); });
})();
