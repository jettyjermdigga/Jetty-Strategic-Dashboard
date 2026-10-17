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

  // ── The row of categories across the top ──────────────────────────────
  //
  // All of them, always, in the order Setup lists them. One you have
  // something in is a button; one you have nothing in is inert text. A
  // department's NAME is not a secret -- everybody knows the company has a
  // Finance -- so the row is the same shape for everybody, and what differs
  // is which of them open.
  //
  // Clicking one shows its tiles below and its links on the right.

  var SEL = '';

  function catbarHtml(cats, sel) {
    return cats.map(function (c) {
      var n = c.tiles.length + c.links.length;
      if (!c.open) {
        // Not a button: there is nothing behind it, and a thing that looks
        // clickable and is not is worse than a thing that looks inert.
        return '<span class="cb shut" aria-disabled="true">'
          + '<span class="cb-name">' + esc(c.label) + '</span></span>';
      }
      return '<button type="button" class="cb' + (c.key === sel ? ' on' : '') + '" '
        + 'data-cat="' + esc(c.key) + '" aria-pressed="' + (c.key === sel) + '">'
        + '<span class="cb-name">' + esc(c.label) + '</span>'
        + '<span class="cb-n">' + n + '</span>'
        + '</button>';
    }).join('');
  }

  function tileLine(t) {
    return '<a class="tl" href="' + esc(t.url) + '">'
      + iconHtml(t.icon)
      + '<span class="tl-txt"><span class="tl-name">' + esc(t.name) + '</span>'
      + (t.blurb ? '<span class="tl-blurb">' + esc(t.blurb) + '</span>' : '')
      + '</span></a>';
  }

  // Below the row: the tiles of whichever category is selected.
  function paneHtml(cat) {
    if (!cat) return '';
    if (!cat.tiles.length) {
      // A category can be open on its links alone. Saying so is the
      // difference between "you have no tools here" and "this is broken".
      return '<div class="pane-empty">No tools in ' + esc(cat.label)
        + ' are assigned to you' + (cat.links.length ? ', but its links are on the right.' : '.')
        + '</div>';
    }
    return '<div class="cat"><div class="cat-body">'
      + cat.tiles.map(tileLine).join('') + '</div></div>';
  }

  // The right column: the selected category's links. Bookmarks rather than
  // tools -- an address with nothing of ours behind it -- so everybody gets
  // them and there is nothing to assign.
  function linksHtml(cat) {
    if (!cat || !cat.links.length) return '';
    return '<div class="links-head">Links · ' + esc(cat.label) + '</div>'
      + '<div class="lk-group">'
      + cat.links.map(function (l) {
          return '<a class="lk" href="' + esc(l.url) + '">' + esc(l.name) + '</a>';
        }).join('')
      + '</div>';
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

  function footHtml(me) {
    var cats = me.cats || [];
    var open = cats.filter(function (c) { return c.open; }).length;
    if (!cats.length) return '';
    var shut = cats.length - open;
    // Said plainly. A row of eleven with two lit is the normal state, not a
    // page half broken, and nobody should have to work that out.
    return open + ' of ' + cats.length + ' categories '
      + (open === 1 ? 'is' : 'are') + ' open to you'
      + (shut ? '. The rest have nothing in them for you yet.' : '.');
  }

  var STATE = {};

  function paint() {
    var cats = STATE.cats || [];
    var cat = cats.filter(function (c) { return c.key === SEL; })[0];
    $('#catbar').innerHTML = catbarHtml(cats, SEL);
    $('#pane').innerHTML = paneHtml(cat);
    var links = linksHtml(cat);
    $('#links').innerHTML = links;
    $('#links').hidden = !links;
    $('#shell').classList.toggle('split', Boolean(links));
  }

  function render(me) {
    STATE = me;
    // The Setup link only appears for somebody who can actually use it; the
    // endpoints behind it answer 404 to everybody else, so this is tidiness
    // rather than the control.
    $('#who').innerHTML = (me.isAdmin ? '<a class="setup" href="/admin.html">Setup</a> · ' : '')
      + esc(me.email ? me.email : 'not signed in');

    // Access is in front and this request did not come through it. The
    // notice is then the entire page: a greeting to nobody and a row of
    // categories with nothing in any of them only bury the one sentence
    // that explains why and says how to fix it.
    var shutOut = me.accessConfigured && !me.verified;
    $('#greeting').textContent = shutOut ? '' : me.greeting;
    $('#sub').textContent = shutOut ? '' : subLine(me);
    $('#notice').innerHTML = noticeHtml(me);
    $('#foot').innerHTML = shutOut ? '' : footHtml(me);

    var cats = me.cats || [];
    var openOnes = cats.filter(function (c) { return c.open; });
    if (shutOut || !openOnes.length) {
      $('#catbar').innerHTML = shutOut ? '' : catbarHtml(cats, '');
      $('#pane').innerHTML = shutOut ? '' : emptyHtml(me);
      $('#links').hidden = true;
      $('#shell').classList.remove('split');
      return;
    }
    // Land on the first one that has something in it. Opening on an empty
    // page and making somebody hunt for which of eleven is lit is a worse
    // first second than simply showing them something.
    SEL = openOnes[0].key;
    paint();
  }

  function emptyHtml(me) {
    // Signed in and holding nothing is a real state, not a fault, and saying
    // so is the difference between "ask Jeremy" and "report a bug".
    if (me.verified) {
      return '<div class="pane-empty"><strong>Nothing has been given to you yet.</strong><br>'
        + 'That is why this page is empty rather than anything being wrong with it. '
        + 'Ask Jeremy for the tools you need.</div>';
    }
    return '<div class="pane-empty">Nothing to show yet.</div>';
  }

  function failed(msg) {
    $('#notice').innerHTML = '<div class="notice"><strong>The dash could not load.</strong> '
      + esc(msg) + '</div>';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-cat]');
    if (!t) return;
    SEL = t.dataset.cat;
    paint();
  });

  fetch('/api/me', { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('The server answered ' + r.status + '.');
      return r.json();
    })
    .then(render)
    .catch(function (err) { failed(err.message); });
})();
