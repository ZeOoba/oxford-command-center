/* ORA Command Center — canonical data layer (Oxford Realty Advisors).
   Single source of truth. Shallow-bay industrial & flex, Class B/C,
   ~629k SF, 170 tenants, 5 markets, 3 third-party PMs, low leverage.
   Every page reads from window.ORA so figures reconcile; detail pages
   bind to ?id=; Studio shares this dataset. */
window.ORA = (function () {
  // [id,name,region(market),type(subtype),value$M,occ%,cap%,units(tenants),sf,ltv%,rate%,built,reno,status,pmId,rentPSF,mktPSF]
  var PROP_RAW = [
    ['eastgate-commerce','Eastgate Commerce Center','Eastgate','Flex',7.2,93,7.4,20,52000,35,4.5,1999,'2019','Stabilized','cardinal',12.5,13.5],
    ['eastgate-bay12','Eastgate Bay 12','Eastgate','Industrial',4.6,96,7.6,6,38000,0,0,1992,'—','Stabilized','cardinal',8.0,8.5],
    ['riverside-flex-park','Riverside Flex Park','Riverside','Flex',8.6,90,7.2,24,60000,38,4.4,2003,'2020','Stabilized','summit',11.5,13.0],
    ['riverside-logistics','Riverside Logistics','Riverside','Industrial',5.8,100,7.0,4,44000,30,4.2,2010,'—','Stabilized','summit',9.0,9.2],
    ['lakewood-ind-1','Lakewood Industrial I','Lakewood','Industrial',5.0,95,7.5,7,41000,0,0,1996,'—','Stabilized','harbor-point',7.5,8.2],
    ['lakewood-ind-2','Lakewood Industrial II','Lakewood','Industrial',4.1,88,7.8,5,36000,42,4.7,1989,'2017','Watch','harbor-point',7.0,8.0],
    ['lakewood-flex','Lakewood Flex','Lakewood','Flex',4.7,92,7.3,12,34000,30,4.5,2001,'2018','Stabilized','harbor-point',12.0,12.8],
    ['southport-business-park','Southport Business Park','Southport','Flex',7.9,91,7.4,22,56000,35,4.5,2004,'2021','Stabilized','cardinal',12.2,13.2],
    ['southport-yard','Southport Yard','Southport','Industrial',3.6,100,7.1,3,30000,0,0,2008,'—','Stabilized','cardinal',8.5,8.8],
    ['tricounty-commerce','Tri-County Commerce','Tri-County','Flex',6.5,89,7.7,20,48000,33,4.6,2000,'2019','Watch','harbor-point',11.8,13.0],
    ['tricounty-distribution','Tri-County Distribution','Tri-County','Industrial',6.8,97,6.9,4,50000,40,4.3,2013,'—','Stabilized','harbor-point',8.8,9.0],
    ['cardinal-service-center','Cardinal Service Center','Eastgate','Flex',3.4,86,8.0,10,28000,0,0,1994,'2016','Watch','cardinal',13.0,14.0],
    ['meridian-shallow-bay','Meridian Shallow-Bay','Riverside','Industrial',4.2,94,7.6,8,33000,30,4.4,1998,'—','Stabilized','summit',8.2,9.0],
    ['harbor-flex-suites','Harbor Flex Suites','Lakewood','Flex',3.5,90,7.9,10,26000,35,4.6,2005,'2020','Stabilized','harbor-point',12.8,13.5],
    ['southgate-industrial','Southgate Industrial','Southport','Industrial',3.7,98,7.2,5,29000,0,0,2011,'—','Stabilized','cardinal',7.8,8.4],
    ['northline-flex','Northline Flex','Tri-County','Flex',3.0,87,8.1,10,24000,38,4.7,1997,'2018','Watch','harbor-point',12.5,14.0]
  ];
  var PF = ['id','name','region','type','value','occ','cap','units','sf','ltv','rate','year','reno','status','pmId','rentPSF','mktPSF'];
  var PROPERTIES = PROP_RAW.map(function (r) {
    var o = {}; PF.forEach(function (f, i) { o[f] = r[i]; });
    o.market = o.region; o.subtype = o.type;
    o.noi = +(o.value * o.cap / 100).toFixed(3);   // $M / yr
    o.debt = +(o.value * o.ltv / 100).toFixed(2);   // $M (0 = unencumbered)
    o.rentGapPct = +((o.mktPSF - o.rentPSF) / o.rentPSF * 100).toFixed(1);
    return o;
  });

  // ===== modeled operating history (monthly, since acquisition) =====
  // Every asset carries a deterministic monthly series — revenue, the full
  // opex stack (tax / insurance / R&M / utilities / mgmt / other), NOI,
  // occupancy, rent and value — plus a smooth budget plan. The latest point
  // reconciles exactly to the canonical figures above and to the Property
  // operating statement, so multi-year trends and anomalies are computed,
  // not asserted. A short 12-month `hist` is derived for the period control.
  var MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var BASE_Y = 2026, BASE_M = 4;             // last closed month = May 2026
  function mkMonth(gi, y, m) {
    return { gi: gi, y: y, m: m, label: MN[m] + " '" + String(y).slice(2), short: MN[m],
      q: 'Q' + (Math.floor(m / 3) + 1) + " '" + String(y).slice(2), qi: y * 4 + Math.floor(m / 3), year: y };
  }
  function seedRand(str) {                    // mulberry32 seeded by id → stable
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return function () { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  }
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
  function clampOcc(v) { return Math.max(80, Math.min(100, +(+v).toFixed(1))); }

  // ownership length per asset (years) → how far each series runs back
  PROPERTIES.forEach(function (p) {
    var h = hashStr(p.id);
    var years = 3 + (h % 6);                            // 3..8 years owned
    var am = Math.floor(h / 7) % 12;                    // acquisition calendar month
    p._ownMonths = years * 12 + ((BASE_M - am + 12) % 12);
  });
  var maxBack = 0; PROPERTIES.forEach(function (p) { if (p._ownMonths > maxBack) maxBack = p._ownMonths; });

  // shared global monthly timeline (earliest acquisition → May 2026)
  var GLOBAL_MONTHS = [];
  for (var gk = maxBack; gk >= 0; gk--) {
    var gm = BASE_M - gk, gy = BASE_Y;
    while (gm < 0) { gm += 12; gy -= 1; }
    GLOBAL_MONTHS.push(mkMonth(maxBack - gk, gy, gm));
  }
  var GLAST = GLOBAL_MONTHS.length - 1;                 // index of the base month

  var OPEX_LINES = [
    { k: 'tax', label: 'Property tax' }, { k: 'ins', label: 'Insurance' },
    { k: 'rm', label: 'Repairs & maint.' }, { k: 'util', label: 'Utilities' },
    { k: 'mgmt', label: 'Management fee' }, { k: 'other', label: 'Other / admin' }
  ];

  PROPERTIES.forEach(function (p) {
    var rnd = seedRand(p.id + '|hist'), N = GLAST + 1;
    var acqIdx = GLAST - p._ownMonths;
    p.acqIdx = acqIdx; p.acqYear = GLOBAL_MONTHS[acqIdx].y; p.ownYears = +((p._ownMonths) / 12).toFixed(1);

    // present ($/mo) targets — reconcile to the operating statement (64% margin)
    var noiMo = p.noi * 1e6 / 12, egi = noiMo / 0.64, opexTot = egi - noiMo;
    var T = { rev: egi, tax: opexTot * 0.30, ins: opexTot * 0.13, rm: opexTot * 0.19, util: opexTot * 0.16, mgmt: opexTot * 0.12, other: opexTot * 0.10 };

    var gRev = 0.030 + rnd() * 0.020, gTax = 0.060 + rnd() * 0.045, gIns = 0.090 + rnd() * 0.080,
        gRm = 0.030 + rnd() * 0.025, gUtil = 0.030 + rnd() * 0.030, gOth = 0.020 + rnd() * 0.020, gVal = 0.020 + rnd() * 0.035;
    var taxMonth = Math.floor(rnd() * 12), insMonth = Math.floor(rnd() * 12);
    function mg(g) { return Math.pow(1 + g, 1 / 12) - 1; }
    function blank() { return new Array(N).fill(null); }
    function scaleTo(a, target) { var f = target / a[GLAST]; for (var i = acqIdx; i <= GLAST; i++) a[i] = a[i] * f; return a; }
    function smooth(g) { var a = blank(); a[acqIdx] = 1; for (var i = acqIdx + 1; i <= GLAST; i++) a[i] = a[i - 1] * (1 + mg(g)); return a; }

    // ---- occupancy: mean-reverting, with a genuine recent slide on Watch assets ----
    var occ = blank(), lvl = Math.min(98, Math.max(86, p.occ + (rnd() * 4 - 1)));
    occ[acqIdx] = clampOcc(lvl + (rnd() * 3 - 1.5));
    for (var i = acqIdx + 1; i <= GLAST; i++) {
      var revert = (lvl - occ[i - 1]) * 0.18, seas = Math.sin(GLOBAL_MONTHS[i].m / 12 * 2 * Math.PI) * 0.4;
      occ[i] = clampOcc(occ[i - 1] + revert + seas + (rnd() * 1.4 - 0.7));
    }
    if (p.status === 'Watch') { var kk = 2 + Math.floor(rnd() * 2); for (var s = 1; s <= kk; s++) occ[GLAST - s] = clampOcc(p.occ + s * (0.8 + rnd() * 1.3)); }
    else { occ[GLAST - 1] = clampOcc(p.occ - (0.1 + rnd() * 0.8)); }
    occ[GLAST] = p.occ;

    // ---- rents ----
    var rentIn = blank(), rentMkt = blank();
    rentIn[GLAST] = p.rentPSF; rentMkt[GLAST] = p.mktPSF;
    for (var i = GLAST - 1; i >= acqIdx; i--) { rentIn[i] = +(rentIn[i + 1] / (1 + mg(gRev))).toFixed(2); rentMkt[i] = +(rentMkt[i + 1] / (1 + mg(gRev * 0.9))).toFixed(2); }

    // ---- revenue: trend × occupancy factor + light noise ----
    var rev = blank(), rt = smooth(gRev);
    for (var i = acqIdx; i <= GLAST; i++) rev[i] = rt[i] * (occ[i] / p.occ) * (1 + (rnd() * 0.02 - 0.01));
    scaleTo(rev, T.rev);

    // ---- tax & insurance: flat with an annual renewal step (a real MoM jump) ----
    function stepLine(g, renewM, hardMkt) {
      var a = blank(), L = 1; a[acqIdx] = L;
      for (var i = acqIdx + 1; i <= GLAST; i++) {
        if (GLOBAL_MONTHS[i].m === renewM) { var bump = g + (rnd() * 0.02 - 0.01); if (hardMkt && i > GLAST - 24) bump += hardMkt; L *= (1 + bump); }
        a[i] = L * (1 + (rnd() * 0.01 - 0.005));
      }
      return a;
    }
    var tax = scaleTo(stepLine(gTax, taxMonth, 0.012), T.tax);
    var ins = scaleTo(stepLine(gIns, insMonth, 0.035), T.ins);

    // ---- R&M lumpy (1–2 one-off spikes), utilities seasonal, mgmt ∝ revenue ----
    var rm = smooth(gRm), nSpk = 1 + Math.floor(rnd() * 2);
    for (var s2 = 0; s2 < nSpk; s2++) { var si = acqIdx + 6 + Math.floor(rnd() * Math.max(1, GLAST - acqIdx - 8)); if (si >= acqIdx && si <= GLAST) rm[si] *= (1.5 + rnd() * 0.9); }
    scaleTo(rm, T.rm);
    var util = blank(), ut = smooth(gUtil);
    for (var i = acqIdx; i <= GLAST; i++) util[i] = ut[i] * (1 + 0.14 * Math.cos(2 * Math.PI * GLOBAL_MONTHS[i].m / 6)) * (1 + (rnd() * 0.02 - 0.01));
    scaleTo(util, T.util);
    var mgmt = blank(); for (var i = acqIdx; i <= GLAST; i++) mgmt[i] = rev[i]; scaleTo(mgmt, T.mgmt);
    var other = smooth(gOth); for (var i = acqIdx; i <= GLAST; i++) other[i] = other[i] * (1 + (rnd() * 0.02 - 0.01)); scaleTo(other, T.other);

    // ---- opex / NOI / value / cap ----
    var opex = blank(), noi = blank(), value = smooth(gVal), cap = blank();
    scaleTo(value, p.value);
    for (var i = acqIdx; i <= GLAST; i++) {
      opex[i] = tax[i] + ins[i] + rm[i] + util[i] + mgmt[i] + other[i];
      noi[i] = rev[i] - opex[i];
      cap[i] = value[i] > 0 ? (noi[i] * 12) / (value[i] * 1e6) * 100 : null;
    }

    // ---- budget: smooth plan; expenses planned under actual so overruns flag ----
    function budgetLine(g, target, bias) { return scaleTo(smooth(g), target * bias); }
    var budget = {
      rev: budgetLine(gRev, T.rev, 1.0), tax: budgetLine(gTax * 0.6, T.tax, 0.93), ins: budgetLine(gIns * 0.5, T.ins, 0.87),
      rm: budgetLine(gRm, T.rm, 0.95), util: budgetLine(gUtil, T.util, 0.97), mgmt: budgetLine(gRev, T.mgmt, 1.0), other: budgetLine(gOth, T.other, 0.98)
    };
    budget.opex = blank(); budget.noi = blank();
    for (var i = acqIdx; i <= GLAST; i++) { budget.opex[i] = budget.tax[i] + budget.ins[i] + budget.rm[i] + budget.util[i] + budget.mgmt[i] + budget.other[i]; budget.noi[i] = budget.rev[i] - budget.opex[i]; }

    p.S = { rev: rev, tax: tax, ins: ins, rm: rm, util: util, mgmt: mgmt, other: other, opex: opex, noi: noi, occ: occ, rentIn: rentIn, rentMkt: rentMkt, value: value, cap: cap, budget: budget };

    // ---- derive the 12-month hist used by the global period control ----
    var h12 = { occ: [], rent: [], val: [], noi: [] };
    for (var i = GLAST - 11; i <= GLAST; i++) { h12.occ.push(occ[i]); h12.rent.push(rentIn[i]); h12.val.push(+value[i].toFixed(3)); h12.noi.push(+(noi[i] * 12 / 1e6).toFixed(3)); }
    p.hist = h12;
  });

  // last-12-months view + current index, for the global period control
  var MONTHS = GLOBAL_MONTHS.slice(GLAST - 11).map(function (m, i) { return { idx: i, m: m.m, y: m.y, label: m.label, short: m.short }; });
  var NOW = 11;

  // consecutive month-over-month declines / rises in `series` ending at `idx`
  function declineStreak(series, idx) { if (!series) return 0; var n = 0; for (var i = idx; i > 0; i--) { if (series[i] != null && series[i - 1] != null && series[i] < series[i - 1] - 0.05) n++; else break; } return n; }
  function riseStreak(series, idx) { if (!series) return 0; var n = 0; for (var i = idx; i > 0; i--) { if (series[i] != null && series[i - 1] != null && series[i] > series[i - 1] + 0.05) n++; else break; } return n; }
  function ordinal(n) { var s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // ---- third-party property managers ----
  var PMS = [
    { id: 'cardinal', name: 'Cardinal Property Mgmt', initials: 'CP', markets: ['Eastgate', 'Southport'],
      noiGrowth: 3.8, expGrowth: 2.1, collections: 98.2, retention: 84, woDays: 2.4 },
    { id: 'summit', name: 'Summit Commercial', initials: 'SC', markets: ['Riverside'],
      noiGrowth: 2.1, expGrowth: 4.6, collections: 95.1, retention: 78, woDays: 3.6 },
    { id: 'harbor-point', name: 'Harbor Point RE Services', initials: 'HP', markets: ['Lakewood', 'Tri-County'],
      noiGrowth: 4.4, expGrowth: 1.8, collections: 97.0, retention: 88, woDays: 2.0 }
  ];
  PMS.forEach(function (pm) {
    pm.assets = PROPERTIES.filter(function (p) { return p.pmId === pm.id; });
    pm.aum = +pm.assets.reduce(function (s, p) { return s + p.value; }, 0).toFixed(1);
    pm.sf = pm.assets.reduce(function (s, p) { return s + p.sf; }, 0);
    pm.tenants = pm.assets.reduce(function (s, p) { return s + p.units; }, 0);
  });

  var MARKETS = ['Eastgate', 'Riverside', 'Lakewood', 'Southport', 'Tri-County'];

  // ---- computed portfolio totals (so nothing can drift) ----
  function sum(a, f) { return a.reduce(function (s, d) { return s + f(d); }, 0); }
  var AUM = sum(PROPERTIES, function (d) { return d.value; });
  var NOI_YR = sum(PROPERTIES, function (d) { return d.noi; });
  var DEBT = sum(PROPERTIES, function (d) { return d.debt; });
  var TEN = sum(PROPERTIES, function (d) { return d.units; });
  var SF = sum(PROPERTIES, function (d) { return d.sf; });
  var OCC = sum(PROPERTIES, function (d) { return d.occ * d.value; }) / AUM;
  var CAPW = sum(PROPERTIES, function (d) { return d.cap * d.value; }) / AUM;
  var totals = {
    aum: AUM, noiYr: NOI_YR, noiMo: NOI_YR / 12, debt: DEBT, ltv: DEBT / AUM * 100,
    occ: OCC, cap: CAPW, units: TEN, tenants: TEN, sf: SF, walt: 3.8,
    assets: PROPERTIES.length, regions: MARKETS.length, markets: MARKETS.length,
    cash: 6.4, runway: 30  // treasury (not asset-derived); low-leverage operator
  };

  // ---- acquisition candidates (industrial / flex buy-box) ----
  var STAGES = ['Sourced', 'Under Review', 'LOI Sent', 'Due Diligence', 'Closing'];
  var DEAL_RAW = [
    ['eastgate-annex','Eastgate Annex','Eastgate','Flex',14,3.8,7.7,0],
    ['valley-shallow-bay','Valley Shallow-Bay','Tri-County','Industrial',5,6.2,8.0,0],
    ['riverside-flex-2','Riverside Flex II','Riverside','Flex',18,5.4,7.4,1],
    ['southport-distribution','Southport Distribution','Southport','Industrial',4,7.1,8.2,1],
    ['lakewood-service','Lakewood Service Center','Lakewood','Flex',12,3.2,7.6,2],
    ['meridian-logistics','Meridian Logistics','Riverside','Industrial',6,5.9,8.1,2],
    ['tricounty-flex-park','Tri-County Flex Park','Tri-County','Flex',20,6.6,7.9,3],
    ['harbor-industrial','Harbor Industrial','Lakewood','Industrial',5,4.7,7.5,3],
    ['eastgate-portfolio','Eastgate 3-Building Portfolio','Eastgate','Industrial',16,9.4,8.4,4]
  ];
  var SELLERS = ['Reyes & Partners', 'Watford Realty', 'Coastal Capital', 'Meridian Brokerage', 'Sutter Group'];
  var DEALS = DEAL_RAW.map(function (r, i) {
    var price = r[5], score = r[6], st = r[7];
    var capIn = +(9.6 - score * 0.30).toFixed(1);
    var totalCost = +(price * 1.05).toFixed(1);
    var equity = +(totalCost * 0.68).toFixed(1);   // low leverage → high equity
    var debt = +(totalCost - equity).toFixed(1);
    var irr = +(10 + score * 0.85 + st * 0.2).toFixed(1);
    var em = +(1.5 + score * 0.07).toFixed(1);
    var stabNOI = +(price * capIn / 100 * 1.16).toFixed(2);
    var exitCap = +(capIn - 0.3).toFixed(1);
    var exitVal = +(stabNOI / (exitCap / 100)).toFixed(1);
    return {
      id: r[0], name: r[1], region: r[2], type: r[3], units: r[4], price: price, score: score,
      stage: STAGES[st], stageIdx: st, seller: SELLERS[i % SELLERS.length],
      capIn: capIn, totalCost: totalCost, equity: equity, debt: debt, irr: irr, em: em,
      stabNOI: stabNOI, exitCap: exitCap, exitVal: exitVal
    };
  });

  // ---- ownership / co-invest capital (family-office, low-leverage) ----
  var INVESTORS = [
    { id: 'meridian-holdings', name: 'Meridian Holdings', initials: 'MH', type: 'Family office',
      since: 2019, contact: 'D. Whitfield', committed: 8.5, contributed: 7.2, distributed: 3.9, irr: 13.4,
      nav: 6.31, dpi: 0.54, tvpi: 1.41, openCall: { fund: 'Eastgate 3-Building JV', amount: 1.25, pct: 50, due: 'Jun 30' },
      holdings: [['Oxford Industrial Fund III', 'Vintage 2022 · 9 assets', 3.4], ['Oxford Industrial Fund II', 'Vintage 2019 · harvesting', 2.1], ['Eastgate 3-Building JV', 'Co-invest · committed', 2.5], ['Tri-County Distribution SPV', 'Co-invest · called 60%', 0.5]] },
    { id: 'crestwood', name: 'Crestwood Family Office', initials: 'CW', type: 'Family office',
      since: 2020, contact: 'A. Crestwood', committed: 5.5, contributed: 4.6, distributed: 2.1, irr: 12.6,
      nav: 4.0, dpi: 0.46, tvpi: 1.33, openCall: { fund: 'Eastgate 3-Building JV', amount: 0.9, pct: 50, due: 'Jun 30' },
      holdings: [['Oxford Industrial Fund III', 'Vintage 2022 · 9 assets', 2.2], ['Eastgate 3-Building JV', 'Co-invest · committed', 1.8], ['Southport Distribution SPV', 'Co-invest · called 40%', 0.6]] },
    { id: 'oxford-gp', name: 'Oxford RA (Principals)', initials: 'OR', type: 'General Partner',
      since: 2015, contact: 'J. Mercer', committed: 12.0, contributed: 10.4, distributed: 5.8, irr: 16.8,
      nav: 9.2, dpi: 0.56, tvpi: 1.49, openCall: null,
      holdings: [['Oxford Industrial Fund III', 'GP commit · 10%', 4.1], ['Oxford Industrial Fund II', 'GP commit · 10%', 3.0], ['Eastgate 3-Building JV', 'GP · 23%', 1.3], ['Co-invest SPVs', '4 vehicles', 2.0]] }
  ];

  // ---- helpers ----
  function fmtM(v) { return '$' + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + 'M'; }
  function fmtMsmall(v) { return '$' + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '<small>M</small>'; }
  function qs(k) { return new URLSearchParams(location.search).get(k); }
  function find(coll, id) { for (var i = 0; i < coll.length; i++) if (coll[i].id === id) return coll[i]; return coll[0]; }

  var METRICS = {
    aum: fmtMsmall(totals.aum), noiMo: '$' + totals.noiMo.toFixed(2) + '<small>M</small>',
    noiYr: '$' + totals.noiYr.toFixed(1) + '<small>M</small>', occ: totals.occ.toFixed(1) + '<small>%</small>',
    cap: totals.cap.toFixed(1) + '<small>%</small>', assets: String(totals.assets),
    debt: '$' + totals.debt.toFixed(0) + '<small>M · ' + totals.ltv.toFixed(0) + '%</small>',
    units: String(totals.units), tenants: String(totals.tenants), cash: fmtMsmall(totals.cash),
    sf: (totals.sf / 1000).toFixed(0) + '<small>K SF</small>', walt: totals.walt.toFixed(1) + '<small> yrs</small>'
  };
  var METRICS_TXT = {
    aum: fmtM(totals.aum), noiMo: '$' + totals.noiMo.toFixed(2) + 'M', noiYr: '$' + totals.noiYr.toFixed(1) + 'M',
    occ: totals.occ.toFixed(1) + '%', cap: totals.cap.toFixed(1) + '%', assets: String(totals.assets),
    debt: '$' + totals.debt.toFixed(0) + 'M', ltv: totals.ltv.toFixed(0) + '%', units: String(totals.units),
    tenants: String(totals.tenants), regions: String(totals.regions), markets: String(totals.markets),
    sf: (totals.sf / 1000).toFixed(0) + 'K', walt: totals.walt.toFixed(1) + ' yrs', cash: fmtM(totals.cash)
  };
  function bindMetrics(root) {
    (root || document).querySelectorAll('[data-metric]').forEach(function (el) {
      var k = el.getAttribute('data-metric');
      if (METRICS[k] != null) el.innerHTML = METRICS[k];
    });
    (root || document).querySelectorAll('[data-metric-txt]').forEach(function (el) {
      var k = el.getAttribute('data-metric-txt');
      if (METRICS_TXT[k] != null) el.textContent = el.textContent.replace(/\{\}/g, METRICS_TXT[k]);
    });
  }

  document.addEventListener('DOMContentLoaded', function () { bindMetrics(document); });

  return {
    PROPERTIES: PROPERTIES, DEALS: DEALS, INVESTORS: INVESTORS, PMS: PMS, MARKETS: MARKETS,
    totals: totals, STAGES: STAGES, MONTHS: MONTHS, NOW: NOW,
    GLOBAL_MONTHS: GLOBAL_MONTHS, GLAST: GLAST, OPEX_LINES: OPEX_LINES,
    declineStreak: declineStreak, riseStreak: riseStreak, ordinal: ordinal,
    fmtM: fmtM, fmtMsmall: fmtMsmall, qs: qs, find: find, bindMetrics: bindMetrics, METRICS_TXT: METRICS_TXT
  };
})();
