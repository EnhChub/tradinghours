"""
Fetch 180 days of US earnings from Finnhub + manually curated macro events.
Output structure (earnings.json):
  {
    "updated": ISO timestamp,
    "all": [...]      # full 180-day catalog of earnings (for search)
    "macro": [...]    # manually curated FOMC / CPI / GDP / etc events
  }
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

# Major tickers — flagged as "important" so they bubble to the top.
# These are the ones the user will most likely care about.
MAJOR_TICKERS = {
    # Mega-cap tech
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA",
    # Other tech & semi
    "AVGO", "ORCL", "CRM", "ADBE", "NFLX", "AMD", "QCOM", "INTC",
    "CSCO", "IBM", "MU", "TXN", "ASML", "TSM", "ARM", "MRVL",
    # Cloud / SaaS
    "SHOP", "SNOW", "DDOG", "CRWD", "ZS", "PANW", "FTNT", "NOW",
    "WDAY", "INTU", "PLTR", "MDB",
    # Consumer
    "WMT", "COST", "HD", "TGT", "LOW", "MCD", "SBUX", "NKE", "DIS",
    # Finance
    "BRK.B", "BRK.A", "JPM", "V", "MA", "BAC", "WFC", "C", "GS",
    "MS", "AXP", "BLK", "SCHW",
    # Healthcare
    "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "AMGN",
    # Energy & industrial
    "XOM", "CVX", "CAT", "BA", "GE", "HON", "DE",
    # Others
    "PG", "KO", "PEP", "T", "VZ", "TMUS", "ABNB", "UBER", "COIN",
    "NFLX", "GME", "CHWY",
}

# ── Manually curated macro events ──
# Each: { date: 'YYYY-MM-DD', time_ny: 'HH:MM' (24h NY local), name: '...', country: '...', tag: '...' }
# Time is when the data is released, in NY local time
MACRO_EVENTS = [
    # FOMC meetings 2026 (8 per year - confirmed pattern)
    {"date": "2026-04-29", "time_ny": "14:00", "name": "FOMC 利率决议", "country": "US", "tag": "FOMC"},
    {"date": "2026-06-17", "time_ny": "14:00", "name": "FOMC 利率决议", "country": "US", "tag": "FOMC"},
    {"date": "2026-07-29", "time_ny": "14:00", "name": "FOMC 利率决议", "country": "US", "tag": "FOMC"},
    {"date": "2026-09-16", "time_ny": "14:00", "name": "FOMC 利率决议", "country": "US", "tag": "FOMC"},
    {"date": "2026-11-04", "time_ny": "14:00", "name": "FOMC 利率决议", "country": "US", "tag": "FOMC"},
    {"date": "2026-12-16", "time_ny": "14:00", "name": "FOMC 利率决议", "country": "US", "tag": "FOMC"},

    # CPI releases (typically 2nd week of each month, 08:30 ET)
    {"date": "2026-05-12", "time_ny": "08:30", "name": "美国 CPI 通胀数据", "country": "US", "tag": "CPI"},
    {"date": "2026-06-10", "time_ny": "08:30", "name": "美国 CPI 通胀数据", "country": "US", "tag": "CPI"},
    {"date": "2026-07-15", "time_ny": "08:30", "name": "美国 CPI 通胀数据", "country": "US", "tag": "CPI"},
    {"date": "2026-08-12", "time_ny": "08:30", "name": "美国 CPI 通胀数据", "country": "US", "tag": "CPI"},
    {"date": "2026-09-10", "time_ny": "08:30", "name": "美国 CPI 通胀数据", "country": "US", "tag": "CPI"},
    {"date": "2026-10-13", "time_ny": "08:30", "name": "美国 CPI 通胀数据", "country": "US", "tag": "CPI"},

    # GDP releases (quarterly, 1st month after quarter end)
    {"date": "2026-04-30", "time_ny": "08:30", "name": "美国 Q1 GDP 初值", "country": "US", "tag": "GDP"},
    {"date": "2026-07-30", "time_ny": "08:30", "name": "美国 Q2 GDP 初值", "country": "US", "tag": "GDP"},
    {"date": "2026-10-29", "time_ny": "08:30", "name": "美国 Q3 GDP 初值", "country": "US", "tag": "GDP"},

    # Non-farm Payrolls (1st Friday of each month, 08:30 ET)
    {"date": "2026-05-01", "time_ny": "08:30", "name": "美国非农就业数据", "country": "US", "tag": "NFP"},
    {"date": "2026-06-05", "time_ny": "08:30", "name": "美国非农就业数据", "country": "US", "tag": "NFP"},
    {"date": "2026-07-02", "time_ny": "08:30", "name": "美国非农就业数据", "country": "US", "tag": "NFP"},
    {"date": "2026-08-07", "time_ny": "08:30", "name": "美国非农就业数据", "country": "US", "tag": "NFP"},
    {"date": "2026-09-04", "time_ny": "08:30", "name": "美国非农就业数据", "country": "US", "tag": "NFP"},
    {"date": "2026-10-02", "time_ny": "08:30", "name": "美国非农就业数据", "country": "US", "tag": "NFP"},

    # ECB rate decisions (typically every 6 weeks)
    {"date": "2026-04-30", "time_ny": "08:15", "name": "欧央行利率决议", "country": "EU", "tag": "ECB"},
    {"date": "2026-06-04", "time_ny": "08:15", "name": "欧央行利率决议", "country": "EU", "tag": "ECB"},
    {"date": "2026-07-23", "time_ny": "08:15", "name": "欧央行利率决议", "country": "EU", "tag": "ECB"},
    {"date": "2026-09-10", "time_ny": "08:15", "name": "欧央行利率决议", "country": "EU", "tag": "ECB"},
    {"date": "2026-10-29", "time_ny": "08:15", "name": "欧央行利率决议", "country": "EU", "tag": "ECB"},

    # ISM Manufacturing PMI (1st business day of month)
    {"date": "2026-05-01", "time_ny": "10:00", "name": "ISM 制造业 PMI", "country": "US", "tag": "PMI"},
    {"date": "2026-06-01", "time_ny": "10:00", "name": "ISM 制造业 PMI", "country": "US", "tag": "PMI"},
    {"date": "2026-07-01", "time_ny": "10:00", "name": "ISM 制造业 PMI", "country": "US", "tag": "PMI"},
    {"date": "2026-08-03", "time_ny": "10:00", "name": "ISM 制造业 PMI", "country": "US", "tag": "PMI"},
    {"date": "2026-09-01", "time_ny": "10:00", "name": "ISM 制造业 PMI", "country": "US", "tag": "PMI"},
    {"date": "2026-10-01", "time_ny": "10:00", "name": "ISM 制造业 PMI", "country": "US", "tag": "PMI"},

    # RBA rate decisions (Australia - 1st Tuesday each month except January)
    {"date": "2026-05-05", "time_ny": "00:30", "name": "澳央行 RBA 利率决议", "country": "AU", "tag": "RBA"},
    {"date": "2026-06-02", "time_ny": "00:30", "name": "澳央行 RBA 利率决议", "country": "AU", "tag": "RBA"},
    {"date": "2026-07-07", "time_ny": "00:30", "name": "澳央行 RBA 利率决议", "country": "AU", "tag": "RBA"},
    {"date": "2026-08-04", "time_ny": "00:30", "name": "澳央行 RBA 利率决议", "country": "AU", "tag": "RBA"},
    {"date": "2026-09-29", "time_ny": "00:30", "name": "澳央行 RBA 利率决议", "country": "AU", "tag": "RBA"},
]


def fetch_range(start_date, end_date):
    url = "https://finnhub.io/api/v1/calendar/earnings?" + urlencode({
        "from": start_date.isoformat(),
        "to": end_date.isoformat(),
        "token": API_KEY,
    })
    req = Request(url, headers={"User-Agent": "tradinghours-bot/1.0"})
    with urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    return data.get("earningsCalendar", [])


def normalize_entry(item):
    date_str = item.get("date")
    sym = (item.get("symbol") or "").upper()
    if not date_str or not sym:
        return None
    hour = item.get("hour", "")
    session = "BMO" if hour == "bmo" else "AMC"
    try:
        y, m, d = map(int, date_str.split("-"))
    except Exception:
        return None
    h = 7 if session == "BMO" else 17
    return {
        "s": sym,
        "n": item.get("name") or sym,
        "ny": {"y": y, "m": m - 1, "d": d, "h": h, "mn": 0},
        "t": session,
        "maj": sym in MAJOR_TICKERS,  # boolean flag for major tickers
    }


# ── Pull data ──
today = datetime.now(timezone.utc).date()
end_date = today + timedelta(days=180)

print(f"Fetching earnings from {today} to {end_date}...")

# Finnhub API may have a per-call range limit (~3 months). Split into chunks.
all_raw = []
chunk_start = today
while chunk_start < end_date:
    chunk_end = min(chunk_start + timedelta(days=85), end_date)
    print(f"  chunk: {chunk_start} -> {chunk_end}")
    try:
        chunk = fetch_range(chunk_start, chunk_end)
        all_raw.extend(chunk)
    except Exception as e:
        print(f"  ERROR fetching chunk: {e}", file=sys.stderr)
    chunk_start = chunk_end + timedelta(days=1)

print(f"Got {len(all_raw)} raw entries")

# Normalize and dedupe by (symbol, date, session)
seen = set()
all_entries = []
for it in all_raw:
    norm = normalize_entry(it)
    if not norm:
        continue
    key = (norm["s"], norm["ny"]["y"], norm["ny"]["m"], norm["ny"]["d"], norm["t"])
    if key in seen:
        continue
    seen.add(key)
    # Optionally include EPS estimate for major tickers only (saves bytes)
    eps = it.get("epsEstimate")
    if eps is not None and norm["maj"]:
        norm["eps"] = eps
    all_entries.append(norm)


def sort_key(e):
    ny = e["ny"]
    return (ny["y"], ny["m"], ny["d"], ny["h"], 0 if e.get("maj") else 1, e["s"])


all_entries.sort(key=sort_key)
print(f"Normalized to {len(all_entries)} unique entries")

# ── Filter macro events to just the next 180 days ──
end_iso = end_date.isoformat()
today_iso = today.isoformat()
macro_filtered = []
for e in MACRO_EVENTS:
    if today_iso <= e["date"] <= end_iso:
        y, m, d = map(int, e["date"].split("-"))
        h, mn = map(int, e["time_ny"].split(":"))
        macro_filtered.append({
            "name": e["name"],
            "tag": e["tag"],
            "country": e["country"],
            "ny": {"y": y, "m": m - 1, "d": d, "h": h, "mn": mn},
        })
macro_filtered.sort(key=lambda e: (e["ny"]["y"], e["ny"]["m"], e["ny"]["d"], e["ny"]["h"]))
print(f"Filtered to {len(macro_filtered)} macro events in window")

# ── Output ──
out = {
    "updated": datetime.now(timezone.utc).isoformat(),
    "all": all_entries,
    "macro": macro_filtered,
}

with open("earnings.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

size_kb = os.path.getsize("earnings.json") / 1024
print(f"Wrote {len(all_entries)} earnings + {len(macro_filtered)} macro events")
print(f"File size: {size_kb:.1f} KB")

major_count = sum(1 for e in all_entries if e.get("maj"))
print(f"  ({major_count} major tickers in 180 days)")
