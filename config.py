TARGET_CONFIGS = [
    {
        "name": "Huxiaoming tennis court",
        "type": "tennis",
        "venueId": "0c6edc93-87ac-41b0-9895-6b66fda93fe5", # the unique ID (may have changed)
        "fieldType": "19f69e5c-872f-4fbb-b9fe-70d6337c2d93", # can be obtained dynamically
    },
    {
        "name": "Eastern district tennis court",
        "type": "tennis",
        "venueId":"3466293b-a7d8-45be-a918-8526e3bed4c5",
        "fieldType":"4dd7ae28-cf27-4369-9bc4-ee75b8e3cc76",
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

COOKIES = {
    "_ga": "GA1.1.1974817216.1753965581",
    "_ga_VGHWLGCC9B": "GS2.1.s1753965580$o1$g1$t1753965998$j56$l0$h0",
    "JSESSIONID": "f137098e-0b96-4909-8dea-ef90dfb35e2f"
}