(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var D = { tiles: [], categories: [], links: [], people: [], admins: [], you: '' };

  function api(path, body) {
    return fetch('/api/admin/' + path, body ? {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } : { headers: { accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        // An errors array is the server saying what is wrong with what was
        // typed. It is shown next to the form rather than thrown, because it
        // is the person's answer that needs changing, not the request.
        if (!r.ok && !j.errors) {
          var err = new Error(j.error || ('The server answered ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function say(msg, bad) {
    var n = $('#notice');
    if (!msg) { n.innerHTML = ''; return; }
    n.innerHTML = '<div class="notice' + (bad ? '' : ' good') + '">' + esc(msg) + '</div>';
    if (!bad) setTimeout(function () { if (n.textContent === msg) n.innerHTML = ''; }, 2600);
  }

  var ICONS = ['link', 'calendar', 'chart', 'box', 'people', 'truck', 'store',
    'wave', 'ink', 'megaphone', 'route', 'board', 'tag',
    'shell', 'squeegee', 'tape', 'hanger'];

  function iconSelect(cls, chosen) {
    return '<select class="' + cls + '">' + ICONS.map(function (i) {
      return '<option value="' + i + '"' + (i === chosen ? ' selected' : '') + '>' + i + '</option>';
    }).join('') + '</select>';
  }

  // ── tiles ───────────────────────────────────────────────────────────────

  // Five answers: name, description, address, category, icon. One row each,
  // top to bottom, so the whole catalogue is readable at a glance instead of
  // being a column of cards to scroll.
  function tileRow(t) {
    var isNew = !t;
    var it = t || { key: '', name: '', blurb: '', url: '',
                    category: (D.categories[0] || {}).key, icon: 'link', everyone: false };
    return '<form class="row tile-row' + (isNew ? ' new' : '') + '" data-key="' + esc(it.key) + '">'
      + '<input class="f-name" value="' + esc(it.name) + '" maxlength="80" placeholder="Name">'
      + '<input class="f-blurb" value="' + esc(it.blurb) + '" maxlength="300" placeholder="Description">'
      + '<input class="f-url" value="' + esc(it.url) + '" placeholder="https://">'
      + '<select class="f-cat">' + D.categories.map(function (c) {
          return '<option value="' + esc(c.key) + '"'
            + (c.key === it.category ? ' selected' : '') + '>' + esc(c.label) + '</option>';
        }).join('') + '</select>'
      + iconSelect('f-icon', it.icon)
      + '<label class="cb tiny" title="Everybody on staff gets this one">'
        + '<input type="checkbox" class="f-everyone"' + (it.everyone ? ' checked' : '') + '> All</label>'
      + '<div class="row-acts">'
        + '<button type="submit" class="btn small primary">' + (isNew ? 'Add' : 'Save') + '</button>'
        + (isNew ? '' : '<button type="button" class="btn small danger del">&times;</button>')
      + '</div>'
      + '<div class="errs"></div></form>';
  }

  function paintTiles() {
    var live = D.tiles.filter(function (t) { return t.url; }).length;
    $('#pane-tiles').innerHTML =
      '<p class="pane-note">' + D.tiles.length + ' tiles, ' + live + ' of them on the dash. '
      + 'A tile shows once it has an address, to the people it is given to \u2014 or to '
      + 'everybody, if All is ticked.</p>'
      + '<div class="rows"><div class="row head">'
        + '<span>Name</span><span>Description</span><span>Address</span>'
        + '<span>Category</span><span>Icon</span><span>All</span><span></span></div>'
      + D.tiles.map(tileRow).join('')
      + tileRow(null) + '</div>';
  }

  // ── groups and categories ───────────────────────────────────────────────

  // ── people ──────────────────────────────────────────────────────────────

  // The tiles somebody has been given, as a box of chips. Assigning a tile
  // is the only thing that puts it on their dash -- a section appears
  // because there is something in it, and is absent otherwise.
  function tileBox(selected) {
    var sel = selected || [];
    return chipBox('tiles', sel);
  }

  // The same box of chips serves two jobs now: the tiles a person holds,
  // and the categories a link is filed under. One widget, told which list
  // to draw from, rather than a second one that behaves almost the same.
  function chipSrc(src) {
    if (src === 'cats') {
      return D.categories.map(function (c) { return { key: c.key, label: c.label }; });
    }
    // A tile open to everyone is not offered: ticking it onto one person
    // would say something the tile has already said for all of them.
    return D.tiles.filter(function (t) { return !t.everyone; })
      .map(function (t) { return { key: t.key, label: t.name }; });
  }

  function chipBox(src, sel) {
    var list = chipSrc(src);
    var label = function (k) {
      var m = list.filter(function (x) { return x.key === k; })[0];
      return m ? m.label : k;
    };
    var chips = sel.map(function (k) {
      return '<span class="chip" data-key="' + esc(k) + '">' + esc(label(k))
        + '<button type="button" class="chip-x" aria-label="Remove">\u00d7</button></span>';
    }).join('');
    var rest = list.filter(function (x) { return sel.indexOf(x.key) < 0; });
    var add = rest.length
      ? '<select class="sec-add"><option value="">+ ' + (src === 'cats' ? 'Category' : 'Tile')
        + '</option>'
        + rest.map(function (x) {
            return '<option value="' + esc(x.key) + '">' + esc(x.label) + '</option>';
          }).join('') + '</select>'
      : '';
    return '<div class="secbox" data-src="' + esc(src) + '">' + chips + add + '</div>';
  }

  function personRow(p) {
    var isNew = !p;
    var it = p || { email: '', name: '', tiles: [] };
    return '<form class="row person" data-email="' + esc(it.email) + '">'
      + '<input class="f-pname" value="' + esc(it.name) + '" maxlength="80" placeholder="Name">'
      + '<input class="f-email" value="' + esc(it.email) + '" '
        + (isNew ? 'placeholder="name@jettylife.com"' : 'readonly') + '>'
      + tileBox(it.tiles)
      + '<div class="row-acts">'
        + '<button type="submit" class="btn small primary">' + (isNew ? 'Add' : 'Save') + '</button>'
        + (isNew ? '' : '<button type="button" class="btn small danger del">&times;</button>')
      + '</div>'
      + '<div class="errs"></div></form>';
  }

  function paintPeople() {
    var none = D.people.filter(function (p) { return !p.tiles.length; }).length;
    var open = D.tiles.filter(function (t) { return t.everyone; }).length;
    $('#pane-people').innerHTML =
      '<p class="pane-note">' + D.people.length + ' people'
      + (none ? ', ' + none + ' of them given nothing yet \u2014 they still sign in, and '
          + 'still get the ' + open + ' ' + (open === 1 ? 'tile' : 'tiles')
          + ' open to everyone.' : '.')
      + ' A section appears on somebody\u2019s dash because they have a tile in it.</p>'
      + '<div class="rows people"><div class="row head">'
        + '<span>Name</span><span>Email</span><span>Tiles they get</span><span></span></div>'
      + D.people.map(personRow).join('')
      + personRow(null) + '</div>';
  }

  // ── links ───────────────────────────────────────────────────────────────

  // A bookmark: a name, an address, and which section it belongs under. No
  // icon and nobody to assign it to -- everybody sees links, because the
  // thing on the far end sets its own access just as a tile's tool does.
  function linkRow(l) {
    var isNew = !l;
    var it = l || { key: '', name: '', url: '', cats: [] };
    return '<form class="row link-row' + (isNew ? ' new' : '') + '" data-key="' + esc(it.key) + '">'
      + '<input class="f-lname" value="' + esc(it.name) + '" maxlength="80" placeholder="Name">'
      + '<input class="f-lurl" value="' + esc(it.url) + '" placeholder="https://">'
      + chipBox('cats', it.cats || [])
      + '<div class="row-acts">'
        + '<button type="submit" class="btn small primary">' + (isNew ? 'Add' : 'Save') + '</button>'
        + (isNew ? '' : '<button type="button" class="btn small danger del">&times;</button>')
      + '</div>'
      + '<div class="errs"></div></form>';
  }

  function paintLinks() {
    $('#pane-links').innerHTML =
      '<p class="pane-note">' + D.links.length + ' links. A link is an address with '
      + 'nothing of ours behind it \u2014 a form, a doc, a vendor portal. They sit in '
      + 'Links &amp; Forms down the right of the dash and everybody sees them, whatever '
      + 'tiles they hold. Categories here do not decide who sees a link, only how the '
      + 'list can be narrowed \u2014 so put a link in every category somebody might '
      + 'look for it under.</p>'
      + '<div class="rows links"><div class="row head">'
        + '<span>Name</span><span>Address</span><span>Categories</span><span></span></div>'
      + D.links.map(linkRow).join('')
      + linkRow(null) + '</div>';
  }

  // Categories are the one list now -- the sections of the dash, and the
  // thing a person is in. Name and icon, nothing else.
  function catRow(c) {
    var isNew = !c;
    var it = c || { key: '', label: '', icon: 'link' };
    var tiles = D.tiles.filter(function (t) { return t.category === it.key; }).length;
    // How many people hold a tile in this section -- the honest measure of
    // whether a section is doing anything.
    var keys = D.tiles.filter(function (t) { return t.category === it.key; })
      .map(function (t) { return t.key; });
    var people = D.people.filter(function (p) {
      return p.tiles.some(function (k) { return keys.indexOf(k) >= 0; });
    }).length;
    return '<form class="row cat-row' + (isNew ? ' new' : '') + '" data-key="' + esc(it.key) + '">'
      + '<input class="f-label" value="' + esc(it.label) + '" maxlength="60" placeholder="Name">'
      + iconSelect('f-icon', it.icon)
      + '<span class="used">' + (isNew ? '' : tiles + (tiles === 1 ? ' tile' : ' tiles')
          + ' \u00b7 ' + people + (people === 1 ? ' person' : ' people')) + '</span>'
      + '<div class="row-acts">'
        + '<button type="submit" class="btn small primary">' + (isNew ? 'Add' : 'Save') + '</button>'
        + (isNew ? '' : '<button type="button" class="btn small danger del">&times;</button>')
      + '</div>'
      + '<div class="errs"></div></form>';
  }

  function paintCats() {
    $('#pane-cats').innerHTML =
      '<p class="pane-note">The sections of the dash, in this order. A person '
      + 'in a section sees its tiles. General / Staff / Culture is everybody.</p>'
      + '<div class="rows cats"><div class="row head">'
        + '<span>Name</span><span>Icon</span><span></span><span></span></div>'
      + D.categories.map(catRow).join('')
      + catRow(null) + '</div>';
  }

  function paintAll() { paintTiles(); paintPeople(); paintLinks(); paintCats(); }

  // ── wiring ──────────────────────────────────────────────────────────────

  function showErrors(form, errs) {
    $('.errs', form).innerHTML = errs.map(function (e) {
      return '<div class="err">' + esc(e) + '</div>';
    }).join('');
  }

  function reload() {
    return api('all').then(function (d) { D = d; paintAll(); });
  }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    e.preventDefault();
    showErrors(f, []);

    var send, body;
    if (f.classList.contains('tile-row')) {
      send = 'tile';
      body = {
        key: f.dataset.key, name: $('.f-name', f).value, blurb: $('.f-blurb', f).value,
        url: $('.f-url', f).value, category: $('.f-cat', f).value, icon: $('.f-icon', f).value,
        everyone: $('.f-everyone', f).checked,
      };
    }
    else if (f.classList.contains('person')) {
      send = 'person';
      body = {
        email: $('.f-email', f).value, name: $('.f-pname', f).value,
        tiles: $$('.secbox .chip', f).map(function (c) { return c.dataset.key; }),
      };
    } else if (f.classList.contains('link-row')) {
      send = 'link';
      body = {
        key: f.dataset.key, name: $('.f-lname', f).value,
        url: $('.f-lurl', f).value,
        category: $$('.secbox .chip', f).map(function (c) { return c.dataset.key; }),
      };
    } else if (f.classList.contains('cat-row')) {
      send = 'category';
      body = { key: f.dataset.key, label: $('.f-label', f).value, icon: $('.f-icon', f).value };
    } else return;

    api(send, body).then(function (r) {
      if (r.errors) return showErrors(f, r.errors);
      say('Saved.');
      return reload();
    }).catch(function (err) { say(err.message, true); });
  });

  // Adding and removing a section edits the row in place. Nothing reaches
  // the server until Save, so a mis-click is undone by not saving.
  document.addEventListener('change', function (e) {
    if (!e.target.classList.contains('sec-add')) return;
    var key = e.target.value;
    if (!key) return;
    var box = e.target.closest('.secbox');
    var g = chipSrc(box.dataset.src).filter(function (x) { return x.key === key; })[0];
    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.key = key;
    chip.innerHTML = esc(g ? g.label : key)
      + '<button type="button" class="chip-x" aria-label="Remove">\u00d7</button>';
    box.insertBefore(chip, e.target);
    e.target.querySelector('option[value="' + key + '"]').remove();
    e.target.value = '';
  });

  document.addEventListener('click', function (e) {
    var x = e.target.closest('.chip-x');
    if (x) {
      e.preventDefault();
      var chip = x.closest('.chip');
      var box = chip.closest('.secbox');
      var sel = box.querySelector('.sec-add');
      var g = chipSrc(box.dataset.src).filter(function (y) { return y.key === chip.dataset.key; })[0];
      if (sel && g) {
        var opt = document.createElement('option');
        opt.value = g.key;
        opt.textContent = g.label;
        sel.appendChild(opt);
      }
      chip.remove();
      return;
    }
    var del = e.target.closest('.del');
    if (del) {
      var f = del.closest('form');
      var what = f.classList.contains('person') ? 'person'
        : f.classList.contains('link-row') ? 'link'
        : f.classList.contains('cat-row') ? 'group' : 'tile';
      var label = what === 'person' ? f.dataset.email : f.dataset.key;
      if (!confirm('Remove ' + label + '?')) return;
      var body = what === 'person' ? { email: f.dataset.email } : { key: f.dataset.key };
      api(what + '/delete', body).then(function () { say('Removed.'); return reload(); })
        .catch(function (err) { say(err.message, true); });
      return;
    }
    var tab = e.target.closest('.setup-tab');
    if (tab) {
      $$('.setup-tab').forEach(function (t) { t.classList.toggle('on', t === tab); });
      $$('.pane').forEach(function (p) { p.hidden = p.id !== 'pane-' + tab.dataset.pane; });
    }
  });

  reload().catch(function (err) {
    // Only a 404 means "not an admin" -- that is what the endpoints answer
    // everybody else. Anything else is this page being broken, and telling
    // somebody "not for you" about a rendering bug sends them off to ask for
    // permissions they already have.
    if (err.status === 404) {
      $('#notice').innerHTML = '<div class="notice"><strong>This page is not for you.</strong> '
        + 'Setup is limited to the people named in the dash’s configuration. '
        + '<a href="/">Back to the dash</a>.</div>';
      $$('.pane').forEach(function (p) { p.innerHTML = ''; });
      $('#tabs').hidden = true;
      return;
    }
    say('Setup could not load: ' + err.message, true);
  });
})();
