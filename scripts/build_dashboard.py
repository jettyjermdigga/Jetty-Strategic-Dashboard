import os, json, datetime
import pandas as pd
import pyxlsb
import openpyxl
import requests

FP = "data/budget.xlsb"
CATEGORIES_SHEET = "Categories"
FP_JRF = "data/jrf_budget.xlsx"

# ── A/P - CNS (live, from Airtable) ───────────────────────────────────────────
# Overseas COGS purchase-order payables tracked in the "Ledger 💰" Airtable
# base -- real vendor debt that hasn't hit the Cash Flow - Tracker's cash-out
# actuals yet (it only shows up there once actually paid), so it's the piece
# missing from a pure spreadsheet-based cash projection.
AIRTABLE_API = "https://api.airtable.com/v0"
AIRTABLE_LEDGER_BASE = "appW8jAfERj3iBzqt"  # Ledger 💰
AP_CNS_TABLE = "tblC9gQD9rrRbVtno"

def fetch_ap_cns():
    """Unpaid A/P - CNS balances with a due date, bucketed into overdue vs.
    due by year-end. Returns None (rather than raising) if AIRTABLE_API_KEY
    isn't configured or the request fails, so a local/offline build just
    omits the Paydown Feasibility section instead of breaking."""
    token = os.environ.get('AIRTABLE_API_KEY')
    if not token:
        return None
    url = f"{AIRTABLE_API}/{AIRTABLE_LEDGER_BASE}/{AP_CNS_TABLE}"
    headers = {"Authorization": f"Bearer {token}"}
    params = {
        "filterByFormula": "AND(NOT({Paid in Full}), {⚠ Due Date} != '')",
        "fields[]": ["⚠ Due Date", "Remaining Due"],
        "pageSize": 100,
    }
    records = []
    try:
        offset = None
        while True:
            p = dict(params)
            if offset:
                p["offset"] = offset
            r = requests.get(url, headers=headers, params=p, timeout=30)
            r.raise_for_status()
            data = r.json()
            records.extend(data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break
    except requests.RequestException as e:
        print("A/P - CNS fetch failed, skipping paydown feasibility:", e)
        return None

    today = datetime.date.today()
    year_end = datetime.date(today.year, 12, 31)
    overdue = upcoming = beyond_year = 0.0
    for rec in records:
        f = rec.get("fields", {})
        remaining = f.get("Remaining Due") or 0
        due_str = f.get("⚠ Due Date")
        if not due_str or not remaining:
            continue
        due = datetime.date.fromisoformat(due_str)
        if due < today:
            overdue += remaining
        elif due <= year_end:
            upcoming += remaining
        else:
            beyond_year += remaining
    return dict(overdue=overdue, upcoming=upcoming, beyond_year=beyond_year,
                total=overdue + upcoming, as_of=today.isoformat())

# ── Formatters ──────────────────────────────────────────────────────────────

def html_escape(s):
    return (s.replace('&', '&amp;').replace('"', '&quot;')
             .replace('<', '&lt;').replace('>', '&gt;'))

def fk(v):
    if v == 0: return "$0"
    a = abs(v); s = "minus" if v < 0 else ""
    if a >= 1_000_000: return ("" if v>0 else "−") + "$" + format(a/1_000_000, ".2f") + "M"
    if a >= 1_000:     return ("" if v>0 else "−") + "$" + format(a/1_000,     ".1f") + "K"
    return ("" if v>0 else "−") + "$" + f"{a:,.0f}"

def vk(v):
    if v == 0: return "—"
    sign = "+" if v > 0 else "−"; a = abs(v)
    if a >= 1_000_000: return sign + "$" + format(a/1_000_000, ".2f") + "M"
    if a >= 1_000:     return sign + "$" + format(a/1_000,     ".1f") + "K"
    return sign + "$" + f"{a:,.0f}"
TAB_JS = '''
document.querySelectorAll(".tab").forEach(function(t){
  t.addEventListener("click", function(){
    document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active");});
    document.querySelectorAll(".tab-panel").forEach(function(x){x.classList.remove("active");});
    t.classList.add("active");
    var panel = document.getElementById("panel-" + t.dataset.panel);
    if (panel) panel.classList.add("active");
    if (window.Chart && Chart.instances) {
      Object.values(Chart.instances).forEach(function(c){ c.resize(); });
    }
  });
});
'''

# A single reusable full-screen modal: any chart registered into
# window.__charts[chartId] (see build_summary_trend_charts_js) can be
# blown up full-screen with a PNG download, via the card's Expand button
# (see rc_trend_chart).
CHART_MODAL_HTML = '''
<div class="chart-modal-overlay" id="chart-modal">
  <div class="chart-modal-content">
    <div class="chart-modal-header">
      <div class="chart-modal-title" id="chart-modal-title"></div>
      <div class="chart-modal-actions">
        <button onclick="downloadChartModal()">⬇ Download PNG</button>
        <button class="chart-modal-close" onclick="closeChartModal()">✕</button>
      </div>
    </div>
    <div class="chart-modal-canvas-wrap"><canvas id="chart-modal-canvas"></canvas></div>
  </div>
</div>
'''

CHART_MODAL_JS = '''
window.__charts = window.__charts || {};
window.__modalChart = null;
function openChartModal(chartId, title){
  var src = window.__charts[chartId];
  var data = window.__chartData[chartId];
  var optsFn = window.__chartOptsFn[chartId];
  if(!src || !data) return;
  document.getElementById("chart-modal-title").textContent = title;
  document.getElementById("chart-modal").classList.add("open");
  if(window.__modalChart){ window.__modalChart.destroy(); window.__modalChart = null; }
  var ctx = document.getElementById("chart-modal-canvas");
  window.__modalChart = new Chart(ctx, {
    type: src.config.type,
    data: data,
    options: optsFn ? optsFn() : {responsive:true, maintainAspectRatio:false}
  });
  window.__modalTitle = title;
}
function closeChartModal(){
  document.getElementById("chart-modal").classList.remove("open");
  if(window.__modalChart){ window.__modalChart.destroy(); window.__modalChart = null; }
}
function downloadChartModal(){
  if(!window.__modalChart) return;
  // toBase64Image()'s canvas is transparent -- fine on a white page, but
  // most image viewers (and dark-mode ones especially) render transparency
  // as black, making the light gridlines/text unreadable. Composite a white
  // fill behind the existing pixels ("destination-over" draws under, not
  // over), grab the URL, then redraw the chart to undo it on-screen.
  var canvas = window.__modalChart.canvas;
  var ctx = canvas.getContext("2d");
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  var url = canvas.toDataURL("image/png", 1);
  ctx.restore();
  window.__modalChart.draw();
  var link = document.createElement("a");
  link.download = (window.__modalTitle || "chart").replace(/[^a-z0-9]+/gi,"_") + ".png";
  link.href = url;
  link.click();
}
document.getElementById("chart-modal").addEventListener("click", function(e){
  if(e.target.id === "chart-modal") closeChartModal();
});
document.addEventListener("click", function(e){
  var btn = e.target.closest(".rc-expand-btn");
  if(btn) openChartModal(btn.dataset.chartId, btn.dataset.chartTitle);
});
document.addEventListener("keydown", function(e){
  if(e.key === "Escape") closeChartModal();
});
'''

def js_arr(lst):
    return '[' + ','.join(str(v) for v in lst) + ']'

def to_xy(d, est=None):
    est = est or set()
    return '[' + ','.join('{x:"Wk ' + str(k) + '",y:' + str(v) + ',e:' + ('true' if k in est else 'false') + '}'
                           for k,v in sorted(d.items())) + ']'

def st_xy(d, est=None):
    est = est or set()
    return '[' + ','.join('{x:"Wk ' + str(k) + '",y:' + str(v) + ',e:' + ('true' if k in est else 'false') + '}'
                           for k,v in sorted(d.items()) if v) + ']'

def trend_xy(arr):
    """arr is a 52-length list (index 0 = week 1), None where there's no data
    for that week -- those weeks are omitted entirely so Chart.js draws a
    gap/skip rather than a fake drop to zero."""
    return '[' + ','.join('{x:"Wk ' + str(i+1) + '",y:' + repr(round(float(v), 2)) + '}'
                           for i, v in enumerate(arr) if v is not None) + ']'

# ── Seasonality / trend ───────────────────────────────────────────────────────
# The dashboard's default "Ann. Proj." (used everywhere for variance reporting)
# is deliberately naive: actual-to-date + whatever's still budgeted for the
# rest of the year, so Ann. Var always equals YTD Var. That's fine for
# tracking plan adherence but it's blind to how a channel is actually
# pacing — a channel already 10% ahead of plan gets projected as if it will
# suddenly land exactly on budget for every remaining week.
#
# Trend Proj. instead asks "given this channel's normal shape for the year,
# and how much of that shape's ground we've covered so far, where does our
# actual pace put us by December?" — ytd_actual / (expected % of the year
# already behind us). That naturally builds in trend (over/under-pace shows
# up directly) *and* seasonality (each channel's "expected % so far" is its
# own curve), which is why one channel's early-year pace means something
# very different from another's.
#
# CHANNEL_SEASONALITY below is derived from real 2025 actuals (the "2025
# Actual" tab), not guessed — each channel's monthly weight is its share of
# that channel's full 2025 revenue, bucketed into the same 4-4-5 retail
# calendar the sheet itself uses for weeks (verified against the Inventory
# tab's Start/End columns).
#
# One wrinkle: Long Branch opened mid-2025 and its revenue was booked
# lumped into Flagship Store all year in the books (no separate ledger
# line), so "DTC - Flagship Store" in 2025 Actual is really Flagship+Long
# Branch combined. Rather than estimate a split, we pulled each store's
# real daily Net Sales straight from Airtable — the Jetty Hub base's
# "DTC Daily" table tracks both stores separately by day, with a Sales
# Channel of "Flagship Store" or "Long Branch" — and used those actual
# per-store weekly totals for each store's own curve. (The two stores'
# 2025 total, summed, comes in within 1% of the lumped ledger figure —
# a good cross-check that the two sources agree.)
#
# Weeks are bucketed into a standard 4-4-5 retail calendar (13 weeks/quarter,
# 52 total), matching the sheet's own week numbering exactly.
MONTH_WEEKS = [4,4,5, 4,4,5, 4,4,5, 4,4,5]  # Jan..Dec

CHANNEL_SEASONALITY = {
    # Jan,   Feb,   Mar,   Apr,   May,   Jun,   Jul,   Aug,   Sep,   Oct,   Nov,   Dec
    'DTC - Jettylife.com':       [.038,.033,.057,.049,.071,.078,.061,.061,.121,.081,.097,.251],
    'Wholesale Revenue':         [.016,.031,.187,.090,.067,.077,.141,.128,.129,.072,.042,.019],
    'Screen Printing Revenue':   [.029,.041,.139,.083,.078,.117,.103,.099,.156,.062,.081,.013],
    'DTC - Flagship Store':      [.021,.036,.054,.066,.072,.107,.092,.129,.088,.045,.088,.202],
    'DTC - Long Branch':         [.000,.000,.000,.000,.069,.212,.203,.205,.121,.053,.057,.080],
    'DTC - Mobile Store & Tent': [.015,.012,.065,.026,.052,.081,.098,.151,.070,.337,.045,.047],
    'JRF - Screen Printing':     [.144,.141,.035,.000,.000,.100,.058,.049,.221,.142,.092,.018],

    # NOTE: we tried adding aggregate COGS_LS_TOTAL / OPEX_TOTAL curves here,
    # derived from the 2025 Actual tab's Total Cost of Goods Sold / Total
    # Operating Expenses rows the same way as the channels above. Reverted --
    # unlike revenue, COGS/Labor/OpEx timing isn't driven by a repeatable
    # calendar pattern, it's driven by when bills get entered into the books.
    # 2025's shape only looked back-loaded because Fall/Winter COGS was
    # entered late that year; 2026's budget already has ~72% of its annual
    # COGS+Labor+Shipping total booked by week 31 (large lump-sum weeks, e.g.
    # $1.26M in week 30) rather than spread seasonally. Extrapolating off
    # 2025's entry-timing artifact produced a full-year COGS+Labor+Shipping
    # projection ~$2.5M over the actual trajectory. Revenue's curves above are
    # fine -- consumer buying seasonality genuinely repeats year to year.
}

def _weekly_weights(monthly):
    out = []
    for wk_count, m_wt in zip(MONTH_WEEKS, monthly):
        out.extend([m_wt / wk_count] * wk_count)
    return out  # 52 weights, summing to ~1.0

def seasonal_ann_proj(key, ytd_act, ann_plan, wk):
    """Trend + seasonality-adjusted full-year projection for one channel.
    Falls back to the plan itself if there's no curve or no ground covered
    yet, rather than divide-by-zero-ing into nonsense in week 1."""
    monthly = CHANNEL_SEASONALITY.get(key)
    if not monthly:
        return ann_plan
    cum = sum(_weekly_weights(monthly)[:wk])
    return (ytd_act / cum) if cum > 0 else ann_plan

# ── Data extraction ──────────────────────────────────────────────────────────

def read_categories():
    """Optional 'Categories' tab: <line item> | Category | Highlight | [Callout Label].
    Columns are matched by position, not header text, and a title/blank row above
    the header is tolerated — the header row is whichever row has "categ" in its
    second cell. The line item must match the sheet name used in the Actual/Budget
    tabs exactly. Returns {} if the tab doesn't exist yet, so the OpEx section
    falls back to the flat opex_map-driven table."""
    try:
        raw = pd.read_excel(FP, sheet_name=CATEGORIES_SHEET, engine='pyxlsb', header=None)
    except Exception:
        return {}
    header_row = None
    for i, row in raw.iterrows():
        if pd.notna(row.get(1)) and 'categ' in str(row[1]).strip().lower():
            header_row = i
            break
    if header_row is None:
        return {}
    cats = {}
    for _, row in raw.iloc[header_row + 1:].iterrows():
        name = row.get(0)
        if pd.isna(name) or not str(name).strip():
            continue
        category = row.get(1)
        highlight = pd.notna(row.get(2)) and str(row.get(2)).strip() != ''
        callout = row.get(3) if len(row) > 3 else None
        cats[str(name).strip()] = {
            'category': str(category).strip() if pd.notna(category) and str(category).strip() else 'Uncategorized',
            'highlight': highlight,
            'callout': str(callout).strip() if highlight and pd.notna(callout) and str(callout).strip() else None,
        }
    return cats

def read_all():
    d = {}
    df_s  = pd.read_excel(FP, sheet_name='Summary',             engine='pyxlsb', header=None)
    df_a  = pd.read_excel(FP, sheet_name='2026 Actual',         engine='pyxlsb', header=None)
    df_b  = pd.read_excel(FP, sheet_name='2026 Budget',         engine='pyxlsb', header=None)
    df_25 = pd.read_excel(FP, sheet_name='2025 Actual',         engine='pyxlsb', header=None)
    df_cf = pd.read_excel(FP, sheet_name='Cash Flow - Tracker', engine='pyxlsb', header=None)
    df_inv= pd.read_excel(FP, sheet_name='Inventory',           engine='pyxlsb', header=None)
    df_oo = pd.read_excel(FP, sheet_name='On Order',            engine='pyxlsb', header=None)
    df_lb = pd.read_excel(FP, sheet_name='Labor',                engine='pyxlsb', header=None)
    df_pr = pd.read_excel(FP, sheet_name='Payroll',              engine='pyxlsb', header=None)

    def sc(row, col):
        r = row - 1
        c = {'B':1,'C':2,'D':3,'G':6,'H':7,'I':8}[col]
        v = df_s.iloc[r, c]
        return float(v) if pd.notna(v) else 0.0

    WK = int(df_s.iloc[2, 1])
    d['week']       = WK
    d['net_inc_var']= sc(21, 'D')
    d['ytd_status'] = 'ahead' if d['net_inc_var'] >= 0 else 'behind'
    for key, row in [('rev',11),('cogs',13),('opex',15),('net_income',21),
                      ('cash_in',68),('cash_out',75),('cf_var_pre',77),('cf_var_post',81),
                      ('credit_line',79)]:
        d[key] = {k: sc(row, c) for k,c in [('plan','B'),('act','C'),('var','D'),
                                              ('ann_plan','G'),('ann_proj','H'),('ann_var','I')]}

    def get_a(name):
        for i,row in df_a.iterrows():
            if str(row[0]).strip() == name: return float(row[WK]) if pd.notna(row[WK]) else 0.0
        return 0.0
    def get_b(name, wks=None):
        w = wks or WK
        for i,row in df_b.iterrows():
            if str(row[0]).strip() == name:
                return sum(float(row[j]) for j in range(1, w+1) if pd.notna(row[j]))
        return 0.0
    def get_r(name):
        for i,row in df_b.iterrows():
            if str(row[0]).strip() == name:
                return sum(float(row[j]) for j in range(WK+1, 53) if pd.notna(row[j]))
        return 0.0
    def get_ann(name):
        for i,row in df_b.iterrows():
            if str(row[0]).strip() == name: return float(row[59]) if pd.notna(row[59]) else 0.0
        return 0.0
    def proj(name): return get_a(name) + get_r(name)

    rev_map = [
        ('Jettylife.com (DTC)',   'DTC - Jettylife.com'),
        ('Wholesale',             'Wholesale Revenue'),
        ('Screen printing (INK)', 'Screen Printing Revenue'),
        ('Flagship Store',        'DTC - Flagship Store'),
        ('Long Branch',           'DTC - Long Branch'),
        ('Mobile Store & Tent',   'DTC - Mobile Store & Tent'),
        ('JRF Screen Printing',   'JRF - Screen Printing'),
    ]
    d['rev_lines'] = []
    for lbl, k in rev_map:
        act, plan, ann_plan_v, ann_proj_v = get_a(k), get_b(k), get_ann(k), proj(k)
        trend_v = seasonal_ann_proj(k, act, ann_plan_v, WK)
        d['rev_lines'].append((lbl, act, plan, ann_plan_v, ann_proj_v, trend_v))
    # Total Revenue's trend projection is just each channel's own trend summed
    # — every channel has its own seasonality curve, so there's no single
    # curve for "all revenue" to run the ytd/expected-pace math against directly.
    d['rev_trend_total'] = sum(tp for *_, tp in d['rev_lines'])
    # Net Income's trend blends Revenue's seasonality-adjusted trend (a real,
    # validated signal -- consumer buying seasonality repeats year to year)
    # with COGS+Labor+Shipping's, OpEx's, and EBIT Expenses' own plan-paced
    # Full Year Projection, *not* a cost-side seasonality curve -- we tried
    # that and reverted it, since bill/payment entry timing doesn't repeat
    # the way revenue does (see the note by COGS_LS_TOTAL above). Building
    # off net_income['ann_proj'] rather than re-deriving from rev/cogs/opex
    # keeps EBIT Expenses (interest, D&A, taxes -- read directly off the
    # Summary sheet, not broken out into `d`) correctly in the total: only
    # the revenue term is swapped for its trend-adjusted counterpart.
    d['net_income_trend'] = d['net_income']['ann_proj'] + (d['rev_trend_total'] - d['rev']['ann_proj'])

    # ── 52-week trend charts (Summary tab) ──────────────────────────────────
    # Row indices are consistent across '2025 Actual', '2026 Budget', and
    # '2026 Actual' -- all three sheets share the same P&L layout.
    TREND_ROWS = {'revenue': 18, 'cogs': 32, 'opex': 96, 'ebit': 105, 'net_income': 107}
    # 2025's Total COGS/OpEx/EBIT rows are SUM formulas over mostly-blank
    # category rows -- only the 12 month-end weeks (where we backfilled a
    # typed-over cumulative value, per the Net Income trend project) hold a
    # real figure; every other week reads as a plain 0, not blank, so it has
    # to be filtered explicitly rather than relying on NaN. Net Income is
    # itself a formula off those two (Income - COGS - OpEx), so at every
    # non-month-end week it silently evaluates to Income - 0 - 0 == Income --
    # caught by cross-checking it against the Total Income row directly.
    # Revenue is the one row genuinely populated for all 52 weeks.
    MONTH_END_WEEKS = {4,8,13,17,21,26,30,34,39,43,47,52}

    def cum_from_weekly_budget(df, row):
        weekly = [df.iloc[row, c] or 0 for c in range(1, 53)]
        out = []; s = 0
        for v in weekly:
            s += v
            out.append(s)
        return out  # 52 values, index 0 = week 1

    def cum_from_actual(df, row, thru_wk=52, month_end_only=False):
        out = []
        for wk in range(1, 53):
            v = df.iloc[row, wk]
            if wk > thru_wk or pd.isna(v) or (month_end_only and wk not in MONTH_END_WEEKS):
                out.append(None)
            else:
                out.append(float(v))
        return out

    d['trend_charts'] = {}
    for key, row in TREND_ROWS.items():
        d['trend_charts'][key] = {
            'act_2025':  cum_from_actual(df_25, row, month_end_only=(key in ('cogs','opex','ebit','net_income'))),
            'plan_2026': cum_from_weekly_budget(df_b, row),
            'act_2026':  cum_from_actual(df_a, row, thru_wk=WK),
        }

    # Trend continuation for weeks WK..52, anchored to the real actual value
    # at WK so it joins the solid actual line without a visible seam:
    #  - revenue: each channel's own validated seasonality curve, summed --
    #    this naturally lands on the real actual total at week WK by
    #    construction (trend_v * cum_weight_at_WK == that channel's actual).
    #  - cogs/opex/ebit: parallels the remaining *budgeted* weekly shape --
    #    no cost-side seasonality curve exists (see the note above
    #    CHANNEL_SEASONALITY for why that was tried and reverted).
    #  - net_income: revenue trend minus cogs/opex/ebit trend, week by week.
    # Normalized so each channel's own cumulative weight hits exactly 1.0 at
    # week 52 (raw monthly weights are rounded to 3 decimals and sum to
    # ~0.998-1.001 per channel) -- without this, the week-52 chart point
    # drifts a fraction of a percent off the "Trend Proj." figure already
    # shown on the Total Revenue card, which uses trend_v as-is.
    def _norm_cum_weights(k):
        raw = _weekly_weights(CHANNEL_SEASONALITY[k])
        total = sum(raw)
        return [sum(raw[:i]) / total for i in range(1, 53)]
    rev_cum_weights = {k: _norm_cum_weights(k) for _, k in rev_map}
    rev_trend_v = {k: seasonal_ann_proj(k, get_a(k), get_ann(k), WK) for _, k in rev_map}
    rev_trend = [None]*52
    for wk in range(WK, 53):
        rev_trend[wk-1] = sum(rev_trend_v[k] * rev_cum_weights[k][wk-1] for _, k in rev_map)
    d['trend_charts']['revenue']['trend_2026'] = rev_trend

    def plan_paced_trend(tc):
        plan = tc['plan_2026']; act_wk = tc['act_2026'][WK-1]
        return [None]*(WK-1) + [act_wk] + [act_wk + (plan[wk-1]-plan[WK-1]) for wk in range(WK+1, 53)]

    for key in ('cogs', 'opex', 'ebit'):
        d['trend_charts'][key]['trend_2026'] = plan_paced_trend(d['trend_charts'][key])

    d['trend_charts']['net_income']['trend_2026'] = [
        None if any(x is None for x in (r,c,o,e)) else r-c-o-e
        for r,c,o,e in zip(d['trend_charts']['revenue']['trend_2026'],
                            d['trend_charts']['cogs']['trend_2026'],
                            d['trend_charts']['opex']['trend_2026'],
                            d['trend_charts']['ebit']['trend_2026'])
    ]

    cogs_map = [
        ('Contract design — brand', 'Contract Design - Brand'),
        ('Contract design — INK',   'Contract Design - Ink'),
        ('Shipping — brand',        'Shipping - BRAND'),
        ('Shipping — INK',          'Shipping - INK'),
    ]
    d['cogs_lines'] = [(lbl, get_a(k), get_b(k), get_ann(k), proj(k)) for lbl,k in cogs_map]

    opex_map = [
        ('Advertising',                  'Advertising'),
        ('Advertising — INK',            'Advertising - Ink'),
        ('Ambassador & influencer',      'Ambassador & Influencer Expenses'),
        ('Box truck',                    'Box Truck'),
        ('Dues & subscriptions',         'Dues & Subscriptions'),
        ('Equipment & repairs',          'Equipment & Repairs'),
        ('Ford Transit — INK van',       'Ford Transit - Ink Van Expenses'),
        ('INK merch store profit share', 'Ink Merch Store Profit Share'),
        ('MKG — bags',                   'MKG - Bags'),
        ('MKG — banners, POP & misc.',   'MKG - Banners, P.O.P & Misc.'),
        ('MKG — catalogs',               'MKG - Catalogs'),
        ('MKG — direct mail',            'MKG - Direct Mail'),
        ('MKG — hang tags & size tags',  'MKG - Hang Tags & Size Tags'),
        ('MKG — photography',            'MKG - Photography'),
        ('MKG — stickers',               'MKG - Stickers'),
        ('MKG — tent sale expenses',     'MKG - Tent Sale Expenses'),
        ('MKG — trade show',             'MKG - Trade Show Expense'),
        ('MKG — video',                  'MKG - Video'),
        ('Miscellaneous warehouse exp.', 'Miscellaneous Warehouse Expenses'),
        ('Office supplies',              'Office Expense - Office Supplies'),
        ('Payroll service',              'Payroll Service'),
        ('Permits — 176 E Bay',          'Permits & Building - 176 E Bay'),
        ('Permits — 700 S Main',         'Permits & Building - 700 S Main St'),
        ('Permits — Flagship',           'Permits & Building - Flagship Store'),
        ('Permits — Jetty INK',          'Permits & Building - Jetty Ink'),
        ('Permits — Long Branch',        'Permits & Building - Long Branch'),
        ('Screen printing supplies',     'Screen Printing Supplies'),
        ('Selling exp. — rep supplies',  'Selling Expenses - Rep Supplies'),
        ('Selling exp. — rep travel',    'Selling Expenses - Rep Travel'),
        ('Shipping supplies',            'Shipping Supplies'),
        ('Software & inventory control', 'Software & Inventory Control'),
        ('Team building',                'Team Building'),
        ('Website expenses',             'Website Expenses'),
    ]
    opex_categories = read_categories()
    if opex_categories:
        # Categories tab is the authoritative full line-item list once it exists —
        # it covers every real OpEx row, not just the hand-picked opex_map subset.
        label_overrides = {k: lbl for lbl, k in opex_map}
        opex_keys = list(opex_categories.keys())
        opex_lines = [(label_overrides.get(k, k), get_a(k), get_b(k), get_ann(k), proj(k)) for k in opex_keys]
    else:
        opex_keys = [k for lbl, k in opex_map]
        opex_lines = [(lbl, get_a(k), get_b(k), get_ann(k), proj(k)) for lbl, k in opex_map]
    d['opex_lines'] = opex_lines
    d['opex_keys'] = opex_keys
    d['opex_categories'] = opex_categories

    # Cash flow
    cin_w,cin_d,cin_i,cin_t,cout_b,cout_i,cout_o,cout_l,cout_e = [],[],[],[],[],[],[],[],[]
    proj_w,proj_d,proj_i,proj_b,proj_i2,proj_o,proj_l,proj_e  = [],[],[],[],[],[],[],[]
    rw=rd=ri=rb=ri2=ro=rl=re=0
    labels=[]
    # Weekly cash-in schedule: the sheet's "Actual" columns (10-13) are cumulative,
    # so per-week cash in is the delta vs the prior week's cumulative total. Plan
    # columns (5-8) are already per-week, so weeks beyond WK can be shown as-is
    # for a forecast of the remaining schedule.
    cf_weekly, cf_forecast = [], []
    prev_w = prev_d = prev_i = prev_t = 0.0
    # Full-year plan totals (all 52 weeks), for an annual projection that's
    # consistent with the actual+remaining-plan convention used everywhere
    # else: ann_proj = ytd_act + remaining_plan, so ann_var always equals
    # ytd_var exactly (remaining_plan cancels out of the subtraction).
    aw_full=ad_full=ai_full=ab_full=ai2_full=ao_full=al_full=ae_full=0.0
    for _,row in df_cf.iterrows():
        if pd.notna(row[2]) and str(row[2]) != 'Week':
            try: wk = int(row[2])
            except: continue
            if wk > 52: break
            plan_w = float(row[5]) if pd.notna(row[5]) else 0.0
            plan_d = float(row[6]) if pd.notna(row[6]) else 0.0
            plan_i = float(row[7]) if pd.notna(row[7]) else 0.0
            plan_t = float(row[8]) if pd.notna(row[8]) else (plan_w+plan_d+plan_i)
            cout_b_plan = float(row[15]) if pd.notna(row[15]) else 0.0
            cout_i_plan = float(row[16]) if pd.notna(row[16]) else 0.0
            cout_o_plan = float(row[17]) if pd.notna(row[17]) else 0.0
            cout_l_plan = float(row[18]) if pd.notna(row[18]) else 0.0
            cout_e_plan = float(row[19]) if pd.notna(row[19]) else 0.0
            aw_full+=plan_w; ad_full+=plan_d; ai_full+=plan_i
            ab_full+=cout_b_plan; ai2_full+=cout_i_plan; ao_full+=cout_o_plan; al_full+=cout_l_plan; ae_full+=cout_e_plan
            if wk > WK:
                cf_forecast.append(dict(wk=wk, w=plan_w, d=plan_d, i=plan_i, t=plan_t))
                continue
            rw  += plan_w
            rd  += plan_d
            ri  += plan_i
            rb  += cout_b_plan
            ri2 += cout_i_plan
            ro  += cout_o_plan
            rl  += cout_l_plan
            re  += cout_e_plan
            act  = float(row[13]) if pd.notna(row[13]) else 0
            if act > 0:
                cum_w = float(row[10]) if pd.notna(row[10]) else prev_w
                cum_d = float(row[11]) if pd.notna(row[11]) else prev_d
                cum_i = float(row[12]) if pd.notna(row[12]) else prev_i
                cum_t = act
                cf_weekly.append(dict(wk=wk, w=cum_w-prev_w, d=cum_d-prev_d, i=cum_i-prev_i, t=cum_t-prev_t,
                                       pw=plan_w, pd_=plan_d, pi=plan_i, pt=plan_t))
                prev_w, prev_d, prev_i, prev_t = cum_w, cum_d, cum_i, cum_t

                labels.append("Wk " + str(wk))
                cin_w.append(round(cum_w)); cin_d.append(round(cum_d)); cin_i.append(round(cum_i))
                cin_t.append(round(cum_t))
                cout_b.append(round(float(row[21]) if pd.notna(row[21]) else 0))
                cout_i.append(round(float(row[22]) if pd.notna(row[22]) else 0))
                cout_o.append(round(float(row[23]) if pd.notna(row[23]) else 0))
                cout_l.append(round(float(row[24]) if pd.notna(row[24]) else 0))
                cout_e.append(round(float(row[25]) if pd.notna(row[25]) else 0))
                proj_w.append(round(rw));  proj_d.append(round(rd));  proj_i.append(round(ri))
                proj_b.append(round(rb));  proj_i2.append(round(ri2)); proj_o.append(round(ro))
                proj_l.append(round(rl));  proj_e.append(round(re))

    d['cf'] = dict(labels=labels,
        cin_w=cin_w, cin_d=cin_d, cin_i=cin_i, cin_t=cin_t,
        cout_b=cout_b, cout_i=cout_i, cout_o=cout_o, cout_l=cout_l, cout_e=cout_e,
        proj_w=proj_w, proj_d=proj_d, proj_i=proj_i,
        proj_b=proj_b, proj_i2=proj_i2, proj_o=proj_o, proj_l=proj_l, proj_e=proj_e)
    d['cf_ann_plan'] = dict(w=aw_full, d=ad_full, i=ai_full,
                             b=ab_full, i2=ai2_full, o=ao_full, l=al_full, e=ae_full)
    d['cf_weekly']   = cf_weekly
    d['cf_forecast'] = cf_forecast

    # ── Bank Position & Weekly Reconciliation (Cash Flow - Weekly / Bank Balance) ──
    # Added once actual bank activity started getting tracked directly: "Cash
    # Flow - Weekly" is a straight pull of Xero's General Ledger Report --
    # every real credit/debit across both bank accounts (Columbia + BOA) for
    # the week, no plan-vs-channel modeling involved. "Bank Balance" is the
    # two accounts' actual recorded starting/ending balances, independently
    # entered from online banking. Because these come from two different
    # sources, "prior week's actual balance + this week's true cash in - true
    # cash out" should equal this week's recorded actual balance -- any gap
    # is a real unreconciled transaction or double-entry, not a modeling
    # artifact, which is exactly why this is useful as an ongoing weekly
    # check rather than just a one-time cleanup.
    # These two tabs have come and gone before (rebuilt from scratch, or lost
    # entirely to an unsaved-sheet mishap) -- a missing sheet should degrade
    # this section to empty, not take down the whole build.
    try:
        df_cfw = pd.read_excel(FP, sheet_name='Cash Flow - Weekly', engine='pyxlsb', header=None)
        df_bb  = pd.read_excel(FP, sheet_name='Bank Balance',      engine='pyxlsb', header=None)
    except ValueError as e:
        print("Bank Position skipped, sheet not found:", e)
        df_cfw = df_bb = None

    def cfw_row(label):
        # Case-insensitive: the sheet's row label has drifted between "Total
        # Cash Out" and "Total Cash OUT" before, which silently zeroed out
        # this whole section (r_cout came back None) without erroring.
        if df_cfw is None:
            return None
        for _, row in df_cfw.iterrows():
            if str(row[0]).strip().lower() == label.lower():
                return row
        return None
    r_cin, r_cout, r_draw, r_pay = (cfw_row(l) for l in
        ('Total Cash IN', 'Total Cash Out', 'Columbia CL Draw', 'Columbia CL Paydown'))

    if df_bb is not None:
        bb_2026 = df_bb[df_bb[0] == 2026]
        bb_total_by_wk = {int(row[2]): float(row[8]) for _, row in bb_2026.iterrows() if pd.notna(row[8]) and row[8] != 0}
        bb_accts_by_wk = {int(row[2]): dict(columbia=float(row[5]) if pd.notna(row[5]) else 0.0,
                                             boa=float(row[6]) if pd.notna(row[6]) else 0.0,
                                             ramp=float(row[7]) if pd.notna(row[7]) else 0.0)
                          for _, row in bb_2026.iterrows() if pd.notna(row[8]) and row[8] != 0}
        prior_year_row = df_bb[(df_bb[0] == 2025) & (df_bb[2] == 52)]
        bb_prior_year_end = float(prior_year_row.iloc[0][8]) if len(prior_year_row) else None
    else:
        bb_total_by_wk, bb_accts_by_wk, bb_prior_year_end = {}, {}, None

    bank_position = []
    prev_end = bb_prior_year_end
    if r_cin is not None and r_cout is not None and prev_end is not None:
        for wk in range(1, 53):
            cin  = float(r_cin[wk])  if pd.notna(r_cin[wk])  else None
            cout = float(r_cout[wk]) if pd.notna(r_cout[wk]) else None
            if cin is None or cout is None:
                break  # no further weeks entered yet
            draw = float(r_draw[wk]) if r_draw is not None and pd.notna(r_draw[wk]) else 0.0
            pay  = float(r_pay[wk])  if r_pay  is not None and pd.notna(r_pay[wk])  else 0.0
            computed_end = prev_end + cin - cout
            actual_end = bb_total_by_wk.get(wk)
            gap = (actual_end - computed_end) if actual_end is not None else None
            bank_position.append(dict(wk=wk, start=prev_end, cash_in=cin, cash_out=cout,
                                       cl_draw=draw, cl_paydown=pay, computed_end=computed_end,
                                       actual_end=actual_end, gap=gap, accts=bb_accts_by_wk.get(wk)))
            # Chain off the actual recorded balance when we have one, so a
            # single week's gap doesn't compound into every week after it.
            prev_end = actual_end if actual_end is not None else computed_end

    d['bank_position']  = bank_position
    d['bp_latest']       = bank_position[-1] if bank_position else None
    d['bp_year_start']   = bb_prior_year_end
    GAP_WATCH = 15000  # weekly reconciliation gap large enough to flag for follow-up
    d['bp_gap_watch']    = GAP_WATCH
    d['bp_flags']        = [bp for bp in bank_position if bp['gap'] is not None and abs(bp['gap']) > GAP_WATCH]
    if bank_position:
        d['bp_ytd'] = dict(
            cash_in    = sum(bp['cash_in']    for bp in bank_position),
            cash_out   = sum(bp['cash_out']   for bp in bank_position),
            cl_draw    = sum(bp['cl_draw']    for bp in bank_position),
            cl_paydown = sum(bp['cl_paydown'] for bp in bank_position),
        )
        d['bp_ytd']['net'] = d['bp_ytd']['cash_in'] - d['bp_ytd']['cash_out']
    else:
        d['bp_ytd'] = None

    # Credit line: monthly cadence (unlike the weekly cash schedule above),
    # from two different sources -- the bank's monthly Borrowing Certificate
    # (actual balance, submitted after the fact) for the 2025 and 2026
    # actual trajectories, and the original "Cash Flow - Plan" sheet for the
    # full-year 2026 plan. That plan sheet is never edited after the year
    # starts, so it stays a true fixed reference rather than drifting to
    # match reality the way the certificate's actuals naturally do.
    MONTH_ORDER = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
    df_cert = pd.read_excel(FP, sheet_name='Columbia Certificate', engine='pyxlsb', header=None)
    cert_2025, cert_2026, loc_status = {}, {}, None
    for r in range(6, df_cert.shape[0]):
        row = df_cert.iloc[r]
        yr, mon, bal = row[0], row[1], row[7]
        if pd.isna(yr) or pd.isna(mon) or pd.isna(bal):
            continue  # future months not yet certified -- placeholder row
        entry = dict(balance=float(bal), month=str(mon).strip(),
                     coverage_x=(float(row[11]) if pd.notna(row[11]) and not isinstance(row[11], str) else None),
                     status=(str(row[13]) if pd.notna(row[13]) else ''))
        (cert_2025 if int(yr) == 2025 else cert_2026)[str(mon).strip()] = entry
        if int(yr) == 2026:
            loc_status = entry  # rows are chronological -- last write is the latest certified month
    d['loc_2025']     = [cert_2025[m]['balance'] if m in cert_2025 else None for m in MONTH_ORDER]
    d['loc_2026_act'] = [cert_2026[m]['balance'] if m in cert_2026 else None for m in MONTH_ORDER]
    d['loc_status']   = loc_status

    df_locplan = pd.read_excel(FP, sheet_name='Cash Flow - Plan', engine='pyxlsb', header=None)
    plan_month_cols = [1,2,3,4,5,6,8,9,10,11,12,13]  # Jan..Jun, Jul..Dec (skips the H1/H2 rollup columns)
    def loc_plan_row(r):
        row = df_locplan.iloc[r]
        return [float(row[c]) if pd.notna(row[c]) else 0.0 for c in plan_month_cols]
    loc_plan_bom = loc_plan_row(34)  # "Balance BOM"
    loc_plan_use = loc_plan_row(35)  # "Use of Credit"
    loc_plan_pay = loc_plan_row(36)  # "Paydown of Credit"
    loc_plan_eom = loc_plan_row(37)  # "Balance EOM"
    d['loc_plan_bom']     = loc_plan_bom
    d['loc_plan_monthly'] = [dict(month=MONTH_ORDER[i], bom=loc_plan_bom[i], draw=loc_plan_use[i],
                                   paydown=loc_plan_pay[i], eom=loc_plan_eom[i]) for i in range(12)]

    # Trend continuation: certified actual through the latest certified
    # month, then the original plan's remaining months -- anchored on the
    # last actual value (duplicated at the seam) so the dashed line picks up
    # exactly where the solid actual line stops, same convention as the
    # Summary tab's 52-week trend charts.
    n_elapsed = sum(1 for v in d['loc_2026_act'] if v is not None)
    d['loc_n_elapsed'] = n_elapsed
    if n_elapsed == 0:
        d['loc_2026_trend'] = list(loc_plan_bom)
    else:
        d['loc_2026_trend'] = ([None]*(n_elapsed-1) + [d['loc_2026_act'][n_elapsed-1]]
                                + loc_plan_bom[n_elapsed:12])

    d['ap_cns'] = fetch_ap_cns()

    # Inventory. A missing weekly reading is not the same as zero on hand — it
    # just means nobody recorded a count that week. carry_forward fills those
    # gaps with the last known value (instead of a fake drop to $0/0 units)
    # and flags which weeks were filled in, so charts can mark them distinctly.
    def carry_forward(pairs):
        values = {}; estimated = set(); prev = None
        for wk, v in sorted(pairs):
            if v is not None:
                values[wk] = v; prev = v
            elif prev is not None:
                values[wk] = prev; estimated.add(wk)
        return values, estimated

    d['inv_est'] = {}  # series name -> set of weeks whose value was carried forward

    # The sheet's Inventory tab was restructured to a simpler layout: one
    # Total INV COG (col 5) / Total Units (col 6) pair per week, plus six
    # named sell-through columns (S24/F24/S25/F25/S26/F26, cols 8-13) — no
    # more per-category COG/units breakdown. Col 7 (Avg Cost/Unit) is a
    # formula-error placeholder in the export and is ignored; we compute the
    # average ourselves from COG/units instead.
    inv_wks = []
    pairs_c = []; pairs_u = []
    for _,row in df_inv[df_inv[0]==2026].iterrows():
        if not pd.notna(row[2]): continue
        wk = int(row[2])
        if wk > WK: continue
        inv_wks.append(wk)
        c = float(row[5]) if pd.notna(row[5]) and isinstance(row[5],(int,float)) else None
        u = float(row[6]) if pd.notna(row[6]) and isinstance(row[6],(int,float)) else None
        pairs_c.append((wk,c)); pairs_u.append((wk,u))

    cog_v, cog_e = carry_forward(pairs_c)
    u_v,   u_e   = carry_forward(pairs_u)
    d['inv_est']['cog_2026']   = cog_e
    d['inv_est']['units_2026'] = u_e
    d['cog_2026']   = {wk: round(cog_v[wk]) for wk in inv_wks if wk in cog_v}
    d['units_2026'] = {wk: round(u_v[wk])   for wk in inv_wks if wk in u_v}
    d['inv_wks']      = inv_wks
    d['inv_latest_wk']= inv_wks[-1] if inv_wks else None
    d['inv_prev_wk']  = inv_wks[-2] if len(inv_wks) > 1 else None

    for yr,ck,uk in [(2024,'cog_2024','units_2024'),(2025,'cog_2025','units_2025')]:
        pairs_c=[]; pairs_u=[]
        for _,row in df_inv[df_inv[0]==yr].iterrows():
            if pd.notna(row[2]):
                try:
                    wk=int(row[2])
                    cv = float(row[5]) if pd.notna(row[5]) and isinstance(row[5],(int,float)) else None
                    uv = float(row[6]) if pd.notna(row[6]) and isinstance(row[6],(int,float)) else None
                    pairs_c.append((wk,cv)); pairs_u.append((wk,uv))
                except: pass
        cog_v, cog_e = carry_forward(pairs_c)
        u_v,   u_e   = carry_forward(pairs_u)
        d[ck] = {wk: round(v) for wk,v in cog_v.items()}
        d[uk] = {wk: round(v) for wk,v in u_v.items()}
        d['inv_est'][ck] = cog_e
        d['inv_est'][uk] = u_e

    lw = d['inv_latest_wk']
    d['yoy_cog_2025']=0; d['yoy_units_2025']=0
    if lw:
        for _,row in df_inv[df_inv[0]==2025].iterrows():
            if pd.notna(row[2]) and int(row[2])==lw:
                d['yoy_cog_2025']  = round(float(row[5])) if pd.notna(row[5]) else 0
                d['yoy_units_2025']= round(float(row[6])) if pd.notna(row[6]) else 0
                break

    # Sell-through: each season has its own dedicated column now (8-13), but
    # every column is still only populated in the one year that season was
    # actively selling (e.g. F25 sell-through is tracked in 2026 rows, since
    # that's when F25 units were on the floor) — pull each from its actual
    # active year, not from the year its name suggests.
    def extract_st(year, col):
        pairs = []
        for _,row in df_inv[df_inv[0]==year].iterrows():
            if pd.notna(row[2]):
                wk = int(row[2])
                v = float(row[col]) if pd.notna(row[col]) and isinstance(row[col],(int,float)) and 0<float(row[col])<=1 else None
                pairs.append((wk, round(v*100,1) if v is not None else None))
        return carry_forward(pairs)

    d['st_s24'], d['inv_est']['st_s24'] = extract_st(2024, 8)
    d['st_f24'], d['inv_est']['st_f24'] = extract_st(2024, 9)
    d['st_s25'], d['inv_est']['st_s25'] = extract_st(2025, 10)
    d['st_f25'], d['inv_est']['st_f25'] = extract_st(2026, 11)
    d['st_s26'], d['inv_est']['st_s26'] = extract_st(2026, 12)
    d['st_f26'], d['inv_est']['st_f26'] = extract_st(2026, 13)

    # On Order: total, by product category, and by half — for both this year
    # and next, since orders for 2027 H1 start landing well before 2026 closes.
    # Column layout (row 4 headers): 5=Total, 6-13=categories (Clearance,
    # Collab, F26, S25, S26, SP27, SU27, STARBOARD), 14=H1 2026, 15=H2 2026,
    # 16=H1 2027, 17=H2 2027. STARBOARD was added as a category after this
    # was first written, shifting the H1/H2 columns one to the right of what
    # the code assumed -- verified against the sheet's own Total (col 5,
    # which equals the sum of cols 6-13, and separately equals the sum of
    # cols 14-17) that 14/15/16/17 is the correct mapping, not 13/14/15/16.
    d['on_order']={'total':0,'h1':0,'h2':0}
    d['on_order_cats'] = []
    d['on_order_periods'] = {'h1_2026':0,'h2_2026':0,'h1_2027':0,'h2_2027':0}
    for _,row in df_oo.iterrows():
        if pd.notna(row[0]) and row[0]==2026 and pd.notna(row[2]) and int(row[2])==WK:
            d['on_order']={
                'total': float(row[5])  if pd.notna(row[5])  else 0,
                'h1':    float(row[14]) if pd.notna(row[14]) else 0,
                'h2':    float(row[15]) if pd.notna(row[15]) else 0,
            }
            cat_cols_oo = [('Clearance',6),('Collab',7),('F26',8),('S25',9),('S26',10),('SP27',11),('SU27',12),('STARBOARD',13)]
            d['on_order_cats'] = [(name, float(row[c]) if pd.notna(row[c]) else 0.0) for name,c in cat_cols_oo]
            d['on_order_periods'] = {
                'h1_2026': float(row[14]) if pd.notna(row[14]) else 0.0,
                'h2_2026': float(row[15]) if pd.notna(row[15]) else 0.0,
                'h1_2027': float(row[16]) if pd.notna(row[16]) else 0.0,
                'h2_2027': float(row[17]) if pd.notna(row[17]) else 0.0,
            }
            break

    def get_a_at(name, wk):
        for _,row in df_a.iterrows():
            if str(row[0]).strip() == name:
                return float(row[wk]) if pd.notna(row[wk]) else 0.0
        return 0.0

    for _,row in df_b.iterrows():
        if str(row[0])=='Wholesale Revenue':
            d['whsl_h1_plan'] = sum(float(row[j]) for j in range(1,27)  if pd.notna(row[j]))
            d['whsl_h2_plan'] = sum(float(row[j]) for j in range(27,53) if pd.notna(row[j]))
            break

    # Actual sheet columns are cumulative-to-date, so week 26 (the last week
    # of H1) gives a real H1-only actual regardless of which half we're in
    # now — no more "weeks left in H1" math that goes negative once H2 starts.
    whsl_h1_actual = get_a_at('Wholesale Revenue', min(WK, 26))
    whsl_ytd_actual = get_a_at('Wholesale Revenue', WK)
    whsl_h2_actual = max(0.0, whsl_ytd_actual - whsl_h1_actual) if WK > 26 else 0.0
    d['whsl_act']      = whsl_ytd_actual
    d['whsl_h1_actual']= whsl_h1_actual
    d['whsl_h2_actual']= whsl_h2_actual
    d['whsl_h1_proj']  = whsl_h1_actual + d['on_order']['h1']
    d['whsl_h2_proj']  = whsl_h2_actual + d['on_order']['h2']
    d['whsl_h1_gap']   = d['whsl_h1_plan'] - d['whsl_h1_proj']
    d['whsl_h2_gap']   = d['whsl_h2_plan'] - d['whsl_h2_proj']

    # Labor: monthly Plan/Actual/Variance for JETTY INK (cols 0-6) and JETTY BRAND
    # (cols 8-14). A month with no Actual yet hasn't closed — its Plan counts toward
    # the remaining-plan total (and so the full-year projection) but not YTD actual,
    # matching the actual+remaining-plan projection convention used elsewhere.
    def labor_year(col0, year):
        months=[]; ytd_act=ytd_plan=rem_plan=ann_plan=0.0
        for _,row in df_lb.iterrows():
            y = row[col0]
            if not isinstance(y, (int, float)) or pd.isna(y) or int(y) != year: continue
            plan = float(row[col0+4]) if pd.notna(row[col0+4]) else 0.0
            act  = row[col0+5]
            mon  = str(row[col0+1]).strip() if pd.notna(row[col0+1]) else ''
            ann_plan += plan
            if pd.notna(act):
                ytd_act += float(act); ytd_plan += plan
                months.append((mon, plan, float(act)))
            else:
                rem_plan += plan
                months.append((mon, plan, None))
        return dict(ytd_act=ytd_act, ytd_plan=ytd_plan, ytd_var=ytd_act-ytd_plan,
                    ann_plan=ann_plan, ann_proj=ytd_act+rem_plan,
                    ann_var=(ytd_act+rem_plan)-ann_plan, months=months)

    labor_ink   = labor_year(0, 2026)
    labor_brand = labor_year(8, 2026)
    labor_total = dict(
        ytd_act = labor_ink['ytd_act']+labor_brand['ytd_act'],
        ytd_plan= labor_ink['ytd_plan']+labor_brand['ytd_plan'],
        ann_plan= labor_ink['ann_plan']+labor_brand['ann_plan'],
        ann_proj= labor_ink['ann_proj']+labor_brand['ann_proj'],
    )
    labor_total['ytd_var'] = labor_total['ytd_act']-labor_total['ytd_plan']
    labor_total['ann_var'] = labor_total['ann_proj']-labor_total['ann_plan']
    labor_total['months']  = [(m, pi+pb, (ai+ab) if ai is not None and ab is not None else None)
                               for (m,pi,ai),(_,pb,ab) in zip(labor_ink['months'], labor_brand['months'])]
    d['labor_ink']   = labor_ink
    d['labor_brand'] = labor_brand
    d['labor_total'] = labor_total

    # Payroll: biweekly headcount + overtime. Weeks with no Total Payroll are the
    # off week in each pay period and carry no snapshot.
    payroll = []
    for _,row in df_pr.iterrows():
        if isinstance(row[0], (int, float)) and pd.notna(row[0]) and isinstance(row[4], (int, float)) and pd.notna(row[4]):
            pay_date = (pd.to_datetime(row[3], unit='D', origin='1899-12-30').strftime('%b %d, %Y')
                        if pd.notna(row[3]) and isinstance(row[3], (int, float)) else '')
            payroll.append(dict(
                wk=int(row[0]), pay_date=pay_date, total_payroll=float(row[4]),
                taxes=float(row[5]) if pd.notna(row[5]) else 0.0,
                net=float(row[6]) if pd.notna(row[6]) else 0.0,
                total=int(row[7]), pt=int(row[8]), ft=int(row[9]),
                hourly=int(row[10]), salary=int(row[11]),
                female=int(row[12]), male=int(row[13]),
                ink=int(row[14]), brand=int(row[15]),
                depts=dict(
                    ink_design=int(row[16]), ink_ops=int(row[17]), ink_prod=int(row[18]), ink_sales=int(row[19]),
                    logistics=int(row[20]), mkg=int(row[21]), prodev=int(row[22]), flagship=int(row[23]),
                    long_branch=int(row[24]), box_truck=int(row[25]), whsl_sales=int(row[26]), finance=int(row[27]),
                ),
                ot_hours=float(row[28]) if pd.notna(row[28]) else 0.0,
                ot_amount=float(row[29]) if pd.notna(row[29]) else 0.0,
            ))
    d['payroll']        = payroll
    d['payroll_latest'] = payroll[-1] if payroll else None

    return d

# Two known source-sheet labeling inconsistencies for the OpEx "Program
# Services" line, found by cross-checking against Summary's own Program
# Services figures: Monthly/Annual - Budget mistakenly tag that line's
# category as "Donation"; Actual (Cumulative) - Sorted spells it "Program
# Service" (singular) instead of "Program Services". Both get normalized
# to the same key so the line groups correctly regardless of source sheet.
JRF_OPEX_CATEGORY_FIX = {'Donation': 'Program Services', 'Program Service': 'Program Services'}

def _jrf_as_of_month(raw):
    """The 'As of' cell has been typed as plain text ('As of 7/31/26') and,
    after the user re-entered it, as a real date -- handle both so a future
    formatting change doesn't silently break the month lookup."""
    if isinstance(raw, datetime.datetime):
        return raw.month, raw.strftime('%m/%d/%y').lstrip('0').replace('/0', '/')
    s = str(raw).replace('As of', '').strip()
    month = int(s.split('/')[0])
    return month, s

def _jrf_section_rows(ws, cat_col, acct_col, val_fn):
    """Yields (section, category, account, values) for every real line-item
    row in a sheet shaped like Monthly - Budget / Actual (Cumulative) -
    Sorted: an Income/Cost of Goods Sold/Operating Expenses section header,
    then Category+Account rows underneath, with 'Total X' subtotal rows to
    skip. Section-scoped because category labels like 'Event' and 'Other'
    repeat across the Revenue and OpEx sections."""
    section = None
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row, values_only=True):
        cat, acct = row[cat_col], row[acct_col]
        if cat is None and acct in ('Income', 'Cost of Goods Sold', 'Operating Expenses'):
            section = {'Income': 'rev', 'Cost of Goods Sold': 'don', 'Operating Expenses': 'opex'}[acct]
            continue
        if cat is None or acct is None: continue
        if str(acct).strip().startswith('Total') or str(acct).strip() == 'Gross Profit': continue
        yield section, str(cat).strip(), str(acct).strip(), val_fn(row)

