"""
Fetch this week's US earnings from Finnhub and save to earnings.json
Runs daily via GitHub Actions.
"""
import os
import json
import sys
from datetime import datetime, timedelta, timezone
from urllib.request import urlopen, Request
from urllib.parse import urlencode

API_KEY = os.environ.get("FINNHUB_API_KEY")
if not API_KEY:
    print("ERROR: FINNHUB_API_KEY not set", file=sys.stderr)
    sys.exit(1)

# Companies we want to flag as "major" (bold in UI)
MAJOR_TICKERS = {
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA",
    "BRK.B", "BRK.A", "JPM", "V", "MA", "UNH", "XOM", "WMT", "JNJ",
    "PG", "HD", "AVGO", "LLY", "KO", "PEP", "MRK", "ABBV", "CVX",
    "COST", "CRM", "ORCL", "ADBE", "NFLX", "AMD", "QCOM", "TMO",
    "BAC", "WFC", "C", "GS", "MS", "AXP", "BLK", "DIS", "MCD",
    "NKE", "SBUX", "T", "VZ", "TMUS", "INTC", "CSCO", "IBM",
    "CAT", "BA", "GE", "HON", "DE", "PFE", "AMGN"
}

# Date range: today through 7 days from now
today = datetime.now(timezone.utc).date()
end = today + timedelta(days=7)

url = "https://finnhub.io/api/v1/calendar/earnings?" + urlencode({
    "from": today.isoformat(),
    "to": end.isoformat(),
    "token": API_KEY
})

print(f"Fetching earnings from {today} to {end}...")
req = Request(url, headers={"User-Agent": "tradinghours-bot/1.0"})
try:
    with urlopen(req, timeout=30) as resp:
        data = json.load(resp)
except Exception as e:
    print(f"ERROR fetching: {e}", file=sys.stderr)
    sys.exit(1)

raw = data.get("earningsCalendar", [])
print(f"Got {len(raw)} entries")

# Group by date + session (BMO vs AMC)
groups = {}
for item in raw:
    date_str = item.get("date")
    hour = item.get("hour", "")  # 'bmo' = before market open, 'amc' = after market close
    sym = item.get("symbol", "").upper()
    if not date_str or not sym:
        continue
    # Skip non-listed/odd tickers (containing dots usually OK, but skip empty)
    # Default unknown timing as AMC
    session = "BMO" if hour == "bmo" else "AMC"
    key = (date_str, session)
    groups.setdefault(key, []).append({
        "symbol": sym,
        "name": item.get("name") or sym,
        "epsEstimate": item.get("epsEstimate"),
        "revenueEstimate": item.get("revenueEstimate"),
    })

# Build the output structure our website expects
output = []
for (date_str, session), companies in sorted(groups.items()):
    # Separate majors from others
    majors = [c for c in companies if c["symbol"] in MAJOR_TICKERS]
    others = [c for c in companies if c["symbol"] not in MAJOR_TICKERS]

    # Skip days with absolutely nothing notable AND too many entries (cluttered noise)
    if not majors and len(others) > 30:
        # Pick top 8 by ticker alphabetical as a fallback sample
        others = sorted(others, key=lambda c: c["symbol"])[:8]

    if not majors and not others:
        continue

    y, m, d = map(int, date_str.split("-"))
    # Convert to NY release time: BMO ~ 7am, AMC ~ 5pm
    h = 7 if session == "BMO" else 17

    entry = {
        "ny": {"y": y, "m": m - 1, "d": d, "h": h, "mn": 0},
        "type": session,
        "major": len(majors) > 0,
        "cos": [c["name"] or c["symbol"] for c in majors[:6]] or [c["name"] or c["symbol"] for c in others[:4]],
    }
    # Add an "extra" line if there are many more
    extras = []
    if majors:
        # Already showed majors in cos, list other notables
        extras = [c["symbol"] for c in others[:8]]
    elif len(others) > 4:
        extras = [c["symbol"] for c in others[4:12]]
    if extras:
        entry["extra"] = ", ".join(extras)

    output.append(entry)

# Write to earnings.json in repo root
out_path = "earnings.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump({
        "updated": datetime.now(timezone.utc).isoformat(),
        "items": output
    }, f, ensure_ascii=False, indent=2)

print(f"Wrote {len(output)} entries to {out_path}")
