/* ORA Command Center — shared interactions
   Rail injection + theme (3-way) + density persist across pages. */
(function () {
  var root = document.documentElement;

  /* ---------- shared navigation rail ---------- */
  var NAV = [
    ['overview','Overview.html','Home','<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'],
    ['portfolio','Portfolio.html','Folio','<path d="M4 19V5M4 19h16M8 16v-4M12 16V9M16 16v-7"/>'],
    ['acquisitions','Acquisitions.html','Deals','<path d="M5 12h13M14 7l5 5-5 5"/>'],
    ['grader','Grader.html','Grade','<path d="M5 18a7 7 0 0114 0"/><path d="M12 18l3.5-4.5"/><circle cx="12" cy="18" r="1.3"/>'],
    ['leases','Leases.html','Leases','<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 4v16"/>'],
    ['financials','Financials.html','Books','<path d="M5 4h13a1 1 0 011 1v15H6a2 2 0 01-2-2V5a1 1 0 011-1z"/><path d="M8 8h7M8 12h7M8 16h4"/>'],
    ['taxes','Taxes.html','Tax','<path d="M6 3h9l3 3v15H6z"/><path d="M9.5 15.5l5-7"/><circle cx="9.5" cy="9.5" r="1"/><circle cx="14.5" cy="14.5" r="1"/>'],
    ['insurance','Insurance.html','Cover','<path d="M12 3l7 3v5c0 4.6-3 7.7-7 9-4-1.3-7-4.4-7-9V6z"/><path d="M9 12l2 2 4-4"/>'],
    ['studio','Studio.html','Studio','<path d="M3 3v18h18M7 14l3-3 3 2 5-6"/>'],
    ['operations','Operations.html','Ops','<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18v3h3l6.7-6.7a4 4 0 005.4-5.4l-2.6 2.6-2.1-2.1z"/>'],
    ['comps','Comps.html','Comps','<path d="M12 3v17M6 7l-3 7h6zM18 7l-3 7h6zM4 20h16M2 14a3 3 0 006 0M16 14a3 3 0 006 0"/>'],
    ['news','News.html','News','<path d="M4 5h12a1 1 0 011 1v12a2 2 0 002 2H6a2 2 0 01-2-2zM8 9h6M8 13h6M8 17h4M17 9h2a1 1 0 011 1v8"/>'],
    ['inbox','Inbox.html','Inbox','<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'],
    ['insights','Insights.html','Signal','<path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"/>'],
    ['brain','Brain.html','Brain','<rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M9.5 3v2M14.5 3v2M9.5 19v2M14.5 19v2M3 9.5h2M3 14.5h2M19 9.5h2M19 14.5h2"/><circle cx="12" cy="12" r="1.5"/>']
  ];

  function buildRail() {
    var nav = document.querySelector('nav.rail');
    if (!nav) return;
    var active = nav.getAttribute('data-active') || '';
    var html = '<div class="logo mono">O</div>';
    NAV.forEach(function (n) {
      html += '<a class="' + (n[0] === active ? 'on' : '') + '" href="' + n[1] + '" title="' + n[2] + '">'
        + '<svg viewBox="0 0 24 24">' + n[3] + '</svg><span class="nl">' + n[2] + '</span></a>';
    });
    html += '<div class="sp"></div><div class="av mono">JM</div>';
    nav.innerHTML = html;
  }

  /* ---------- theme (dark / light / warm) + density ---------- */
  var THEMES = ['dark', 'light', 'warm'];
  var ICONS = {
    dark: '<svg viewBox="0 0 24 24"><path d="M21 12.8A8.5 8.5 0 1111.2 3 6.6 6.6 0 0021 12.8z"/></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>',
    warm: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 109 9c-5 0-9-4-9-9z"/></svg>'
  };
  function applyTheme(t) {
    if (THEMES.indexOf(t) < 0) t = 'dark';
    root.setAttribute('data-theme', t);
    try { localStorage.setItem('ora-theme', t); } catch (e) {}
    var b = document.getElementById('themeBtn');
    if (b) { b.innerHTML = ICONS[t]; b.title = 'Theme: ' + t + ' (click to cycle)'; }
  }
  function nextTheme() {
    var cur = root.getAttribute('data-theme') || 'dark';
    return THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  }
  function applyDensity(d) {
    if (d === 'compact') root.setAttribute('data-density', 'compact');
    else root.removeAttribute('data-density');
    try { localStorage.setItem('ora-density', d); } catch (e) {}
    var b = document.getElementById('densityBtn');
    if (b) b.classList.toggle('on', d === 'compact');
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildRail();

    var theme = 'dark', density = 'roomy';
    try { theme = localStorage.getItem('ora-theme') || 'dark'; } catch (e) {}
    try { density = localStorage.getItem('ora-density') || 'roomy'; } catch (e) {}
    applyTheme(theme);
    applyDensity(density);

    var tb = document.getElementById('themeBtn');
    if (tb) tb.addEventListener('click', function () { applyTheme(nextTheme()); });
    var db = document.getElementById('densityBtn');
    if (db) db.addEventListener('click', function () {
      applyDensity(root.getAttribute('data-density') === 'compact' ? 'roomy' : 'compact');
    });

    /* page sub-tabs */
    document.querySelectorAll('.tabs').forEach(function (tabs) {
      tabs.addEventListener('click', function (e) {
        var t = e.target.closest('.tab'); if (!t) return;
        var pane = t.getAttribute('data-pane'); if (!pane) return;
        tabs.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        var scope = tabs.getAttribute('data-scope');
        var ctx = scope ? document.querySelector(scope) : document;
        ctx.querySelectorAll('.tabpane').forEach(function (p) {
          p.classList.toggle('on', p.getAttribute('data-pane') === pane);
        });
      });
    });

    /* segmented controls — visual toggle */
    document.querySelectorAll('.seg').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var s = e.target.closest('span'); if (!s) return;
        seg.querySelectorAll('span').forEach(function (x) { x.classList.remove('on'); });
        s.classList.add('on');
      });
    });

    /* filter pills (inbox/insights) */
    document.querySelectorAll('[data-filterset]').forEach(function (set) {
      set.addEventListener('click', function (e) {
        var p = e.target.closest('[data-filter]'); if (!p) return;
        set.querySelectorAll('[data-filter]').forEach(function (x) { x.classList.remove('on'); });
        p.classList.add('on');
        var f = p.getAttribute('data-filter');
        var scope = document.querySelector(set.getAttribute('data-filterset'));
        if (!scope) return;
        scope.querySelectorAll('[data-tags]').forEach(function (row) {
          var show = f === 'all' || (row.getAttribute('data-tags') || '').split(' ').indexOf(f) > -1;
          row.style.display = show ? '' : 'none';
        });
      });
    });

    /* quick actions: Done / Snooze fade the row out */
    document.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var row = btn.closest('[data-dismissable]');
        if (!row) return;
        var act = btn.getAttribute('data-act');
        if (act === 'done' || act === 'snooze') {
          row.style.transition = 'opacity .25s, transform .25s';
          row.style.opacity = '0'; row.style.transform = 'translateX(12px)';
          setTimeout(function () { row.style.display = 'none'; }, 260);
        } else if (act === 'reply') {
          btn.textContent = 'Drafting…';
          setTimeout(function () { btn.textContent = 'Reply'; }, 1100);
        }
      });
    });

    initCommandPalette();
  });

  /* ---------- ⌘K command palette (works on every page) ---------- */
  function initCommandPalette() {
    var O = window.ORA;
    var PAGES = [
      ['Overview', 'Overview.html', 'OV'], ['Portfolio', 'Portfolio.html', 'PF'],
      ['Acquisitions', 'Acquisitions.html', 'AQ'], ['OM Grader', 'Grader.html', 'GR'],
      ['Leases', 'Leases.html', 'LS'],
      ['Financials', 'Financials.html', 'FN'], ['Taxes', 'Taxes.html', 'TX'],
      ['Insurance', 'Insurance.html', 'IC'], ['Analytics Studio', 'Studio.html', 'ST'],
      ['Operations', 'Operations.html', 'OP'], ['Comps', 'Comps.html', 'CM'],
      ['Inbox', 'Inbox.html', 'IN'], ['Insights', 'Insights.html', 'IS'], ['News', 'News.html', 'NW'],
      ['Command Brain', 'Brain.html', 'BR']
    ];
    var ov = document.createElement('div');
    ov.className = 'cmdk-ov';
    ov.innerHTML =
      '<div class="cmdk" role="dialog" aria-label="Command palette">' +
      '<div class="cmdk-in"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>' +
      '<input type="text" placeholder="Search assets, deals, investors, actions\u2026 or jump to a page" />' +
      '<span class="esc">ESC</span></div>' +
      '<div class="cmdk-res" id="cmdkRes"></div>' +
      '<div class="cmdk-foot"><span><b>\u2191\u2193</b> navigate</span><span><b>\u21b5</b> open</span><span><b>esc</b> close</span></div>' +
      '</div>';
    document.body.appendChild(ov);
    var input = ov.querySelector('input');
    var res = ov.querySelector('#cmdkRes');
    var items = [], sel = 0;

    function corpus() {
      var c = [];
      if (O) {
        O.PROPERTIES.forEach(function (p) {
          c.push({ g: 'Assets', icon: 'PR', name: p.name, sub: p.market + ' \u00b7 ' + p.type + ' \u00b7 ' + (p.sf / 1000).toFixed(0) + 'K SF',
            val: O.fmtM(p.value), href: 'Property.html?id=' + p.id, key: p.name + ' ' + p.market + ' ' + p.type });
        });
        O.DEALS.forEach(function (d) {
          c.push({ g: 'Deals', icon: 'DL', name: d.name, sub: d.stage + ' \u00b7 ' + d.region + ' \u00b7 ' + d.irr.toFixed(1) + '% IRR',
            val: O.fmtM(d.price), href: 'DealRoom.html?id=' + d.id, key: d.name + ' ' + d.region + ' ' + d.stage });
        });
        O.INVESTORS.forEach(function (i) {
          c.push({ g: 'Investors', icon: i.initials, name: i.name, sub: i.type + ' \u00b7 ' + i.irr.toFixed(1) + '% net IRR',
            val: O.fmtM(i.committed), href: 'Investor.html?id=' + i.id, key: i.name + ' ' + i.type });
        });
      }
      if (window.ORA_ENGINE) {
        ORA_ENGINE.SIGNALS.slice(0, 30).forEach(function (s) {
          c.push({ g: 'Actions', icon: '\u25c7', name: s.title, sub: '\u2192 ' + s.action,
            valCls: s.dir === 'risk' ? 'risk' : s.dir === 'gain' ? 'gain' : '',
            val: s.id === 'cap-allocate' ? '' : ORA_ENGINE.money(s.impact).replace(/^[+\u2212]/, s.dir === 'risk' ? '\u2212' : '+'),
            href: s.href, key: s.title + ' ' + s.action + ' ' + s.cat });
        });
      }
      PAGES.forEach(function (p) {
        c.push({ g: 'Pages', icon: p[2], name: p[0], sub: 'Go to ' + p[0], val: '', href: p[1], key: p[0] + ' page navigate' });
      });
      return c;
    }
    var DATA = corpus();

    function render(q) {
      q = (q || '').toLowerCase().trim();
      var matched = !q ? DATA.filter(function (d) { return d.g !== 'Pages'; }).slice(0, 8)
        : DATA.filter(function (d) { return d.key.toLowerCase().indexOf(q) > -1; }).slice(0, 24);
      items = matched; sel = 0;
      if (!matched.length) { res.innerHTML = '<div class="cmdk-empty">No matches for \u201c' + q + '\u201d</div>'; return; }
      var html = '', lastG = '';
      matched.forEach(function (d, i) {
        if (d.g !== lastG) { html += '<div class="cmdk-grp">' + d.g + '</div>'; lastG = d.g; }
        html += '<a class="cmdk-it' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '" href="' + d.href + '">' +
          '<span class="ci">' + d.icon + '</span>' +
          '<span class="ct"><span class="cn">' + d.name + '</span><span class="cs">' + d.sub + '</span></span>' +
          (d.val ? '<span class="cv ' + (d.valCls || '') + '">' + d.val + '</span>' : '') + '</a>';
      });
      res.innerHTML = html;
    }
    function moveSel(dir) {
      var els = res.querySelectorAll('.cmdk-it'); if (!els.length) return;
      els[sel] && els[sel].classList.remove('sel');
      sel = (sel + dir + els.length) % els.length;
      els[sel].classList.add('sel');
      els[sel].scrollIntoView({ block: 'nearest' });
    }
    function open() { ov.classList.add('on'); input.value = ''; render(''); setTimeout(function () { input.focus(); }, 30); }
    function close() { ov.classList.remove('on'); }

    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); var el = res.querySelectorAll('.cmdk-it')[sel]; if (el) location.href = el.getAttribute('href'); }
      else if (e.key === 'Escape') { close(); }
    });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    res.addEventListener('mousemove', function (e) {
      var it = e.target.closest('.cmdk-it'); if (!it) return;
      var i = +it.getAttribute('data-i'); if (i === sel) return;
      var els = res.querySelectorAll('.cmdk-it'); els[sel] && els[sel].classList.remove('sel'); sel = i; it.classList.add('sel');
    });

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); ov.classList.contains('on') ? close() : open(); }
    });
    document.querySelectorAll('.search').forEach(function (s) {
      s.style.cursor = 'pointer';
      s.addEventListener('click', open);
    });
  }
})();