def read_jrf():
    """JRF (Jetty Rock Foundation) tracks its own budget in a separate,
    simpler workbook (monthly cadence, no weekly detail) -- a distinct file
    from the main budget.xlsb. Returns None if that file isn't present so the
    main dashboard build never breaks on it; the JRF tab is simply omitted
    when that happens (see build_html).

    Budget/Actual/Projection are all derived here rather than read from the
    Summary sheet's own (manually-typed) columns -- so month to month, the
    only upkeep needed on the sheet is the 'As of' date and the Annual -
    Actual (Cumulative) tab (which JRF was already updating monthly per that
    sheet's own instructions); everything else -- cumulative-to-date budget,
    variance, full-year projection, per category -- gets computed the same
    way the rest of this dashboard computes projections: actual-to-date plus
    whatever's still budgeted for the remaining months."""
    if not os.path.exists(FP_JRF):
        return None
    wb = openpyxl.load_workbook(FP_JRF, data_only=True)
    ws = wb['Summary']
    as_of_raw = ws.cell(row=4, column=2).value
    as_of_month, as_of_str = _jrf_as_of_month(as_of_raw)

    def norm_opex_cat(section, cat):
        return JRF_OPEX_CATEGORY_FIX.get(cat, cat) if section == 'opex' else cat

    # Budget: Monthly - Budget has Category/Account/Jan..Dec/Total columns.
    # Aggregated two ways -- by category (for the rev/opex category cards,
    # where category is the real distinguishing field) and by exact account
    # name (for Donations, whose category column is uniformly "Donation"
    # for all three lines -- the account name is what actually varies).
    budget_cum, budget_full, budget_rem = {}, {}, {}
    budget_cum_acct, budget_full_acct, budget_rem_acct = {}, {}, {}
    for section, cat, acct, months in _jrf_section_rows(
            wb['Monthly - Budget'], 0, 1, lambda r: [r[c] or 0 for c in range(2, 14)]):
        cat = norm_opex_cat(section, cat)
        cum, full, rem = sum(months[:as_of_month]), sum(months), sum(months[as_of_month:])
        budget_cum.setdefault(section, {})[cat]  = budget_cum.setdefault(section, {}).get(cat, 0) + cum
        budget_full.setdefault(section, {})[cat] = budget_full.setdefault(section, {}).get(cat, 0) + full
        budget_rem.setdefault(section, {})[cat]  = budget_rem.setdefault(section, {}).get(cat, 0) + rem
        budget_cum_acct.setdefault(section, {})[acct]  = cum
        budget_full_acct.setdefault(section, {})[acct] = full
        budget_rem_acct.setdefault(section, {})[acct]  = rem

    # Actual: Actual (Cumulative) - Sorted has Category/Account/2023../2026.
    actual_cum, actual_cum_acct = {}, {}
    for section, cat, acct, val in _jrf_section_rows(
            wb['Actual (Cumulative) - Sorted'], 0, 1, lambda r: r[5] or 0):
        cat = norm_opex_cat(section, cat)
        actual_cum.setdefault(section, {})[cat]  = actual_cum.setdefault(section, {}).get(cat, 0) + val
        actual_cum_acct.setdefault(section, {})[acct] = actual_cum_acct.setdefault(section, {}).get(acct, 0) + val

    def line(section, key, by_account=False):
        bc_src, bf_src, rem_src, ac_src = (
            (budget_cum_acct, budget_full_acct, budget_rem_acct, actual_cum_acct) if by_account
            else (budget_cum, budget_full, budget_rem, actual_cum)
        )
        bc  = bc_src.get(section, {}).get(key, 0)
        bf  = bf_src.get(section, {}).get(key, 0)
        rem = rem_src.get(section, {}).get(key, 0)
        ac  = ac_src.get(section, {}).get(key, 0)
        proj = ac + rem
        return dict(plan=bc, act=ac, var=ac-bc, ann_plan=bf, ann_proj=proj, ann_var=proj-bf)

    def total(section):
        bc  = sum(budget_cum.get(section, {}).values())
        ac  = sum(actual_cum.get(section, {}).values())
        bf  = sum(budget_full.get(section, {}).values())
        rem = sum(budget_rem.get(section, {}).values())
        proj = ac + rem
        return dict(plan=bc, act=ac, var=ac-bc, ann_plan=bf, ann_proj=proj, ann_var=proj-bf)

    jrf = {}
    jrf['as_of'] = 'As of ' + as_of_str
    jrf['rev'] = total('rev')
    jrf['rev_cats'] = [(c, line('rev', c)) for c in ['Corporate','DTC','Event','Other','Private','Raffle']]
    jrf['don'] = total('don')
    jrf['don_cats'] = [(c.replace('Donation - ',''), line('don', c, by_account=True)) for c in
        ['Donation - Community & Education','Donation - Environmental','Donation - Storm & Disaster Relief']]
    jrf['opex'] = total('opex')
    jrf['opex_cats'] = [(c, line('opex', c)) for c in ['COGS','Program Services','Event','Finance','Labor','MKG','Other']]
    # Net Income has no line of its own in Monthly - Budget / Actual
    # (Cumulative) - Sorted -- it's Revenue minus Donations minus OpEx,
    # same as the Summary sheet's own formula.
    jrf['net_income'] = {
        k: jrf['rev'][k] - jrf['don'][k] - jrf['opex'][k] for k in jrf['rev']
    }

    # Outstanding donation commitments (Name/Amount/Bucket), rows 16-30
    commitments = []
    for r in range(16, 31):
        name = ws.cell(row=r, column=10).value
        if name is None or str(name).strip() == 'Total': continue
        commitments.append((
            str(name).strip(),
            ws.cell(row=r, column=11).value or 0,
            ws.cell(row=r, column=12).value or '',
        ))
    jrf['commitments'] = commitments
    jrf['commitments_total'] = ws.cell(row=31, column=11).value or 0

    jrf['don_analysis'] = dict(
        donated_to_date=ws.cell(row=37, column=10).value or 0,
        projected=ws.cell(row=37, column=12).value or 0,
        committed=ws.cell(row=37, column=14).value or 0,
        available=ws.cell(row=37, column=15).value or 0,
    )

    # YoY totals, top-level only (Total Income / Total COGS / Total OpEx /
    # Net Income) -- prior years (2023-2025) only have a single annual
    # actual on file, not a monthly budget to compare against, so there's
    # no meaningful "cumulative to date" cut for past years the way there
    # is for the current year above; this chart stays at the clean,
    # unambiguous top-line full-year comparison instead.
    ws2 = wb['Actual (Cumulative) - Sorted']
    yoy = {}
    for row in ws2.iter_rows(min_row=7, max_row=ws2.max_row, values_only=True):
        acct = row[1]
        if acct is None: continue
        acct = str(acct).strip()
        if acct in ('Total Income', 'Total Cost of Goods Sold', 'Total Operating Expenses', 'Net Income'):
            yoy[acct] = [row[2] or 0, row[3] or 0, row[4] or 0, row[5] or 0]
    jrf['yoy'] = yoy
    jrf['yoy_years'] = ['2023', '2024', '2025', '2026 YTD']

    return jrf

