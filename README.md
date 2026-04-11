# SJTU Sports Venue Monitor (Terminal UI)

A small Python script that polls SJTU Sports venue availability and shows a continuously auto-refreshing terminal dashboard.

## Features

- Auto-refreshing terminal UI (no scrolling logs)
- Monitors multiple venues/dates in a loop
- Caches `dateId` mapping in `date_id_cache.json` to reduce daily API calls
- Attention-catching alert when availability is found:
  - terminal bell (`\a`)
  - highlighted banner inside the UI

## Requirements

- Linux/macOS/Windows with Python **3.10+** (recommended: 3.11/3.12)
- Python dependency: `requests`

Install dependency:

```bash
pip install requests
```

## Setup

1. Configure targets and request headers/cookies in `config.py`:
   - `TARGET_CONFIGS`: list of venues you want to monitor
   - `HEADERS` / `COOKIES`: used for the SJTU Sports API requests

2. (Optional) Adjust polling interval in `monitor.py`:

- `POLL_INTERVAL` (seconds)

## Usage

Run the monitor:

```bash
python main.py
```

## Tampermonkey version (no cookie copy/paste)

If you prefer browser-side monitoring that reuses your current login session automatically, import `sjtu_venue_monitor.user.js` into Tampermonkey.

1. Install Tampermonkey in your browser.
2. Create a new script and paste the content of `sjtu_venue_monitor.user.js` (or use Tampermonkey import).
3. Open and keep any `https://sports.sjtu.edu.cn/*` page logged in.
4. The script will poll in the page, show an overlay panel, and alert on availability changes.

Customize `TARGET_CONFIGS`, `POLL_INTERVAL_MS`, `INTERESTING_VENUES`, and `INTERESTING_HOURS` directly in the userscript.

### Filter by venue type

If your `TARGET_CONFIGS` items include a `type` field (case-insensitive) such as `tennis`, `badminton`, `gym`, you can filter what gets monitored:

```bash
python main.py --tennis
python main.py --badminton
python main.py --gym
```

You can also combine them:

```bash
python main.py --tennis --gym
```

If you specify a filter but nothing matches, the program will exit with `No tasks to monitor. Exiting.`

## Reading the UI

The dashboard shows:

- current time, cycle number, and total checks
- which task is currently being checked
- **AVAILABLE NOW (court + date)**: a live list of currently available venues (deduped)
- **TASK OUTPUT**: per-task recent status lines

When spare venues are found, you should see:

- a terminal bell sound (if your terminal supports it)
- a highlighted banner near the top of the UI containing the first few available `(court | date)` pairs

## Files

- `main.py`: CLI entrypoint and target selection
- `monitor.py`: polling logic + terminal UI
- `config.py`: your targets + headers/cookies
- `date_id_cache.json`: daily cache generated/updated by the program
- `sjtu_venue_monitor.user.js`: Tampermonkey userscript version (browser session-based, no manual cookie copy)

## Notes / Troubleshooting

- **No bell sound?**
  - Some terminals disable the audible bell; you may need to enable it in terminal settings.
- **Requests failing / empty results?**
  - Double-check `HEADERS` and `COOKIES` in `config.py`.
- **Too noisy / too slow?**
  - Tune `POLL_INTERVAL` and/or reduce `TARGET_CONFIGS`.

## Disclaimer

This project is for personal monitoring convenience. Please use responsibly and avoid excessive polling.
