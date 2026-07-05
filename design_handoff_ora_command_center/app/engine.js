/* ORA Command Center — Insight & Attention Engine.
   Derives ranked, $-quantified, actionable signals from the canonical
   data layer (window.ORA). Nothing here is hand-authored copy: every
   figure is computed from PROPERTIES / PMS / DEALS so it reconciles with
   the rest of the app and updates if the data changes.

   A "signal" = a thing ownership should act on, with:
     cat   noi | risk | acq | capital | ops
     dir   gain | risk | info
     impact  annualized $ (for ranking)
     title / detail / action / href   the actionable intel
*/
window.ORA_ENGINE = (function () {
  var O = window.ORA;

  function money(n) {
    var a = Math.abs(n), s = n < 0 ? '\u2212' : '+';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
    return s + '$' + Math.round(a / 1e3) + 'K';
  }

  // active slice (respects the global filter if present)
  function scope() {
    var f = window.ORA_FILTER;
    return {
      props: f ? f.properties() : O.PROPERTIES,
      deals: f ? f.deals() : O.DEALS,
      filtered: f ? f.active() : false
    };
  }

  function build(argProps, argDeals) {
    var sc = scope();
    var PROPS = argProps || sc.props, DEALS = argDeals || sc.deals;
    var filtered = argProps ? (PROPS.length < O.PROPERTIES.length) : sc.filtered;
    var f = window.ORA_FILTER;
    var asOf = (f && f.asOf) ? f.asOf() : (O.NOW || 0);
    function occAt(p) { return p.hist ? p.hist.occ[asOf] : p.occ; }
    function rentAt(p) { return p.hist ? p.hist.rent[asOf] : p.rentPSF; }
    function valAt(p) { return p.hist ? p.hist.val[asOf] : p.value; }
    var aum = PROPS.reduce(function (t, p) { return t + valAt(p); }, 0) || 1;
    var capW = PROPS.reduce(function (t, p) { return t + p.cap * valAt(p); }, 0) / aum;
    var sig = [];

    // ---------- 1. NOI: mark-to-market on below-market leases ----------
    PROPS.forEach(function (p) {
      var inPlace = rentAt(p);
      var gap = p.mktPSF - inPlace;
      if (gap <= 0.05) return;
      var upside = p.sf * (occAt(p) / 100) * gap;        // $/yr if rolled to market
      var gapPct = gap / inPlace * 100;
      sig.push({
        id: 'mtm-' + p.id, cat: 'noi', dir: 'gain', impact: upside,
        sev: upside > 55000 ? 'high' : upside > 30000 ? 'med' : 'low',
        title: p.name + ' sits ' + Math.round(gapPct) + '% below market',
        detail: '$' + inPlace.toFixed(2) + ' in-place vs $' + p.mktPSF.toFixed(2) + ' market NNN \u00b7 ' + (p.sf / 1000).toFixed(0) + 'K SF \u00b7 ' + p.market,
        action: 'Mark to market on next renewal',
        href: 'Property.html?id=' + p.id
      });
    });

    // ---------- 2. RISK: occupancy decline, computed from modeled history ----------
    // Streak = consecutive month-over-month drops ending at the as-of period,
    // so "2nd straight month declining" is derived, not asserted.
    PROPS.forEach(function (p) {
      if (!p.hist) return;
      var occS = p.hist.occ, cur = occS[asOf];
      var streak = O.declineStreak(occS, asOf);
      if (streak >= 2) {
        var startIdx = asOf - streak, startOcc = occS[startIdx];
        var sfLost = p.sf * ((startOcc - cur) / 100);
        var atRisk = sfLost * p.mktPSF;                 // annual rent tied to the slide
        var path = [];
        for (var j = startIdx; j <= asOf; j++) path.push(occS[j].toFixed(0));
        var span = O.MONTHS[startIdx].short + '\u2013' + O.MONTHS[asOf].short;
        sig.push({
          id: 'occ-' + p.id, cat: 'risk', dir: 'risk', impact: atRisk,
          sev: (streak >= 3 || cur < 88) ? 'high' : 'med',
          title: p.name + ' occupancy down to ' + cur.toFixed(0) + '% \u2014 ' + O.ordinal(streak) + ' straight month declining',
          detail: path.join('% \u2192 ') + '% over ' + span + ' \u00b7 ' + (sfLost / 1000).toFixed(1) + 'K SF given back \u00b7 ' + p.market,
          action: 'Arrest the slide \u2014 leasing push / concession review',
          href: 'Property.html?id=' + p.id
        });
      } else if (cur < 90 && (p.status === 'Watch' || streak === 1)) {
        var vacantSf = p.sf * (1 - cur / 100);
        sig.push({
          id: 'occf-' + p.id, cat: 'risk', dir: 'risk', impact: vacantSf * p.mktPSF,
          sev: cur < 88 ? 'high' : 'med',
          title: p.name + ' occupancy at ' + cur.toFixed(0) + '%',
          detail: Math.round(vacantSf / 1000) + 'K SF vacant \u00b7 ' + p.market + ' \u00b7 ' + (streak === 1 ? 'slipped this month \u2014 watch for a trend' : 'holding flat, no recovery yet'),
          action: 'Push leasing / concession review',
          href: 'Property.html?id=' + p.id
        });
      }
    });

    // ---------- 3. OPS: property-manager underperformance ----------
    // PM rent computed over the filtered assets each manager actually holds
    var avgExp = O.PMS.reduce(function (t, m) { return t + m.expGrowth; }, 0) / O.PMS.length;
    O.PMS.forEach(function (pm) {
      var pmProps = PROPS.filter(function (p) { return p.pmId === pm.id; });
      if (!pmProps.length) return;
      var rent = pmProps.reduce(function (t, p) { return t + p.sf * (occAt(p) / 100) * rentAt(p); }, 0);
      var uncollected = rent * (1 - pm.collections / 100);
      var excessExp = pm.expGrowth > avgExp ? rent * 0.30 * ((pm.expGrowth - avgExp) / 100) : 0;
      var impact = uncollected + excessExp;
      var weak = pm.collections < 96 || pm.retention < 80 || pm.expGrowth > avgExp + 1;
      if (!weak) return;
      sig.push({
        id: 'pm-' + pm.id, cat: 'ops', dir: 'risk', impact: impact,
        sev: pm.retention < 80 ? 'high' : 'med',
        title: pm.name + ' trailing on PM scorecard',
        detail: pm.collections.toFixed(0) + '% collections \u00b7 ' + pm.retention + '% retention \u00b7 OpEx +' + pm.expGrowth.toFixed(1) + '% vs ' + avgExp.toFixed(1) + '% avg',
        action: 'Quarterly PM review \u00b7 collections plan',
        href: 'Operations.html'
      });
    });

    // ---------- 4. RISK: market concentration vs policy (portfolio-wide only) ----------
    if (!filtered) {
      var byMkt = {};
      PROPS.forEach(function (p) { byMkt[p.market] = (byMkt[p.market] || 0) + valAt(p); });
      var topMkt = Object.keys(byMkt).sort(function (a, b) { return byMkt[b] - byMkt[a]; })[0];
      var share = byMkt[topMkt] / aum * 100, ceiling = 25;
      if (share > ceiling - 4) {
        var breach = share > ceiling;
        sig.push({
          id: 'conc-mkt', cat: 'risk', dir: breach ? 'risk' : 'info',
          impact: breach ? (share - ceiling) / 100 * byMkt[topMkt] * 1e6 : 1,
          sev: breach ? 'high' : 'low',
          title: topMkt + ' is ' + share.toFixed(0) + '% of AUM',
          detail: O.fmtM(byMkt[topMkt]) + ' in one market vs ' + ceiling + '% policy ceiling \u2014 single-market exposure',
          action: breach ? 'Rebalance / pause buys here' : 'Monitor \u2014 approaching ceiling',
          href: 'Portfolio.html'
        });
      }
    }

    // ---------- 5. ACQ: pipeline clearing the return hurdle ----------
    DEALS.filter(function (d) { return d.stageIdx >= 3; })
      .sort(function (a, b) { return b.irr - a.irr; })
      .slice(0, 3).forEach(function (d) {
        sig.push({
          id: 'acq-' + d.id, cat: 'acq', dir: 'gain', impact: d.stabNOI * 1e6,
          sev: d.stageIdx >= 4 ? 'high' : 'med',
          title: d.name + ' \u2014 ' + d.irr.toFixed(1) + '% IRR, ' + d.em.toFixed(1) + 'x',
          detail: O.fmtM(d.price) + ' \u00b7 ' + d.capIn.toFixed(1) + '% going-in \u00b7 ' + d.stage + ' \u00b7 +' + d.stabNOI.toFixed(2) + 'M stabilized NOI',
          action: d.stageIdx >= 4 ? 'Final IC approval to close' : 'Advance due diligence',
          href: 'DealRoom.html?id=' + d.id
        });
      });

    // ---------- 6. CAPITAL: fund the closing(s) ----------
    var closing = DEALS.filter(function (d) { return d.stageIdx >= 4; });
    if (closing.length) {
      var eqNeed = closing.reduce(function (t, d) { return t + d.equity; }, 0);
      var coInvest = O.INVESTORS.reduce(function (t, i) { return t + (i.openCall ? i.openCall.amount : 0); }, 0);
      var net = O.totals.cash + coInvest - eqNeed;
      sig.push({
        id: 'cap-close', cat: 'capital', dir: net >= 0 ? 'info' : 'risk', impact: eqNeed * 1e6,
        sev: net >= 0 ? 'low' : 'high',
        title: 'Closing pipeline needs ' + O.fmtM(eqNeed) + ' equity',
        detail: O.fmtM(O.totals.cash) + ' cash + ' + O.fmtM(coInvest) + ' co-invest called \u2192 ' + (net >= 0 ? O.fmtM(net) + ' buffer remains' : O.fmtM(-net) + ' short'),
        action: net >= 0 ? 'Fundable \u2014 confirm wire timing' : 'Open a capital call',
        href: 'Investor.html?id=meridian-holdings'
      });
    }

    // ---------- 7. CAPITAL: best use of the next dollar ----------
    var totalMtm = sig.filter(function (s) { return s.cat === 'noi'; }).reduce(function (t, s) { return t + s.impact; }, 0);
    if (totalMtm > 0) sig.push({
      id: 'cap-allocate', cat: 'capital', dir: 'info', impact: 1,
      sev: 'med',
      title: 'Best return on the next dollar: lease mark-to-market',
      detail: money(totalMtm) + '/yr of NOI is recapturable at ~$0 capital cost \u2014 ahead of ' + capW.toFixed(1) + '% on new acquisitions or paying down ' + (O.totals.ltv).toFixed(0) + '% LTV debt',
      action: 'Prioritize renewals over paydown',
      href: 'Leases.html'
    });

    // ---------- 8. ANOMALY: month-end outliers derived from modeled history ----------
    if (window.ORA_TRENDS) {
      ORA_TRENDS.detectAll(PROPS).slice(0, 3).forEach(function (a) {
        sig.push({
          id: 'anom-' + a.pid + '-' + a.metric + '-' + a.type, cat: 'risk', dir: a.dir, impact: a.impact || 1,
          sev: a.sev,
          title: a.title + ' \u2014 ' + a.pname,
          detail: a.note,
          action: 'Review month-end variance \u00b7 ' + a.market,
          href: 'Property.html?id=' + a.pid
        });
      });
    }

    return sig.sort(function (a, b) { return b.impact - a.impact; });
  }

  var _signals = build();
  function rebuild() { _signals = build(); api.SIGNALS = _signals; return _signals; }
  // build a ranked signal set for an explicit slice (e.g. Studio's cross-filter)
  function signalsFor(props, deals) { return build(props, deals); }

  function summary() {
    var noiUpside = _signals.filter(function (s) { return s.cat === 'noi'; }).reduce(function (t, s) { return t + s.impact; }, 0);
    var atRisk = _signals.filter(function (s) { return s.dir === 'risk'; }).reduce(function (t, s) { return t + s.impact; }, 0);
    return { noiUpside: noiUpside, atRisk: atRisk, count: _signals.length };
  }

  // lens → which categories surface
  var LENS_CATS = {
    balanced: ['noi', 'risk', 'ops'],       // operational intel at comparable $ scale
    attention: null,                        // all, re-ranked by severity
    noi: ['noi', 'acq', 'capital'],         // growth levers incl. pipeline & capital
    risk: ['risk', 'ops']
  };
  function forLens(lens) {
    var cats = LENS_CATS[lens];
    var list = cats ? _signals.filter(function (s) { return cats.indexOf(s.cat) > -1; }) : _signals.slice();
    if (lens === 'attention') {
      var rank = { high: 0, med: 1, low: 2 };
      list.sort(function (a, b) { return (rank[a.sev] - rank[b.sev]) || (b.impact - a.impact); });
    }
    return list;
  }

  var CAT_LABEL = { noi: 'NOI', risk: 'Risk', acq: 'Acquire', capital: 'Capital', ops: 'Ops' };

  function rowHtml(s) {
    var impCls = s.dir === 'risk' ? 'risk' : s.dir === 'gain' ? 'gain' : 'info';
    var impSub = s.dir === 'risk' ? 'AT RISK' : s.dir === 'gain' ? (s.cat === 'acq' ? 'NOI ADDED' : 'NOI / YR') : (s.cat === 'capital' ? 'EQUITY NEED' : 'GUIDANCE');
    var val = (s.id === 'cap-allocate' || s.impact <= 1) ? '\u2014' : (s.dir === 'info' ? money(s.impact).replace(/^[+\u2212]/, '') : money(s.impact));
    return '<a class="sig" href="' + s.href + '">' +
      '<span class="sev sev-' + s.sev + '"></span>' +
      '<div class="body"><div class="st">' + s.title + '</div>' +
      '<div class="sd">' + s.detail + '</div>' +
      '<div class="sa">\u2192 ' + s.action + '</div></div>' +
      '<div><div class="imp ' + impCls + '">' + val + '</div>' +
      '<div class="impsub">' + impSub + '</div>' +
      '<span class="catpill cat-' + s.cat + '">' + CAT_LABEL[s.cat] + '</span></div></a>';
  }

  var api = { SIGNALS: _signals, rebuild: rebuild, signalsFor: signalsFor, summary: summary, forLens: forLens, rowHtml: rowHtml, money: money, CAT_LABEL: CAT_LABEL };
  return api;
})();