# ── Design assets (fonts + component CSS extracted verbatim from the approved
#    mockups, so the live dashboard matches what was actually designed) ──────

_ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

def _asset(name):
    with open(os.path.join(_ASSETS_DIR, name)) as f:
        return f.read()

FONTS_CSS = _asset('fonts.css')
RC_CSS    = _asset('rc_system.css')
LOGO_B64  = _asset('logo_base64.txt').strip().split(',', 1)[-1]
LABOR_ICONS_TEMPLATE = _asset('labor_icons_template.html')

def build_labor_fun_stats(pr):
    """The Employment Mix icon row (person/clock/$/gender/brand-ink icons)
    extracted verbatim from the approved mockup, with live values swapped in."""
    html = LABOR_ICONS_TEMPLATE
    for token, val in [
        ('__TOTAL_ACTIVE__', pr['total']),
        ('__FT__', pr['ft']), ('__PT__', pr['pt']),
        ('__SALARY__', pr['salary']), ('__HOURLY__', pr['hourly']),
        ('__MALE__', pr['male']), ('__FEMALE__', pr['female']),
        ('__BRAND__', pr['brand']), ('__INK__', pr['ink']),
    ]:
        html = html.replace(token, str(val))
    return html

EXTRA_CSS = '''
*{box-sizing:border-box}
.tab-panel{display:none}
.tab-panel.active{display:block}
.chart-wrap{position:relative;width:100%}
.rc-card{overflow-x:auto}
.rc-expand-btn{
  position:absolute;top:0;right:0;background:transparent;cursor:pointer;
  border:1px solid var(--surface-alt);border-radius:4px;padding:4px 10px;
  font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--ink);
}
.rc-expand-btn:hover{background:var(--surface)}
.chart-modal-overlay{
  display:none;position:fixed;inset:0;background:rgba(20,26,29,.6);
  z-index:1000;align-items:center;justify-content:center;padding:24px;
}
.chart-modal-overlay.open{display:flex}
.chart-modal-content{
  background:#fff;border-radius:8px;width:min(1400px,95vw);height:min(820px,90vh);
  display:flex;flex-direction:column;padding:20px 24px;
}
.chart-modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-shrink:0}
.chart-modal-title{font-family:var(--display);font-weight:700;font-size:18px;color:#252933}
.chart-modal-actions{display:flex;gap:8px;align-items:center}
.chart-modal-actions button{
  border:1px solid var(--surface-alt);border-radius:4px;background:#fff;cursor:pointer;
  padding:6px 14px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink);
}
.chart-modal-actions button:hover{background:var(--surface)}
.chart-modal-close{font-size:16px;line-height:1;padding:6px 10px !important}
.chart-modal-canvas-wrap{flex:1;position:relative;min-height:0}
'''

