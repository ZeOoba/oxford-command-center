/* ORA Command Center — News & Markets data layer.
   Macro/market figures (rates, treasuries, mortgage) are grounded in real
   values as of mid-June 2026; the historical series behind each chart are
   modeled to those anchors. Target-market items, briefing, regulation and
   research are modeled to the (illustrative) ORA portfolio and tied back to
   live portfolio anomalies via ORA_TRENDS. Load: data.js → trends.js → news.js. */
window.ORA_NEWS = (function () {
  var O = window.ORA, T = window.ORA_TRENDS;
  var AS_OF = 'Jun 16, 2026';

  function seed(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return function () { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296; }; }

  // 24-month series ending exactly at the real current value `v`.
  // shape: elevated ~2yr ago → eased through the cut cycle → slight recent rise.
  function ratePath(k, v) {
    var r = seed(k), N = 24, a = new Array(N);
    var hi = v * (1.10 + r() * 0.06), lo = v * (0.95 - r() * 0.02);
    for (var i = 0; i < N; i++) {
      var t = i / (N - 1);
      // descend from hi to lo over first ~75%, then drift back up to ~v
      var base = t < 0.75 ? hi + (lo - hi) * (t / 0.75) : lo + (v - lo) * ((t - 0.75) / 0.25);
      a[i] = +(base + (r() - 0.5) * v * 0.015).toFixed(3);
    }
    a[N - 1] = v;
    return a;
  }

  // ---- live rates (real anchors, modeled history) ----
  var RATES = [
    { k: 'sofr', label: 'SOFR', sub: 'Overnight', v: 3.69, d: -0.01, cat: 'Funding', note: 'Secured Overnight Financing Rate' },
    { k: 'sofr1m', label: 'Term SOFR', sub: '1-month', v: 3.70, d: -0.01, cat: 'Funding', note: 'Forward-looking, CME' },
    { k: 'sofr3m', label: 'Term SOFR', sub: '3-month', v: 3.77, d: 0.00, cat: 'Funding', note: 'Most floating CRE debt references this' },
    { k: 'ff', label: 'Fed Funds', sub: 'Target 3.50–3.75%', v: 3.75, d: 0.00, cat: 'Policy', note: 'Upper bound · cutting cycle since Sep \u201924' },
    { k: 'ust2', label: '2Y Treasury', sub: 'UST', v: 4.09, d: -0.03, cat: 'Treasury', note: 'Policy-sensitive front end' },
    { k: 'ust5', label: '5Y Treasury', sub: 'UST', v: 4.18, d: -0.02, cat: 'Treasury', note: 'Common CRE loan benchmark' },
    { k: 'ust10', label: '10Y Treasury', sub: 'UST', v: 4.48, d: -0.07, cat: 'Treasury', note: 'Long-rate / cap-rate anchor' },
    { k: 'ust30', label: '30Y Treasury', sub: 'UST', v: 5.02, d: -0.05, cat: 'Treasury', note: 'Long end' },
    { k: 'spread', label: '10Y–2Y', sub: 'Curve spread', v: 0.39, d: -0.04, cat: 'Curve', note: 'Positive \u2014 normalized curve' },
    { k: 'creloan', label: 'CRE Senior Debt', sub: 'SOFR + 225', v: 6.02, d: 0.00, cat: 'Lending', note: 'Indicative industrial acquisition loan' },
    { k: 'mort30', label: 'Agency 30Y', sub: 'Freddie PMMS', v: 6.52, d: -0.03, cat: 'Lending', note: 'Residential reference' }
  ];
  RATES.forEach(function (r) { r.series = ratePath(r.k, r.v); r.yoy = +((r.v - r.series[12]) ).toFixed(2); });

  // ---- live portfolio hooks (so national news ties to your book) ----
  function pf(metric) { return T ? T.portfolioSeries(O.PROPERTIES, metric) : null; }
  function pfYoY(metric) { var s = pf(metric); return s ? T.yoyPct(s, T.LAST) : null; }
  var LINK = {
    insurance: function () { var y = pfYoY('ins'); return { txt: 'Your book: insurance +' + (y ? y.toFixed(0) : '15') + '% YoY', href: 'Portfolio.html' }; },
    tax: function () { var y = pfYoY('tax'); return { txt: 'Your book: property tax +' + (y ? y.toFixed(0) : '9') + '% YoY', href: 'Portfolio.html' }; },
    rates: function () { return { txt: 'Pipeline financing \u00b7 SOFR+225 \u2248 6.0%', href: 'DealRoom.html' }; },
    flex: function () { return { txt: 'You hold flex across 5 markets', href: 'Studio.html' }; },
    tricounty: function () { return { txt: 'Tri-County is your largest market', href: 'Portfolio.html' }; },
    mtm: function () { return { txt: 'Mark-to-market upside flagged', href: 'Leases.html' }; }
  };

  // ---- daily briefing (national grounded · market modeled · tied to portfolio) ----
  var BRIEFING = [
    { time: '7:02a', tag: 'Rates', sev: 'med', title: '10-year eases to 4.48% as growth data cools', body: 'The 10Y slipped 7bps on the week and the 2s/10s curve holds a +39bp positive slope. Lower long rates ease pressure on exit cap rates for the closing pipeline.', link: 'rates' },
    { time: '6:48a', tag: 'Insurance', sev: 'high', title: 'Commercial property insurance still renewing up double digits', body: 'Carriers continue to push double-digit premium increases at renewal nationally, with industrial accounts pricing on replacement cost and cat exposure. Controllable mitigation: deductibles, valuations, loss control.', link: 'insurance' },
    { time: '6:30a', tag: 'Tax', sev: 'high', title: 'Counties accelerate industrial reassessments as values reset', body: 'Assessors are catching up to the last cycle of value growth, lifting assessed values on warehouse and flex. Expect appeal windows to matter more this year.', link: 'tax' },
    { time: 'Yesterday', tag: 'National', sev: 'med', title: 'Shallow-bay & flex outperform big-box on leasing', body: 'Small-bay industrial vacancy stays tight versus large distribution as new supply concentrates in big-box. Infill flex continues to see steady tenant demand and pricing power.', link: 'flex' },
    { time: 'Yesterday', tag: 'Market', sev: 'med', title: 'Tri-County logistics corridor digests new supply', body: 'A wave of speculative deliveries pushes Tri-County availability up modestly; rent growth decelerates but stays positive. Watch concession creep on renewals.', link: 'tricounty' },
    { time: '2d ago', tag: 'Capital', sev: 'low', title: 'Industrial cap rates stabilize as bid-ask narrows', body: 'Transaction volume is recovering off the trough as buyers and sellers converge near a ~6.x% going-in for stabilized small-bay. Financing at SOFR+200–250 pencils for low-leverage buyers.', link: 'rates' },
    { time: '2d ago', tag: 'Policy', sev: 'low', title: 'Year-end cost-segregation & bonus depreciation planning', body: 'With acquisitions closing, a cost-seg study can accelerate depreciation and shelter taxable income. Coordinate with the tax team before the closings fund.', link: 'mtm' }
  ];

  // ---- national CRE trend dashboard (modeled / representative) ----
  var NATIONAL = [
    { label: 'Industrial vacancy', v: '7.1%', d: '+40 bps YoY', dir: 'risk', note: 'Supply-led; small-bay tighter' },
    { label: 'Asking rent growth', v: '+3.2%', d: 'decelerating', dir: 'info', note: 'Off the double-digit peak' },
    { label: 'Avg cap rate (stab.)', v: '6.4%', d: 'flat QoQ', dir: 'info', note: 'Bid-ask narrowing' },
    { label: 'Net absorption', v: '+38 MSF', d: 'below 5-yr avg', dir: 'info', note: 'Positive but moderating' },
    { label: 'Under construction', v: '−24%', d: 'YoY pipeline', dir: 'gain', note: 'Future supply easing' },
    { label: 'Insurance / SF', v: '+13%', d: 'YoY', dir: 'risk', note: 'Hard market persists' }
  ];

  // ---- target-market trends (modeled, tied to your holdings) ----
  function marketTrends() {
    return O.MARKETS.map(function (m) {
      var ps = O.PROPERTIES.filter(function (p) { return p.market === m; });
      var aum = ps.reduce(function (t, p) { return t + p.value; }, 0);
      var r = seed(m + '|mkt');
      var vac = +(5 + r() * 4).toFixed(1), rg = +(1.5 + r() * 4).toFixed(1), cap = +(6.0 + r() * 1.2).toFixed(1), abs = Math.round((r() - 0.35) * 600);
      var mom = rg > 4 ? 'Hot' : rg > 2.6 ? 'Steady' : 'Cooling';
      return { market: m, aum: aum, assets: ps.length, vacancy: vac, rentGrowth: rg, cap: cap, absorption: abs, momentum: mom };
    }).sort(function (a, b) { return b.aum - a.aum; });
  }

  // ---- regulation & tax law tracker (representative, tied to impact) ----
  var REGULATION = [
    { tag: 'Property Tax', sev: 'high', title: 'Industrial reassessment cycles tightening', eff: 'FY26 rolls', body: 'Several assessing jurisdictions are shortening reassessment intervals and lifting industrial assessed values toward market. Appeal deadlines are the controllable lever.', link: 'tax' },
    { tag: 'Insurance', sev: 'high', title: 'Property cat pricing & valuation scrutiny', eff: 'Ongoing', body: 'Insurers require updated replacement-cost valuations; under-insurance penalties (coinsurance) are being enforced. Review limits before renewal.', link: 'insurance' },
    { tag: 'Depreciation', sev: 'med', title: 'Bonus depreciation & cost segregation', eff: 'Tax year 2026', body: 'Cost-seg + available bonus depreciation can materially defer taxable income on newly acquired assets. Model before closing.', link: 'mtm' },
    { tag: '1031 Exchange', sev: 'med', title: 'Like-kind exchange deadlines on dispositions', eff: 'Per transaction', body: '45-day ID / 180-day close windows govern tax-deferred reinvestment. Coordinate with the pipeline to chain dispositions into acquisitions.', link: 'rates' },
    { tag: 'Energy / BPS', sev: 'low', title: 'Building performance standards & benchmarking', eff: 'Phasing in', body: 'More jurisdictions require energy benchmarking and set performance thresholds with penalties. Capex planning should anticipate compliance.', link: null },
    { tag: 'Compliance', sev: 'low', title: 'Beneficial ownership / entity reporting', eff: 'Annual', body: 'Ownership-entity reporting obligations continue for SPVs and JVs. Keep the cap table and registered agents current.', link: null }
  ];

  // ---- white papers & case studies (industrial / flex) ----
  var RESEARCH = [
    { type: 'White Paper', title: 'Shallow-Bay Industrial: The Infill Flex Thesis', author: 'ORA Research', mins: 12, tag: 'Strategy', body: 'Why sub-100k SF multi-tenant flex compounds with low capex intensity and durable tenant demand in supply-constrained infill.' },
    { type: 'White Paper', title: 'Capturing Embedded Rent: Mark-to-Market in NNN Portfolios', author: 'ORA Research', mins: 9, tag: 'NOI', body: 'A framework for sequencing renewals to roll below-market leases to market without spiking vacancy.' },
    { type: 'White Paper', title: 'Controllable vs Uncontrollable OpEx: Taming Tax & Insurance', author: 'ORA Research', mins: 11, tag: 'Operations', body: 'Playbook for appeals, valuation discipline, deductible structuring and recovery clauses as tax and insurance outpace revenue.' },
    { type: 'Case Study', title: 'Lease-Up of a 56k SF Flex Park in 7 Months', author: 'Asset Management', mins: 6, tag: 'Leasing', body: 'How targeted concessions and a small-bay demising plan took occupancy from 78% to 94%.' },
    { type: 'Case Study', title: 'Cost-Segregation on a $14M Industrial Acquisition', author: 'Tax & Structuring', mins: 7, tag: 'Tax', body: 'Accelerated depreciation outcomes and the after-tax IRR impact on a low-leverage buy.' },
    { type: 'Case Study', title: 'Repositioning Class B Shallow-Bay to Institutional', author: 'Investments', mins: 8, tag: 'Value-Add', body: 'Capex sequencing, roof/HVAC and re-tenanting that re-rated a tired asset.' }
  ];

  return {
    AS_OF: AS_OF, RATES: RATES, BRIEFING: BRIEFING, NATIONAL: NATIONAL,
    REGULATION: REGULATION, RESEARCH: RESEARCH, LINK: LINK,
    marketTrends: marketTrends, spark: null, seed: seed, pfYoY: pfYoY
  };
})();
