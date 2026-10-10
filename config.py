import json
import os
from pathlib import Path


TARGET_CONFIGS = [
    {
        "name": "Huxiaoming tennis court",
        "type": "Tennis",
        "venueId": "0c6edc93-87ac-41b0-9895-6b66fda93fe5", # the unique ID (may have changed)
        "fieldType": "19f69e5c-872f-4fbb-b9fe-70d6337c2d93", # can be obtained dynamically
    },
    {
        "name": "Eastern district tennis court",
        "type": "Tennis",
        "venueId":"3466293b-a7d8-45be-a918-8526e3bed4c5",
        "fieldType":"4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76",
    },
    {
        "name": "Student Center Gym",
        "type": "Gym",
        "venueId":"d784ad7c-cb24-4282-afd6-a67aec68c675",
        "fieldType":"7d46c0a4-3ae6-4398-822b-d4b7b37085fa",
    },
    {
        "name": "Zijin Street Gym",
        "type": "Gym",
        "venueId":"768214ba-3b1c-4f29-ad00-15c0e376b000",
        "fieldType":"0a349309-1734-4507-98bd-4c30bf33c6bc",
    },
    {
        "name": "Huoyingdong Gym",
        "type": "Gym",
        "venueId":"9096787a-bc53-430a-9405-57dc46bc9e83",
        "fieldType":"b3dce013-3a0e-45e0-a0c2-425a364ac90f",
    },
    {
        "name": "Huoyingdong Badminton Court",
        "type": "Badminton",
        "venueId":"9096787a-bc53-430a-9405-57dc46bc9e83",
        "fieldType":"49629b20-71fb-4bae-8675-fdae0831e861",
    },
    {
        "name": "Air Center Badminton Court",
        "type": "Badminton",
        "venueId":"3b10ff47-7e83-4c21-816c-5edc257168c1",
        "fieldType":"29942202-d2ac-448e-90b7-14d3c6be19ff",
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

COOKIE_FILE_PATH = Path(__file__).with_name("cookies.json")


def _parse_cookie_header(header: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for part in header.split(";"):
        part = part.strip()
        if not part:
            continue
        name, separator, value = part.partition("=")
        if not separator or not name.strip():
            raise ValueError("Cookie must contain name=value pairs separated by semicolons")
        cookies[name.strip()] = value.strip()
    return cookies


def load_cookies() -> dict[str, str]:
    """Use the local JSON file first; environment settings remain a fallback."""
    if COOKIE_FILE_PATH.exists():
        try:
            with COOKIE_FILE_PATH.open("r", encoding="utf-8") as file:
                data = json.load(file)
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"{COOKIE_FILE_PATH} is not readable valid JSON: {exc}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("cookie_header"), str):
            raise ValueError(f"{COOKIE_FILE_PATH} must contain a string named cookie_header")
        return _parse_cookie_header(data["cookie_header"])

    # A copied Request Headers > Cookie value is authoritative over older env settings.
    header = os.environ.get("SJTU_COOKIE_HEADER", "").strip()
    if header:
        return _parse_cookie_header(header)

    raw = os.environ.get("SJTU_COOKIES_JSON")
    cookies: dict[str, str] = {}
    if raw:
        try:
            cookies = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("SJTU_COOKIES_JSON is invalid JSON; clear it or set SJTU_COOKIE_HEADER") from exc
        if not isinstance(cookies, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in cookies.items()
        ):
            raise ValueError("SJTU_COOKIES_JSON must be a JSON object of string values")

    session_id = os.environ.get("SJTU_JSESSIONID", "").strip()
    if session_id:
        cookies["JSESSIONID"] = session_id
    return cookies


COOKIES = load_cookies()