# ── rc- component helpers ────────────────────────────────────────────────────

def rc_stat(label, value, cls=''):
    c = ' ' + cls if cls else ''
    return ('<div class="rc-stat"><span class="rc-stat-label">' + label + '</span>'
            '<span class="rc-stat-val' + c + '">' + value + '</span></div>')

def rc_box(group_label, plan_val, act_lbl, act_val, var_val, var_cls):
    return ('<div class="rc-box"><div class="rc-group-label">' + group_label + '</div>'
            '<div class="rc-row">'
            + rc_stat('Plan', plan_val) + rc_stat(act_lbl, act_val) + rc_stat('Variance', var_val, var_cls)
            + '</div></div>')

def var_cls(v, favorable_if_below=False):
    good = (v <= 0) if favorable_if_below else (v >= 0)
    return 'pos' if good else 'neg'

def rc_card_kpi(title, cum, full, favorable_if_below=False, desc=None, body_extra='', trend=None):
    """cum/full = (plan, actual_or_proj, var). favorable_if_below flips the
    variance color convention for cost lines (Labor, OpEx-style spend).
    trend, if given, is a seasonality-adjusted full-year projection (see
    seasonal_ann_proj) shown as a third box alongside the plan-based one."""
    cum_plan, cum_act, cum_var = cum
    full_plan, full_proj, full_var = full
    trend_box = ''
    if trend is not None:
        trend_var = trend - full_plan
        trend_box = rc_box('Trend (Seasonality-Adj.)', fk(full_plan), 'Trend Proj.', fk(trend),
                            vk(trend_var), var_cls(trend_var, favorable_if_below))
    return (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">' + title + '</div>'
        + ('<div class="rc-desc">' + desc + '</div>' if desc else '') +
        '</div>'
        '<div class="rc-boxrow">'
        + rc_box('Cumulative to Date', fk(cum_plan), 'Actual', fk(cum_act), vk(cum_var), var_cls(cum_var, favorable_if_below))
        + rc_box('Full Year', fk(full_plan), 'Projection', fk(full_proj), vk(full_var), var_cls(full_var, favorable_if_below))
        + trend_box +
        '</div>'
        + body_extra +
        '</div>\n'
    )

def rc_trend_chart(chart_id, title, desc=None):
    """A 52-week canvas placed under a summary card -- see
    build_summary_trend_charts_js() for the four-line (2025 Actual, 2026
    Plan, 2026 Actual, 2026 Trend) series it renders into this canvas. The
    expand button opens the same chart full-screen via a delegated click
    listener on .rc-expand-btn (see CHART_MODAL_JS) with a PNG download
    option -- data attributes rather than an inline onclick, since the
    title's own double quotes (from embedding it as a JS string) would
    otherwise collide with the HTML attribute's double quotes."""
    return (
        '<div class="rc-card" style="grid-column:1 / -1;position:relative">'
        '<div class="rc-headrow"><div class="rc-name">' + title + '</div>'
        + ('<div class="rc-desc">' + desc + '</div>' if desc else '') +
        '<button class="rc-expand-btn" data-chart-id="' + chart_id + '" data-chart-title="' + html_escape(title) + '">⤢ Expand</button>'
        '</div>'
        '<div style="height:220px"><canvas id="' + chart_id + '"></canvas></div>'
        '</div>\n'
    )

def rc_divider(title):
    return '<div class="rc-divider"><div class="rc-divider-title">' + title + '</div></div>\n'

def rc_hltable(rows, is_cost=False):
    """rows: list of (label, ytd_plan, ytd_act, ann_plan, ann_proj, highlighted).
    Matches the approved design's 5-metric itemized table (Account Line / YTD
    Plan / YTD Actual / YTD Var / Ann. Proj. / Ann. Var — no Ann. Plan column,
    since under the actual+remaining-plan projection model Ann. Var always
    equals YTD Var, so showing both variance columns is the useful pair)."""
    body = ''
    for name, ytd_plan, ytd_act, ann_plan, ann_proj, hl in rows:
        ytd_var = ytd_act - ytd_plan
        ann_var = ann_proj - ann_plan
        star = '<span class="rc-hl-star">&#9733;</span>' if hl else ''
        body += (
            '<tr>'
            '<td>' + star + name + '</td>'
            '<td>' + fk(ytd_plan) + '</td>'
            '<td>' + fk(ytd_act) + '</td>'
            '<td class="' + var_cls(ytd_var, is_cost) + '">' + vk(ytd_var) + '</td>'
            '<td>' + fk(ann_proj) + '</td>'
            '<td class="' + var_cls(ann_var, is_cost) + '">' + vk(ann_var) + '</td>'
            '</tr>\n'
        )
    return (
        '<div class="rc-hl">'
        '<table class="rc-hltable">'
        '<colgroup><col class="rc-hl-col-name">'
        '<col class="rc-hl-col-stat"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat">'
        '<col class="rc-hl-col-stat"><col class="rc-hl-col-stat"></colgroup>'
        '<thead><tr><th>Account Line</th><th>YTD Plan</th><th>YTD Actual</th><th>YTD Var</th>'
        '<th>Ann. Proj.</th><th>Ann. Var</th></tr></thead>'
        '<tbody>' + body + '</tbody>'
        '</table></div>'
    )

def ch_card(name, ytd_act, ytd_plan, ann_plan, ann_proj, trend_proj=None):
    """trend_proj is optional -- omit it for lines with no seasonality curve
    yet (e.g. JRF's category breakdown) and the trend footer is skipped."""
    var = ytd_act - ytd_plan
    cls = var_cls(var)
    pct = max(0, min(100, (ytd_act / ann_proj * 100) if ann_proj else 0))
    trend_row = ''
    if trend_proj is not None:
        trend_var = trend_proj - ann_plan
        trend_cls = var_cls(trend_var)
        trend_row = (
            '<div class="ch-foot ch-trend ' + trend_cls + '">Trend Proj. ' + fk(trend_proj)
            + ' (' + vk(trend_var) + ' vs plan)</div>'
        )
    return (
        '<div class="ch-card">'
        '<div class="ch-name">' + name + '</div>'
        '<div class="ch-value">' + fk(ytd_act) + '</div>'
        '<div class="ch-delta ' + cls + '">' + vk(var) + ' vs plan</div>'
        '<div class="ch-bar"><div class="ch-bar-fill ' + cls + '" style="width:' + f'{pct:.0f}' + '%"></div></div>'
        '<div class="ch-foot">Ann. Proj. ' + fk(ann_proj) + '</div>'
        + trend_row +
        '</div>'
    )

def dept_tile(name, value):
    return (
        '<div class="dept-tile">'
        '<div class="dept-tile-top"><span class="dept-tile-name">' + name + '</span></div>'
        '<div class="dept-tile-val">' + value + '</div>'
        '</div>'
    )

def rc_bignum_card(title, value, sub, sub2=None, sub2_cls='pos'):
    return (
        '<div class="rc-card">'
        '<div class="rc-group-label">' + title + '</div>'
        '<div class="rc-stat-val" style="font-size:26px;margin:6px 0 4px">' + value + '</div>'
        '<div class="rc-desc">' + sub + '</div>'
        + (('<div class="rc-desc ' + sub2_cls + '" style="font-family:var(--mono);margin-top:2px">' + sub2 + '</div>') if sub2 else '')
        + '</div>'
    )

# ── Chart JS ─────────────────────────────────────────────────────────────────

def build_chart_js(d):
    cf     = d['cf']
    labels = '[' + ','.join('"' + l + '"' for l in cf['labels']) + ']'
    cout_tot = [b+i+o+l+e for b,i,o,l,e in zip(cf['cout_b'],cf['cout_i'],cf['cout_o'],cf['cout_l'],cf['cout_e'])]

    return (
        'Chart.defaults.font.family="\'IBM Plex Mono\',monospace";Chart.defaults.font.size=10;\n'
        'const fmtK=v=>{const a=Math.abs(v);'
        'if(a>=1000000)return"$"+(v<0?"−":"")+(a/1000000).toFixed(2)+"M";'
        'if(a>=1000)return"$"+(v<0?"−":"")+(a/1000).toFixed(1)+"K";'
        'return"$"+v.toLocaleString();};\n'
        # Estimated points (a week with no recorded reading, carried forward
        # from the prior week rather than dropped to zero) render as hollow
        # markers instead of solid, and say so in their tooltip.
        'const estNote=c=>(c.raw&&c.raw.e)?" (not recorded — carried fwd)":"";\n'
        'const estStyle=color=>({'
        'pointBackgroundColor:ctx=>(ctx.raw&&ctx.raw.e)?"#fff":color,'
        'pointBorderColor:color,'
        'pointBorderWidth:ctx=>(ctx.raw&&ctx.raw.e)?2:1,'
        'pointRadius:ctx=>(ctx.raw&&ctx.raw.e)?4:3,'
        '});\n'
        'const WKS=' + labels + ';\n'
        '(function(){const el=document.getElementById("cfChart");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:WKS,datasets:['
        '{label:"Cash in", data:' + js_arr(cf['cin_t'])  + ',borderColor:"#2F7A5C",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,pointHoverRadius:5,tension:0.3},'
        '{label:"Cash out",data:' + js_arr(cout_tot)     + ',borderColor:"#B4482F",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,pointHoverRadius:5,tension:0.3},'
        ']},options:{responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:true,position:"top"}},'
        'scales:{x:{grid:{color:"#EDECED"}},y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}'
        '}});})();\n'
        'const HL=Array.from({length:52},(_,i)=>"Wk "+(i+1));\n'
        'const histOpts={responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.parsed.y)+estNote(c)}}},'
        'scales:{x:{type:"category",grid:{color:"#EDECED"},ticks:{maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}};\n'
        '(function(){const el=document.getElementById("invHistCOG");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:HL,datasets:['
        '{label:"2024",data:' + to_xy(d['cog_2024'], d['inv_est']['cog_2024'])   + ',borderColor:"#B0B4B8",backgroundColor:"transparent",borderWidth:2,tension:0.3,parsing:false,...estStyle("#B0B4B8")},'
        '{label:"2025",data:' + to_xy(d['cog_2025'], d['inv_est']['cog_2025'])   + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:2,tension:0.3,parsing:false,...estStyle("#586D72")},'
        '{label:"2026",data:' + to_xy(d['cog_2026'], d['inv_est']['cog_2026'])  + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,tension:0.3,parsing:false,...estStyle("#43575E")},'
        ']},options:histOpts});})();\n'
        '(function(){const el=document.getElementById("invTotUnits");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:HL,datasets:['
        '{label:"2024",data:' + to_xy(d['units_2024'], d['inv_est']['units_2024']) + ',borderColor:"#B0B4B8",backgroundColor:"transparent",borderWidth:2,tension:0.3,parsing:false,...estStyle("#B0B4B8")},'
        '{label:"2025",data:' + to_xy(d['units_2025'], d['inv_est']['units_2025']) + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:2,tension:0.3,parsing:false,...estStyle("#586D72")},'
        '{label:"2026",data:' + to_xy(d['units_2026'], d['inv_est']['units_2026'])+ ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,tension:0.3,parsing:false,...estStyle("#43575E")},'
        ']},options:histOpts});})();\n'
        'const stOpts={responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+c.parsed.y.toFixed(1)+"%"+estNote(c)}}},'
        'scales:{x:{type:"category",grid:{color:"#EDECED"},ticks:{maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},y:{min:0,max:100,grid:{color:"#EDECED"},ticks:{callback:v=>v+"%"}}}};\n'
        'const SL=Array.from({length:52},(_,i)=>"Wk "+(i+1));\n'
        'function mkST(id,ds){const el=document.getElementById(id);if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:SL,datasets:ds.map(d=>{return{label:d.l,data:d.d,'
        'borderColor:d.c,backgroundColor:"transparent",borderWidth:2,tension:0.3,parsing:false,...estStyle(d.c)};})},'
        'options:stOpts});}\n'
        'mkST("invSSSellThru",['
        '{l:"S24",d:' + st_xy(d['st_s24'], d['inv_est']['st_s24']) + ',c:"#B0B4B8"},'
        '{l:"S25",d:' + st_xy(d['st_s25'], d['inv_est']['st_s25']) + ',c:"#586D72"},'
        '{l:"S26",d:' + st_xy(d['st_s26'], d['inv_est']['st_s26']) + ',c:"#43575E"}]);\n'
        'mkST("invFWSellThru",['
        '{l:"F24",d:' + st_xy(d['st_f24'], d['inv_est']['st_f24']) + ',c:"#B0B4B8"},'
        '{l:"F25",d:' + st_xy(d['st_f25'], d['inv_est']['st_f25']) + ',c:"#586D72"},'
        '{l:"F26",d:' + st_xy(d['st_f26'], d['inv_est']['st_f26']) + ',c:"#43575E"}]);\n'
        + build_labor_chart_js(d)
        + build_summary_trend_charts_js(d)
        + build_creditline_chart_js(d)
        + (build_jrf_chart_js(d['jrf']) if d.get('jrf') else '')
    )

