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
    // Every category had an icon name from the start; only five of them
    // existed, so most of the page fell back to the generic chain link and
    // the row read as eleven of the same thing. These are the rest.
    truck: '<path d="M2 7.5h11v9H2zM13 11h4.2l2.8 3v2.5h-7z"/><circle cx="6.5" cy="18.5" r="1.9"/><circle cx="16.5" cy="18.5" r="1.9"/>',
    store: '<path d="M3.5 9.5h17V20h-17z"/><path d="M2.5 9.5 4.5 4h15l2 5.5"/><path d="M9.5 20v-5.5h5V20"/>',
    wave: '<path d="M2 9c2.5-2.5 5-2.5 7.5 0S15 11.5 17.5 9 22 6.5 22 6.5"/><path d="M2 14.5c2.5-2.5 5-2.5 7.5 0s5.5 2.5 8 0 4.5-2.5 4.5-2.5"/><path d="M2 20c2.5-2.5 5-2.5 7.5 0"/>',
    ink: '<path d="M12 2.8s6 6.4 6 10.3a6 6 0 0 1-12 0C6 9.2 12 2.8 12 2.8z"/><path d="M9.5 13.8a2.6 2.6 0 0 0 2.5 2.6"/>',
    megaphone: '<path d="M3.5 10v4a1.5 1.5 0 0 0 1.5 1.5h2L15 20V4L7 8.5H5A1.5 1.5 0 0 0 3.5 10z"/><path d="M18.5 9.5a4 4 0 0 1 0 5"/><path d="M7 15.5V20"/>',
    route: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M6 8v4.5a3.5 3.5 0 0 0 3.5 3.5H15"/>',
    board: '<rect x="3" y="4" width="18" height="16.5" rx="2"/><path d="M3 9h18M9 9v11.5M15 9v11.5"/>',
    tag: '<path d="M11 2.8H20a1.2 1.2 0 0 1 1.2 1.2v9l-9.4 9.4a1.2 1.2 0 0 1-1.7 0l-8-8a1.2 1.2 0 0 1 0-1.7z"/><circle cx="17" cy="7" r="1.6"/>',
    // On-brand rather than generic: the foundation recycles shells, INK
    // pulls screens, ProDev measures garments, and Women's hangs them.
    shell: '<path d="M12 20.5C6.8 17.8 3.2 13 3.2 8.6A5.4 5.4 0 0 1 12 4.3a5.4 5.4 0 0 1 8.8 4.3c0 4.4-3.6 9.2-8.8 11.9z"/><path d="M12 20.5V4.3M7.4 18.1 9.6 5.1M16.6 18.1 14.4 5.1"/>',
    squeegee: '<path d="M4.5 3.8h15v5.4h-15z"/><path d="M12 9.2v7.4"/><path d="M6.5 20.2h11"/><path d="M8.8 16.6h6.4v3.6H8.8z"/>',
    tape: '<path d="M3 7.5h18v9H3z"/><path d="M6.5 7.5v3M9.5 7.5v4.5M12.5 7.5v3M15.5 7.5v4.5M18.5 7.5v3"/>',
    hanger: '<path d="M12 7.6a2.2 2.2 0 1 1 2.2-2.2"/><path d="M12 7.6v2.2L3.4 16a1.3 1.3 0 0 0 .8 2.4h15.6a1.3 1.3 0 0 0 .8-2.4L12 9.8"/>',
    // The flagship, literally. Long Branch already has the storefront, and
    // two shops drawn the same way defeats the point of drawing them.
    flag: '<path d="M5.5 21V3.2"/><path d="M5.5 4.3h12.2l-2.4 3.9 2.4 3.9H5.5z"/>',
    // A ledger, not a calculator: the budget is 77 lines down a page, which
    // is what it looks like, and a calculator would say "arithmetic" when
    // the hard part is the note beside each line.
    calc: '<rect x="4" y="2.8" width="16" height="18.4" rx="2"/><path d="M8 7.5h8M8 11.5h8M8 15.5h4.5"/>',
    music: '<circle cx="6.2" cy="17.6" r="2.9"/><circle cx="17.8" cy="15.4" r="2.9"/><path d="M9.1 17.6V6.2l11.6-2.2v11.4"/><path d="M9.1 9.4 20.7 7.2"/>',
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
          + catIcon(c.icon)
          + '<span class="cb-name">' + esc(c.label) + '</span></span>';
      }
      return '<button type="button" class="cb' + (c.key === sel ? ' on' : '') + '" '
        + 'data-cat="' + esc(c.key) + '" aria-pressed="' + (c.key === sel) + '">'
        + catIcon(c.icon)
        + '<span class="cb-name">' + esc(c.label) + '</span>'
        + '<span class="cb-n">' + n + '</span>'
        + '</button>';
    }).join('');
  }

  // Bigger than the tile icon, and above the label rather than beside it, so
  // the row reads as eleven distinct things at a glance instead of eleven
  // lines of small caps.
  function catIcon(key) {
    var path = ICONS[key] || ICONS.link;
    return '<span class="cb-ico"><svg viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">' + path + '</svg></span>';
  }

  // Everything on this page leaves the dash, so everything opens beside it.
  // rel=noopener is not optional with target=_blank: without it the page
  // that opens gets a handle on this one through window.opener and can
  // navigate it somewhere else. noreferrer keeps our address out of the
  // other end's logs, which matters for the vendor portals among the links.
  var OUT = ' target="_blank" rel="noopener noreferrer"';

  function tileLine(t) {
    return '<a class="tl"' + OUT + ' href="' + esc(t.url) + '">'
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

  // The right column. Links are bookmarks rather than tools -- an address
  // with nothing of ours behind it -- so everybody gets all of them and the
  // category is only a way to narrow the list.
  //
  // Its filter is deliberately its own, not the row along the top. That row
  // is about tiles, and a category you hold no tile in leaves its chip shut
  // -- so following it would make those links unreachable for precisely the
  // people links exist to serve.
  var LFILTER = '';

  function linksHtml(me) {
    var all = me.links || [];
    if (!all.length) {
      if (!me.isAdmin) return '';
      return head('')
        + '<div class="lk-empty">No links yet. They are bookmarks and forms rather'
        + ' than tools \u2014 a form, a doc, a vendor portal \u2014 and everybody'
        + ' sees them. Add them under Links in Setup.</div>';
    }

    // Only categories that actually hold a link, so the filter never offers
    // a choice that empties the list.
    var used = {};
    all.forEach(function (l) { (l.cats || []).forEach(function (k) { used[k] = true; }); });
    var opts = (me.cats || []).filter(function (c) { return used[c.key]; });

    var shown = LFILTER
      ? all.filter(function (l) { return (l.cats || []).indexOf(LFILTER) !== -1; })
      : all;

    return head(opts)
      + '<div class="lk-list">'
      + (shown.length
          ? shown.map(function (l) {
              return '<a class="lk"' + OUT + ' href="' + esc(l.url) + '">'
                + esc(l.name) + '</a>';
            }).join('')
          : '<div class="lk-empty">Nothing filed under that one.</div>')
      + '</div>';

    function head(options) {
      var sel = '';
      if (options && options.length) {
        sel = '<select class="lk-filter" id="lkfilter" aria-label="Filter links by category">'
          + '<option value="">All (' + all.length + ')</option>'
          + options.map(function (c) {
              var n = all.filter(function (l) {
                return (l.cats || []).indexOf(c.key) !== -1;
              }).length;
              return '<option value="' + esc(c.key) + '"'
                + (c.key === LFILTER ? ' selected' : '') + '>'
                + esc(c.label) + ' (' + n + ')</option>';
            }).join('')
          + '</select>';
      }
      return '<div class="links-head">Links &amp; Forms</div>' + sel;
    }
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
    var links = linksHtml(STATE);
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
    if (shutOut) {
      $('#catbar').innerHTML = '';
      $('#pane').innerHTML = '';
      $('#links').hidden = true;
      $('#shell').classList.remove('split');
      return;
    }
    if (!openOnes.length) {
      // Holding no tiles does not mean an empty page any more. Links go to
      // everybody, so the column still stands -- it is the one thing on
      // here a brand new person can use on their first morning.
      $('#catbar').innerHTML = catbarHtml(cats, '');
      $('#pane').innerHTML = emptyHtml(me);
      var only = linksHtml(me);
      $('#links').innerHTML = only;
      $('#links').hidden = !only;
      $('#shell').classList.toggle('split', Boolean(only));
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

  // Narrowing the links does not touch the tiles, and repainting the whole
  // page would throw away which category is open above.
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'lkfilter') return;
    LFILTER = e.target.value;
    var el = $('#links');
    el.innerHTML = linksHtml(STATE);
    el.hidden = !el.innerHTML;
  });

  fetch('/api/me', { headers: { accept: 'application/json' } })
    .then(function (r) {
      // The Worker puts the actual fault in the body -- "no such column",
      // and so on. Reporting the status alone turned a one-line diagnosis
      // into guesswork, so read the body before giving up on it.
      if (!r.ok) {
        return r.json().then(function (b) {
          throw new Error((b && b.error) || 'The server answered ' + r.status + '.');
        }, function () {
          throw new Error('The server answered ' + r.status + '.');
        });
      }
      return r.json();
    })
    .then(render)
    .catch(function (err) { failed(err.message); });
})();
