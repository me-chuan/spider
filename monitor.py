"""Poll SJTU Sports and show the state of each check in a terminal dashboard."""

import json
import os
import time
from datetime import datetime
from typing import Any

import requests

from config import COOKIES, HEADERS, TARGET_CONFIGS


DATE_ID_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldReserveSituationIsFull"
VENUE_API_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldSituation"
POLL_INTERVAL = 180  # Idle time after a complete scan, in seconds.
CHECK_INTERVAL = 1  # Minimum pause between field requests.
TIME_SLOTS = [f"{hour:02d}:00-{hour + 1:02d}:00" for hour in range(7, 22)]
INTERESTING_VENUES: list[str] = []
INTERESTING_HOURS: list[str] = []
CACHE_VERSION = 2
DATE_ID_CACHE_PATH = os.path.join(os.path.dirname(__file__), "date_id_cache.json")


class AuthenticationError(ValueError):
    """The venue API rejected the supplied login session."""


def _login_error_message(exc: AuthenticationError) -> str:
    return (
        f"登录态无效或已过期：{exc}\n"
        "请在浏览器重新登录，复制 sports.sjtu.edu.cn 场地接口请求实际发送的整段 Cookie，"
        "填入 cookies.json 的 cookie_header 后重启。仅有 _ga Cookie 通常不够。"
    )


def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _empty_cache() -> dict[str, Any]:
    return {"version": CACHE_VERSION, "by_target": {}}


def load_date_id_cache() -> dict[str, Any]:
    try:
        with open(DATE_ID_CACHE_PATH, "r", encoding="utf-8") as file:
            cache = json.load(file)
        if (
            not isinstance(cache, dict)
            or cache.get("version") != CACHE_VERSION
            or not isinstance(cache.get("by_target"), dict)
        ):
            return _empty_cache()
        return cache
    except FileNotFoundError:
        return _empty_cache()
    except (OSError, ValueError) as exc:
        print(f"Warning: could not load dateId cache: {exc}")
        return _empty_cache()