def build_summary_trend_charts_js(d):
    """52-week line chart for each Summary card: 2025 Actual (reference),
    2026 Plan, 2026 Actual (solid, stops at the current week), and 2026
    Trend (dashed continuation from the current week to week 52) -- see
    the trend_charts computation in read_all()."""
    tc = d['trend_charts']
    sections = [
        ('chart-trend-revenue',    'revenue'),
        ('chart-trend-cogs',       'cogs'),
        ('chart-trend-opex',       'opex'),
        ('chart-trend-net_income', 'net_income'),
    ]
    # Options are built by a factory function, called fresh for every chart
    # instance (including the modal's) -- Chart.js writes internal resolver
    # state onto whatever options object it's given, so reusing one live
    # instance's already-resolved .options for a second instance breaks it.
    # data.datasets, by contrast, is plain and safe to share by reference
    # (this is Chart.js's own supported pattern for one dataset in multiple
    # charts), so window.__chartData is shared as-is with the modal.
    out = (
        'function sumTrendOpts(){return {responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:true,position:"top"},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.parsed.y)}}},'
        'scales:{x:{type:"category",grid:{color:"#EDECED"},ticks:{maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},'
        'y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}};}\n'
        'window.__chartData=window.__chartData||{};window.__chartOptsFn=window.__chartOptsFn||{};window.__charts=window.__charts||{};\n'
    )
    for chart_id, key in sections:
        s = tc[key]
        out += (
            '(function(){const el=document.getElementById("' + chart_id + '");if(!el)return;'
            'const data={labels:HL,datasets:['
            '{label:"2025 Actual",data:' + trend_xy(s['act_2025'])   + ',borderColor:"#B0B4B8",backgroundColor:"transparent",borderWidth:2,pointRadius:2,tension:0.3,parsing:false},'
            '{label:"2026 Plan",data:'   + trend_xy(s['plan_2026'])  + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:1.5,borderDash:[4,3],pointRadius:0,tension:0.3,parsing:false},'
            '{label:"2026 Actual",data:' + trend_xy(s['act_2026'])   + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,pointRadius:2,tension:0.3,parsing:false},'
            '{label:"2026 Trend",data:'  + trend_xy(s['trend_2026']) + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,borderDash:[6,4],pointRadius:0,tension:0.3,parsing:false},'
            ']};'
            'window.__chartData["' + chart_id + '"]=data;window.__chartOptsFn["' + chart_id + '"]=sumTrendOpts;'
            'window.__charts["' + chart_id + '"]=new Chart(el,{type:"line",data:data,options:sumTrendOpts()});})();\n'
        )
    return out

def build_creditline_chart_js(d):
    """Monthly Line-of-Credit balance: 2025 Actual (certified monthly,
    prior-year reference), 2026 Plan (the original static full-year plan,
    never revised), 2026 Actual (certified through the latest month,
    solid), and 2026 Trend (dashed continuation using the plan's remaining
    months, anchored at the last certified balance) -- same convention as
    the Summary tab's 52-week trend charts, just monthly instead of weekly."""
    labels_py = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    labels_js = '[' + ','.join('"' + l + '"' for l in labels_py) + ']'
    def mxy(arr):
        return '[' + ','.join('{x:"' + labels_py[i] + '",y:' + repr(round(float(v), 2)) + '}'
                               for i, v in enumerate(arr) if v is not None) + ']'
    return (
        'function locChartOpts(){return {responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:true,position:"top"},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.parsed.y)}}},'
        'scales:{x:{type:"category",grid:{color:"#EDECED"}},y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}};}\n'
        'window.__chartData=window.__chartData||{};window.__chartOptsFn=window.__chartOptsFn||{};window.__charts=window.__charts||{};\n'
        '(function(){const el=document.getElementById("chart-loc-balance");if(!el)return;'
        'const data={labels:' + labels_js + ',datasets:['
        '{label:"2025 Actual",data:' + mxy(d['loc_2025'])       + ',borderColor:"#B0B4B8",backgroundColor:"transparent",borderWidth:2,pointRadius:2,tension:0.3,parsing:false},'
        '{label:"2026 Plan",data:'   + mxy(d['loc_plan_bom'])   + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:1.5,borderDash:[4,3],pointRadius:0,tension:0.3,parsing:false},'
        '{label:"2026 Actual",data:' + mxy(d['loc_2026_act'])   + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,pointRadius:2,tension:0.3,parsing:false},'
        '{label:"2026 Trend",data:'  + mxy(d['loc_2026_trend']) + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,borderDash:[6,4],pointRadius:0,tension:0.3,parsing:false},'
        ']};'
        'window.__chartData["chart-loc-balance"]=data;window.__chartOptsFn["chart-loc-balance"]=locChartOpts;'
        'window.__charts["chart-loc-balance"]=new Chart(el,{type:"line",data:data,options:locChartOpts()});})();\n'
    )

def build_labor_chart_js(d):
    months = d['labor_total']['months']
    mon_labels = '[' + ','.join('"' + m + '"' for m,_,_ in months) + ']'
    plan_arr   = js_arr([round(p) for _,p,_ in months])
    act_arr    = '[' + ','.join(('null' if a is None else str(round(a))) for _,_,a in months) + ']'
    payroll    = d['payroll']
    ot_labels  = '[' + ','.join('"Wk ' + str(p['wk']) + '"' for p in payroll) + ']'
    ot_amt     = js_arr([round(p['ot_amount']) for p in payroll])
    ot_hrs     = js_arr([round(p['ot_hours'],1) for p in payroll])
    return (
        '(function(){const el=document.getElementById("laborMonthly");if(!el)return;'
        'new Chart(el,{type:"bar",data:{labels:' + mon_labels + ',datasets:['
        '{label:"Plan",data:' + plan_arr + ',backgroundColor:"#EDECED",borderRadius:3},'
        '{label:"Actual",data:' + act_arr + ',backgroundColor:"#43575E",borderRadius:3},'
        ']},options:{responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:true,position:"top"},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.raw)}}},'
        'scales:{x:{grid:{color:"#EDECED"}},y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}'
        '}});})();\n'
        '(function(){const el=document.getElementById("laborOT");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:' + ot_labels + ',datasets:['
        '{label:"OT $",data:' + ot_amt + ',borderColor:"#B4482F",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,tension:0.3,yAxisID:"y"},'
        '{label:"OT hrs",data:' + ot_hrs + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:1.5,borderDash:[4,3],pointRadius:2,tension:0.3,yAxisID:"y1"},'
        ']},options:{responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:true,position:"top"},tooltip:{callbacks:{label:c=>c.dataset.label+": "+(c.dataset.yAxisID==="y"?fmtK(c.raw):c.raw+"h")}}},'
        'scales:{x:{grid:{color:"#EDECED"}},'
        'y:{position:"left",grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}},'
        'y1:{position:"right",grid:{drawOnChartArea:false},ticks:{callback:v=>v+"h"}}}'
        '}});})();\n'
    )

# ── OpEx panel ───────────────────────────────────────────────────────────────

def build_opex_panel(d):
    opex = d['opex']
    lines = d['opex_lines']
    keys = d['opex_keys']
    cats = d['opex_categories']

    body = rc_card_kpi("Total OpEx",
        (opex['plan'], opex['act'], opex['var']),
        (opex['ann_plan'], opex['ann_proj'], opex['ann_var']), favorable_if_below=True)

    if not cats:
        rows = [(lbl, plan, act, ann, ap, False) for lbl, act, plan, ann, ap in lines]
        body += rc_divider("OpEx by category")
        body += ('<div class="rc-card" style="grid-column:1 / -1">' + rc_hltable(rows, is_cost=True) + '</div>\n')
        return body

    groups = {}
    order = []
    for (lbl, act, plan, ann, ap), key in zip(lines, keys):
        meta = cats.get(key, {})
        cat_name = meta.get('category', 'Uncategorized')
        if cat_name not in groups:
            groups[cat_name] = []
            order.append(cat_name)
        groups[cat_name].append((lbl, act, plan, ann, ap, meta.get('highlight')))

    for cat_name in order:
        rows = [(lbl, plan, act, ann, ap, hl) for lbl, act, plan, ann, ap, hl in groups[cat_name]]
        sub_act  = sum(r[1] for r in groups[cat_name])
        sub_plan = sum(r[2] for r in groups[cat_name])
        sub_ann  = sum(r[3] for r in groups[cat_name])
        sub_ap   = sum(r[4] for r in groups[cat_name])
        body += rc_divider(cat_name)
        body += rc_card_kpi(cat_name,
            (sub_plan, sub_act, sub_act-sub_plan),
            (sub_ann, sub_ap, sub_ap-sub_ann), favorable_if_below=True,
            body_extra=rc_hltable(rows, is_cost=True))

    itemized_act      = sum(l[1] for l in lines)
    itemized_plan     = sum(l[2] for l in lines)
    itemized_ann_plan = sum(l[3] for l in lines)
    itemized_ann_proj = sum(l[4] for l in lines)
    other = (opex['act'] - itemized_act, opex['plan'] - itemized_plan,
             opex['ann_plan'] - itemized_ann_plan, opex['ann_proj'] - itemized_ann_proj)
    if any(abs(v) > 1 for v in other):
        body += rc_divider("Unallocated")
        body += ('<div class="rc-card" style="grid-column:1 / -1">'
                 + rc_hltable([("Other / unallocated OpEx", other[1], other[0], other[2], other[3], False)], is_cost=True)
                 + '</div>\n')
    return body

# ── Cash Flow panel ──────────────────────────────────────────────────────────

def cf_week_cell(v, plan):
    color = 'var(--good)' if v-plan >= 0 else 'var(--watch)'
    return '<td style="color:' + color + '">' + fk(v) + '</td>'

def build_cf_weekly_table(d):
    """Full 52-week cash-collection schedule: actual weeks (through the current week)
    with each channel colored vs. its own weekly plan, followed by the remaining
    weeks shown as a muted plan-only forecast."""
    weekly = d['cf_weekly']; forecast = d['cf_forecast']

    rows = ''
    tot_w=tot_d=tot_i=tot_t=tot_pt=0.0
    for wkr in weekly:
        var_t = wkr['t'] - wkr['pt']
        vcolor = 'var(--good)' if var_t >= 0 else 'var(--watch)'
        tot_w+=wkr['w']; tot_d+=wkr['d']; tot_i+=wkr['i']; tot_t+=wkr['t']; tot_pt+=wkr['pt']
        rows += (
            '<tr>'
            '<td style="text-align:left;font-family:var(--body)">Wk ' + str(wkr['wk']) + '</td>'
            + cf_week_cell(wkr['w'], wkr['pw'])
            + cf_week_cell(wkr['d'], wkr['pd_'])
            + cf_week_cell(wkr['i'], wkr['pi'])
            + '<td style="font-weight:600">' + fk(wkr['t']) + '</td>'
            + '<td style="font-weight:600;color:' + vcolor + '">' + vk(var_t) + '</td>'
            '</tr>\n'
        )
    total_var = tot_t - tot_pt
    tcolor = 'var(--good)' if total_var >= 0 else 'var(--watch)'
    rows += (
        '<tr style="border-top:1.5px solid var(--ink)">'
        '<td style="text-align:left;font-family:var(--body);font-weight:700;border-bottom:none">Total</td>'
        + ''.join('<td style="font-weight:700;border-bottom:none">' + fk(v) + '</td>' for v in (tot_w,tot_d,tot_i,tot_t))
        + '<td style="font-weight:700;color:' + tcolor + ';border-bottom:none">' + vk(total_var) + '</td>'
        '</tr>\n'
    )

    fc_rows = ''
    for wkr in forecast:
        fc_rows += (
            '<tr style="opacity:.55">'
            '<td style="text-align:left;font-family:var(--body)">Wk ' + str(wkr['wk']) + '</td>'
            + ''.join('<td>' + fk(v) + '</td>' for v in (wkr['w'],wkr['d'],wkr['i'],wkr['t']))
            + '<td></td>'
            '</tr>\n'
        )

    return (
        '<div class="rc-hl">'
        '<table class="rc-hltable">'
        '<colgroup><col class="rc-hl-col-name"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat">'
        '<col class="rc-hl-col-stat"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat"></colgroup>'
        '<thead><tr><th>Week</th><th>WHSL</th><th>DTC</th><th>INK</th><th>Total</th><th>Var.</th></tr></thead>\n'
        '<tbody>\n'
        + rows
        + (('<tr><td colspan="6" style="text-align:left;padding-top:12px;font-family:var(--mono);font-size:10px;font-weight:600;'
            'letter-spacing:.08em;text-transform:uppercase;color:var(--ink);opacity:.55;border-bottom:none">Remaining weeks (plan)</td></tr>\n' + fc_rows)
           if forecast else '')
        + '</tbody>\n'
        '</table></div>'
    )

def bp_gap_cell(gap, watch):
    """Colors a reconciliation gap: quiet (near-zero, normal rounding/timing
    noise), ink (real but small), or watch (big enough that it's probably a
    genuine unreconciled transaction or double-entry, not noise)."""
    a = abs(gap)
    color = 'var(--watch)' if a > watch else ('var(--ink)' if a > watch/3 else 'var(--ink)')
    opacity = '' if a > watch else ';opacity:.6'
    return '<td style="color:' + color + opacity + ';font-weight:' + ('700' if a > watch else '600') + '">' + vk(gap) + '</td>'

def build_bank_reconciliation_table(d):
    """Week by week: does 'prior actual balance + true cash in - true cash
    out' land on this week's actually-recorded balance? The two sides come
    from independently-maintained tabs (Xero's GL report vs. online-banking
    balances), so a gap here is a real signal -- an unreconciled transaction
    or a double-entry -- not a modeling artifact, and it's meant to be
    checked every week as new figures are entered, not just once."""
    watch = d['bp_gap_watch']
    rows = ''
    for bp in d['bank_position']:
        has_actual = bp['actual_end'] is not None
        rows += (
            '<tr' + ('' if has_actual else ' style="opacity:.55"') + '>'
            '<td style="text-align:left;font-family:var(--body)">Wk ' + str(bp['wk']) + '</td>'
            '<td>' + fk(bp['start']) + '</td>'
            '<td style="color:var(--good)">' + fk(bp['cash_in']) + '</td>'
            '<td style="color:var(--watch)">' + fk(bp['cash_out']) + '</td>'
            '<td>' + fk(bp['computed_end']) + '</td>'
            '<td style="font-weight:600">' + (fk(bp['actual_end']) if has_actual else '—') + '</td>'
            + (bp_gap_cell(bp['gap'], watch) if bp['gap'] is not None else '<td>—</td>')
            + '</tr>\n'
        )
    return (
        '<div class="rc-hl">'
        '<table class="rc-hltable">'
        '<colgroup><col class="rc-hl-col-name"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat">'
        '<col class="rc-hl-col-stat"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat"></colgroup>'
        '<thead><tr><th>Week</th><th>Start Bal.</th><th>Cash In</th><th>Cash Out</th>'
        '<th>Computed End</th><th>Actual End</th><th>Gap</th></tr></thead>\n'
        '<tbody>\n' + rows + '</tbody>\n'
        '</table></div>'
    )

def bridge_row(label, plan_amt, trend_amt, plan_bal, trend_bal,
               bold=False, indent=False, plan_cls='', trend_cls=''):
    """One row of the Cash Bridge table. Amounts/balances are already-
    formatted strings (or '' to leave a cell blank) -- callers pass
    vk()/fk() output so the sign convention (running total vs. this line's
    delta) stays explicit at the call site instead of being inferred here.
    Plan and Trend run as two parallel columns throughout, converging into
    a range at the final row rather than a single blended number."""
    label_style = 'padding-left:20px;opacity:.7' if indent else ''
    weight = 'font-weight:700' if bold else ''
    top = 'border-top:1.5px solid var(--ink)' if bold else ''
    return (
        '<tr style="' + top + '">'
        '<td style="' + label_style + ';' + weight + '">' + label + '</td>'
        '<td class="' + plan_cls + '" style="' + weight + '">' + plan_amt + '</td>'
        '<td class="' + trend_cls + '" style="' + weight + '">' + trend_amt + '</td>'
        '<td style="' + weight + '">' + plan_bal + '</td>'
        '<td style="' + weight + '">' + trend_bal + '</td>'
        '</tr>\n'
    )

