/* ORA Command Center — global portfolio filter.
   One slice (market / subtype / property manager) that persists across
   every module via sessionStorage. Changing it re-runs the insight engine
   on the slice and notifies every subscribed view, so a thread can be
   chased Portfolio → Financials → Insights without re-selecting.

   Load order: data.js → filter.js → engine.js → (page script).
   State is available synchronously at load so the engine builds filtered. */
window.ORA_FILTER = (function () {
  var O = window.ORA;
  var KEY = 'ora-filter';
  var state = { market: '', type: '', pm: '', period: '' };  // period '' = current month
  try { var saved = JSON.parse(sessionStorage.getItem(KEY) || '{}'); Object.assign(state, saved); } catch (e) {}

  var subs = [];
  function pmName(id) { for (var i = 0; i < O.PMS.length; i++) if (O.PMS[i].id === id) return O.PMS[i].name; return id; }

  function matchProp(p) {
    if (state.market && p.market !== state.market) return false;
    if (state.type && p.subtype !== state.type) return false;
    if (state.pm && p.pmId !== state.pm) return false;
    return true;
  }
  function matchDeal(d) {
    if (state.market && d.region !== state.market) return false;
    if (state.type && d.type !== state.type) return false;   // pm n/a to deals
    return true;
  }
  // predicate for a rendered table row carrying data-mkt / data-type / data-pm
  function matchProp_row(tr) {
    if (state.market && tr.getAttribute('data-mkt') !== state.market) return false;
    if (state.type && tr.getAttribute('data-type') !== state.type) return false;
    if (state.pm && tr.getAttribute('data-pm') !== state.pm) return false;
    return true;
  }
  function properties() { return O.PROPERTIES.filter(matchProp); }
  function deals() { return O.DEALS.filter(matchDeal); }
  // ---- reporting period ("as of" month over the modeled history) ----
  function asOf() { var i = (state.period === '' || state.period == null) ? O.NOW : +state.period; if (isNaN(i) || i < 0 || i > O.NOW) i = O.NOW; return i; }
  function atCurrent() { return asOf() === O.NOW; }
  function periodLabel() { return O.MONTHS[asOf()].label; }
  function active() { return !!(state.market || state.type || state.pm); }
  function markets() {
    // markets available given the other two filters (keeps the bar coherent)
    var m = {}; O.PROPERTIES.forEach(function (p) { if ((!state.type || p.subtype === state.type) && (!state.pm || p.pmId === state.pm)) m[p.market] = 1; });
    return O.MARKETS.filter(function (x) { return m[x]; });
  }

  function slice() {
    var ps = properties(), idx = asOf();
    var aum = 0, noi = 0, sf = 0, ten = 0, occW = 0;
    ps.forEach(function (p) {
      var h = p.hist, v = h ? h.val[idx] : p.value, n = h ? h.noi[idx] : p.noi, o = h ? h.occ[idx] : p.occ;
      aum += v; noi += n; sf += p.sf; ten += p.units; occW += o * v;
    });
    var occ = aum ? occW / aum : 0;
    return { count: ps.length, total: O.PROPERTIES.length, aum: aum, noi: noi, sf: sf, tenants: ten, occ: occ, asOf: idx, label: O.MONTHS[idx].label };
  }

  function persist() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function notify() {
    if (window.ORA_ENGINE && ORA_ENGINE.rebuild) ORA_ENGINE.rebuild();
    var s = slice();
    subs.forEach(function (cb) { try { cb(s, state); } catch (e) { console.warn(e); } });
    paintBar();
  }

  function set(key, val) { state[key] = val; persist(); notify(); }
  function clear() { state.market = ''; state.type = ''; state.pm = ''; persist(); notify(); }  // keeps the as-of period
  function subscribe(cb) { subs.push(cb); return cb; }

  // ---- the bar ----
  var barEl = null;
  function buildBar() {
    var host = document.querySelector('.content');
    if (!host || document.getElementById('globalFilter')) return;
    barEl = document.createElement('div');
    barEl.className = 'gfbar';
    barEl.id = 'globalFilter';
    function opts(list, cur, allLabel) {
      return '<option value="">' + allLabel + '</option>' + list.map(function (o) {
        var v = o.v || o, l = o.l || o;
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + l + '</option>';
      }).join('');
    }
    // last 6 months selectable, newest first; '' (current) maps to NOW
    function periodOpts() {
      var out = '', cur = state.period === '' ? String(O.NOW) : state.period;
      for (var i = O.NOW; i >= Math.max(0, O.NOW - 5); i--) {
        var lbl = O.MONTHS[i].label + (i === O.NOW ? ' · current' : '');
        out += '<option value="' + i + '"' + (String(i) === cur ? ' selected' : '') + '>' + lbl + '</option>';
      }
      return out;
    }
    barEl.innerHTML =
      '<span class="gfl"><svg viewBox="0 0 24 24"><path d="M3 5h18M6 12h12M10 19h4"/></svg>Portfolio filter</span>' +
      '<span class="gfgrp"><label>Market</label><select class="gfsel" data-k="market">' + opts(O.MARKETS, state.market, 'All markets') + '</select></span>' +
      '<span class="gfgrp"><label>Type</label><select class="gfsel" data-k="type">' + opts(['Industrial', 'Flex'], state.type, 'All types') + '</select></span>' +
      '<span class="gfgrp"><label>Manager</label><select class="gfsel" data-k="pm">' + opts(O.PMS.map(function (m) { return { v: m.id, l: m.name }; }), state.pm, 'All managers') + '</select></span>' +
      '<span class="gfdiv"></span>' +
      '<span class="gfgrp gfpergrp"><label>As of</label><select class="gfsel gfper" data-k="period">' + periodOpts() + '</select></span>' +
      '<span class="gfslice" id="gfSlice"></span>' +
      '<span class="gfclear" id="gfClear">Clear ✕</span>';
    host.insertBefore(barEl, host.firstChild);
    barEl.addEventListener('change', function (e) {
      var sel = e.target.closest('.gfsel'); if (!sel) return;
      var k = sel.getAttribute('data-k');
      var v = (k === 'period' && String(sel.value) === String(O.NOW)) ? '' : sel.value;
      set(k, v);
    });
    barEl.querySelector('#gfClear').addEventListener('click', clear);
    paintBar();
  }
  function paintBar() {
    if (!barEl) return;
    var rewound = !atCurrent();
    barEl.classList.toggle('active', active() || rewound);
    barEl.classList.toggle('rewound', rewound);
    barEl.querySelectorAll('.gfsel').forEach(function (sel) {
      var k = sel.getAttribute('data-k');
      if (k === 'period') { sel.value = String(asOf()); sel.classList.toggle('set', rewound); return; }
      var v = state[k];
      sel.value = v || '';
      sel.classList.toggle('set', !!v);
    });
    var s = slice(), el = barEl.querySelector('#gfSlice');
    var asof = rewound ? '<span class="gfas">as of ' + s.label + '</span> ' : '';
    if (el) el.innerHTML = active()
      ? asof + '<b>' + s.count + '</b> of ' + s.total + ' assets · <b>' + O.fmtM(s.aum) + '</b> AUM · <b>$' + s.noi.toFixed(1) + 'M</b> NOI · ' + s.occ.toFixed(0) + '% occ'
      : asof + 'all <b>' + s.total + '</b> assets · <b>' + O.fmtM(s.aum) + '</b> AUM · ' + s.occ.toFixed(0) + '% occ';
    barEl.querySelector('#gfClear').classList.toggle('hide', !active());
  }

  document.addEventListener('DOMContentLoaded', function () { buildBar(); });

  return {
    state: state, properties: properties, deals: deals, slice: slice,
    matchProp: matchProp, matchDeal: matchDeal, matchProp_row: matchProp_row,
    active: active, markets: markets, asOf: asOf, atCurrent: atCurrent, periodLabel: periodLabel,
    set: set, clear: clear, subscribe: subscribe, pmName: pmName
  };
})();
