/* ORA Command Center — Trend & Anomaly engine.
   Operates on the modeled monthly history in window.ORA (p.S, GLOBAL_MONTHS).
   Provides: series math (MoM / YoY / CAGR / rolling stats), anomaly detection
   (MoM spike, statistical outlier, expense-outpaces-revenue, sustained
   direction change, variance vs budget, YoY variance), portfolio aggregation,
   and a compact inline-SVG trend chart with prior-year overlay + anomaly dots.
   Load order: data.js → trends.js → (engine.js, page scripts). */
window.ORA_TRENDS = (function () {
  var O = window.ORA;
  var GM = O.GLOBAL_MONTHS, LAST = O.GLAST;

  // ---------- series math ----------
  function momPct(s, i) { if (i <= 0 || s[i] == null || s[i - 1] == null || s[i - 1] === 0) return null; return (s[i] - s[i - 1]) / Math.abs(s[i - 1]) * 100; }
  function yoyPct(s, i) { var j = i - 12; if (j < 0 || s[i] == null || s[j] == null || s[j] === 0) return null; return (s[i] - s[j]) / Math.abs(s[j]) * 100; }
  function firstIdx(s) { for (var i = 0; i < s.length; i++) if (s[i] != null) return i; return LAST; }
  function cagr(s) { var a = firstIdx(s), months = LAST - a; if (months < 6 || s[a] <= 0 || s[LAST] == null) return null; return (Math.pow(s[LAST] / s[a], 12 / months) - 1) * 100; }
  // organic CAGR over an explicit window (use with a same-store/constant set)
  function cagrWindow(s, from) { if (from == null || s[from] == null || s[LAST] == null || s[from] <= 0) return null; var months = LAST - from; if (months < 6) return null; return (Math.pow(s[LAST] / s[from], 12 / months) - 1) * 100; }
  function stats(arr) { var v = arr.filter(function (x) { return x != null && !isNaN(x); }); if (!v.length) return { mean: 0, sd: 0, n: 0 }; var m = v.reduce(function (t, x) { return t + x; }, 0) / v.length; var sd = Math.sqrt(v.reduce(function (t, x) { return t + (x - m) * (x - m); }, 0) / v.length); return { mean: m, sd: sd, n: v.length }; }
  function momSeries(s) { var o = []; for (var i = 0; i < s.length; i++) o.push(momPct(s, i)); return o; }

  // ---------- anomaly detection ----------
  // thresholds tuned so the modeled steps/spikes surface as real, sparse flags
  var EXPENSE = { tax: 1, ins: 1, rm: 1, util: 1, mgmt: 1, other: 1, opex: 1 };
  var LABEL = { rev: 'Revenue', tax: 'Property tax', ins: 'Insurance', rm: 'Repairs & maint.', util: 'Utilities', mgmt: 'Mgmt fee', other: 'Other', opex: 'Operating expense', noi: 'NOI', occ: 'Occupancy', value: 'Value', cap: 'Cap rate' };

  function money(n) { var a = Math.abs(n), s = n < 0 ? '\u2212' : '+'; if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K'; return s + '$' + Math.round(a); }

  // anomalies for one property, anchored on the current (month-end) period plus
  // notable historical MoM spikes for chart markers.
  function detect(p) {
    if (!p.S) return [];
    var S = p.S, B = S.budget, out = [], i = LAST;
    function push(o) { o.pid = p.id; o.pname = p.name; o.market = p.market; out.push(o); }

    // -- per opex line + revenue: current-month MoM spike, YoY, vs budget --
    ['rev', 'tax', 'ins', 'rm', 'util', 'mgmt', 'other'].forEach(function (k) {
      var s = S[k], isExp = !!EXPENSE[k];
      var mom = momPct(s, i), yoy = yoyPct(s, i);
      var ms = stats(momSeries(s).slice(p.acqIdx + 1)), z = ms.sd ? (mom - ms.mean) / ms.sd : 0;
      var bud = B[k] ? B[k][i] : null, varPct = bud ? (s[i] - bud) / bud * 100 : null;
      var annual = s[i] * 12;

      // MoM spike / statistical outlier
      if (mom != null && Math.abs(mom) >= 12 && Math.abs(z) >= 1.9) {
        var bad = isExp ? mom > 0 : mom < 0;
        push({ metric: k, gi: i, type: 'spike', dir: bad ? 'risk' : 'gain', sev: Math.abs(mom) >= 24 ? 'high' : 'med',
          deltaPct: mom, impact: Math.abs(s[i] - s[i - 1]) * 12,
          title: LABEL[k] + ' ' + (mom > 0 ? 'jumped' : 'dropped') + ' ' + Math.abs(mom).toFixed(0) + '% month-over-month',
          note: GM[i].label + ' \u00b7 ' + money(s[i] * (isExp ? 1 : 1)) + '/mo, ' + Math.abs(z).toFixed(1) + '\u03c3 from trend' });
      }
      // YoY variance beyond band (insurance/tax run hot)
      var band = k === 'ins' ? 11 : k === 'tax' ? 8 : k === 'rev' ? -0.5 : 9;
      if (yoy != null && ((isExp && yoy >= band) || (k === 'rev' && yoy <= band))) {
        push({ metric: k, gi: i, type: 'yoy', dir: (isExp ? 1 : -1) * yoy > 0 ? 'risk' : 'gain', sev: (isExp && yoy >= band + 6) ? 'high' : 'med',
          deltaPct: yoy, impact: Math.abs(s[i] - s[i - 12]) * 12,
          title: LABEL[k] + ' ' + (yoy >= 0 ? 'up' : 'down') + ' ' + Math.abs(yoy).toFixed(0) + '% year-over-year',
          note: money(s[i] * 12) + '/yr vs ' + money(S[k][i - 12] * 12) + ' a year ago \u00b7 ' + p.market });
      }
      // variance vs budget (current month)
      var thr = isExp ? 8 : 5;
      if (varPct != null && ((isExp && varPct >= thr) || (k === 'rev' && varPct <= -thr))) {
        push({ metric: k, gi: i, type: 'budget', dir: 'risk', sev: Math.abs(varPct) >= thr * 2 ? 'high' : 'med',
          deltaPct: varPct, impact: Math.abs(s[i] - bud) * 12,
          title: LABEL[k] + ' ' + Math.abs(varPct).toFixed(0) + '% ' + (varPct > 0 ? 'over' : 'under') + ' budget',
          note: money(s[i]) + '/mo actual vs ' + money(bud) + ' plan \u00b7 ' + GM[i].label });
      }
    });

    // -- expense ratio outpacing revenue (margin compression, trailing year) --
    var opexYoY = yoyPct(S.opex, i), revYoY = yoyPct(S.rev, i);
    if (opexYoY != null && revYoY != null && (opexYoY - revYoY) >= 3) {
      var marginNow = (1 - S.opex[i] / S.rev[i]) * 100, marginYr = (1 - S.opex[i - 12] / S.rev[i - 12]) * 100;
      push({ metric: 'opex', gi: i, type: 'margin', dir: 'risk', sev: (opexYoY - revYoY) >= 6 ? 'high' : 'med',
        deltaPct: opexYoY - revYoY, impact: Math.max(0, (S.opex[i] - S.opex[i - 12])) * 12,
        title: 'Expenses outpacing revenue \u2014 margin compressing',
        note: 'OpEx +' + opexYoY.toFixed(0) + '% vs revenue +' + revYoY.toFixed(0) + '% YoY \u00b7 NOI margin ' + marginYr.toFixed(0) + '% \u2192 ' + marginNow.toFixed(0) + '%' });
    }

    // -- sustained NOI direction change --
    var noiStreak = O.declineStreak(S.noi, i);
    if (noiStreak >= 3) {
      push({ metric: 'noi', gi: i, type: 'trend', dir: 'risk', sev: noiStreak >= 5 ? 'high' : 'med',
        deltaPct: (S.noi[i] - S.noi[i - noiStreak]) / S.noi[i - noiStreak] * 100, impact: Math.abs(S.noi[i] - S.noi[i - noiStreak]) * 12,
        title: 'NOI down ' + noiStreak + ' straight months',
        note: money(S.noi[i - noiStreak] * 12) + ' \u2192 ' + money(S.noi[i] * 12) + '/yr over ' + GM[i - noiStreak].short + '\u2013' + GM[i].short + ' \u00b7 ' + p.market });
    }

    return out;
  }

  // historical MoM spikes of a single metric (for chart markers across the window)
  function spikeMarkers(p, metric, fromGi) {
    var s = p.S[metric], ms = stats(momSeries(s).slice(p.acqIdx + 1)), out = [];
    for (var i = Math.max(p.acqIdx + 1, fromGi); i <= LAST; i++) {
      var mom = momPct(s, i), z = ms.sd ? (mom - ms.mean) / ms.sd : 0;
      if (mom != null && Math.abs(mom) >= 12 && Math.abs(z) >= 1.9) out.push({ gi: i, mom: mom });
    }
    return out;
  }

  function detectAll(props) {
    var all = []; (props || O.PROPERTIES).forEach(function (p) { detect(p).forEach(function (a) { all.push(a); }); });
    return all.sort(function (a, b) { return (b.impact || 0) - (a.impact || 0); });
  }

  // ---------- aggregation ----------
  // portfolio (or slice) monthly total of a $ metric, summing only owned assets
  function portfolioSeries(props, metric) {
    var out = new Array(LAST + 1).fill(null);
    for (var i = 0; i <= LAST; i++) {
      var t = 0, any = false;
      props.forEach(function (p) { var v = p.S && p.S[metric] != null ? p.S[metric][i] : null; if (v != null) { t += v; any = true; } });
      out[i] = any ? t : null;
    }
    return out;
  }
  function occSeries(props) { // value-weighted occupancy
    var out = new Array(LAST + 1).fill(null);
    for (var i = 0; i <= LAST; i++) {
      var num = 0, den = 0;
      props.forEach(function (p) { if (p.S && p.S.occ[i] != null) { num += p.S.occ[i] * p.S.value[i]; den += p.S.value[i]; } });
      out[i] = den ? num / den : null;
    }
    return out;
  }

  // ---------- horizon helper ----------
  function startGi(horizon, props) {
    if (horizon === '1Y') return Math.max(0, LAST - 12);
    if (horizon === '3Y') return Math.max(0, LAST - 36);
    if (horizon === '5Y') return Math.max(0, LAST - 60);
    // 'max' / since acquisition
    if (props && props.length) { var m = LAST; props.forEach(function (p) { if (p.acqIdx < m) m = p.acqIdx; }); return m; }
    return 0;
  }

  // ---------- chart ----------
  // opts: { series, budget, compareYoY(bool), color, fmt(v), height, markers[], smoothMonths }
  function chart(series, fromGi, opts) {
    opts = opts || {}; var H = opts.height || 190, W = 1000, color = opts.color || 'var(--accent)';
    var fmt = opts.fmt || function (v) { return Math.round(v); };
    var xs = [], idxs = [];
    for (var i = fromGi; i <= LAST; i++) { idxs.push(i); }
    var n = idxs.length;
    function vals(arr) { return idxs.map(function (i) { return arr ? arr[i] : null; }).filter(function (v) { return v != null; }); }
    var prim = vals(series), bud = opts.budget ? vals(opts.budget) : [];
    var cmp = [];
    if (opts.compareYoY) { cmp = idxs.map(function (i) { return (i - 12 >= 0 && series[i - 12] != null) ? series[i - 12] : null; }); }
    var pool = prim.concat(bud).concat(cmp.filter(function (v) { return v != null; }));
    var mn = Math.min.apply(null, pool), mx = Math.max.apply(null, pool);
    var pad = (mx - mn) * 0.15 || 1; mn -= pad; mx += pad;
    function X(k) { return n <= 1 ? 0 : k / (n - 1) * W; }
    function Y(v) { return H - (v - mn) / (mx - mn) * H; }
    // build primary path (gap-aware)
    var dPath = '', area = '', started = false, firstX = 0, lastX = 0;
    idxs.forEach(function (gi, k) {
      var v = series[gi]; if (v == null) return;
      var x = X(k).toFixed(1), y = Y(v).toFixed(1);
      if (!started) { dPath = 'M' + x + ',' + y; area = 'M' + x + ',' + H + ' L' + x + ',' + y; firstX = x; started = true; }
      else { dPath += ' L' + x + ',' + y; area += ' L' + x + ',' + y; }
      lastX = x;
    });
    area += ' L' + lastX + ',' + H + ' Z';
    // compare (prior-year) dashed line
    var cmpPath = '';
    if (opts.compareYoY) { var st = false; idxs.forEach(function (gi, k) { var v = (gi - 12 >= 0) ? series[gi - 12] : null; if (v == null) return; var x = X(k).toFixed(1), y = Y(v).toFixed(1); cmpPath += (st ? ' L' : 'M') + x + ',' + y; st = true; }); }
    // budget dotted line
    var budPath = '';
    if (opts.budget) { var sb = false; idxs.forEach(function (gi, k) { var v = opts.budget[gi]; if (v == null) return; var x = X(k).toFixed(1), y = Y(v).toFixed(1); budPath += (sb ? ' L' : 'M') + x + ',' + y; sb = true; }); }
    // anomaly markers
    var dots = '';
    (opts.markers || []).forEach(function (mk) {
      var k = idxs.indexOf(mk.gi); if (k < 0 || series[mk.gi] == null) return;
      var x = X(k).toFixed(1), y = Y(series[mk.gi]).toFixed(1);
      var col = mk.dir === 'gain' ? 'var(--green)' : 'var(--red)';
      dots += '<circle cx="' + x + '" cy="' + y + '" r="5.5" fill="' + col + '" stroke="var(--panel)" stroke-width="2"><title>' + (mk.title || '') + '</title></circle>';
    });
    var gid = 'tg' + Math.random().toString(36).slice(2, 7);
    var grid = '';
    for (var g = 1; g <= 3; g++) { var gy = (H / 4 * g).toFixed(0); grid += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="var(--line-2)"/>'; }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px;display:block;overflow:visible">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + color + '" stop-opacity=".20"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      (cmpPath ? '<path d="' + cmpPath + '" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="5 4" opacity=".75"/>' : '') +
      (budPath ? '<path d="' + budPath + '" fill="none" stroke="var(--ink-3,#8a93a3)" stroke-width="1.4" stroke-dasharray="2 4" opacity=".7"/>' : '') +
      '<path d="' + dPath + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linejoin="round"/>' +
      dots + '</svg>';
  }

  // axis labels (~6 ticks) for a window
  function axisLabels(fromGi, max) {
    max = max || 6; var n = LAST - fromGi + 1, step = Math.max(1, Math.round(n / max)), out = [];
    for (var i = fromGi; i <= LAST; i += step) out.push(GM[i].short + (GM[i].m === 0 || i === fromGi ? " '" + String(GM[i].y).slice(2) : ''));
    return out;
  }

  return {
    momPct: momPct, yoyPct: yoyPct, cagr: cagr, cagrWindow: cagrWindow, stats: stats, momSeries: momSeries, firstIdx: firstIdx,
    detect: detect, detectAll: detectAll, spikeMarkers: spikeMarkers,
    portfolioSeries: portfolioSeries, occSeries: occSeries, startGi: startGi,
    chart: chart, axisLabels: axisLabels, money: money, LABEL: LABEL, LAST: LAST, GM: GM
  };
})();
