// ==UserScript==
// @name         SJTU 场地余量助手
// @namespace    local.sjtu.sports.monitor
// @version      1.0.1
// @description  在已登录的交大体育预约页选择场馆、日期和时段，监控可用场地。
// @match        https://sports.sjtu.edu.cn/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (document.getElementById('sjtu-venue-monitor-host')) return;

  const DATE_URL = '/manage/fieldDetail/queryFieldReserveSituationIsFull';
  const SITUATION_URL = '/manage/fieldDetail/queryFieldSituation';
  const STORAGE_KEY = 'sjtu-venue-monitor-settings-v1';
  const REQUEST_TIMEOUT_MS = 15000;
  const CHECK_GAP_MS = 1000;
  const VENUES = [
    { name: 'Huxiaoming tennis court', type: '网球', venueId: '0c6edc93-87ac-41b0-9895-6b66fda93fe5', fieldType: '19f69e5c-872f-4fbb-b9fe-70d6337c2d93' },
    { name: 'Eastern district tennis court', type: '网球', venueId: '3466293b-a7d8-45be-a918-8526e3bed4c5', fieldType: '4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76' },
    { name: 'Student Center Gym', type: '健身', venueId: 'd784ad7c-cb24-4282-afd6-a67aec68c675', fieldType: '7d46c0a4-3ae6-4398-822b-d4b7b37085fa' },
    { name: 'Zijin Street Gym', type: '健身', venueId: '768214ba-3b1c-4f29-ad00-15c0e376b000', fieldType: '0a349309-1734-4507-98bd-4c30bf33c6bc' },
    { name: 'Huoyingdong Gym', type: '健身', venueId: '9096787a-bc53-430a-9405-57dc46bc9e83', fieldType: 'b3dce013-3a0e-45e0-a0c2-425a364ac90f' },
    { name: 'Huoyingdong Badminton Court', type: '羽毛球', venueId: '9096787a-bc53-430a-9405-57dc46bc9e83', fieldType: '49629b20-71fb-4bae-8675-fdae0831e861' },
    { name: 'Air Center Badminton Court', type: '羽毛球', venueId: '3b10ff47-7e83-4c21-816c-5edc257168c1', fieldType: '29942202-d2ac-448e-90b7-14d3c6be19ff' },
  ].map((venue) => ({ ...venue, key: `${venue.venueId}|${venue.fieldType}` }));

  class AuthenticationError extends Error {}

  function shanghaiDate() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function checkTime() {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
  }

  function readSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (_) { /* storage is optional */ }
    const knownKeys = new Set(VENUES.map((venue) => venue.key));
    const selectedVenues = Array.isArray(saved.venues)
      ? saved.venues.filter((key) => knownKeys.has(key))
      : VENUES.map((venue) => venue.key);
    return {
      venues: new Set(selectedVenues),
      dates: new Set(Array.isArray(saved.dates) ? saved.dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) : []),
      datesChosen: saved.datesChosen === true,
      startHour: Number.isInteger(saved.startHour) ? saved.startHour : 7,
      endHour: Number.isInteger(saved.endHour) ? saved.endHour : 22,
      interval: Number.isInteger(saved.interval) ? Math.min(600, Math.max(60, saved.interval)) : 60,
      notify: saved.notify === true,
    };
  }

  const settings = readSettings();
  const state = {
    open: false, running: false, loadingDates: false, datePromise: null,
    dateMaps: new Map(), allDates: [], cacheDay: '', loadedSignature: '',
    dateErrors: [], results: new Map(), knownAvailable: new Map(),
    activeControllers: new Set(), wait: null, runId: 0, cycle: 0, checks: 0,
    current: '', message: '打开面板后读取可选日期。', alert: '',
  };

  const host = document.createElement('div');
  host.id = 'sjtu-venue-monitor-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      button, select, input { font: inherit; }
      #launcher { position: fixed; right: 22px; bottom: 22px; z-index: 2147483646; pointer-events: auto; width: 58px; height: 58px; border: 0; border-radius: 18px; color: #fff; background: #123f5d; box-shadow: 0 10px 28px #08233755; cursor: pointer; font-size: 28px; }
      #launcher:hover, #launcher:focus-visible { background: #0d6382; outline: 3px solid #95dbea; outline-offset: 2px; }
      #badge { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 999px; background: #dc5b30; color: #fff; font: 700 11px/20px system-ui; text-align: center; }
      #badge[hidden], #panel[hidden], #alert[hidden], #errors[hidden] { display: none !important; }
      #panel { position: fixed; z-index: 2147483647; right: 22px; bottom: 90px; pointer-events: auto; width: min(430px, calc(100vw - 24px)); max-height: min(780px, calc(100vh - 112px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #b6d2db; border-radius: 18px; background: #f8fbfa; color: #183743; box-shadow: 0 22px 70px #092b3c55; font: 14px/1.45 system-ui, -apple-system, 'Microsoft YaHei', sans-serif; }
      #top { display: flex; align-items: center; justify-content: space-between; padding: 15px 17px; background: #123f5d; color: #fff; }
      #top h2 { margin: 0; font-size: 17px; font-weight: 700; }
      #top small { display: block; opacity: .8; font-size: 11px; }
      #close { border: 0; border-radius: 8px; padding: 3px 8px; background: transparent; color: inherit; cursor: pointer; font-size: 22px; }
      #close:hover, #close:focus-visible { background: #ffffff22; }
      #body { overflow-y: auto; padding: 15px 17px 18px; }
      .section { margin: 0 0 17px; }
      .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
      .section-head h3 { margin: 0; font-size: 14px; color: #173f51; }
      .small-actions { display: flex; gap: 5px; }
      .link-button { border: 0; background: transparent; color: #0d6b83; padding: 2px 4px; cursor: pointer; font-size: 12px; }
      .link-button:hover { text-decoration: underline; }
      .link-button:disabled { opacity: .45; cursor: default; }
      .venue-list { display: grid; grid-template-columns: 1fr; gap: 6px; }
      .choice { display: flex; gap: 8px; align-items: center; min-height: 32px; border: 1px solid #d8e5e7; border-radius: 9px; background: #fff; padding: 6px 9px; cursor: pointer; }
      .choice:hover { border-color: #7abac6; }
      .choice input { accent-color: #087e92; margin: 0; }
      .choice .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .tag { color: #497080; background: #e7f2f3; border-radius: 5px; padding: 2px 5px; font-size: 11px; white-space: nowrap; }
      .date-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
      .date-list .choice { font-size: 12px; }
      .hint { margin: 5px 0 0; color: #5d7882; font-size: 12px; }
      .options { display: flex; flex-wrap: wrap; align-items: end; gap: 9px; }
      .options label { display: grid; gap: 3px; font-size: 12px; }
      .options select, .options input[type=number] { min-height: 34px; border: 1px solid #b6cfd4; border-radius: 8px; background: #fff; color: #183743; padding: 5px 8px; }
      .options input[type=number] { width: 80px; }
      .notify-choice { display: flex; align-items: center; gap: 7px; margin-top: 10px; font-size: 12px; }
      .notify-choice input { accent-color: #087e92; }
      #actions { display: flex; gap: 8px; margin-bottom: 12px; }
      #start { flex: 1; border: 0; border-radius: 9px; background: #0d7287; color: #fff; padding: 10px 12px; font-weight: 700; cursor: pointer; }
      #start:hover { background: #08566a; }
      #start:disabled { opacity: .55; cursor: default; }
      #refresh { border: 1px solid #adc9d0; border-radius: 9px; background: #fff; color: #23596b; padding: 9px 11px; cursor: pointer; }
      #refresh:disabled { opacity: .55; cursor: default; }
      #status { border-radius: 9px; padding: 9px 10px; background: #e9f3f4; color: #245466; font-size: 12px; }
      #summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
      #summary span { border-radius: 6px; background: #edf1f1; padding: 3px 6px; font-size: 11px; }
      #alert { margin: 8px 0; border-radius: 9px; background: #fff2cf; color: #7b4e0a; padding: 9px 10px; font-weight: 700; }
      .result-list { display: grid; gap: 6px; }
      .slot { border-left: 4px solid #0b967e; border-radius: 7px; padding: 7px 9px; background: #e9f8f2; }
      .slot strong { display: block; font-size: 12px; }
      .slot span { display: block; margin-top: 3px; color: #3c665e; font-size: 11px; }
      .task { border-radius: 7px; padding: 5px 7px; background: #eef3f4; font-size: 11px; overflow-wrap: anywhere; }
      .task.error { background: #fff0ea; color: #9b432b; }
      .task.available { background: #e9f8f2; color: #21654d; }
      #errors { margin-top: 7px; border-radius: 8px; background: #fff0ea; color: #9b432b; padding: 8px; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
      @media (max-width: 520px) { #launcher { right: 12px; bottom: 12px; } #panel { right: 12px; bottom: 80px; max-height: calc(100vh - 92px); } }
    </style>
    <button id="launcher" type="button" aria-label="打开场地余量助手" aria-controls="panel" aria-expanded="false" title="场地余量助手">🏟️<span id="badge" hidden></span></button>
    <section id="panel" role="dialog" aria-label="场地余量助手" hidden>
      <div id="top"><div><h2>场地余量助手</h2><small>在预约页面内监控 · 自动使用当前登录态</small></div><button id="close" type="button" aria-label="关闭面板">×</button></div>
      <div id="body">
        <div class="section"><div class="section-head"><h3>选择场馆</h3><div class="small-actions"><button id="all-venues" class="link-button" type="button">全选</button><button id="no-venues" class="link-button" type="button">清空</button></div></div><div id="venues" class="venue-list"></div></div>
        <div class="section"><div class="section-head"><h3>选择日期</h3><div class="small-actions"><button id="all-dates" class="link-button" type="button">全选</button><button id="no-dates" class="link-button" type="button">清空</button></div></div><div id="dates" class="date-list"></div><p id="date-hint" class="hint"></p></div>
        <div class="section"><div class="section-head"><h3>时段与频率</h3></div><div class="options"><label>开始<select id="start-hour"></select></label><label>结束<select id="end-hour"></select></label><label>每轮间隔（秒）<input id="interval" type="number" min="60" max="600" step="10"></label></div><label class="notify-choice"><input id="notify" type="checkbox">发现新余量时显示桌面通知</label><p class="hint">间隔从一整轮结束后开始计算；相邻请求至少间隔 1 秒。</p></div>
        <div id="actions"><button id="start" type="button">开始监控</button><button id="refresh" type="button">刷新日期</button></div>
        <div id="status" role="status"></div><div id="summary"></div><div id="alert" role="alert" hidden></div>
        <div class="section"><div class="section-head"><h3>可用时段</h3></div><div id="slots" class="result-list"></div></div>
        <div class="section"><div class="section-head"><h3>检查状态</h3></div><div id="tasks" class="result-list"></div><div id="errors" hidden></div></div>
      </div>
    </section>`;
  function mountHost() {
    const parent = document.body || document.documentElement;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }
  mountHost();
  // The booking SPA can replace its body or remove injected nodes during navigation.
  // Keep the existing panel and monitoring state, then reattach the same host.
  const mountObserver = new MutationObserver(() => {
    if (!host.isConnected || host.parentNode !== (document.body || document.documentElement)) mountHost();
  });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });

  const $ = (selector) => root.querySelector(selector);
  const elements = {
    launcher: $('#launcher'), badge: $('#badge'), panel: $('#panel'), close: $('#close'),
    venues: $('#venues'), dates: $('#dates'), dateHint: $('#date-hint'),
    allVenues: $('#all-venues'), noVenues: $('#no-venues'), allDates: $('#all-dates'), noDates: $('#no-dates'),
    startHour: $('#start-hour'), endHour: $('#end-hour'), interval: $('#interval'), notify: $('#notify'),
    start: $('#start'), refresh: $('#refresh'), status: $('#status'), summary: $('#summary'),
    alert: $('#alert'), slots: $('#slots'), tasks: $('#tasks'), errors: $('#errors'),
  };

  for (let hour = 7; hour <= 21; hour += 1) elements.startHour.add(new Option(`${hour}:00`, String(hour)));
  for (let hour = 8; hour <= 22; hour += 1) elements.endHour.add(new Option(`${hour}:00`, String(hour)));

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        venues: [...settings.venues], dates: [...settings.dates], datesChosen: settings.datesChosen,
        startHour: settings.startHour, endHour: settings.endHour,
        interval: settings.interval, notify: settings.notify,
      }));
    } catch (_) { /* monitoring still works if storage is disabled */ }
  }

  function venueSignature() { return [...settings.venues].sort().join(','); }

  function textNode(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  }

  function renderChoices() {
    const venues = VENUES.map((venue) => {
      const label = textNode('label', 'choice', '');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings.venues.has(venue.key);
      input.disabled = state.running || state.loadingDates;
      input.addEventListener('change', () => {
        if (input.checked) settings.venues.add(venue.key); else settings.venues.delete(venue.key);
        state.loadedSignature = '';
        state.message = '场馆已改变；点击“刷新日期”，或开始监控时自动刷新。';
        saveSettings(); render();
      });
      label.append(input, textNode('span', 'name', venue.name), textNode('span', 'tag', venue.type));
      return label;
    });
    elements.venues.replaceChildren(...venues);

    const dates = state.allDates.map((date) => {
      const label = textNode('label', 'choice', '');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings.dates.has(date);
      input.disabled = state.running || state.loadingDates;
      input.addEventListener('change', () => {
        if (input.checked) settings.dates.add(date); else settings.dates.delete(date);
        settings.datesChosen = true;
        saveSettings(); render();
      });
      label.append(input, textNode('span', '', date));
      return label;
    });
    elements.dates.replaceChildren(...dates);
    elements.dateHint.textContent = state.loadingDates ? '正在读取可选日期…'
      : state.allDates.length ? `共 ${state.allDates.length} 个日期；只查询勾选的日期。`
        : '暂无日期。请先选择场馆，再点击“刷新日期”。';
  }

  function renderResults() {
    const results = [...state.results.values()];
    const counts = { pending: 0, available: 0, unavailable: 0, error: 0 };
    for (const result of results) counts[result.status] += 1;
    elements.summary.replaceChildren(
      textNode('span', '', `待检查 ${counts.pending}`),
      textNode('span', '', `有余量 ${counts.available}`),
      textNode('span', '', `无余量 ${counts.unavailable}`),
      textNode('span', '', `失败 ${counts.error}`),
      textNode('span', '', `第 ${state.cycle} 轮 · 共 ${state.checks} 次请求`),
    );
    const slots = results.flatMap((result) => result.slots || [])
      .sort((a, b) => `${a.date}${a.time}${a.venueName}`.localeCompare(`${b.date}${b.time}${b.venueName}`));
    elements.badge.hidden = !slots.length;
    elements.badge.textContent = slots.length > 99 ? '99+' : String(slots.length);
    if (slots.length) {
      const rows = slots.slice(0, 40).map((slot) => {
        const row = textNode('div', 'slot', '');
        row.append(
          textNode('strong', '', `${slot.venueName} · ${slot.fieldName}`),
          textNode('span', '', `${slot.date}  ${slot.time}  · 余量 ${slot.count} · 查询 ${slot.checkedAt}`),
        );
        return row;
      });
      if (slots.length > 40) rows.push(textNode('p', 'hint', `还有 ${slots.length - 40} 个可用时段未展示。`));
      elements.slots.replaceChildren(...rows);
    } else {
      const message = counts.pending ? `还有 ${counts.pending} 项待检查，暂不能判定全部无余量。`
        : (counts.error || state.dateErrors.length) ? '没有已确认的余量；部分查询失败，结果未知。'
          : results.length ? '本轮所选范围内无余量。' : '选择场馆和日期后，点击“开始监控”。';
      elements.slots.replaceChildren(textNode('p', 'hint', message));
    }
    const priority = { error: 0, available: 1, pending: 2, unavailable: 3 };
    const taskRows = results.sort((a, b) => priority[a.status] - priority[b.status]).slice(0, 12).map((result) =>
      textNode('div', `task ${result.status}`, `${{ pending: '待检查', available: '有余量', unavailable: '无余量', error: '失败' }[result.status]} · ${result.venueName} · ${result.date}${result.checkedAt ? ` · ${result.checkedAt}` : ''}${result.error ? ` · ${result.error}` : ''}`));
    if (results.length > 12) taskRows.push(textNode('p', 'hint', `还有 ${results.length - 12} 项；上方显示优先状态。`));
    elements.tasks.replaceChildren(...(taskRows.length ? taskRows : [textNode('p', 'hint', '尚未开始查询。')]));
    elements.errors.hidden = !state.dateErrors.length;
    elements.errors.textContent = state.dateErrors.slice(0, 4).join('\n');
  }

  function render() {
    elements.panel.hidden = !state.open;
    elements.launcher.setAttribute('aria-expanded', String(state.open));
    elements.launcher.title = state.running ? '场地监控运行中' : '打开场地余量助手';
    elements.status.textContent = `${state.message}${state.current ? ` 当前：${state.current}` : ''}`;
    elements.alert.hidden = !state.alert;
    elements.alert.textContent = state.alert;
    elements.start.textContent = state.running ? '停止监控' : '开始监控';
    elements.start.disabled = state.loadingDates && !state.running;
    elements.refresh.disabled = state.running || state.loadingDates || !settings.venues.size;
    for (const button of [elements.allVenues, elements.noVenues, elements.allDates, elements.noDates]) {
      button.disabled = state.running || state.loadingDates || ((button === elements.allDates || button === elements.noDates) && !state.allDates.length);
    }
    elements.startHour.value = String(settings.startHour);
    elements.endHour.value = String(settings.endHour);
    elements.interval.value = String(settings.interval);
    elements.notify.checked = settings.notify;
    for (const control of [elements.startHour, elements.endHour, elements.interval, elements.notify]) control.disabled = state.running;
    renderChoices();
    renderResults();
  }

  async function requestJson(path, payload) {
    const controller = new AbortController();
    state.activeControllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      if (response.status === 401) throw new AuthenticationError('HTTP 401：请重新登录预约页面。');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(response.headers.get('Content-Type') || '').toLowerCase().includes('json')) {
        throw new AuthenticationError('接口返回的不是 JSON，可能已跳转到登录页面。');
      }
      const data = await response.json();
      if (String(data?.code) === '401') throw new AuthenticationError(`接口 401：${data.msg || '登录已过期'}`);
      if (Number(data?.code) !== 0) throw new Error(`接口 ${data?.code ?? '?'}：${data?.msg || '请求失败'}`);
      if (!Array.isArray(data.data)) throw new Error('接口数据格式与预期不符。');
      return data.data;
    } catch (error) {
      if (timedOut) throw new Error('请求超时（15 秒）。');
      throw error;
    } finally {
      clearTimeout(timeout);
      state.activeControllers.delete(controller);
    }
  }

  async function refreshDates() {
    if (state.datePromise) return state.datePromise;
    state.datePromise = (async () => {
      const startedDuringMonitoring = state.running;
      state.loadingDates = true;
      state.dateErrors = [];
      state.message = '正在读取可选日期…';
      render();
      try {
        const selected = VENUES.filter((venue) => settings.venues.has(venue.key));
        if (!selected.length) throw new Error('请先选择至少一个场馆。');
        const maps = new Map();
        const dates = new Set();
        const errors = [];
        const today = shanghaiDate();
        for (const venue of selected) {
          if (startedDuringMonitoring && !state.running) return false;
          try {
            const items = await requestJson(DATE_URL, {
              id: venue.venueId, feildType: venue.fieldType, date: today,
            });
            const map = new Map();
            for (const item of items) {
              if (typeof item?.date === 'string' && item.dateId) {
                map.set(item.date, String(item.dateId));
                dates.add(item.date);
              }
            }
            if (!map.size) errors.push(`${venue.name}：没有可预约日期。`);
            maps.set(venue.key, map);
          } catch (error) {
            if (startedDuringMonitoring && !state.running) return false;
            if (error instanceof AuthenticationError) throw error;
            errors.push(`${venue.name}：${error.message}`);
          }
          if (selected.length > 1) await pause(250);
        }
        if (startedDuringMonitoring && !state.running) return false;
        state.dateMaps = maps;
        state.allDates = [...dates].sort();
        state.dateErrors = errors;
        state.cacheDay = today;
        state.loadedSignature = venueSignature();
        const previousDates = [...settings.dates];
        settings.dates = new Set(previousDates.filter((date) => dates.has(date)));
        if (!settings.dates.size && state.allDates.length && (!settings.datesChosen || previousDates.length)) {
          settings.dates.add(state.allDates[0]);
        }
        saveSettings();
        state.message = state.allDates.length
          ? `已读取 ${state.allDates.length} 个日期${errors.length ? `；${errors.length} 个场馆读取失败` : ''}。`
          : '没有读取到可选日期，请检查登录状态或稍后刷新。';
        return state.allDates.length > 0;
      } catch (error) {
        state.dateErrors = [error.message];
        state.message = error instanceof AuthenticationError
          ? '登录失效。请在预约页面重新登录，再点“刷新日期”。'
          : `日期读取失败：${error.message}`;
        if (state.running) stopMonitoring(state.message);
        return false;
      } finally {
        state.loadingDates = false;
        render();
      }
    })();
    try { return await state.datePromise; } finally { state.datePromise = null; }
  }

  function parseAvailableSlots(fields, venue, date) {
    const available = [];
    for (const field of fields) {
      if (!Array.isArray(field?.priceList)) throw new Error('场地时段数据格式与预期不符。');
      for (const [index, item] of field.priceList.entries()) {
        const count = Number(item?.count);
        if (!Number.isFinite(count)) throw new Error('场地余量数据格式与预期不符。');
        const hour = 7 + index;
        if (count <= 0 || hour < settings.startHour || hour >= settings.endHour) continue;
        const time = hour < 22 ? `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00` : `时段 ${index + 1}`;
        const fieldName = String(field.fieldNameEn || field.fieldName || '未命名场地');
        const fieldId = String(field.fieldId || fieldName);
        available.push({
          id: `${venue.key}|${date}|${fieldId}|${index}`, venueName: venue.name,
          fieldName, date, time, count, checkedAt: checkTime(),
        });
      }
    }
    return available;
  }

  function notifyNew(slots) {
    state.alert = `发现 ${slots.length} 个新可用时段：${slots[0].venueName} · ${slots[0].date} ${slots[0].time}`;
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('SJTU 场地有新余量', {
          body: `${slots[0].venueName} · ${slots[0].fieldName} · ${slots[0].date} ${slots[0].time}${slots.length > 1 ? ` 等 ${slots.length} 个时段` : ''}`,
          tag: 'sjtu-venue-monitor',
        });
      } catch (_) { /* visual alert remains available */ }
    }
  }

  function pause(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { state.wait = null; resolve(); }, milliseconds);
      state.wait = { timer, resolve };
    });
  }

  function stopMonitoring(message = '监控已停止。') {
    state.running = false;
    state.runId += 1;
    for (const controller of state.activeControllers) controller.abort();
    if (state.wait) {
      clearTimeout(state.wait.timer);
      state.wait.resolve();
      state.wait = null;
    }
    state.current = '';
    state.message = message;
    render();
  }

  async function runMonitoring(runId) {
    while (state.running && runId === state.runId) {
      if (state.cacheDay !== shanghaiDate() || state.loadedSignature !== venueSignature()) {
        if (!await refreshDates()) {
          if (!state.running || runId !== state.runId) return;
          stopMonitoring('无法取得日期，监控已停止。');
          return;
        }
        if (!state.running || runId !== state.runId) return;
      }
      const tasks = [];
      for (const venue of VENUES.filter((item) => settings.venues.has(item.key))) {
        const dates = state.dateMaps.get(venue.key) || new Map();
        for (const date of [...settings.dates].sort()) {
          const dateId = dates.get(date);
          if (dateId) tasks.push({ key: `${venue.key}|${date}`, venue, date, dateId });
        }
      }
      if (!tasks.length) {
        stopMonitoring('所选场馆与日期没有可查询的组合。请刷新日期并重新选择。');
        return;
      }
      state.cycle += 1;
      state.alert = '';
      state.results = new Map(tasks.map((task) => [task.key, {
        status: 'pending', venueName: task.venue.name, date: task.date, slots: [], checkedAt: '', error: '',
      }]));
      state.message = `第 ${state.cycle} 轮：正在检查 ${tasks.length} 个场馆／日期组合。`;
      render();
      for (const [index, task] of tasks.entries()) {
        if (!state.running || runId !== state.runId) return;
        state.current = `${index + 1}/${tasks.length} ${task.venue.name} · ${task.date}`;
        state.checks += 1;
        render();
        try {
          const fields = await requestJson(SITUATION_URL, {
            fieldType: task.venue.fieldType, date: task.date,
            venueId: task.venue.venueId, dateId: task.dateId,
          });
          if (!state.running || runId !== state.runId) return;
          const slots = parseAvailableSlots(fields, task.venue, task.date);
          const previous = state.knownAvailable.get(task.key) || new Map();
          const newSlots = slots.filter((slot) => !previous.has(slot.id));
          state.knownAvailable.set(task.key, new Map(slots.map((slot) => [slot.id, slot.count])));
          state.results.set(task.key, {
            status: slots.length ? 'available' : 'unavailable', venueName: task.venue.name,
            date: task.date, slots, checkedAt: checkTime(), error: '',
          });
          if (newSlots.length) notifyNew(newSlots);
        } catch (error) {
          if (!state.running || runId !== state.runId) return;
          state.results.set(task.key, {
            status: 'error', venueName: task.venue.name, date: task.date,
            slots: [], checkedAt: checkTime(), error: error.message,
          });
          if (error instanceof AuthenticationError) {
            stopMonitoring('登录失效。请在预约页面重新登录，再启动监控。');
            return;
          }
        }
        render();
        if (index < tasks.length - 1) await pause(CHECK_GAP_MS);
      }
      if (!state.running || runId !== state.runId) return;
      state.current = '';
      state.message = `第 ${state.cycle} 轮完成；${settings.interval} 秒后开始下一轮。`;
      render();
      await pause(settings.interval * 1000);
    }
  }

  async function startMonitoring() {
    if (state.running) { stopMonitoring(); return; }
    if (!settings.venues.size) { state.message = '请至少选择一个场馆。'; render(); return; }
    if (settings.startHour >= settings.endHour) { state.message = '结束时间必须晚于开始时间。'; render(); return; }
    if (!state.allDates.length || state.cacheDay !== shanghaiDate() || state.loadedSignature !== venueSignature()) {
      if (!await refreshDates()) return;
    }
    if (!settings.dates.size) { state.message = '请至少选择一个日期。'; render(); return; }
    state.running = true;
    state.knownAvailable.clear();
    state.results.clear();
    state.cycle = 0;
    state.checks = 0;
    state.alert = '';
    state.runId += 1;
    const runId = state.runId;
    render();
    runMonitoring(runId).catch((error) => stopMonitoring(`监控已停止：${error.message}`));
  }

  elements.launcher.addEventListener('click', () => {
    state.open = !state.open;
    render();
    if (state.open && !state.allDates.length && !state.loadingDates) void refreshDates();
  });
  elements.close.addEventListener('click', () => { state.open = false; render(); elements.launcher.focus(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) { state.open = false; render(); elements.launcher.focus(); }
  });
  elements.allVenues.addEventListener('click', () => { settings.venues = new Set(VENUES.map((venue) => venue.key)); state.loadedSignature = ''; saveSettings(); render(); });
  elements.noVenues.addEventListener('click', () => { settings.venues.clear(); state.loadedSignature = ''; saveSettings(); render(); });
  elements.allDates.addEventListener('click', () => { settings.dates = new Set(state.allDates); settings.datesChosen = true; saveSettings(); render(); });
  elements.noDates.addEventListener('click', () => { settings.dates.clear(); settings.datesChosen = true; saveSettings(); render(); });
  elements.startHour.addEventListener('change', () => { settings.startHour = Number(elements.startHour.value); saveSettings(); render(); });
  elements.endHour.addEventListener('change', () => { settings.endHour = Number(elements.endHour.value); saveSettings(); render(); });
  elements.interval.addEventListener('change', () => {
    settings.interval = Math.min(600, Math.max(60, Math.round(Number(elements.interval.value) || 60)));
    saveSettings(); render();
  });
  elements.notify.addEventListener('change', async () => {
    if (elements.notify.checked && 'Notification' in window) {
      try { settings.notify = (await Notification.requestPermission()) === 'granted'; }
      catch (_) { settings.notify = false; }
      if (!settings.notify) state.message = '浏览器未允许桌面通知；面板仍会显示新余量。';
    } else {
      settings.notify = false;
      if (elements.notify.checked) state.message = '当前浏览器不支持桌面通知。';
    }
    saveSettings(); render();
  });
  elements.refresh.addEventListener('click', () => { void refreshDates(); });
  elements.start.addEventListener('click', () => { void startMonitoring(); });
  render();
})();