def build_cash_bridge(d):
    """The plain-English question this page exists to answer: starting from
    cash in the bank today, what do we still expect in and out through Dec
    31, and where does that leave the credit line? Two parallel tracks run
    side by side rather than one blended number, because a single figure
    hides how much of it is "if everything goes exactly to budget" vs.
    "based on what's actually happening":

    - Plan: the 2026 Budget tab's own remaining-plan totals (ann_plan minus
      cumulative plan-to-date, the same actual+remaining-plan convention
      used throughout this dashboard) -- the original budget, untouched.
    - Trend: grounded in live, bottom-up signals instead of the budget's
      assumed pace --
        * Wholesale cash in uses the On Order backlog (orders placed but
          not yet invoiced, so not yet in A/R -- see the On Order sheet)
          rather than a pace extrapolation, since a lumpy backlog wouldn't
          show up in a flat continuation of past weekly pace anyway.
        * INK and DTC cash in extrapolate current actual weekly pace
          forward (no on-order/A/R equivalent exists for either yet).
        * COGS - Brand cash out swaps in the live A/P - CNS balance (same
          swap already proven out in Paydown Feasibility) instead of a
          pace extrapolation; COGS - INK, Other COGS, Labor, and OpEx all
          extrapolate current actual cash-out pace.
        * The planned credit-line paydown schedule is a fixed commitment,
          not a forecast -- it's subtracted the same way from both tracks,
          so the range shows whether either one can actually support it.

    A/R (Brand & INK, <90 days) isn't in the Trend track yet -- it's
    tracked weekly on the Ledger's BANK tab, but currently only as
    per-invoice attachments, not a pullable figure. Once it's in the XL
    sheet it belongs here narrowing the Wholesale/INK trend lines (it's
    more concrete than a pace extrapolation), not as an addition on top of
    On Order (On Order is pre-invoice backlog; A/R is post-invoice -- the
    two are non-overlapping dollars, so summing them is safe once both
    exist)."""
    bp = d.get('bank_position')
    if not bp:
        return ''
    latest = d['bp_latest']
    cash_on_hand = latest['actual_end'] if latest['actual_end'] is not None else latest['computed_end']

    WK = d['week']
    remaining_weeks = 52 - WK
    cf = d['cf']
    def p(k): return cf[k][-1] if cf[k] else 0
    def pace(k):
        """Extrapolate this cash-flow-tracker category's actual pace to
        date over the remaining weeks -- a flat continuation, not a
        seasonality curve, so it's directly comparable to the Plan track's
        own remaining-plan figure."""
        return (p(k) / WK) * remaining_weeks if WK else 0.0

    ann_plan = d['cf_ann_plan']
    rem_whsl_plan = ann_plan['w'] - p('proj_w')
    rem_dtc_plan  = ann_plan['d'] - p('proj_d')
    rem_ink_plan  = ann_plan['i'] - p('proj_i')
    rem_in_plan   = rem_whsl_plan + rem_dtc_plan + rem_ink_plan

    on_order_backlog = d['on_order']['h1'] + d['on_order']['h2']
    rem_whsl_trend = on_order_backlog
    rem_dtc_trend  = pace('cin_d')
    rem_ink_trend  = pace('cin_i')
    rem_in_trend   = rem_whsl_trend + rem_dtc_trend + rem_ink_trend

    rem_cogs_plan  = d['cogs']['ann_plan']  - d['cogs']['plan']
    rem_labor_plan = d['labor_total']['ann_plan'] - d['labor_total']['ytd_plan']
    rem_opex_plan  = d['opex']['ann_plan']  - d['opex']['plan']
    rem_out_plan   = rem_cogs_plan + rem_labor_plan + rem_opex_plan

    ap = d.get('ap_cns')
    cogs_brand_trend = ap['total'] if ap else pace('cout_b')
    rem_cogs_trend  = cogs_brand_trend + pace('cout_i') + pace('cout_o')
    rem_labor_trend = pace('cout_l')
    rem_opex_trend  = pace('cout_e')
    rem_out_trend   = rem_cogs_trend + rem_labor_trend + rem_opex_trend

    plan_bal1  = cash_on_hand + rem_in_plan
    trend_bal1 = cash_on_hand + rem_in_trend
    plan_bal2  = plan_bal1  - rem_out_plan
    trend_bal2 = trend_bal1 - rem_out_trend

    n_elapsed = d['loc_n_elapsed']
    remaining_months = d['loc_plan_monthly'][n_elapsed:]
    rem_paydown = sum(m['paydown'] for m in remaining_months)
    rem_draw    = sum(m['draw']    for m in remaining_months)
    plan_final  = plan_bal2  - rem_paydown + rem_draw
    trend_final = trend_bal2 - rem_paydown + rem_draw

    rows = bridge_row('Cash on Hand (Today)', '—', '—', fk(cash_on_hand), fk(cash_on_hand), bold=True)
    rows += bridge_row('Wholesale', fk(rem_whsl_plan), fk(rem_whsl_trend), '', '', indent=True)
    rows += bridge_row('DTC', fk(rem_dtc_plan), fk(rem_dtc_trend), '', '', indent=True)
    rows += bridge_row('INK', fk(rem_ink_plan), fk(rem_ink_trend), '', '', indent=True)
    rows += bridge_row('+ Expected Cash In (Remaining Weeks)', vk(rem_in_plan), vk(rem_in_trend),
                        fk(plan_bal1), fk(trend_bal1), bold=True, plan_cls='pos', trend_cls='pos')
    rows += bridge_row('COGS', fk(rem_cogs_plan), fk(rem_cogs_trend), '', '', indent=True)
    rows += bridge_row('Labor', fk(rem_labor_plan), fk(rem_labor_trend), '', '', indent=True)
    rows += bridge_row('OpEx', fk(rem_opex_plan), fk(rem_opex_trend), '', '', indent=True)
    rows += bridge_row('&minus; Expected Cash Out (Remaining Weeks)', vk(-rem_out_plan), vk(-rem_out_trend),
                        fk(plan_bal2), fk(trend_bal2), bold=True, plan_cls='neg', trend_cls='neg')
    rows += bridge_row('= Cash Before Credit Line Activity', '', '', fk(plan_bal2), fk(trend_bal2), bold=True)
    if rem_draw:
        rows += bridge_row('+ Planned Credit Line Draw (Remaining)', vk(rem_draw), vk(rem_draw),
                            fk(plan_bal2 + rem_draw), fk(trend_bal2 + rem_draw),
                            bold=True, plan_cls='pos', trend_cls='pos')
    rows += bridge_row('&minus; Planned Credit Line Paydown (Remaining)', vk(-rem_paydown), vk(-rem_paydown),
                        fk(plan_final), fk(trend_final), bold=True, plan_cls='neg', trend_cls='neg')
    rows += bridge_row('= Projected Cash at Year-End', '', '', fk(plan_final), fk(trend_final), bold=True)

    notes = (
        '<div class="rc-desc" style="margin-top:10px">'
        '<strong>Trend &mdash; Wholesale</strong> is the known On Order backlog only (' + fk(on_order_backlog) +
        ') &mdash; a conservative floor, not a forecast of new orders still to be booked and invoiced between '
        'now and Dec 31. The real number is likely higher; this deliberately doesn\'t guess by how much.</div>'
    )
    if not ap:
        notes += ('<div class="rc-desc" style="margin-top:10px">'
                   '<strong>Trend COGS &mdash; Brand</strong> is a pace extrapolation, not the live A/P - CNS '
                   'balance &mdash; no <code>AIRTABLE_API_KEY</code> configured for this build.</div>')
    notes += ('<div class="rc-desc" style="margin-top:6px">'
               '<strong>A/R &mdash; Brand &amp; INK (not yet in the Trend track):</strong> tracked weekly on the '
               'Ledger\'s BANK tab (&lt;90 / 90+ days), but currently only as per-invoice attachments &mdash; '
               'not yet a pullable weekly figure. Once it is, it narrows the Wholesale/INK trend lines above '
               '(it\'s post-invoice, non-overlapping with the pre-invoice On Order backlog already included).</div>')

    lo, hi = (plan_final, trend_final) if plan_final <= trend_final else (trend_final, plan_final)
    cls = 'pos' if lo >= 0 else ('neg' if hi < 0 else '')
    subhead = ('Cash on hand today, plus everything still expected in and out through Dec 31, lands '
               'somewhere between ' + fk(lo) + ' and ' + fk(hi) + ' after the planned credit-line paydown' +
               (' and draw' if rem_draw else '') + ', depending on whether the year plays out closer to plan '
               'or to current trend.')

    return (
        rc_divider("Cash Bridge to Year-End")
        + '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Cash on Hand &rarr; Expected In/Out &rarr; Credit Line &rarr; Year-End</div></div>'
        '<div class="rc-subhead ' + cls + '">' + subhead + '</div>'
        '<div class="rc-hl"><table class="rc-hltable">'
        '<colgroup><col style="width:36%"><col style="width:16%"><col style="width:16%">'
        '<col style="width:16%"><col style="width:16%"></colgroup>'
        '<thead><tr><th>Line</th><th>Plan</th><th>Trend</th><th>Bal. (Plan)</th><th>Bal. (Trend)</th></tr></thead>'
        '<tbody>' + rows + '</tbody>'
        '</table></div>'
        + notes +
        '</div>\n'
    )

def build_bank_position_section(d):
    """Ground-truth cash position, built from the actual bank ledger (Cash
    Flow - Weekly / Bank Balance) rather than the plan-modeled Cash Flow -
    Tracker below it -- see the read_all() comment for why the two tabs
    cross-check each other. Returns '' if those tabs aren't populated yet
    (e.g. a very early-year build), so an incomplete data entry doesn't
    break the page."""
    bp = d.get('bank_position')
    if not bp:
        return ''
    latest = d['bp_latest']
    ytd = d['bp_ytd']
    current_balance = latest['actual_end'] if latest['actual_end'] is not None else latest['computed_end']
    accts = latest.get('accts')
    accts_sub = (('Columbia ' + fk(accts['columbia']) + ' · BOA ' + fk(accts['boa'])
                  + (' · RAMP ' + fk(accts['ramp']) if accts['ramp'] else ''))
                 if accts else None)

    body = rc_divider("Cash Position — Actual (Bank Ledger)")
    body += (
        '<div class="rc-desc" style="grid-column:1 / -1;margin-bottom:2px">'
        'Pulled straight from the bank ledger, not the plan below -- Xero\'s General Ledger Report for '
        'true weekly cash in/out, cross-checked every week against the banks\' own recorded balances.'
        '</div>\n'
    )
    body += rc_bignum_card('Starting Balance', fk(d['bp_year_start']), 'Jan 1, 2026 (carried in from Dec 2025)')
    body += rc_bignum_card('True Cash In (YTD)', fk(ytd['cash_in']), 'All credits, both bank accounts — Wk 1–' + str(latest['wk']))
    body += rc_bignum_card('True Cash Out (YTD)', fk(ytd['cash_out']), 'All debits, incl. credit-card payments & CL paydowns')
    body += rc_bignum_card('Current Balance', fk(current_balance),
                            'As of Week ' + str(latest['wk']) + (' (recorded)' if latest['actual_end'] is not None else ' (computed — not yet recorded)'),
                            sub2=accts_sub, sub2_cls='')

    n_flags = len(d['bp_flags'])
    if n_flags:
        recon_desc = (str(n_flags) + ' of ' + str(len(bp)) + ' weeks show a gap over ' + fk(d['bp_gap_watch']) +
                      ' between the computed and recorded ending balance — worth a look next time the '
                      'Accounting Manager reconciles the accounts.')
        recon_cls = 'neg'
    else:
        recon_desc = 'Every week so far reconciles within ' + fk(d['bp_gap_watch']) + '.'
        recon_cls = 'pos'
    body += rc_divider("Weekly Bank Reconciliation")
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Computed vs. Recorded Ending Balance</div></div>'
        '<div class="rc-subhead ' + recon_cls + '">' + recon_desc + '</div>'
        + build_bank_reconciliation_table(d) +
        '</div>\n'
    )
    return body

def build_loc_plan_table(d):
    """2026 monthly credit-line schedule from the original static plan:
    draws, paydowns, and resulting balance, Jan through Dec. Months already
    certified (see loc_n_elapsed) render normally; remaining months render
    muted, same convention as the weekly cash-collection schedule's
    forecast rows."""
    n_elapsed = d['loc_n_elapsed']
    rows = ''
    for i, m in enumerate(d['loc_plan_monthly']):
        muted = ' style="opacity:.55"' if i >= n_elapsed else ''
        rows += (
            '<tr' + muted + '>'
            '<td style="text-align:left;font-family:var(--body)">' + m['month'].title() + '</td>'
            '<td>' + fk(m['bom']) + '</td>'
            '<td>' + (fk(m['draw']) if m['draw'] else '—') + '</td>'
            '<td style="color:' + ('var(--good)' if m['paydown'] else 'var(--ink)') + '">'
            + (fk(m['paydown']) if m['paydown'] else '—') + '</td>'
            '<td style="font-weight:600">' + fk(m['eom']) + '</td>'
            '</tr>\n'
        )
    year_draw = sum(m['draw'] for m in d['loc_plan_monthly'])
    year_pay  = sum(m['paydown'] for m in d['loc_plan_monthly'])
    eoy       = d['loc_plan_monthly'][-1]['eom']
    rows += (
        '<tr style="border-top:1.5px solid var(--ink)">'
        '<td style="text-align:left;font-family:var(--body);font-weight:700;border-bottom:none">Full-Year Plan</td>'
        '<td style="font-weight:700;border-bottom:none">' + fk(d['loc_plan_monthly'][0]['bom']) + '</td>'
        '<td style="font-weight:700;border-bottom:none">' + fk(year_draw) + '</td>'
        '<td style="font-weight:700;color:var(--good);border-bottom:none">' + fk(year_pay) + '</td>'
        '<td style="font-weight:700;border-bottom:none">' + fk(eoy) + '</td>'
        '</tr>\n'
    )
    return (
        '<div class="rc-hl">'
        '<table class="rc-hltable">'
        '<colgroup><col class="rc-hl-col-name"><col class="rc-hl-col-stat">'
        '<col class="rc-hl-col-stat"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat"></colgroup>'
        '<thead><tr><th>Month</th><th>Balance (BOM)</th><th>Draws</th><th>Paydowns</th><th>Balance (EOM)</th></tr></thead>\n'
        '<tbody>\n' + rows + '</tbody>\n'
        '</table></div>'
    )

def build_paydown_feasibility(d):
    """Will current-pace cash generation actually cover the planned
    paydown? The naive version of this (net a plan-based cash-flow
    projection against known A/P) double-counts: COGS - Brand alone
    accounts for essentially all of the YTD "ahead of plan" cash-flow
    variance (it's -128% of it -- Cash In is actually running behind plan,
    and every other cost category is a rounding error), and that
    favorability is exactly the same phenomenon as the A/P backlog -- cash
    that "looks" available only because vendor invoices haven't been paid.
    Extrapolating that variance forward as a "trend" would double the same
    dollars: once via the trend, again via subtracting A/P.

    So instead of netting a generic cash-flow projection against A/P, this
    swaps out the *plan's* COGS - Brand assumption for the *live* A/P - CNS
    total (the more reliable, bottom-up source for exactly that one
    category) and only trend-extrapolates the genuine signal in the
    remaining categories (Cash In pace + Labor/OpEx/COGS-INK/Other
    COGS+Shipping, where the combined variance is negligible either way).
    Returns '' if the A/P feed isn't available (no Airtable token) or the
    credit line hasn't been certified yet this year."""
    ap = d.get('ap_cns')
    if not ap or not d['loc_n_elapsed']:
        return ''

    WK = d['week']
    remaining_weeks = 52 - WK
    cf = d['cf_var_pre']
    cfd = d['cf']
    def p(k): return cfd[k][-1] if cfd[k] else 0

    remaining_plan_cf = cf['ann_proj'] - cf['act']  # plan-based cash flow still to come, as everywhere else
    remaining_plan_cogs_brand = d['cf_ann_plan']['b'] - p('proj_b')  # what the plan still expects to pay

    # Swap the plan's COGS - Brand assumption for the live ledger total.
    remaining_plan_cf_adj = remaining_plan_cf + remaining_plan_cogs_brand - ap['total']

    # Trend-extrapolate only the genuine signal: Cash In pace plus the
    # other cost categories, excluding COGS - Brand (already handled above
    # via the live ledger, not a variance extrapolation).
    other_cost_var = sum(p(a) - p(b) for a, b in
                          [('cout_i','proj_i2'), ('cout_o','proj_o'), ('cout_l','proj_l'), ('cout_e','proj_e')])
    genuine_var = d['cash_in']['var'] - other_cost_var
    genuine_rate = (genuine_var / WK) if WK else 0.0
    remaining_trend_cf_adj = remaining_plan_cf_adj + genuine_rate * remaining_weeks

    current_balance = d['loc_2026_act'][d['loc_n_elapsed'] - 1]
    target_balance = d['loc_plan_monthly'][-1]['eom']
    required_paydown = current_balance - target_balance

    gap_plan = remaining_plan_cf_adj - required_paydown
    gap_trend = remaining_trend_cf_adj - required_paydown
    lo_lbl, lo_gap = ('trend-adjusted', gap_trend) if gap_trend <= gap_plan else ('plan-based', gap_plan)
    hi_lbl, hi_gap = ('plan-based', gap_plan) if gap_trend <= gap_plan else ('trend-adjusted', gap_trend)

    if gap_plan >= 0 and gap_trend >= 0:
        verdict = 'Both estimates clear the paydown goal: a cushion of ' + fk(lo_gap) + ' to ' + fk(hi_gap) + '.'
    elif gap_plan < 0 and gap_trend < 0:
        verdict = ('Neither estimate covers the paydown goal: short by ' + fk(abs(hi_gap)) + ' (' + hi_lbl +
                   ') to ' + fk(abs(lo_gap)) + ' (' + lo_lbl + ').')
    else:
        verdict = ('Mixed signal: the ' + hi_lbl + ' estimate clears the goal by ' + fk(hi_gap) +
                   ', but the ' + lo_lbl + ' estimate falls short by ' + fk(abs(lo_gap)) +
                   ' -- treat this as tight, not certain.')

    desc = ('Nets remaining-year Cash In against Labor/OpEx/COGS-INK/Other COGS+Shipping per the original '
             'plan, and against COGS - Brand using the live A/P - CNS ledger (' + fk(ap['total']) +
             ' outstanding -- ' + fk(ap['overdue']) + ' already past due, ' + fk(ap['upcoming']) +
             ' due before year end, as of ' + ap['as_of'] + ') instead of the plan’s own COGS - Brand '
             'assumption, to avoid double-counting the same dollars. The trend estimate only extrapolates '
             'genuine pace (Cash In + the other cost categories) -- not the COGS - Brand variance, which is '
             'a payment-timing artifact, not real performance.')

    return (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Paydown Feasibility</div></div>'
        '<div class="rc-subhead ' + ('pos' if (gap_plan >= 0 and gap_trend >= 0) else 'neg') + '">'
        + verdict + '</div>'
        '<div class="rc-desc" style="margin:8px 0 14px">' + desc + '</div>'
        '<div class="rc-boxrow">'
        '<div class="rc-box"><div class="rc-group-label">Required Paydown</div><div class="rc-row">'
        + rc_stat('Current Balance', fk(current_balance))
        + rc_stat('Year-End Target', fk(target_balance))
        + rc_stat('To Pay Down', fk(required_paydown))
        + '</div></div>'
        '<div class="rc-box"><div class="rc-group-label">COGS &mdash; Brand: Plan vs. Live A/P</div><div class="rc-row">'
        + rc_stat('Plan Still Assumes', fk(remaining_plan_cogs_brand))
        + rc_stat('Live A/P (CNS)', fk(ap['total']))
        + rc_stat('Gap', vk(ap['total'] - remaining_plan_cogs_brand), 'neg' if ap['total'] > remaining_plan_cogs_brand else 'pos')
        + '</div></div>'
        '</div>'
        '<div class="rc-boxrow">'
        '<div class="rc-box"><div class="rc-group-label">Cash Still to Come (thru Dec 31, COGS-Brand via live A/P)</div><div class="rc-row">'
        + rc_stat('Plan-Based', fk(remaining_plan_cf_adj))
        + rc_stat('Trend-Adjusted', fk(remaining_trend_cf_adj))
        + '</div></div>'
        '<div class="rc-box"><div class="rc-group-label">Net vs. Paydown Goal</div><div class="rc-row">'
        + rc_stat('Plan-Based', vk(gap_plan), var_cls(gap_plan))
        + rc_stat('Trend-Adjusted', vk(gap_trend), var_cls(gap_trend))
        + '</div></div>'
        '</div>'
        '</div>\n'
    )

