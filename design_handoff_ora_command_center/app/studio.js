/* ORA Analytics Studio — interactive cross-filtering across charts.
   Click any region bar, type bar, scatter point or heat cell to filter
   every other view. Click the same element (or a chip's ✕) to clear. */
(function () {
  // ---- dataset: shared canonical portfolio from the data layer ----
  var DATA = (window.ORA && ORA.PROPERTIES) ? ORA.PROPERTIES : [];

  var REGIONS = (window.ORA && ORA.MARKETS) ? ORA.MARKETS : ['Eastgate','Riverside','Lakewood','Southport','Tri-County'];
  var TYPES = ['Industrial', 'Flex'];
  var CVAR = { Eastgate: '--accent', Riverside: '--blue', Lakewood: '--amber', Southport: '--violet', 'Tri-County': '--green',
    Industrial: '--blue', Flex: '--accent' };

  var filters = { region: null, type: null };

  function fmt(v) { return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + 'M'; }
  function cssv(n) { return 'var(' + n + ')'; }

  // data filtered by all active filters except the named dimension
  function subset(except) {
    return DATA.filter(function (d) {
      if (filters.region && except !== 'region' && d.region !== filters.region) return false;
      if (filters.type && except !== 'type' && d.type !== filters.type) return false;
      return true;
    });
  }
  function sumBy(rows, key, val) {
    var m = {}; rows.forEach(function (d) { m[d[key]] = (m[d[key]] || 0) + d[val]; }); return m;
  }

  function toggle(dim, value) {
    filters[dim] = (filters[dim] === value) ? null : value;
    render();
  }

  // ---- renderers ----
  function renderChips() {
    var box = document.getElementById('xfchips');
    var chips = '';
    ['region', 'type'].forEach(function (dim) {
      if (filters[dim]) {
        chips += '<span class="xfchip" data-dim="' + dim + '">' + filters[dim] + ' <span class="x">✕</span></span>';
      }
    });
    if (!chips) chips = '<span class="xfchip empty">no filters · showing all ' + DATA.length + ' assets</span>';
    box.innerHTML = chips;
    box.querySelectorAll('.xfchip[data-dim]').forEach(function (c) {
      c.onclick = function () { toggle(c.getAttribute('data-dim'), filters[c.getAttribute('data-dim')]); };
    });
    document.getElementById('xfclear').style.display = (filters.region || filters.type) ? '' : 'none';
  }

  function renderKpis() {
    var rows = subset();
    var aum = rows.reduce(function (s, d) { return s + d.value; }, 0);
    var noi = rows.reduce(function (s, d) { return s + d.noi; }, 0);
    var occ = rows.length ? rows.reduce(function (s, d) { return s + d.occ; }, 0) / rows.length : 0;
    var cap = rows.length ? rows.reduce(function (s, d) { return s + d.cap * d.value; }, 0) / aum : 0;
    document.getElementById('kpis').innerHTML =
      kpi('AUM (FILTERED)', fmt(aum), rows.length + ' assets', 'g') +
      kpi('NOI / YR', '$' + noi.toFixed(1) + 'M', (aum ? (noi / aum * 100).toFixed(1) : 0) + '% yield', 'g') +
      kpi('AVG OCCUPANCY', occ.toFixed(1) + '%', occ >= 93 ? 'healthy' : 'watch', occ >= 93 ? 'g' : 'r') +
      kpi('WTD CAP RATE', cap.toFixed(2) + '%', 'value-weighted', 'g');
  }
  function kpi(l, v, s, c) {
    return '<div class="kpi"><div class="lbl">' + l + '</div><div class="v">' + v +
      '</div><div class="dl ' + c + '">' + s + '</div></div>';
  }

  function renderBars() {
    var agg = sumBy(subset('region'), 'region', 'value');
    var max = Math.max.apply(null, REGIONS.map(function (r) { return agg[r] || 0; })) || 1;
    document.getElementById('chRegion').innerHTML = REGIONS.map(function (r) {
      var v = agg[r] || 0, h = Math.round(v / max * 150) + 4;
      var sel = filters.region === r, dim = filters.region && !sel;
      return '<div class="bcol ' + (sel ? 'sel' : '') + (dim ? ' dim' : '') + '" data-r="' + r + '">' +
        '<div class="bk" style="height:' + h + 'px"><i style="height:100%;background:' + cssv(CVAR[r]) + '"></i></div>' +
        '<div class="bl">' + r.replace(' ', '\u00a0') + ' · $' + v.toFixed(0) + 'M</div></div>';
    }).join('');
    document.getElementById('chRegion').querySelectorAll('.bcol').forEach(function (b) {
      b.onclick = function () { toggle('region', b.getAttribute('data-r')); };
    });
  }

  function renderHBars() {
    var agg = sumBy(subset('type'), 'type', 'value');
    var max = Math.max.apply(null, TYPES.map(function (t) { return agg[t] || 0; })) || 1;
    document.getElementById('chType').innerHTML = TYPES.map(function (t) {
      var v = agg[t] || 0, w = Math.round(v / max * 100);
      var sel = filters.type === t, dim = filters.type && !sel;
      return '<div class="hbar ' + (dim ? 'dim' : '') + '" data-t="' + t + '">' +
        '<div class="hb-top"><span>' + t + (sel ? ' ◂' : '') + '</span><span class="v">' + fmt(v) + '</span></div>' +
        '<div class="track"><span style="width:' + w + '%;background:' + cssv(CVAR[t]) + '"></span></div></div>';
    }).join('');
    document.getElementById('chType').querySelectorAll('.hbar').forEach(function (b) {
      b.onclick = function () { toggle('type', b.getAttribute('data-t')); };
    });
  }

  function renderScatter() {
    var maxV = Math.max.apply(null, DATA.map(function (d) { return d.value; }));
    var pts = DATA.map(function (d) {
      var x = (d.occ - 80) / 20 * 96 + 2;        // 80-100% -> 2-98%
      var y = (d.cap - 6.5) / 2.0 * 92 + 4;       // 6.5-8.5% -> 4-96% (from bottom)
      var size = 8 + d.value / maxV * 16;
      var active = (!filters.region || d.region === filters.region) && (!filters.type || d.type === filters.type);
      return '<div class="pt ' + (active ? '' : 'dim') + '" title="' + d.name + ' · ' + d.cap.toFixed(1) + '% cap · ' + d.occ + '% occ" ' +
        'style="left:' + x.toFixed(1) + '%;bottom:' + y.toFixed(1) + '%;width:' + size.toFixed(0) + 'px;height:' + size.toFixed(0) + 'px;background:' + cssv(CVAR[d.region]) + '"></div>';
    }).join('');
    var sc = document.getElementById('chScatter');
    // keep axis labels (first 4 children), replace points
    sc.querySelectorAll('.pt').forEach(function (p) { p.remove(); });
    sc.insertAdjacentHTML('beforeend', pts);
    var shown = DATA.filter(function (d) { return (!filters.region || d.region === filters.region) && (!filters.type || d.type === filters.type); }).length;
    document.getElementById('scCount').textContent = shown + ' assets';
  }

  function renderHeat() {
    var grid = {};
    DATA.forEach(function (d) { grid[d.region + '|' + d.type] = (grid[d.region + '|' + d.type] || 0) + d.value; });
    var max = Math.max.apply(null, Object.keys(grid).map(function (k) { return grid[k]; })) || 1;
    var html = '<div class="hh"></div>' + TYPES.map(function (t) { return '<div class="hh">' + t.slice(0, 4) + '</div>'; }).join('');
    REGIONS.forEach(function (r) {
      html += '<div class="hh" style="justify-content:flex-end;padding-right:6px">' + r.split(' ')[0] + '</div>';
      TYPES.forEach(function (t) {
        var v = grid[r + '|' + t] || 0, op = v ? (0.14 + v / max * 0.86) : 0.05;
        var active = (!filters.region || filters.region === r) && (!filters.type || filters.type === t);
        html += '<div class="hc" data-r="' + r + '" data-t="' + t + '" style="background:rgba(57,211,192,' + (active ? op : op * 0.25).toFixed(2) + ');color:' + (op > 0.5 ? 'var(--accent-ink)' : 'var(--ink-2)') + '">' + (v ? v.toFixed(0) : '·') + '</div>';
      });
    });
    var heat = document.getElementById('chHeat');
    heat.style.gridTemplateColumns = 'auto repeat(4,1fr)';
    heat.innerHTML = html;
    heat.querySelectorAll('.hc[data-r]').forEach(function (c) {
      c.onclick = function () {
        var r = c.getAttribute('data-r'), t = c.getAttribute('data-t');
        var both = filters.region === r && filters.type === t;
        filters.region = both ? null : r; filters.type = both ? null : t; render();
      };
    });
  }

  function renderTable() {
    var rows = subset().sort(function (a, b) { return b.value - a.value; });
    document.querySelector('#chTable tbody').innerHTML = rows.map(function (d) {
      return '<tr class="click" onclick="location.href=\'Property.html?id=' + d.id + '\'"><td><b>' + d.name + '</b></td><td class="muted">' + d.region +
        '</td><td>' + d.type + '</td><td class="r num">' + fmt(d.value) + '</td><td class="r num' + (d.occ < 90 ? ' neg' : '') + '">' + d.occ +
        '%</td><td class="r num">' + d.cap.toFixed(1) + '%</td><td class="r num">$' + d.noi.toFixed(2) + 'M</td></tr>';
    }).join('');
    document.getElementById('subTable').textContent = (filters.region || filters.type)
      ? rows.length + ' of ' + DATA.length + ' assets · filtered' : 'all ' + DATA.length + ' assets';
  }

  function renderActions() {
    var box = document.getElementById('studioActions');
    if (!box || !window.ORA_ENGINE) return;
    var sel = subset();   // assets matching the current cross-filter
    var dealSel = ORA.DEALS.filter(function (d) {
      if (filters.region && d.region !== filters.region) return false;
      if (filters.type && d.type !== filters.type) return false;
      return true;
    });
    var sigs = ORA_ENGINE.signalsFor(sel, dealSel);
    var rows = sigs.slice(0, 4);
    box.innerHTML = rows.length ? rows.map(ORA_ENGINE.rowHtml).join('')
      : '<div class="cmdk-empty" style="padding:18px">No actions for this selection.</div>';
    var sub = document.getElementById('saSub');
    if (sub) sub.textContent = (filters.region || filters.type)
      ? sigs.length + ' actions for ' + [filters.region, filters.type].filter(Boolean).join(' · ') + ' \u00b7 ranked by $ impact'
      : 'across all ' + DATA.length + ' assets \u00b7 ranked by $ impact';
  }

  function render() {
    renderChips(); renderKpis(); renderBars(); renderHBars(); renderScatter(); renderHeat(); renderTable(); renderActions();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var clr = document.getElementById('xfclear');
    if (clr) clr.onclick = function () { filters.region = null; filters.type = null; render(); };
    render();
  });
})();
