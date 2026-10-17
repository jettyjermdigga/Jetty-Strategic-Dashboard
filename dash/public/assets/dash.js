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

  // A column shows this many tiles. The rest are a click away rather than a
  // scroll away: eleven categories deep enough to need scrolling would bury
  // the ones further down the page.
  var CAP = 2;

  function sectionsHtml(sections) {
    return sections.map(function (s) {
      var shown = s.tiles.slice(0, CAP);
      var rest = s.tiles.length - shown.length;
      // The heading only becomes a control when there is something behind it.
      var head = rest > 0
        ? '<h2 class="sect-h more" data-cat="' + esc(s.key) + '">' + esc(s.label) + '</h2>'
        : '<h2 class="sect-h">' + esc(s.label) + '</h2>';
      return '<section class="sect">' + head
        + '<div class="tiles">' + shown.map(tileHtml).join('') + '</div>'
        + (rest > 0
            ? '<button type="button" class="sect-more" data-cat="' + esc(s.key) + '">'
              + '+' + rest + ' more</button>'
            : '')
        + '</section>';
    }).join('');
  }

  // The list beside the columns: one category, in full, with the blurbs
  // untruncated. The tiles are capped to keep the columns even; this is where
  // the rest of them live.
  function openSide(key) {
    var s = (STATE.sections || []).filter(function (x) { return x.key === key; })[0];
    if (!s) return;
    $('#side').innerHTML =
      '<div class="side-head"><h2 class="side-h">' + esc(s.label) + '</h2>'
      + '<button type="button" class="side-x" id="sideX" aria-label="Close">\u00d7</button></div>'
      + '<div class="side-body">' + s.tiles.map(function (t) {
          return '<a class="side-row" href="' + esc(t.url) + '">'
            + '<span class="side-name">' + esc(t.name) + '</span>'
            + '<p class="side-blurb">' + esc(t.blurb) + '</p></a>';
        }).join('') + '</div>';
    $('#side').hidden = false;
    $('#shell').classList.add('split');
  }

  function closeSide() {
    $('#side').hidden = true;
    $('#side').innerHTML = '';
    $('#shell').classList.remove('split');
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
      return '<div class="notice"><strong>Your sign-in could not be verified.</strong> '
        + esc(me.reason || '') + ' Try signing out and in again; if it keeps happening, '
        + 'the Access application for this site needs a look.</div>';
    }
    if (me.groups === null) {
      return '<div class="notice"><strong>Your groups could not be looked up, '
        + 'so this is not the full list.</strong> ' + esc(me.groupReason || '')
        + ' Nothing has been taken away — reload in a minute and it should come back.</div>';
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
    if (me.groups && me.groups.length === 0) {
      return '<div class="tiles-empty"><strong>You are not in any groups yet.</strong><br>'
        + 'That is why this page is empty rather than anything being wrong with it. '
        + 'Ask Jeremy to put you in the groups for the tools you need.</div>';
    }
    return '<div class="tiles-empty">Nothing to show yet.</div>';
  }

  function footHtml(me) {
    if (!Array.isArray(me.groups) || !me.groups.length) return '';
    // "You are in FINANCIALS, RETAIL" read as a claim about somebody's job.
    // It is not -- it is which sections of the portal they get.
    return 'Your sections: <span class="grp">'
      + me.groups.map(esc).join('</span>, <span class="grp">') + '</span>';
  }

  var STATE = {};

  function render(me) {
    STATE = me;
    // The Setup link only appears for somebody who can actually use it; the
    // endpoints behind it answer 404 to everybody else, so this is tidiness
    // rather than the control.
    $('#who').innerHTML = (me.isAdmin ? '<a class="setup" href="/admin.html">Setup</a> \u00b7 ' : '')
      + esc(me.email ? me.email : 'not signed in');
    $('#greeting').textContent = me.greeting;
    $('#sub').textContent = subLine(me);
    $('#notice').innerHTML = noticeHtml(me);
    $('#tiles').innerHTML = me.tiles.length
      ? sectionsHtml(me.sections || [{ key: 'all', label: '', tiles: me.tiles }])
      : emptyHtml(me);
    $('#foot').innerHTML = footHtml(me);
    closeSide();
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('#sideX')) return closeSide();
    var opener = e.target.closest('[data-cat]');
    if (opener) return openSide(opener.dataset.cat);
  });

  function failed(msg) {
    $('#greeting').textContent = 'The dash could not load';
    $('#sub').textContent = '';
    $('#notice').innerHTML = '<div class="notice"><strong>Something went wrong '
      + 'fetching your tools.</strong> ' + esc(msg) + '</div>';
  }

  fetch('/api/me', { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('The server answered ' + r.status + '.');
      return r.json();
    })
    .then(render)
    .catch(function (err) { failed(err.message); });
})();