def save_date_id_cache(cache: dict[str, Any]) -> None:
    """Replace the cache atomically so an interrupted write cannot corrupt it."""
    temporary_path = DATE_ID_CACHE_PATH + ".tmp"
    with open(temporary_path, "w", encoding="utf-8") as file:
        json.dump(cache, file, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(temporary_path, DATE_ID_CACHE_PATH)


def _cache_key(venue_id: str, field_type: str) -> str:
    return f"{venue_id}|{field_type}"


def get_or_refresh_date_id_map(
    cfg: dict[str, Any], cache: dict[str, Any], today: str
) -> dict[str, str]:
    key = _cache_key(cfg["venueId"], cfg["fieldType"])
    entry = cache["by_target"].get(key, {})
    cached_map = entry.get("date_id_map")
    if entry.get("cache_date") == today and isinstance(cached_map, dict) and cached_map:
        return {str(date): str(date_id) for date, date_id in cached_map.items() if date and date_id}

    date_id_map = fetch_date_ids(cfg["venueId"], cfg["fieldType"], today)
    if date_id_map:
        cache["by_target"][key] = {
            "name": cfg["name"],
            "cache_date": today,
            "date_id_map": date_id_map,
            "refreshed_at": datetime.now().isoformat(timespec="seconds"),
        }
    return date_id_map


def refresh_all_date_ids_for_today() -> None:
    """Force-refresh every configured target's date IDs and save successful results."""
    today = _today_str()
    cache = load_date_id_cache()
    updated = 0
    errors: list[str] = []

    for cfg in TARGET_CONFIGS:
        try:
            date_id_map = fetch_date_ids(cfg["venueId"], cfg["fieldType"], today)
            if not date_id_map:
                errors.append(f"{cfg['name']}: no dates returned")
                continue
            cache["by_target"][_cache_key(cfg["venueId"], cfg["fieldType"])] = {
                "name": cfg["name"],
                "cache_date": today,
                "date_id_map": date_id_map,
                "refreshed_at": datetime.now().isoformat(timespec="seconds"),
            }
            updated += 1
        except AuthenticationError as exc:
            raise SystemExit(_login_error_message(exc)) from None
        except Exception as exc:
            errors.append(f"{cfg['name']}: {exc}")

    if updated:
        save_date_id_cache(cache)
    print(f"Date IDs refreshed for {updated}/{len(TARGET_CONFIGS)} targets.")
    for error in errors:
        print(f"- {error}")


def fetch_with_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(url, headers=HEADERS, cookies=COOKIES, json=payload, timeout=15)
    if getattr(response, "status_code", None) == 401:
        raise AuthenticationError("HTTP 401")
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("API response is not a JSON object")
    return data


def _response_items(data: dict[str, Any]) -> list[dict[str, Any]]:
    if str(data.get("code")) == "401":
        raise AuthenticationError(f"API error 401: {data.get('msg', '未登录或登录超时')}")
    if data.get("code") != 0:
        raise ValueError(f"API error {data.get('code')}: {data.get('msg', 'unknown error')}")
    items = data.get("data")
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ValueError("API response has no valid data list")
    return items


def fetch_date_ids(venue_id: str, field_type: str, base_date: str) -> dict[str, str]:
    # The endpoint really spells this field "feildType".
    payload = {"id": venue_id, "feildType": field_type, "date": base_date}
    items = _response_items(fetch_with_json(DATE_ID_URL, payload))
    return {
        str(item["date"]): str(item["dateId"])
        for item in items
        if item.get("date") and item.get("dateId")
    }


def build_field_situation_payload(
    venue_id: str, field_type: str, date: str, date_id: str
) -> dict[str, str]:
    return {"fieldType": field_type, "date": date, "venueId": venue_id, "dateId": date_id}


def fetch_raw_response(payload: dict[str, Any]) -> requests.Response:
    response = requests.post(
        VENUE_API_URL, headers=HEADERS, cookies=COOKIES, json=payload, timeout=15
    )
    if getattr(response, "status_code", None) == 401:
        raise AuthenticationError("HTTP 401")
    response.raise_for_status()
    return response


def parse_slots_from_json(json_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Parse every field and time slot; invalid API responses are check failures."""
    slots: list[dict[str, Any]] = []
    for field in _response_items(json_data):
        field_name = field.get("fieldNameEn") or field.get("fieldName") or "UNKNOWN"
        price_list = field.get("priceList")
        if not isinstance(price_list, list):
            raise ValueError("API field has no valid priceList")
        for index, item in enumerate(price_list):
            if not isinstance(item, dict):
                raise ValueError("API priceList contains an invalid slot")
            try:
                count = int(item["count"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("API slot has no valid availability count") from exc
            slots.append(
                {
                    "venue": field_name,
                    "venue_id": field.get("fieldId"),
                    "time": TIME_SLOTS[index] if index < len(TIME_SLOTS) else f"slot_{index}",
                    "slot_index": index,
                    "count": count,
                    "price": item.get("price"),
                    "status": str(item.get("status", "")),
                }
            )
    return slots


def filter_slots(slots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    available = [slot for slot in slots if slot["count"] > 0]
    if INTERESTING_VENUES:
        available = [slot for slot in available if slot["venue"] in INTERESTING_VENUES]
    if INTERESTING_HOURS:
        available = [slot for slot in available if slot["time"] in INTERESTING_HOURS]
    return available


def _prepare_monitoring_tasks_core(
    target_configs: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    tasks: list[dict[str, Any]] = []
    errors: list[str] = []
    today = _today_str()
    cache = load_date_id_cache()
    changed = False

    for cfg in target_configs:
        try:
            key = _cache_key(cfg["venueId"], cfg["fieldType"])
            before = cache["by_target"].get(key)
            date_id_map = get_or_refresh_date_id_map(cfg, cache, today)
            changed |= cache["by_target"].get(key) != before
            if not date_id_map:
                errors.append(f"{cfg['name']}: no dates returned; will retry")
                continue
            for target_date, date_id in date_id_map.items():
                tasks.append(
                    {
                        "key": f"{key}|{target_date}",
                        "top_venue_name": cfg["name"],
                        "top_venue_id": cfg["venueId"],
                        "target_date": target_date,
                        "payload": build_field_situation_payload(
                            cfg["venueId"], cfg["fieldType"], target_date, date_id
                        ),
                    }
                )
        except AuthenticationError:
            raise
        except Exception as exc:
            errors.append(f"{cfg.get('name', 'Unknown venue')}: {exc}")

    if changed:
        try:
            save_date_id_cache(cache)
        except OSError as exc:
            errors.append(f"Could not save dateId cache: {exc}")
    return tasks, errors


def prepare_monitoring_tasks() -> list[dict[str, Any]]:
    return _prepare_monitoring_tasks_core(TARGET_CONFIGS)[0]


def prepare_monitoring_tasks_for(target_configs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return _prepare_monitoring_tasks_core(target_configs)[0]


def _slot_key(slot: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(slot["top_venue_id"]),
        str(slot["venue_id"] or slot["venue"]),
        str(slot["date"]),
        str(slot["time"]),
    )


def _record_available_slots(
    task_key: str,
    available: list[dict[str, Any]],
    known_available: dict[str, dict[tuple[str, str, str, str], int]],
) -> tuple[list[dict[str, Any]], bool]:
    """Remember successful checks; failures leave the last known state intact."""
    current = {_slot_key(slot): slot["count"] for slot in available}
    previous = known_available.get(task_key)
    new_slots = [slot for slot in available if _slot_key(slot) not in (previous or {})]
    changed = previous != current and (previous is not None or bool(current))
    known_available[task_key] = current
    return new_slots, changed


def _clear_screen() -> None:
    print("\033[2J\033[H", end="")


def _terminal_bell() -> None:
    print("\a", end="", flush=True)


def _render_status_panel(
    *,
    cycle_no: int,
    total_checks: int,
    tasks: list[dict[str, Any]],
    results: dict[str, dict[str, Any]],
    current_check: str | None,
    last_change_at: datetime | None,
    sleep_left: int | None,
    recent_errors: list[str],
    preparation_errors: list[str],
    alert_banner: str | None,
) -> None:
    _clear_screen()
    now = datetime.now()
    counts = {status: 0 for status in ("pending", "available", "unavailable", "error")}
    for result in results.values():
        counts[result["status"]] += 1

    print(f"SJTU Venue Monitor | {now:%Y-%m-%d %H:%M:%S} | cycle {cycle_no} | checks {total_checks}")
    print("=" * 78)
    print(
        f"Pending {counts['pending']}  Available {counts['available']}  "
        f"No availability {counts['unavailable']}  Failed {counts['error']}"
    )
    print(f"Checking: {current_check or '(idle)'}")
    print(f"Last confirmed availability change: {last_change_at:%Y-%m-%d %H:%M:%S}" if last_change_at else "Last confirmed availability change: (none)")
    print(f"Next scan after: {sleep_left}s idle" if sleep_left is not None else "Next scan after: (running)")

    if alert_banner:
        print(f"\n\033[1;7m {alert_banner} \033[0m")

    available = [slot for result in results.values() for slot in result["slots"]]
    print("\nAVAILABLE SLOTS")
    print("---------------")
    if available:
        for slot in sorted(available, key=lambda item: (item["date"], item["time"], item["top_venue_name"], item["venue"]))[:30]:
            print(
                f"- {slot['top_venue_name']} / {slot['venue']} | {slot['date']} "
                f"{slot['time']} | {slot['count']} left | checked {slot['checked_at']}"
            )
        if len(available) > 30:
            print(f"... and {len(available) - 30} more available slots")
    elif counts["pending"]:
        print(f"No availability confirmed yet; {counts['pending']} checks pending.")
    elif counts["error"] or preparation_errors:
        print("No availability confirmed; some checks or date preparations failed (result unknown).")
    else:
        print("None: all checks completed successfully.")

    print("\nCHECK STATUS (priority order; first 15)")
    print("---------------------------------------")
    if not tasks:
        print("No tasks prepared; retrying after the idle interval.")
    priority = {"error": 0, "available": 1, "pending": 2, "unavailable": 3}
    ordered = sorted(tasks, key=lambda task: priority[results[task["key"]]["status"]])
    for task in ordered[:15]:
        result = results[task["key"]]
        detail = f" | {result['detail']}" if result["detail"] else ""
        checked = f" | checked {result['checked_at']}" if result["checked_at"] else ""
        print(f"- {result['status'].upper():11} {task['top_venue_name']} | {task['target_date']}{checked}{detail}")
    if len(ordered) > 15:
        print(f"... {len(ordered) - 15} more; see summary above")

    if preparation_errors:
        print("\nPREPARATION FAILED (will retry)")
        for error in preparation_errors[:5]:
            print(f"- {error}")
        if len(preparation_errors) > 5:
            print(f"... and {len(preparation_errors) - 5} more")
    if recent_errors:
        print("\nRECENT ERRORS (history)")
        for error in recent_errors[-5:]:
            print(f"- {error}")


def _new_results(tasks: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        task["key"]: {"status": "pending", "slots": [], "checked_at": None, "detail": ""}
        for task in tasks
    }


def _fetch_available_slots(task: dict[str, Any]) -> list[dict[str, Any]]:
    response = fetch_raw_response(task["payload"])
    content_type = response.headers.get("Content-Type", "").lower()
    if "json" not in content_type:
        raise ValueError(f"Unexpected Content-Type: {content_type or '(missing)'}")
    slots = filter_slots(parse_slots_from_json(response.json()))
    checked_at = datetime.now().strftime("%H:%M:%S")
    for slot in slots:
        slot.update(
            top_venue_name=task["top_venue_name"],
            top_venue_id=task["top_venue_id"],
            date=task["target_date"],
            checked_at=checked_at,
        )
    return slots


def main_loop(target_configs: list[dict[str, Any]] | None = None) -> None:
    targets = TARGET_CONFIGS if target_configs is None else target_configs
    if not targets:
        print("No tasks to monitor. Exiting.")
        return
    if not COOKIES:
        raise SystemExit("No cookie configured. Fill in cookie_header in cookies.json.")

    tasks: list[dict[str, Any]] = []
    preparation_errors: list[str] = []
    prepared_day: str | None = None
    known_available: dict[str, dict[tuple[str, str, str, str], int]] = {}
    last_change_at: datetime | None = None
    recent_errors: list[str] = []
    total_checks = 0
    cycle_no = 0

    while True:
        today = _today_str()
        if prepared_day != today or preparation_errors:
            try:
                tasks, preparation_errors = _prepare_monitoring_tasks_core(targets)
            except AuthenticationError as exc:
                raise SystemExit(_login_error_message(exc)) from None
            prepared_day = today
            current_keys = {task["key"] for task in tasks}
            known_available = {
                key: value for key, value in known_available.items() if key in current_keys
            }

        cycle_no += 1
        results = _new_results(tasks)
        alert_until = 0.0
        alert_banner: str | None = None

        def render(current_check: str | None = None, sleep_left: int | None = None) -> None:
            _render_status_panel(
                cycle_no=cycle_no,
                total_checks=total_checks,
                tasks=tasks,
                results=results,
                current_check=current_check,
                last_change_at=last_change_at,
                sleep_left=sleep_left,
                recent_errors=recent_errors,
                preparation_errors=preparation_errors,
                alert_banner=alert_banner if time.time() < alert_until else None,
            )

        render()
        for index, task in enumerate(tasks, start=1):
            label = f"{index}/{len(tasks)} {task['top_venue_name']} | {task['target_date']}"
            render(current_check=label)
            total_checks += 1
            try:
                available = _fetch_available_slots(task)
                new_slots, changed = _record_available_slots(
                    task["key"], available, known_available
                )
                if changed:
                    last_change_at = datetime.now()
                if new_slots:
                    _terminal_bell()
                    alert_banner = f"NEW AVAILABILITY: {len(new_slots)} slot(s) | {task['top_venue_name']} | {task['target_date']}"
                    alert_until = time.time() + 25
                results[task["key"]] = {
                    "status": "available" if available else "unavailable",
                    "slots": available,
                    "checked_at": datetime.now().strftime("%H:%M:%S"),
                    "detail": f"{len(available)} slot(s)" if available else "",
                }
            except AuthenticationError as exc:
                raise SystemExit(_login_error_message(exc)) from None
            except Exception as exc:
                message = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {label}: {exc}"
                recent_errors.append(message)
                del recent_errors[:-100]
                results[task["key"]] = {
                    "status": "error", "slots": [],
                    "checked_at": datetime.now().strftime("%H:%M:%S"), "detail": str(exc)
                }
            render(current_check=label)
            time.sleep(CHECK_INTERVAL)

        render(sleep_left=POLL_INTERVAL)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main_loop()
    except KeyboardInterrupt:
        print("\n监控已停止。")
