(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var D = { tiles: [], categories: [], groups: [], people: [], admins: [], you: '' };

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
        if (!r.ok && !j.errors) throw new Error(j.error || ('The server answered ' + r.status));
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

  // ── tiles ───────────────────────────────────────────────────────────────

  function groupBoxes(selected, withEveryone) {
    var sel = selected || [];
    var all = (withEveryone ? [{ key: 'everyone', label: 'Everyone (all staff)' }] : [])
      .concat(D.groups);
    return all.map(function (g) {
      return '<label class="cb"><input type="checkbox" class="g" value="' + esc(g.key) + '"'
        + (sel.indexOf(g.key) >= 0 ? ' checked' : '') + '> ' + esc(g.label) + '</label>';
    }).join('');
  }

  function tileForm(t) {
    var it = t || { key: '', name: '', blurb: '', url: '', icon: 'link',
                    category: (D.categories[0] || {}).key, groups: [], status: 'soon' };
    var isNew = !t;
    return '<form class="card tile-form" data-key="' + esc(it.key) + '">'
      + '<div class="row2">'
        + '<label>Name<input class="f-name" value="' + esc(it.name) + '" maxlength="80" '
          + 'placeholder="Wholesale Hub"></label>'
        + '<label>Key<input class="f-key" value="' + esc(it.key) + '" maxlength="38" '
          + 'placeholder="wholesale"' + (isNew ? '' : ' readonly') + '>'
          + '<span class="hint">' + (isNew ? 'Lower case, no spaces. Cannot be changed later.'
              : 'Fixed once set, so renaming is safe.') + '</span></label>'
      + '</div>'
      + '<label>What it is<textarea class="f-blurb" maxlength="300" '
        + 'placeholder="One line. This is what people read before clicking.">' + esc(it.blurb) + '</textarea></label>'
      + '<label>Address<input class="f-url" value="' + esc(it.url) + '" placeholder="https://"></label>'
      + '<div class="row2">'
        + '<label>Category<select class="f-cat">'
          + D.categories.map(function (c) {
              return '<option value="' + esc(c.key) + '"'
                + (c.key === it.category ? ' selected' : '') + '>' + esc(c.label) + '</option>';
            }).join('')
        + '</select></label>'
        + '<label>Icon<select class="f-icon">'
          + ['calendar', 'chart', 'box', 'people', 'link'].map(function (i) {
              return '<option value="' + i + '"' + (i === it.icon ? ' selected' : '') + '>' + i + '</option>';
            }).join('')
        + '</select></label>'
      + '</div>'
      + '<fieldset><legend>Who sees it</legend><div class="cbs">'
        + groupBoxes(it.groups, true) + '</div></fieldset>'
      + '<label class="cb big"><input type="checkbox" class="f-live"'
        + (it.status === 'live' ? ' checked' : '') + '> '
        + 'Show it on the dash<span class="hint">Needs an address. Leave off while it is '
        + 'still being built — an unfinished tile appears on nobody’s page.</span></label>'
      + '<div class="errs"></div>'
      + '<div class="acts">'
        + '<button type="submit" class="btn primary">' + (isNew ? 'Add tile' : 'Save') + '</button>'
        + (isNew ? '' : '<button type="button" class="btn danger del">Remove</button>')
      + '</div>'
      + '</form>';
  }

  function readTileForm(f) {
    return {
      key: $('.f-key', f).value,
      name: $('.f-name', f).value,
      blurb: $('.f-blurb', f).value,
      url: $('.f-url', f).value,
      category: $('.f-cat', f).value,
      icon: $('.f-icon', f).value,
      groups: $$('.g:checked', f).map(function (b) { return b.value; }),
      status: $('.f-live', f).checked ? 'live' : 'soon',
    };
  }

  function paintTiles() {
    var live = D.tiles.filter(function (t) { return t.status === 'live'; }).length;
    $('#pane-tiles').innerHTML =
      '<p class="pane-note">' + D.tiles.length + ' tiles, ' + live + ' of them on the dash.</p>'
      + D.tiles.map(tileForm).join('')
      + '<h3 class="add-h">Add a tile</h3>' + tileForm(null);
  }

  // ── people ──────────────────────────────────────────────────────────────

  function personRow(p) {
    var isNew = !p;
    var it = p || { email: '', name: '', groups: [] };
    return '<form class="card person" data-email="' + esc(it.email) + '">'
      + '<div class="row2">'
        + '<label>Email<input class="f-email" value="' + esc(it.email) + '" '
          + (isNew ? 'placeholder="name@jettylife.com"' : 'readonly') + '></label>'
        + '<label>Name <span class="opt">optional</span>'
          + '<input class="f-pname" value="' + esc(it.name) + '" maxlength="80"></label>'
      + '</div>'
      + '<fieldset><legend>In</legend><div class="cbs">' + groupBoxes(it.groups, false) + '</div></fieldset>'
      + '<div class="errs"></div>'
      + '<div class="acts">'
        + '<button type="submit" class="btn primary">' + (isNew ? 'Add' : 'Save') + '</button>'
        + (isNew ? '' : '<button type="button" class="btn danger del">Remove</button>')
      + '</div></form>';
  }

  function paintPeople() {
    var none = D.people.filter(function (p) { return !p.groups.length; }).length;
    $('#pane-people').innerHTML =
      '<p class="pane-note">' + D.people.length + ' people'
      + (none ? ', ' + none + ' of them in no groups yet — they still sign in and still '
          + 'see whatever is open to everyone.' : '.') + '</p>'
      + D.people.map(personRow).join('')
      + '<h3 class="add-h">Add somebody</h3>' + personRow(null);
  }

  // ── groups and categories ───────────────────────────────────────────────

  function simpleRow(kind, it) {
    var isNew = !it;
    var x = it || { key: '', label: '', note: '' };
    var used = kind === 'group'
      ? D.people.filter(function (p) { return p.groups.indexOf(x.key) >= 0; }).length
      : D.tiles.filter(function (t) { return t.category === x.key; }).length;
    return '<form class="card simple" data-kind="' + kind + '" data-key="' + esc(x.key) + '">'
      + '<div class="row2">'
        + '<label>Name<input class="f-label" value="' + esc(x.label) + '" maxlength="60"></label>'
        + '<label>Key<input class="f-skey" value="' + esc(x.key) + '" maxlength="38"'
          + (isNew ? '' : ' readonly') + '></label>'
      + '</div>'
      + (kind === 'group'
          ? '<label>Note <span class="opt">optional</span><input class="f-note" value="'
            + esc(x.note || '') + '" maxlength="200" placeholder="What this unlocks"></label>'
          : '')
      + '<div class="errs"></div>'
      + '<div class="acts">'
        + '<button type="submit" class="btn primary">' + (isNew ? 'Add' : 'Save') + '</button>'
        + (isNew || kind !== 'group' ? ''
            : '<button type="button" class="btn danger del">Remove</button>')
        + (isNew ? '' : '<span class="used">' + used
            + (kind === 'group' ? (used === 1 ? ' person' : ' people')
                                : (used === 1 ? ' tile' : ' tiles')) + '</span>')
      + '</div></form>';
  }

  function paintGroups() {
    $('#pane-groups').innerHTML =
      '<p class="pane-note">A group is named for the door it opens, not the job somebody '
      + 'holds. Removing one takes it off every tile and person that had it.</p>'
      + D.groups.map(function (g) { return simpleRow('group', g); }).join('')
      + '<h3 class="add-h">Add a group</h3>' + simpleRow('group', null);
  }

  function paintCats() {
    $('#pane-cats').innerHTML =
      '<p class="pane-note">Headings on the dash, in this order. A category is not a '
      + 'permission — two tools in the same one can be open to completely different people.</p>'
      + D.categories.map(function (c) { return simpleRow('category', c); }).join('')
      + '<h3 class="add-h">Add a category</h3>' + simpleRow('category', null);
  }

  function paintAll() { paintTiles(); paintPeople(); paintGroups(); paintCats(); }

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
    if (f.classList.contains('tile-form')) { send = 'tile'; body = readTileForm(f); }
    else if (f.classList.contains('person')) {
      send = 'person';
      body = {
        email: $('.f-email', f).value, name: $('.f-pname', f).value,
        groups: $$('.g:checked', f).map(function (b) { return b.value; }),
      };
    } else if (f.classList.contains('simple')) {
      send = f.dataset.kind === 'group' ? 'group' : 'category';
      body = {
        key: $('.f-skey', f).value, label: $('.f-label', f).value,
        note: $('.f-note', f) ? $('.f-note', f).value : '',
      };
    } else return;

    api(send, body).then(function (r) {
      if (r.errors) return showErrors(f, r.errors);
      say('Saved.');
      return reload();
    }).catch(function (err) { say(err.message, true); });
  });

  document.addEventListener('click', function (e) {
    var del = e.target.closest('.del');
    if (del) {
      var f = del.closest('form');
      var what = f.classList.contains('person') ? 'person'
        : f.classList.contains('simple') ? 'group' : 'tile';
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
    // The admin endpoints answer 404 to anybody who is not an admin, so this
    // is what somebody who guessed the address sees.
    $('#notice').innerHTML = '<div class="notice"><strong>This page is not for you.</strong> '
      + 'Setup is limited to the people named in the dash’s configuration. '
      + '<a href="/">Back to the dash</a>.</div>';
    $$('.pane').forEach(function (p) { p.innerHTML = ''; });
    $('#tabs').hidden = true;
  });
})();
