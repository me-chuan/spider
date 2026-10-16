// ==UserScript==
// @name         SJTU 场地查询与手动下单
// @namespace    local.sjtu.sports.manual-booking
// @version      0.4.1
// @description  按日期范围查询或持续监控羽毛球、网球与健身房余量，并手动创建未付款订单。
// @match        https://sports.sjtu.edu.cn/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (document.getElementById('sjtu-manual-booking-host')) return;

  const DATE_URL = '/manage/fieldDetail/queryFieldReserveSituationIsFull';
  const SITUATION_URL = '/manage/fieldDetail/queryFieldSituation';
  const VENUE_URL = '/manage/venue/queryVenueById';
  const ORDER_URL = '/venue/personal/ConfirmOrder';
  const STORAGE_KEY = 'sjtu-manual-booking-settings-v1';
  const ATTEMPT_KEY = 'sjtu-manual-booking-attempt-v1';
  const MANUAL_ATTEMPT_PREFIX = 'sjtu-manual-booking-manual-attempt-';
  const ORDER_LOCK_NAME = 'sjtu-manual-booking-order-v1';
  const QUERY_LOCK_NAME = 'sjtu-manual-booking-query-v1';
  const NEXT_QUERY_KEY = 'sjtu-manual-booking-next-query-v1';
  const RATE_COOLDOWN_KEY = 'sjtu-manual-booking-rate-cooldown-v1';
  const TIMEOUT_MS = 15000;
  const ORDER_TIMEOUT_MS = 10000;
  const MIN_QUERY_SPACING_MS = 4000;
  const DEFAULT_MONITOR_INTERVAL = 180;
  const MIN_MONITOR_INTERVAL = 60;
  const MAX_MONITOR_INTERVAL = 3600;
  // Public key observed in the site's booking flow. A changed site key requires a script update.
  const RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArKZOdKQAL+iYzJ4Q5EQzwv/yvVPnfdNVKRgNG19HbCYM4qIzFPEOFv28SVFQh+xqAj8tAfjpMSTihFwt6BQuWfZXWYpAqf4jF4cU7ez/VHJyzsn8Cb7Lf/1KsLpuz+MbqufrA57AysnLAnRXHOwik+QnpsXZYjTcjgxQ0iLMe5iJyo06CKFxH1rmgYMwS4E89kNg1VtYrFKs1MajApfhu9hTEXnm/lP24TPdefRXbf+z84p1GLue2HRhZs3wECH1HJWZOsrdL/M+wigWldY0fHoiaKsjD9rK1NyaPtk4bIYuwPsfQu5RN4hkEPpTvdw1nKzOdo77zNa5ovCY0uNLZwIDAQAB';
  const VENUES = [
    { name: '胡晓明网球场', type: '网球', venueId: '0c6edc93-87ac-41b0-9895-6b66fda93fe5', fieldType: '19f69e5c-872f-4fbb-b9fe-70d6337c2d93' },
    { name: '东区网球场', type: '网球', venueId: '3466293b-a7d8-45be-a918-8526e3bed4c5', fieldType: '4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76' },
    { name: '学生中心健身房', type: '健身房', venueId: 'd784ad7c-cb24-4282-afd6-a67aec68c675', fieldType: '7d46c0a4-3ae6-4398-822b-d4b7b37085fa' },
    { name: '子衿街健身房', type: '健身房', venueId: '768214ba-3b1c-4f29-ad00-15c0e376b000', fieldType: '0a349309-1734-4507-98bd-4c30bf33c6bc' },
    { name: '霍英东健身房', type: '健身房', venueId: '9096787a-bc53-430a-9405-57dc46bc9e83', fieldType: 'b3dce013-3a0e-45e0-a0c2-425a364ac90f' },
    { name: '霍英东羽毛球场', type: '羽毛球', venueId: '9096787a-bc53-430a-9405-57dc46bc9e83', fieldType: '49629b20-71fb-4bae-8675-fdae0831e861' },
    { name: '气膜体育中心羽毛球场', type: '羽毛球', venueId: '3b10ff47-7e83-4c21-816c-5edc257168c1', fieldType: '29942202-d2ac-448e-90b7-14d3c6be19ff' },
  ].map((venue) => ({ ...venue, key: `${venue.venueId}|${venue.fieldType}` }));

  class ApiError extends Error {
    constructor(message, code, kind = 'api') { super(message); this.code = code; this.kind = kind; }
  }

  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  })();
  const knownKeys = new Set(VENUES.map((venue) => venue.key));
  function monitorInterval(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? Math.min(MAX_MONITOR_INTERVAL, Math.max(MIN_MONITOR_INTERVAL, Math.round(number)))
      : DEFAULT_MONITOR_INTERVAL;
  }

  function datesInRange(dates, start, end) {
    return start && end && start <= end ? dates.filter((date) => date >= start && date <= end) : [];
  }

  function planRangeQueries(venues, dateMaps, range) {
    const tasks = [];
    const unopened = [];
    for (const venue of venues) {
      const map = dateMaps.get(venue.key);
      if (!map) continue;
      const missing = [];
      for (const date of range) {
        if (map.has(date)) tasks.push({ venue, date, dateId: map.get(date) });
        else missing.push(date);
      }
      if (missing.length) unopened.push(`${venue.name}：${missing.join('、')} 未开放预约。`);
    }
    return { tasks, unopened };
  }

  function nextMonitorDelay(intervalSeconds, rateStreak) {
    return rateStreak
      ? Math.min(900000, 120000 * 2 ** (rateStreak - 1))
      : intervalSeconds * 1000;
  }

  function readStoredTime(key) {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (_) { return 0; }
  }

  function apiErrorKind(code, message) {
    if (code === 401 || code === 403 || /未登录|登录超时/i.test(message)) return 'auth';
    if (code === 429 || /频繁|限流/i.test(message)) return 'rate';
    return 'api';
  }

  const state = {
    open: false, busy: false, submitting: false, confirmOpen: false,
    venueKeys: new Set(Array.isArray(stored.venues) ? stored.venues.filter((key) => knownKeys.has(key)) : VENUES.map((venue) => venue.key)),
    startDate: typeof stored.startDate === 'string' ? stored.startDate : typeof stored.date === 'string' ? stored.date : '',
    endDate: typeof stored.endDate === 'string' ? stored.endDate : typeof stored.date === 'string' ? stored.date : '',
    intervalSeconds: monitorInterval(stored.intervalSeconds),
    dateMaps: new Map(), dates: [], results: [], errors: [], selected: null, hasQueried: false,
    attempted: new Set(), orderId: '', message: '打开面板后读取可预约日期。',
    monitoring: false, monitorTimer: null, nextRunAt: 0, rateStreak: 0,
    cooldownUntil: readStoredTime(RATE_COOLDOWN_KEY), nextQueryAt: 0,
    activeController: null, monitorQuery: false, lastSeenSlotIds: new Set(),
    roundAlerted: new Set(), roundNotified: false, unseenCount: 0, roundNumber: 0,
  };

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({
      venues: [...state.venueKeys], startDate: state.startDate, endDate: state.endDate,
      intervalSeconds: state.intervalSeconds, candidates: stored.candidates,
    })); }
    catch (_) { /* The panel still works without storage. */ }
  }

  function todayInShanghai() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const value = (type) => parts.find((part) => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function checkedAt() {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date());
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function slotTime(index) {
    const hour = 7 + index;
    return `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00`;
  }

  function slotKey(venue, date, fieldId, index) {
    return `${venue.key}|${date}|${fieldId}|${index}`;
  }

  function cooldownUntil() {
    state.cooldownUntil = Math.max(state.cooldownUntil, readStoredTime(RATE_COOLDOWN_KEY));
    return state.cooldownUntil;
  }

  function cooldownText() {
    return new Date(cooldownUntil()).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }

  function ensureNotCoolingDown() {
    if (cooldownUntil() > Date.now()) {
      throw new ApiError(`原站要求放慢请求；已暂停查询至 ${cooldownText()}。`, 429, 'rate');
    }
  }

  function applyRateCooldown(retryAfter) {
    state.rateStreak += 1;
    const seconds = Number(retryAfter);
    const serverUntil = retryAfter && Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1000
      : retryAfter ? Date.parse(retryAfter) || 0 : 0;
    state.cooldownUntil = Math.max(cooldownUntil(), Date.now() + nextMonitorDelay(state.intervalSeconds, state.rateStreak), serverUntil);
    try { localStorage.setItem(RATE_COOLDOWN_KEY, String(state.cooldownUntil)); }
    catch (_) { /* Keep the cooldown in this tab. */ }
  }

  function pause(ms, signal) {
    if (signal?.aborted) return Promise.reject(new ApiError('请求已取消。', 0, 'cancel'));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new ApiError('请求已取消。', 0, 'cancel'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function pacedQueryRequest(path, body, options = {}) {
    const run = async () => {
      ensureNotCoolingDown();
      const waitMs = Math.max(0, Math.max(state.nextQueryAt, readStoredTime(NEXT_QUERY_KEY)) - Date.now());
      await pause(waitMs, options.signal);
      ensureNotCoolingDown();
      state.nextQueryAt = Date.now() + MIN_QUERY_SPACING_MS;
      try { localStorage.setItem(NEXT_QUERY_KEY, String(state.nextQueryAt)); }
      catch (_) { /* This tab still keeps its own pace. */ }
      return request(path, body, options);
    };
    if (!navigator.locks?.request) return run();
    try {
      return await navigator.locks.request(QUERY_LOCK_NAME, { mode: 'exclusive', signal: options.signal }, run);
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('请求已取消。', 0, 'cancel');
      throw error;
    }
  }

  async function request(path, body, { form = false, headers = {}, timeoutMs = TIMEOUT_MS, signal, onResponse } = {}) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const sentAt = Date.now();
    try {
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': form ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'application/json;charset=utf-8',
          ...headers,
        },
        body: form ? new URLSearchParams(body).toString() : typeof body === 'string' ? body : JSON.stringify(body),
      });
      if (onResponse) onResponse(response.headers.get('Date'), sentAt, Date.now());
      if (response.status === 401 || response.status === 403) throw new ApiError('登录已过期，请在预约网页重新登录。', response.status, 'auth');
      if (response.status === 429) {
        applyRateCooldown(response.headers.get('Retry-After'));
        throw new ApiError('请求过于频繁，服务器要求稍后再试。', 429, 'rate');
      }
      if (!(response.headers.get('Content-Type') || '').toLowerCase().includes('json')) {
        if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status, 'http');
        throw new ApiError('接口未返回 JSON，可能已跳转到登录页。', 401, 'auth');
      }
      const result = await response.json();
      if (!response.ok || Number(result?.code) !== 0) {
        const code = Number(result?.code ?? response.status);
        const message = `接口 ${result?.code ?? response.status}：${result?.msg || `HTTP ${response.status}`}`;
        const kind = apiErrorKind(code, message);
        if (kind === 'rate') applyRateCooldown(response.headers.get('Retry-After'));
        throw new ApiError(message, code, kind);
      }
      return result.data;
    } catch (error) {
      if (error.name === 'AbortError') {
        if (signal?.aborted) throw new ApiError('请求已取消。', 0, 'cancel');
        throw new ApiError('请求超时；若刚才提交了订单，请先去原站核对订单，勿重复提交。', 0, 'timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }

  async function loadDates(signal) {
    const selected = VENUES.filter((venue) => state.venueKeys.has(venue.key));
    if (!selected.length) throw new Error('请先选择至少一个场馆。');
    const maps = new Map();
    const dates = new Set();
    const errors = [];
    for (const [index, venue] of selected.entries()) {
      state.message = `读取日期 ${index + 1}/${selected.length}：${venue.name}`;
      render();
      try {
        const data = await pacedQueryRequest(DATE_URL, { id: venue.venueId, feildType: venue.fieldType, date: todayInShanghai() }, { signal });
        if (!Array.isArray(data)) throw new Error('日期数据格式不符。');
        const map = new Map();
        for (const item of data) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(item?.date) && item.dateId) {
            map.set(item.date, String(item.dateId));
            dates.add(item.date);
          }
        }
        maps.set(venue.key, map);
      } catch (error) {
        if (error instanceof ApiError && ['auth', 'rate', 'cancel'].includes(error.kind)) throw error;
        errors.push(`${venue.name}：${error.message}`);
      }
      if (signal?.aborted) throw new ApiError('请求已取消。', 0, 'cancel');
    }
    state.dateMaps = maps;
    state.dates = [...dates].sort();
    state.errors = errors;
    if (!state.dates.includes(state.startDate)) state.startDate = state.dates[0] || '';
    if (!state.dates.includes(state.endDate)) state.endDate = state.startDate;
    if (state.endDate < state.startDate) state.endDate = state.startDate;
    saveSettings();
    return state.dates.length;
  }

  function parseSlots(fields, venue, date) {
    if (!Array.isArray(fields)) throw new Error('场地数据格式不符。');
    const slots = [];
    for (const field of fields) {
      if (!Array.isArray(field?.priceList) || !field.fieldId) throw new Error('场地时段数据格式不符。');
      for (const [index, price] of field.priceList.entries()) {
        const count = Number(price?.count);
        if (!Number.isFinite(count)) throw new Error('余量数据格式不符。');
        if (count <= 0 || Number(price?.status) !== 0 || index > 14) continue;
        slots.push({
          id: slotKey(venue, date, field.fieldId, index), venue, date,
          fieldId: String(field.fieldId), fieldName: String(field.fieldName || field.fieldNameEn || '未命名场地'),
          index, time: slotTime(index), count, price: price.price,
          orderable: typeof price.sign === 'string' && price.sign.length > 0 && price.price !== undefined && price.price !== null,
          checkedAt: checkedAt(),
        });
      }
    }
    return slots;
  }

  function announceNewSlots(slots) {
    const fresh = slots.filter((slot) => slot.orderable && !state.lastSeenSlotIds.has(slot.id) && !state.roundAlerted.has(slot.id));
    if (!fresh.length) return;
    for (const slot of fresh) state.roundAlerted.add(slot.id);
    state.unseenCount += fresh.length;
    if (!state.roundNotified && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      state.roundNotified = true;
      try {
        const first = fresh[0];
        const notification = new Notification(`发现 ${fresh.length} 个可订场次`, {
          body: `${first.venue.name} · ${first.fieldName} · ${first.date} ${first.time}${fresh.length > 1 ? ' 等' : ''}`,
        });
        notification.onclick = () => { window.focus(); state.open = true; state.unseenCount = 0; render(); notification.close(); };
      } catch (_) { /* Some browsers only allow the in-page badge. */ }
    }
  }

  async function queryAvailability({ monitor = false } = {}) {
    if (state.busy || state.submitting) return 'busy';
    const controller = new AbortController();
    state.activeController = controller;
    state.monitorQuery = monitor;
    state.busy = true;
    state.results = [];
    state.hasQueried = false;
    state.selected = null;
    state.confirmOpen = false;
    state.orderId = '';
    state.errors = [];
    state.roundAlerted = new Set();
    state.roundNotified = false;
    const checkedGroups = [];
    let outcome = 'ok';
    render();
    try {
      await loadDates(controller.signal);
      const range = datesInRange(state.dates, state.startDate, state.endDate);
      if (!range.length) throw new Error('没有可查询的日期，请刷新日期或调整范围。');
      const selected = VENUES.filter((venue) => state.venueKeys.has(venue.key));
      const { tasks, unopened } = planRangeQueries(selected, state.dateMaps, range);
      state.errors.push(...unopened);
      if (!tasks.length) throw new Error('所选日期范围内，这些场馆暂时没有开放的场次。');
      for (const [index, { venue, date, dateId }] of tasks.entries()) {
        if (controller.signal.aborted) throw new ApiError('请求已取消。', 0, 'cancel');
        state.message = `查询余量 ${index + 1}/${tasks.length}：${venue.name} · ${date}`;
        render();
        try {
          const fields = await pacedQueryRequest(SITUATION_URL, {
            fieldType: venue.fieldType, date,
            venueId: venue.venueId, dateId,
          }, { signal: controller.signal });
          const slots = parseSlots(fields, venue, date);
          state.results.push(...slots);
          checkedGroups.push(`${venue.key}|${date}|`);
          if (monitor) announceNewSlots(slots);
        } catch (error) {
          if (error instanceof ApiError && ['auth', 'rate', 'cancel'].includes(error.kind)) throw error;
          state.errors.push(`${venue.name} · ${date}：${error.message}`);
        }
        render();
      }
      state.results.sort((a, b) => `${a.date}${a.time}${a.venue.name}${a.fieldName}`.localeCompare(`${b.date}${b.time}${b.venue.name}${b.fieldName}`, 'zh-CN'));
      state.hasQueried = true;
      state.message = `查询完成：${range[0]} 至 ${range[range.length - 1]}，${tasks.length} 组场馆日期，${state.results.length} 个有余量的场地时段${state.errors.length ? `，${state.errors.length} 条未开放或查询失败信息` : ''}。`;
    } catch (error) {
      outcome = error instanceof ApiError ? error.kind : 'error';
      if (!(outcome === 'cancel' && !state.monitoring)) {
        state.message = outcome === 'rate' ? `${error.message} 已暂停查询至 ${cooldownText()}；建议缩小场馆和日期范围。` : error.message;
      }
    } finally {
      if (monitor && outcome !== 'cancel') {
        state.lastSeenSlotIds = new Set([
          ...[...state.lastSeenSlotIds].filter((id) => !checkedGroups.some((prefix) => id.startsWith(prefix))),
          ...state.results.filter((slot) => slot.orderable).map((slot) => slot.id),
        ]);
      }
      state.activeController = null;
      state.monitorQuery = false;
      state.busy = false;
      render();
    }
    return outcome;
  }

  function stopMonitoring(message = '监控已停止。', abortCurrent = true) {
    state.monitoring = false;
    clearTimeout(state.monitorTimer);
    state.monitorTimer = null;
    state.nextRunAt = 0;
    if (abortCurrent && state.monitorQuery) state.activeController?.abort();
    state.message = message;
    render();
  }

  function scheduleNextMonitor() {
    if (!state.monitoring) return;
    clearTimeout(state.monitorTimer);
    const delay = Math.max(state.intervalSeconds * 1000, cooldownUntil() - Date.now());
    state.nextRunAt = Date.now() + delay;
    state.monitorTimer = setTimeout(() => {
      state.monitorTimer = null;
      if (state.monitoring) void runMonitorCycle();
    }, delay);
    render();
  }

  async function runMonitorCycle() {
    if (!state.monitoring || state.busy || state.submitting) return;
    if (cooldownUntil() > Date.now()) {
      state.message = `原站限流，已暂停查询至 ${cooldownText()}。`;
      scheduleNextMonitor();
      return;
    }
    state.nextRunAt = 0;
    state.roundNumber += 1;
    const outcome = await queryAvailability({ monitor: true });
    if (!state.monitoring) return;
    if (outcome === 'auth') {
      stopMonitoring('登录已失效，监控已停止。请在原站重新登录。', false);
      return;
    }
    if (outcome === 'rate') {
      state.message = `原站提示请求过于频繁，已暂停查询至 ${cooldownText()}。`;
    } else {
      state.rateStreak = 0;
    }
    scheduleNextMonitor();
  }

  function startMonitoring() {
    if (state.monitoring || state.busy || state.submitting || !state.venueKeys.size || !state.dates.length) return;
    state.monitoring = true;
    state.rateStreak = 0;
    state.roundNumber = 0;
    state.lastSeenSlotIds = new Set();
    state.unseenCount = 0;
    saveSettings();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Promise.resolve(Notification.requestPermission()).catch(() => {}); }
      catch (_) { /* The in-page badge still reports new availability. */ }
    }
    if (cooldownUntil() > Date.now()) {
      state.message = `原站限流，已暂停查询至 ${cooldownText()}。`;
      scheduleNextMonitor();
    } else {
      void runMonitorCycle();
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
  }

  function bytesToBigInt(bytes) {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  }

  function bigIntToBytes(value, length) {
    const bytes = new Uint8Array(length);
    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = Number(value & 255n);
      value >>= 8n;
    }
    if (value !== 0n) throw new Error('RSA 密文长度异常。');
    return bytes;
  }

  function modPow(base, exponent, modulus) {
    let result = 1n;
    while (exponent > 0n) {
      if (exponent & 1n) result = (result * base) % modulus;
      base = (base * base) % modulus;
      exponent >>= 1n;
    }
    return result;
  }

  let rsaComponentsPromise;
  function rsaComponents() {
    if (!rsaComponentsPromise) rsaComponentsPromise = (async () => {
      const spki = base64ToBytes(RSA_PUBLIC_KEY);
      const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
      const jwk = await crypto.subtle.exportKey('jwk', key);
      return { modulusBytes: base64ToBytes(jwk.n), exponent: bytesToBigInt(base64ToBytes(jwk.e)) };
    })();
    return rsaComponentsPromise;
  }

  async function rsaEncrypt(value) {
    const { modulusBytes, exponent } = await rsaComponents();
    const message = new TextEncoder().encode(value);
    const paddingSize = modulusBytes.length - message.length - 3;
    if (paddingSize < 8) throw new Error('RSA 明文过长。');
    const encoded = new Uint8Array(modulusBytes.length);
    encoded[1] = 2; // RSAES-PKCS1-v1_5: 00 || 02 || nonzero random padding || 00 || message
    for (let index = 2; index < 2 + paddingSize; index += 1) {
      let random = 0;
      while (!random) random = crypto.getRandomValues(new Uint8Array(1))[0];
      encoded[index] = random;
    }
    encoded.set(message, 3 + paddingSize);
    const encrypted = modPow(bytesToBigInt(encoded), exponent, bytesToBigInt(modulusBytes));
    return bytesToBase64(bigIntToBytes(encrypted, modulusBytes.length));
  }

  function randomAesKey() {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    while (result.length < 16) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      for (const byte of bytes) {
        if (byte < 252 && result.length < 16) result += alphabet[byte % alphabet.length];
      }
    }
    return result;
  }

  async function aesEncryptEcb(value, secret) {
    const plain = new TextEncoder().encode(value);
    const padding = 16 - plain.length % 16;
    const padded = new Uint8Array(plain.length + padding);
    padded.set(plain);
    padded.fill(padding, plain.length);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'AES-CBC', false, ['encrypt']);
    const output = new Uint8Array(padded.length);
    for (let offset = 0; offset < padded.length; offset += 16) {
      // The first CBC block with a zero IV equals one ECB block. WebCrypto has no ECB mode.
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: new Uint8Array(16) }, key, padded.subarray(offset, offset + 16),
      ));
      output.set(encrypted.subarray(0, 16), offset);
    }
    return bytesToBase64(output);
  }

  function tensionText(tension) {
    return ({ 0: '正常', 1: '紧张', 2: '很紧张', 3: '非常紧张', 4: '很紧张(签退)' })[String(tension)] || '';
  }

  function buildPayload(venue, date, field, price, index, motionType) {
    const { price: venuePrice, ...rest } = price;
    return {
      venTypeId: motionType.id,
      venueId: venue.venueId,
      fieldType: motionType.name,
      returnUrl: `${location.origin}/#/paymentResult/1`,
      scheduleDate: date,
      week: String(new Date(`${date}T00:00:00+08:00`).getDay()),
      spaces: [{
        ...rest, venuePrice, scheduleTime: slotTime(index),
        subSitename: field.fieldName || field.fieldNameEn, subSiteId: field.fieldId,
        tensity: field.fieldDetailStatus, venueNum: 1, status: 1,
      }],
      tenSity: tensionText(motionType.tension),
    };
  }

  async function submitSelected() {
    const selected = state.selected;
    if (!selected || state.submitting || state.busy || state.attempted.has(selected.id)) return;
    try {
      const record = readAttemptRecord();
      if (record?.targetDate === selected.date && ['sending', 'unknown', 'success'].includes(record.stage)) {
        state.message = '这个日期已有自动下单尝试，请先到原站核对订单。';
        render();
        return;
      }
      const manual = readManualAttempt(selected.date);
      if (manual && ['sending', 'unknown', 'success'].includes(manual.stage)) {
        state.message = '这个日期已有手动下单尝试，请先到原站核对订单。';
        render();
        return;
      }
    } catch (error) {
      state.message = `无法核对下单记录：${error.message}`;
      render();
      return;
    }
    state.confirmOpen = false;
    state.submitting = true;
    state.message = '正在重新核对场地、余量和价格…';
    render();
    let orderRequestStarted = false;
    try {
      const details = await pacedQueryRequest(VENUE_URL, { id: selected.venue.venueId }, { form: true });
      const motionType = details?.motionTypes?.find((item) => String(item.id) === selected.venue.fieldType);
      if (!motionType?.id || !motionType.name) throw new Error('未能确认场馆运动类型，已停止下单。');
      const dates = await pacedQueryRequest(DATE_URL, {
        id: selected.venue.venueId, feildType: selected.venue.fieldType, date: todayInShanghai(),
      });
      if (!Array.isArray(dates)) throw new Error('日期数据格式不符。');
      const dateId = dates.find((item) => item.date === selected.date)?.dateId;
      if (!dateId) throw new Error('所选日期已不可预约，请重新查询。');
      const fields = await pacedQueryRequest(SITUATION_URL, {
        fieldType: selected.venue.fieldType, date: selected.date,
        venueId: selected.venue.venueId, dateId,
      });
      if (!Array.isArray(fields)) throw new Error('场地数据格式不符。');
      const field = fields.find((item) => String(item.fieldId) === selected.fieldId);
      const price = field?.priceList?.[selected.index];
      if (!field || !price || Number(price.status) !== 0 || Number(price.count) <= 0 || !price.sign) {
        throw new Error('该场次已无可下单余量，请重新查询。');
      }
      if (String(price.price) !== String(selected.price)) {
        throw new Error(`价格从 ${selected.price} 变为 ${price.price}，请重新查询后确认。`);
      }
      if (String(field.fieldName || field.fieldNameEn || '') !== selected.fieldName) {
        throw new Error('场地名称已变化，请重新查询后确认。');
      }
      const payload = buildPayload(selected.venue, selected.date, field, price, selected.index, motionType);
      const aesKey = randomAesKey();
      const encryptedBody = await aesEncryptEcb(JSON.stringify(payload), aesKey);
      const sid = await rsaEncrypt(aesKey);
      const tim = await rsaEncrypt(String(Date.now()));
      state.message = '正在提交一次未付款订单…';
      render();
      if (!navigator.locks?.request) throw new Error('当前浏览器不支持跨标签页下单锁。');
      const orderId = await navigator.locks.request(ORDER_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('另一标签页正在下单，请先核对原站订单。');
        const automatic = readAttemptRecord();
        const manual = readManualAttempt(selected.date);
        if (automatic?.targetDate === selected.date && ['sending', 'unknown', 'success'].includes(automatic.stage)) {
          throw new Error('定时脚本已经尝试下单，请先核对原站订单。');
        }
        if (manual && ['sending', 'unknown', 'success'].includes(manual.stage)) {
          throw new Error('这个日期已有手动下单尝试，请先核对原站订单。');
        }
        const record = { targetDate: selected.date, stage: 'sending', at: new Date().toISOString() };
        writeManualAttempt(selected.date, record);
        orderRequestStarted = true;
        state.attempted.add(selected.id);
        try {
          const result = await request(ORDER_URL, encryptedBody, { headers: { sid, tim }, timeoutMs: ORDER_TIMEOUT_MS });
          if (result === undefined || result === null || result === '') {
            throw new Error('接口返回成功但没有订单号，请到原站核对订单。');
          }
          writeManualAttempt(selected.date, { ...record, stage: 'success', orderId: String(result) });
          return result;
        } catch (error) {
          writeManualAttempt(selected.date, { ...record, stage: error instanceof ApiError && error.kind === 'api' ? 'failed' : 'unknown' });
          throw error;
        }
      });
      state.orderId = String(orderId);
      state.message = `未付款订单已创建，订单号：${state.orderId}。请到原站查看订单。`;
    } catch (error) {
      state.message = orderRequestStarted && !(error instanceof ApiError && error.kind === 'api')
        ? `提交结果未知：${error.message} 请先到原站核对订单，勿重复提交。`
        : `未下单：${error.message}`;
    } finally {
      state.submitting = false;
      render();
    }
  }

  function readAttemptRecord() {
    const raw = localStorage.getItem(ATTEMPT_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function readManualAttempt(date) {
    const raw = localStorage.getItem(`${MANUAL_ATTEMPT_PREFIX}${date}`);
    return raw ? JSON.parse(raw) : null;
  }

  function writeManualAttempt(date, record) {
    const value = JSON.stringify(record);
    const key = `${MANUAL_ATTEMPT_PREFIX}${date}`;
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error('无法保存下单防重记录。');
  }

  const host = node('div');
  host.id = 'sjtu-manual-booking-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      button, select, input { font: inherit; }
      #launcher { position: fixed; left: 20px; bottom: 20px; width: 58px; height: 58px; border: 0; border-radius: 18px; background: #15466b; color: #fff; font-size: 27px; box-shadow: 0 8px 28px #19344966; cursor: pointer; pointer-events: auto; }
      #badge { position: absolute; top: -7px; right: -7px; min-width: 22px; padding: 2px 5px; border-radius: 12px; background: #d74328; color: #fff; font: bold 12px/18px system-ui, sans-serif; }
      #panel { position: fixed; left: 20px; bottom: 88px; width: min(520px, calc(100vw - 24px)); max-height: min(850px, calc(100vh - 105px)); display: flex; flex-direction: column; border-radius: 16px; border: 1px solid #b4ced7; background: #f7fbfd; color: #183b4a; box-shadow: 0 20px 60px #17354755; overflow: hidden; pointer-events: auto; font: 13px/1.45 system-ui, -apple-system, 'Microsoft YaHei', sans-serif; }
      [hidden] { display: none !important; }
      #head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 13px 15px; background: #15466b; color: #fff; }
      h2 { margin: 0; font-size: 17px; }
      #head small { opacity: .8; }
      #close { border: 0; background: transparent; color: #fff; font-size: 22px; cursor: pointer; }
      #body { padding: 14px 15px 18px; overflow-y: auto; }
      h3 { margin: 12px 0 7px; font-size: 13px; }
      .venues { display: grid; gap: 5px; }
      .venue { display: flex; align-items: center; gap: 7px; border: 1px solid #d2e2e7; background: #fff; border-radius: 7px; padding: 5px 7px; cursor: pointer; }
      .venue span { flex: 1; }
      .venue em { font-size: 11px; color: #547688; font-style: normal; }
      select { width: 100%; padding: 8px; border: 1px solid #b6ced4; border-radius: 8px; background: #fff; color: inherit; }
      .date-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .date-row label { display: grid; gap: 4px; }
      .monitor-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
      .monitor-row input { width: 86px; padding: 8px; border: 1px solid #b6ced4; border-radius: 8px; background: #fff; color: inherit; }
      #monitor-info { margin: 6px 0; color: #3e6778; }
      .actions { display: flex; gap: 7px; margin: 12px 0; }
      button.action { padding: 9px 11px; border: 0; border-radius: 8px; background: #0a7185; color: #fff; font-weight: 700; cursor: pointer; }
      button.action:disabled { opacity: .5; cursor: default; }
      button.secondary { background: #e4eff2; color: #255363; }
      #query { flex: 1; }
      #status { padding: 8px; border-radius: 8px; background: #e6f1f5; white-space: pre-wrap; overflow-wrap: anywhere; }
      #errors { margin-top: 7px; padding: 8px; border-radius: 8px; background: #fff0e9; color: #913d24; white-space: pre-wrap; overflow-wrap: anywhere; }
      .slots { display: grid; gap: 6px; }
      .slot { display: block; width: 100%; padding: 9px; text-align: left; border: 1px solid #bcded4; border-radius: 9px; background: #eaf8f2; color: #1d5543; cursor: pointer; }
      .slot strong, .slot span { display: block; }
      .slot span { margin-top: 3px; font-size: 11px; }
      .slot.selected { border: 2px solid #087d65; padding: 8px; }
      .slot:disabled { background: #edf1f1; color: #637175; cursor: default; }
      .hint { color: #607d88; font-size: 11px; }
      #order { width: 100%; margin-top: 11px; }
      #confirm { position: fixed; inset: 0; display: grid; place-items: center; background: #112d3c99; pointer-events: auto; font: 14px/1.5 system-ui, 'Microsoft YaHei', sans-serif; }
      #confirm-box { width: min(420px, calc(100vw - 28px)); padding: 18px; border-radius: 14px; background: #fff; color: #173b49; box-shadow: 0 20px 60px #0005; }
      #confirm-box h2 { margin-bottom: 9px; }
      #confirm-text { white-space: pre-line; overflow-wrap: anywhere; }
      @media (max-width: 520px) { #launcher { left: 12px; bottom: 12px; } #panel { left: 12px; bottom: 80px; max-height: calc(100vh - 92px); } }
    </style>
    <button id="launcher" type="button" aria-label="打开场地查询与手动下单" title="场地查询与手动下单">🏸<span id="badge" hidden></span></button>
    <section id="panel" role="dialog" aria-label="场地查询与手动下单" hidden>
      <div id="head"><div><h2>场地查询与手动下单</h2><small>查询余量 · 手动创建未付款订单</small></div><button id="close" type="button" aria-label="关闭">×</button></div>
      <div id="body">
        <h3>选择场馆</h3><div id="venues" class="venues"></div>
        <h3>选择日期范围（含起止日期）</h3>
        <div class="date-row"><label>开始日期<select id="date-start" aria-label="开始日期"></select></label><label>结束日期<select id="date-end" aria-label="结束日期"></select></label></div>
        <p id="scope-info" class="hint"></p>
        <div class="actions"><button id="query" class="action" type="button">查询所选范围</button><button id="refresh" class="action secondary" type="button">刷新日期</button></div>
        <h3>持续监控</h3>
        <div class="monitor-row"><label for="interval">每轮结束后等待</label><input id="interval" type="number" min="60" max="3600" step="1" aria-label="监控间隔秒数"><span>秒</span><button id="monitor" class="action secondary" type="button">开始监控</button></div>
        <p id="monitor-info" role="status"></p>
        <p class="hint">监控只查询并提醒，不会自动下单。请保持网页标签页打开；浏览器休眠可能推迟下一轮。</p>
        <div id="status" role="status"></div><div id="errors" hidden></div>
        <h3>可用场次</h3><div id="slots" class="slots"></div>
        <button id="order" class="action" type="button" disabled>下单所选时段</button>
        <p class="hint">每次只提交一个未付款订单。提交前会重新检查余量和价格；验证码如由原站要求，需在原站完成。</p>
      </div>
    </section>
    <div id="confirm" role="dialog" aria-modal="true" aria-label="确认提交订单" hidden><div id="confirm-box">
      <h2>确认提交未付款订单</h2><div id="confirm-text"></div>
      <div class="actions"><button id="cancel" class="action secondary" type="button">取消</button><button id="submit" class="action" type="button">确认提交一次</button></div>
    </div></div>`;
  const $ = (selector) => root.querySelector(selector);
  const elements = {
    launcher: $('#launcher'), badge: $('#badge'), panel: $('#panel'), close: $('#close'), venues: $('#venues'),
    startDate: $('#date-start'), endDate: $('#date-end'), scopeInfo: $('#scope-info'),
    interval: $('#interval'), monitor: $('#monitor'), monitorInfo: $('#monitor-info'),
    query: $('#query'), refresh: $('#refresh'), status: $('#status'), errors: $('#errors'),
    slots: $('#slots'), order: $('#order'), confirm: $('#confirm'), confirmText: $('#confirm-text'),
    cancel: $('#cancel'), submit: $('#submit'),
  };

  function mount() {
    const parent = document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }
  mount();
  new MutationObserver(() => { if (!host.isConnected || host.parentNode !== (document.body || document.documentElement)) mount(); })
    .observe(document.documentElement, { childList: true, subtree: true });

  function render() {
    elements.panel.hidden = !state.open;
    elements.status.textContent = state.message;
    elements.badge.hidden = !state.unseenCount;
    elements.badge.textContent = state.unseenCount > 99 ? '99+' : String(state.unseenCount);
    elements.monitor.textContent = state.monitoring ? '停止监控' : '开始监控';
    elements.monitor.disabled = !state.monitoring && (state.busy || state.submitting || !state.venueKeys.size || !state.dates.length);
    elements.monitorInfo.textContent = state.monitoring
      ? state.busy && state.monitorQuery
        ? `监控中：第 ${state.roundNumber} 轮正在查询。`
        : state.nextRunAt
          ? `监控中：已完成 ${state.roundNumber} 轮；下一轮约 ${new Date(state.nextRunAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（${state.rateStreak ? '限流退避' : `间隔 ${state.intervalSeconds} 秒`}）。`
          : '监控中：正在安排下一轮。'
      : '监控未启动；刷新页面后不会自动启动。';
    if (root.activeElement !== elements.interval) elements.interval.value = String(state.intervalSeconds);
    elements.interval.disabled = state.submitting;
    elements.errors.hidden = !state.errors.length;
    elements.errors.textContent = state.errors.join('\n');
    elements.query.disabled = state.busy || state.submitting || state.monitoring || !state.venueKeys.size;
    elements.refresh.disabled = state.busy || state.submitting || state.monitoring || !state.venueKeys.size;
    elements.startDate.disabled = state.busy || state.submitting || state.monitoring || !state.dates.length;
    elements.endDate.disabled = state.busy || state.submitting || state.monitoring || !state.dates.length;
    elements.order.disabled = state.busy || state.submitting || !state.selected || !state.selected.orderable || state.attempted.has(state.selected?.id);
    elements.confirm.hidden = !state.confirmOpen;
    elements.submit.disabled = state.submitting;
    const venueRows = VENUES.map((venue) => {
      const label = node('label', 'venue');
      const input = node('input');
      input.type = 'checkbox';
      input.checked = state.venueKeys.has(venue.key);
      input.disabled = state.busy || state.submitting || state.monitoring;
      input.addEventListener('change', () => {
        if (input.checked) state.venueKeys.add(venue.key); else state.venueKeys.delete(venue.key);
        state.dateMaps.clear();
        state.dates = [];
        state.results = [];
        state.hasQueried = false;
        state.selected = null;
        state.message = '场馆已变化，请点击“查询空余”重新读取日期和余量。';
        saveSettings(); render();
      });
      label.append(input, node('span', '', venue.name), node('em', '', venue.type));
      return label;
    });
    elements.venues.replaceChildren(...venueRows);
    const dateOptions = state.dates.map((date) => {
      const option = node('option', '', date);
      option.value = date;
      return option;
    });
    elements.startDate.replaceChildren(...dateOptions);
    elements.endDate.replaceChildren(...dateOptions.map((option) => option.cloneNode(true)));
    elements.startDate.value = state.startDate;
    elements.endDate.value = state.endDate;
    const selectedVenues = VENUES.filter((venue) => state.venueKeys.has(venue.key));
    const range = datesInRange(state.dates, state.startDate, state.endDate);
    const taskCount = planRangeQueries(selectedVenues, state.dateMaps, range).tasks.length;
    elements.scopeInfo.textContent = taskCount
      ? `本次共 ${taskCount} 组场馆日期；请求至少间隔 ${MIN_QUERY_SPACING_MS / 1000} 秒。范围越大，查询越久；建议只勾选需要的场馆。`
      : '请选择场馆和已开放日期；扩大范围会增加请求次数。';
    const rows = state.results.map((slot) => {
      const button = node('button', `slot${state.selected?.id === slot.id ? ' selected' : ''}`);
      button.type = 'button';
      button.disabled = !slot.orderable || state.busy || state.submitting || state.attempted.has(slot.id);
      button.append(
        node('strong', '', `${slot.venue.name} · ${slot.fieldName} · ${slot.time}`),
        node('span', '', `${slot.date} · 余量 ${slot.count} · 接口报价 ${slot.price ?? '未知'} · 查询 ${slot.checkedAt}${slot.orderable ? '' : ' · 缺少下单凭据'}`),
      );
      button.addEventListener('click', () => { state.selected = slot; render(); });
      return button;
    });
    if (!rows.length) rows.push(node('p', 'hint', state.busy ? '正在查询，请稍候…' : state.errors.length ? '目前没有已确认的可用场次；部分查询失败或日期未开放。' : state.hasQueried ? '本次查询范围内无可用场次。' : '点击“查询空余”查看结果。'));
    elements.slots.replaceChildren(...rows);
    if (state.selected) {
      const slot = state.selected;
      elements.confirmText.textContent = `${slot.venue.name} · ${slot.fieldName}\n${slot.date} ${slot.time}\n接口报价：${slot.price ?? '未知'}\n\n确认后会向原站提交一次订单，暂不付款。请检查场地、日期、时间和价格。`;
    }
  }

  async function refreshDatesOnly() {
    if (state.busy || state.submitting || state.monitoring) return;
    state.busy = true;
    state.results = [];
    state.hasQueried = false;
    state.selected = null;
    state.errors = [];
    render();
    try {
      const count = await loadDates();
      state.message = count ? `已读取 ${count} 个可选日期，请选择起止日期后查询空余。` : '没有读取到可选日期。';
    } catch (error) {
      state.message = error instanceof ApiError && error.kind === 'rate'
        ? `${error.message} 已暂停查询至 ${cooldownText()}。` : error.message;
    }
    finally { state.busy = false; render(); }
  }

  elements.launcher.addEventListener('click', () => {
    state.open = !state.open;
    if (state.open) state.unseenCount = 0;
    render();
    if (state.open && !state.dates.length) void refreshDatesOnly();
  });
  elements.close.addEventListener('click', () => { state.open = false; render(); });
  function changeDateRange(changed) {
    state.startDate = elements.startDate.value;
    state.endDate = elements.endDate.value;
    if (state.startDate > state.endDate) {
      if (changed === 'start') state.endDate = state.startDate;
      else state.startDate = state.endDate;
    }
    state.results = [];
    state.hasQueried = false;
    state.selected = null;
    state.message = '日期范围已变化，请重新查询空余。';
    saveSettings(); render();
  }
  elements.startDate.addEventListener('change', () => changeDateRange('start'));
  elements.endDate.addEventListener('change', () => changeDateRange('end'));
  elements.interval.addEventListener('change', () => {
    state.intervalSeconds = monitorInterval(elements.interval.value);
    saveSettings();
    if (state.monitoring && state.monitorTimer !== null) scheduleNextMonitor();
    else render();
  });
  elements.monitor.addEventListener('click', () => {
    if (state.monitoring) stopMonitoring();
    else startMonitoring();
  });
  elements.refresh.addEventListener('click', () => { void refreshDatesOnly(); });
  elements.query.addEventListener('click', () => { void queryAvailability(); });
  elements.order.addEventListener('click', () => {
    if (state.monitoring) stopMonitoring('已停止监控，请确认手动下单。');
    state.confirmOpen = true;
    render();
  });
  elements.cancel.addEventListener('click', () => { state.confirmOpen = false; render(); });
  elements.submit.addEventListener('click', () => { void submitSelected(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.confirmOpen && !state.submitting) {
      state.confirmOpen = false; render();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.monitoring && state.monitorTimer !== null && Date.now() >= state.nextRunAt) {
      clearTimeout(state.monitorTimer);
      state.monitorTimer = null;
      void runMonitorCycle();
    }
  });
  render();
})();
