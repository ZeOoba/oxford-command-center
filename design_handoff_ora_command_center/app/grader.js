/* ORA Command Center — OM Grader.
   A buy-box scoring engine. Defines Oxford RA's acquisition criteria (asset
   type, geography, size, going-in cap, levered IRR, equity multiple, leverage,
   occupancy / value-add, vintage, mark-to-market upside) with weights and
   thresholds, scores any deal against them into a 0–100 + letter grade with
   per-criterion sub-scores, and can grade both the live pipeline (window.ORA
   DEALS) and uploaded OMs (pre-baked samples + manual entry).
   Load: data.js → grader.js. */
window.ORA_GRADER = (function () {
  var O = window.ORA;
  var TARGET_MARKETS = O.MARKETS;                  // Eastgate, Riverside, Lakewood, Southport, Tri-County
  var ADJACENT = ['Valley', 'Meridian', 'Harbor', 'Northline', 'Southgate', 'Cardinal'];

  // ---- the buy box ----
  var BUYBOX = {
    summary: 'Shallow-bay industrial & flex \u00b7 Class B/C \u00b7 5 core markets \u00b7 $3\u201320M \u00b7 going-in \u2265 7.0% \u00b7 IRR \u2265 14% \u00b7 \u2264 55% LTV \u00b7 mark-to-market upside',
    criteria: [
      { key: 'type', label: 'Asset type', weight: 16, kind: 'set',
        good: ['Industrial', 'Flex', 'Shallow-bay', 'Warehouse', 'Light industrial'],
        bad: ['Office', 'Retail', 'Multifamily', 'Big-box', 'Data center'],
        target: 'Shallow-bay industrial / flex' },
      { key: 'market', label: 'Geography', weight: 14, kind: 'market', target: '5 core markets' },
      { key: 'price', label: 'Deal size', weight: 9, kind: 'range', min: 3, max: 20, unit: 'M', target: '$3M\u2013$20M' },
      { key: 'capIn', label: 'Going-in cap', weight: 17, kind: 'min', min: 7.0, soft: 6.5, unit: '%', target: '\u2265 7.0%' },
      { key: 'irr', label: 'Levered IRR', weight: 15, kind: 'min', min: 14, soft: 12, unit: '%', target: '\u2265 14%' },
      { key: 'em', label: 'Equity multiple', weight: 8, kind: 'min', min: 1.7, soft: 1.5, unit: 'x', target: '\u2265 1.7x' },
      { key: 'ltv', label: 'Leverage', weight: 8, kind: 'max', max: 55, soft: 65, unit: '%', target: '\u2264 55% LTV' },
      { key: 'occ', label: 'Occupancy / value-add', weight: 7, kind: 'band', lo: 80, hi: 96, unit: '%', target: '80\u201396% (room to add)' },
      { key: 'vintage', label: 'Vintage', weight: 3, kind: 'min', min: 1985, soft: 1975, unit: '', target: '1985 or newer' },
      { key: 'mtm', label: 'Mark-to-market upside', weight: 3, kind: 'min', min: 6, soft: 2, unit: '%', target: 'In-place < market' }
    ],
    breakers: [
      { key: 'type', test: function (d) { return d.type && ['Office', 'Retail', 'Multifamily'].indexOf(d.type) > -1; }, msg: 'Asset type outside mandate' },
      { key: 'price', test: function (d) { return d.price != null && (d.price > 30 || d.price < 1.5); }, msg: 'Deal size far outside $3\u201320M' }
    ]
  };

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function scoreCriterion(c, d) {
    var v = d[c.key], s = 0, status = 'warn', shown = v;
    if (v == null || v === '') return { score: 0.5, status: 'warn', value: '\u2014', note: 'not stated' };
    if (c.kind === 'set') {
      var t = String(v);
      if (c.good.some(function (g) { return t.toLowerCase().indexOf(g.toLowerCase()) > -1; })) { s = 1; status = 'pass'; }
      else if (c.bad.some(function (b) { return t.toLowerCase().indexOf(b.toLowerCase()) > -1; })) { s = 0.05; status = 'fail'; }
      else { s = 0.5; status = 'warn'; }
    } else if (c.kind === 'market') {
      if (TARGET_MARKETS.some(function (m) { return String(v).toLowerCase().indexOf(m.toLowerCase()) > -1; })) { s = 1; status = 'pass'; }
      else if (ADJACENT.some(function (m) { return String(v).toLowerCase().indexOf(m.toLowerCase()) > -1; })) { s = 0.6; status = 'warn'; shown = v + ' (adjacent)'; }
      else { s = 0.15; status = 'fail'; shown = v + ' (off-thesis)'; }
    } else if (c.kind === 'min') {
      shown = v + c.unit;
      if (v >= c.min) { s = clamp01(0.85 + (v - c.min) / (c.min || 1) * 0.4); status = 'pass'; }
      else if (v >= c.soft) { s = 0.4 + (v - c.soft) / (c.min - c.soft) * 0.4; status = 'warn'; }
      else { s = clamp01(v / c.soft * 0.4); status = 'fail'; }
    } else if (c.kind === 'max') {
      shown = v + c.unit;
      if (v <= c.max) { s = clamp01(1 - (v / c.max) * 0.15); status = 'pass'; }
      else if (v <= c.soft) { s = 0.4 + (c.soft - v) / (c.soft - c.max) * 0.4; status = 'warn'; }
      else { s = 0.15; status = 'fail'; }
    } else if (c.kind === 'range') {
      shown = '$' + v + c.unit;
      if (v >= c.min && v <= c.max) { s = 1; status = 'pass'; }
      else if (v >= c.min * 0.6 && v <= c.max * 1.5) { s = 0.55; status = 'warn'; }
      else { s = 0.15; status = 'fail'; }
    } else if (c.kind === 'band') {
      shown = v + c.unit;
      if (v >= c.lo && v <= c.hi) { s = 1; status = 'pass'; }
      else if (v < c.lo) { s = clamp01(0.3 + v / c.lo * 0.4); status = v < 65 ? 'fail' : 'warn'; }
      else { s = 0.7; status = 'warn'; }   // very high occ = less value-add room
    }
    return { score: clamp01(s), status: status, value: shown, note: c.target };
  }

  function letter(score) {
    if (score >= 90) return ['A+', 'gr-A']; if (score >= 85) return ['A', 'gr-A']; if (score >= 80) return ['A\u2212', 'gr-A'];
    if (score >= 75) return ['B+', 'gr-B']; if (score >= 70) return ['B', 'gr-B']; if (score >= 66) return ['B\u2212', 'gr-B'];
    if (score >= 61) return ['C+', 'gr-C']; if (score >= 55) return ['C', 'gr-C']; if (score >= 50) return ['C\u2212', 'gr-C'];
    if (score >= 42) return ['D', 'gr-D']; return ['F', 'gr-F'];
  }

  function grade(d) {
    var crits = BUYBOX.criteria.map(function (c) {
      var r = scoreCriterion(c, d);
      return { key: c.key, label: c.label, weight: c.weight, target: c.target, score: r.score, status: r.status, value: r.value };
    });
    var wsum = BUYBOX.criteria.reduce(function (t, c) { return t + c.weight; }, 0);
    var raw = crits.reduce(function (t, c) { return t + c.score * c.weight; }, 0) / wsum * 100;
    // deal-breakers cap the grade hard
    var hits = BUYBOX.breakers.filter(function (b) { return b.test(d); });
    var score = hits.length ? Math.min(raw, 38) : raw;
    var L = letter(score);
    var passes = crits.filter(function (c) { return c.status === 'pass'; }).length;
    var fails = crits.filter(function (c) { return c.status === 'fail'; });
    var verdict, reason;
    if (hits.length) { verdict = 'Pass \u2014 outside the buy box'; reason = hits.map(function (h) { return h.msg; }).join('; ') + '. Hard mandate breach overrides otherwise-tradeable metrics.'; }
    else if (score >= 80) { verdict = 'Strong fit \u2014 advance to IC'; reason = 'Clears ' + passes + '/' + crits.length + ' criteria including the return hurdles and core-market test. This is squarely in the fairway.'; }
    else if (score >= 66) { verdict = 'Tradeable \u2014 sharpen the underwriting'; reason = 'Hits the thesis but ' + (fails.length ? fails.map(function (c) { return c.label.toLowerCase(); }).join(' & ') + ' need work' : 'a few metrics sit at the soft edge') + '. Re-trade price or model upside before LOI.'; }
    else if (score >= 50) { verdict = 'Marginal \u2014 only at the right basis'; reason = 'Multiple criteria miss; would need a meaningful price concession or a clear value-add path to pencil.'; }
    else { verdict = 'Below mandate \u2014 decline'; reason = 'Falls short on the criteria that matter most. Not worth committed diligence time.'; }
    return { score: Math.round(score), grade: L[0], cls: L[1], verdict: verdict, reason: reason, criteria: crits, breakers: hits, passes: passes, fails: fails.length };
  }

  // map a live DEAL → buy-box metrics
  function dealToInput(d) {
    return {
      name: d.name, type: d.type, market: d.region, price: d.price,
      capIn: d.capIn, irr: d.irr, em: d.em,
      ltv: +(d.debt / d.totalCost * 100).toFixed(0),
      occ: 88, vintage: 2002, mtm: 8   // pipeline deals: modeled stabilized assumptions
    };
  }
  function gradePipeline() {
    return O.DEALS.map(function (d) { var inp = dealToInput(d); var g = grade(inp); g.deal = d; g.input = inp; return g; })
      .sort(function (a, b) { return b.score - a.score; });
  }

  // ---- pre-baked sample OMs (what an upload would extract) ----
  var SAMPLES = [
    { id: 'sample-a', label: 'Greenfield Bay Industrial', file: 'Greenfield_Bay_OM.pdf',
      input: { name: 'Greenfield Bay Industrial', type: 'Shallow-bay industrial', market: 'Riverside', price: 11.4, capIn: 7.8, irr: 16.2, em: 1.9, ltv: 50, occ: 87, vintage: 2004, mtm: 11 } },
    { id: 'sample-b', label: 'Midpoint Flex Center', file: 'Midpoint_Flex_OM.pdf',
      input: { name: 'Midpoint Flex Center', type: 'Flex', market: 'Meridian', price: 8.2, capIn: 6.8, irr: 12.5, em: 1.55, ltv: 62, occ: 94, vintage: 1996, mtm: 4 } },
    { id: 'sample-c', label: 'Crown Plaza Office Park', file: 'Crown_Plaza_OM.pdf',
      input: { name: 'Crown Plaza Office Park', type: 'Office', market: 'Metro Center', price: 26, capIn: 6.1, irr: 9.5, em: 1.35, ltv: 70, occ: 72, vintage: 1988, mtm: 2 } }
  ];

  return {
    BUYBOX: BUYBOX, grade: grade, letter: letter, gradePipeline: gradePipeline,
    dealToInput: dealToInput, SAMPLES: SAMPLES, TARGET_MARKETS: TARGET_MARKETS
  };
})();
