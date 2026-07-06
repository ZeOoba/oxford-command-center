/* ORA — table enhancer. Any <table class="tbl" data-enhance> gets:
   · click-to-sort headers (numeric-aware, asc/desc)
   · a live search box
   · auto filter-chips from a column (data-chips="Header Name")
   Operates on existing DOM rows — no data rebinding required. */
(function () {
  function parseNum(t) {
    if (!t) return null;
    t = t.replace(/[\u2009\u00a0,]/g, '').trim();
    var neg = /^\(.*\)$/.test(t) || /[-\u2212\u25bc]/.test(t);
    var m = t.replace(/[^0-9.]/g, '');
    if (m === '' || isNaN(+m)) return null;
    return (neg ? -1 : 1) * parseFloat(m);
  }
  function colIsNumeric(rows, ci) {
    var n = 0, ok = 0;
    rows.forEach(function (r) {
      var c = r.cells[ci]; if (!c) return; n++;
      if (parseNum(c.textContent) !== null) ok++;
    });
    return n && ok / n > 0.6;
  }

  function enhance(table) {
    var thead = table.tHead, tbody = table.tBodies[0];
    if (!thead || !tbody) return;
    var ths = [].slice.call(thead.rows[0].cells);
    var allRows = [].slice.call(tbody.rows);

    // ---- toolbar ----
    var chipCol = table.getAttribute('data-chips');
    var ci = -1;
    if (chipCol) ths.forEach(function (th, i) { if (th.textContent.trim().toLowerCase() === chipCol.toLowerCase()) ci = i; });
    var tool = document.createElement('div');
    tool.className = 'tbltool';
    var chipHtml = '';
    if (ci >= 0) {
      var vals = [];
      allRows.forEach(function (r) { var v = (r.cells[ci] || {}).textContent; v = v && v.trim(); if (v && vals.indexOf(v) < 0) vals.push(v); });
      vals.sort();
      chipHtml = '<div class="tchips"><span class="fp on" data-v="">All</span>' +
        vals.map(function (v) { return '<span class="fp" data-v="' + v.replace(/"/g, '&quot;') + '">' + v + '</span>'; }).join('') + '</div>';
    }
    tool.innerHTML =
      '<div class="tsearch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>' +
      '<input type="text" placeholder="Search ' + allRows.length + ' rows…"></div>' + chipHtml +
      '<span class="tcount">' + allRows.length + ' rows</span>';
    table.parentNode.insertBefore(tool, table);

    var search = tool.querySelector('input');
    var count = tool.querySelector('.tcount');
    var chips = tool.querySelector('.tchips');
    var state = { q: '', chip: '' };

    function apply() {
      var shown = 0;
      allRows.forEach(function (r) {
        var txt = r.textContent.toLowerCase();
        var okQ = !state.q || txt.indexOf(state.q) > -1;
        var okC = !state.chip || (ci >= 0 && (r.cells[ci] || {}).textContent.trim() === state.chip);
        var okX = !table.__extFilter || table.__extFilter(r);
        var show = okQ && okC && okX;
        r.style.display = show ? '' : 'none';
        if (show) shown++;
      });
      count.textContent = shown + (shown === allRows.length ? ' rows' : ' of ' + allRows.length);
    }
    table.__apply = apply;
    search.addEventListener('input', function () { state.q = search.value.toLowerCase().trim(); apply(); });
    if (chips) chips.addEventListener('click', function (e) {
      var c = e.target.closest('.fp'); if (!c) return;
      chips.querySelectorAll('.fp').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on'); state.chip = c.getAttribute('data-v'); apply();
    });

    // ---- sorting ----
    var numeric = ths.map(function (_, i) { return colIsNumeric(allRows, i); });
    ths.forEach(function (th, i) {
      th.classList.add('sortable');
      th.insertAdjacentHTML('beforeend', '<span class="sarr"></span>');
      th.addEventListener('click', function () {
        var asc = th.getAttribute('data-dir') !== 'asc';
        ths.forEach(function (o) { o.removeAttribute('data-dir'); o.querySelector('.sarr').textContent = ''; });
        th.setAttribute('data-dir', asc ? 'asc' : 'desc');
        th.querySelector('.sarr').textContent = asc ? ' ▲' : ' ▼';
        var rows = [].slice.call(tbody.rows);
        rows.sort(function (a, b) {
          var ta = (a.cells[i] || {}).textContent || '', tb = (b.cells[i] || {}).textContent || '';
          var r;
          if (numeric[i]) { var na = parseNum(ta), nb = parseNum(tb); r = (na == null ? -Infinity : na) - (nb == null ? -Infinity : nb); }
          else r = ta.trim().localeCompare(tb.trim());
          return asc ? r : -r;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
  }

  function tryEnhance(t) {
    if (t.__enh) return;
    var tb = t.tBodies[0];
    if (!tb || tb.rows.length === 0) return; // populated later — enhance on next call
    t.__enh = 1; enhance(t);
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('table.tbl[data-enhance]').forEach(tryEnhance);
  });
  window.ORA_enhanceTables = function (root) {
    (root || document).querySelectorAll('table.tbl[data-enhance]').forEach(tryEnhance);
  };
  // apply an external row predicate (e.g. the global portfolio filter) that
  // composes with search/chips/sort. fn(row)->bool, or null to clear.
  window.ORA_tableExtFilter = function (table, fn) {
    if (!table) return;
    table.__extFilter = fn;
    if (table.__apply) table.__apply();
  };
})();