def build_cashflow_panel(d):
    cf = d['cf']
    def p(k): return cf[k][-1] if cf[k] else 0

    body = build_cash_bridge(d)
    body += build_bank_position_section(d)

    body += rc_divider("Cash Flow vs. Plan (Cash Flow - Tracker)")
    body += (
        '<div class="rc-desc" style="grid-column:1 / -1;margin-bottom:2px">'
        'Everything below models cash by channel/category against the original weekly plan -- useful for '
        'seeing where collections and payments are running ahead or behind, but plan-based rather than a '
        'direct read of the bank ledger above.'
        '</div>\n'
    )
    body += rc_card_kpi("Total Cash In",
        (d['cash_in']['plan'], d['cash_in']['act'], d['cash_in']['var']),
        (d['cash_in']['ann_plan'], d['cash_in']['ann_proj'], d['cash_in']['ann_var']))
    body += rc_card_kpi("Total Cash Out",
        (d['cash_out']['plan'], d['cash_out']['act'], d['cash_out']['var']),
        (d['cash_out']['ann_plan'], d['cash_out']['ann_proj'], d['cash_out']['ann_var']))
    body += rc_card_kpi("Net Cash Flow (Before Borrowing)",
        (d['cf_var_pre']['plan'], d['cf_var_pre']['act'], d['cf_var_pre']['var']),
        (d['cf_var_pre']['ann_plan'], d['cf_var_pre']['ann_proj'], d['cf_var_pre']['ann_var']))
    body += rc_card_kpi("Net Cash Flow (After Borrowing)",
        (d['cf_var_post']['plan'], d['cf_var_post']['act'], d['cf_var_post']['var']),
        (d['cf_var_post']['ann_plan'], d['cf_var_post']['ann_proj'], d['cf_var_post']['ann_var']))
    body += rc_card_kpi("Total Credit Line Borrowing",
        (d['credit_line']['plan'], d['credit_line']['act'], d['credit_line']['var']),
        (d['credit_line']['ann_plan'], d['credit_line']['ann_proj'], d['credit_line']['ann_var']),
        desc="The gap between the two cards above — drawn against the line of credit, not repaid.")

    cf_surplus = d['cf_var_pre']['act']
    cf_cls = 'pos' if cf_surplus >= 0 else 'neg'
    subhead = ('Through Week ' + str(d['week']) + ', cumulative cash in is ' + fk(d['cash_in']['act']) +
               ' vs. cumulative cash out of ' + fk(d['cash_out']['act']) + ' — a ' + fk(abs(cf_surplus)) +
               (' surplus' if cf_surplus >= 0 else ' deficit') + ' before borrowing.')

    body += rc_divider("Cumulative Trend — Weekly")
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Cash In vs. Cash Out — Cumulative by Week</div></div>'
        '<div class="rc-subhead ' + cf_cls + '">' + subhead + '</div>'
        '<div class="rc-chart chart-wrap" style="height:220px;margin-top:10px"><canvas id="cfChart"></canvas></div>'
        '</div>\n'
    )

    body += rc_divider("Credit Line")
    loc_status = d.get('loc_status')
    if loc_status:
        loc_desc = ('As of ' + loc_status['month'].title() + " 2026's Borrowing Certificate: "
                    + fk(loc_status['balance']) + ' outstanding. ' + loc_status['status'])
    else:
        loc_desc = None
    body += rc_trend_chart('chart-loc-balance', 'Line of Credit Balance — Monthly', desc=loc_desc)

    n_elapsed = d['loc_n_elapsed']
    year_pay = sum(m['paydown'] for m in d['loc_plan_monthly'])
    eoy = d['loc_plan_monthly'][-1]['eom']
    peak = max(m['eom'] for m in d['loc_plan_monthly'])
    paydown_desc = ('The plan (fixed at the start of the year, not updated since) calls for ' + fk(year_pay) +
                     ' paid down in the back half of the year, bringing the balance from a ' + fk(peak) +
                     ' peak down to ' + fk(eoy) + ' by Dec 31' +
                     ((' — ' + str(12 - n_elapsed) + ' months of that still ahead of us.')
                      if n_elapsed < 12 else '.'))
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">2026 Paydown Plan</div></div>'
        '<div class="rc-subhead">' + paydown_desc + '</div>'
        + build_loc_plan_table(d) +
        '</div>\n'
    )
    body += build_paydown_feasibility(d)

    ann_plan = d['cf_ann_plan']
    body += rc_divider("Cash In by Channel")
    cin_rows = []
    ann_plan_tot = ann_proj_tot = 0.0
    for lbl, act_k, proj_k, ann_key in [("Wholesale",'cin_w','proj_w','w'),("DTC",'cin_d','proj_d','d'),("INK",'cin_i','proj_i','i')]:
        act=p(act_k); prj=p(proj_k)
        ap = ann_plan[ann_key]; aproj = act + (ap - prj)
        ann_plan_tot += ap; ann_proj_tot += aproj
        cin_rows.append((lbl, prj, act, ap, aproj, False))
    cin_act=p('cin_t'); cin_prj=p('proj_w')+p('proj_d')+p('proj_i')
    cin_rows.append(("Total Cash In", cin_prj, cin_act, ann_plan_tot, ann_proj_tot, False))
    body += ('<div class="rc-card" style="grid-column:1 / -1">' + rc_hltable(cin_rows) + '</div>\n')

    body += rc_divider("Weekly Cash Collection Schedule")
    body += ('<div class="rc-card" style="grid-column:1 / -1">' + build_cf_weekly_table(d) + '</div>\n')

    body += rc_divider("Cash Out by Category")
    cout_rows = []
    ann_plan_tot = ann_proj_tot = 0.0
    for lbl, act_k, proj_k, ann_key in [("COGS — Brand",'cout_b','proj_b','b'),("COGS — INK",'cout_i','proj_i2','i2'),("Other COGS + Shipping",'cout_o','proj_o','o'),
                               ("Labor",'cout_l','proj_l','l'),("OpEx + EBIT",'cout_e','proj_e','e')]:
        act=p(act_k); prj=p(proj_k)
        ap = ann_plan[ann_key]; aproj = act + (ap - prj)
        ann_plan_tot += ap; ann_proj_tot += aproj
        cout_rows.append((lbl, prj, act, ap, aproj, False))
    cout_act=p('cout_b')+p('cout_i')+p('cout_o')+p('cout_l')+p('cout_e')
    cout_prj=p('proj_b')+p('proj_i2')+p('proj_o')+p('proj_l')+p('proj_e')
    cout_rows.append(("Total Cash Out", cout_prj, cout_act, ann_plan_tot, ann_proj_tot, False))
    body += ('<div class="rc-card" style="grid-column:1 / -1">' + rc_hltable(cout_rows) + '</div>\n')
    return body

# ── Labor panel ──────────────────────────────────────────────────────────────

DEPT_LABELS = {
    'ink_design':'INK — Design','ink_ops':'INK — Operations','ink_prod':'INK — Production','ink_sales':'INK — Sales',
    'logistics':'Logistics','mkg':'Marketing','prodev':'Product Dev','flagship':'Flagship Store',
    'long_branch':'Long Branch','box_truck':'Box Truck Sales','whsl_sales':'Wholesale Sales','finance':'Finance',
}

def build_labor_panel(d):
    lt=d['labor_total']; li=d['labor_ink']; lb=d['labor_brand']

    body = rc_card_kpi("Total Labor",
        (lt['ytd_plan'],lt['ytd_act'],lt['ytd_var']), (lt['ann_plan'],lt['ann_proj'],lt['ann_var']),
        favorable_if_below=True,
        body_extra='<div class="rc-chart chart-wrap" style="height:200px;margin-top:14px"><canvas id="laborMonthly"></canvas></div>')
    body += rc_card_kpi("Brand Labor", (lb['ytd_plan'],lb['ytd_act'],lb['ytd_var']), (lb['ann_plan'],lb['ann_proj'],lb['ann_var']), favorable_if_below=True)
    body += rc_card_kpi("INK Labor",   (li['ytd_plan'],li['ytd_act'],li['ytd_var']), (li['ann_plan'],li['ann_proj'],li['ann_var']), favorable_if_below=True)

    pr = d['payroll_latest']
    if pr:
        body += rc_divider("Headcount — Pay Period Ending Week " + str(pr['wk']))
        pay_period_label = "Week " + str(pr['wk']) + (" — Pay Date " + pr['pay_date'] if pr['pay_date'] else "")
        body += (
            '<div class="rc-card" style="grid-column:1 / -1">'
            '<div class="rc-headrow"><div class="rc-name">Employment Mix</div></div>'
            '<div class="rc-group-label-fun">' + pay_period_label + '</div>'
            '<div class="rc-row-fun">' + build_labor_fun_stats(pr) + '</div>'
            '</div>\n'
        )
        dept_items = sorted(DEPT_LABELS.items(), key=lambda kv: -pr['depts'][kv[0]])
        dept_tiles = ''.join(dept_tile(lbl, str(pr['depts'][key])) for key, lbl in dept_items)
        body += (
            '<div class="rc-card" style="grid-column:1 / -1">'
            '<div class="dept-group-label">By Department</div>'
            '<div class="dept-grid">' + dept_tiles + '</div>'
            '</div>\n'
        )
        body += rc_divider("Overtime — Hours & Cost per Pay Period")
        ot_rows = ''.join(
            '<tr>'
            '<td style="text-align:left;font-family:var(--body)">' + (p['pay_date'] or ('Wk ' + str(p['wk']))) + '</td>'
            '<td>' + f"{p['ot_hours']:.1f}" + '</td>'
            '<td>' + fk(p['ot_amount']) + '</td>'
            '</tr>\n'
            for p in reversed(d['payroll'])
        )
        body += (
            '<div class="rc-card" style="grid-column:1 / -1">'
            '<div class="rc-chart chart-wrap" style="height:200px"><canvas id="laborOT"></canvas></div>'
            '<div class="rc-hl"><table class="rc-hltable">'
            '<colgroup><col class="rc-hl-col-name"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat"></colgroup>'
            '<thead><tr><th style="text-align:left">Pay Date</th><th>OT Hours</th><th>OT $</th></tr></thead>'
            '<tbody>' + ot_rows + '</tbody>'
            '</table></div>'
            '</div>\n'
        )
    return body

# ── Revenue panel ────────────────────────────────────────────────────────────

def build_revenue_panel(d):
    rev = d['rev']
    body = rc_card_kpi("Total Revenue",
        (rev['plan'], rev['act'], rev['var']), (rev['ann_plan'], rev['ann_proj'], rev['ann_var']),
        trend=d['rev_trend_total'])

    body += rc_divider("Revenue by Channel")
    cards = ''.join(ch_card(lbl, act, plan, ann, ap, tp) for lbl, act, plan, ann, ap, tp in d['rev_lines'])
    body += '<div class="channel-grid" style="grid-column:1 / -1">' + cards + '</div>\n'
    body += (
        '<div class="rc-note" style="grid-column:1 / -1">'
        'Trend Proj. adjusts each channel\'s full-year projection for its own seasonal shape, '
        'instead of assuming a flat pace to plan for the rest of the year. Curves are built from '
        'each channel\'s actual 2025 monthly split — e.g. Flagship Store\'s biggest month last year '
        'was December, not summer, the Mobile Store &amp; Tent pop-up did about a third of its year '
        'in October (the Box Truck warehouse sale), and Long Branch — which opened mid-2025, using '
        'real per-store daily sales from Jetty Hub since its books lumped it into Flagship — peaks '
        'in summer as expected of a shore-town shop.'
        '</div>\n'
    )

    oo = d['on_order']; per = d['on_order_periods']

    body += rc_divider("Open Orders — On Order, Not Yet Shipped or Invoiced")
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">On Order — As of Week ' + str(d['week']) + '</div>'
        '<div class="rc-desc">Retail orders including discounts applied, not yet shipped or invoiced.</div></div>'
        '<div class="rc-boxrow"><div class="rc-box" style="flex:none;min-width:160px">'
        '<div class="rc-group-label">Total On Order</div>'
        '<div class="rc-stat-val" style="font-size:22px;margin-top:2px">' + fk(oo['total']) + '</div>'
        '</div></div>'
        '<div class="dept-group-label">By Category</div>'
        '<div class="dept-grid">' + ''.join(dept_tile(name, fk(amt)) for name, amt in d['on_order_cats']) + '</div>'
        '<div class="dept-group-label">By Half</div>'
        '<div class="dept-grid">'
        + dept_tile('H1 2026', fk(per['h1_2026']))
        + dept_tile('H2 2026', fk(per['h2_2026']))
        + dept_tile('H1 2027', fk(per['h1_2027']))
        + dept_tile('H2 2027', fk(per['h2_2027']))
        + '</div>'
        '</div>\n'
    )

    body += rc_divider("Wholesale — Plan vs. Booked, by Half (2026)")
    gap_rows = []
    for lbl, plan, act, order, proj in [
        ("H1 (Jan – Jun)", d['whsl_h1_plan'], d['whsl_h1_actual'], oo['h1'], d['whsl_h1_proj']),
        ("H2 (Jul – Dec)", d['whsl_h2_plan'], d['whsl_h2_actual'], oo['h2'], d['whsl_h2_proj']),
    ]:
        gap = plan - proj
        gap_cls = 'pos' if gap <= 0 else 'neg'
        gap_rows.append(
            '<tr>'
            '<td style="text-align:left;font-family:var(--body)">' + lbl + '</td>'
            '<td>' + fk(plan) + '</td>'
            '<td>' + fk(act) + '</td>'
            '<td>' + fk(order) + '</td>'
            '<td style="font-weight:600">' + fk(proj) + '</td>'
            '<td class="' + gap_cls + '" style="font-weight:700">' + (vk(-gap) if gap != 0 else '—') + '</td>'
            '</tr>\n'
        )
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Wholesale Gap Analysis</div>'
        '<div class="rc-desc">Projected = shipped/invoiced to date for that half, plus what\'s on order for it. '
        'Gap = plan minus projected — positive means still short of plan, negative means already ahead.</div></div>'
        '<div class="rc-hl"><table class="rc-hltable">'
        '<colgroup><col class="rc-hl-col-name"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat">'
        '<col class="rc-hl-col-stat"><col class="rc-hl-col-stat"><col class="rc-hl-col-stat"></colgroup>'
        '<thead><tr><th style="text-align:left">Half</th><th>Plan</th><th>Actual</th><th>On Order</th><th>Projected</th><th>Gap to Plan</th></tr></thead>'
        '<tbody>' + ''.join(gap_rows) + '</tbody>'
        '</table></div>'
        '</div>\n'
    )
    return body

# ── JRF panel ─────────────────────────────────────────────────────────────────
# Jetty Rock Foundation tracks its own budget in a separate, simpler workbook
# (monthly cadence, no weekly detail, no seasonality curves yet) -- see
# read_jrf(). This panel is only built (and only appears in the nav) when
# that file is present; see build_html.

def build_jrf_panel(jrf):
    as_of = str(jrf['as_of']).replace('As of', '').strip() if jrf['as_of'] else None
    body = (
        '<div class="rc-note" style="grid-column:1 / -1;padding-top:0">'
        'Jetty Rock Foundation tracks its own budget separately, on a monthly cadence'
        + (' — as of ' + as_of + '.' if as_of else '.')
        + '</div>\n'
    )

    body += rc_card_kpi("Total Revenue",
        (jrf['rev']['plan'], jrf['rev']['act'], jrf['rev']['var']),
        (jrf['rev']['ann_plan'], jrf['rev']['ann_proj'], jrf['rev']['ann_var']))
    body += rc_divider("Revenue by Category")
    cards = ''.join(ch_card(name, l['act'], l['plan'], l['ann_plan'], l['ann_proj']) for name, l in jrf['rev_cats'])
    body += '<div class="channel-grid" style="grid-column:1 / -1">' + cards + '</div>\n'

    body += rc_card_kpi("Donations (COGS)",
        (jrf['don']['plan'], jrf['don']['act'], jrf['don']['var']),
        (jrf['don']['ann_plan'], jrf['don']['ann_proj'], jrf['don']['ann_var']), favorable_if_below=True)
    body += rc_divider("Donations by Category")
    cards = ''.join(ch_card(name, l['act'], l['plan'], l['ann_plan'], l['ann_proj']) for name, l in jrf['don_cats'])
    body += '<div class="channel-grid" style="grid-column:1 / -1">' + cards + '</div>\n'

    body += rc_card_kpi("Total OpEx",
        (jrf['opex']['plan'], jrf['opex']['act'], jrf['opex']['var']),
        (jrf['opex']['ann_plan'], jrf['opex']['ann_proj'], jrf['opex']['ann_var']), favorable_if_below=True)
    body += rc_divider("OpEx by Category")
    cards = ''.join(ch_card(name, l['act'], l['plan'], l['ann_plan'], l['ann_proj']) for name, l in jrf['opex_cats'])
    body += '<div class="channel-grid" style="grid-column:1 / -1">' + cards + '</div>\n'

    body += rc_card_kpi("Net Income (Loss)",
        (jrf['net_income']['plan'], jrf['net_income']['act'], jrf['net_income']['var']),
        (jrf['net_income']['ann_plan'], jrf['net_income']['ann_proj'], jrf['net_income']['ann_var']))

    body += rc_divider("Revenue, Donations &amp; OpEx — Year over Year")
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Annual Totals, 2023–2025, vs. 2026 Year to Date</div>'
        '<div class="rc-desc">2026 is a partial year to date, not a full-year figure — expect it to look low.</div></div>'
        '<div class="rc-legend">'
        '<span><i class="swatch" style="background:#B0B4B8"></i>2023</span>'
        '<span><i class="swatch" style="background:#889096"></i>2024</span>'
        '<span><i class="swatch" style="background:#586D72"></i>2025</span>'
        '<span><i class="swatch" style="background:#43575E"></i>2026 YTD</span>'
        '</div>'
        '<div class="rc-chart chart-wrap" style="height:280px;margin-top:8px"><canvas id="jrfYoy"></canvas></div>'
        '</div>\n'
    )

    commit_rows = ''.join(
        '<tr><td style="text-align:left;font-family:var(--body)">' + name + '</td>'
        '<td style="padding-right:16px">' + fk(amt) + '</td>'
        '<td style="text-align:left;font-family:var(--body)">' + (bucket or '—') + '</td></tr>\n'
        for name, amt, bucket in jrf['commitments']
    )
    da = jrf['don_analysis']
    body += rc_divider("Outstanding Donation Commitments")
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-boxrow"><div class="rc-box"><div class="rc-group-label">Donated to Date</div><div class="rc-row">'
        + rc_stat('Donated', fk(da['donated_to_date']))
        + rc_stat('Projected', fk(da['projected']))
        + '</div></div>'
        '<div class="rc-box"><div class="rc-group-label">Commitments</div><div class="rc-row">'
        + rc_stat('Committed', fk(da['committed']))
        + rc_stat('Available to Donate', fk(da['available']))
        + '</div></div></div>'
        '<div class="rc-hl"><table class="rc-hltable">'
        '<colgroup><col class="rc-hl-col-name"><col class="rc-hl-col-stat"><col style="width:54.4%"></colgroup>'
        '<thead><tr><th style="text-align:left">Name</th><th style="padding-right:16px">Amount</th><th style="text-align:left">Bucket</th></tr></thead>'
        '<tbody>' + commit_rows
        + '<tr><td style="text-align:left;font-weight:700;font-family:var(--body)">Total</td>'
        + '<td style="font-weight:700">' + fk(jrf['commitments_total']) + '</td><td></td></tr></tbody>'
        '</table></div>'
        '</div>\n'
    )
    return body

