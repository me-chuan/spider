// ==UserScript==
// @name         SJTU Venue Monitor (Browser)
// @namespace    https://sports.sjtu.edu.cn/
// @version      1.0.0
// @description  Monitor SJTU venue availability in-page without manual cookie copy/paste.
// @author       you
// @match        https://sports.sjtu.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DATE_ID_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldReserveSituationIsFull";
  const VENUE_API_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldSituation";

  const POLL_INTERVAL_MS = 180000;
  const CHECK_INTERVAL_MS = 1000;
  const ALERT_BANNER_DURATION_MS = 25000;

  const TIME_SLOTS = Array.from({ length: 15 }, (_, i) => {
    const h = i + 7;
    return `${String(h).padStart(2, "0")}:00-${String(h + 1).padStart(2, "0")}:00`;
  });

  const INTERESTING_VENUES = [];
  const INTERESTING_HOURS = [];

  const TARGET_CONFIGS = [
    {
      name: "Huxiaoming tennis court",
      type: "Tennis",
      venueId: "0c6edc93-87ac-41b0-9895-6b66fda93fe5",
      fieldType: "19f69e5c-872f-4fbb-b9fe-70d6337c2d93",
    },
    {
      name: "Eastern district tennis court",
      type: "Tennis",
      venueId: "3466293b-a7d8-45be-a918-8526e3bed4c5",
      fieldType: "4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76",
    },
    {
      name: "Student Center Gym",
      type: "Gym",
      venueId: "d784ad7c-cb24-4282-afd6-a67aec68c675",
      fieldType: "7d46c0a4-3ae6-4398-822b-d4b7b37085fa",
    },
    {
      name: "Zijin Street Gym",
      type: "Gym",
      venueId: "768214ba-3b1c-4f29-ad00-15c0e376b000",
      fieldType: "0a349309-1734-4507-98bd-4c30bf33c6bc",
    },
    {
      name: "Huoyingdong Gym",
      type: "Gym",
      venueId: "9096787a-bc53-430a-9405-57dc46bc9e83",
      fieldType: "b3dce013-3a0e-45e0-a0c2-425a364ac90f",
    },
    {
      name: "Huoyingdong Badminton Court",
      type: "Badminton",
      venueId: "9096787a-bc53-430a-9405-57dc46bc9e83",
      fieldType: "49629b20-71fb-4bae-8675-fdae0831e861",
    },
    {
      name: "Air Center Badminton Court",
      type: "Badminton",
      venueId: "3b10ff47-7e83-4c21-816c-5edc257168c1",
      fieldType: "29942202-d2ac-448e-90b7-14d3c6be19ff",
    },
  ];

  const CACHE_KEY = "sjtu-monitor-date-id-cache-v1";
  const STATE_KEY = "sjtu-monitor-enabled";
  const TYPES_KEY = "sjtu-monitor-selected-types-v1";
  const ALL_SPORT_TYPES = [...new Set(TARGET_CONFIGS.map((cfg) => String(cfg.type || "Other")))];

  const state = {
    enabled: true,
    cycleNo: 0,
    availableNow: [],
    lastAvailSig: "",
    lastChangeAt: null,
    errorLines: [],
    currentCheck: null,
    recentLines: [],
    alertUntilTs: 0,
    lastAlertSig: "",
    sleepLeftSec: null,
    lastNotifiedAt: 0,
    panel: null,
    selectedTypes: new Set(ALL_SPORT_TYPES),
    monitorRunId: 0,
  };

  function nowTime() {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
  }

  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function pairsFromSlots(slots) {
    return [...new Set(slots.map((s) => `${s.top_venue_name || "?"} | ${s.date || "?"}`))].sort();
  }

  function availabilitySignature(slots) {
    const keys = slots.map((s) => [
      String(s.top_venue_name || ""),
      String(s.venue || ""),
      String(s.date || ""),
      String(s.time || ""),
    ]);
    keys.sort((a, b) => a.join("|").localeCompare(b.join("|")));
    return JSON.stringify(keys);
  }

  function pushError(line) {
    state.errorLines.push(line);
    if (state.errorLines.length > 100) {
      state.errorLines.splice(0, state.errorLines.length - 100);
    }
  }

  function getActiveTargetConfigs() {
    return TARGET_CONFIGS.filter((cfg) => state.selectedTypes.has(String(cfg.type || "Other")));
  }

  function saveSelectedTypes() {
    GM_setValue(TYPES_KEY, [...state.selectedTypes]);
  }

  function loadSelectedTypes() {
    const raw = GM_getValue(TYPES_KEY, null);
    if (!Array.isArray(raw) || !raw.length) {
      state.selectedTypes = new Set(ALL_SPORT_TYPES);
      return;
    }
    const allowed = new Set(ALL_SPORT_TYPES);
    const picked = raw.filter((t) => allowed.has(String(t)));
    state.selectedTypes = new Set(picked.length ? picked : ALL_SPORT_TYPES);
  }

  function makePanel() {
    if (state.panel) return state.panel;
    const wrap = document.createElement("div");
    wrap.id = "sjtu-venue-monitor-panel";
    wrap.style.cssText = [
      "position:fixed",
      "right:12px",
      "top:12px",
      "width:420px",
      "max-height:80vh",
      "overflow:auto",
      "z-index:2147483647",
      "background:rgba(17,17,17,0.95)",
      "color:#f5f5f5",
      "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace",
      "border:1px solid #3a3a3a",
      "border-radius:8px",
      "box-shadow:0 8px 30px rgba(0,0,0,.35)",
      "padding:10px",
      "white-space:pre-wrap",
    ].join(";");
    document.body.appendChild(wrap);
    state.panel = wrap;
    return wrap;
  }

  function renderPanel(totalChecks = 0) {
    const panel = makePanel();
    const now = new Date();
    const pairs = pairsFromSlots(state.availableNow);
    const availText = pairs.length ? pairs.slice(0, 200).join("\n") : "(none)";
    const taskText = state.recentLines.length ? state.recentLines.slice(-25).join("\n") : "(none)";
    const errText = state.errorLines.length ? state.errorLines.slice(-10).join("\n") : "(none)";
    const showBanner = state.availableNow.length > 0 && Date.now() < state.alertUntilTs;
    const typeButtons = ALL_SPORT_TYPES.map((type) => {
      const active = state.selectedTypes.has(type);
      return `<button class="sjtu-monitor-type-btn" data-type="${escapeHtml(type)}" style="font:inherit;padding:2px 8px;border-radius:999px;border:1px solid ${
        active ? "#66bb6a" : "#555"
      };background:${active ? "#1b5e20" : "#333"};color:#fff;cursor:pointer;">${escapeHtml(type)}</button>`;
    }).join(" ");
    const banner = showBanner
      ? `<div style="margin:8px 0;padding:6px 8px;background:#ffd54f;color:#212121;border-radius:4px;font-weight:700;">SPARE VENUES FOUND!\n${escapeHtml(
          pairs.slice(0, 4).join("\n")
        )}</div>`
      : "";

    panel.innerHTML = [
      `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">`,
      `<strong>SJTU Venue Monitor</strong>`,
      `<button id="sjtu-monitor-toggle" style="font:inherit;padding:2px 8px;border-radius:4px;border:1px solid #555;background:${
        state.enabled ? "#2e7d32" : "#555"
      };color:#fff;cursor:pointer;">${state.enabled ? "Running" : "Paused"}</button>`,
      `</div>`,
      `<div>now=${escapeHtml(now.toLocaleString("sv-SE").replace("T", " "))} | cycle=${state.cycleNo} | checks=${totalChecks}</div>`,
      `<div style="margin-top:6px"><strong>Types:</strong> ${typeButtons}</div>`,
      banner,
      `<div>Checking: ${escapeHtml(state.currentCheck || "(idle)")}</div>`,
      `<div>Last availability change: ${escapeHtml(state.lastChangeAt || "(none)")}</div>`,
      `<div>Next poll in: ${state.sleepLeftSec == null ? "(running)" : `${state.sleepLeftSec}s`}</div>`,
      `<hr style="border:none;border-top:1px solid #333;margin:8px 0">`,
      `<div><strong>AVAILABLE NOW (court + date)</strong></div>`,
      `<div>${escapeHtml(availText)}</div>`,
      `<hr style="border:none;border-top:1px solid #333;margin:8px 0">`,
      `<div><strong>TASK OUTPUT</strong></div>`,
      `<div>${escapeHtml(taskText)}</div>`,
      `<hr style="border:none;border-top:1px solid #333;margin:8px 0">`,
      `<div><strong>ERRORS</strong></div>`,
      `<div>${escapeHtml(errText)}</div>`,
    ].join("");

    const btn = panel.querySelector("#sjtu-monitor-toggle");
    if (btn) {
      btn.onclick = async () => {
        state.enabled = !state.enabled;
        GM_setValue(STATE_KEY, state.enabled);
        renderPanel(totalChecks);
        if (state.enabled) {
          requestMonitorRestart();
        } else {
          state.monitorRunId += 1;
        }
      };
    }

    for (const typeBtn of panel.querySelectorAll(".sjtu-monitor-type-btn")) {
      typeBtn.onclick = () => {
        const type = typeBtn.getAttribute("data-type");
        if (!type) return;
        if (state.selectedTypes.has(type)) {
          if (state.selectedTypes.size === 1) {
            return;
          }
          state.selectedTypes.delete(type);
        } else {
          state.selectedTypes.add(type);
        }
        saveSelectedTypes();
        renderPanel(totalChecks);
        if (state.enabled) {
          requestMonitorRestart();
        }
      };
    }
  }

  function requestMonitorRestart() {
    state.monitorRunId += 1;
    const runId = state.monitorRunId;
    runMonitorLoop(runId).catch((err) => {
      if (runId !== state.monitorRunId) {
        return;
      }
      pushError(`[${nowTime()}] Fatal: ${String(err)}`);
      renderPanel(0);
    });
  }

  function isRunActive(runId) {
    return state.enabled && runId === state.monitorRunId;
  }

  function alertUser(message) {
    try {
      GM_notification({
        title: "SJTU Venue Monitor",
        text: message,
        timeout: 5000,
      });
    } catch (_) {
      // ignore
    }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 1000;
      gain.gain.value = 0.02;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (_) {
      // ignore
    }
  }

  async function postJson(url, payload) {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    return resp.json();
  }

  async function fetchDateIds(venueId, fieldType, baseDate) {
    const data = await postJson(DATE_ID_URL, {
      id: venueId,
      feildType: fieldType,
      date: baseDate,
    });
    const result = {};
    for (const item of data?.data || []) {
      if (item?.date && item?.dateId) {
        result[String(item.date)] = String(item.dateId);
      }
    }
    return result;
  }

  function buildFieldSituationPayload(venueId, fieldType, date, dateId) {
    return {
      fieldType,
      date,
      venueId,
      dateId,
    };
  }

  async function loadCache() {
    const raw = GM_getValue(CACHE_KEY, null);
    if (!raw || typeof raw !== "object") {
      return { cache_date: null, version: 1, by_venue: {} };
    }
    if (!raw.by_venue || typeof raw.by_venue !== "object") {
      raw.by_venue = {};
    }
    return raw;
  }

  async function saveCache(cache) {
    GM_setValue(CACHE_KEY, cache);
  }

  async function getOrRefreshDateIdMap(cfg, cache, today) {
    const venueEntry = cache.by_venue?.[cfg.venueId] || {};
    const cachedFieldType = venueEntry.fieldType;
    const cachedMap = venueEntry.date_id_map;
    const cachedRefreshedDate = venueEntry.refreshed_date;

    if (
      cachedRefreshedDate === today &&
      cachedFieldType === cfg.fieldType &&
      cachedMap &&
      typeof cachedMap === "object" &&
      Object.keys(cachedMap).length > 0
    ) {
      return cachedMap;
    }

    const dateIdMap = await fetchDateIds(cfg.venueId, cfg.fieldType, today);
    if (Object.keys(dateIdMap).length > 0) {
      cache.by_venue[cfg.venueId] = {
        name: cfg.name,
        fieldType: cfg.fieldType,
        date_id_map: dateIdMap,
        refreshed_date: today,
        refreshed_at: new Date().toISOString(),
      };
    }
    return dateIdMap;
  }

  async function prepareMonitoringTasks(targetConfigs) {
    const allTasks = [];
    const today = todayStr();
    const cache = await loadCache();
    cache.by_venue = cache.by_venue || {};

    for (const cfg of targetConfigs) {
      state.recentLines = [`[${nowTime()}] Preparing: ${cfg.name}`];
      renderPanel(allTasks.length);

      const dateIdMap = await getOrRefreshDateIdMap(cfg, cache, today);
      const entries = Object.entries(dateIdMap);
      if (entries.length === 0) {
        pushError(`[${nowTime()}] Could not fetch dates for ${cfg.name}`);
        continue;
      }

      for (const [targetDate, dateId] of entries) {
        allTasks.push({
          top_venue_name: cfg.name,
          top_venue_id: cfg.venueId,
          target_date: targetDate,
          payload: buildFieldSituationPayload(cfg.venueId, cfg.fieldType, targetDate, dateId),
        });
      }
    }

    cache.cache_date = today;
    cache.last_written_at = new Date().toISOString();
    await saveCache(cache);
    return allTasks;
  }

  function parseSlotsFromJson(jsonData) {
    const slots = [];
    if (!jsonData || jsonData.code !== 0) {
      return slots;
    }
    for (const field of jsonData.data || []) {
      const fieldName = field?.fieldNameEn || field?.fieldName || "UNKNOWN";
      const fieldId = field?.fieldId || "";
      const priceList = field?.priceList || [];

      for (let idx = 0; idx < priceList.length; idx += 1) {
        const item = priceList[idx] || {};
        const countInt = Number.parseInt(item.count, 10) || 0;
        slots.push({
          venue: fieldName,
          venue_id: fieldId,
          time: TIME_SLOTS[idx] || `slot_${idx}`,
          slot_index: idx,
          count: countInt,
          price: item.price,
          status: String(item.status || ""),
          raw: item,
        });
      }
    }
    return slots;
  }

  function filterSlots(slots) {
    const available = slots.filter((s) => Number(s.count || 0) !== 0);
    if (!INTERESTING_VENUES.length && !INTERESTING_HOURS.length) {
      return available;
    }
    return available.filter((s) => {
      if (INTERESTING_VENUES.length && !INTERESTING_VENUES.includes(s.venue)) return false;
      if (INTERESTING_HOURS.length && !INTERESTING_HOURS.includes(s.time)) return false;
      return true;
    });
  }

  async function fetchRawResponse(payload) {
    const resp = await fetch(VENUE_API_URL, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new Error(`Unexpected Content-Type: ${ct}`);
    }
    return resp.json();
  }

  function maybeAlert(currentAvailable) {
    if (!currentAvailable.length) return;
    const sig = availabilitySignature(currentAvailable);
    if (sig === state.lastAlertSig) return;
    state.lastAlertSig = sig;
    state.alertUntilTs = Date.now() + ALERT_BANNER_DURATION_MS;
    alertUser("Spare venues found.");
  }

  async function runMonitorLoop(runId) {
    if (!isRunActive(runId)) return;

    const monitoringTasks = await prepareMonitoringTasks(getActiveTargetConfigs());
    if (!monitoringTasks.length) {
      pushError(`[${nowTime()}] No tasks to monitor.`);
      renderPanel(0);
      return;
    }

    while (isRunActive(runId)) {
      state.cycleNo += 1;
      state.availableNow = [];
      state.lastAvailSig = "";
      state.alertUntilTs = 0;
      state.lastAlertSig = "";
      state.sleepLeftSec = null;
      state.currentCheck = null;
      state.recentLines = [];

      const allSlotsForCycle = [];
      renderPanel(monitoringTasks.length);

      for (let idx = 0; idx < monitoringTasks.length; idx += 1) {
        if (!isRunActive(runId)) break;
        const task = monitoringTasks[idx];
        state.currentCheck = `${idx + 1}/${monitoringTasks.length} ${task.top_venue_name} on ${task.target_date}`;
        state.recentLines = [`[${nowTime()}] Fetching...`];
        renderPanel(monitoringTasks.length);

        try {
          const data = await fetchRawResponse(task.payload);
          const serverCode = data?.code;
          if (serverCode != null && serverCode !== 0) {
            const msg = `[${nowTime()}] Server error: code=${serverCode} msg=${data?.msg || ""} msgEn=${data?.msgEn || ""}`.trim();
            state.recentLines.push(msg);
            pushError(msg);

            if (Date.now() - state.lastNotifiedAt > 120000) {
              alertUser(`Server error: ${data?.msg || serverCode}`);
              state.lastNotifiedAt = Date.now();
            }
          }

          const slots = parseSlotsFromJson(data);
          for (const s of slots) {
            s.top_venue_name = task.top_venue_name;
            s.top_venue_id = task.top_venue_id;
            s.date = task.target_date;
          }
          allSlotsForCycle.push(...slots);

          const availForTask = filterSlots(slots);
          if (availForTask.length) {
            state.recentLines.push(`[${nowTime()}] Available: ${task.top_venue_name} | ${task.target_date}`);
            state.availableNow.push(...availForTask);
            const sigNow = availabilitySignature(state.availableNow);
            if (sigNow !== state.lastAvailSig) {
              state.lastAvailSig = sigNow;
              state.lastChangeAt = new Date().toLocaleString("sv-SE").replace("T", " ");
            }
            maybeAlert(state.availableNow);
          } else {
            state.recentLines.push(`[${nowTime()}] No availability.`);
          }
        } catch (err) {
          const msg = `[${nowTime()}] Error: ${String(err)}`;
          state.recentLines.push(msg);
          pushError(msg);
        }

        renderPanel(monitoringTasks.length);
        await sleep(CHECK_INTERVAL_MS);
      }

      const nowAvailable = filterSlots(allSlotsForCycle);
      const sig = availabilitySignature(nowAvailable);
      if (sig !== state.lastAvailSig) {
        state.lastAvailSig = sig;
        state.availableNow = nowAvailable;
        state.lastChangeAt = new Date().toLocaleString("sv-SE").replace("T", " ");
      }

      state.currentCheck = null;
      state.recentLines = [];
      state.sleepLeftSec = Math.floor(POLL_INTERVAL_MS / 1000);
      renderPanel(monitoringTasks.length);

      while (isRunActive(runId) && state.sleepLeftSec > 0) {
        await sleep(1000);
        state.sleepLeftSec -= 1;
        renderPanel(monitoringTasks.length);
      }
    }
  }

  async function init() {
    state.enabled = GM_getValue(STATE_KEY, true);
    loadSelectedTypes();
    GM_registerMenuCommand("Toggle monitor", async () => {
      state.enabled = !state.enabled;
      GM_setValue(STATE_KEY, state.enabled);
      renderPanel(0);
      if (state.enabled) {
        requestMonitorRestart();
      } else {
        state.monitorRunId += 1;
      }
    });

    renderPanel(0);
    if (state.enabled) {
      requestMonitorRestart();
    }
  }

  init().catch((err) => {
    pushError(`[${nowTime()}] Init failed: ${String(err)}`);
    renderPanel(0);
  });
})();
