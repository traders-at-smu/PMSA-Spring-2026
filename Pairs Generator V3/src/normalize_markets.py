import json
import re
import unicodedata
from database import get_connection

def to_ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")

import os

BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
STOPWORDS_PATH = os.path.join(BASE_DIR, "..", "..", "resources", "EN-Stopwords.txt")
COMMIT_EVERY   = 10_000

# Precompiled regexes
RE_DEGREE    = re.compile(r"°[fc]?")
RE_OVU       = re.compile(r"\bo/u\b")
RE_DECIMAL   = re.compile(r"(\d+)\.(\d+)")
RE_NONWORD   = re.compile(r"[^\w\s]")

# Month abbreviation → full name, precompiled
MONTH_ABBREVS = {
    abbrev: (re.compile(rf"\b{abbrev}\b"), full)
    for abbrev, full in {
        "jan": "january", "feb": "february", "mar": "march",
        "apr": "april",   "jun": "june",     "jul": "july",
        "aug": "august",  "sep": "september","oct": "october",
        "nov": "november","dec": "december",
    }.items()
}

# Word-numbers → digits, precompiled (cardinals then ordinals)
# Applied before stopword removal so e.g. "one" isn't stripped first
_WORD_NUMBERS = [
    ("zero",      "0"),  ("one",       "1"),  ("two",       "2"),
    ("three",     "3"),  ("four",      "4"),  ("five",      "5"),
    ("six",       "6"),  ("seven",     "7"),  ("eight",     "8"),
    ("nine",      "9"),  ("ten",       "10"), ("eleven",    "11"),
    ("twelve",    "12"), ("thirteen",  "13"), ("fourteen",  "14"),
    ("fifteen",   "15"), ("sixteen",   "16"), ("seventeen", "17"),
    ("eighteen",  "18"), ("nineteen",  "19"), ("twenty",    "20"),
    ("thirty",    "30"), ("forty",     "40"), ("fifty",     "50"),
    ("sixty",     "60"), ("seventy",   "70"), ("eighty",    "80"),
    ("ninety",    "90"), ("hundred",   "100"),("thousand",  "1000"),
    # Ordinals
    ("first",     "1st"),  ("second",  "2nd"),  ("third",   "3rd"),
    ("fourth",    "4th"),  ("fifth",   "5th"),  ("sixth",   "6th"),
    ("seventh",   "7th"),  ("eighth",  "8th"),  ("ninth",   "9th"),
    ("tenth",     "10th"), ("eleventh","11th"), ("twelfth", "12th"),
    ("thirteenth","13th"), ("fourteenth","14th"),("fifteenth","15th"),
    ("sixteenth", "16th"), ("seventeenth","17th"),("eighteenth","18th"),
    ("nineteenth","19th"), ("twentieth","20th"), ("thirtieth","30th"),
    ("fortieth",  "40th"), ("fiftieth","50th"),
]
WORD_NUMBER_PATTERNS = [
    (re.compile(rf"\b{word}\b"), digit)
    for word, digit in _WORD_NUMBERS
]


def load_stopwords():
    with open(STOPWORDS_PATH, "r", encoding="utf-8") as f:
        return frozenset(line.strip().lower() for line in f if line.strip())


def normalize_title(title: str, stopwords: frozenset) -> str:
    text = to_ascii(title.lower())
    text = RE_DEGREE.sub("", text)
    for pattern, digit in WORD_NUMBER_PATTERNS:
        text = pattern.sub(digit, text)
    for _, (pattern, full) in MONTH_ABBREVS.items():
        text = pattern.sub(full, text)
    text = RE_OVU.sub("OVUNDER", text)
    text = RE_DECIMAL.sub(r"\1DECPT\2", text)
    text = RE_NONWORD.sub(" ", text)
    text = text.replace("OVUNDER", "o/u").replace("DECPT", ".")
    tokens = text.split()
    tokens = [t for t in tokens if t not in stopwords and (len(t) > 1 or t.isdigit())]
    return " ".join(tokens)


def parse_outcomes(raw_data: dict, platform: str) -> list:
    if platform != "polymarket":
        return []
    outcomes_raw = raw_data.get("outcomes")
    if not outcomes_raw:
        return []
    if isinstance(outcomes_raw, list):
        outcomes = outcomes_raw
    elif isinstance(outcomes_raw, str):
        try:
            parsed = json.loads(outcomes_raw)
            outcomes = parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, ValueError):
            outcomes = [o.strip() for o in outcomes_raw.split(",") if o.strip()]
    else:
        return []
    if not outcomes:
        return []
    if {o.strip().lower() for o in outcomes} <= {"yes", "no"}:
        return []
    return [str(o) for o in outcomes]


def run():
    stopwords = load_stopwords()
    conn = get_connection()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    cursor = conn.cursor()

    cursor.execute("SELECT id, platform, market_id, title, category, raw_data FROM markets_raw")

    batch = []
    normalized = 0
    skipped = 0

    while True:
        rows = cursor.fetchmany(5000)
        if not rows:
            break

        for row in rows:
            row_id    = row["id"]
            platform  = row["platform"]
            market_id = row["market_id"]
            title     = row["title"] or ""
            category  = row["category"] or ""
            try:
                raw_data = json.loads(row["raw_data"] or "{}")
            except Exception:
                raw_data = {}

            outcomes = parse_outcomes(raw_data, platform)

            if outcomes:
                for outcome in outcomes:
                    norm = normalize_title(f"{title} {outcome}", stopwords)
                    if not norm:
                        skipped += 1
                        continue
                    batch.append((row_id, platform, market_id, outcome, category, norm))
                    normalized += 1
            else:
                norm = normalize_title(title, stopwords)
                if not norm:
                    skipped += 1
                    continue
                batch.append((row_id, platform, market_id, "", category, norm))
                normalized += 1

        if len(batch) >= COMMIT_EVERY:
            conn.executemany(
                """INSERT OR REPLACE INTO markets_normalized
                       (raw_id, platform, market_id, outcome, category, normalized_title)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                batch,
            )
            conn.commit()
            print(f"  Committed {normalized} rows so far...")
            batch.clear()

    # Final flush
    if batch:
        conn.executemany(
            """INSERT OR REPLACE INTO markets_normalized
                   (raw_id, platform, market_id, outcome, category, normalized_title)
               VALUES (?, ?, ?, ?, ?, ?)""",
            batch,
        )
        conn.commit()

    conn.close()
    print(f"Normalized {normalized} rows, skipped {skipped} empty titles.")


if __name__ == "__main__":
    run()
