// ==UserScript==
// @name         SJTU 12:00 定时抢场
// @namespace    local.sjtu.sports.noon-booking
// @version      0.4.1
// @description  按运动类型、场地和时段优先级，在上海时间 12:00 争取七天后的一个未付款订单。
// @match        https://sports.sjtu.edu.cn/pc/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (document.getElementById('sjtu-noon-booking-host')) return;

  const DATE_URL = '/manage/fieldDetail/queryFieldReserveSituationIsFull';
  const SITUATION_URL = '/manage/fieldDetail/queryFieldSituation';
  const VENUE_URL = '/manage/venue/queryVenueById';
  const ORDER_URL = '/venue/personal/ConfirmOrder';
  const STORAGE_KEY = 'sjtu-noon-booking-settings-v1';
  const LEGACY_STORAGE_KEY = 'sjtu-manual-booking-settings-v1';
  const ATTEMPT_KEY = 'sjtu-manual-booking-attempt-v1';
  const MANUAL_ATTEMPT_PREFIX = 'sjtu-manual-booking-manual-attempt-';
  const ORDER_LOCK_NAME = 'sjtu-manual-booking-order-v1';
  const TIMEOUT_MS = 15000;
  const RELEASE_QUERY_TIMEOUT_MS = 8000;
  const ORDER_TIMEOUT_MS = 10000;
  const DEFAULT_RELEASE_WINDOW_MINUTES = 5;
  const MIN_RELEASE_WINDOW_MINUTES = 1;
  const MAX_RELEASE_WINDOW_MINUTES = 15;
  const RELEASE_RETRY_MS = 1000;
  const RETRY_JITTER_RATIO = 0.25;
  const MAX_RETRY_JITTER_MS = 1000;
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
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  })();
  const knownKeys = new Set(VENUES.map((venue) => venue.key));
  const savedCandidates = Array.isArray(stored.candidates) ? stored.candidates : [];
  const candidates = savedCandidates.filter((item) => knownKeys.has(item?.venueKey)
    && (item.fieldId === '' || typeof item.fieldId === 'string')
    && Number.isInteger(item.index) && item.index >= 0 && item.index <= 14)
    .slice(0, 30).map((item) => ({ venueKey: item.venueKey, fieldId: item.fieldId, fieldName: String(item.fieldName || ''), index: item.index }));
  const state = {
    open: false, orderId: '',
    candidates, fieldCatalog: new Map(), candidateLoading: false, armConfirmOpen: false,
    windowMinutes: releaseWindowMinutes(stored.windowMinutes),
    autoRun: null, autoPhase: 'idle', autoMessage: '添加候选场次后可启动定时抢场。',
    autoLog: [], autoErrors: [], autoErrorCount: 0,
    clockOffsetMs: 0, clockSource: '本机时间',
  };
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ candidates: state.candidates, windowMinutes: state.windowMinutes })); }
    catch (_) { /* The panel still works without storage. */ }
  }

  function todayInShanghai() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const value = (type) => parts.find((part) => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function shanghaiDateAt(timestamp) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const value = (type) => parts.find((part) => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function addShanghaiDays(date, days) {
    return shanghaiDateAt(Date.parse(`${date}T00:00:00+08:00`) + days * 86400000);
  }

  function releaseWindowMinutes(value) {
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes > 0
      ? Math.min(MAX_RELEASE_WINDOW_MINUTES, Math.max(MIN_RELEASE_WINDOW_MINUTES, Math.round(minutes)))
      : DEFAULT_RELEASE_WINDOW_MINUTES;
  }

  function releaseDeadline(releaseAt, minutes) {
    return releaseAt + releaseWindowMinutes(minutes) * 60000;
  }

  function nextRelease(nowMs, offsetMs = 0) {
    const today = shanghaiDateAt(nowMs + offsetMs);
    const noon = Date.parse(`${today}T12:00:00+08:00`);
    const releaseDate = nowMs + offsetMs < noon ? today : addShanghaiDays(today, 1);
    return {
      releaseDate,
      targetDate: addShanghaiDays(releaseDate, 7),
      releaseAt: Date.parse(`${releaseDate}T12:00:00+08:00`),
    };
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

  async function request(path, body, { form = false, headers = {}, timeoutMs = TIMEOUT_MS, signal, onResponse } = {}) {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const sentAt = Date.now();
    let httpStatus = 0;
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
      httpStatus = response.status;
      if (onResponse) onResponse(response.headers.get('Date'), sentAt, Date.now());
      if (response.status === 401 || response.status === 403) throw new ApiError('登录已过期，请在预约网页重新登录。', response.status, 'auth');
      if (response.status === 429) throw new ApiError('请求过于频繁，服务器要求稍后再试。', 429, 'rate');
      if (!(response.headers.get('Content-Type') || '').toLowerCase().includes('json')) {
        if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status,
          response.status >= 500 ? 'server' : 'http');
        throw new ApiError('接口未返回 JSON，可能已跳转到登录页。', 401, 'auth');
      }
      const result = await response.json();
      if (!response.ok || Number(result?.code) !== 0) {
        const code = Number(result?.code ?? response.status);
        const message = `接口 ${result?.code ?? response.status}：${result?.msg || `HTTP ${response.status}`}`;
        const kind = apiErrorKind(response.ok ? code : response.status, message);
        throw new ApiError(message, code, kind);
      }
      return result.data;
    } catch (error) {
      let failure = error;
      if (error.name === 'AbortError') {
        failure = signal?.aborted
          ? new ApiError('请求已取消。', 0, 'cancel')
          : new ApiError(path === ORDER_URL
            ? '下单请求超时；请先去原站核对订单，勿重复提交。'
            : `查询请求超过 ${timeoutMs} 毫秒仍未返回。`, 0, 'timeout');
      }
      failure.requestPath = path;
      failure.elapsedMs = Date.now() - sentAt;
      failure.httpStatus = httpStatus;
      throw failure;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromParent);
    }
  }

  function apiErrorKind(code, message) {
    if (code === 401 || code === 403 || /未登录|登录超时/i.test(message)) return 'auth';
    if (code === 429 || /频繁|限流/i.test(message)) return 'rate';
    return code >= 500 ? 'server' : 'api';
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

  function candidateId(candidate) {
    return `${candidate.venueKey}|${candidate.fieldId || '*'}|${candidate.index}`;
  }

  function candidateLabel(candidate) {
    const venue = VENUES.find((item) => item.key === candidate.venueKey);
    return `${venue?.name || '未知场馆'} · ${candidate.fieldName || '任意场地'} · ${slotTime(candidate.index)}`;
  }

  function autoActive() {
    return ['preflight', 'waiting', 'date_pending', 'checking', 'query_failed', 'available', 'submitting'].includes(state.autoPhase);
  }

  function logAuto(message) {
    state.autoLog.push(`${checkedAt()}  ${message}`);
    if (state.autoLog.length > 50) state.autoLog.shift();
    renderAutoStatus();
  }

  function retryDelay(baseMs) {
    const jitter = Math.min(MAX_RETRY_JITTER_MS, Math.round(baseMs * RETRY_JITTER_RATIO));
    return baseMs + Math.floor(Math.random() * (jitter + 1));
  }

  function requestName(path) {
    return ({ [DATE_URL]: '日期接口', [SITUATION_URL]: '场次接口',
      [VENUE_URL]: '场馆接口', [ORDER_URL]: '下单接口' })[path] || '页面检查';
  }

  function recordAutoError(error, context, nextDelayMs = null) {
    if (error?.kind === 'cancel') return;
    const stage = error?.requestPath ? requestName(error.requestPath) : context;
    const details = [context !== stage ? `${context} · ${stage}` : stage];
    if (error?.httpStatus) details.push(`HTTP ${error.httpStatus}`);
    if (error?.code && error.code !== error.httpStatus) details.push(`接口码 ${error.code}`);
    if (Number.isFinite(error?.elapsedMs)) details.push(`耗时 ${error.elapsedMs}ms`);
    if (error?.kind) details.push(`类型 ${error.kind}`);
    const message = String(error?.message || error || '未知错误')
      .replace(/\b(JSESSIONID|Cookie|sid|tim)\s*[:=]\s*[^;\s]+/gi, '$1=[已隐藏]')
      .replace(/\s+/g, ' ').slice(0, 240);
    let line = `${checkedAt()}  ${details.join(' · ')}：${message}`;
    if (nextDelayMs !== null) line += `；约 ${(nextDelayMs / 1000).toFixed(2)} 秒后重试`;
    state.autoErrorCount += 1;
    state.autoErrors.push(line);
    if (state.autoErrors.length > 30) state.autoErrors.shift();
    renderAutoStatus();
  }

  function readAttemptRecord() {
    const raw = localStorage.getItem(ATTEMPT_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function readManualAttempt(date) {
    const raw = localStorage.getItem(`${MANUAL_ATTEMPT_PREFIX}${date}`);
    return raw ? JSON.parse(raw) : null;
  }

  function writeAttemptRecord(record) {
    localStorage.setItem(ATTEMPT_KEY, JSON.stringify(record));
    if (localStorage.getItem(ATTEMPT_KEY) !== JSON.stringify(record)) {
      throw new Error('无法保存下单防重记录，已停止自动下单。');
    }
  }

  function updateClockOffset(dateHeader, sentAt, receivedAt) {
    if (!dateHeader) return;
    const serverTime = Date.parse(dateHeader);
    if (!Number.isFinite(serverTime)) return;
    const offset = serverTime - (sentAt + receivedAt) / 2;
    if (Math.abs(offset) > 5 * 60 * 1000) return;
    state.clockOffsetMs = offset;
    state.clockSource = `服务器响应时间（偏差 ${Math.round(offset)} 毫秒）`;
  }

  async function checkCurrentPublicKey() {
    if (!location.pathname.startsWith('/pc')) throw new Error('请在 /pc/ 预约页面启动定时抢场。');
    const script = [...document.scripts].find((item) => /\/pc\/static\/js\/app\.[^/]+\.js(?:\?|$)/.test(item.src));
    if (!script) throw new Error('未找到预约页面主脚本，无法核对下单公钥。');
    const response = await fetch(script.src, { credentials: 'same-origin', cache: 'no-cache' });
    if (!response.ok) throw new Error(`无法读取预约页面主脚本：HTTP ${response.status}`);
    const source = await response.text();
    const keys = [...source.matchAll(/setPublicKey\(\s*['"](MIIB[A-Za-z0-9+/=]{300,})['"]\s*\)/g)].map((match) => match[1]);
    if (keys.length !== 1 || keys[0] !== RSA_PUBLIC_KEY) {
      throw new Error('当前网页下单公钥与脚本不一致，或无法唯一识别；请更新脚本后再启动。');
    }
    await rsaComponents();
  }

  async function loadVenueCatalog(venue, { signal, timeoutMs = TIMEOUT_MS } = {}) {
    const details = await request(VENUE_URL, { id: venue.venueId }, { form: true, signal, timeoutMs });
    const motionType = details?.motionTypes?.find((item) => String(item.id) === venue.fieldType);
    if (!motionType?.id || !motionType.name) throw new Error(`${venue.name}：运动类型已变化。`);
    const dates = await request(DATE_URL, {
      id: venue.venueId, feildType: venue.fieldType, date: todayInShanghai(),
    }, { signal, timeoutMs, onResponse: updateClockOffset });
    if (!Array.isArray(dates)) throw new Error(`${venue.name}：日期数据格式不符。`);
    const sample = dates.find((item) => item.date && item.dateId);
    if (!sample) throw new Error(`${venue.name}：没有可用于预检的日期。`);
    const fields = await request(SITUATION_URL, {
      fieldType: venue.fieldType, date: sample.date,
      venueId: venue.venueId, dateId: sample.dateId,
    }, { signal, timeoutMs });
    if (!Array.isArray(fields) || !fields.length) throw new Error(`${venue.name}：没有读取到场地。`);
    const fieldCatalog = fields.filter((field) => field.fieldId).map((field) => ({
      id: String(field.fieldId), name: String(field.fieldName || field.fieldNameEn || field.fieldId),
    }));
    if (!fieldCatalog.length) throw new Error(`${venue.name}：场地标识缺失。`);
    state.fieldCatalog.set(venue.key, fieldCatalog);
    return { motionType, fields: fieldCatalog };
  }

  async function loadCandidateFields() {
    if (state.candidateLoading || autoActive()) return;
    const venue = VENUES.find((item) => item.key === elements.autoVenue.value);
    if (!venue) return;
    state.candidateLoading = true;
    elements.autoFieldHint.textContent = `正在读取 ${venue.name} 的场地…`;
    renderAutoStatus();
    try {
      await loadVenueCatalog(venue);
      elements.autoFieldHint.textContent = `已读取 ${state.fieldCatalog.get(venue.key).length} 个场地。`;
      renderCandidateFields();
    } catch (error) {
      elements.autoFieldHint.textContent = `读取失败：${error.message}；仍可选择“任意场地”。`;
    } finally {
      state.candidateLoading = false;
      renderAutoStatus();
    }
  }

  function sleepForRun(run, milliseconds) {
    return new Promise((resolve) => {
      if (run.controller.signal.aborted || milliseconds <= 0) { resolve(); return; }
      const done = () => {
        clearTimeout(timer);
        run.controller.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      run.controller.signal.addEventListener('abort', done, { once: true });
    });
  }

  function currentReleaseNow() { return Date.now() + state.clockOffsetMs; }

  function runAlive(run) {
    return state.autoRun === run && !run.controller.signal.aborted
      && ['waiting', 'date_pending', 'checking', 'query_failed', 'available', 'submitting'].includes(state.autoPhase);
  }

  function finishAuto(run, phase, message) {
    if (state.autoRun !== run) return;
    clearInterval(run.tickTimer);
    run.controller.abort();
    for (const waiter of run.limitWaiters.splice(0)) waiter.resolve(false);
    state.autoPhase = phase;
    state.autoMessage = message;
    logAuto(message);
    render();
  }

  function stopAuto() {
    const run = state.autoRun;
    if (!run || !autoActive()) return;
    if (run.postStarted) {
      state.autoMessage = '订单已发出，正在等待结果；此时不能取消服务器上的提交。';
      renderAutoStatus();
      return;
    }
    finishAuto(run, 'stopped', '已停止本次定时抢场。');
  }

  async function preflightAuto(run) {
    if (!navigator.locks?.request) throw new Error('当前浏览器缺少跨标签页锁，无法安全运行自动下单。');
    const old = readAttemptRecord();
    if (old?.releaseDate === run.releaseDate) throw new Error('本次放号已有下单尝试记录；请先在原站核对订单。');
    const manual = readManualAttempt(run.targetDate);
    if (manual && ['sending', 'unknown', 'success'].includes(manual.stage)) {
      throw new Error('目标日期已有手动下单尝试；请先在原站核对订单。');
    }
    await checkCurrentPublicKey();
    const venues = [...new Set(run.candidates.map((candidate) => candidate.venueKey))]
      .map((key) => VENUES.find((venue) => venue.key === key));
    const queue = [...venues];
    const errors = [];
    await Promise.allSettled(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length && state.autoRun === run && !run.controller.signal.aborted) {
        const venue = queue.shift();
        try {
          const catalog = await loadVenueCatalog(venue, { signal: run.controller.signal });
          run.catalogs.set(venue.key, catalog);
          for (const candidate of run.candidates.filter((item) => item.venueKey === venue.key && item.fieldId)) {
            if (!catalog.fields.some((field) => field.id === candidate.fieldId)) {
              throw new Error(`${candidateLabel(candidate)}：场地已不在当前场馆列表。`);
            }
          }
          logAuto(`${venue.name}：登录及场地预检通过。`);
        } catch (error) {
          recordAutoError(error, `${venue.name} 预检`);
          errors.push(error.message);
        }
      }
    }));
    if (errors.length) throw new Error(errors.join('；'));
    if (run.catalogs.size !== venues.length) throw new Error('预检未完成。');
  }

  function matchingOptions(run, venue, fields, dateId) {
    if (!Array.isArray(fields)) throw new Error('场地数据格式不符。');
    const options = [];
    for (const [rank, candidate] of run.candidates.entries()) {
      if (candidate.venueKey !== venue.key) continue;
      for (const field of fields) {
        if (!field?.fieldId || !Array.isArray(field.priceList)) continue;
        if (candidate.fieldId && String(field.fieldId) !== candidate.fieldId) continue;
        const price = field.priceList[candidate.index];
        if (!price || Number(price.status) !== 0 || Number(price.count) <= 0
          || typeof price.sign !== 'string' || !price.sign || price.price === undefined || price.price === null) continue;
        const optionKey = `${rank}|${field.fieldId}|${candidate.index}`;
        if (run.failedOptions.has(optionKey)) continue;
        options.push({
          optionKey, rank, candidate, venue, fieldId: String(field.fieldId),
          fieldName: String(field.fieldName || field.fieldNameEn || field.fieldId),
          price: price.price, dateId,
        });
      }
    }
    return options.sort((a, b) => a.rank - b.rank);
  }

  async function attemptAutoOption(run, option) {
    const { venue, candidate } = option;
    logAuto(`再次核对：${venue.name} · ${option.fieldName} · ${slotTime(candidate.index)}。`);
    let fields;
    try {
      fields = await limitedReleaseRequest(run, SITUATION_URL, {
        fieldType: venue.fieldType, date: run.targetDate,
        venueId: venue.venueId, dateId: option.dateId,
      }, { priority: 2 });
    } catch (error) {
      if (error.kind === 'auth') {
        recordAutoError(error, `${venue.name} 二次查询`);
        finishAuto(run, 'failed', '登录已失效，自动下单已停止。');
        return 'terminal';
      }
      if (error.kind === 'cancel') return 'terminal';
      recordAutoError(error, `${venue.name} 二次查询`);
      logAuto(`二次查询失败：${error.message}`);
      return 'failed';
    }
    if (!Array.isArray(fields)) return 'failed';
    const field = fields.find((item) => String(item.fieldId) === option.fieldId);
    const price = field?.priceList?.[candidate.index];
    if (!field || !price || Number(price.status) !== 0 || Number(price.count) <= 0 || !price.sign
      || String(price.price) !== String(option.price)
      || String(field.fieldName || field.fieldNameEn || field.fieldId) !== option.fieldName) {
      logAuto(`场次已变化，跳过：${venue.name} · ${option.fieldName}。`);
      return 'failed';
    }
    if (currentReleaseNow() > run.deadlineAt || !runAlive(run)) return 'terminal';
    const motionType = run.catalogs.get(venue.key)?.motionType;
    if (!motionType) { finishAuto(run, 'failed', '缺少场馆预检信息，自动下单已停止。'); return 'terminal'; }
    const payload = buildPayload(venue, run.targetDate, field, price, candidate.index, motionType);
    const aesKey = randomAesKey();
    const encryptedBody = await aesEncryptEcb(JSON.stringify(payload), aesKey);
    const sid = await rsaEncrypt(aesKey);
    const tim = await rsaEncrypt(String(Date.now()));
    if (!runAlive(run)) return 'terminal';
    state.autoPhase = 'submitting';
    state.autoMessage = `正在提交：${candidateLabel(candidate)}。`;
    logAuto(state.autoMessage);
    render();
    let outcome;
    try {
      outcome = await navigator.locks.request(ORDER_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) return { kind: 'locked' };
        if (!runAlive(run)) return { kind: 'cancelled' };
        const previous = readAttemptRecord();
        const manual = readManualAttempt(run.targetDate);
        if (manual && ['sending', 'unknown', 'success'].includes(manual.stage)) return { kind: 'locked' };
        if (previous?.releaseDate === run.releaseDate && previous.owner !== run.id) return { kind: 'locked' };
        if (previous?.releaseDate === run.releaseDate && ['sending', 'unknown', 'success'].includes(previous.stage)) {
          return { kind: 'locked' };
        }
        const record = {
          releaseDate: run.releaseDate, targetDate: run.targetDate, owner: run.id,
          stage: 'sending', candidate: option.optionKey, at: new Date().toISOString(),
          attempts: [...(previous?.owner === run.id ? previous.attempts || [] : []), option.optionKey],
        };
        writeAttemptRecord(record); // Must complete before the first order POST byte is sent.
        try {
          run.postStarted = true;
          renderAutoStatus();
          const orderId = await request(ORDER_URL, encryptedBody, { headers: { sid, tim }, timeoutMs: ORDER_TIMEOUT_MS });
          if (orderId === undefined || orderId === null || orderId === '') {
            writeAttemptRecord({ ...record, stage: 'unknown' });
            recordAutoError(new Error('接口返回成功，但没有订单号。'), '提交订单');
            return { kind: 'unknown', message: '接口返回成功但没有订单号。' };
          }
          writeAttemptRecord({ ...record, stage: 'success', orderId: String(orderId) });
          return { kind: 'success', orderId: String(orderId) };
        } catch (error) {
          recordAutoError(error, '提交订单');
          if (error instanceof ApiError && error.kind === 'api' && !/验证码|安全验证|滑块/i.test(error.message)) {
            writeAttemptRecord({ ...record, stage: 'failed', reason: error.message });
            return { kind: 'failed', message: error.message };
          }
          writeAttemptRecord({ ...record, stage: 'unknown' });
          return { kind: 'unknown', message: error.message };
        }
      });
    } catch (error) {
      recordAutoError(error, '提交订单');
      // A failed lock or storage operation before POST is safe; after POST the ledger stays at 'sending'.
      const record = (() => { try { return readAttemptRecord(); } catch (_) { return null; } })();
      outcome = record?.releaseDate === run.releaseDate && record.owner === run.id && record.stage === 'sending'
        ? { kind: 'unknown', message: error.message } : { kind: 'locked', message: error.message };
    }
    if (outcome.kind === 'success') {
      state.orderId = outcome.orderId;
      finishAuto(run, 'success', `已创建一个未付款订单，订单号：${outcome.orderId}。`);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('SJTU 抢场成功', { body: `未付款订单 ${outcome.orderId}` }); } catch (_) { /* Panel remains visible. */ }
      }
      return 'success';
    }
    if (outcome.kind === 'failed') {
      run.postStarted = false;
      run.failedOptions.add(option.optionKey);
      logAuto(`服务器明确拒绝该场次：${outcome.message}`);
      state.autoPhase = 'checking';
      state.autoMessage = '继续尝试其他可订候选。';
      renderAutoStatus();
      return 'failed';
    }
    finishAuto(run, outcome.kind === 'locked' ? 'failed' : 'unknown',
      outcome.kind === 'locked'
        ? '另一个标签页正在或已经尝试下单；已停止本页，避免重复。'
        : `提交结果未知：${outcome.message} 请先到原站核对订单。`);
    return 'terminal';
  }

  function offerAutoOptions(run, options) {
    if (!runAlive(run) || !options.length) return;
    for (const option of options) {
      if (!run.failedOptions.has(option.optionKey)) run.optionQueue.set(option.optionKey, option);
    }
    if (!run.orderInFlight) {
      state.autoPhase = 'available';
      state.autoMessage = `已确认 ${run.optionQueue.size} 个可订候选，正在核对并准备提交。`;
      renderAutoStatus();
      run.drainPromise = drainAutoOptions(run);
    }
  }

  async function drainAutoOptions(run) {
    if (run.orderInFlight) return;
    run.orderInFlight = true;
    try {
      while (runAlive(run) && run.optionQueue.size) {
        const option = [...run.optionQueue.values()].sort((a, b) => a.rank - b.rank)[0];
        run.optionQueue.delete(option.optionKey);
        if (run.failedOptions.has(option.optionKey)) continue;
        const result = await attemptAutoOption(run, option);
        if (result === 'success' || result === 'terminal') return;
      }
    } catch (error) {
      recordAutoError(error, '处理可订候选');
      finishAuto(run, 'failed', `自动下单停止：${error.message}`);
    } finally {
      run.orderInFlight = false;
      if (runAlive(run) && state.autoPhase === 'submitting') state.autoPhase = 'checking';
      renderAutoStatus();
    }
  }

  async function limitedReleaseRequest(run, path, body, options = {}) {
    const { priority = 0, ...requestOptions } = options;
    const releasePermit = () => {
      const highest = run.limitWaiters.reduce((best, waiter, index, waiters) =>
        waiter.priority > (waiters[best]?.priority ?? -1) ? index : best, 0);
      const next = run.limitWaiters.splice(highest, 1)[0];
      if (next) next.resolve(true);
      else run.limitActive -= 1;
    };
    let granted;
    if (run.limitActive < 2 && !run.limitWaiters.length) {
      run.limitActive += 1;
      granted = true;
    } else {
      granted = await new Promise((resolve) => run.limitWaiters.push({ resolve, priority }));
    }
    if (!granted || run.controller.signal.aborted) {
      if (granted) releasePermit();
      throw new ApiError('请求已取消。', 0, 'cancel');
    }
    try {
      const pause = Math.max(0, run.ratePauseUntil - currentReleaseNow());
      if (pause) await sleepForRun(run, pause);
      if (!runAlive(run) || currentReleaseNow() >= run.deadlineAt) {
        throw new ApiError('请求已取消。', 0, 'cancel');
      }
      return await request(path, body, { ...requestOptions, signal: run.controller.signal, timeoutMs: RELEASE_QUERY_TIMEOUT_MS });
    } finally {
      releasePermit();
    }
  }

  async function pollReleaseVenue(run, venue) {
    let dateId = '';
    let rateDelay = 2000;
    let transientDelay = RELEASE_RETRY_MS;
    while (runAlive(run) && currentReleaseNow() < run.deadlineAt) {
      if (run.orderInFlight) { await sleepForRun(run, 200); continue; }
      try {
        if (!dateId) {
          const dates = await limitedReleaseRequest(run, DATE_URL, {
            id: venue.venueId, feildType: venue.fieldType, date: todayInShanghai(),
          }, { onResponse: updateClockOffset });
          if (!Array.isArray(dates)) throw new Error('日期数据格式不符。');
          dateId = String(dates.find((item) => item.date === run.targetDate)?.dateId || '');
          if (dateId) {
            run.seenDate = true;
            if (!run.orderInFlight) {
              state.autoPhase = 'checking';
              state.autoMessage = `已取得 ${run.targetDate} 的日期标识，正在查询场次。`;
            }
            logAuto(`${venue.name}：新日期已开放。`);
          }
        }
        if (dateId && runAlive(run)) {
          const fields = await limitedReleaseRequest(run, SITUATION_URL, {
            fieldType: venue.fieldType, date: run.targetDate,
            venueId: venue.venueId, dateId,
          }, { priority: 1 });
          const options = matchingOptions(run, venue, fields, dateId);
          if (!options.length && !run.orderInFlight) {
            state.autoPhase = 'checking';
            state.autoMessage = `${venue.name} 已查询，暂无符合条件的可订场次。`;
            renderAutoStatus();
          }
          if (options.length) {
            logAuto(`${venue.name}：发现 ${options.length} 个可订候选。`);
            offerAutoOptions(run, options);
          }
        }
        rateDelay = 2000;
        transientDelay = RELEASE_RETRY_MS;
        if (runAlive(run) && currentReleaseNow() < run.deadlineAt) {
          await sleepForRun(run, retryDelay(RELEASE_RETRY_MS));
        }
      } catch (error) {
        if (!runAlive(run) || error.kind === 'cancel') return;
        if (error.kind === 'auth') {
          recordAutoError(error, `${venue.name} 查询`);
          finishAuto(run, 'failed', '登录已失效，自动抢场已停止。');
          return;
        }
        if (/验证码|安全验证|滑块/i.test(error.message)) {
          recordAutoError(error, `${venue.name} 查询`);
          finishAuto(run, 'failed', '原站要求安全验证，请在原站手动处理。');
          return;
        }
        logAuto(`${venue.name} 查询失败：${error.message}`);
        if (!run.orderInFlight) {
          state.autoPhase = 'query_failed';
          state.autoMessage = `${venue.name} 查询失败：${error.message}`;
          renderAutoStatus();
        }
        if (error.kind === 'rate') {
          const waitMs = retryDelay(rateDelay);
          recordAutoError(error, `${venue.name} 查询`, waitMs);
          run.ratePauseUntil = Math.max(run.ratePauseUntil, currentReleaseNow() + waitMs);
          await sleepForRun(run, waitMs);
          rateDelay = Math.min(rateDelay * 2, 8000);
        } else {
          if (error.kind === 'api') dateId = '';
          if (['timeout', 'server', 'http'].includes(error.kind)) {
            transientDelay = Math.min(transientDelay * 2, 8000);
            const waitMs = retryDelay(transientDelay);
            recordAutoError(error, `${venue.name} 查询`, waitMs);
            await sleepForRun(run, waitMs);
          } else {
            const waitMs = retryDelay(RELEASE_RETRY_MS);
            recordAutoError(error, `${venue.name} 查询`, waitMs);
            await sleepForRun(run, waitMs);
          }
        }
      }
    }
  }

  async function runRelease(run) {
    if (!runAlive(run)) return;
    if (currentReleaseNow() >= run.deadlineAt) {
      finishAuto(run, 'failed', `当前时间已超过本次 ${run.windowMinutes} 分钟尝试截止时间。`);
      return;
    }
    state.autoPhase = 'date_pending';
    state.autoMessage = `12:00 已到，正在等待 ${run.targetDate} 的日期标识。`;
    logAuto(state.autoMessage);
    const venues = [...new Set(run.candidates.map((candidate) => candidate.venueKey))]
      .map((key) => VENUES.find((venue) => venue.key === key));
    await Promise.allSettled(venues.map((venue) => pollReleaseVenue(run, venue)));
    if (run.drainPromise) await run.drainPromise;
    if (!runAlive(run)) return;
    finishAuto(run, 'failed', run.seenDate
      ? `本次 ${run.windowMinutes} 分钟尝试结束，没有成功创建订单。`
      : `本次 ${run.windowMinutes} 分钟尝试结束，服务器仍未返回目标日期。`);
  }

  async function recheckBeforeRelease(run) {
    const venue = VENUES.find((item) => item.key === run.candidates[0].venueKey);
    try {
      await request(DATE_URL, {
        id: venue.venueId, feildType: venue.fieldType, date: todayInShanghai(),
      }, { signal: run.controller.signal, timeoutMs: RELEASE_QUERY_TIMEOUT_MS, onResponse: updateClockOffset });
      logAuto('放号前登录状态复查通过。');
    } catch (error) {
      if (error.kind === 'auth') finishAuto(run, 'failed', '放号前登录状态已失效，请重新登录。');
      else if (error.kind !== 'cancel') logAuto(`放号前复查失败，12:00 仍会再试：${error.message}`);
      recordAutoError(error, '放号前复查');
    }
  }

  function tickAuto(run) {
    if (state.autoRun !== run || state.autoPhase !== 'waiting') return;
    const remaining = run.releaseAt - currentReleaseNow();
    if (remaining <= 0) {
      clearInterval(run.tickTimer);
      void runRelease(run);
      return;
    }
    if (remaining <= 30000 && !run.recheckStarted) {
      run.recheckStarted = true;
      void recheckBeforeRelease(run);
    }
    renderAutoStatus();
  }

  async function armAuto() {
    if (autoActive()) return;
    if (!state.candidates.length) {
      state.autoMessage = '请先添加至少一个候选场次。';
      renderAutoStatus();
      return;
    }
    const schedule = nextRelease(Date.now(), state.clockOffsetMs);
    const windowMinutes = state.windowMinutes;
    const run = {
      ...schedule, id: crypto.randomUUID(), windowMinutes,
      candidates: state.candidates.map((item) => ({ ...item })),
      deadlineAt: releaseDeadline(schedule.releaseAt, windowMinutes),
      controller: new AbortController(), catalogs: new Map(), failedOptions: new Set(),
      optionQueue: new Map(), orderInFlight: false, postStarted: false, drainPromise: null,
      limitActive: 0, limitWaiters: [], ratePauseUntil: 0,
      seenDate: false, recheckStarted: false, tickTimer: null,
    };
    state.autoRun = run;
    state.autoPhase = 'preflight';
    state.autoLog = [];
    state.autoErrors = [];
    state.autoErrorCount = 0;
    state.autoMessage = '正在预检登录、场地和网页公钥…';
    logAuto(`目标：${run.releaseDate} 12:00 放号，预约 ${run.targetDate}；最多持续 ${run.windowMinutes} 分钟，共 ${run.candidates.length} 个候选。`);
    render();
    try {
      await preflightAuto(run);
      if (state.autoRun !== run || run.controller.signal.aborted) return;
      if (currentReleaseNow() >= run.deadlineAt) {
        finishAuto(run, 'failed', '预检结束时已超过本次尝试截止时间，请下次提前启动。');
        return;
      }
      state.autoPhase = 'waiting';
      state.autoMessage = `预检通过，等待 ${run.releaseDate} 12:00。`;
      logAuto(state.autoMessage);
      run.tickTimer = setInterval(() => tickAuto(run), 250);
      tickAuto(run);
      render();
    } catch (error) {
      if (!state.autoErrorCount) recordAutoError(error, '预检');
      finishAuto(run, 'failed', `预检失败：${error.message}`);
    }
  }

  const host = node('div');
  host.id = 'sjtu-noon-booking-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      button, select, input { font: inherit; }
      #launcher { position: fixed; left: 20px; bottom: 88px; width: 58px; height: 58px; border: 0; border-radius: 18px; background: #15466b; color: #fff; font-size: 27px; box-shadow: 0 8px 28px #19344966; cursor: pointer; pointer-events: auto; }
      #panel { position: fixed; left: 20px; bottom: 156px; width: min(520px, calc(100vw - 24px)); max-height: min(850px, calc(100vh - 173px)); display: flex; flex-direction: column; border-radius: 16px; border: 1px solid #b4ced7; background: #f7fbfd; color: #183b4a; box-shadow: 0 20px 60px #17354755; overflow: hidden; pointer-events: auto; font: 13px/1.45 system-ui, -apple-system, 'Microsoft YaHei', sans-serif; }
      [hidden] { display: none !important; }
      #head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 13px 15px; background: #15466b; color: #fff; }
      h2 { margin: 0; font-size: 17px; }
      #head small { opacity: .8; }
      #close { border: 0; background: transparent; color: #fff; font-size: 22px; cursor: pointer; }
      #body { padding: 14px 15px 18px; overflow-y: auto; }
      h3 { margin: 12px 0 7px; font-size: 13px; }
      select { width: 100%; padding: 8px; border: 1px solid #b6ced4; border-radius: 8px; background: #fff; color: inherit; }
      input[type="number"] { width: 82px; padding: 8px; border: 1px solid #b6ced4; border-radius: 8px; background: #fff; color: inherit; }
      .actions { display: flex; gap: 7px; margin: 12px 0; }
      button.action { padding: 9px 11px; border: 0; border-radius: 8px; background: #0a7185; color: #fff; font-weight: 700; cursor: pointer; }
      button.action:disabled { opacity: .5; cursor: default; }
      button.secondary { background: #e4eff2; color: #255363; }
      .hint { color: #607d88; font-size: 11px; }
      .auto-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .auto-grid label { display: grid; gap: 3px; min-width: 0; }
      .auto-grid .wide { grid-column: 1 / -1; }
      .candidate { display: flex; align-items: center; gap: 5px; border: 1px solid #d3e1e6; border-radius: 8px; background: #fff; padding: 6px; margin: 5px 0; }
      .candidate span { flex: 1; overflow-wrap: anywhere; }
      .candidate button { border: 0; border-radius: 5px; background: #e4eff2; color: #255363; cursor: pointer; padding: 4px 6px; }
      .candidate button:disabled { opacity: .4; cursor: default; }
      #auto-target, #auto-status { padding: 8px; border-radius: 8px; background: #e6f1f5; margin: 7px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      #auto-log { max-height: 120px; overflow-y: auto; white-space: pre-wrap; color: #476473; background: #f0f5f6; border-radius: 7px; padding: 6px; font-size: 11px; }
      #auto-errors { max-height: 180px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: #843c26; background: #fff3ed; border-radius: 7px; padding: 8px; font-size: 11px; }
      #arm-confirm { position: fixed; inset: 0; display: grid; place-items: center; background: #112d3c99; pointer-events: auto; font: 14px/1.5 system-ui, 'Microsoft YaHei', sans-serif; }
      #arm-confirm-box { width: min(420px, calc(100vw - 28px)); padding: 18px; border-radius: 14px; background: #fff; color: #173b49; box-shadow: 0 20px 60px #0005; }
      #arm-confirm-box h2 { margin-bottom: 9px; }
      #arm-confirm-text { white-space: pre-line; overflow-wrap: anywhere; }
      @media (max-width: 520px) { #launcher { left: 12px; bottom: 80px; } #panel { left: 12px; bottom: 148px; max-height: calc(100vh - 160px); } }
    </style>
    <button id="launcher" type="button" aria-label="打开12:00 定时抢场" title="12:00 定时抢场">🕛</button>
    <section id="panel" role="dialog" aria-label="12:00 定时抢场" hidden>
      <div id="head"><div><h2>12:00 定时抢场</h2><small>按候选顺序争取一个未付款订单</small></div><button id="close" type="button" aria-label="关闭">×</button></div>
      <div id="body">
        <h3>按优先级添加候选</h3>
          <div id="auto-target"></div>
          <label>放号后最多尝试 <input id="release-window" type="number" min="1" max="15" step="1" aria-label="放号后尝试分钟数"> 分钟（1–15，默认 5）</label>
          <div class="auto-grid">
            <label>运动类型<select id="auto-sport" aria-label="候选运动类型"></select></label>
            <label>场馆<select id="auto-venue" aria-label="候选场馆"></select></label>
            <label>场地<select id="auto-field" aria-label="候选场地"><option value="">任意场地</option></select></label>
            <label>一小时时段<select id="auto-time" aria-label="候选时段"></select></label>
          </div>
          <div id="auto-field-hint" class="hint">选择场馆后可读取具体场地；也可使用“任意场地”。</div>
          <div class="actions"><button id="load-fields" class="action secondary" type="button">读取场地</button><button id="add-candidate" class="action" type="button">添加候选</button></div>
          <div id="candidates"></div>
          <div class="actions"><button id="auto-arm" class="action" type="button">启动本次抢场</button><button id="auto-stop" class="action secondary" type="button" hidden>停止</button></div>
          <div id="auto-status" role="status"></div>
          <p class="hint">启动后在设定时长内尝试创建最多一个未付款订单；请保持本页面打开并尽量置于前台。浏览器休眠可能延迟执行。</p>
          <h3>报错详情（<span id="auto-error-count">0</span>）</h3>
          <div id="auto-errors" aria-label="抢场报错详情"></div>
          <h3>时间线</h3>
          <div id="auto-log" aria-label="抢场时间线"></div>
      </div>
    </section>
    <div id="arm-confirm" role="dialog" aria-modal="true" aria-label="确认启动定时抢场" hidden><div id="arm-confirm-box">
      <h2>确认启动自动抢场</h2><div id="arm-confirm-text"></div>
      <div class="actions"><button id="arm-cancel" class="action secondary" type="button">取消</button><button id="arm-submit" class="action" type="button">授权自动提交一单</button></div>
    </div></div>`;
  const $ = (selector) => root.querySelector(selector);
  const elements = {
    launcher: $('#launcher'), panel: $('#panel'), close: $('#close'),
    autoSport: $('#auto-sport'),
    autoVenue: $('#auto-venue'), autoField: $('#auto-field'), autoTime: $('#auto-time'),
    autoFieldHint: $('#auto-field-hint'), loadFields: $('#load-fields'), addCandidate: $('#add-candidate'),
    candidates: $('#candidates'), autoTarget: $('#auto-target'), autoArm: $('#auto-arm'),
    releaseWindow: $('#release-window'),
    autoStop: $('#auto-stop'), autoStatus: $('#auto-status'), autoLog: $('#auto-log'),
    autoErrors: $('#auto-errors'), autoErrorCount: $('#auto-error-count'),
    armConfirm: $('#arm-confirm'), armConfirmText: $('#arm-confirm-text'),
    armCancel: $('#arm-cancel'), armSubmit: $('#arm-submit'),
  };

  elements.autoSport.replaceChildren(...['羽毛球', '健身房', '网球'].map((sport) => {
    const option = node('option', '', sport);
    option.value = sport;
    return option;
  }));
  function renderAutoVenues() {
    const previous = elements.autoVenue.value;
    const venues = VENUES.filter((venue) => venue.type === elements.autoSport.value);
    elements.autoVenue.replaceChildren(...venues.map((venue) => {
      const option = node('option', '', venue.name);
      option.value = venue.key;
      return option;
    }));
    if (venues.some((venue) => venue.key === previous)) elements.autoVenue.value = previous;
    renderCandidateFields();
  }
  renderAutoVenues();
  for (let index = 0; index <= 14; index += 1) {
    const option = node('option', '', slotTime(index));
    option.value = String(index);
    elements.autoTime.appendChild(option);
  }

  function mount() {
    const parent = document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }
  mount();
  new MutationObserver(() => { if (!host.isConnected || host.parentNode !== (document.body || document.documentElement)) mount(); })
    .observe(document.documentElement, { childList: true, subtree: true });

  function renderCandidateFields() {
    const selected = elements.autoField.value;
    const fields = state.fieldCatalog.get(elements.autoVenue.value) || [];
    const any = node('option', '', '任意场地');
    any.value = '';
    elements.autoField.replaceChildren(any, ...fields.map((field) => {
      const option = node('option', '', field.name);
      option.value = field.id;
      return option;
    }));
    elements.autoField.value = fields.some((field) => field.id === selected) ? selected : '';
  }

  function renderCandidateList() {
    const rows = state.candidates.map((candidate, index) => {
      const row = node('div', 'candidate');
      row.append(node('span', '', `${index + 1}. ${candidateLabel(candidate)}`));
      for (const [label, shift] of [['↑', -1], ['↓', 1]]) {
        const button = node('button', '', label);
        button.type = 'button';
        button.title = shift < 0 ? '提高优先级' : '降低优先级';
        button.disabled = autoActive() || index + shift < 0 || index + shift >= state.candidates.length;
        button.addEventListener('click', () => {
          const [item] = state.candidates.splice(index, 1);
          state.candidates.splice(index + shift, 0, item);
          saveSettings(); renderCandidateList(); renderAutoStatus();
        });
        row.append(button);
      }
      const remove = node('button', '', '删除');
      remove.type = 'button';
      remove.disabled = autoActive();
      remove.addEventListener('click', () => {
        state.candidates.splice(index, 1);
        saveSettings(); renderCandidateList(); renderAutoStatus();
      });
      row.append(remove);
      return row;
    });
    elements.candidates.replaceChildren(...(rows.length ? rows : [node('p', 'hint', '尚未添加候选场次。')]));
  }

  function renderAutoStatus() {
    const run = state.autoRun;
    const plan = run && autoActive() ? run : nextRelease(Date.now(), state.clockOffsetMs);
    const deadlineAt = run && autoActive() ? run.deadlineAt : releaseDeadline(plan.releaseAt, state.windowMinutes);
    const deadlineText = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(deadlineAt));
    const preview = `${plan.releaseDate} 12:00 放号 → ${plan.targetDate} 场地 · 最晚 ${deadlineText}`;
    const remaining = run && state.autoPhase === 'waiting'
      ? Math.max(0, Math.ceil((run.releaseAt - currentReleaseNow()) / 1000)) : null;
    const countdown = remaining === null ? ''
      : ` · 倒计时 ${Math.floor(remaining / 3600)}:${String(Math.floor(remaining % 3600 / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    elements.autoTarget.textContent = `${preview}${countdown}`;
    const names = {
      idle: '未启动', preflight: '预检中', waiting: '等待放号', date_pending: '日期未开放',
      checking: '查询可订场次', query_failed: '查询失败', available: '可订',
      submitting: '提交中', success: '成功', unknown: '结果未知',
      failed: '已停止', stopped: '已停止',
    };
    elements.autoStatus.textContent = `${names[state.autoPhase]}：${state.autoMessage}\n时钟：${state.clockSource}`;
    elements.autoErrorCount.textContent = String(state.autoErrorCount);
    elements.autoErrors.textContent = state.autoErrors.slice(-12).join('\n') || '暂无报错。';
    elements.autoLog.textContent = state.autoLog.slice(-16).join('\n') || '启动后显示关键事件。';
    const locked = (() => {
      try {
        const manual = readManualAttempt(plan.targetDate);
        return readAttemptRecord()?.releaseDate === plan.releaseDate
          || Boolean(manual && ['sending', 'unknown', 'success'].includes(manual.stage));
      }
      catch (_) { return false; }
    })();
    elements.autoArm.disabled = autoActive() || !state.candidates.length || locked;
    elements.autoArm.title = locked ? '本次放号已有下单尝试记录，请先核对原站订单。' : '';
    if (root.activeElement !== elements.releaseWindow) elements.releaseWindow.value = String(state.windowMinutes);
    elements.releaseWindow.disabled = autoActive();
    elements.autoStop.hidden = !autoActive();
    elements.autoStop.disabled = Boolean(run?.postStarted);
    for (const control of [elements.autoVenue, elements.autoField, elements.autoTime, elements.loadFields, elements.addCandidate]) {
      control.disabled = autoActive() || state.candidateLoading;
    }
    elements.autoSport.disabled = autoActive() || state.candidateLoading;
    elements.armConfirm.hidden = !state.armConfirmOpen;
  }

  function render() {
    elements.panel.hidden = !state.open;
    renderCandidateList();
    renderAutoStatus();
  }

  elements.launcher.addEventListener('click', () => { state.open = !state.open; render(); });
  elements.close.addEventListener('click', () => { state.open = false; render(); });
  elements.autoSport.addEventListener('change', () => {
    renderAutoVenues();
    elements.autoFieldHint.textContent = '可选择“任意场地”，或点击“读取场地”。';
  });
  elements.autoVenue.addEventListener('change', () => {
    renderCandidateFields();
    elements.autoFieldHint.textContent = state.fieldCatalog.has(elements.autoVenue.value)
      ? '已显示读取过的具体场地。' : '可选择“任意场地”，或点击“读取场地”。';
  });
  elements.releaseWindow.addEventListener('change', () => {
    if (autoActive()) return;
    state.windowMinutes = releaseWindowMinutes(elements.releaseWindow.value);
    saveSettings();
    renderAutoStatus();
  });
  elements.loadFields.addEventListener('click', () => { void loadCandidateFields(); });
  elements.addCandidate.addEventListener('click', () => {
    if (autoActive() || state.candidates.length >= 30) return;
    const venueKey = elements.autoVenue.value;
    const fieldId = elements.autoField.value;
    const index = Number(elements.autoTime.value);
    const fieldName = fieldId ? elements.autoField.selectedOptions[0]?.textContent || fieldId : '';
    const candidate = { venueKey, fieldId, fieldName, index };
    if (!knownKeys.has(venueKey) || !Number.isInteger(index) || index < 0 || index > 14) return;
    if (state.candidates.some((item) => candidateId(item) === candidateId(candidate))) {
      state.autoMessage = '这个候选场次已经添加。'; renderAutoStatus(); return;
    }
    state.candidates.push(candidate);
    saveSettings(); renderCandidateList(); renderAutoStatus();
  });
  elements.autoArm.addEventListener('click', () => {
    if (autoActive() || !state.candidates.length) return;
    const plan = nextRelease(Date.now(), state.clockOffsetMs);
    elements.armConfirmText.textContent = `${plan.releaseDate} 12:00 开始，目标日期 ${plan.targetDate}，放号后最多尝试 ${state.windowMinutes} 分钟。\n\n按返回速度尝试以下候选（同批结果按优先级）：\n${state.candidates.map((item, index) => `${index + 1}. ${candidateLabel(item)}`).join('\n')}\n\n启动后可自动提交最多一个未付款订单，不会付款。`;
    state.armConfirmOpen = true;
    renderAutoStatus();
  });
  elements.armCancel.addEventListener('click', () => { state.armConfirmOpen = false; renderAutoStatus(); });
  elements.armSubmit.addEventListener('click', () => {
    if (!state.armConfirmOpen) return;
    state.armConfirmOpen = false;
    void armAuto();
  });
  elements.autoStop.addEventListener('click', stopAuto);
  window.addEventListener('focus', () => { if (state.autoRun) tickAuto(state.autoRun); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRun) tickAuto(state.autoRun);
  });
  window.addEventListener('storage', (event) => {
    if (!state.autoRun || !autoActive()) return;
    try {
      if (event.key === `${MANUAL_ATTEMPT_PREFIX}${state.autoRun.targetDate}`) {
        const manual = JSON.parse(event.newValue);
        if (manual && ['sending', 'unknown', 'success'].includes(manual.stage) && !state.autoRun.postStarted) {
          finishAuto(state.autoRun, 'failed', '另一标签页已手动下单，本页已停止。');
        }
        return;
      }
      if (event.key !== ATTEMPT_KEY) return;
      const record = JSON.parse(event.newValue);
      if (record?.releaseDate === state.autoRun.releaseDate && record.owner !== state.autoRun.id
        && !state.autoRun.orderInFlight) {
        finishAuto(state.autoRun, 'failed', '另一标签页已开始下单，本页已停止。');
      }
    } catch (_) { /* The lock still guards order submission. */ }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.armConfirmOpen) {
      state.armConfirmOpen = false; renderAutoStatus();
    }
  });
  renderCandidateFields();
  render();
})();
