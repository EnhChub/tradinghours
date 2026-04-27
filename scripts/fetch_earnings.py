"""
Fetch 180 days of US earnings from Finnhub, merged with a hardcoded
fallback list of major company earnings. Outputs earnings.json.

Output structure:
  {
    "updated": ISO timestamp,
    "all": [...]   # full catalog of earnings (for search + agenda)
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

# Major tickers — flagged so they bubble to the top of agenda lists.
MAJOR_TICKERS = {
    # Mega-cap tech
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA",
    # Other tech & semi
    "AVGO", "ORCL", "CRM", "ADBE", "NFLX", "AMD", "QCOM", "INTC",
    "CSCO", "IBM", "MU", "TXN", "ASML", "TSM", "ARM", "MRVL",
    # Cloud / SaaS
    "SHOP", "SNOW", "DDOG", "CRWD", "ZS", "PANW", "FTNT", "NOW",
    "WDAY", "INTU", "PLTR", "MDB", "HPQ", "DELL",
    # Consumer
    "WMT", "COST", "HD", "TGT", "LOW", "MCD", "SBUX", "NKE", "DIS",
    "CMG", "LULU",
    # Finance
    "BRK.B", "BRK.A", "JPM", "V", "MA", "BAC", "WFC", "C", "GS",
    "MS", "AXP", "BLK", "SCHW", "PYPL",
    # Healthcare
    "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "AMGN",
    # Energy & industrial
    "XOM", "CVX", "CAT", "BA", "GE", "HON", "DE", "BKR",
    # Telecoms / others
    "PG", "KO", "PEP", "T", "VZ", "TMUS", "ABNB", "UBER", "COIN",
    "GME", "CHWY",
}

# Friendly names for tickers (used when Finnhub returns just the ticker as name)
TICKER_NAMES = {
    "AAPL": "Apple", "MSFT": "Microsoft", "GOOGL": "Alphabet (Class A)",
    "GOOG": "Alphabet", "AMZN": "Amazon", "META": "Meta Platforms",
    "NVDA": "NVIDIA", "TSLA": "Tesla", "AVGO": "Broadcom", "ORCL": "Oracle",
    "CRM": "Salesforce", "ADBE": "Adobe", "NFLX": "Netflix",
    "AMD": "AMD", "QCOM": "Qualcomm", "INTC": "Intel", "CSCO": "Cisco",
    "IBM": "IBM", "MU": "Micron", "TXN": "Texas Instruments",
    "ASML": "ASML", "TSM": "TSMC", "ARM": "ARM Holdings", "MRVL": "Marvell",
    "SHOP": "Shopify", "SNOW": "Snowflake", "DDOG": "Datadog",
    "CRWD": "CrowdStrike", "ZS": "Zscaler", "PANW": "Palo Alto Networks",
    "FTNT": "Fortinet", "NOW": "ServiceNow", "WDAY": "Workday",
    "INTU": "Intuit", "PLTR": "Palantir", "MDB": "MongoDB",
    "HPQ": "HP Inc", "DELL": "Dell", "WMT": "Walmart", "COST": "Costco",
    "HD": "Home Depot", "TGT": "Target", "LOW": "Lowe's",
    "MCD": "McDonald's", "SBUX": "Starbucks", "NKE": "Nike",
    "DIS": "Disney", "CMG": "Chipotle", "LULU": "Lululemon",
    "JPM": "JPMorgan Chase", "V": "Visa", "MA": "Mastercard",
    "BAC": "Bank of America", "WFC": "Wells Fargo", "C": "Citigroup",
    "GS": "Goldman Sachs", "MS": "Morgan Stanley", "AXP": "American Express",
    "BLK": "BlackRock", "SCHW": "Charles Schwab", "PYPL": "PayPal",
    "UNH": "UnitedHealth", "JNJ": "Johnson & Johnson", "LLY": "Eli Lilly",
    "PFE": "Pfizer", "MRK": "Merck", "ABBV": "AbbVie",
    "TMO": "Thermo Fisher", "AMGN": "Amgen",
    "XOM": "ExxonMobil", "CVX": "Chevron", "CAT": "Caterpillar",
    "BA": "Boeing", "GE": "GE Aerospace", "HON": "Honeywell",
    "DE": "Deere", "BKR": "Baker Hughes",
    "PG": "Procter & Gamble", "KO": "Coca-Cola", "PEP": "PepsiCo",
    "T": "AT&T", "VZ": "Verizon", "TMUS": "T-Mobile",
    "ABNB": "Airbnb", "UBER": "Uber", "COIN": "Coinbase",
    "GME": "GameStop", "CHWY": "Chewy",
}

# ── HARDCODED FALLBACK earnings ──
# These are confirmed earnings dates for major companies that should always
# appear, even if Finnhub API misses them. Updated manually as needed.
# Format: (ticker, "YYYY-MM-DD", "BMO" or "AMC")
FALLBACK_EARNINGS = [
    # Q1 2026 earnings season (April-May 2026)
    # Mag 7 + key tech
    ("TSLA", "2026-04-22", "AMC"),
    ("META", "2026-04-29", "AMC"),
    ("MSFT", "2026-04-29", "AMC"),
    ("GOOGL", "2026-04-29", "AMC"),
    ("GOOG", "2026-04-29", "AMC"),
    ("AMZN", "2026-04-29", "AMC"),
    ("AAPL", "2026-04-30", "AMC"),
    # Other notable Q1 2026 dates
    ("V", "2026-04-29", "AMC"),
    ("KO", "2026-04-29", "BMO"),
    ("LLY", "2026-04-30", "BMO"),
    ("MA", "2026-04-30", "BMO"),
    ("CAT", "2026-04-30", "BMO"),
    ("MRK", "2026-04-30", "BMO"),
    ("AMGN", "2026-05-01", "AMC"),
    ("XOM", "2026-05-01", "BMO"),
    ("CVX", "2026-05-01", "BMO"),
    ("ABBV", "2026-04-30", "BMO"),
    ("QCOM", "2026-04-29", "AMC"),
    ("PYPL", "2026-04-28", "BMO"),
    ("SBUX", "2026-04-28", "AMC"),
    ("PFE", "2026-04-29", "BMO"),
    ("UBER", "2026-05-07", "BMO"),
    ("DIS", "2026-05-06", "BMO"),
    # Late Q1 / early Q2 already-known calendars
    ("PLTR", "2026-05-04", "AMC"),
    ("AMD", "2026-05-05", "AMC"),
    ("ABNB", "2026-05-06", "AMC"),
    ("SHOP", "2026-05-06", "BMO"),
    ("COIN", "2026-05-07", "AMC"),
    # Mid-2026 (estimates - will be replaced by Finnhub data when closer)
    ("NVDA", "2026-05-20", "AMC"),  # NVDA confirmed via Finnhub
    # Late summer earnings (Q2 2026, reported Jul-Aug)
    ("NFLX", "2026-07-16", "AMC"),
    ("TSLA", "2026-07-22", "AMC"),
    ("GOOGL", "2026-07-22", "AMC"),
    ("GOOG", "2026-07-22", "AMC"),
    ("MSFT", "2026-07-29", "AMC"),
    ("META", "2026-07-29", "AMC"),
    ("AAPL", "2026-07-30", "AMC"),
    ("AMZN", "2026-07-30", "AMC"),
    ("NVDA", "2026-08-26", "AMC"),
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
    raw_name = item.get("name") or sym
    # If Finnhub returned just the ticker as name, use our friendly name
    if raw_name == sym and sym in TICKER_NAMES:
        name = TICKER_NAMES[sym]
    else:
        name = raw_name
    return {
        "s": sym,
        "n": name,
        "ny": {"y": y, "m": m - 1, "d": d, "h": h, "mn": 0},
        "t": session,
        "maj": sym in MAJOR_TICKERS,
    }


def make_fallback_entry(ticker, date_str, session):
    y, m, d = map(int, date_str.split("-"))
    h = 7 if session == "BMO" else 17
    return {
        "s": ticker,
        "n": TICKER_NAMES.get(ticker, ticker),
        "ny": {"y": y, "m": m - 1, "d": d, "h": h, "mn": 0},
        "t": session,
        "maj": ticker in MAJOR_TICKERS,
    }


# ── Pull data ──
today = datetime.now(timezone.utc).date()
end_date = today + timedelta(days=180)

print(f"Fetching earnings from {today} to {end_date}...")

# Split into chunks (Finnhub may have per-call range limits)
all_raw = []
chunk_start = today
while chunk_start < end_date:
    chunk_end = min(chunk_start + timedelta(days=85), end_date)
    print(f"  chunk: {chunk_start} -> {chunk_end}")
    try:
        chunk = fetch_range(chunk_start, chunk_end)
        all_raw.extend(chunk)
        print(f"    got {len(chunk)} entries")
    except Exception as e:
        print(f"  ERROR fetching chunk: {e}", file=sys.stderr)
    chunk_start = chunk_end + timedelta(days=1)

print(f"Total raw entries from Finnhub: {len(all_raw)}")

# Normalize
normalized = []
for it in all_raw:
    norm = normalize_entry(it)
    if norm:
        normalized.append(norm)

# Debug: report on which major tickers Finnhub gave us
finnhub_majors = sorted({e["s"] for e in normalized if e["maj"]})
print(f"Major tickers from Finnhub ({len(finnhub_majors)}): {', '.join(finnhub_majors[:30])}{'...' if len(finnhub_majors) > 30 else ''}")

# ── Merge with hardcoded fallback (dedupe by symbol+date+session) ──
combined = list(normalized)
for ticker, date_str, session in FALLBACK_EARNINGS:
    if date_str < today.isoformat() or date_str > end_date.isoformat():
        continue
    fallback = make_fallback_entry(ticker, date_str, session)
    combined.append(fallback)

# Dedupe: for each (symbol, date), prefer the entry with more info (Finnhub > fallback)
seen = {}
for e in combined:
    key = (e["s"], e["ny"]["y"], e["ny"]["m"], e["ny"]["d"])
    if key not in seen:
        seen[key] = e
    else:
        # Keep the one with a better name (not equal to ticker)
        existing = seen[key]
        if existing["n"] == existing["s"] and e["n"] != e["s"]:
            seen[key] = e

all_entries = list(seen.values())

# Sort: by date, then majors first
def sort_key(e):
    ny = e["ny"]
    return (ny["y"], ny["m"], ny["d"], ny["h"], 0 if e.get("maj") else 1, e["s"])


all_entries.sort(key=sort_key)
print(f"After merge + dedupe: {len(all_entries)} entries")

# Verify Mag 7 are all present
mag7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"]
print("Mag 7 check:")
for t in mag7:
    matches = [e for e in all_entries if e["s"] == t]
    if matches:
        next_match = matches[0]  # already sorted by date
        d = next_match["ny"]
        print(f"  {t}: {d['y']}-{d['m']+1:02d}-{d['d']:02d} {next_match['t']} ({next_match['n']})")
    else:
        print(f"  {t}: NOT FOUND ⚠")

# ── Output ──
out = {
    "updated": datetime.now(timezone.utc).isoformat(),
    "all": all_entries,
}

with open("earnings.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

size_kb = os.path.getsize("earnings.json") / 1024
print(f"Wrote {len(all_entries)} entries to earnings.json ({size_kb:.1f} KB)")
