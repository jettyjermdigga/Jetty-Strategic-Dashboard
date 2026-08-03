import os, json
import pandas as pd
import pyxlsb

FP = "data/budget.xlsb"
CATEGORIES_SHEET = "Categories"

# ── Formatters ──────────────────────────────────────────────────────────────

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

def js_arr(lst):
    return '[' + ','.join(str(v) for v in lst) + ']'

def to_xy(d):
    return '[' + ','.join('{x:"Wk ' + str(k) + '",y:' + str(v) + '}' for k,v in sorted(d.items())) + ']'

def st_xy(d):
    return '[' + ','.join('{x:"Wk ' + str(k) + '",y:' + str(v) + '}' for k,v in sorted(d.items()) if v) + ']'

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
    df_a  = pd.read_excel(FP, sheet_name='Actual',              engine='pyxlsb', header=None)
    df_b  = pd.read_excel(FP, sheet_name='Budget',              engine='pyxlsb', header=None)
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
                      ('cash_in',68),('cash_out',75),('cf_var_pre',77),('cf_var_post',81)]:
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
    d['rev_lines'] = [(lbl, get_a(k), get_b(k), get_ann(k), proj(k)) for lbl,k in rev_map]

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

    # Inventory
    cat_cols = {
        'Total':(5,6,None),      'F25':(21,22,23),       'S26':(25,26,27),
        'F26':(29,30,31),        'Starboard':(33,34,35),  'PastSeason':(37,38,39),
        'Misc':(41,42,43),       'JRF':(45,46,47),        'TP2025':(49,50,51),
        'TP2026':(53,54,55),     'Surf3P':(57,58,59),     'Skateboards':(61,62,63),
        'SurfCon':(65,66,67),    'Collab':(69,70,71),     'WhiteWhale':(73,74,75),
    }
    inv = {k: {'cog':[], 'units':[], 'st':[]} for k in cat_cols}
    inv_wks = []
    for _,row in df_inv[df_inv[0]==2026].iterrows():
        if not pd.notna(row[2]): continue
        wk = int(row[2])
        if wk > WK: continue
        inv_wks.append(wk)
        for cat,(cc,uc,sc_col) in cat_cols.items():
            c = round(float(row[cc])) if pd.notna(row[cc]) and isinstance(row[cc],(int,float)) else 0
            u = round(float(row[uc])) if pd.notna(row[uc]) and isinstance(row[uc],(int,float)) else 0
            s = (round(float(row[sc_col])*100,1)
                 if sc_col and pd.notna(row[sc_col]) and isinstance(row[sc_col],(int,float))
                 and 0 < float(row[sc_col]) <= 1 else None)
            inv[cat]['cog'].append(c)
            inv[cat]['units'].append(u)
            inv[cat]['st'].append(s)
    d['inv']          = inv
    d['inv_wks']      = inv_wks
    d['inv_latest_wk']= inv_wks[-1] if inv_wks else None
    d['inv_prev_wk']  = inv_wks[-2] if len(inv_wks) > 1 else None

    for yr,ck,uk in [(2024,'cog_2024','units_2024'),(2025,'cog_2025','units_2025')]:
        cog_d={}; u_d={}
        for _,row in df_inv[df_inv[0]==yr].iterrows():
            if pd.notna(row[2]):
                try:
                    wk=int(row[2]); cv=float(row[5]) if pd.notna(row[5]) else 0
                    uv=float(row[6]) if pd.notna(row[6]) else 0
                    if cv>0: cog_d[wk]=round(cv)
                    if uv>0: u_d[wk]=round(uv)
                except: pass
        d[ck]=cog_d; d[uk]=u_d
    d['cog_2026']  = dict(zip(inv_wks, inv['Total']['cog']))
    d['units_2026']= dict(zip(inv_wks, inv['Total']['units']))

    lw = d['inv_latest_wk']
    d['yoy_cog_2025']=0; d['yoy_units_2025']=0
    if lw:
        for _,row in df_inv[df_inv[0]==2025].iterrows():
            if pd.notna(row[2]) and int(row[2])==lw:
                d['yoy_cog_2025']  = round(float(row[5])) if pd.notna(row[5]) else 0
                d['yoy_units_2025']= round(float(row[6])) if pd.notna(row[6]) else 0
                break

    d['st_s24']={}; d['st_s25']={}; d['st_f24']={}
    for _,row in df_inv[df_inv[0]==2025].iterrows():
        if pd.notna(row[2]):
            wk=int(row[2])
            if pd.notna(row[19]) and 0<float(row[19])<=1: d['st_s25'][wk]=round(row[19]*100,1)
    for _,row in df_inv[df_inv[0]==2024].iterrows():
        if pd.notna(row[2]):
            wk=int(row[2])
            if pd.notna(row[15]) and 0<float(row[15])<=1: d['st_f24'][wk]=round(row[15]*100,1)
            if pd.notna(row[11]) and 0<float(row[11])<=1: d['st_s24'][wk]=round(row[11]*100,1)
    d['st_s26']={};d['st_f25']={};d['st_f26']={}
    for wk,ss,sf5,sf6 in zip(inv_wks,inv['S26']['st'],inv['F25']['st'],inv['F26']['st']):
        if ss:  d['st_s26'][wk]=ss
        if sf5: d['st_f25'][wk]=sf5
        if sf6: d['st_f26'][wk]=sf6

    # On Order
    d['on_order']={'total':0,'h1':0,'h2':0}
    for _,row in df_oo.iterrows():
        if pd.notna(row[0]) and row[0]==2026 and pd.notna(row[2]) and int(row[2])==WK:
            d['on_order']={
                'total': float(row[5])  if pd.notna(row[5])  else 0,
                'h1':    float(row[13]) if pd.notna(row[13]) else 0,
                'h2':    float(row[14]) if pd.notna(row[14]) else 0,
            }
            break

    for _,row in df_b.iterrows():
        if str(row[0])=='Wholesale Revenue':
            d['whsl_h1_plan']    = sum(float(row[j]) for j in range(1,27)    if pd.notna(row[j]))
            d['whsl_h2_plan']    = sum(float(row[j]) for j in range(27,53)   if pd.notna(row[j]))
            d['whsl_h1_rem_plan']= sum(float(row[j]) for j in range(WK+1,27) if pd.notna(row[j]))
            d['whsl_h1_wks_left']= 26 - WK
            break

    whsl_act = 0
    for lbl,act,*_ in d['rev_lines']:
        if 'Wholesale' in lbl: whsl_act=act; break
    d['whsl_act']   = whsl_act
    d['whsl_h1_gap']= d['whsl_h1_plan'] - (whsl_act + d['on_order']['h1'])

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
            payroll.append(dict(
                wk=int(row[0]), total_payroll=float(row[4]),
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
# ── Design assets (fonts + component CSS extracted verbatim from the approved
#    mockups, so the live dashboard matches what was actually designed) ──────

_ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

def _asset(name):
    with open(os.path.join(_ASSETS_DIR, name)) as f:
        return f.read()

FONTS_CSS = _asset('fonts.css')
RC_CSS    = _asset('rc_system.css')
LOGO_B64  = _asset('logo_base64.txt').strip().split(',', 1)[-1]

EXTRA_CSS = '''
*{box-sizing:border-box}
.tab-panel{display:none}
.tab-panel.active{display:block}
.chart-wrap{position:relative;width:100%}
.rc-card{overflow-x:auto}
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

def rc_card_kpi(title, cum, full, favorable_if_below=False, desc=None, body_extra=''):
    """cum/full = (plan, actual_or_proj, var). favorable_if_below flips the
    variance color convention for cost lines (Labor, OpEx-style spend)."""
    cum_plan, cum_act, cum_var = cum
    full_plan, full_proj, full_var = full
    return (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">' + title + '</div>'
        + ('<div class="rc-desc">' + desc + '</div>' if desc else '') +
        '</div>'
        '<div class="rc-boxrow">'
        + rc_box('Cumulative to Date', fk(cum_plan), 'Actual', fk(cum_act), vk(cum_var), var_cls(cum_var, favorable_if_below))
        + rc_box('Full Year', fk(full_plan), 'Projection', fk(full_proj), vk(full_var), var_cls(full_var, favorable_if_below))
        + '</div>'
        + body_extra +
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

def ch_card(name, ytd_act, ytd_plan, ann_proj):
    var = ytd_act - ytd_plan
    cls = var_cls(var)
    pct = max(0, min(100, (ytd_act / ann_proj * 100) if ann_proj else 0))
    return (
        '<div class="ch-card">'
        '<div class="ch-name">' + name + '</div>'
        '<div class="ch-value">' + fk(ytd_act) + '</div>'
        '<div class="ch-delta ' + cls + '">' + vk(var) + ' vs plan</div>'
        '<div class="ch-bar"><div class="ch-bar-fill ' + cls + '" style="width:' + f'{pct:.0f}' + '%"></div></div>'
        '<div class="ch-foot">Ann. Proj. ' + fk(ann_proj) + '</div>'
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

# ── Inventory table ──────────────────────────────────────────────────────────

def fmt_cog(v):
    if not v: return '—'
    if v>=1_000_000: return '$' + format(v/1_000_000,'.2f') + 'M'
    if v>=1_000:     return '$' + format(v/1_000,    '.1f') + 'K'
    return '$' + f'{v:,}'

def fmt_units(v):
    return f'{int(v):,}' if v else '—'

def delta_str(curr, prev, is_cog=True):
    if not curr or not prev: return ''
    diff = curr - prev
    if abs(diff) < 50: return ''
    sign = '+' if diff > 0 else ''
    if abs(diff) >= 1000:
        return sign + '$' + format(diff/1000,'.1f') + 'K' if is_cog else sign + f'{int(diff):,}'
    return sign + '$' + f'{int(diff):,}' if is_cog else sign + f'{int(diff):,}'

def st_color(p):
    if p is None: return 'var(--ink)'
    return 'var(--good)' if p>=80 else ('#BA7517' if p>=60 else 'var(--ink)')

def inv_trow(name, cc, cu, pc, pu, st, group):
    dc = delta_str(cc, pc, True)
    du = delta_str(cu, pu, False)
    if group=='season' and 'F26' not in name:
        dcc = 'var(--good)' if dc.startswith('-') else ('var(--watch)' if dc.startswith('+') else 'var(--ink)')
        duc = 'var(--good)' if du.startswith('-') else ('var(--watch)' if du.startswith('+') else 'var(--ink)')
    else:
        dcc = 'var(--watch)' if dc.startswith('+') else ('var(--good)' if dc.startswith('-') else 'var(--ink)')
        duc = 'var(--watch)' if du.startswith('+') else ('var(--good)' if du.startswith('-') else 'var(--ink)')
    sv  = (f'{st:.1f}%' if st else '—')
    sc2 = st_color(st)
    bw  = (f'{min(st,100):.0f}%' if st else '0%')
    return (
        '<tr>'
        '<td style="text-align:left;font-family:var(--body)">' + name + '</td>'
        '<td>' + fmt_cog(cc) + '</td>'
        '<td style="color:' + dcc + '">' + dc + '</td>'
        '<td>' + fmt_units(cu) + '</td>'
        '<td style="color:' + duc + '">' + du + '</td>'
        '<td style="min-width:130px">'
        '<div style="display:flex;align-items:center;gap:8px">'
        '<div style="flex:1;height:5px;background:var(--surface-alt);border-radius:3px"><div style="height:5px;width:' + bw + ';background:' + sc2 + ';border-radius:3px"></div></div>'
        '<span style="font-weight:600;color:' + sc2 + ';min-width:38px;text-align:right">' + sv + '</span>'
        '</div></td>'
        '</tr>\n'
    )

def build_inv_table(d):
    inv=d['inv']; lw=d['inv_latest_wk']; pw=d['inv_prev_wk']
    def get(cat, wk):
        if wk is None or wk not in d['inv_wks']: return 0,0,None
        i = d['inv_wks'].index(wk)
        return inv[cat]['cog'][i], inv[cat]['units'][i], inv[cat]['st'][i]

    season_cats=[('F25 — Last Season','F25','season'),
                 ('S26 — Current Season','S26','season'),
                 ('F26 — Next Season','F26','season')]
    other_cats=[('Starboard','Starboard','other'),('Past Season','PastSeason','other'),
                ('Miscellaneous','Misc','other'),('Jetty Rock Foundation','JRF','other'),
                ('3rd Party 2025','TP2025','other'),('3rd Party 2026','TP2026','other'),
                ('Surfboard — 3rd Party','Surf3P','other'),
                ('Skateboards — 3rd Party','Skateboards','other'),
                ('Surfboard — Consignment','SurfCon','other'),
                ('Collab','Collab','other'),('White Whale','WhiteWhale','other')]

    rows_s = ''.join(inv_trow(lbl,*get(k,lw)[:2],*get(k,pw)[:2],get(k,lw)[2],g) for lbl,k,g in season_cats)
    rows_o = ''.join(inv_trow(lbl,*get(k,lw)[:2],*get(k,pw)[:2],get(k,lw)[2],g) for lbl,k,g in other_cats)

    tc,tu,_ = get('Total',lw); pc2,pu,_ = get('Total',pw)
    dc = delta_str(tc,pc2,True); du = delta_str(tu,pu,False)
    avg = round(tc/tu,2) if tu else 0
    dcc = 'var(--watch)' if dc.startswith('+') else 'var(--good)'
    duc = 'var(--watch)' if du.startswith('+') else 'var(--good)'

    thstyle = 'text-align:right;font-family:var(--mono);font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink);opacity:.55;padding:0 0 6px;border-bottom:1px solid var(--surface-alt)'
    tdstyle = 'font-family:var(--mono);font-size:11.5px;color:var(--ink);text-align:right;padding:6px 0;border-bottom:1px solid var(--surface-alt);font-variant-numeric:tabular-nums'
    return (
        '<table style="width:100%;border-collapse:collapse;table-layout:fixed" class="rc-hltable-like">\n'
        '<style>.rc-hltable-like td,.rc-hltable-like th{' + tdstyle + '}.rc-hltable-like th{' + thstyle + '}</style>\n'
        '      <thead><tr>\n'
        '        <th style="text-align:left">Category</th>\n'
        '        <th>COG</th><th>vs prev wk</th><th>Units</th><th>vs prev wk</th>\n'
        '        <th style="text-align:left;min-width:130px">Sell-through</th>\n'
        '      </tr></thead>\n'
        '      <tbody>\n'
        '        <tr><td colspan="6" style="padding:8px 0 4px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink);opacity:.6;border-bottom:none">Seasons</td></tr>\n'
        + rows_s +
        '        <tr><td colspan="6" style="padding:12px 0 4px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink);opacity:.6;border-bottom:none">Other categories</td></tr>\n'
        + rows_o +
        '        <tr style="border-top:1.5px solid var(--ink)">\n'
        '          <td style="text-align:left;font-family:var(--body);font-weight:700;border-bottom:none">Total inventory</td>\n'
        '          <td style="font-weight:700;border-bottom:none">' + fmt_cog(tc) + '</td>\n'
        '          <td style="color:' + dcc + ';border-bottom:none">' + dc + '</td>\n'
        '          <td style="font-weight:700;border-bottom:none">' + fmt_units(tu) + '</td>\n'
        '          <td style="color:' + duc + ';border-bottom:none">' + du + '</td>\n'
        '          <td style="text-align:left;font-size:10.5px;opacity:.6;border-bottom:none">Avg cost/unit: $' + f'{avg:,.2f}' + '</td>\n'
        '        </tr>\n'
        '      </tbody>\n'
        '    </table>'
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
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.parsed.y)}}},'
        'scales:{x:{type:"category",grid:{color:"#EDECED"},ticks:{maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},y:{grid:{color:"#EDECED"},ticks:{callback:v=>fmtK(v)}}}};\n'
        '(function(){const el=document.getElementById("invHistCOG");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:HL,datasets:['
        '{label:"2024",data:' + to_xy(d['cog_2024'])   + ',borderColor:"#B0B4B8",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2025",data:' + to_xy(d['cog_2025'])   + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2026",data:' + to_xy(d['cog_2026'])   + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,tension:0.3,parsing:false},'
        ']},options:histOpts});})();\n'
        '(function(){const el=document.getElementById("invTotUnits");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:HL,datasets:['
        '{label:"2024",data:' + to_xy(d['units_2024']) + ',borderColor:"#B0B4B8",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2025",data:' + to_xy(d['units_2025']) + ',borderColor:"#586D72",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2026",data:' + to_xy(d['units_2026']) + ',borderColor:"#43575E",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,tension:0.3,parsing:false},'
        ']},options:histOpts});})();\n'
        'const stOpts={responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+c.parsed.y.toFixed(1)+"%"}}},'
        'scales:{x:{type:"category",grid:{color:"#EDECED"},ticks:{maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},y:{min:0,max:100,grid:{color:"#EDECED"},ticks:{callback:v=>v+"%"}}}};\n'
        'const SL=Array.from({length:52},(_,i)=>"Wk "+(i+1));\n'
        'function mkST(id,ds){const el=document.getElementById(id);if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:SL,datasets:ds.map(d=>{return{label:d.l,data:d.d,'
        'borderColor:d.c,backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false};})},'
        'options:stOpts});}\n'
        'mkST("invSSSellThru",['
        '{l:"S24",d:' + st_xy(d['st_s24']) + ',c:"#B0B4B8"},'
        '{l:"S25",d:' + st_xy(d['st_s25']) + ',c:"#586D72"},'
        '{l:"S26",d:' + st_xy(d['st_s26']) + ',c:"#43575E"}]);\n'
        'mkST("invFWSellThru",['
        '{l:"F24",d:' + st_xy(d['st_f24']) + ',c:"#B0B4B8"},'
        '{l:"F25",d:' + st_xy(d['st_f25']) + ',c:"#586D72"},'
        '{l:"F26",d:' + st_xy(d['st_f26']) + ',c:"#43575E"}]);\n'
        + build_labor_chart_js(d)
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

def build_cashflow_panel(d):
    cf = d['cf']
    def p(k): return cf[k][-1] if cf[k] else 0

    body = rc_card_kpi("Total Cash In",
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
        mix_tiles = ''.join(dept_tile(n, str(v)) for n, v in [
            ('Full-Time', pr['ft']), ('Part-Time', pr['pt']),
            ('Hourly', pr['hourly']), ('Salary', pr['salary']),
            ('Female', pr['female']), ('Male', pr['male']),
            ('Brand', pr['brand']), ('INK', pr['ink']),
        ])
        dept_items = sorted(DEPT_LABELS.items(), key=lambda kv: -pr['depts'][kv[0]])
        dept_tiles = ''.join(dept_tile(lbl, str(pr['depts'][key])) for key, lbl in dept_items)
        body += (
            '<div class="rc-card" style="grid-column:1 / -1">'
            '<div class="dept-group-label">Employment Mix</div>'
            '<div class="dept-grid">' + mix_tiles + '</div>'
            '<div class="dept-group-label">By Department</div>'
            '<div class="dept-grid">' + dept_tiles + '</div>'
            '</div>\n'
        )
        body += rc_divider("Overtime — Hours & Cost per Pay Period")
        body += (
            '<div class="rc-card" style="grid-column:1 / -1">'
            '<div class="rc-chart chart-wrap" style="height:200px"><canvas id="laborOT"></canvas></div>'
            '</div>\n'
        )
    return body

# ── Revenue panel ────────────────────────────────────────────────────────────

def build_revenue_panel(d):
    rev = d['rev']
    body = rc_card_kpi("Total Revenue",
        (rev['plan'], rev['act'], rev['var']), (rev['ann_plan'], rev['ann_proj'], rev['ann_var']))

    body += rc_divider("Revenue by Channel")
    cards = ''.join(ch_card(lbl, act, plan, ap) for lbl, act, plan, ann, ap in d['rev_lines'])
    body += '<div class="channel-grid" style="grid-column:1 / -1">' + cards + '</div>\n'

    oo=d['on_order']; h1_wks=d['whsl_h1_wks_left']
    h1_rem=d['whsl_h1_rem_plan']; h2_plan=d['whsl_h2_plan']
    h1_open_vs=oo['h1']-h1_rem; h2_pct=oo['h2']/h2_plan*100 if h2_plan else 0
    whsl_act=d['whsl_act']; h1_proj=whsl_act+oo['h1']; h1_gap=d['whsl_h1_gap']
    gap_cls = 'pos' if h1_gap<=0 else 'neg'
    gap_disp= vk(-h1_gap) if h1_gap>0 else '+'+fk(abs(h1_gap))
    h1ov_cls= 'pos' if h1_open_vs>=0 else 'neg'

    body += rc_divider("Open Orders — On Order, Not Yet Shipped or Invoiced")
    body += (
        '<div class="rc-card" style="grid-column:1 / -1">'
        '<div class="rc-headrow"><div class="rc-name">As of Week ' + str(d['week']) + '</div>'
        '<div class="rc-desc">Retail orders including discounts applied · Total on order: ' + fk(oo['total']) + '</div></div>'
        '<div class="rc-boxrow">'
        '<div class="rc-box"><div class="rc-group-label">H1 (ends Jul 4) — ' + str(h1_wks) + ' wks left</div>'
        '<div class="rc-row">'
        + rc_stat('On Order', fk(oo['h1']))
        + rc_stat('vs Remaining Plan', vk(h1_open_vs), h1ov_cls)
        + rc_stat('H1 Projected', fk(h1_proj))
        + '</div></div>'
        '<div class="rc-box"><div class="rc-group-label">H2 (Jul 5 – Dec 31) — 26 wks left</div>'
        '<div class="rc-row">'
        + rc_stat('On Order', fk(oo['h2']))
        + rc_stat('% of H2 Plan', f'{h2_pct:.1f}%')
        + '</div></div>'
        '</div>'
        '<div class="rc-hl">'
        '<table class="rc-hltable"><thead><tr><th style="text-align:left">H1 Wholesale Gap Analysis</th><th></th></tr></thead><tbody>'
        '<tr><td style="text-align:left;font-family:var(--body)">H1 total plan (wks 1–26)</td><td>' + fk(d['whsl_h1_plan']) + '</td></tr>'
        '<tr><td style="text-align:left;font-family:var(--body)">YTD actual (wks 1–' + str(d['week']) + ')</td><td class="neg">' + fk(whsl_act) + '</td></tr>'
        '<tr><td style="text-align:left;font-family:var(--body)">H1 open orders (wks ' + str(d['week']+1) + '–26)</td><td>' + fk(oo['h1']) + '</td></tr>'
        '<tr><td style="text-align:left;font-family:var(--body);font-weight:700;border-bottom:none">H1 gap to plan</td><td class="' + gap_cls + '" style="font-weight:700;border-bottom:none">' + gap_disp + '</td></tr>'
        '</tbody></table></div>'
        '<div class="rc-subhead neg" style="margin-top:12px">Action required: Wholesale reps must actively sell AO during S27 road shows starting June 1. '
        'KONA, Sun Cruiser, Stone Pony, and Ron Jon\'s collab invoices are in the WIP pipeline and represent meaningful upside.</div>'
        '</div>\n'
    )
    return body

# ── HTML assembly ─────────────────────────────────────────────────────────────

def sec_label(txt):
    return rc_divider(txt)

def build_html(d):
    WK  = d['week']
    rev = d['rev']; cogs = d['cogs']; opex = d['opex']; ni = d['net_income']

    # Revenue table (used by nothing now except cogs table below reuses the pattern)
    cogs_rows = [(lbl, plan, act, ann, ap, False) for lbl, act, plan, ann, ap in d['cogs_lines']]

    lw=d['inv_latest_wk']; pending=lw and lw<WK
    pend_note=" (wk " + str(lw) + " shown — wk " + str(WK) + " pending)" if pending else ""
    inv=d['inv']
    if lw:
        i_lw=d['inv_wks'].index(lw)
        tc=inv['Total']['cog'][i_lw]; tu=inv['Total']['units'][i_lw]
        s26_st=inv['S26']['st'][i_lw] or 0
        s26_py=d['st_s25'].get(lw,None)
        st_diff=round(s26_st-s26_py,1) if s26_py else None
        yoy_c=d['yoy_cog_2025']; yoy_u=d['yoy_units_2025']
        yoy_cog_str = ('+' + fk(tc-yoy_c) + ' vs prior year (+' + f'{(tc-yoy_c)/yoy_c*100:.1f}' + '%)') if yoy_c else ''
        yoy_u_str   = ('+' + f'{tu-yoy_u:,}' + ' units vs prior year (+' + f'{(tu-yoy_u)/yoy_u*100:.1f}' + '%)') if yoy_u else ''
        st_diff_str = ('S26 ' + f'{s26_st:.1f}' + '% — ' + f'{abs(st_diff):.1f}' + 'pts '
                       + ('behind' if st_diff<0 else 'ahead of') + ' S25 at wk ' + str(lw)) if st_diff is not None else ''
        pw_idx = d['inv_wks'].index(d['inv_prev_wk']) if d['inv_prev_wk'] in d['inv_wks'] else None
        prev_c = inv['Total']['cog'][pw_idx]   if pw_idx is not None else 0
        prev_u = inv['Total']['units'][pw_idx] if pw_idx is not None else 0
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
        '</nav>\n'
    )

    summary_panel = (
        rc_card_kpi("Total Revenue", (rev['plan'],rev['act'],rev['var']), (rev['ann_plan'],rev['ann_proj'],rev['ann_var']))
        + rc_card_kpi("COGS + Labor + Shipping", (cogs['plan'],cogs['act'],cogs['var']), (cogs['ann_plan'],cogs['ann_proj'],cogs['ann_var']), favorable_if_below=True)
        + rc_card_kpi("Total OpEx", (opex['plan'],opex['act'],opex['var']), (opex['ann_plan'],opex['ann_proj'],opex['ann_var']), favorable_if_below=True)
        + rc_card_kpi("Net Income", (ni['plan'],ni['act'],ni['var']), (ni['ann_plan'],ni['ann_proj'],ni['ann_var']))
    )

    cogs_panel = (
        rc_card_kpi("Total COGS + Labor + Shipping",
            (cogs['plan'],cogs['act'],cogs['var']), (cogs['ann_plan'],cogs['ann_proj'],cogs['ann_var']),
            favorable_if_below=True, body_extra=rc_hltable(cogs_rows, is_cost=True))
    )

    inventory_panel = (
        '<div class="rc-card"><div class="rc-group-label">Total Inventory COG — Week ' + str(lw or WK) + pend_note + '</div>'
        '<div class="rc-stat-val" style="font-size:26px;margin:6px 0 4px">' + (fk(tc) if tc else '—') + '</div>'
        '<div class="rc-desc">' + (delta_c_str or '—') + '</div>'
        + (('<div class="rc-desc neg" style="font-family:var(--mono);margin-top:2px">' + yoy_cog_str + '</div>') if yoy_cog_str else '') +
        '</div>\n'
        '<div class="rc-card"><div class="rc-group-label">Total Units on Hand — Week ' + str(lw or WK) + pend_note + '</div>'
        '<div class="rc-stat-val" style="font-size:26px;margin:6px 0 4px">' + (format(tu, ',') if tu else '—') + '</div>'
        '<div class="rc-desc">' + (yoy_u_str or '—') + '</div>'
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
        + rc_divider("Inventory Breakdown — Week " + str(lw or WK) + pend_note)
        + '<div class="rc-card" style="grid-column:1 / -1">' + build_inv_table(d) + '</div>\n'
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
        + '</main>\n'
        '</div>\n'
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>\n'
        '<script>\n'
        + build_chart_js(d)
        + '</script>\n'
        '<script>\n'
        + TAB_JS +
        '</script>\n</body>\n</html>'
    )

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Reading data...")
    d = read_all()
    print("Week " + str(d['week']) + " data loaded")
    print("Building dashboard...")
    html = build_html(d)
    os.makedirs("output", exist_ok=True)
    with open("output/index.html", "w") as f:
        f.write(html)
    size = os.path.getsize("output/index.html") / 1024
    print("Done — output/index.html written (" + str(round(size,1)) + " KB)")

    source_modified = os.environ.get("SOURCE_MODIFIED_TIME", "")
    with open("output/meta.json", "w") as f:
        json.dump({"source_modified": source_modified}, f)
    print("Recorded source_modified=" + source_modified + " in output/meta.json")

if __name__ == "__main__":
    main()
