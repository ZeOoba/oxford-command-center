/* ORA Command Center — Insurance engine.
   Per-asset policy register (premium reconciles to the modeled insurance
   line in window.ORA p.S.ins), a continuous savings scanner (premium vs
   benchmark, deductible optimization, over-/under-insurance, blanket vs
   scheduled), a self-insurance / risk-retention analysis (premium vs modeled
   expected loss), and a re-bid trigger engine with modeled inbound quotes.
   Load: data.js → trends.js → ins.js. */
window.ORA_INS = (function () {
  var O = window.ORA, T = window.ORA_TRENDS, LAST = O.GLAST;

  function seed(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return function () { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296; }; }
  function trailing12(s) { if (!s) return 0; var t = 0; for (var i = LAST - 11; i <= LAST; i++) t += s[i] || 0; return t; }
  function money(n) { var a = Math.abs(n), s = n < 0 ? '\u2212' : '+'; if (a >= 999500) return s + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K'; return s + '$' + Math.round(a); }
  function plain(n) { var a = Math.abs(n); if (a >= 999500) return '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + Math.round(a / 1e3) + 'K'; return '$' + Math.round(a); }

  var CARRIERS = ['Statewide Mutual', 'Liberty Commercial', 'Travelers Inland', 'Chubb Industrial', 'Zurich NA', 'AmTrust E&S'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // peril exposure weighted by market (modeled)
  var MKT_PERIL = { Eastgate: 'Wind', Riverside: 'Flood', Lakewood: 'Coastal wind', Southport: 'Convective storm', 'Tri-County': 'Hail' };

  // ---- per-asset policy ----
  var ASOF = O.GLOBAL_MONTHS[LAST];
  var POLICIES = O.PROPERTIES.map(function (p) {
    var r = seed(p.id + '|ins2');
    var premium = p.S ? trailing12(p.S.ins) : p.value * 1e6 * 0.0012;
    var premYoY = p.S ? T.yoyPct(p.S.ins, LAST) : 13;
    var costPerSf = 92 + r() * 46;                 // replacement cost $/SF
    var tiv = p.sf * costPerSf;                      // total insured value (replacement)
    var rate = premium / tiv;                        // premium per $1 TIV
    var deductible = [25000, 25000, 50000, 50000, 100000][Math.floor(r() * 5)];
    // over-insurance: insured limit above replacement (carrier auto-inflated)
    var limit = tiv * (1 + (r() < 0.45 ? 0.06 + r() * 0.10 : -0.02 - r() * 0.06));
    var overInsured = Math.max(0, limit - tiv);
    // renewal month / days out
    var renMonth = Math.floor(r() * 12);
    var daysOut = ((renMonth - ASOF.m + 12) % 12) * 30 + Math.floor(r() * 28) + 4;
    var carrier = CARRIERS[Math.floor(r() * CARRIERS.length)];
    // modeled trailing-3yr loss ratio and expected annual loss (a fraction of premium)
    var lossRatio3y = 0.10 + r() * 0.45;             // claims / premium, trailing 3y
    var expectedLoss = premium * (0.12 + r() * 0.33); // EAL keeps portfolio loss ratio ~0.28
    var freq = 0.10 + r() * 0.22;
    return {
      id: p.id, name: p.name, market: p.market, type: p.type, sf: p.sf, carrier: carrier,
      premium: premium, premYoY: premYoY, tiv: tiv, costPerSf: costPerSf, rate: rate,
      rateVsBench: 0, deductible: deductible, limit: limit, overInsured: overInsured,
      renMonth: renMonth, renLabel: MONTHS[renMonth] + " '" + String(ASOF.m >= renMonth ? ASOF.y + 1 : ASOF.y).slice(2),
      daysOut: daysOut, peril: MKT_PERIL[p.market] || 'Wind', expectedLoss: expectedLoss,
      lossRatio3y: lossRatio3y, freq: freq
    };
  });
  // benchmark = a touch under the book's median rate, so ~half the policies read
  // "over market" by varying degrees and the scanner has something real to find.
  var RATES_SORTED = POLICIES.map(function (x) { return x.rate; }).sort(function (a, b) { return a - b; });
  var BENCH_RATE = RATES_SORTED[Math.floor(RATES_SORTED.length / 2)] * 0.9;
  POLICIES.forEach(function (x) { x.rateVsBench = (x.rate - BENCH_RATE) / BENCH_RATE; });
  function policy(id) { for (var i = 0; i < POLICIES.length; i++) if (POLICIES[i].id === id) return POLICIES[i]; return null; }

  var totals = {
    premium: POLICIES.reduce(function (t, x) { return t + x.premium; }, 0),
    tiv: POLICIES.reduce(function (t, x) { return t + x.tiv; }, 0),
    expectedLoss: POLICIES.reduce(function (t, x) { return t + x.expectedLoss; }, 0),
    overInsured: POLICIES.reduce(function (t, x) { return t + x.overInsured; }, 0),
    premYoY: T ? T.yoyPct(T.portfolioSeries(O.PROPERTIES, 'ins'), LAST) : 13,
    renew90: POLICIES.filter(function (x) { return x.daysOut <= 90; }).length
  };
  totals.rate = totals.premium / totals.tiv;
  totals.lossRatio = totals.expectedLoss / totals.premium;

  // ---- savings scanner (ranked, $-quantified) ----
  function build() {
    var sig = [];
    POLICIES.forEach(function (x) {
      // a. paying over benchmark → re-bid
      if (x.rateVsBench > 0.08) {
        var save = x.premium * Math.min(0.22, x.rateVsBench * 0.6);
        sig.push({ id: 'bid-' + x.id, cat: 'bid', scope: 'asset', dir: 'gain', impact: save,
          sev: save > 14000 ? 'high' : save > 6000 ? 'med' : 'low',
          title: x.name + ' priced ' + Math.round(x.rateVsBench * 100) + '% over market rate',
          detail: '$' + (x.rate * 100).toFixed(2) + '/$100 TIV vs $' + (BENCH_RATE * 100).toFixed(2) + ' benchmark \u00b7 ' + x.carrier + ' \u00b7 renews ' + x.renLabel,
          action: 'Trigger competitive re-bid (3 carriers)', href: 'Insurance.html' });
      }
      // b. deductible optimization
      if (x.deductible < 75000 && x.lossRatio3y < 0.4) {
        var save2 = x.premium * (0.06 + (75000 - x.deductible) / 75000 * 0.05);
        sig.push({ id: 'ded-' + x.id, cat: 'save', scope: 'asset', dir: 'gain', impact: save2,
          sev: save2 > 9000 ? 'med' : 'low',
          title: x.name + ' \u2014 raise deductible to $75K',
          detail: 'From $' + (x.deductible / 1000) + 'K \u00b7 ' + Math.round(x.lossRatio3y * 100) + '% loss ratio (3y) makes retention cheap',
          action: 'Increase deductible at renewal', href: 'Insurance.html' });
      }
      // c. over-insurance
      if (x.overInsured > 60000) {
        var save3 = x.overInsured * x.rate;
        sig.push({ id: 'over-' + x.id, cat: 'save', scope: 'asset', dir: 'gain', impact: save3,
          sev: save3 > 8000 ? 'med' : 'low',
          title: x.name + ' insured ' + plain(x.overInsured) + ' above replacement',
          detail: 'Limit ' + plain(x.limit) + ' vs ' + plain(x.tiv) + ' RC valuation \u00b7 paying premium on phantom value',
          action: 'Right-size limit to current RC', href: 'Insurance.html' });
      }
    });
    // d. portfolio: blanket / master program consolidation
    sig.push({ id: 'blanket', cat: 'save', scope: 'portfolio', dir: 'gain', impact: totals.premium * 0.07,
      sev: 'med',
      title: 'Consolidate ' + POLICIES.length + ' scheduled policies into a blanket program',
      detail: 'One master limit across the book typically cuts 6\u20139% vs per-asset scheduling and removes coinsurance gaps',
      action: 'Solicit blanket program quotes', href: 'Insurance.html' });
    // e. portfolio: self-insure a primary layer (captive / retention)
    var retention = selfInsure();
    if (retention.recommend) {
      sig.push({ id: 'retain', cat: 'retain', scope: 'portfolio', dir: 'gain', impact: retention.netSaving,
        sev: retention.netSaving > 120000 ? 'high' : 'med',
        title: 'Self-insure a ' + plain(retention.layer) + ' primary layer',
        detail: plain(totals.premium) + ' premium vs ' + plain(totals.expectedLoss) + ' modeled annual loss \u2014 ' + Math.round(totals.lossRatio * 100) + '% loss ratio leaves margin to retain',
        action: 'Model a captive / raise SIR', href: 'Insurance.html' });
    }
    return sig.sort(function (a, b) { return b.impact - a.impact; });
  }

  // ---- self-insurance / retention analysis ----
  function selfInsure() {
    var prem = totals.premium, eal = totals.expectedLoss;
    var riskLoad = eal * 1.6;                 // capital cushion for volatility (1.6× EAL)
    var transferCost = prem * 0.62;           // portion of premium buying the primary layer
    var netSaving = transferCost - eal - (riskLoad - eal) * 0.18; // keep excess, retain primary
    var layer = 250000;                       // primary layer per occurrence to retain
    return {
      premium: prem, expectedLoss: eal, riskLoad: riskLoad, transferCost: transferCost,
      netSaving: Math.max(0, netSaving), layer: layer, lossRatio: totals.lossRatio,
      recommend: totals.lossRatio < 0.45 && netSaving > 50000
    };
  }

  // ---- re-bid pipeline: modeled inbound quotes for re-bid candidates ----
  function bids() {
    var cands = POLICIES.filter(function (x) { return x.rateVsBench > 0.05 || x.daysOut <= 90; })
      .sort(function (a, b) { return a.daysOut - b.daysOut; });
    return cands.map(function (x) {
      var r = seed(x.id + '|bid');
      var nQuotes = 1 + Math.floor(r() * 3);
      var best = x.premium * (0.82 + r() * 0.12);
      return {
        id: x.id, name: x.name, carrier: x.carrier, premium: x.premium, daysOut: x.daysOut,
        renLabel: x.renLabel, quotes: nQuotes, best: best, saving: x.premium - best,
        status: x.daysOut <= 45 ? 'Quotes in' : x.daysOut <= 90 ? 'Out to market' : 'Queued'
      };
    });
  }

  var SCAN = build();
  return {
    POLICIES: POLICIES, policy: policy, totals: totals, SCAN: SCAN,
    selfInsure: selfInsure, bids: bids, BENCH_RATE: BENCH_RATE,
    money: money, plain: plain,
    CAT_LABEL: { bid: 'Re-bid', save: 'Save', retain: 'Retain', ins: 'Cover' },
    rebuild: function () { SCAN = build(); return SCAN; }
  };
})();
