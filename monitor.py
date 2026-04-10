import requests
import time
from datetime import datetime
from typing import List, Dict, Any, Tuple
# from bs4 import BeautifulSoup  # uncomment if you need HTML parsing

# ========= 1. CONFIG – YOU FILL THESE IN =========

# URL that returns the venue/slot data (from DevTools → Network)
VENUE_API_URL = "https://sports.sjtu.edu.cn/manage/fieldDetail/queryFieldSituation"


TARGET_CONFIGS = [
    {
        "name": "Huxiaoming tennis court",
        "venue_id": "0c6edc93-87ac-41b0-9895-6b66fda93fe5",
        "payload": {
            "fieldType": "19f69e5c-872f-4fbb-b9fe-70d6337c2d93",  # 网球
            "date": "2026-04-12",  # target date
            "venueId": "0c6edc93-87ac-41b0-9895-6b66fda93fe5",   # this specific tennis venue
            "dateId": "0drGPm8tcFtAKjfJ+Qa7wnIwRs0YPXAUTXlyWzHam4Y=",  # opaque, copied as-is
        }
    },
    {
        "name": "Eastern district tennis court",
        "venue_id": "3466293b-a7d8-45be-a918-8526e3bed4c5",
        "payload": {
            "fieldType":"4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76",
            "date":"2026-04-12",
            "venueId":"3466293b-a7d8-45be-a918-8526e3bed4c5",
            "dateId":"0drGPm8tcFtAKjfJ+Qa7wod3a2NI40C2dHZQsT4sZHo="
        }
    }
]


# Headers copied from your browser for that request
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Content-Type": "application/json;charset=utf-8",
    "Origin": "https://sports.sjtu.edu.cn",
    "Referer": "https://sports.sjtu.edu.cn/pc/",
}

# Cookies copied from your logged-in browser
COOKIES = {
    "_ga": "GA1.1.1974817216.1753965581",
    "_ga_VGHWLGCC9B": "GS2.1.s1753965580$o1$g1$t1753965998$j56$l0$h0",
    "JSESSIONID": "f137098e-0b96-4909-8dea-ef90dfb35e2f"
}

# How often to check (seconds)
POLL_INTERVAL = 60

# Time mapping for the 15 slots (07:00-08:00 to 21:00-22:00)
TIME_SLOTS = [f"{h:02d}:00-{h+1:02d}:00" for h in range(7, 22)]

# Optional simple filter: only these venues/times are interesting
INTERESTING_VENUES = []  # e.g. ["Main Gym", "Court 1"]
INTERESTING_HOURS = []   # e.g. ["19:00", "20:00"]


# ========= 2. FETCHING =========

def fetch_raw_response(payload: Dict[str, Any]) -> requests.Response:
    """Perform the HTTP POST to the venue API/page."""
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
    available = [s for s in slots if s.get("count", 0) == 1]

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


# ========= 5. NOTIFICATION (simple for now) =========

def format_all_slots(slots: List[Dict[str, Any]]) -> str:
    """
    Format ALL slots grouped by venue, listing each slot index, count, price, status.
    """
    # Group by venue
    by_venue: Dict[str, List[Dict[str, Any]]] = {}
    for s in slots:
        by_venue.setdefault(s["venue"], []).append(s)

    lines: List[str] = []
    for venue, v_slots in by_venue.items():
        lines.append(f"Venue: {venue}")
        # sort by slot_index
        v_slots = sorted(v_slots, key=lambda x: x["slot_index"])
        for s in v_slots:
            idx = s["slot_index"]
            count = s["count"]
            price = s["price"]
            status = s["status"]
            time_str = s["time"]
            flag = "AVAILABLE" if count == 1 else ""
            lines.append(f"  {time_str}: count={count}, price={price}, status={status} {flag}")
        lines.append("")  # blank line between venues
    return "\n".join(lines)


def format_available_slots(slots: List[Dict[str, Any]]) -> str:
    """
    Format only available slots (for notification).
    """
    if not slots:
        return "No available slots."

    lines = []
    for s in slots:
        #print(s)
        lines.append(
            f'Court={s["top_venue_name"]} {s["time"]} '
            f'(count={s["count"]}, price={s["price"]}, status={s["status"]})'
        )
    return "\n".join(lines)


def notify(slots: List[Dict[str, Any]]) -> None:
    """
    For now, just print to stdout (only the newly found available slots).
    """
    print("=== NEWLY AVAILABLE SLOTS ===")
    print(format_available_slots(slots))
    print("=============================")


# ========= 6. MAIN LOOP =========

def main_loop():
    print(f"[{datetime.now()}] Starting venue monitor...")
    last_seen: set[Tuple[str, str]] = set()  # (venue, time) to avoid duplicate spam

    while True:
        try:
            all_slots_for_cycle = []
            print(f"\n[{datetime.now()}] --- STARTING NEW POLL CYCLE ---")

            for config in TARGET_CONFIGS:
                print(f"--- Checking: {config['name']} ---")
                resp = fetch_raw_response(config["payload"])

                # Decide JSON vs HTML
                content_type = resp.headers.get("Content-Type", "")
                if "application/json" in content_type:
                    data = resp.json()
                    all_slots = parse_slots_from_json(data)

                    for s in all_slots:
                        s["top_venue_name"] = config["name"]
                        s["top_venue_id"] = config["venue_id"]

                    all_slots_for_cycle.extend(all_slots)
                    print(format_all_slots(all_slots))
                else:
                    print(f"Unexpected Content-Type for {config['name']}: {content_type}")

            interesting_and_available = filter_slots(all_slots_for_cycle)

            # Deduplicate by (venue, time) across runs so you don’t get spam
            new_slots: List[Dict[str, Any]] = []
            for s in interesting_and_available:
                key = (s["venue"], s["time"])
                if key not in last_seen:
                    last_seen.add(key)
                    new_slots.append(s)

            if new_slots:
                notify(new_slots)
            else:
                print(f"[{datetime.now()}] No new available slots found.")

        except Exception as e:
            print(f"[{datetime.now()}] Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main_loop()