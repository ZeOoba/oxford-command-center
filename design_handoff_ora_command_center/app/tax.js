/* ORA Command Center — Tax engine.
   Per-asset tax profile (reconciles to the modeled property-tax line in
   window.ORA p.S.tax), a ranked, $-quantified strategy engine (appeals,
   cost-segregation, bonus depreciation, 1031, entity structuring, OZ) for
   the asset / portfolio / pipeline, plus a filed-return archive with AI
   review. Nothing is hand-asserted: figures derive from PROPERTIES / DEALS
   so they tie back to the rest of the app. Load: data.js → trends.js → tax.js. */
window.ORA_TAX = (function () {
  var O = window.ORA, T = window.ORA_TRENDS, LAST = O.GLAST;

  function seed(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return function () { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296; }; }
  function trailing12(s) { if (!s) return 0; var t = 0; for (var i = LAST - 11; i <= LAST; i++) t += s[i] || 0; return t; }
  function money(n) { var a = Math.abs(n), s = n < 0 ? '\u2212' : '+'; if (a >= 999500) return s + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K'; return s + '$' + Math.round(a); }
  function plain(n) { var a = Math.abs(n); if (a >= 999500) return '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + Math.round(a / 1e3) + 'K'; return '$' + Math.round(a); }

  var MARGINAL = 0.37;        // top federal marginal rate (passthrough principals)
  var BONUS_2026 = 0.40;      // modeled first-year bonus depreciation rate

  // ---- per-asset tax profile ----
  var ASSETS = O.PROPERTIES.map(function (p) {
    var r = seed(p.id + '|tax2');
    var marketVal = p.value * 1e6;
    var annualTax = p.S ? trailing12(p.S.tax) : marketVal * 0.014;
    var taxYoY = p.S ? T.yoyPct(p.S.tax, LAST) : 8;
    // assessment: assessed value as a fraction of market (jurisdiction ratio)
    var ratio = 0.58 + r() * 0.20;
    var assessed = marketVal * ratio;
    var effRate = annualTax / assessed;           // mill / effective rate on assessed
    var rateOnMarket = annualTax / marketVal * 100;
    // appeal: how far assessment overshoots a defensible income-approach value.
    // assessor has been catching up to the last value cycle → some overshoot.
    var over = taxYoY > 9 ? (0.04 + r() * 0.09) : (r() < 0.4 ? (0.02 + r() * 0.05) : 0);
    var appealSaving = annualTax * over;          // proportional tax reduction
    var appealProb = over > 0.07 ? 0.7 : over > 0 ? 0.5 : 0;
    // depreciation: building basis (ex-land) + cost-seg reclass potential
    var landPct = 0.18 + r() * 0.10;
    var basis = marketVal * (1 - landPct);
    var reclassPct = 0.22 + r() * 0.10;           // % movable to 5/7/15-yr life
    var costSegBenefit = basis * reclassPct * BONUS_2026 * MARGINAL; // yr-1 tax deferral
    var yearsHeld = p.ownYears || 4;
    var costSegDone = yearsHeld > 5 && r() < 0.5; // older holds may already be segregated
    return {
      id: p.id, name: p.name, market: p.market, type: p.type, sf: p.sf,
      marketVal: marketVal, assessed: assessed, ratio: ratio, annualTax: annualTax,
      effRate: effRate, rateOnMarket: rateOnMarket, taxYoY: taxYoY,
      overPct: over, appealSaving: appealSaving, appealProb: appealProb,
      basis: basis, landPct: landPct, reclassPct: reclassPct,
      costSegBenefit: costSegBenefit, costSegDone: costSegDone, yearsHeld: yearsHeld
    };
  });
  function asset(id) { for (var i = 0; i < ASSETS.length; i++) if (ASSETS[i].id === id) return ASSETS[i]; return null; }

  // ---- portfolio totals ----
  var totals = {
    annualTax: ASSETS.reduce(function (t, a) { return t + a.annualTax; }, 0),
    assessed: ASSETS.reduce(function (t, a) { return t + a.assessed; }, 0),
    marketVal: ASSETS.reduce(function (t, a) { return t + a.marketVal; }, 0),
    appealSaving: ASSETS.reduce(function (t, a) { return t + a.appealSaving; }, 0),
    appeals: ASSETS.filter(function (a) { return a.appealSaving > 1500; }).length,
    costSeg: ASSETS.filter(function (a) { return !a.costSegDone; }).reduce(function (t, a) { return t + a.costSegBenefit; }, 0)
  };
  totals.effRate = totals.annualTax / totals.assessed;
  totals.taxYoY = T ? T.yoyPct(T.portfolioSeries(O.PROPERTIES, 'tax'), LAST) : 8;

  // ---- strategy engine (ranked, $-quantified) ----
  function build() {
    var sig = [];
    // 1. APPEALS — over-assessed assets
    ASSETS.filter(function (a) { return a.appealSaving > 1500; }).forEach(function (a) {
      sig.push({
        id: 'appeal-' + a.id, cat: 'appeal', scope: 'asset', dir: 'gain', impact: a.appealSaving,
        sev: a.appealSaving > 18000 ? 'high' : a.appealSaving > 7000 ? 'med' : 'low',
        title: a.name + ' assessed ' + Math.round(a.overPct * 100) + '% above defensible value',
        detail: plain(a.assessed) + ' assessed vs ' + plain(a.marketVal) + ' market \u00b7 tax +' + (a.taxYoY || 0).toFixed(0) + '% YoY \u00b7 ' + a.market,
        action: 'File assessment appeal (' + Math.round(a.appealProb * 100) + '% win prob)',
        href: 'Property.html?id=' + a.id
      });
    });
    // 2. COST-SEG / bonus depreciation — assets not yet segregated
    ASSETS.filter(function (a) { return !a.costSegDone && a.costSegBenefit > 20000; }).forEach(function (a) {
      sig.push({
        id: 'cseg-' + a.id, cat: '1031', scope: 'asset', dir: 'gain', impact: a.costSegBenefit,
        sev: a.costSegBenefit > 120000 ? 'high' : a.costSegBenefit > 60000 ? 'med' : 'low',
        title: a.name + ' \u2014 cost-seg can accelerate ' + Math.round(a.reclassPct * 100) + '% of basis',
        detail: plain(a.basis) + ' depreciable basis \u00b7 reclass to 5/15-yr \u00b7 ' + Math.round(BONUS_2026 * 100) + '% bonus \u00b7 ' + Math.round(MARGINAL * 100) + '% marginal',
        action: 'Commission cost-segregation study',
        href: 'Property.html?id=' + a.id
      });
    });
    // 3. PORTFOLIO — entity structuring & grouping election
    sig.push({
      id: 'tax-grouping', cat: 'struct', scope: 'portfolio', dir: 'gain', impact: totals.annualTax * 0.03,
      sev: 'med',
      title: 'Group rental activities to unlock passive-loss offsets',
      detail: 'A §469 grouping election lets accelerated depreciation on new buys shelter income across the ' + O.totals.assets + '-asset book',
      action: 'Confirm grouping election with tax counsel',
      href: 'Taxes.html'
    });
    // 4. PORTFOLIO — bonus depreciation window
    sig.push({
      id: 'tax-bonus', cat: '1031', scope: 'portfolio', dir: 'gain', impact: totals.costSeg,
      sev: totals.costSeg > 250000 ? 'high' : 'med',
      title: 'Stack cost-seg across ' + ASSETS.filter(function (a) { return !a.costSegDone; }).length + ' un-segregated assets',
      detail: 'Aggregate ' + plain(totals.costSeg) + ' first-year tax deferral available before bonus depreciation steps down further',
      action: 'Prioritize studies this tax year',
      href: 'Taxes.html'
    });
    // 5. PIPELINE — tax structuring on closing deals (1031 chain + day-1 cost-seg)
    O.DEALS.filter(function (d) { return d.stageIdx >= 3; }).sort(function (a, b) { return b.price - a.price; }).slice(0, 3).forEach(function (d) {
      var basis = d.price * 1e6 * 0.78, benefit = basis * 0.28 * BONUS_2026 * MARGINAL;
      sig.push({
        id: 'acq-tax-' + d.id, cat: 'struct', scope: 'acquisition', dir: 'gain', impact: benefit,
        sev: d.stageIdx >= 4 ? 'high' : 'med',
        title: d.name + ' \u2014 model day-1 cost-seg before close',
        detail: O.fmtM(d.price) + ' \u00b7 ' + plain(benefit) + ' yr-1 deferral \u00b7 chain a 1031 to defer gain into this basis',
        action: 'Engage cost-seg + 1031 QI pre-closing',
        href: 'DealRoom.html?id=' + d.id
      });
    });
    return sig.sort(function (a, b) { return b.impact - a.impact; });
  }
  var STRATEGIES = build();

  // ---- filed-return archive (modeled annual federal returns, portfolio) ----
  var thisYr = O.GLOBAL_MONTHS[LAST].y;
  var RETURNS = [];
  (function () {
    var r = seed('ora|returns');
    for (var y = thisYr - 1; y >= thisYr - 5; y--) {
      var growth = Math.pow(1.09, thisYr - 1 - y);
      var egi = totals.marketVal * 0.066 / growth;       // ~ income scaled back in time
      var opex = egi * 0.36, noi = egi - opex;
      var depr = totals.marketVal * 0.82 / 27.5 / growth; // straight-line shield
      var bonus = (y >= thisYr - 3) ? totals.costSeg / growth * (0.6 + r() * 0.5) : 0;
      var interest = totals.marketVal * 0.41 * 0.046 / growth;
      var taxableIncome = noi - depr - bonus - interest;
      var flag = bonus > 0 && y === thisYr - 1;
      RETURNS.push({
        year: y, entity: 'Oxford Industrial Fund III, LP', form: 'Form 1065',
        egi: egi, noi: noi, depreciation: depr, bonus: bonus, interest: interest,
        taxableIncome: taxableIncome, shelter: taxableIncome < 0,
        status: y >= thisYr - 1 ? 'Filed \u00b7 under review' : 'Filed \u00b7 accepted',
        note: taxableIncome < 0
          ? 'Depreciation fully shelters NOI \u2014 ' + plain(-taxableIncome) + ' passive loss carried forward; verify at-risk basis on co-invest LPs.'
          : (flag ? 'Bonus depreciation under-claimed vs cost-seg potential \u2014 amended-return opportunity flagged.'
            : 'Clean. Effective passthrough rate within range; K-1s reconciled to capital accounts.'),
        reviewSev: taxableIncome < 0 ? 'low' : flag ? 'med' : 'low'
      });
    }
  })();

  return {
    ASSETS: ASSETS, asset: asset, totals: totals, STRATEGIES: STRATEGIES, RETURNS: RETURNS,
    MARGINAL: MARGINAL, BONUS_2026: BONUS_2026, money: money, plain: plain,
    CAT_LABEL: { appeal: 'Appeal', '1031': 'Cost-Seg', struct: 'Structure', tax: 'Tax' },
    rebuild: function () { STRATEGIES = build(); return STRATEGIES; }
  };
})();
