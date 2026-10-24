(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var app = $('#app');

  /* ---------- состояние ---------- */
  var state = {
    screen: 'login', token: null, op: '', club: '',
    hosts: [], filter: 'all', sel: null,
    taskHost: null, apps: [], sort: 'cpu',
    inv: [], invLoaded: false, query: '',
    shift: null
  };
  var meta = {
    free: { label: 'Свободен', cls: 'free', color: 'var(--ok)' },
    busy: { label: 'Занят', cls: 'busy', color: 'var(--warn)' },
    off:  { label: 'Не в сети', cls: 'off', color: 'var(--muted)' },
    boot: { label: 'Включается', cls: 'boot', color: 'var(--muted)' }
  };

  /* ---------- утилиты ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDur(m) { if (m == null) return ''; var h = Math.floor(m / 60), mm = m % 60; return h + ':' + (mm < 10 ? '0' : '') + mm; }
  function rub(v) { var s = Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'; return v < 0 ? '−' + s : (v > 0 ? '+' + s : s); }
  function hhmm(iso) { var d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''; }
  function svg(id, size, sw) {
    return '<svg width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.75) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function store(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }

  /* ---------- API ---------- */
  function api(method, path, body) {
    var opt = { method: method, headers: { 'Accept': 'application/json' } };
    if (state.token) opt.headers['Authorization'] = 'Bearer ' + state.token;
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== '/api/login') { forceLogout('Сессия закончилась, войдите заново'); }
        if (!r.ok) { var e = new Error(data.error || ('Ошибка ' + r.status)); e.offline = !!data.offline; e.status = r.status; throw e; }
        return data;
      });
    }, function () { throw new Error('Нет связи с сервером клуба'); });
  }

  /* двойное нажатие для опасных действий */
  function confirmTap(btn, label) {
    if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.classList.remove('confirm'); return true; }
    btn.dataset.armed = '1'; btn.classList.add('confirm');
    var old = btn.dataset.label || btn.innerHTML; btn.dataset.label = old;
    btn.innerHTML = label || 'Нажмите ещё раз';
    setTimeout(function () { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.classList.remove('confirm'); btn.innerHTML = old; } }, 4000);
    return false;
  }

  /* ---------- навигация ---------- */
  var tabFor = { hall: 'hall', tasks: 'hall', inventory: 'inventory', report: 'report', settings: 'settings' };
  function go(name) {
    closeSheet();
    state.screen = name;
    $$('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 's-' + name); });
    var tabs = name !== 'login';
    $('#tabbar').hidden = !tabs;
    app.classList.toggle('no-tabs', !tabs);
    $$('.tab').forEach(function (t) {
      if (t.dataset.tab === tabFor[name]) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (name === 'hall') { renderHall(); loadHosts(); loadShift(); }
    if (name === 'tasks') loadApps();
    if (name === 'inventory') { if (!state.invLoaded) loadStock(); else renderInv(); }
    if (name === 'report') renderReport();
    if (name === 'settings') { renderSettings(); loadShift(); pingServer(); }
    var scr = $('#s-' + name); if (scr) scr.scrollTop = 0;
  }
  $$('.tab').forEach(function (t) { t.addEventListener('click', function () { go(t.dataset.tab); }); });
  document.addEventListener('click', function (e) { var g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); });

  /* ---------- тема ---------- */
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $$('[data-theme-opt]').forEach(function (b) { b.setAttribute('aria-checked', b.dataset.themeOpt === t ? 'true' : 'false'); });
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    $('meta[name="theme-color"]').setAttribute('content', bg || '#0E1116');
    try { localStorage.setItem('club-admin-theme', t); } catch (e) {}
  }
  $$('[data-theme-opt]').forEach(function (b) { b.addEventListener('click', function () { setTheme(b.dataset.themeOpt); }); });
  try { var saved = localStorage.getItem('club-admin-theme'); if (saved) setTheme(saved); } catch (e) {}

  /* ---------- вход ---------- */
  function pingServer() {
    return api('GET', '/api/ping').then(function (d) {
      state.club = d.club || 'Клуб';
      if (d.version) $('#appVer').textContent = 'версия ' + d.version;
      $('#clubName').textContent = state.club;
      $('#clubAddr').textContent = 'Сервер на связи · ' + location.host;
      $('#srvAddr').textContent = location.host;
      $('#srvState').innerHTML = '<span class="dot"></span>На связи'; $('#srvState').style.color = 'var(--ok)';
      $$('#s-hall .h1').forEach(function (h) { h.textContent = state.club; });
    }, function () {
      $('#clubAddr').textContent = 'Сервер клуба не отвечает';
      $('#srvState').innerHTML = '<span class="dot"></span>Нет связи'; $('#srvState').style.color = 'var(--danger)';
    });
  }
  $('#pwToggle').addEventListener('click', function () {
    var i = $('#opPass'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    this.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  });
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var login = $('#opLogin').value.trim(), pass = $('#opPass').value;
    var btn = $('#loginForm [type=submit]');
    if (!login || !pass) { $('#loginErr').textContent = 'Введите логин и пароль оператора'; return; }
    $('#loginErr').textContent = ''; btn.disabled = true; btn.textContent = 'Входим…';
    api('POST', '/api/login', { login: login, password: pass }).then(function (d) {
      state.token = d.token; state.op = d.operator; state.club = d.club || state.club;
      store('ca-token', d.token); store('ca-op', d.operator);
      $('#opPass').value = '';
      if (d.gizmo) $('#gizmoVer').textContent = 'Gizmo ' + d.gizmo;
      go('hall');
    }, function (err) {
      $('#loginErr').textContent = err.message;
    }).then(function () { btn.disabled = false; btn.textContent = 'Войти'; });
  });
  function forceLogout(msg) {
    state.token = null; store('ca-token', null);
    if (state.screen !== 'login') { go('login'); if (msg) toast(msg); }
  }

  /* ---------- зал ---------- */
  var hostsLoading = false;
  function loadHosts(silent) {
    if (hostsLoading || !state.token) return Promise.resolve();
    hostsLoading = true;
    return api('GET', '/api/hosts').then(function (d) {
      state.hosts = d.hosts || [];
      if (state.screen === 'hall') renderHall();
      if (state.sel) renderSheet();
    }, function (err) { if (!silent) toast(err.message); })
      .then(function () { hostsLoading = false; });
  }
  function findHost(id) { for (var i = 0; i < state.hosts.length; i++) if (state.hosts[i].id === id) return state.hosts[i]; return null; }
  function subOf(h) {
    if (h.status === 'busy') return (h.user ? h.user + ' · ' : '') + fmtDur(h.sessionMinutes);
    if (h.status === 'free') return 'в сети';
    if (h.status === 'boot') return 'включается…';
    return 'не в сети';
  }
  function renderHall() {
    var c = { free: 0, busy: 0, off: 0 };
    state.hosts.forEach(function (h) { if (h.status === 'boot') c.off++; else if (c[h.status] !== undefined) c[h.status]++; });
    $('#nFree').textContent = c.free; $('#nBusy').textContent = c.busy; $('#nOff').textContent = c.off;
    var sh = state.shift;
    var shiftText = !sh ? 'Смена: …' : (sh.active ? 'Смена открыта · ' + (sh.operator || '') : 'Смена не открыта');
    $('#hallSub').textContent = shiftText + ' · ' + state.hosts.length + ' ПК';
    $('#shiftDot').style.color = sh && sh.active ? 'var(--ok)' : 'var(--warn)';
    var offWake = state.hosts.filter(function (h) { return h.status === 'off' && h.hasMac; }).length;
    $('#wolBar').style.display = offWake ? '' : 'none';
    $('#wolText').textContent = offWake + ' ПК можно включить';
    $$('.chips [data-filter]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.filter === state.filter ? 'true' : 'false'); });
    var html = '';
    state.hosts.forEach(function (h) {
      if (state.filter !== 'all' && h.status !== state.filter && !(state.filter === 'off' && h.status === 'boot')) return;
      var m = meta[h.status] || meta.off;
      html += '<button class="pc' + (h.id === state.sel ? ' sel' : '') + '" data-pc="' + h.id + '" aria-label="' + esc(h.name) + ', ' + m.label + '">' +
        '<span class="pc-id">' + esc(h.name) + '</span>' +
        '<span class="st ' + m.cls + '"><span class="dot"></span>' + m.label + '</span>' +
        '<span class="small">' + esc(subOf(h)) + '</span>' +
        (h.maintenance ? '<span class="maint">обслуживание</span>' : '') + '</button>';
    });
    if (!state.hosts.length) html = '<div class="small" style="grid-column:1/-1;padding:12px 0">' + (hostsLoading ? 'Загружаю ПК…' : 'ПК не найдены') + '</div>';
    else if (!html) html = '<div class="small" style="grid-column:1/-1;padding:12px 0">Нет ПК с таким статусом</div>';
    $('#pcGrid').innerHTML = html;
  }
  $$('.chips [data-filter]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.dataset.filter; renderHall(); }); });
  $('#pcGrid').addEventListener('click', function (e) { var b = e.target.closest('[data-pc]'); if (b) openSheet(+b.dataset.pc); });
  $('#refreshBtn').addEventListener('click', function () { loadHosts().then(function () { toast('Обновлено'); }); loadShift(); });
  $('#wakeAll').addEventListener('click', function () {
    var list = state.hosts.filter(function (h) { return h.status === 'off' && h.hasMac; });
    Promise.all(list.map(function (h) { return api('POST', '/api/hosts/' + h.id + '/wake', {}).catch(function () {}); }))
      .then(function () { toast('Сигнал включения отправлен на ' + list.length + ' ПК'); loadHosts(true); });
  });

  /* ---------- шторка ПК ---------- */
  var lastFocus = null;
  function openSheet(id) {
    state.sel = id; lastFocus = document.activeElement;
    renderSheet(); renderHall();
    app.classList.add('sheet-open');
    setTimeout(function () { $('#sheetClose').focus(); }, 50);
  }
  function closeSheet() {
    if (!app.classList.contains('sheet-open')) return;
    app.classList.remove('sheet-open'); state.sel = null;
    if (state.screen === 'hall') renderHall();
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
  }
  function renderSheet() {
    var h = findHost(state.sel); if (!h) return;
    var m = meta[h.status] || meta.off;
    $('#sheetTitle').textContent = h.name;
    $('#sheetLabel').textContent = m.label;
    $('#sheetPill').style.color = m.color;
    $('#sheetSub').textContent = (h.status === 'busy' ? 'В сессии · ' : '') + subOf(h);
    var body;
    if (h.status === 'off') {
      body = '<div style="margin-top:12px"><button class="btn btn-primary btn-block" data-act="wake" style="height:56px"' + (h.hasMac ? '' : ' disabled') + '>' + svg('i-power', 20, 2) + 'Включить</button>' +
        '<div class="small" style="text-align:center;margin-top:8px">' + (h.hasMac ? 'Сигнал Wake-on-LAN уйдёт через сервер клуба' : 'У этого ПК в Gizmo нет MAC-адреса') + '</div></div>';
    } else if (h.status === 'boot') {
      body = '<div class="small" style="margin-top:16px;font-size:14px;text-align:center;padding:12px 0">Сигнал отправлен, ждём, пока ПК подключится…</div>';
    } else {
      body = '<div class="actions">' +
        '<button class="action" data-act="reboot">' + svg('i-refresh', 20) + 'Перезагрузить</button>' +
        '<button class="action" data-act="tasks">' + svg('i-list', 20) + 'Диспетчер задач</button>' +
        '<button class="action" data-act="msg">' + svg('i-chat', 20) + 'Сообщение</button>' +
        '<button class="action danger" data-act="shutdown">' + svg('i-power', 20) + 'Выключить</button>' +
        '<button class="action tt-btn" data-act="techtime"' + (h.status === 'busy' ? '' : ' disabled') + '>' + svg('i-plus', 20) + 'Тех. время</button>' +
        (h.status === 'busy' ? '' : '<div class="small" style="grid-column:1/-1;text-align:center">Тех. время — когда на ПК вошёл игрок</div>') + '</div>' +
        '<form class="msg-row" id="msgForm" hidden><label for="msgInput" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Текст сообщения</label>' +
        '<input class="input" id="msgInput" maxlength="200" placeholder="Текст для экрана ПК" style="height:48px"><button class="btn btn-primary" type="submit" style="height:48px">Отправить</button></form>';
    }
    $('#sheetBody').innerHTML = body;
  }
  $('#sheetBody').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var h = findHost(state.sel); if (!h) return;
    var a = b.dataset.act;
    if (a === 'tasks') { state.taskHost = h.id; go('tasks'); return; }
    if (a === 'msg') { var f = $('#msgForm'); f.hidden = !f.hidden; if (!f.hidden) $('#msgInput').focus(); return; }
    if (a === 'techtime') { openTechTime(h); return; }
    // выключение — двойное нажатие (включить потом можно только через Wake-on-LAN); остальное — сразу
    if (a === 'shutdown' && !confirmTap(b, 'Нажмите ещё раз')) return;
    b.disabled = true;
    if (a === 'reboot' || a === 'shutdown') {
      // не ждём ответа: сразу закрываем шторку и показываем ПК «не в сети»
      h.status = a === 'reboot' ? 'boot' : 'off'; closeSheet(); renderHall();
      toast(a === 'reboot' ? h.name + ': перезагрузка' : h.name + ': выключение');
    }
    api('POST', '/api/hosts/' + h.id + '/' + a, {}).then(function () {
      if (a === 'wake') { toast('Сигнал включения отправлен на ' + h.name); closeSheet(); }
      setTimeout(function () { loadHosts(true); }, 4000);
    }, function (err) { toast(err.message); b.disabled = false; loadHosts(true); });
  });
  $('#sheetBody').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#msgInput').value.trim(); if (!v) { $('#msgInput').focus(); return; }
    var id = state.sel, h = findHost(id);
    closeSheet(); toast('Сообщение отправлено на ' + (h ? h.name : 'ПК'));
    api('POST', '/api/hosts/' + id + '/message', { text: v }).catch(function (err) { toast(err.message); });
  });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSheet(); if (!$('#ttModal').hidden) closeModal(); } });

  /* ---------- диспетчер задач ---------- */
  var appsLoading = false, appsTimer = null;
  function loadApps(silent) {
    var h = findHost(state.taskHost);
    $('#taskPc').textContent = h ? h.name : 'ПК';
    var m = h ? (meta[h.status] || meta.off) : meta.off;
    $('#taskSub').innerHTML = '<span class="dot" style="color:' + m.color + '"></span>' + m.label + (h ? ' · ' + esc(subOf(h)) : '');
    if (appsLoading || state.taskHost == null) return;
    appsLoading = true;
    if (!silent) { state.apps = []; $('#procList').innerHTML = '<div class="empty">Загружаю программы…</div>'; }
    var forHost = state.taskHost;
    api('GET', '/api/hosts/' + forHost + '/processes').then(function (d) {
      if (forHost !== state.taskHost || state.screen !== 'tasks') return;
      state.apps = d.apps || []; state.appsAt = new Date(); renderApps();
      // первый ответ — без ЦП; через 1.5 с придёт второй, уже с ЦП; дальше раз в 5 с
      clearTimeout(appsTimer);
      var needCpu = state.apps.some(function (a) { return a.cpu == null; });
      appsTimer = setTimeout(function () {
        if (state.screen === 'tasks' && !document.hidden) loadApps(true);
      }, needCpu ? 1500 : 5000);
    }, function (err) {
      if (silent && state.apps.length) return;
      state.apps = [];
      $('#procList').innerHTML = '<div class="empty">' + esc(err.offline ? 'ПК не в сети: клиент Gizmo не подключён' : err.message) + '</div>';
      $('#cpuVal').textContent = '—'; $('#appCount').textContent = '—';
    }).then(function () { appsLoading = false; });
  }
  function renderApps() {
    var list = state.apps.slice();
    var cpu = list.reduce(function (s, x) { return s + (x.cpu || 0); }, 0);
    var noCpu = list.length && list.every(function (x) { return x.cpu == null; });
    $('#cpuVal').textContent = noCpu ? '…' : Math.round(Math.min(100, cpu)) + '%';
    $('#cpuBar').style.width = Math.min(100, cpu) + '%';
    $('#appCount').textContent = list.length;
    $('#sampleNote').textContent = 'обновлено ' + (state.appsAt ? state.appsAt.toLocaleTimeString('ru-RU') : '—');
    $$('[data-sort]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.sort === state.sort ? 'true' : 'false'); });
    list.sort(function (a, b) {
      return state.sort === 'cpu' ? ((b.cpu || 0) - (a.cpu || 0)) : String(b.started || '').localeCompare(String(a.started || ''));
    });
    if (!list.length) { $('#procList').innerHTML = '<div class="empty">Пользовательских программ не запущено</div>'; return; }
    $('#procList').innerHTML = list.map(function (x, i) {
      var ic = x.icon ? '<img alt="" src="data:image/png;base64,' + x.icon + '">' : svg('i-monitor', 18);
      return '<div class="proc"><span class="app-ic">' + ic + '</span><div class="grow"><div class="proc-name">' + esc(x.name) + '</div>' +
        '<div class="small" style="margin-top:2px">ЦП ' + (x.cpu == null ? '…' : x.cpu + '%') + (x.count > 1 ? ' · процессов ' + x.count : '') + (x.started ? ' · с ' + hhmm(x.started) : '') + '</div></div>' +
        '<button class="btn btn-danger-outline" data-kill="' + i + '" style="font-size:13px">Завершить</button></div>';
    }).join('');
    state.appsView = list;
  }
  $('#procList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-kill]'); if (!b || b.disabled) return;
    var x = (state.appsView || [])[+b.dataset.kill]; if (!x) return;
    // сразу убираем строку, не дожидаясь ПК
    var row = b.closest('.proc'); row.style.opacity = '.35'; b.disabled = true; b.textContent = '…';
    api('POST', '/api/hosts/' + state.taskHost + '/kill', { key: x.key }).then(function (d) {
      state.apps = state.apps.filter(function (a) { return a.key !== x.key; });
      renderApps(); toast((d.name || x.name) + ' завершена');
    }, function (err) { toast(err.message); row.style.opacity = ''; b.disabled = false; b.textContent = 'Завершить'; });
  });
  $$('[data-sort]').forEach(function (b) { b.addEventListener('click', function () { state.sort = b.dataset.sort; renderApps(); }); });
  $('#procRefresh').addEventListener('click', function () { loadApps(true); toast('Обновляю…'); });

  /* ---------- тех. время ---------- */
  var TT_MIN = [5, 10, 15, 20, 30];
  var TT_REASON = ['Завис ПК', 'Не запускается игра', 'Проблемы с интернетом', 'Периферия', 'Перезагрузка ПК', 'Другое'];
  var tt = { host: null, minutes: 10, reason: TT_REASON[0] };
  function chip(label, on, attr) {
    return '<button type="button" class="chip" ' + attr + ' aria-pressed="' + (on ? 'true' : 'false') + '" style="height:40px;padding:0 14px;font-size:13px">' + esc(label) + '</button>';
  }
  function openTechTime(h) {
    tt.host = h; closeSheet();
    renderTechTime();
    $('#ttModal').hidden = false; app.classList.add('modal-open');
  }
  function closeModal() { $('#ttModal').hidden = true; app.classList.remove('modal-open'); }
  function renderTechTime() {
    var h = tt.host;
    $('#ttBody').innerHTML =
      '<h2 class="h2" id="ttTitle">Тех. время</h2>' +
      '<div class="small" style="font-size:13px;margin-top:4px">' + esc(h.name) + ' · ' + esc(h.user || 'гость') + '</div>' +
      '<div class="section-label" style="margin-top:16px">Сколько</div>' +
      '<div class="row" style="flex-wrap:wrap;gap:8px">' + TT_MIN.map(function (m) { return chip(m + ' мин', tt.minutes === m, 'data-tt-min="' + m + '"'); }).join('') + '</div>' +
      '<div class="section-label">Причина</div>' +
      '<div class="row" style="flex-wrap:wrap;gap:8px">' + TT_REASON.map(function (r) { return chip(r, tt.reason === r, 'data-tt-reason="' + esc(r) + '"'); }).join('') + '</div>' +
      '<label for="ttNote" class="small" style="display:block;margin-top:12px">Уточнение (необязательно)</label>' +
      '<input class="input" id="ttNote" maxlength="80" placeholder="например: вылетала CS2" style="height:48px;margin-top:6px">' +
      '<div class="row" style="gap:8px;margin-top:16px">' +
      '<button type="button" class="btn btn-outline" data-tt-close style="flex:1;height:52px">Отмена</button>' +
      '<button type="button" class="btn btn-primary" id="ttGo" style="flex:2;height:52px;font-size:15px;font-weight:800">Начислить ' + tt.minutes + ' мин</button></div>';
  }
  function ttReasonText() {
    var note = ($('#ttNote') && $('#ttNote').value.trim()) || '';
    var r = tt.reason === 'Другое' ? (note || 'другое') : tt.reason + (note ? ', ' + note : '');
    return r.charAt(0).toLowerCase() + r.slice(1);
  }
  function showTechTimeResult(d, reason) {
    var text = d.user + ' — тех. время ' + d.minutes + ' мин (' + reason + ')';
    $('#ttBody').innerHTML =
      '<h2 class="h2">Начислено ' + d.minutes + ' мин</h2>' +
      '<div class="small" style="font-size:13px;margin-top:4px">' + esc(d.host) + ' · ' + esc(d.user) + '. Текст можно поправить и скопировать.</div>' +
      '<label for="ttText" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Текст для копирования</label>' +
      '<textarea class="input" id="ttText" rows="3" style="height:auto;padding:12px 14px;margin-top:12px;resize:vertical;line-height:1.4">' + esc(text) + '</textarea>' +
      '<div class="row" style="gap:8px;margin-top:12px">' +
      '<button type="button" class="btn btn-outline" data-tt-close style="flex:1;height:52px">Готово</button>' +
      '<button type="button" class="btn btn-primary" id="ttCopy" style="flex:2;height:52px;font-size:15px;font-weight:800">Скопировать</button></div>';
    var ta = $('#ttText'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      var ta = $('#ttText') || document.createElement('textarea');
      ta.value = text; ta.select(); ta.setSelectionRange(0, text.length);
      try { document.execCommand('copy') ? ok() : fail(); } catch (e) { fail(e); }
    });
  }
  $('#ttModal').addEventListener('click', function (e) {
    if (e.target === $('#ttModal') || e.target.closest('[data-tt-close]')) { closeModal(); return; }
    var m = e.target.closest('[data-tt-min]'), r = e.target.closest('[data-tt-reason]');
    if (m || r) {
      var note = $('#ttNote') ? $('#ttNote').value : '';
      if (m) tt.minutes = +m.dataset.ttMin; else tt.reason = r.dataset.ttReason;
      renderTechTime(); $('#ttNote').value = note; return;
    }
    if (e.target.closest('#ttGo')) {
      var b = $('#ttGo'), reason = ttReasonText();
      b.disabled = true; b.textContent = 'Начисляю…';
      api('POST', '/api/hosts/' + tt.host.id + '/techtime', { minutes: tt.minutes, reason: reason }).then(function (d) {
        showTechTimeResult(d, reason);
      }, function (err) { toast(err.message); b.disabled = false; b.textContent = 'Начислить ' + tt.minutes + ' мин'; });
      return;
    }
    if (e.target.closest('#ttCopy')) {
      copyText($('#ttText').value).then(function () { toast('Скопировано'); closeModal(); },
        function () { toast('Выделите текст и скопируйте вручную'); });
    }
  });

  /* ---------- склад (только сверка, в Gizmo ничего не пишем) ---------- */
  function loadStock() {
    $('#invList').innerHTML = '<div class="empty">Загружаю остатки из Gizmo…</div>';
    return api('GET', '/api/stock').then(function (d) {
      var old = {}; state.inv.forEach(function (i) { old[i.id] = i.fact; });
      state.inv = (d.products || []).map(function (p) {
        return { id: p.id, n: p.name, price: +p.price || 0, barcode: p.barcode, book: p.stock == null ? 0 : +p.stock, fact: old[p.id] === undefined ? null : old[p.id] };
      });
      state.invLoaded = true; state.invAt = new Date(); renderInv();
    }, function (err) { $('#invList').innerHTML = '<div class="empty">' + esc(err.message) + '</div>'; });
  }
  function badgeFor(it) {
    if (it.fact === null) return '<span class="badge b-muted">Не сверено</span>';
    var d = it.fact - it.book;
    if (d === 0) return '<span class="badge b-ok">Совпало</span>';
    if (d < 0) return '<span class="badge b-danger">Недостача −' + Math.abs(d) + '</span>';
    return '<span class="badge b-warn">Излишек +' + d + '</span>';
  }
  function renderInv() {
    var inv = state.inv, done = inv.filter(function (i) { return i.fact !== null; }).length, left = inv.length - done;
    $('#invProgressText').textContent = 'Сверено ' + done + ' из ' + inv.length;
    $('#invLeft').textContent = left ? 'осталось ' + left : (inv.length ? 'всё сверено' : '');
    $('#invBar').style.width = (inv.length ? done / inv.length * 100 : 0) + '%';
    var q = state.query.toLowerCase();
    var rows = inv.map(function (it, i) { return { it: it, i: i }; }).filter(function (r) {
      return !q || r.it.n.toLowerCase().indexOf(q) >= 0 || (r.it.barcode && String(r.it.barcode).indexOf(q) >= 0);
    });
    $('#invList').innerHTML = rows.length ? rows.map(function (r) {
      var it = r.it;
      return '<div class="inv"><div class="grow"><div class="inv-name">' + esc(it.n) + '</div>' +
        '<div class="small" style="margin-top:2px">В Gizmo ' + it.book + (it.barcode ? ' · ' + esc(it.barcode) : '') + '</div>' + badgeFor(it) + '</div>' +
        '<div class="stepper"><button data-step="-1" data-i="' + r.i + '" aria-label="Меньше: ' + esc(it.n) + '">' + svg('i-minus', 20, 2) + '</button>' +
        '<output aria-live="polite">' + (it.fact === null ? '—' : it.fact) + '</output>' +
        '<button data-step="1" data-i="' + r.i + '" aria-label="Больше: ' + esc(it.n) + '">' + svg('i-plus', 20, 2) + '</button></div></div>';
    }).join('') : '<div class="empty">' + (inv.length ? 'Ничего не найдено' : 'Товаров нет') + '</div>';
  }
  $('#invList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-step]'); if (!b) return;
    var it = state.inv[+b.dataset.i], s = +b.dataset.step;
    it.fact = it.fact === null ? Math.max(0, s > 0 ? 1 : 0) : Math.max(0, it.fact + s);
    renderInv();
  });
  $('#scanInput').addEventListener('input', function () { state.query = this.value.trim(); renderInv(); });
  $('#scanForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#scanInput').value.trim(); if (!v) return;
    var hit = state.inv.filter(function (i) { return i.barcode && String(i.barcode) === v; })[0];
    if (hit) {
      hit.fact = (hit.fact || 0) + 1;
      toast(hit.n + ': ' + hit.fact + ' шт.');
      $('#scanInput').value = ''; state.query = '';
    } else {
      toast('Штрихкод не найден в Gizmo');
    }
    renderInv();
  });
  $('#scanBtn').addEventListener('click', function () { $('#scanInput').focus(); });
  $('#invReload').addEventListener('click', function () { loadStock().then(function () { toast('Остатки обновлены, ваш счёт сохранён'); }); });

  /* ---------- акт ---------- */
  function calc() {
    var short = 0, over = 0, rows = [], checked = 0, match = 0;
    state.inv.forEach(function (it) {
      if (it.fact === null) return; checked++;
      var d = it.fact - it.book, sum = Math.round(d * it.price * 100) / 100;
      if (d === 0) { match++; return; }
      if (d < 0) short += sum; else over += sum;
      rows.push({ it: it, d: d, sum: sum });
    });
    return { short: short, over: over, total: short + over, rows: rows, checked: checked, match: match };
  }
  function renderReport() {
    var r = calc();
    $('#reportDate').textContent = (state.club || 'Склад') + ' · ' + new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    $('#repTotal').textContent = rub(r.total);
    $('#repTotal').style.color = r.total < 0 ? 'var(--danger)' : (r.total > 0 ? 'var(--warn)' : 'var(--ok)');
    $('#repShort').textContent = rub(r.short);
    $('#repOver').textContent = rub(r.over);
    $('#repStats').textContent = 'Проверено ' + r.checked + ' из ' + state.inv.length + ' · совпало ' + r.match + ' · расхождений ' + r.rows.length;
    $('#repList').innerHTML = r.rows.length ? r.rows.map(function (x) {
      return '<div class="diff"><div class="grow"><div style="font-size:14px;font-weight:700">' + esc(x.it.n) + '</div>' +
        '<div class="small" style="margin-top:2px">В Gizmo ' + x.it.book + ' · Факт ' + x.it.fact + ' · ' + Math.abs(x.d) + ' × ' + x.it.price + ' ₽</div></div>' +
        '<div class="diff-sum" style="color:' + (x.d < 0 ? 'var(--danger)' : 'var(--warn)') + '">' + rub(x.sum) + '</div></div>';
    }).join('') : '<div class="empty">' + (r.checked ? 'Расхождений нет' : 'Сначала пересчитайте товары на вкладке «Склад»') + '</div>';
  }
  function reportText() {
    var r = calc(), lines = ['Акт расхождений · ' + (state.club || '') + ' · ' + new Date().toLocaleString('ru-RU'),
      'Сверял: ' + (state.op || ''), 'Итог: ' + rub(r.total) + ' (недостача ' + rub(r.short) + ', излишек ' + rub(r.over) + ')'];
    r.rows.forEach(function (x) { lines.push(x.it.n + ': в Gizmo ' + x.it.book + ', факт ' + x.it.fact + ' (' + rub(x.sum) + ')'); });
    return lines.join('\n');
  }
  $('#shareBtn').addEventListener('click', function () {
    var text = reportText();
    if (navigator.share) { navigator.share({ title: 'Акт расхождений', text: text }).catch(function () {}); return; }
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(function () { toast('Акт скопирован'); }, function () { toast('Не удалось скопировать'); }); return; }
    toast('Поделиться недоступно: используйте экспорт в CSV');
  });
  $('#csvBtn').addEventListener('click', function () {
    var rows = [['Товар', 'Штрихкод', 'В Gizmo', 'Факт', 'Разница', 'Цена', 'Сумма']];
    state.inv.forEach(function (it) {
      var d = it.fact === null ? '' : it.fact - it.book;
      rows.push([it.n, it.barcode || '', it.book, it.fact === null ? '' : it.fact, d, it.price, d === '' ? '' : Math.round(d * it.price * 100) / 100]);
    });
    var csv = '﻿' + rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'akt-' + new Date().toISOString().slice(0, 10) + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    toast('CSV сохранён');
  });

  /* ---------- смена и настройки ---------- */
  function loadShift() {
    if (!state.token) return;
    api('GET', '/api/shift').then(function (d) {
      state.shift = d;
      if (state.screen === 'hall') renderHall();
      if (state.screen === 'settings') renderSettings();
    }, function () {});
  }
  function renderSettings() {
    $('#opName').textContent = state.op || 'Оператор';
    $('#opAvatar').textContent = (state.op || 'ОП').slice(0, 2).toUpperCase();
    var sh = state.shift;
    $('#shiftState').textContent = !sh ? '…' : (sh.active ? 'Открыта' : 'Не открыта');
    $('#shiftPill').style.color = sh && sh.active ? 'var(--ok)' : 'var(--warn)';
    if (sh && sh.active) {
      var start = new Date(sh.start), mins = Math.max(0, Math.floor((Date.now() - start) / 60000));
      $('#shiftInfo').textContent = (sh.register || 'Касса') + ' · ' + (sh.operator || '') + ' · с ' + hhmm(sh.start) +
        ' (' + Math.floor(mins / 60) + ' ч ' + (mins % 60) + ' мин)' + (sh.expected != null ? ' · в кассе ' + rub(sh.expected).replace('+', '') : '');
    } else {
      $('#shiftInfo').textContent = sh ? 'Откройте смену на операторском ПК' : 'Загружаю…';
    }
  }
  $('#shiftRefresh').addEventListener('click', function () { loadShift(); toast('Обновляю статус смены'); });
  $('#logoutBtn').addEventListener('click', function () {
    api('POST', '/api/logout', {}).catch(function () {}).then(function () {
      state.token = null; store('ca-token', null); state.inv = []; state.invLoaded = false;
      go('login'); toast('Вы вышли');
    });
  });
  $$('.switch-row').forEach(function (b) {
    b.addEventListener('click', function () { b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
  });

  /* ---------- внутри нативного приложения (айфон/андроид) ---------- */
  var nativeShell = navigator.userAgent.indexOf('ClubAdminApp') >= 0;
  if (nativeShell) {
    $('#changeServerRow').hidden = false;
    $('#changeServer').addEventListener('click', function () {
      var ios = /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent);
      location.href = (ios ? 'capacitor://localhost/' : 'https://localhost/') + '?change=1';
    });
  }

  /* ---------- автообновление ---------- */
  setInterval(function () {
    if (document.hidden || !state.token) return;
    if (state.screen === 'hall') loadHosts(true);
  }, 10000);
  setInterval(function () {
    if (document.hidden || !state.token) return;
    loadShift();
  }, 60000);

  /* ---------- установка как приложение (PWA) ---------- */
  var installEvt = null;
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function renderInstall() {
    var ua = navigator.userAgent, ios = /iphone|ipad|ipod/i.test(ua) || (ua.indexOf('Mac') >= 0 && 'ontouchend' in document);
    var hint, title = 'Установить на главный экран';
    if (standalone) { title = 'Установлено'; hint = 'Приложение открыто с главного экрана'; }
    else if (!window.isSecureContext) { hint = 'Нужен адрес https:// — откройте приложение по ссылке Tailscale (см. инструкцию)'; }
    else if (installEvt) { hint = 'Появится иконка, приложение будет открываться без браузера'; }
    else if (ios) { hint = 'В Safari нажмите «Поделиться» → «На экран „Домой“»'; }
    else { hint = 'В меню браузера выберите «Установить приложение» или «Добавить на главный экран»'; }
    $('#installTitle').textContent = title;
    $('#installHint').textContent = hint;
    $('#installBtn').hidden = !installEvt || standalone;
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; renderInstall(); });
  window.addEventListener('appinstalled', function () { installEvt = null; standalone = true; renderInstall(); toast('Приложение установлено'); });
  $('#installBtn').addEventListener('click', function () {
    if (!installEvt) return;
    installEvt.prompt();
    installEvt.userChoice.then(function () { installEvt = null; renderInstall(); });
  });
  renderInstall();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  /* ---------- старт ---------- */
  pingServer();
  var t = load('ca-token');
  if (t) {
    state.token = t; state.op = load('ca-op') || '';
    api('GET', '/api/me').then(function (d) { state.op = d.operator; state.club = d.club; go('hall'); }, function () { state.token = null; store('ca-token', null); });
  }
})();
