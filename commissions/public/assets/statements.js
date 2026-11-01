// The monthly run, which is the Ledger's Reps tab.
//
// A row per rep per month: what they earned, the file, whether it has gone
// out. Three columns in the Airtable tab did the work -- Amount, Sales
// Report, Date Sent -- and the two things it could not say are the two this
// screen is for: whether the figures have moved since the file was built,
// and whether the rep has actually been paid.

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    if (Math.abs(v) < 0.005) v = 0;
    return (v < 0 ? '-$' : '$')
      + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2,
                                              maximumFractionDigits: 2 });
  }

  function day(iso) {
    var s = String(iso || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  var D = null;
  var month = '';
  var busy = {};

  var SIGNED_OUT = 'Your sign-in has expired. Reload the page.';

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
    }, opts || {})).then(function (res) {
      if (res.type === 'opaqueredirect' || res.redirected || res.status === 0) {
        throw new Error(SIGNED_OUT);
      }
      if ((res.headers.get('content-type') || '').indexOf('application/json') < 0) {
        throw new Error(res.ok ? SIGNED_OUT
          : 'The page answered with an error (' + res.status + ').');
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
    $('#notice').innerHTML = msg ? '<div class="notice">' + esc(msg) + '</div>' : '';
  }

  function parts() {
    var m = /^(\d{4})-(\d{2})$/.exec(month);
    return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  function stateOf(r) {
    if (!r.built_at) return { key: 'none', label: 'Not built' };
    if (r.stale) return { key: 'stale', label: 'Figures changed' };
    if (r.resent) return { key: 'stale', label: 'Rebuilt since sending' };
    if (r.sent_at) return { key: 'sent', label: 'Sent ' + day(r.sent_at) };
    return { key: 'built', label: 'Built, not sent' };
  }

  function rowHtml(r) {
    var st = stateOf(r);
    var working = busy[r.rep_key];

    var fileCell = r.id && r.report_name
      ? '<a class="cm-file" href="/api/statements/' + esc(r.id) + '/file" download'
        + ' title="' + esc(r.report_name) + '">Download</a>'
      : '<span class="cm-zero">&mdash;</span>';

    // What the file said, when that is not what the books say now. Shown
    // beside the live figure rather than instead of it, because the
    // question is always "by how much".
    var amount = usd(r.due);
    if (r.stale) {
      amount += '<span class="cm-was"> was ' + esc(usd(r.amount)) + '</span>';
    }

    var paidNote = r.lines && r.paid_lines === r.lines
      ? '<span class="cm-paid">Rep paid</span>'
      : (r.paid_lines
        ? '<span class="cm-part">' + r.paid_lines + ' of ' + r.lines + ' paid</span>'
        : '');

    return '<tr data-rep="' + esc(r.rep_key) + '">'
      + '<td><span class="cm-who">' + esc(r.name) + '</span>' + paidNote + '</td>'
      + '<td class="cm-email">' + esc(r.email || '') + '</td>'
      + '<td class="cm-n">' + esc(String(r.lines)) + '</td>'
      + '<td class="cm-due">' + amount + '</td>'
      + '<td class="cm-n cm-ink">' + (r.ink_due ? esc(usd(r.ink_due)) : '') + '</td>'
      + '<td>' + fileCell + '</td>'
      + '<td><span class="cm-flag is-' + st.key + '">' + esc(st.label) + '</span></td>'
      + '<td class="cm-acts">'
      + '<button class="cm-f-x" type="button" data-build="' + esc(r.rep_key) + '"'
      + (working ? ' disabled' : '') + '>'
      + (r.built_at ? 'Rebuild' : 'Build') + '</button>'
      + (r.id && r.report_name
        ? '<button class="cm-f-x" type="button" data-sent="' + esc(r.id) + '"'
          + ' data-on="' + (r.sent_at ? '0' : '1') + '">'
          + (r.sent_at ? 'Not sent' : 'Mark sent') + '</button>'
        : '')
      + '</td>'
      + '<td><input class="cm-note" type="text" value="' + esc(r.notes || '') + '"'
      + (r.id ? ' data-note="' + esc(r.id) + '"' : ' disabled')
      + ' placeholder="Notes" aria-label="Notes for ' + esc(r.name) + '"></td>'
      + '</tr>';
  }

  function render() {
    var rows = (D && D.rows) || [];
    var head = '<tr><th>Sales Rep</th><th>Email</th><th>Lines</th><th>Amount</th>'
      + '<th>Ink</th><th>Report</th><th>State</th><th></th><th>Notes</th></tr>';

    var body = rows.length
      ? rows.map(rowHtml).join('')
      : '<tr><td colspan="9" class="cm-none">Nothing allocated in '
        + esc((D && D.period) || 'that month') + ' yet.</td></tr>';

    $('#t').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    $('#wrap').hidden = false;

    var sent = rows.filter(function (r) { return r.sent_at; }).length;
    var builtRows = rows.filter(function (r) { return r.built_at; });
    var stale = rows.filter(function (r) { return r.stale || r.resent; }).length;

    $('#strip').innerHTML = [
      ['Reps', String(rows.length)],
      ['Commission', usd(D.total)],
      ['Built', builtRows.length + ' of ' + rows.length],
      ['Sent', sent + ' of ' + rows.length],
    ].concat(stale ? [['Need rebuilding', String(stale)]] : [])
      .map(function (p) {
        return '<div><div class="cm-k">' + esc(p[0]) + '</div>'
          + '<div class="cm-v">' + esc(p[1]) + '</div></div>';
      }).join('');
    $('#strip').hidden = false;

    $('#count').textContent = D.period || '';
    $('#sub').textContent = (D.period || '') + ' · ' + rows.length + ' rep'
      + (rows.length === 1 ? '' : 's');
    $('#who').textContent = D.you || '';

    if (D.storage === false) {
      say('The statements bucket is not bound to this Worker, so a statement '
        + 'can be worked out here but not kept. Deploy with the R2 binding first.');
    }
  }

  // ── Doing ─────────────────────────────────────────────────────────────

  function load() {
    var p = parts();
    if (!p) return;
    return api('/api/statements?year=' + p.year + '&month=' + p.month)
      .then(function (body) { D = body; say(''); render(); })
      .catch(function (err) { say(err.message); });
  }

  function build(reps) {
    var p = parts();
    if (!p) return;
    (reps || []).forEach(function (k) { busy[k] = true; });
    render();
    api('/api/statements/build', {
      method: 'POST',
      body: JSON.stringify({ year: p.year, month: p.month, reps: reps || undefined }),
    }).then(function (body) {
      busy = {};
      var made = (body.built || []).length;
      var missed = (body.skipped || []).length;
      say(made
        ? ('Built ' + made + ' statement' + (made === 1 ? '' : 's') + ' for '
           + body.period + (missed ? ', skipped ' + missed : '') + '.')
        : 'Nothing to build for ' + body.period + '.');
      return load();
    }).catch(function (err) {
      busy = {};
      say(err.message);
      render();
    });
  }

  function markSent(id, on) {
    api('/api/statements/' + id + '/sent', {
      method: 'POST', body: JSON.stringify({ sent: on }),
    }).then(load).catch(function (err) { say(err.message); });
  }

  function saveNote(id, text) {
    api('/api/statements/' + id + '/note', {
      method: 'POST', body: JSON.stringify({ notes: text }),
    }).catch(function (err) { say(err.message); });
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  $('#t').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.dataset.build) { build([b.dataset.build]); return; }
    if (b.dataset.sent) { markSent(b.dataset.sent, b.dataset.on === '1'); }
  });

  // A note saves when the box is left rather than on every keystroke: it is
  // free text somebody is in the middle of typing, and a save per character
  // is a request per character.
  $('#t').addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.dataset && el.dataset.note) saveNote(el.dataset.note, el.value);
  });

  $('#buildAll').addEventListener('click', function () { build(null); });

  $('#fMonth').addEventListener('change', function () {
    month = $('#fMonth').value;
    try { localStorage.setItem('jetty-stmt-month', month); } catch (err) { /* private mode */ }
    load();
  });

  function start() {
    var saved = '';
    try { saved = localStorage.getItem('jetty-stmt-month') || ''; } catch (err) { saved = ''; }
    // Last month, not this one. A statement is built once the month has
    // finished, so opening on a month that is still running would show a
    // screen of half-months every time.
    var now = new Date();
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    var fallback = d.getUTCFullYear() + '-'
      + String(d.getUTCMonth() + 1).padStart(2, '0');
    month = /^\d{4}-\d{2}$/.test(saved) ? saved : fallback;
    $('#fMonth').value = month;
    $('#bar').hidden = false;
    load();
  }

  start();
}());
