import requests
import time
from datetime import datetime
from typing import List, Dict, Any, Tuple
import json
import os

from config import TARGET_CONFIGS, HEADERS, COOKIES

# ========= terminal UI helpers =========

def _clear_screen() -> None:
    # ANSI clear screen + cursor home
    print("\033[2J\033[H", end="")


def _terminal_bell(repeat: int = 1, interval: float = 0.15) -> None:
    """Emit an audible/visible terminal bell (best-effort)."""
    for i in range(max(1, repeat)):
        print("\a", end="", flush=True)
        if i != repeat - 1:
            time.sleep(interval)


def _render_status_panel(
    *,
    cycle_started_at: datetime,
    cycle_no: int,
    total_checks: int,
    current_check: str | None,
    available_now: List[Dict[str, Any]],
    last_change_at: datetime | None,
    sleep_left: int | None,
    recent_lines: List[str] | None = None,
    error_lines: List[str] | None = None,
    alert_banner: str | None = None,
) -> None:
    """Render a compact always-on-top status view."""
    _clear_screen()

    now = datetime.now()
    header = f"SJTU Venue Monitor | now={now:%Y-%m-%d %H:%M:%S} | cycle={cycle_no} | checks={total_checks}"
    print(header)
    print("=" * len(header))

    if alert_banner:
        # Inverse video + bold (best-effort ANSI)
        print(f"\n\033[1;7m {alert_banner} \033[0m\n")

    if current_check:
        print(f"Checking: {current_check}")
    else:
        print("Checking: (idle)")

    if last_change_at:
        print(f"Last availability change: {last_change_at:%Y-%m-%d %H:%M:%S}")
    else:
        print("Last availability change: (none)")

    if sleep_left is not None:
        print(f"Next poll in: {sleep_left}s")
    else:
        print("Next poll in: (running)")

    print("\nAVAILABLE NOW (court + date)")
    print("---------------------------")

    pairs = sorted({(s.get("top_venue_name", "?"), s.get("date", "?")) for s in available_now})
    if not pairs:
        print("(none)")
    else:
        for court, date in pairs[:200]:
            print(f"- {court} | {date}")
        if len(pairs) > 200:
            print(f"... and {len(pairs) - 200} more")

    if recent_lines:
        print("\nTASK OUTPUT")
        print("-----------")
        for line in recent_lines[-25:]:
            print(line)

    # Persistent error area so important problems (like expired cookies)
    # are not immediately cleared by UI refreshes.
    print("\nERRORS")
    print("------")
    if error_lines:
        for line in error_lines[-10:]:
            print(line)
    else:
        print("(none)")


def _availability_signature(slots: List[Dict[str, Any]]) -> Tuple[Tuple[str, str, str, str], ...]:
    """Stable signature for 'currently available' list."""
    keys = []
    for s in slots:
        keys.append((
            str(s.get("top_venue_name")),
            str(s.get("venue")),
            str(s.get("date")),
            str(s.get("time")),
        ))
    return tuple(sorted(set(keys)))

# ========= 1. CONSTANTS / ENDPOINTS =========

VENUE_DETAIL_URL = "https://sports.sjtu.edu.cn/manage/venue/queryVenueById"
DATE_ID_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldReserveSituationIsFull"
VENUE_API_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldSituation"

# How often to check (seconds)
POLL_INTERVAL = 100
CHECK_INTERVAL = 1

# Time mapping for the 15 slots (07:00-08:00 to 21:00-22:00)
TIME_SLOTS = [f"{h:02d}:00-{h+1:02d}:00" for h in range(7, 22)]

# Optional simple filter: only these venues/times are interesting
INTERESTING_VENUES: List[str] = []  # top-level venue names
INTERESTING_HOURS: List[str] = []   # e.g. ["19:00-20:00"]

# Persistent cache for dateId refresh (1 refresh per day)
DATE_ID_CACHE_PATH = os.path.join(os.path.dirname(__file__), "date_id_cache.json")


def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def load_date_id_cache() -> Dict[str, Any]:
    """Load cache JSON from disk. Returns a normalized dict."""
    try:
        if not os.path.exists(DATE_ID_CACHE_PATH):
            return {"cache_date": None, "version": 1, "by_venue": {}}
        with open(DATE_ID_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"cache_date": None, "version": 1, "by_venue": {}}
        data.setdefault("cache_date", None)
        data.setdefault("version", 1)
        data.setdefault("by_venue", {})
        if not isinstance(data["by_venue"], dict):
            data["by_venue"] = {}
        return data
    except Exception as e:
        print(f"[{datetime.now()}] Warning: failed to load dateId cache: {e}. Will refresh.")
        return {"cache_date": None, "version": 1, "by_venue": {}}


