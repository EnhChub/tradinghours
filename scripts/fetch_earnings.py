"""
Fetch 90 days of US earnings from Finnhub and save to earnings.json.
Output structure:
  {
    "updated": ISO timestamp,
    "items": [...]      # this week, curated for homepage display (with majors flagged)
    "all": [...]        # full 90-day catalog, for search/favourites
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

# Companies we want to flag as "major" (bold in UI, surface on homepage)
MAJOR_TICKERS = {
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA",
    "BRK.B", "BRK.A", "JPM", "V", "MA", "UNH", "XOM", "WMT", "JNJ",
    "PG", "HD", "AVGO", "LLY", "KO", "PEP", "MRK", "ABBV", "CVX",
    "COST", "CRM", "ORCL", "ADBE", "NFLX", "AMD", "QCOM", "TMO",
    "BAC", "WFC", "C", "GS", "MS", "AXP", "BLK", "DIS", "MCD",
    "NKE", "SBUX", "T", "VZ", "TMUS", "INTC", "CSCO", "IBM",
    "CAT", "BA", "GE", "HON", "DE", "PFE", "AMGN", "PYPL", "UBER",
    "SHOP", "SQ", "PLTR", "ABNB", "COIN", "SNOW", "DDOG", "CRWD",
    "ZS", "PANW", "FTNT", "MU", "ASML", "TSM", "ARM",
}


def fetch_range(start_date, end_date):
    """Hit the Finnhub earnings calendar for a date range."""
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
    """Turn one Finnhub entry into our internal flat format."""
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
        "symbol": sym,
        "name": item.get("name") or sym,
        "ny": {"y": y, "m": m - 1, "d": d, "h": h, "mn": 0},
        "type": session,
        "epsEstimate": item.get("epsEstimate"),
        "revenueEstimate": item.get("revenueEstimate"),
    }


# ── Pull data ──
today = datetime.now(timezone.utc).date()
ninety_days = today + timedelta(days=90)

print(f"Fetching earnings from {today} to {ninety_days}...")
try:
    raw = fetch_range(today, ninety_days)
except Exception as e:
    print(f"ERROR fetching: {e}", file=sys.stderr)
    sys.exit(1)
print(f"Got {len(raw)} entries from Finnhub")

# Normalize all entries
all_entries = []
for it in raw:
    norm = normalize_entry(it)
    if norm:
        all_entries.append(norm)

# Sort by date, then BMO before AMC
def sort_key(e):
    ny = e["ny"]
    return (ny["y"], ny["m"], ny["d"], ny["h"])

all_entries.sort(key=sort_key)
print(f"Normalized to {len(all_entries)} entries")

# ── Build "this week" curated list (for homepage display) ──
# Group entries from today through 7 days out by (date, session)
seven_days = today + timedelta(days=7)
groups = {}
for e in all_entries:
    ny = e["ny"]
    e_date = datetime(ny["y"], ny["m"] + 1, ny["d"]).date()
    if e_date < today or e_date > seven_days:
        continue
    key = (ny["y"], ny["m"], ny["d"], e["type"])
    groups.setdefault(key, []).append(e)

curated = []
for (y, m, d, session), companies in sorted(groups.items()):
    majors = [c for c in companies if c["symbol"] in MAJOR_TICKERS]
    others = [c for c in companies if c["symbol"] not in MAJOR_TICKERS]

    if not majors and len(others) > 30:
        others = sorted(others, key=lambda c: c["symbol"])[:8]
    if not majors and not others:
        continue

    h = 7 if session == "BMO" else 17
    cos_list = [c["name"] or c["symbol"] for c in (majors[:6] if majors else others[:4])]
    extras_syms = []
    if majors:
        extras_syms = [c["symbol"] for c in others[:8]]
    elif len(others) > 4:
        extras_syms = [c["symbol"] for c in others[4:12]]

    entry = {
        "ny": {"y": y, "m": m, "d": d, "h": h, "mn": 0},
        "type": session,
        "major": len(majors) > 0,
        "cos": cos_list,
    }
    if extras_syms:
        entry["extra"] = ", ".join(extras_syms)
    curated.append(entry)

# Slim "all" entries down for transport (drop nulls to reduce file size)
all_slim = []
for e in all_entries:
    slim = {
        "s": e["symbol"],
        "n": e["name"],
        "ny": e["ny"],
        "t": e["type"],
    }
    if e.get("epsEstimate") is not None:
        slim["eps"] = e["epsEstimate"]
    all_slim.append(slim)

out = {
    "updated": datetime.now(timezone.utc).isoformat(),
    "items": curated,
    "all": all_slim,
}

with open("earnings.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

print(f"Wrote {len(curated)} curated items + {len(all_slim)} total entries")
print(f"File size approx: {os.path.getsize('earnings.json') / 1024:.1f} KB")
