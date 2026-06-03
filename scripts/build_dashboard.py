import os, hashlib
import pandas as pd
import pyxlsb

FP = "data/budget.xlsb"

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

def cell(val, width, cls="", muted=False, bold=False):
    color  = "color:var(--ink-muted);" if muted else ""
    weight = "font-weight:500;"        if bold  else ""
    c = ' class="' + cls + '"' if cls else ""
    return '<span' + c + ' style="width:' + str(width) + 'px;text-align:right;font-family:var(--mono);font-size:11px;' + color + weight + '">' + val + '</span>'

def trow(name, ytd_act, ytd_plan, ann_plan, ann_proj, is_cost=False, is_total=False):
    ytd_var = ytd_act - ytd_plan
    ann_var = ann_proj - ann_plan
    if is_cost:
        yvc = "pos" if ytd_var < -50 else ("neg" if ytd_var >  50 else "neu")
        avc = "pos" if ann_var < -100 else ("neg" if ann_var > 100 else "neu")
        ac  = "pos" if ytd_var < -50 else ("neg" if ytd_var >  50 else "")
    else:
        yvc = "pos" if ytd_var >  50 else ("neg" if ytd_var < -50  else "neu")
        avc = "pos" if ann_var > 100  else ("neg" if ann_var < -100 else "neu")
        ac  = "pos" if ytd_var >  50 else ("neg" if ytd_var < -50  else "")
    style = ' style="border-top:1.5px solid var(--ink);margin-top:4px;padding-top:8px;font-weight:500"' if is_total else ""
    return ('    <div class="ch-row"' + style + '><span class="ch-name">' + name + '</span>'
            + cell(fk(ytd_act), 72, ac, bold=True)
            + cell(fk(ytd_plan), 68, muted=True)
            + cell(vk(ytd_var), 62, yvc)
            + cell(fk(ann_plan), 78, muted=True)
            + cell(fk(ann_proj), 78, bold=True)
            + cell(vk(ann_var), 62, avc)
            + '</div>\n')

COL_HDR = '''    <div style="display:flex;gap:6px;padding-bottom:6px;font-size:10px;color:var(--ink-muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--rule)">
      <span style="flex:1">Category</span>
      <span style="width:72px;text-align:right">YTD Actual</span>
      <span style="width:68px;text-align:right">YTD Plan</span>
      <span style="width:62px;text-align:right">YTD Var</span>
      <span style="width:78px;text-align:right">Ann. Plan</span>
      <span style="width:78px;text-align:right">Ann. Proj.</span>
      <span style="width:62px;text-align:right">Ann. Var</span>
    </div>\n'''

def js_arr(lst):
    return '[' + ','.join(str(v) for v in lst) + ']'

def to_xy(d):
    return '[' + ','.join('{x:"Wk ' + str(k) + '",y:' + str(v) + '}' for k,v in sorted(d.items())) + ']'

def st_xy(d):
    return '[' + ','.join('{x:"Wk ' + str(k) + '",y:' + str(v) + '}' for k,v in sorted(d.items()) if v) + ']'

# ── Data extraction ──────────────────────────────────────────────────────────

def read_all():
    d = {}
    df_s  = pd.read_excel(FP, sheet_name='Summary',             engine='pyxlsb', header=None)
    df_a  = pd.read_excel(FP, sheet_name='Actual',              engine='pyxlsb', header=None)
    df_b  = pd.read_excel(FP, sheet_name='Budget',              engine='pyxlsb', header=None)
    df_cf = pd.read_excel(FP, sheet_name='Cash Flow - Tracker', engine='pyxlsb', header=None)
    df_inv= pd.read_excel(FP, sheet_name='Inventory',           engine='pyxlsb', header=None)
    df_oo = pd.read_excel(FP, sheet_name='On Order',            engine='pyxlsb', header=None)

    def sc(row, col):
        r = row - 1
        c = {'B':1,'C':2,'D':3,'G':6,'H':7,'I':8}[col]
        v = df_s.iloc[r, c]
        return float(v) if pd.notna(v) else 0.0

    WK = int(df_s.iloc[2, 1])
    d['week']       = WK
    d['net_inc_var']= sc(21, 'D')
    d['ytd_status'] = 'ahead' if d['net_inc_var'] >= 0 else 'behind'
    for key, row in [('rev',11),('cogs',13),('opex',15)]:
        d[key] = {k: sc(row, c) for k,c in [('plan','B'),('act','C'),('var','D'),
                                              ('ann_plan','G'),('ann_proj','H'),('ann_var','I')]}

    def get_a(name):
        for i,row in df_a.iterrows():
            if str(row[0]) == name: return float(row[WK]) if pd.notna(row[WK]) else 0.0
        return 0.0
    def get_b(name, wks=None):
        w = wks or WK
        for i,row in df_b.iterrows():
            if str(row[0]) == name:
                return sum(float(row[j]) for j in range(1, w+1) if pd.notna(row[j]))
        return 0.0
    def get_r(name):
        for i,row in df_b.iterrows():
            if str(row[0]) == name:
                return sum(float(row[j]) for j in range(WK+1, 53) if pd.notna(row[j]))
        return 0.0
    def get_ann(name):
        for i,row in df_b.iterrows():
            if str(row[0]) == name: return float(row[59]) if pd.notna(row[59]) else 0.0
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
    d['opex_lines'] = [(lbl, get_a(k), get_b(k), get_ann(k), proj(k)) for lbl,k in opex_map]

    # Cash flow
    cin_w,cin_d,cin_i,cin_t,cout_b,cout_i,cout_o = [],[],[],[],[],[],[]
    proj_w,proj_d,proj_i,proj_b,proj_i2,proj_o   = [],[],[],[],[],[]
    rw=rd=ri=rb=ri2=ro=0
    labels=[]
    for _,row in df_cf.iterrows():
        if pd.notna(row[2]) and str(row[2]) != 'Week':
            try: wk = int(row[2])
            except: continue
            if wk > WK: break
            rw  += float(row[5])  if pd.notna(row[5])  else 0
            rd  += float(row[6])  if pd.notna(row[6])  else 0
            ri  += float(row[7])  if pd.notna(row[7])  else 0
            rb  += float(row[15]) if pd.notna(row[15]) else 0
            ri2 += float(row[16]) if pd.notna(row[16]) else 0
            ro  += float(row[17]) if pd.notna(row[17]) else 0
            act  = float(row[13]) if pd.notna(row[13]) else 0
            if act > 0:
                labels.append("Wk " + str(wk))
                cin_w.append(round(float(row[10]) if pd.notna(row[10]) else 0))
                cin_d.append(round(float(row[11]) if pd.notna(row[11]) else 0))
                cin_i.append(round(float(row[12]) if pd.notna(row[12]) else 0))
                cin_t.append(round(act))
                cout_b.append(round(float(row[21]) if pd.notna(row[21]) else 0))
                cout_i.append(round(float(row[22]) if pd.notna(row[22]) else 0))
                cout_o.append(round(float(row[23]) if pd.notna(row[23]) else 0))
                proj_w.append(round(rw));  proj_d.append(round(rd));  proj_i.append(round(ri))
                proj_b.append(round(rb));  proj_i2.append(round(ri2)); proj_o.append(round(ro))

    d['cf'] = dict(labels=labels,
        cin_w=cin_w, cin_d=cin_d, cin_i=cin_i, cin_t=cin_t,
        cout_b=cout_b, cout_i=cout_i, cout_o=cout_o,
        proj_w=proj_w, proj_d=proj_d, proj_i=proj_i,
        proj_b=proj_b, proj_i2=proj_i2, proj_o=proj_o)

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

    return d

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
    if p is None: return 'var(--ink-muted)'
    return '#0d6e4f' if p>=80 else ('#BA7517' if p>=60 else '#888780')