def save_date_id_cache(cache: Dict[str, Any]) -> None:
    """Atomically write cache JSON to disk."""
    tmp = DATE_ID_CACHE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, DATE_ID_CACHE_PATH)


def get_or_refresh_date_id_map(cfg: Dict[str, Any], cache: Dict[str, Any], today: str) -> Dict[str, str]:
    """Return date->dateId mapping for a venue+fieldType from cache or by refreshing API."""
    venue_id = cfg["venueId"]
    field_type = cfg["fieldType"]

    venue_entry = cache.get("by_venue", {}).get(venue_id, {})
    cached_field_type = venue_entry.get("fieldType")
    cached_map = venue_entry.get("date_id_map")

    # Cache is valid only if it's for today AND same fieldType AND has a mapping
    if cache.get("cache_date") == today and cached_field_type == field_type and isinstance(cached_map, dict) and cached_map:
        return {str(k): str(v) for k, v in cached_map.items() if k and v}

    # Refresh from API
    date_id_map = fetch_date_ids(venue_id, field_type, today)
    if date_id_map:
        cache.setdefault("by_venue", {})
        cache["by_venue"][venue_id] = {
            "name": cfg.get("name"),
            "fieldType": field_type,
            "date_id_map": date_id_map,
            "refreshed_at": datetime.now().isoformat(timespec="seconds"),
        }
    return date_id_map


# ========= 2. FETCHING HELPERS =========