def build_jrf_chart_js(jrf):
    years  = jrf['yoy_years']
    colors = ['#B0B4B8', '#889096', '#586D72', '#43575E']
    metrics = [
        ('Revenue',    jrf['yoy'].get('Total Income', [0,0,0,0])),
        ('Donations',  jrf['yoy'].get('Total Cost of Goods Sold', [0,0,0,0])),
        ('OpEx',       jrf['yoy'].get('Total Operating Expenses', [0,0,0,0])),
        ('Net Income', jrf['yoy'].get('Net Income', [0,0,0,0])),
    ]
    metric_labels = '[' + ','.join('"' + m + '"' for m, _ in metrics) + ']'
    datasets = ''.join(
        '{label:"' + yr + '",data:' + js_arr([round(vals[yi]) for _, vals in metrics]) + ',backgroundColor:"' + color + '",borderRadius:3},'
        for yi, (yr, color) in enumerate(zip(years, colors))
    )
    return (
        '(function(){const el=document.getElementById("jrfYoy");if(!el)return;'
        'new Chart(el,{type:"bar",data:{labels:' + metric_labels + ',datasets:[' + datasets + ']},'
        'options:{responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.raw)}}},'
        'scales:{x:{grid:{color:"#EDECED"}},y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}'
        '}});})();\n'
    )

# ── HTML assembly ─────────────────────────────────────────────────────────────

def sec_label(txt):
    return rc_divider(txt)

def instr_badge(cadence):
    """cadence: 'Weekly' | 'Bi-Weekly' | 'Monthly' -- colored pill matching
    the badge's own cadence so the eye can scan for "what's due this week"
    across sections."""
    cls = {'Weekly': 'weekly', 'Bi-Weekly': 'biweekly', 'Monthly': 'monthly'}[cadence]
    return '<span class="instr-badge instr-badge-' + cls + '">' + cadence + '</span>'

def instr_section(tab_label, cadence, sheet_note, items):
    lis = ''.join('<li>' + it + '</li>' for it in items)
    return (
        rc_divider(tab_label)
        + '<div class="rc-card" style="grid-column:1 / -1">'
        + '<div class="rc-headrow" style="display:flex;align-items:center;gap:10px">'
        + instr_badge(cadence)
        + ('<div class="rc-desc" style="margin:0">' + sheet_note + '</div>' if sheet_note else '')
        + '</div>'
        + '<ul class="instr-list">' + lis + '</ul>'
        + '</div>\n'
    )

def build_instructions_panel(d):
    """First-pass draft, inferred from which workbook tab feeds each
    dashboard section (see read_all()) -- cadences and exact steps are
    guesses about Jeremy's actual process and are meant to be corrected,
    not treated as settled fact."""
    intro = (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Keeping This Dashboard Current</div>'
        '<div class="rc-desc">This is a first-draft checklist, not a confirmed process — the cadence tags '
        '(Weekly / Bi-Weekly / Monthly) and specific steps below are guesses based on which tab in the budget '
        'workbook feeds each dashboard section. Correct anything that’s wrong or missing. One thing that is '
        'confirmed: once you save an edit to the workbook, the site checks for changes every 5 minutes and '
        'rebuilds automatically — there’s no separate publish step.</div></div>'
        '</div>\n'
    )
    sections = (
        instr_section('Revenue', 'Weekly',
            'Feeds the &ldquo;2026 Actual&rdquo; tab.',
            ['Enter this week’s actual revenue by channel (DTC, Wholesale, Screen Printing/INK, etc.).',
             'Reconcile the week’s total against Shopify/QuickBooks (or your source system) before saving.'])
        + instr_section('COGS &amp; Shipping', 'Weekly',
            'Also on the &ldquo;2026 Actual&rdquo; tab — Spring/Summer, Fall/Winter, and Special COGS, plus Brand/Ink Shipping.',
            ['Book this week’s COGS by season (Spring/Summer, Fall/Winter, Special).',
             'Enter Shipping actuals (Brand, Ink) for the week.'])
        + instr_section('Inventory', 'Weekly',
            'Feeds the &ldquo;Inventory&rdquo; and &ldquo;On Order&rdquo; tabs.',
            ['Update the on-hand COG/units snapshot for the week.',
             'Refresh sell-through % figures for the current season.',
             'Add or update any new POs on the &ldquo;On Order&rdquo; tab.'])
        + instr_section('Labor', 'Bi-Weekly',
            'Feeds the &ldquo;Labor&rdquo; and &ldquo;Payroll&rdquo; tabs, aligned to the pay cycle.',
            ['Enter headcount/hours by department for the completed pay period.',
             'Enter payroll cost actuals for the same period.'])
        + instr_section('OpEx', 'Monthly',
            'Feeds the OpEx line items on the &ldquo;2026 Actual&rdquo; tab (plus the optional &ldquo;Categories&rdquo; '
            'tab — see docs/opex-categories-setup.md).',
            ['Enter the month’s actual spend per OpEx line item as bills/invoices are booked.',
             'Add any new line item to the &ldquo;Categories&rdquo; tab so it doesn’t fall into Uncategorized.'])
        + instr_section('Cash Flow', 'Weekly',
            'Feeds the &ldquo;Cash Flow - Tracker&rdquo; tab.',
            ['Enter the week’s actual cash in/out.',
             'Confirm the forward schedule/forecast rows are still current.'])
    )
    return intro + sections

def build_html(d):
    WK  = d['week']
    rev = d['rev']; cogs = d['cogs']; opex = d['opex']; ni = d['net_income']

    # Revenue table (used by nothing now except cogs table below reuses the pattern)
    cogs_rows = [(lbl, plan, act, ann, ap, False) for lbl, act, plan, ann, ap in d['cogs_lines']]

    lw=d['inv_latest_wk']; pending=lw and lw<WK
    pend_note=" (wk " + str(lw) + " shown — wk " + str(WK) + " pending)" if pending else ""
    if lw:
        tc=d['cog_2026'].get(lw,0); tu=d['units_2026'].get(lw,0)
        s26_st=d['st_s26'].get(lw,0) or 0
        s26_py=d['st_s25'].get(lw,None)
        st_diff=round(s26_st-s26_py,1) if s26_py else None
        yoy_c=d['yoy_cog_2025']; yoy_u=d['yoy_units_2025']
        yoy_cog_str = ('+' + fk(tc-yoy_c) + ' vs prior year (+' + f'{(tc-yoy_c)/yoy_c*100:.1f}' + '%)') if yoy_c else ''
        yoy_u_str   = ('+' + f'{tu-yoy_u:,}' + ' units vs prior year (+' + f'{(tu-yoy_u)/yoy_u*100:.1f}' + '%)') if yoy_u else ''
        st_diff_str = ('S26 ' + f'{s26_st:.1f}' + '% — ' + f'{abs(st_diff):.1f}' + 'pts '
                       + ('behind' if st_diff<0 else 'ahead of') + ' S25 at wk ' + str(lw)) if st_diff is not None else ''
        prev_c = d['cog_2026'].get(d['inv_prev_wk'], 0)
        prev_u = d['units_2026'].get(d['inv_prev_wk'], 0)
        delta_c = tc - prev_c
        delta_c_str = ('+' if delta_c>=0 else '') + fk(delta_c) + ' vs prev wk'
    else:
        tc=tu=delta_c=0; yoy_cog_str=yoy_u_str=st_diff_str=delta_c_str=''

    legend_3yr = (
        '<div class="rc-legend">'
        '<span><i class="swatch y24" style="background:#B0B4B8"></i>2024</span>'
        '<span><i class="swatch y25" style="background:#586D72"></i>2025</span>'
        '<span><i class="swatch y26" style="background:#43575E"></i>2026</span>'
        '</div>'
    )

    qtr_wk_pct = WK / 52 * 100
    milestones = [13, 26, 39, 52]
    qtr_names = ['Q1','Q2','Q3','Q4']
    cur_q = min(3, (WK - 1) // 13)
    qtr_labels_html = ''.join(
        '<span class="' + ('done' if i < cur_q else ('current' if i == cur_q else 'upcoming')) + '">' + qtr_names[i] + '</span>'
        for i in range(4)
    )
    milestones_html = ''.join(
        '<div class="qtr-milestone' + (' passed' if WK > mw else '') + '" style="left:' + str(pct) + '%"></div>'
        for mw, pct in zip(milestones, [25, 50, 75, 100])
    )

    CSS = FONTS_CSS + RC_CSS + EXTRA_CSS

    topbar = (
        '<header class="topbar">\n'
        '  <div class="left-group">\n'
        '    <div class="brand">\n'
        '      <img src="data:image/png;base64,' + LOGO_B64 + '">\n'
        '      <div class="divider"></div>\n'
        '      <div><div class="title-main">Strategic Dashboard</div>'
        '<div class="title-sub">2026 · YTD Cumulative</div></div>\n'
        '    </div>\n'
        '    <div class="divider"></div>\n'
        '    <div class="week-pill"><span class="lbl">Thru</span><span class="val">Week ' + str(WK) + '</span><span class="of">of 52</span></div>\n'
        '  </div>\n'
        '  <div class="qtr-timeline">\n'
        '    <div class="qtr-track">\n'
        '      <div class="qtr-fill" style="width:' + f'{qtr_wk_pct:.1f}' + '%"></div>\n'
        + milestones_html +
        '      <div class="qtr-now" style="left:' + f'{qtr_wk_pct:.1f}' + '%" title="Week ' + str(WK) + '"></div>\n'
        '    </div>\n'
        '    <div class="qtr-labels">' + qtr_labels_html + '</div>\n'
        '  </div>\n'
        '</header>\n'
    )

    tabs = (
        '<nav class="tabs">\n'
        '  <div class="tab active" data-panel="summary">Summary</div>\n'
        '  <div class="tab" data-panel="revenue">Revenue</div>\n'
        '  <div class="tab" data-panel="cogs">COGS &amp; Shipping</div>\n'
        '  <div class="tab" data-panel="inventory">Inventory</div>\n'
        '  <div class="tab" data-panel="labor">Labor</div>\n'
        '  <div class="tab" data-panel="opex">OpEx</div>\n'
        '  <div class="tab" data-panel="cashflow">Cash Flow</div>\n'
        + ('  <div class="tab" data-panel="jrf">JRF</div>\n' if d.get('jrf') else '') +
        '  <div class="tab tab-instructions" data-panel="instructions">Instructions</div>\n'
        '</nav>\n'
    )

    trend_chart_desc = (
        "2025 Actual (gray) is last year's cumulative pace for reference. 2026 Trend (dashed) "
        "continues the solid 2026 Actual line from this week forward."
    )
    summary_panel = (
        rc_card_kpi("Total Revenue", (rev['plan'],rev['act'],rev['var']), (rev['ann_plan'],rev['ann_proj'],rev['ann_var']),
            trend=d['rev_trend_total'])
        + rc_trend_chart('chart-trend-revenue', '52-Week Trend — Total Revenue', trend_chart_desc)
        + rc_card_kpi("COGS + Labor + Shipping", (cogs['plan'],cogs['act'],cogs['var']), (cogs['ann_plan'],cogs['ann_proj'],cogs['ann_var']),
            favorable_if_below=True)
        + rc_trend_chart('chart-trend-cogs', '52-Week Trend — COGS + Labor + Shipping', trend_chart_desc)
        + rc_card_kpi("Total OpEx", (opex['plan'],opex['act'],opex['var']), (opex['ann_plan'],opex['ann_proj'],opex['ann_var']),
            favorable_if_below=True)
        + rc_trend_chart('chart-trend-opex', '52-Week Trend — Total OpEx', trend_chart_desc)
        + rc_card_kpi("Net Income", (ni['plan'],ni['act'],ni['var']), (ni['ann_plan'],ni['ann_proj'],ni['ann_var']),
            trend=d['net_income_trend'],
            desc="Trend uses Revenue's seasonality curve; COGS/OpEx use their plan-paced Full Year Projection.")
        + rc_trend_chart('chart-trend-net_income', '52-Week Trend — Net Income', trend_chart_desc)
    )

    cogs_panel = (
        rc_card_kpi("Total COGS + Labor + Shipping",
            (cogs['plan'],cogs['act'],cogs['var']), (cogs['ann_plan'],cogs['ann_proj'],cogs['ann_var']),
            favorable_if_below=True, body_extra=rc_hltable(cogs_rows, is_cost=True))
    )

    avg_unit_cost = (tc / tu) if tu else 0
    note_parts = []
    if delta_c_str: note_parts.append('COG ' + delta_c_str)
    if yoy_cog_str: note_parts.append('COG ' + yoy_cog_str)
    if yoy_u_str:   note_parts.append(yoy_u_str)
    inv_note = ('. '.join(note_parts) + '.') if note_parts else 'No comparison data available.'

    inventory_panel = (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">Inventory Snapshot — Week ' + str(lw or WK) + pend_note + '</div>'
        '<div class="rc-desc">' + inv_note + '</div></div>'
        '<div class="rc-boxrow"><div class="rc-box"><div class="rc-group-label">On Hand</div><div class="rc-row">'
        + rc_stat('Total COG', fk(tc) if tc else '—')
        + rc_stat('Units', format(tu, ',') if tu else '—')
        + rc_stat('Avg Unit Cost', '$' + f'{avg_unit_cost:,.2f}' if tu else '—')
        + '</div></div></div>'
        '</div>\n'
        + rc_divider("Total Inventory COG — Week by Week")
        + '<div class="rc-card" style="grid-column:1 / -1">'
        + '<div class="rc-headrow"><div class="rc-name">' + (yoy_cog_str or ' ') + '</div></div>'
        + legend_3yr
        + '<div class="rc-chart chart-wrap" style="height:260px;margin-top:8px"><canvas id="invHistCOG"></canvas></div>'
        + '</div>\n'
        + rc_divider("Total Units on Hand — Week by Week")
        + '<div class="rc-card" style="grid-column:1 / -1">'
        + '<div class="rc-headrow"><div class="rc-name">' + (yoy_u_str or ' ') + '</div></div>'
        + legend_3yr
        + '<div class="rc-chart chart-wrap" style="height:260px;margin-top:8px"><canvas id="invTotUnits"></canvas></div>'
        + '</div>\n'
        + rc_divider("Spring / Summer Sell-Through % — by Week")
        + '<div class="rc-card" style="grid-column:1 / -1">'
        + '<div class="rc-headrow"><div class="rc-name">' + (st_diff_str or ' ') + '</div></div>'
        + '<div class="rc-legend"><span><i class="swatch" style="background:#B0B4B8"></i>S24</span><span><i class="swatch" style="background:#586D72"></i>S25</span><span><i class="swatch" style="background:#43575E"></i>S26</span></div>'
        + '<div class="rc-chart chart-wrap" style="height:240px;margin-top:8px"><canvas id="invSSSellThru"></canvas></div>'
        + '</div>\n'
        + rc_divider("Fall / Winter Sell-Through % — by Week")
        + '<div class="rc-card" style="grid-column:1 / -1">'
        + '<div class="rc-legend"><span><i class="swatch" style="background:#B0B4B8"></i>F24</span><span><i class="swatch" style="background:#586D72"></i>F25</span><span><i class="swatch" style="background:#43575E"></i>F26</span></div>'
        + '<div class="rc-chart chart-wrap" style="height:240px;margin-top:8px"><canvas id="invFWSellThru"></canvas></div>'
        + '</div>\n'
    )

    def panel(pid, content):
        return '<div class="tab-panel' + (' active' if pid=='summary' else '') + '" id="panel-' + pid + '">\n<div class="rc-grid">\n' + content + '</div>\n</div>\n\n'

    return (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
        '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
        '<title>Jetty Strategic Dashboard 2026 — Week ' + str(WK) + '</title>\n'
        '<style>' + CSS + '</style>\n</head>\n<body>\n'
        '<div class="page">\n\n'
        + topbar + tabs +
        '\n<main class="content">\n'
        + panel('summary', summary_panel)
        + panel('revenue', build_revenue_panel(d))
        + panel('cogs', cogs_panel)
        + panel('inventory', inventory_panel)
        + panel('labor', build_labor_panel(d))
        + panel('opex', build_opex_panel(d))
        + panel('cashflow', build_cashflow_panel(d))
        + (panel('jrf', build_jrf_panel(d['jrf'])) if d.get('jrf') else '')
        + panel('instructions', build_instructions_panel(d))
        + '</main>\n'
        '</div>\n'
        + CHART_MODAL_HTML +
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>\n'
        '<script>\n'
        + build_chart_js(d)
        + '</script>\n'
        '<script>\n'
        + TAB_JS +
        '</script>\n'
        '<script>\n'
        + CHART_MODAL_JS +
        '</script>\n</body>\n</html>'
    )

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Reading data...")
    d = read_all()
    print("Week " + str(d['week']) + " data loaded")
    d['jrf'] = read_jrf()
    print("JRF data loaded" if d['jrf'] else "JRF file not found — skipping JRF tab")
    print("Building dashboard...")
    html = build_html(d)
    os.makedirs("output", exist_ok=True)
    with open("output/index.html", "w") as f:
        f.write(html)
    size = os.path.getsize("output/index.html") / 1024
    print("Done — output/index.html written (" + str(round(size,1)) + " KB)")

    source_modified = os.environ.get("SOURCE_MODIFIED_TIME", "")
    jrf_modified = os.environ.get("JRF_MODIFIED_TIME", "")
    with open("output/meta.json", "w") as f:
        json.dump({"source_modified": source_modified, "jrf_modified": jrf_modified}, f)
    print("Recorded source_modified=" + source_modified + ", jrf_modified=" + jrf_modified + " in output/meta.json")

if __name__ == "__main__":
    main()
