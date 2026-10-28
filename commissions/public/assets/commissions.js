(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Money, the way a statement reads it. Not toLocaleString('en-US',
  // {style:'currency'}) because that renders -0 as "-$0.00" on a credit that
  // rounds to nothing, and a minus sign in front of zero reads as an error.
  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    if (Math.abs(v) < 0.005) v = 0;
    return (v < 0 ? '-$' : '$')
      + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2,
                                              maximumFractionDigits: 2 });
  }

  var D = null;
  var choices = { reps: [], territories: [], lines: [], methods: [] };
  var filters = { status: 'needs', rep: '', month: '', territory: '', q: '' };
  // Which payment is open, and what has been typed into it. Kept out here
  // because every keystroke re-renders the table underneath the form.
  var openId = '';
  var form = {};
  var xero = null;

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
    $('#notice').innerHTML = '<div class="notice">' + esc(msg) + '</div>';
  }

  // ── the arithmetic, the same three lines the Worker uses ───────────────
  //
  // Repeated here rather than asked for on every keystroke: the preview under
  // the form has to move as the rate is typed, and a round trip per character
  // would make it lag behind what is on screen. A test runs this and the
  // Worker's copy over the same rows and fails if they disagree.
  function num(v) {
    if (v === '' || v == null) return 0;
    var n = Number(String(v).replace(/[,$\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function cents(v) { return Math.round(Number(v) * 100) / 100; }
  function netInvoice(r) { return cents(num(r.gross) + num(r.credits) - num(r.freight)); }
  function base(r) { return r.cad ? cents(num(r.usd_net)) : netInvoice(r); }
  function amountDue(r) { return cents((base(r) * num(r.commission_pct)) / 100); }

  // ── drawing ────────────────────────────────────────────────────────────

  function repName(key) {
    for (var i = 0; i < choices.reps.length; i++) {
      if (choices.reps[i].key === key) return choices.reps[i].name;
    }
    return key || '';
  }

  function dataList(id, values) {
    return '<datalist id="' + id + '">'
      + (values || []).map(function (v) {
          return '<option value="' + esc(v) + '"></option>';
        }).join('') + '</datalist>';
  }

  function formHtml(row, span) {
    var f = form[row.id] || {};
    var val = function (k) { return f[k] == null ? (row[k] == null ? '' : row[k]) : f[k]; };
    var tick = function (k) { return f[k] == null ? Boolean(row[k]) : Boolean(f[k]); };
    var live = {
      gross: row.gross, credits: val('credits'), freight: val('freight'),
      cad: tick('cad'), usd_net: val('usd_net'), commission_pct: val('commission_pct'),
    };

    var reps = '<option value="">Pick a rep…</option>'
      + choices.reps.map(function (r) {
          return '<option value="' + esc(r.key) + '"'
            + (val('rep_key') === r.key ? ' selected' : '') + '>' + esc(r.name) + '</option>';
        }).join('');

    var text = function (k, label, list, cls) {
      return '<label class="cm-f-l">' + esc(label)
        + '<input class="cm-f-i ' + (cls || '') + '" type="text" name="' + k + '"'
        + (list ? ' list="' + list + '"' : '')
        + ' value="' + esc(val(k)) + '"></label>';
    };
    var money = function (k, label) {
      return '<label class="cm-f-l">' + esc(label)
        + '<input class="cm-f-i cm-f-num" type="text" inputmode="decimal" name="' + k + '"'
        + ' value="' + esc(val(k)) + '"></label>';
    };
    var box = function (k, label) {
      return '<label class="cm-f-tick"><input type="checkbox" name="' + k + '"'
        + (tick(k) ? ' checked' : '') + '>' + esc(label) + '</label>';
    };

    return '<tr class="cm-frow"><td colspan="' + span + '">'
      + '<form class="cm-f" data-for="' + esc(row.id) + '">'
      + '<label class="cm-f-l">Sales rep'
      + '<select class="cm-f-i cm-f-wide" name="rep_key">' + reps + '</select></label>'
      + '<label class="cm-f-l">Rate %'
      + '<input class="cm-f-i cm-f-num" type="text" inputmode="decimal" name="commission_pct"'
      + ' value="' + esc(val('commission_pct')) + '"></label>'
      + text('retailer', 'Retailer', 'cmRetailers', 'cm-f-wide')
      + text('territory', 'Territory', 'cmTerritories')
      + text('jetty_line', 'Line', 'cmLines')
      + text('payment_method', 'Paid by', 'cmMethods')
      + money('credits', 'Credits')
      + money('freight', 'Freight')
      + (tick('cad') ? money('usd_net', 'USD net') : '')
      + '<span class="cm-f-ticks">' + box('cad', 'CAD') + box('cc_fee', '3% card')
      + box('partial', 'Part pmt') + '</span>'
      + '<span class="cm-f-go">'
      + '<button class="cm-f-save" type="submit">Allocate</button>'
      + '<button class="cm-f-x" type="button" data-cancel="1">Cancel</button></span>'
      + '<span class="cm-f-preview">Net <b>' + usd(netInvoice(live)) + '</b>'
      + ' · commission <b>' + usd(amountDue(live)) + '</b>'
      + (tick('cad') ? ' · on the USD net' : '') + '</span>'
      + (f.error ? '<span class="cm-f-err">' + esc(f.error) + '</span>' : '')
      + '</form></td></tr>';
  }

  function render() {
    var rows = D.rows || [];
    var head = '<tr><th>Paid</th><th>Invoice</th><th>Retailer</th>'
      + '<th>Rep</th><th>Territory</th><th>Line</th>'
      + '<th>Gross</th><th>Net</th><th>Rate</th><th>Commission</th><th></th></tr>';

    var body = rows.length
      ? rows.map(function (r) {
          var due = amountDue(r);
          return '<tr>'
            + '<td class="cm-when">' + esc(String(r.paid_on || '').slice(0, 10)) + '</td>'
            + '<td class="cm-inv">' + esc(r.invoice_no || '—') + '</td>'
            + '<td><button class="cm-open" type="button" data-open="' + esc(r.id) + '"'
            + ' aria-expanded="' + (openId === r.id) + '">'
            + '<span class="cm-who">' + esc(r.retailer || 'Not named yet') + '</span>'
            + (r.customer ? '<span class="cm-sub">' + esc(r.customer) + '</span>' : '')
            + '</button></td>'
            + '<td class="cm-n' + (r.rep_key ? '' : ' cm-zero') + '">'
            + esc(r.rep_key ? repName(r.rep_key) : '\u2014')
            + (r.paid ? '<span class="cm-flag">Paid</span>' : '')
            + '</td>'
            + '<td class="cm-n">' + esc(r.territory || '') + '</td>'
            + '<td class="cm-n">' + esc(r.jetty_line || '')
            + (r.cad ? '<span class="cm-flag">CAD</span>' : '')
            + (r.cc_fee ? '<span class="cm-flag">3%</span>' : '')
            + (r.partial ? '<span class="cm-flag">Part</span>' : '')
            + '</td>'
            + '<td class="cm-n">' + usd(r.gross) + '</td>'
            + '<td class="cm-n">' + usd(netInvoice(r)) + '</td>'
            + '<td class="cm-n' + (r.commission_pct ? '' : ' cm-zero') + '">'
            + (r.commission_pct ? esc(r.commission_pct) + '%' : '—') + '</td>'
            + '<td class="cm-due' + (due ? '' : ' cm-zero') + '">' + (due ? usd(due) : '—') + '</td>'
            + '<td><button class="cm-f-x" type="button" data-open="' + esc(r.id) + '">'
            + (openId === r.id ? 'Close' : (r.rep_key ? 'Edit' : 'Allocate'))
            + '</button></td></tr>'
            + (openId === r.id ? formHtml(r, 11) : '');
        }).join('')
      : '<tr><td colspan="11" class="cm-none">' + esc(nothingHere()) + '</td></tr>';

    $('#t').innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>'
      + dataList('cmRetailers', choices.retailers)
      + dataList('cmTerritories', choices.territories)
      + dataList('cmLines', choices.lines)
      + dataList('cmMethods', choices.methods);
    $('#wrap').hidden = false;
    chrome();
  }

  // Where the money comes from. A line rather than a page: the connection
  // is somebody's concern twice a year and the queue is their concern every
  // day.
  function xeroHtml() {
    if (!xero) return '';
    if (!xero.configured) {
      return '<span class="cm-x-off">Xero is not set up yet.</span>'
        + '<span>XERO_CLIENT_ID and the XERO_CLIENT_SECRET secret are both needed.</span>';
    }
    if (!xero.connected) {
      return '<span class="cm-x-off">Not connected to Xero.</span>'
        + '<span class="cm-grow"></span>'
        + '<button class="cm-x-btn" type="button" id="xConnect">Connect Xero</button>';
    }
    var r = xero.lastResult || {};
    var last = xero.lastRunAt
      ? ('last pull ' + String(xero.lastRunAt).slice(0, 16).replace('T', ' ')
         + (r.error ? ' \u2014 failed: ' + r.error
                    : ' \u00b7 ' + (r.made || 0) + ' new'))
      : 'never pulled';
    return '<span>Xero: <b>' + esc(xero.tenant || '') + '</b></span>'
      + '<span' + (r.error ? ' class="cm-x-off"' : '') + '>' + esc(last) + '</span>'
      + (xero.accounts && xero.accounts.length
          ? '<span>accounts ' + esc(xero.accounts.join(', ')) + '</span>'
          : '<span class="cm-x-off">no wholesale accounts set</span>')
      + '<span class="cm-grow"></span>'
      + '<button class="cm-x-btn" type="button" id="xPull">Pull now</button>';
  }

  // Said in the words of the filter that found nothing, because "no results"
  // on a screen with five boxes on it does not say which box to change.
  function nothingHere() {
    if (filters.q) return 'Nothing matches \u201c' + filters.q + '\u201d in this view.';
    if (filters.status === 'needs') {
      return (filters.rep || filters.month || filters.territory)
        ? 'Nothing is waiting that matches those filters.'
        : 'Nothing waiting. Every payment that has come in has a rep on it.';
    }
    if (filters.status === 'unpaid') return 'Nothing allocated here is still unpaid.';
    if (filters.status === 'paid') return 'Nothing has been paid in this view yet.';
    return 'No payments match those filters.';
  }

  function dirty() {
    return filters.status !== 'needs' || Boolean(filters.rep) || Boolean(filters.month)
      || Boolean(filters.territory) || Boolean(filters.q);
  }

  function chrome() {
    var t = D.totals || {};
    var label = (choices.statuses || []).filter(function (x) {
      return x.key === D.status;
    })[0];
    $('#strip').innerHTML = [
      ['Waiting to allocate', D.waiting],
      [(label ? label.label : 'Matching'), (D.matched || 0).toLocaleString('en-US')],
      ['Net invoiced', usd(t.gross)],
      ['Commission', usd(t.due)],
      ['Allocated, unpaid', usd(t.unpaid)],
    ].map(function (p) {
      return '<div><div class="cm-k">' + esc(p[0]) + '</div>'
        + '<div class="cm-v">' + esc(p[1]) + '</div></div>';
    }).join('');
    $('#strip').hidden = false;
    var box = $('#xero');
    if (box) { box.innerHTML = xeroHtml(); box.hidden = !xero; }
    // A page of two hundred out of nine thousand has to say so, or the
    // totals above it look like they belong to what is on screen.
    $('#count').textContent = D.matched > D.shown
      ? (D.shown + ' of ' + D.matched.toLocaleString('en-US')
         + ' \u2014 the totals cover all ' + D.matched.toLocaleString('en-US'))
      : (D.shown + (D.shown === 1 ? ' payment' : ' payments'));
    $('#sub').textContent = D.waiting + ' to allocate';
    $('#fClear').hidden = !dirty();
  }

  // ── allocating ─────────────────────────────────────────────────────────

  function save(id) {
    var f = form[id] || {};
    var row = null;
    (D.rows || []).forEach(function (r) { if (r.id === id) row = r; });
    if (!row) return;
    var body = {};
    ['rep_key', 'commission_pct', 'retailer', 'territory', 'jetty_line', 'payment_method',
     'credits', 'freight', 'usd_net'].forEach(function (k) {
      body[k] = f[k] == null ? (row[k] == null ? '' : row[k]) : f[k];
    });
    ['cad', 'cc_fee', 'partial'].forEach(function (k) {
      body[k] = (f[k] == null ? Boolean(row[k]) : Boolean(f[k])) ? 1 : 0;
    });

    api('/api/payments/' + id, { method: 'PATCH', body: JSON.stringify(body) })
      .then(function () {
        openId = '';
        delete form[id];
        $('#notice').innerHTML = '';
        // Re-read rather than splice the row out: allocating changes the
        // totals and the count, and a strip that disagrees with the table is
        // worse than a round trip.
        return load();
      })
      .catch(function (err) {
        form[id] = Object.assign({}, f, { error: err.message || 'That did not save.' });
        render();
      });
  }

  function fillBar() {
    var opt = function (v, label, sel) {
      return '<option value="' + esc(v) + '"' + (sel === v ? ' selected' : '') + '>'
        + esc(label) + '</option>';
    };
    $('#fStatus').innerHTML = (choices.statuses || []).map(function (x) {
      return opt(x.key, x.label, filters.status);
    }).join('');
    $('#fRep').innerHTML = opt('', 'Every rep', filters.rep)
      + (choices.reps || []).map(function (r) { return opt(r.key, r.name, filters.rep); }).join('');
    $('#fTerritory').innerHTML = opt('', 'Everywhere', filters.territory)
      + (choices.territories || []).map(function (v) {
          return opt(v, v, filters.territory);
        }).join('');
    $('#fMonth').value = filters.month;
    $('#q').value = filters.q;
  }

  function bind() {
    var onFilter = function (key, el, typed) {
      el.addEventListener(typed ? 'input' : 'change', function (e) {
        filters[key] = e.target.value;
        openId = '';
        clearTimeout(bind.t);
        bind.t = setTimeout(load, typed ? 220 : 0);
      });
    };
    onFilter('status', $('#fStatus'));
    onFilter('rep', $('#fRep'));
    onFilter('month', $('#fMonth'));
    onFilter('territory', $('#fTerritory'));
    onFilter('q', $('#q'), true);
    $('#fClear').addEventListener('click', function () {
      filters = { status: 'needs', rep: '', month: '', territory: '', q: '' };
      openId = '';
      fillBar();
      load();
    });
    $('#t').addEventListener('click', function (e) {
      if (e.target.closest('[data-cancel]')) { openId = ''; render(); return; }
      var o = e.target.closest('[data-open]');
      if (!o) return;
      var id = o.dataset.open;
      openId = openId === id ? '' : id;
      render();
      var el = document.querySelector('.cm-f [name="rep_key"]');
      if (el) el.focus();
    });
    // Every keystroke re-renders the table under the form, so what has been
    // typed is kept here rather than read back off the inputs later.
    var take = function (e) {
      var f = e.target.closest('.cm-f');
      if (!f || !e.target.name) return;
      var id = f.dataset.for;
      form[id] = form[id] || {};
      form[id][e.target.name] = e.target.type === 'checkbox'
        ? e.target.checked : e.target.value;
      // The preview and the USD field both follow what has been typed.
      if (e.target.name === 'cad' || e.target.type !== 'checkbox') render();
    };
    $('#t').addEventListener('input', take);
    $('#t').addEventListener('change', take);
    $('#t').addEventListener('submit', function (e) {
      var f = e.target.closest('.cm-f');
      if (!f) return;
      e.preventDefault();
      save(f.dataset.for);
    });
    // Delegated, because the strip is redrawn on every render.
    document.addEventListener('click', function (e) {
      if (e.target.id === 'xConnect') {
        api('/api/xero/connect')
          .then(function (r) { window.location.href = r.go; })
          .catch(function (err) { say(err.message || 'Could not start that.'); });
        return;
      }
      if (e.target.id === 'xPull') {
        e.target.disabled = true;
        e.target.textContent = 'Pulling\u2026';
        api('/api/xero/pull', { method: 'POST', body: '{}' })
          .then(function () { return refreshXero(); })
          .then(load)
          .catch(function (err) {
            say(err.message || 'The pull did not run.');
            return refreshXero().then(render);
          });
      }
    });
  }

  function refreshXero() {
    return api('/api/xero/status')
      .then(function (r) { xero = r; })
      // A connection nobody can read about is not worth failing the queue
      // over: the rows are still there and still allocatable.
      .catch(function () { xero = null; });
  }

  function load() {
    var p = new URLSearchParams({ limit: '200' });
    Object.keys(filters).forEach(function (k) {
      if (filters[k]) p.set(k, String(filters[k]).trim());
    });
    return api('/api/payments?' + p.toString()).then(function (data) {
      D = data;
      render();
    });
  }

  Promise.all([api('/api/choices'), api('/api/payments?limit=200'), refreshXero()])
    .then(function (both) {
      choices = both[0];
      D = both[1];
      $('#who').textContent = D.you || '';
      $('#bar').hidden = false;
      fillBar();
      bind();
      render();
    })
    .catch(function (err) {
      $('#sub').textContent = 'Not open to you';
      say(/not on the commissions list|403/.test(err.message)
        ? 'Commissions is not open to this address. It is kept to whoever runs '
          + 'the rep payments.'
        : (err.message || 'The queue did not load.'));
    });
}());