def fetch_with_json(url: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    resp = requests.post(
        url,
        headers=HEADERS,
        cookies=COOKIES,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_date_ids(venue_id: str, field_type: str, base_date: str) -> Dict[str, str]:
    """Return mapping date -> dateId for the range returned by the API, based on one date query."""
    payload = {
        "id": venue_id,
        "feildType": field_type,
        "date": base_date,
    }
    data = fetch_with_json(DATE_ID_URL, payload)
    result: Dict[str, str] = {}
    for item in data.get("data", []):
        d = item.get("date")
        did = item.get("dateId")
        if d and did:
            result[d] = did
    return result


def build_field_situation_payload(venue_id: str, field_type: str, date: str, date_id: str) -> Dict[str, Any]:
    return {
        "fieldType": field_type,
        "date": date,
        "venueId": venue_id,
        "dateId": date_id,
    }


def fetch_raw_response(payload: Dict[str, Any]) -> requests.Response:
    """Perform the HTTP POST to the venue field situation API."""
    resp = requests.post(
        VENUE_API_URL,
        headers=HEADERS,
        cookies=COOKIES,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    return resp


# ========= 3. PARSING =========

def parse_slots_from_json(json_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Parse SJTU sports JSON, returning ALL slots (not only available ones).
    """
    slots: List[Dict[str, Any]] = []

    if json_data.get("code") != 0:
        print(f"Server returned non-zero code: {json_data.get('code')} {json_data.get('msg')}")
        return slots

    for field in json_data.get("data", []):
        field_name = field.get("fieldNameEn") or field.get("fieldName") or "UNKNOWN"
        field_id = field.get("fieldId")
        price_list = field.get("priceList", [])

        for idx, item in enumerate(price_list):
            raw_count = item.get("count", 0)
            try:
                count_int = int(raw_count)
            except (TypeError, ValueError):
                count_int = 0

            # Map slot index to a human-readable time string
            time_str = TIME_SLOTS[idx] if idx < len(TIME_SLOTS) else f"slot_{idx}"

            slots.append({
                "venue": field_name,
                "venue_id": field_id,
                "time": time_str,
                "slot_index": idx,
                "count": count_int,
                "price": item.get("price"),
                "status": str(item.get("status", "")),
                "raw": item,
            })

    return slots


# ========= 4. FILTERING / DEDUP =========

def filter_slots(slots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Apply simple filters like venue name / hours of day, if configured."""
    # First, get only available slots
    available = [s for s in slots if s.get("count", 0) != 0]

    if not INTERESTING_VENUES and not INTERESTING_HOURS:
        return available

    filtered: List[Dict[str, Any]] = []
    for s in available:
        # Note: INTERESTING_HOURS requires time mapping to be implemented
        if INTERESTING_VENUES and s["venue"] not in INTERESTING_VENUES:
            continue
        if INTERESTING_HOURS and s["time"] not in INTERESTING_HOURS:
            continue
        filtered.append(s)

    return filtered


def _format_available_pairs(slots: List[Dict[str, Any]], limit: int = 12) -> str:
    pairs = sorted({(s.get("top_venue_name", "?"), s.get("date", "?")) for s in slots})
    if not pairs:
        return "(none)"
    head = pairs[:limit]
    more = len(pairs) - len(head)
    lines = [f"{court} | {date}" for court, date in head]
    if more > 0:
        lines.append(f"...and {more} more")
    return "\n".join(lines)


def _build_alert_banner(slots: List[Dict[str, Any]]) -> str:
    # Keep banner readable in terminal: short title + first few pairs.
    body = _format_available_pairs(slots, limit=4)
    return "SPARE VENUES FOUND!\n" + body


# ========= 6. PREPARE TASKS =========

def prepare_monitoring_tasks() -> List[Dict[str, Any]]:
    """
    Runs once to resolve all fieldTypes and dateIds, creating a list of tasks.
    Each task is a dictionary with the payload and metadata needed for a single check.

    Daily refresh optimization:
    - On startup, if the cache file is for today, reuse cached dateId mappings.
    - Otherwise refresh from API and write cache for today.

    Cache update behavior:
    - Even on a cache hit day, if you add new courts (venueId) or change fieldType,
      we will fetch the missing mapping and write it back to the cache file.
    """
    print("--- Preparing all monitoring tasks for the day ---")
    all_tasks = []

    today = _today_str()
    cache = load_date_id_cache()

    cache_is_today = cache.get("cache_date") == today
    if cache_is_today:
        print(f"--- dateId cache hit for {today}. Skipping refresh. ---")
    else:
        print(f"--- dateId cache miss/stale. Refreshing for {today}. ---")
        cache["cache_date"] = today
        cache.setdefault("by_venue", {})

    cache_changed = False

    def _cache_snapshot_for(cfg: Dict[str, Any]) -> Tuple[Any, Any]:
        venue_id = cfg.get("venueId")
        entry = cache.get("by_venue", {}).get(venue_id, {}) if venue_id else {}
        return (entry.get("fieldType"), entry.get("date_id_map"))

    for cfg in TARGET_CONFIGS:
        try:
            print(f"--- Preparing: {cfg['name']} ---")
            field_type = cfg["fieldType"]
            print(f"  Using configured fieldType: {field_type}")

            before = _cache_snapshot_for(cfg)
            date_id_map = get_or_refresh_date_id_map(cfg, cache, today)
            after = _cache_snapshot_for(cfg)
            if after != before:
                cache_changed = True

            if not date_id_map:
                print(f"  Could not fetch any dates for {cfg['name']}")
                continue

            print(f"  Found {len(date_id_map)} dates to check for {cfg['name']}.")

            for target_date, date_id in date_id_map.items():
                payload = build_field_situation_payload(cfg["venueId"], cfg["fieldType"], target_date, date_id)
                task = {
                    "top_venue_name": cfg["name"],
                    "top_venue_id": cfg["venueId"],
                    "target_date": target_date,
                    "payload": payload,
                }
                all_tasks.append(task)
        except Exception as e:
            print(f"  Failed to prepare tasks for {cfg['name']}: {e}")

    # If the day changed OR we fetched any new/changed venue mappings, write cache
    if (not cache_is_today) or cache_changed:
        try:
            cache["cache_date"] = today
            cache["last_written_at"] = datetime.now().isoformat(timespec="seconds")
            save_date_id_cache(cache)
            print(f"--- Wrote dateId cache: {DATE_ID_CACHE_PATH} ---")
        except Exception as e:
            print(f"[{datetime.now()}] Warning: failed to write dateId cache: {e}")

    print(f"--- Preparation complete. Found {len(all_tasks)} total date/venue combinations to monitor. ---")
    return all_tasks


def prepare_monitoring_tasks_for(target_configs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Similar to prepare_monitoring_tasks(), but only for the given subset of target configs.

    Note: this also persists `date_id_cache.json` if it had to fetch any uncached mappings.
    """
    print(f"--- Preparing monitoring tasks for selected venues ---")
    all_tasks = []

    today = _today_str()
    cache = load_date_id_cache()

    cache_changed = False

    def _cache_snapshot_for(cfg: Dict[str, Any]) -> Tuple[Any, Any]:
        venue_id = cfg.get("venueId")
        entry = cache.get("by_venue", {}).get(venue_id, {}) if venue_id else {}
        return (entry.get("fieldType"), entry.get("date_id_map"))

    for cfg in target_configs:
        try:
            print(f"--- Preparing: {cfg['name']} ---")
            field_type = cfg["fieldType"]

            before = _cache_snapshot_for(cfg)
            date_id_map = get_or_refresh_date_id_map(cfg, cache, today)
            after = _cache_snapshot_for(cfg)
            if after != before:
                cache_changed = True

            if not date_id_map:
                print(f"  Could not fetch any dates for {cfg['name']}")
                continue

            print(f"  Found {len(date_id_map)} dates to check for {cfg['name']}.")

            for target_date, date_id in date_id_map.items():
                payload = build_field_situation_payload(cfg["venueId"], cfg["fieldType"], target_date, date_id)
                task = {
                    "top_venue_name": cfg["name"],
                    "top_venue_id": cfg["venueId"],
                    "target_date": target_date,
                    "payload": payload,
                }
                all_tasks.append(task)
        except Exception as e:
            print(f"  Failed to prepare tasks for {cfg['name']}: {e}")

    if cache_changed:
        try:
            cache["cache_date"] = today
            cache["last_written_at"] = datetime.now().isoformat(timespec="seconds")
            save_date_id_cache(cache)
            print(f"--- Wrote dateId cache: {DATE_ID_CACHE_PATH} ---")
        except Exception as e:
            print(f"[{datetime.now()}] Warning: failed to write dateId cache: {e}")

    print(f"--- Preparation complete. Found {len(all_tasks)} total date/venue combinations to monitor. ---")
    return all_tasks


# ========= 7. MAIN LOOP =========

def main_loop(target_configs: List[Dict[str, Any]] | None = None):
    cycle_no = 0

    # Prepare all tasks once at the start.
    monitoring_tasks = prepare_monitoring_tasks() if target_configs is None else prepare_monitoring_tasks_for(target_configs)
    if not monitoring_tasks:
        # With the TUI, we still surface this via stdout because we cannot render a panel without tasks.
        print("No tasks to monitor. Exiting.")
        return

    last_seen: set[Tuple[str, str]] = set()

    # TUI state
    available_now: List[Dict[str, Any]] = []
    last_avail_sig: Tuple[Tuple[str, str, str, str], ...] = tuple()
    last_change_at: datetime | None = None

    # Persistent error log across refreshes
    error_lines: List[str] = []

    # Alert state (sticky for a short time after detection)
    alert_until_ts: float = 0.0
    last_alert_sig: Tuple[Tuple[str, str, str, str], ...] = tuple()

    def _maybe_alert(current_available: List[Dict[str, Any]]) -> None:
        """Best-effort immediate alert when we first observe availability."""
        nonlocal alert_until_ts, last_alert_sig
        if not current_available:
            return
        sig = _availability_signature(current_available)
        if sig == last_alert_sig:
            return
        last_alert_sig = sig
        alert_until_ts = time.time() + 25
        _terminal_bell(repeat=2)

    while True:
        cycle_no += 1
        cycle_started_at = datetime.now()

        # Expire availability from previous cycle so AVAILABLE NOW only shows fresh data
        available_now = []
        last_avail_sig = tuple()

        # Track a panel message for outer-loop failures
        outer_recent_lines: List[str] | None = None

        try:
            all_slots_for_cycle: List[Dict[str, Any]] = []

            banner = _build_alert_banner(available_now) if (available_now and time.time() < alert_until_ts) else None
            _render_status_panel(
                cycle_started_at=cycle_started_at,
                cycle_no=cycle_no,
                total_checks=len(monitoring_tasks),
                current_check=None,
                available_now=available_now,
                last_change_at=last_change_at,
                sleep_left=None,
                recent_lines=None,
                error_lines=error_lines,
                alert_banner=banner,
            )

            for idx, task in enumerate(monitoring_tasks, start=1):
                recent_lines: List[str] = []
                current_label = f"{idx}/{len(monitoring_tasks)} {task['top_venue_name']} on {task['target_date']}"

                try:
                    recent_lines.append(f"[{datetime.now():%H:%M:%S}] Fetching...")

                    banner = _build_alert_banner(available_now) if (available_now and time.time() < alert_until_ts) else None
                    _render_status_panel(
                        cycle_started_at=cycle_started_at,
                        cycle_no=cycle_no,
                        total_checks=len(monitoring_tasks),
                        current_check=current_label,
                        available_now=available_now,
                        last_change_at=last_change_at,
                        sleep_left=None,
                        recent_lines=recent_lines,
                        error_lines=error_lines,
                        alert_banner=banner,
                    )

                    resp = fetch_raw_response(task["payload"])

                    content_type = resp.headers.get("Content-Type", "")
                    if "application/json" in content_type:
                        data = resp.json()
                        slots = parse_slots_from_json(data)

                        for s in slots:
                            s["top_venue_name"] = task["top_venue_name"]
                            s["top_venue_id"] = task["top_venue_id"]
                            s["date"] = task["target_date"]

                        all_slots_for_cycle.extend(slots)

                        avail_for_task = filter_slots(slots)
                        if avail_for_task:
                            # Only show court + date (no venue/time details)
                            recent_lines.append(
                                f"[{datetime.now():%H:%M:%S}] Available: {task['top_venue_name']} | {task['target_date']}"
                            )

                            # Update AVAILABLE NOW immediately
                            available_now.extend(avail_for_task)
                            sig_now = _availability_signature(available_now)
                            if sig_now != last_avail_sig:
                                last_avail_sig = sig_now
                                last_change_at = datetime.now()

                            # Immediate alert as soon as we observe availability (no need to wait for full cycle).
                            _maybe_alert(available_now)

                        else:
                            recent_lines.append(f"[{datetime.now():%H:%M:%S}] No availability.")
                    else:
                        msg = f"[{datetime.now():%H:%M:%S}] Unexpected Content-Type: {content_type}"
                        recent_lines.append(msg)
                        error_lines.append(msg)
                        if len(error_lines) > 100:
                            del error_lines[:-100]

                    banner = _build_alert_banner(available_now) if (available_now and time.time() < alert_until_ts) else None
                    _render_status_panel(
                        cycle_started_at=cycle_started_at,
                        cycle_no=cycle_no,
                        total_checks=len(monitoring_tasks),
                        current_check=current_label,
                        available_now=available_now,
                        last_change_at=last_change_at,
                        sleep_left=None,
                        recent_lines=recent_lines,
                        error_lines=error_lines,
                        alert_banner=banner,
                    )

                    time.sleep(CHECK_INTERVAL)

                except Exception as e:
                    msg = f"[{datetime.now():%H:%M:%S}] Error: {e}"
                    recent_lines.append(msg)
                    error_lines.append(msg)
                    if len(error_lines) > 100:
                        del error_lines[:-100]
                    banner = _build_alert_banner(available_now) if (available_now and time.time() < alert_until_ts) else None
                    _render_status_panel(
                        cycle_started_at=cycle_started_at,
                        cycle_no=cycle_no,
                        total_checks=len(monitoring_tasks),
                        current_check=current_label,
                        available_now=available_now,
                        last_change_at=last_change_at,
                        sleep_left=None,
                        recent_lines=recent_lines,
                        error_lines=error_lines,
                        alert_banner=banner,
                    )
                    time.sleep(1)

            # End-of-cycle aggregation still updates the panel state,
            # but alerts would have already been triggered above.
            now_available = filter_slots(all_slots_for_cycle)
            sig = _availability_signature(now_available)

            if sig != last_avail_sig:
                last_avail_sig = sig
                available_now = now_available
                last_change_at = datetime.now()

            # Keep a "seen" set so the project can re-introduce alerts later if desired.
            for s in now_available:
                key = (s["top_venue_name"], s["venue"], s["date"], s["time"])
                last_seen.add(key)

        except Exception as e:
            msg = f"[{datetime.now():%H:%M:%S}] Cycle error: {e}"
            outer_recent_lines = [msg]
            error_lines.append(msg)
            if len(error_lines) > 100:
                del error_lines[:-100]
            banner = _build_alert_banner(available_now) if (available_now and time.time() < alert_until_ts) else None
            _render_status_panel(
                cycle_started_at=cycle_started_at,
                cycle_no=cycle_no,
                total_checks=len(monitoring_tasks),
                current_check=None,
                available_now=available_now,
                last_change_at=last_change_at,
                sleep_left=None,
                recent_lines=outer_recent_lines,
                error_lines=error_lines,
                alert_banner=banner,
            )
            time.sleep(1)

        # 在等待下一次轮询时，为了减少后台占用，我们不再每秒刷新 TUI，
        # 而是渲染一次状态面板然后整体 sleep POLL_INTERVAL 秒。
        banner = _build_alert_banner(available_now) if (available_now and time.time() < alert_until_ts) else None
        _render_status_panel(
            cycle_started_at=cycle_started_at,
            cycle_no=cycle_no,
            total_checks=len(monitoring_tasks),
            current_check=None,
            available_now=available_now,
            last_change_at=last_change_at,
            sleep_left=POLL_INTERVAL,
            recent_lines=outer_recent_lines,
            error_lines=error_lines,
            alert_banner=banner,
        )
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main_loop()