def inv_trow(name, cc, cu, pc, pu, st, group):
    dc = delta_str(cc, pc, True)
    du = delta_str(cu, pu, False)
    if group=='season' and 'F26' not in name:
        dcc = '#0d6e4f' if dc.startswith('-') else ('#a82f2f' if dc.startswith('+') else 'var(--ink-muted)')
        duc = '#0d6e4f' if du.startswith('-') else ('#a82f2f' if du.startswith('+') else 'var(--ink-muted)')
    else:
        dcc = '#a82f2f' if dc.startswith('+') else ('#0d6e4f' if dc.startswith('-') else 'var(--ink-muted)')
        duc = '#a82f2f' if du.startswith('+') else ('#0d6e4f' if du.startswith('-') else 'var(--ink-muted)')
    sv  = (f'{st:.1f}%' if st else '—')
    sc2 = st_color(st)
    bw  = (f'{min(st,100):.0f}%' if st else '0%')
    return (
        '    <tr>\n'
        '      <td style="padding:7px 8px 7px 0;font-size:12px;color:var(--ink);border-bottom:1px solid var(--rule)">' + name + '</td>\n'
        '      <td style="padding:7px 6px;font-family:var(--mono);font-size:11px;font-weight:500;text-align:right;border-bottom:1px solid var(--rule)">' + fmt_cog(cc) + '</td>\n'
        '      <td style="padding:7px 6px;font-family:var(--mono);font-size:10px;text-align:right;border-bottom:1px solid var(--rule);color:' + dcc + '">' + dc + '</td>\n'
        '      <td style="padding:7px 6px;font-family:var(--mono);font-size:11px;font-weight:500;text-align:right;border-bottom:1px solid var(--rule)">' + fmt_units(cu) + '</td>\n'
        '      <td style="padding:7px 6px;font-family:var(--mono);font-size:10px;text-align:right;border-bottom:1px solid var(--rule);color:' + duc + '">' + du + '</td>\n'
        '      <td style="padding:7px 0 7px 6px;border-bottom:1px solid var(--rule);min-width:130px">\n'
        '        <div style="display:flex;align-items:center;gap:8px">\n'
        '          <div style="flex:1;height:5px;background:var(--rule);border-radius:3px"><div style="height:5px;width:' + bw + ';background:' + sc2 + ';border-radius:3px"></div></div>\n'
        '          <span style="font-family:var(--mono);font-size:11px;font-weight:600;color:' + sc2 + ';min-width:38px;text-align:right">' + sv + '</span>\n'
        '        </div>\n'
        '      </td>\n'
        '    </tr>\n'
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
    dcc = '#a82f2f' if dc.startswith('+') else '#0d6e4f'
    duc = '#a82f2f' if du.startswith('+') else '#0d6e4f'

    return (
        '<table style="width:100%;border-collapse:collapse">\n'
        '      <thead><tr>\n'
        '        <th style="text-align:left;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-muted);padding:0 8px 8px 0;border-bottom:1.5px solid var(--ink)">Category</th>\n'
        '        <th style="text-align:right;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-muted);padding:0 6px 8px;border-bottom:1.5px solid var(--ink)">COG</th>\n'
        '        <th style="text-align:right;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-muted);padding:0 6px 8px;border-bottom:1.5px solid var(--ink)">vs prev wk</th>\n'
        '        <th style="text-align:right;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-muted);padding:0 6px 8px;border-bottom:1.5px solid var(--ink)">Units</th>\n'
        '        <th style="text-align:right;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-muted);padding:0 6px 8px;border-bottom:1.5px solid var(--ink)">vs prev wk</th>\n'
        '        <th style="text-align:left;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-muted);padding:0 0 8px 6px;border-bottom:1.5px solid var(--ink);min-width:130px">Sell-through</th>\n'
        '      </tr></thead>\n'
        '      <tbody>\n'
        '        <tr><td colspan="6" style="padding:8px 0 4px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted)">Seasons</td></tr>\n'
        + rows_s +
        '        <tr><td colspan="6" style="padding:12px 0 4px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted)">Other categories</td></tr>\n'
        + rows_o +
        '        <tr style="border-top:1.5px solid var(--ink)">\n'
        '          <td style="padding:8px 8px 4px 0;font-family:var(--mono);font-size:11px;font-weight:600">Total inventory</td>\n'
        '          <td style="padding:8px 6px 4px;font-family:var(--mono);font-size:11px;font-weight:600;text-align:right">' + fmt_cog(tc) + '</td>\n'
        '          <td style="padding:8px 6px 4px;font-family:var(--mono);font-size:10px;text-align:right;color:' + dcc + '">' + dc + '</td>\n'
        '          <td style="padding:8px 6px 4px;font-family:var(--mono);font-size:11px;font-weight:600;text-align:right">' + fmt_units(tu) + '</td>\n'
        '          <td style="padding:8px 6px 4px;font-family:var(--mono);font-size:10px;text-align:right;color:' + duc + '">' + du + '</td>\n'
        '          <td style="padding:8px 0 4px 6px;font-family:var(--mono);font-size:10px;color:var(--ink-muted)">Avg cost/unit: $' + f'{avg:,.2f}' + '</td>\n'
        '        </tr>\n'
        '      </tbody>\n'
        '    </table>'
    )

# ── Callout boxes ────────────────────────────────────────────────────────────

def box(bg, border, label_color, label, txt):
    return (
        '      <div style="margin-bottom:10px;padding:10px 12px;background:' + bg + ';border-left:3px solid ' + border + ';border-radius:0 4px 4px 0">\n'
        '        <div style="font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:' + label_color + ';margin-bottom:4px">' + label + '</div>\n'
        '        <div style="font-size:12px;color:var(--ink);line-height:1.6">' + txt + '</div>\n'
        '      </div>'
    )

def win(t):    return box('#eaf4ef','#b8ddd0','#0d6e4f','Win',t)
def watch(t):  return box('#fce8e8','#f0c0c0','#a82f2f','Watch',t)
def trend(t):  return box('#edf3fb','#b8d0ee','#2e6da4','Trend',t)
def outlook(t):return box('#edf3fb','#b8d0ee','#2e6da4','Outlook',t)

def callout_col(boxes):
    return (
        '    <div style="padding:0 0 0 4px">\n'
        '      <div style="font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:14px">Summary &amp; Outlook</div>\n'
        + '\n'.join(boxes) + '\n'
        '    </div>'
    )

def generate_callouts(d):
    WK=d['week']; rev=d['rev']; cogs=d['cogs']; opex=d['opex']
    cf=d['cf']; oo=d['on_order']; net_var=d['net_inc_var']

    jtl_act=jtl_plan=whsl_act=whsl_plan=sp_act=0
    for lbl,act,plan,ann,ap in d['rev_lines']:
        if 'Jettylife' in lbl: jtl_act=act; jtl_plan=plan
        if 'Wholesale' in lbl: whsl_act=act; whsl_plan=plan
        if 'Screen'    in lbl: sp_act=act

    ship_brand_act=ship_brand_plan=adv_act=adv_plan=0
    for lbl,act,plan,*_ in d['cogs_lines']:
        if 'brand' in lbl.lower() and 'ship' in lbl.lower():
            ship_brand_act=act; ship_brand_plan=plan
    for lbl,act,plan,*_ in d['opex_lines']:
        if lbl=='Advertising': adv_act=act; adv_plan=plan

    cin_tot  = cf['cin_t'][-1]  if cf['cin_t']  else 0
    proj_tot = (cf['proj_w'][-1] if cf['proj_w'] else 0) + (cf['proj_d'][-1] if cf['proj_d'] else 0) + (cf['proj_i'][-1] if cf['proj_i'] else 0)
    cout_tot = (cf['cout_b'][-1] if cf['cout_b'] else 0) + (cf['cout_i'][-1] if cf['cout_i'] else 0) + (cf['cout_o'][-1] if cf['cout_o'] else 0)
    surplus  = cin_tot - cout_tot
    h1_wks   = d['whsl_h1_wks_left']
    h1_proj  = whsl_act + oo['h1']
    h2_pct   = oo['h2']/d['whsl_h2_plan']*100 if d['whsl_h2_plan'] else 0

    inv=d['inv']; lw=d['inv_latest_wk']
    pending = lw and lw < WK
    pend_note = " (showing wk " + str(lw) + ")" if pending else ""
    if lw:
        i = d['inv_wks'].index(lw)
        tc=inv['Total']['cog'][i]; tu=inv['Total']['units'][i]
        s26_st=inv['S26']['st'][i]; f25_st=inv['F25']['st'][i]
        yoy_c=d['yoy_cog_2025']
    else:
        tc=tu=s26_st=f25_st=yoy_c=0

    pl_c = callout_col([
        win("COGS + Labor + Shipping is " + fk(abs(cogs['var'])) + " favorable vs plan through Week " + str(WK) + ". "
            "Net income is " + fk(abs(net_var)) + (" ahead of plan." if net_var>=0 else " behind plan.")),
        watch("Revenue is " + fk(abs(rev['var'])) + (" ahead of" if rev['var']>=0 else " behind") + " plan YTD. "
              "OpEx is " + fk(opex['var']) + " over plan, driven by advertising (" + fk(adv_act-adv_plan) + " over)."),
        outlook("Full-year revenue projects at " + fk(rev['ann_proj']) + " vs " + fk(rev['ann_plan']) + " plan. "
                "COGS projects " + fk(abs(cogs['ann_var'])) + " favorable. "
                "Net income is " + fk(abs(net_var)) + " ahead of plan.")
    ])

    rev_c = callout_col([
        win("Jettylife.com is " + fk(jtl_act-jtl_plan) + " above YTD plan through Week " + str(WK) + "."),
        watch("Wholesale is " + fk(abs(whsl_act-whsl_plan)) + (" ahead of" if whsl_act>=whsl_plan else " behind") + " YTD plan. "
              "H1 open orders of " + fk(oo['h1']) + " with " + str(h1_wks) + " wks remaining "
              "project H1 at " + fk(h1_proj) + " vs the " + fk(d['whsl_h1_plan']) + " H1 plan. "
              "Screen Printing is " + fk(abs(sp_act)) + " YTD — Playa Bowls franchisee timing continues to weigh."),
        trend("H2 open orders of " + fk(oo['h2']) + " represent " + f'{h2_pct:.1f}' + "% of H2 plan already on the books. "
              "AO sell-in during S27 road shows and collab invoices (KONA, Sun Cruiser, Stone Pony, Ron Jon's) are the key upside levers."),
        outlook("Full-year revenue projects at " + fk(rev['ann_proj']) + ". "
                "Collab invoices in the WIP pipeline represent meaningful upside not yet in this figure.")
    ])

    cogs_c = callout_col([
        win("Total COGS + Labor + Shipping is " + fk(abs(cogs['var'])) + " favorable vs plan through Week " + str(WK) + ". "
            "Full-year projection of " + fk(cogs['ann_proj']) + " is " + fk(abs(cogs['ann_var'])) + " below the " + fk(cogs['ann_plan']) + " plan."),
        watch("Shipping — Brand is over plan: " + fk(ship_brand_act) + " actual vs " + fk(ship_brand_plan) + " planned YTD "
              "— a " + fk(ship_brand_act-ship_brand_plan) + " overage driven by DTC eComm volume. This is the only COGS line running above budget."),
        outlook("Net COGS remains " + fk(abs(cogs['var'])) + " below plan — the primary driver of net income being " + fk(abs(net_var)) + " ahead of plan.")
    ])

    opex_c = callout_col([
        watch("Advertising is " + fk(adv_act) + " actual vs " + fk(adv_plan) + " plan YTD — a " + fk(adv_act-adv_plan) + " overage. "
              "MER confirms this spend is driving Jettylife.com's DTC outperformance."),
        watch("Permits at 700 S Main are over plan. Selling Expenses — Rep Travel is elevated from S27 road show activity."),
        win("Several MKG lines are running under plan — Banners/POP, Photography, and Trade Show are all favorable."),
        outlook("Full-year OpEx projects at " + fk(opex['ann_proj']) + " vs " + fk(opex['ann_plan']) + " plan. H2 advertising discipline is the key lever.")
    ])

    dtc_act = cf['cin_d'][-1] if cf['cin_d'] else 0
    dtc_proj= cf['proj_d'][-1] if cf['proj_d'] else 0
    cf_c = callout_col([
        win("Total cumulative cash in through Week " + str(WK) + " is " + fk(cin_tot) + " "
            + ("ahead of" if cin_tot>=proj_tot else "behind") + " projection by " + fk(abs(cin_tot-proj_tot)) + ". "
            "DTC cash in of " + fk(dtc_act) + " is " + fk(abs(dtc_act-dtc_proj)) + " vs projection."),
        watch("Total cash out is " + fk(cout_tot) + ". The business is cash-flow positive with a " + fk(surplus) + " cumulative surplus."),
        trend("H1 open orders of " + fk(oo['h1']) + " will drive additional cash in over the next " + str(h1_wks) + " weeks as orders ship and invoice."),
        outlook("F26 inventory payments will increase cash out in H2 as product ships — this is planned and expected.")
    ])

    if not lw:
        inv_c = callout_col([watch("Inventory data has not yet been entered for this week.")])
    else:
        s26_py  = d['st_s25'].get(lw, None)
        st_diff = round(s26_st-s26_py, 1) if s26_py and s26_st else None
        inv_c = callout_col([
            win("Total inventory COG " + fmt_cog(tc) + " / " + fmt_units(tu) + " units" + pend_note + ". "
                "S26 sell-through " + (f'{s26_st:.1f}%' if s26_st else '—') + ". "
                "F25 at " + (f'{f25_st:.1f}% sold' if f25_st else '—') + "."),
            watch((str(abs(st_diff)) + "pts " + ("behind" if st_diff and st_diff<0 else "ahead of") + " S25 at the same week. " if st_diff else '') +
                  "Total COG is " + fk(abs(tc-yoy_c)) + (" above" if tc>yoy_c else " below") + " prior year "
                  "(" + fmt_cog(tc) + " vs " + fmt_cog(yoy_c) + " in 2025)."),
            outlook("H2 open orders of " + fk(oo['h2']) + " (" + f'{h2_pct:.1f}' + "% of H2 plan) with F26 in house. "
                    "Shipping F26 against these open orders is the key H2 operational priority.")
        ])

    return pl_c, rev_c, cogs_c, opex_c, cf_c, inv_c

# ── Chart JS ─────────────────────────────────────────────────────────────────

def build_chart_js(d):
    cf     = d['cf']
    labels = '[' + ','.join('"' + l + '"' for l in cf['labels']) + ']'
    cout_tot = [b+i+o for b,i,o in zip(cf['cout_b'],cf['cout_i'],cf['cout_o'])]

    return (
        'const fmtK=v=>{const a=Math.abs(v);'
        'if(a>=1000000)return"$"+(v<0?"−":"")+(a/1000000).toFixed(2)+"M";'
        'if(a>=1000)return"$"+(v<0?"−":"")+(a/1000).toFixed(1)+"K";'
        'return"$"+v.toLocaleString();};\n'
        'const WKS=' + labels + ';\n'
        'const mkChart=(id,act,proj,color)=>{'
        'const el=document.getElementById(id);if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:WKS,datasets:['
        '{label:"Actual",data:act,borderColor:color,backgroundColor:"transparent",borderWidth:2,pointRadius:2,tension:0.3},'
        '{label:"Projected",data:proj,borderColor:color,backgroundColor:"transparent",borderWidth:2,borderDash:[4,3],pointRadius:2,tension:0.3},'
        ']},options:{responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtK(c.raw)}}},'
        'scales:{x:{ticks:{font:{size:9}}},y:{ticks:{callback:v=>fmtK(v),font:{size:9}}}}'
        '}});};\n'
        'mkChart("ciWholesale",' + js_arr(cf['cin_w'])  + ',' + js_arr(cf['proj_w'])  + ',"#0d6e4f");\n'
        'mkChart("ciDTC",      ' + js_arr(cf['cin_d'])  + ',' + js_arr(cf['proj_d'])  + ',"#378ADD");\n'
        'mkChart("ciINK",      ' + js_arr(cf['cin_i'])  + ',' + js_arr(cf['proj_i'])  + ',"#BA7517");\n'
        'mkChart("coCOGSBrand",' + js_arr(cf['cout_b']) + ',' + js_arr(cf['proj_b'])  + ',"#a82f2f");\n'
        'mkChart("coCOGSINK",  ' + js_arr(cf['cout_i']) + ',' + js_arr(cf['proj_i2']) + ',"#D85A30");\n'
        'mkChart("coOther",    ' + js_arr(cf['cout_o']) + ',' + js_arr(cf['proj_o'])  + ',"#888780");\n'
        '(function(){const el=document.getElementById("cfChart");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:WKS,datasets:['
        '{label:"Cash in", data:' + js_arr(cf['cin_t'])  + ',borderColor:"#0d6e4f",backgroundColor:"transparent",borderWidth:2.5,pointRadius:2,tension:0.3},'
        '{label:"Cash out",data:' + js_arr(cout_tot)     + ',borderColor:"#a82f2f",backgroundColor:"transparent",borderWidth:2.5,pointRadius:2,tension:0.3},'
        ']},options:{responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:true,position:"top",labels:{font:{size:10}}}},'
        'scores:{x:{ticks:{font:{size:9}}},y:{ticks:{callback:v=>fmtK(v),font:{size:9}}}}'
        '}}});})();\n'
        'const HL=Array.from({length:52},(_,i)=>"Wk "+(i+1));\n'
        'const histOpts={responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+fmtK(c.parsed.y)}}},'
        'scales:{x:{type:"category",ticks:{font:{size:9},maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},y:{ticks:{callback:v=>fmtK(v),font:{size:9}}}}};\n'
        '(function(){const el=document.getElementById("invHistCOG");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:HL,datasets:['
        '{label:"2024",data:' + to_xy(d['cog_2024'])   + ',borderColor:"#B4B2A9",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2025",data:' + to_xy(d['cog_2025'])   + ',borderColor:"#378ADD",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2026",data:' + to_xy(d['cog_2026'])   + ',borderColor:"#0d6e4f",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,tension:0.3,parsing:false},'
        ']},options:histOpts});})();\n'
        '(function(){const el=document.getElementById("invTotUnits");if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:HL,datasets:['
        '{label:"2024",data:' + to_xy(d['units_2024']) + ',borderColor:"#B4B2A9",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2025",data:' + to_xy(d['units_2025']) + ',borderColor:"#378ADD",backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false},'
        '{label:"2026",data:' + to_xy(d['units_2026']) + ',borderColor:"#0d6e4f",backgroundColor:"transparent",borderWidth:2.5,pointRadius:3,tension:0.3,parsing:false},'
        ']},options:histOpts});})();\n'
        'const stOpts={responsive:true,maintainAspectRatio:false,'
        'plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.dataset.label+": "+c.parsed.y.toFixed(1)+"%"}}},'
        'scales:{x:{type:"category",ticks:{font:{size:9},maxRotation:45,callback:function(v,i){return i%4===0?this.getLabelForValue(v):"";}}},y:{min:0,max:100,ticks:{callback:v=>v+"%",font:{size:9}}}}};\n'
        'const SL=Array.from({length:52},(_,i)=>"Wk "+(i+1));\n'
        'function mkST(id,ds){const el=document.getElementById(id);if(!el)return;'
        'new Chart(el,{type:"line",data:{labels:SL,datasets:ds.map(d=>{return{label:d.l,data:d.d,'
        'borderColor:d.c,backgroundColor:"transparent",borderWidth:2,pointRadius:3,tension:0.3,parsing:false};})},'
        'options:stOpts});}\n'
        'mkST("invSSSellThru",['
        '{l:"S24",d:' + st_xy(d['st_s24']) + ',c:"#B4B2A9"},'
        '{l:"S25",d:' + st_xy(d['st_s25']) + ',c:"#378ADD"},'
        '{l:"S26",d:' + st_xy(d['st_s26']) + ',c:"#0d6e4f"}]);\n'
        'mkST("invFWSellThru",['
        '{l:"F24",d:' + st_xy(d['st_f24']) + ',c:"#B4B2A9"},'
        '{l:"F25",d:' + st_xy(d['st_f25']) + ',c:"#BA7517"},'
        '{l:"F26",d:' + st_xy(d['st_f26']) + ',c:"#a82f2f"}]);\n'
    )

# ── HTML assembly ─────────────────────────────────────────────────────────────

def kpi(label, value, sub, sub2=None, sub2_cls='neg'):
    s2 = ('<div class="kpi-sub ' + sub2_cls + '" style="margin-top:2px">' + sub2 + '</div>') if sub2 else ''
    return ('<div class="kpi"><div class="kpi-label">' + label + '</div>'
            '<div class="kpi-value">' + value + '</div>'
            '<div class="kpi-sub">' + sub + '</div>' + s2 + '</div>')

def card(title, body):
    return ('    <div class="card">\n'
            '      <div class="card-title">' + title + '</div>\n'
            + body +
            '    </div>\n')

def two_col(left, right):
    return ('  <div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px;margin-bottom:28px">\n'
            '    <div>\n' + left + '    </div>\n'
            + right + '\n'
            '  </div>\n')

def sec_label(txt):
    return ('  <div style="font-family:var(--mono);font-size:12px;font-weight:700;'
            'letter-spacing:.12em;text-transform:uppercase;color:var(--ink);'
            'background:#dedad2;border-left:5px solid var(--ink);padding:11px 32px;'
            'margin-bottom:24px;margin-left:-32px;margin-right:-32px;display:block">'
            + txt + '</div>\n')

def build_html(d):
    WK  = d['week']
    rev = d['rev']; cogs = d['cogs']; opex = d['opex']
    net_var = d['net_inc_var']
    ahead   = net_var >= 0
    pill_style = ('style="background:#fce8e8;color:#a82f2f;border-color:#f0c0c0"'
                  if not ahead else '')
    pill_txt   = 'YTD ahead of plan' if ahead else 'YTD behind plan'

    pl_c, rev_c, cogs_c, opex_c, cf_c, inv_c = generate_callouts(d)

    # Revenue table
    rev_tbl = COL_HDR
    for item in d['rev_lines']: rev_tbl += trow(*item)
    rev_tbl += trow("Total Revenue", rev['act'], rev['plan'], rev['ann_plan'], rev['ann_proj'], is_total=True)

    # COGS table
    cogs_tbl = COL_HDR
    for item in d['cogs_lines']: cogs_tbl += trow(*item, is_cost=True)
    cogs_tbl += trow("Total COGS + Labor + Shipping",
                     cogs['act'], cogs['plan'], cogs['ann_plan'], cogs['ann_proj'],
                     is_cost=True, is_total=True)

    # OpEx table
    opex_tbl = COL_HDR
    for item in d['opex_lines']: opex_tbl += trow(*item)
    opex_tbl += trow("Total OpEx", opex['act'], opex['plan'], opex['ann_plan'], opex['ann_proj'], is_total=True)

    # CF tables
    cf = d['cf']
    def p(k): return cf[k][-1] if cf[k] else 0
    cin_tbl = COL_HDR
    for lbl, act_k, proj_k in [("Wholesale",'cin_w','proj_w'),("DTC",'cin_d','proj_d'),("INK",'cin_i','proj_i')]:
        act=p(act_k); prj=p(proj_k)
        cin_tbl += trow(lbl, act, prj, 0, act+(act-prj))
    cin_act=p('cin_t'); cin_prj=p('proj_w')+p('proj_d')+p('proj_i')
    cin_tbl += trow("Total cash in", cin_act, cin_prj, 0, cin_act+(cin_act-cin_prj), is_total=True)

    cout_tbl = COL_HDR
    for lbl, act_k, proj_k in [("COGS — brand",'cout_b','proj_b'),("COGS — INK",'cout_i','proj_i2'),("Other COGS + shipping",'cout_o','proj_o')]:
        act=p(act_k); prj=p(proj_k)
        cout_tbl += trow(lbl, act, prj, 0, act+(act-prj), is_cost=True)
    cout_act=p('cout_b')+p('cout_i')+p('cout_o'); cout_prj=p('proj_b')+p('proj_i2')+p('proj_o')
    cout_tbl += trow("Total cash out", cout_act, cout_prj, 0, cout_act+(cout_act-cout_prj), is_cost=True, is_total=True)

    # On Order card
    oo=d['on_order']; h1_wks=d['whsl_h1_wks_left']
    h1_rem=d['whsl_h1_rem_plan']; h2_plan=d['whsl_h2_plan']
    h1_open_vs=oo['h1']-h1_rem; h2_pct=oo['h2']/h2_plan*100 if h2_plan else 0
    whsl_act=d['whsl_act']; h1_proj=whsl_act+oo['h1']; h1_gap=d['whsl_h1_gap']
    gap_clr = '#0d6e4f' if h1_gap<=0 else '#a82f2f'
    gap_disp= vk(-h1_gap) if h1_gap>0 else '+'+fk(abs(h1_gap))
    h1ov_clr= '#0d6e4f' if h1_open_vs>=0 else '#a82f2f'

    oo_card = (
        '  <div class="card" style="margin-bottom:28px">\n'
        '    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--rule)">\n'
        '      <div><div class="card-title" style="margin-bottom:2px">Open orders — on order, not yet shipped or invoiced</div>\n'
        '      <div style="font-size:11px;color:var(--ink-muted);font-family:var(--mono)">As of Week ' + str(WK) + ' · Retail orders including discounts applied</div></div>\n'
        '      <div style="font-family:var(--mono);font-size:11px;color:var(--ink-muted)">Total on order: <span style="color:var(--ink);font-weight:600">' + fk(oo['total']) + '</span></div>\n'
        '    </div>\n'
        '    <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px">\n'
        '      <div>\n'
        '        <div style="display:flex;gap:6px;padding-bottom:6px;font-size:10px;color:var(--ink-muted);font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--rule)">\n'
        '          <span style="flex:1">Period</span><span style="width:72px;text-align:right">Wks Left</span>'
        '<span style="width:105px;text-align:right">On Order</span><span style="width:120px;text-align:right">vs Remaining Plan</span>\n'
        '        </div>\n'
        '        <div style="display:flex;gap:6px;padding:7px 0;border-bottom:1px solid var(--rule)">\n'
        '          <span style="flex:1;font-size:12px;color:var(--ink)">H1 (ends Jul 4)</span>\n'
        '          <span style="width:72px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-muted)">' + str(h1_wks) + ' wks</span>\n'
        '          <span style="width:105px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink)">' + fk(oo['h1']) + '</span>\n'
        '          <span style="width:120px;text-align:right;font-family:var(--mono);font-size:11px;color:' + h1ov_clr + ';font-weight:600">' + vk(h1_open_vs) + ' vs plan</span>\n'
        '        </div>\n'
        '        <div style="display:flex;gap:6px;padding:7px 0;border-bottom:1px solid var(--rule)">\n'
        '          <span style="flex:1;font-size:12px;color:var(--ink)">H2 (Jul 5 – Dec 31)</span>\n'
        '          <span style="width:72px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-muted)">26 wks</span>\n'
        '          <span style="width:105px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink)">' + fk(oo['h2']) + '</span>\n'
        '          <span style="width:120px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-muted)">' + f'{h2_pct:.1f}' + '% of H2 plan</span>\n'
        '        </div>\n'
        '        <div style="display:flex;gap:6px;padding:8px 0 2px;border-top:1.5px solid var(--ink);margin-top:2px">\n'
        '          <span style="flex:1;font-size:12px;font-weight:600;color:var(--ink)">Total on order</span>\n'
        '          <span style="width:72px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-muted)">35 wks</span>\n'
        '          <span style="width:105px;text-align:right;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink)">' + fk(oo['total']) + '</span>\n'
        '          <span style="width:120px"></span>\n'
        '        </div>\n'
        '      </div>\n'
        '      <div>\n'
        '        <div style="font-size:10px;font-family:var(--mono);font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-muted);margin-bottom:10px">H1 wholesale gap analysis</div>\n'
        '        <table style="width:100%;font-family:var(--mono);font-size:11px;border-collapse:collapse;margin-bottom:14px">\n'
        '          <tr style="border-bottom:1px solid var(--rule)"><td style="padding:5px 0;color:var(--ink-muted)">H1 total plan (wks 1–26)</td><td style="text-align:right">' + fk(d['whsl_h1_plan']) + '</td></tr>\n'
        '          <tr style="border-bottom:1px solid var(--rule)"><td style="padding:5px 0;color:var(--ink-muted)">YTD actual (wks 1–' + str(WK) + ')</td><td style="text-align:right;color:#a82f2f;font-weight:600">' + fk(whsl_act) + '</td></tr>\n'
        '          <tr style="border-bottom:1px solid var(--rule)"><td style="padding:5px 0;color:var(--ink-muted)">H1 open orders (wks ' + str(WK+1) + '–26)</td><td style="text-align:right">' + fk(oo['h1']) + '</td></tr>\n'
        '          <tr style="border-bottom:1px solid var(--rule)"><td style="padding:5px 0;color:var(--ink-muted)">H1 projected total</td><td style="text-align:right;font-weight:600">' + fk(h1_proj) + '</td></tr>\n'
        '          <tr style="border-top:1.5px solid #BA7517"><td style="padding:7px 0 2px;font-weight:600">H1 gap to plan</td>'
        '<td style="text-align:right;font-weight:700;color:' + gap_clr + ';font-size:12px">' + gap_disp + '</td></tr>\n'
        '        </table>\n'
        '        <div style="padding:10px 12px;background:#fef9ec;border-left:3px solid #BA7517;border-radius:0 4px 4px 0;font-size:11px;line-height:1.6">\n'
        '          <span style="font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#BA7517;display:block;margin-bottom:4px">Action required</span>\n'
        '          Wholesale reps must actively sell AO during S27 road shows starting June 1. '
        'KONA, Sun Cruiser, Stone Pony, and Ron Jon\'s collab invoices are in the WIP pipeline and represent meaningful upside.\n'
        '        </div>\n'
        '      </div>\n'
        '    </div>\n'
        '  </div>\n'
    )

    # Inventory
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
        delta_c = tc - prev_c; delta_u = tu - prev_u
        delta_c_str = ('+' if delta_c>=0 else '') + fk(delta_c) + ' vs prev wk'
    else:
        tc=tu=delta_c=delta_u=0; yoy_cog_str=yoy_u_str=st_diff_str=delta_c_str=''

    legend_3yr = (
        '      <div style="display:flex;gap:16px;font-size:11px;color:var(--ink-muted)">\n'
        '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#B4B2A9;display:inline-block"></span>2024</span>\n'
        '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#378ADD;display:inline-block"></span>2025</span>\n'
        '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#0d6e4f;display:inline-block"></span>2026</span>\n'
        '      </div>'
    )
    cf_vs  = cin_act - (p('proj_w')+p('proj_d')+p('proj_i'))

    CSS = '''
:root{--surface:#f7f5f0;--ink:#1a1a18;--ink-mid:#3a3a36;--ink-muted:#888780;--rule:#dedad2;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--surface);color:var(--ink);font-size:13px;line-height:1.5}
.page{max-width:1200px;margin:0 auto;padding:40px 32px 80px}
.masthead{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:20px;border-bottom:1.5px solid var(--ink);margin-bottom:36px}
.masthead-left{display:flex;align-items:baseline;gap:12px}
.brand{font-size:28px;font-weight:700;letter-spacing:-.02em}
.dash-title{font-size:28px;font-weight:300;color:var(--ink-muted)}
.week-badge{background:var(--ink);color:#fff;font-family:var(--mono);font-size:13px;padding:4px 10px;border-radius:3px;font-weight:500}
.meta{font-family:var(--mono);font-size:12px;color:var(--ink-muted);letter-spacing:.04em}
.status-pill{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;padding:5px 12px;border:1.5px solid #b8ddd0;border-radius:3px;color:#0d6e4f;background:#eaf4ef}
.card{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:16px 18px}
.card-title{font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--rule)}
.kpi-row{display:grid;gap:12px}.kpi-row.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi-row.cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.kpi{background:#fff;border:1px solid var(--rule);border-radius:4px;padding:14px 16px}
.kpi-label{font-family:var(--mono);font-size:10px;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.kpi-value{font-size:28px;font-weight:700;letter-spacing:-.02em;margin-bottom:4px}
.kpi-sub{font-family:var(--mono);font-size:11px;color:var(--ink-muted)}
.pos{color:#0d6e4f}.neg{color:#a82f2f}.neu{color:var(--ink-muted)}
.ch-row{display:flex;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule);font-size:12px}
.ch-name{flex:1;color:var(--ink)}
.chart-wrap{position:relative;width:100%}
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;700&display=swap');
'''

    return (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
        '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
        '<title>Jetty Strategic Dashboard 2026 — Week ' + str(WK) + '</title>\n'
        '<style>' + CSS + '</style>\n</head>\n<body>\n'
        '<div class="page">\n\n'
        '  <div class="masthead">\n'
        '    <div class="masthead-left">\n'
        '      <span class="brand">Jetty</span>\n'
        '      <span class="dash-title">/ Strategic Dashboard</span>\n'
        '      <span class="week-badge">Week ' + str(WK) + ' <span style="color:rgba(255,255,255,.5);font-weight:400">of 52</span></span>\n'
        '      <span class="meta">2026 · YTD Cumulative</span>\n'
        '    </div>\n'
        '    <span class="status-pill" ' + pill_style + '>' + pill_txt + '</span>\n'
        '  </div>\n\n'

        + sec_label("P&amp;L Summary") +
        two_col(
            '  <div class="kpi-row cols-3" style="margin-bottom:12px">\n'
            '    ' + kpi("Total revenue", fk(rev['act']),
                          ('+' if rev['var']>=0 else '') + fk(rev['var']) + ' vs plan') + '\n'
            '    ' + kpi("COGS + labor + shipping", fk(cogs['act']),
                          fk(cogs['var']) + (' favorable' if cogs['var']<0 else ' over') + ' vs plan') + '\n'
            '    ' + kpi("Total OpEx", fk(opex['act']),
                          ('+' if opex['var']>=0 else '') + fk(opex['var']) + ' vs plan') + '\n'
            '  </div>\n'
            '  <div class="kpi-row cols-2">\n'
            '    ' + kpi("Full-year revenue plan", fk(rev['ann_plan']), "52-week annual budget") + '\n'
            '    ' + kpi("Full-year revenue projection", fk(rev['ann_proj']),
                          ('above' if rev['ann_proj']>=rev['ann_plan'] else 'below') + ' annual plan',
                          vk(rev['ann_var']) + ' vs annual plan',
                          'pos' if rev['ann_proj']>=rev['ann_plan'] else 'neg') + '\n'
            '  </div>\n',
            pl_c
        )

        + sec_label("Revenue Channels — YTD &amp; Full Year")
        + two_col(card("Revenue by channel", rev_tbl), rev_c)

        + oo_card

        + sec_label("COGS + Labor + Shipping — YTD &amp; Full Year")
        + two_col(card("Cost detail", cogs_tbl), cogs_c)

        + sec_label("Operating Expenses — YTD &amp; Full Year")
        + two_col(card("OpEx by category", opex_tbl), opex_c)

        + sec_label("Cash Flow — YTD &amp; Full Year")
        + two_col(
            '  ' + kpi("Total cash in — YTD actual", fk(cin_act),
                        ('ahead of' if cf_vs>=0 else 'behind') + ' projection by ' + fk(abs(cf_vs))) + '\n'
            '  <div style="margin-bottom:8px;margin-top:16px;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted)">Cash in — actual vs projected</div>\n'
            '  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px">\n'
            '    <div class="card"><div class="card-title">Wholesale</div><div class="chart-wrap" style="height:140px"><canvas id="ciWholesale"></canvas></div></div>\n'
            '    <div class="card"><div class="card-title">DTC</div><div class="chart-wrap" style="height:140px"><canvas id="ciDTC"></canvas></div></div>\n'
            '    <div class="card"><div class="card-title">INK</div><div class="chart-wrap" style="height:140px"><canvas id="ciINK"></canvas></div></div>\n'
            '  </div>\n'
            '  <div style="margin-bottom:8px;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted)">Cash out — actual vs projected</div>\n'
            '  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px">\n'
            '    <div class="card"><div class="card-title">COGS — brand</div><div class="chart-wrap" style="height:140px"><canvas id="coCOGSBrand"></canvas></div></div>\n'
            '    <div class="card"><div class="card-title">COGS — INK</div><div class="chart-wrap" style="height:140px"><canvas id="coCOGSINK"></canvas></div></div>\n'
            '    <div class="card"><div class="card-title">Other COGS + shipping</div><div class="chart-wrap" style="height:140px"><canvas id="coOther"></canvas></div></div>\n'
            '  </div>\n'
            + card("Cumulative cash in vs. cash out",
                   '      <div class="chart-wrap" style="height:190px"><canvas id="cfChart"></canvas></div>\n')
            + card("Cash in by channel",   cin_tbl)
            + card("Cash out by category", cout_tbl),
            cf_c
        )

        + sec_label("Inventory Analysis")
        + '  <div class="kpi-row cols-2" style="margin-bottom:16px">\n'
          '    ' + kpi("Total inventory COG — Week " + str(lw or WK) + pend_note,
                        fk(tc) if tc else '—', delta_c_str or '—',
                        yoy_cog_str or None, 'neg') + '\n'
          '    ' + kpi("Total units on hand — Week " + str(lw or WK) + pend_note,
                        (format(tu, ',') if tu else '—'), yoy_u_str or '—') + '\n'
          '  </div>\n'

        + '  <div class="card" style="margin-bottom:16px">\n'
          '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--rule)">\n'
          '      <div><div class="card-title" style="margin-bottom:0;padding-bottom:0;border-bottom:none">Total Inventory COG — Week by Week</div>\n'
          '      <div style="font-family:var(--mono);font-size:11px;margin-top:4px"><span style="color:#a82f2f;font-weight:600">' + yoy_cog_str + '</span></div></div>\n'
          + legend_3yr + '\n'
          '    </div>\n'
          '    <div class="chart-wrap" style="height:280px"><canvas id="invHistCOG"></canvas></div>\n'
          '  </div>\n'

        + '  <div class="card" style="margin-bottom:16px">\n'
          '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--rule)">\n'
          '      <div><div class="card-title" style="margin-bottom:0;padding-bottom:0;border-bottom:none">Total Units on Hand — Week by Week</div>\n'
          '      <div style="font-family:var(--mono);font-size:11px;margin-top:4px"><span style="color:#a82f2f;font-weight:600">' + yoy_u_str + '</span></div></div>\n'
          + legend_3yr + '\n'
          '    </div>\n'
          '    <div class="chart-wrap" style="height:280px"><canvas id="invTotUnits"></canvas></div>\n'
          '  </div>\n'

        + '  <div class="card" style="margin-bottom:16px">\n'
          '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--rule)">\n'
          '      <div><div class="card-title" style="margin-bottom:0;padding-bottom:0;border-bottom:none">Spring / Summer Sell-Through % — by Week</div>\n'
          '      <div style="font-family:var(--mono);font-size:11px;margin-top:4px"><span style="color:#a82f2f;font-weight:600">' + st_diff_str + '</span></div></div>\n'
          '      <div style="display:flex;gap:16px">\n'
          '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#B4B2A9;display:inline-block"></span><span style="font-size:11px;color:var(--ink-muted)">S24</span></span>\n'
          '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#378ADD;display:inline-block"></span><span style="font-size:11px;color:var(--ink-muted)">S25</span></span>\n'
          '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#0d6e4f;display:inline-block"></span><span style="font-size:11px;color:var(--ink-muted)">S26</span></span>\n'
          '      </div>\n'
          '    </div>\n'
          '    <div class="chart-wrap" style="height:260px"><canvas id="invSSSellThru"></canvas></div>\n'
          '  </div>\n'

        + '  <div class="card" style="margin-bottom:24px">\n'
          '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--rule)">\n'
          '      <div class="card-title" style="margin-bottom:0;padding-bottom:0;border-bottom:none">Fall / Winter Sell-Through % — by Week</div>\n'
          '      <div style="display:flex;gap:16px">\n'
          '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#B4B2A9;display:inline-block"></span><span style="font-size:11px;color:var(--ink-muted)">F24</span></span>\n'
          '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#BA7517;display:inline-block"></span><span style="font-size:11px;color:var(--ink-muted)">F25</span></span>\n'
          '        <span style="display:flex;align-items:center;gap:4px"><span style="width:24px;height:2px;background:#a82f2f;display:inline-block"></span><span style="font-size:11px;color:var(--ink-muted)">F26</span></span>\n'
          '      </div>\n'
          '    </div>\n'
          '    <div class="chart-wrap" style="height:260px"><canvas id="invFWSellThru"></canvas></div>\n'
          '  </div>\n'

        + '  <div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px;margin-bottom:28px">\n'
          '    <div>\n'
          '      <div class="card">\n'
          '        <div class="card-title">Inventory breakdown — week ' + str(lw or WK) + pend_note + '</div>\n'
          + build_inv_table(d) + '\n'
          '      </div>\n'
          '    </div>\n'
          + inv_c + '\n'
          '  </div>\n\n'

        + '</div>\n'
          '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>\n'
          '<script>\n'
          + build_chart_js(d)
          + '</script>\n</body>\n</html>'
    )

# ── Password gate ─────────────────────────────────────────────────────────────

GATE_PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jetty Strategic Dashboard 2026</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#f7f5f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.gate{background:#fff;border:1px solid #dedad2;border-radius:6px;padding:44px 48px;width:380px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.07)}
.brand{font-size:28px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px}
.sub{font-size:11px;color:#888780;margin-bottom:32px;font-family:'DM Mono',monospace;letter-spacing:.07em;text-transform:uppercase}
input{width:100%;padding:12px 14px;border:1.5px solid #dedad2;border-radius:3px;font-size:15px;font-family:'DM Mono',monospace;letter-spacing:.12em;margin-bottom:12px;outline:none;text-align:center;background:#f7f5f0;color:#1a1a18}
input:focus{border-color:#1a1a18;background:#fff}
button{width:100%;padding:12px;background:#1a1a18;color:#fff;border:none;border-radius:3px;font-size:13px;font-weight:500;cursor:pointer}
button:hover{background:#2d2d2a}
.err{color:#a82f2f;font-size:11px;font-family:'DM Mono',monospace;margin-top:10px;display:none}
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700&display=swap');
</style>
</head>
<body>
<div class="gate">
  <div class="brand">Jetty</div>
  <div class="sub">Strategic Dashboard &middot; 2026</div>
  <input type="password" id="pw" placeholder="Password" onkeydown="if(event.key==='Enter')check()">
  <button onclick="check()">View Dashboard</button>
  <div class="err" id="err">Incorrect password</div>
</div>
<script>
const H="HASH_GOES_HERE";
async function sha256(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');}
async function check(){const h=await sha256(document.getElementById('pw').value);if(h===H){sessionStorage.setItem('jd_auth',h);location.reload();}else{document.getElementById('err').style.display='block';document.getElementById('pw').value='';document.getElementById('pw').focus();}}
document.getElementById('pw').focus();
</script>
</body>
</html>'''

def apply_gate(html, password):
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    gate = GATE_PAGE.replace('HASH_GOES_HERE', pw_hash)
    # Escape for JS template literal
    gate_esc = gate.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')
    check_js = (
        '<script>\n'
        '(function(){\n'
        '  var H="' + pw_hash + '";\n'
        '  if(sessionStorage.getItem("jd_auth")!==H){\n'
        '    document.open();\n'
        '    document.write(`' + gate_esc + '`);\n'
        '    document.close();\n'
        '  }\n'
        '})();\n'
        '</script>\n'
    )
    return html.replace('<body>\n', '<body>\n' + check_js, 1)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Reading data...")
    d = read_all()
    print("Week " + str(d['week']) + " data loaded")
    print("Building dashboard...")
    html = build_html(d)
    password = os.environ.get("DASHBOARD_PASSWORD", "")
    if password:
        html = apply_gate(html, password)
        print("Password gate applied")
    else:
        print("WARNING: No DASHBOARD_PASSWORD set")
    os.makedirs("output", exist_ok=True)
    with open("output/index.html", "w") as f:
        f.write(html)
    size = os.path.getsize("output/index.html") / 1024
    print("Done — output/index.html written (" + f'{size:.1f}' + " KB)")

if __name__ == "__main__":
    main()
