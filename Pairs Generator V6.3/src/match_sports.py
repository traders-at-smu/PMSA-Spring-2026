"""
Sports game matcher.

Extracts team names from Polymarket and Kalshi sports markets, then pairs
them by shared team(s) and similar resolution date (±2 days).

Speed: single compiled alternation regex — one pass per text string.
Output: matched_sports_pairs.csv  (high-confidence only, best match per game)
"""
import csv
import json
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from database import get_connection

BASE_DIR         = os.path.dirname(os.path.abspath(__file__))


def _normalize_token_ids_list(raw):
    """Return a list of token ID strings, handling pre-serialized strings."""
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return list(raw) if raw else []


def _normalize_token_ids(raw):
    """Return a JSON array string of token IDs, handling pre-serialized strings."""
    return json.dumps(_normalize_token_ids_list(raw))
CATEGORIES_DIR   = os.path.join(BASE_DIR, "..", "resources")
OUTPUT_FILE      = os.path.join(BASE_DIR, "..", "outputs", "matched_sports_pairs.csv")
DATE_WINDOW      = 1    # days either side (for regular team sports)
MAX_TEAMS_KALSHI = 2    # skip Kalshi markets where more than 2 teams extracted
MIN_TEAM_LEN     = 3    # minimum chars for a team-name token (catches PSG, etc.)
_TOURNAMENT_SPORTS = {"Golf", "Tennis"}  # multi-day events; exempt from strict date matching

# Standalone words that appear in Sports.txt but are NOT team identifiers
GENERIC_TERMS = {
    "fc", "united", "city", "sporting", "sc", "cf", "ac", "as",
    "real", "inter", "new", "red", "blue", "white", "black",
}

# Kalshi event-ticker substrings that indicate bundle/parlay markets
BUNDLE_TICKER_FRAGMENTS = {
    "MULTIGAME", "EXTENDED", "PARLAY", "COMBO", "MULTI", "CROSSCATEGORY",
}

# ---------------------------------------------------------------------------
# Sport/league classifier
# ---------------------------------------------------------------------------
# Each entry: (regex_on_kalshi_ticker, sport, league)
# Ordered most-specific first so "KXBUNDESLIGA2" wins over "KXBUNDESLIGA"
_KALSHI_SPORT_MAP = [
    # Soccer – Europe
    (r"KXEPL|KXPREMIERLEAGUE|KXFACUP",          "Soccer",   "Premier League"),
    (r"KXBUNDESLIGA2",                            "Soccer",   "2. Bundesliga"),
    (r"KXBUNDESLIGA",                             "Soccer",   "Bundesliga"),
    (r"KXLALIGA2",                                "Soccer",   "La Liga 2"),
    (r"KXLALIGA",                                 "Soccer",   "La Liga"),
    (r"KXSERIEB",                                 "Soccer",   "Serie B"),
    (r"KXSERIEA",                                 "Soccer",   "Serie A"),
    (r"KXLIGUE1",                                 "Soccer",   "Ligue 1"),
    (r"KXUCL|KXUCLW",                            "Soccer",   "Champions League"),
    (r"KXUEL",                                    "Soccer",   "Europa League"),
    (r"KXUECL",                                   "Soccer",   "Conference League"),
    (r"KXDFBPOKAL",                               "Soccer",   "DFB Pokal"),
    (r"KXCOPADELREY",                             "Soccer",   "Copa del Rey"),
    (r"KXCOPPAITALIA",                            "Soccer",   "Coppa Italia"),
    (r"KXEKSTRAKLASA",                            "Soccer",   "Ekstraklasa"),
    (r"KXBELGIANPL",                              "Soccer",   "Belgian Pro League"),
    (r"KXEREDIVISIE",                             "Soccer",   "Eredivisie"),
    (r"KXLIGAPORTUGAL",                           "Soccer",   "Primeira Liga"),
    (r"KXSCOTTISHPREM",                           "Soccer",   "Scottish Premiership"),
    (r"KXSUPERLIG",                               "Soccer",   "Süper Lig"),
    (r"KXDENSUPERLIGA",                           "Soccer",   "Danish Superliga"),
    (r"KXSLGREECE",                               "Soccer",   "Greek Super League"),
    (r"KXTHAIL1",                                 "Soccer",   "Thai League 1"),
    (r"KXSAUDIPLGAME|KXSAUDIPL",                 "Soccer",   "Saudi Pro League"),
    (r"KXPERLIGA",                                "Soccer",   "Liga 1 Peru"),
    (r"KXECULP",                                  "Soccer",   "LigaPro Ecuador"),
    # Soccer – Americas
    (r"KXMLS",                                    "Soccer",   "MLS"),
    (r"KXLIGAMX",                                 "Soccer",   "Liga MX"),
    (r"KXBRASILEIRO",                             "Soccer",   "Brasileirão"),
    (r"KXCONCACAFCCUP",                           "Soccer",   "CONCACAF"),
    (r"KXURYPDGAME|KXURYPD",                     "Soccer",   "Uruguayan Primera"),
    (r"KXVENFUTVE",                               "Soccer",   "Venezuelan Primera"),
    (r"KXARGPREMDIV",                             "Soccer",   "Argentine Primera"),
    # Soccer – Asia/Other
    (r"KXJLEAGUE",                                "Soccer",   "J.League"),
    (r"KXKLEAGUE",                                "Soccer",   "K League"),
    (r"KXPSL(?!GAME)",                            "Cricket",  "PSL"),   # Pakistan Super League cricket
    (r"KXPSLGAME",                                "Soccer",   "Pakistani Football"),
    (r"KXCHNSL",                                  "Soccer",   "Chinese Super League"),
    # Soccer – international
    (r"KXWC(?!OT)|KXWCGAME|KXWCROUND|KXWCGROUP", "Soccer",  "World Cup"),
    (r"KXMENWORLDCUP",                            "Soccer",   "World Cup"),
    (r"KXNWSL",                                   "Soccer",   "NWSL"),
    (r"KXUFL",                                    "American Football", "UFL"),
    # Soccer – misc
    (r"KXEFL",                                    "Soccer",   "EFL Championship"),
    (r"KXAFLGAME",                                "Australian Football", "AFL"),
    (r"KXALEAGUE",                                "Soccer",   "A-League"),
    (r"KXLIIGAGAME",                              "Ice Hockey","Finnish Liiga"),
    # Basketball
    (r"KXNBA",                                    "Basketball","NBA"),
    (r"KXNCAAMB|KXNCAABB",                        "Basketball","NCAA Basketball"),
    (r"KXEUROLEAGUE",                             "Basketball","EuroLeague"),
    (r"KXBBSERIEAGAME",                           "Basketball","Lega Basket Serie A"),
    (r"KXCBAGAME",                                "Basketball","CBA"),
    (r"KXKBLGAME",                                "Basketball","KBL"),
    (r"KXNBLGAME",                                "Basketball","NBL"),
    (r"KXLNBELITE",                               "Basketball","LNB Elite"),
    (r"KXBBLGAME",                                "Basketball","BBL"),
    (r"KXBSLGAME",                                "Basketball","BSL"),
    (r"KXFIBACHAMP",                              "Basketball","FIBA Champions League"),
    (r"KXJBLEAGUE",                               "Basketball","B.League"),
    (r"KXARGLNB",                                 "Basketball","Argentine LNB"),
    (r"KXBALGAME",                                "Basketball","African/Asian League"),
    # Baseball
    (r"KXMLB",                                    "Baseball", "MLB"),
    (r"KXNPBGAME",                                "Baseball", "NPB"),
    (r"KXKBOGAME",                                "Baseball", "KBO"),
    (r"KXNCAABASEBALL",                           "Baseball", "NCAA Baseball"),
    # Ice Hockey
    (r"KXNHL",                                    "Ice Hockey","NHL"),
    (r"KXAHLGAME",                                "Ice Hockey","AHL"),
    (r"KXKHLGAME",                                "Ice Hockey","KHL"),
    (r"KXSHLGAME",                                "Ice Hockey","SHL"),
    (r"KXVTBGAME",                                "Ice Hockey","VHL"),
    (r"KXNCAAHOCKEY",                             "Ice Hockey","NCAA Hockey"),
    # American Football
    (r"KXNFL",                                    "American Football","NFL"),
    (r"KXNCAAF",                                  "American Football","NCAA Football"),
    (r"KXNRLCHAMP|KXRUGBYNRL",                   "Rugby",    "NRL"),
    (r"KXRUGBYESL",                               "Rugby",    "Rugby ESL"),
    # Tennis
    (r"KXATPMATCH|KXATPGRANDSLAM|KXATPCHALLENGER", "Tennis", "ATP"),
    (r"KXWTAMATCH|KXWTAGRANDSLAM|KXWTACHALLENGER",  "Tennis", "WTA"),
    (r"KXGRANDSLAM",                              "Tennis",   "Grand Slam"),
    # Golf
    (r"KXPGATOUR|KXPGAMAJOR|KXPGATOP|KXPGACURRY|KXPGAH2H", "Golf",   "PGA Tour"),
    (r"KXLPGATOUR",                               "Golf",     "LPGA Tour"),
    (r"KXDPWORLDTOUR",                            "Golf",     "DP World Tour"),
    (r"KXGOLFMAJORS",                             "Golf",     "Majors"),
    # Motorsport
    (r"KXF1",                                     "Motorsport","Formula 1"),
    (r"KXNASCAR",                                 "Motorsport","NASCAR"),
    (r"KXINDYCAR",                                "Motorsport","IndyCar"),
    # MMA / Boxing
    (r"KXUFC",                                    "MMA",      "UFC"),
    (r"KXBOXING",                                 "Boxing",   "Boxing"),
    # Cricket
    (r"KXIPL",                                    "Cricket",  "IPL"),
    (r"KXT20",                                    "Cricket",  "T20"),
    # Esports
    (r"KXCS",                                     "Esports",  "CS2"),
    (r"KXLOLGAME|KXLOLMAP|KXLOLTOTALMAPS",          "Esports",  "LoL"),
    (r"KXDOTA",                                   "Esports",  "Dota 2"),
    (r"KXVALORANT",                               "Esports",  "Valorant"),
    (r"KXR6",                                     "Esports",  "Rainbow Six"),
    (r"KXOWGAME",                                 "Esports",  "Overwatch"),
    (r"KXXAIGAME",                                "Esports",  "XAI"),
    # Other
    (r"KXCHESS",                                  "Chess",    "Chess"),
]

_KALSHI_SPORT_COMPILED = [
    (re.compile(pat, re.IGNORECASE), sport, league)
    for pat, sport, league in _KALSHI_SPORT_MAP
]

# Polymarket slug prefixes → (sport, league)  — used as fallback / cross-check
_SLUG_PREFIX_MAP = {
    "nhl": ("Ice Hockey",       "NHL"),
    "nba": ("Basketball",       "NBA"),
    "mlb": ("Baseball",         "MLB"),
    "nfl": ("American Football","NFL"),
    "epl": ("Soccer",           "Premier League"),
    "eng": ("Soccer",           "English Football"),
    "bun": ("Soccer",           "Bundesliga"),
    "sea": ("Soccer",           "Serie A"),
    "ita": ("Soccer",           "Italian Football"),
    "itsb":("Soccer",           "Serie B"),
    "lig": ("Soccer",           "Ligue 1"),
    "fra": ("Soccer",           "French Football"),
    "esp": ("Soccer",           "La Liga"),
    "mls": ("Soccer",           "MLS"),
    "mex": ("Soccer",           "Liga MX"),
    "ucl": ("Soccer",           "Champions League"),
    "uel": ("Soccer",           "Europa League"),
    "atp": ("Tennis",           "ATP"),
    "wta": ("Tennis",           "WTA"),
    "pga": ("Golf",             "PGA Tour"),
    "f1":  ("Motorsport",       "Formula 1"),
    "ufc": ("MMA",              "UFC"),
    "nwsl":("Soccer",           "NWSL"),
    "por": ("Soccer",           "Primeira Liga"),
    "bel": ("Soccer",           "Belgian Pro League"),
    "ned": ("Soccer",           "Eredivisie"),
    "tur": ("Soccer",           "Süper Lig"),
    "sco": ("Soccer",           "Scottish Premiership"),
    "bra": ("Soccer",           "Brasileirão"),
    "bra2":("Soccer",           "Série B Brazil"),
    "arg": ("Soccer",           "Argentine Primera"),
    "ncaamb": ("Basketball",    "NCAA Basketball"),
    "ncaafb": ("American Football","NCAA Football"),
    # New slug prefixes
    "fl1": ("Soccer",           "Ligue 1"),
    "lal": ("Soccer",           "La Liga"),
    "kbo": ("Baseball",         "KBO"),
    "lol": ("Esports",          "LoL"),
    "val": ("Esports",          "Valorant"),
    "aus": ("Soccer",           "A-League"),
    "mex": ("Soccer",           "Liga MX"),
    "chi1":("Soccer",           "Chilean Primera"),
    "kor": ("Soccer",           "K League"),
    "j1100":("Soccer",          "J.League"),
    "j2100":("Soccer",          "J.League 2"),
    "el1": ("Soccer",           "EFL League One"),
    "el2": ("Soccer",           "EFL League Two"),
    "elc": ("Soccer",           "EFL Championship"),
    "enl": ("Soccer",           "National League"),
    "ere": ("Soccer",           "Eredivisie"),
    "es2": ("Soccer",           "La Liga 2"),
    "bl2": ("Soccer",           "2. Bundesliga"),
    "col1":("Soccer",           "Colombian Primera"),
    "lib": ("Soccer",           "Copa Libertadores"),
    "sud": ("Soccer",           "Copa Sudamericana"),
    "svk1":("Soccer",           "Slovak Super Liga"),
    "fr2": ("Soccer",           "Ligue 2"),
    "nor": ("Soccer",           "Eliteserien"),
    "cze1":("Soccer",           "Czech First League"),
    "gtm": ("Soccer",           "Guatemalan Liga Nacional"),
    "per1":("Soccer",           "Liga 1 Peru"),
    "rus": ("Soccer",           "Russian Premier League"),
    "ukr1":("Soccer",           "Ukrainian Premier League"),
    "rou1":("Soccer",           "Romanian Liga 1"),
    "isp": ("Cricket",          "IPL"),
    "sea": ("Soccer",           "Serie A"),
    "scop":("Soccer",           "Scottish Premiership"),
    "spl": ("Soccer",           "Saudi Pro League"),
    "ucl": ("Soccer",           "Champions League"),
    "uel": ("Soccer",           "Europa League"),
}


def classify_sport(kalshi_ticker: str, poly_slug: str = "") -> tuple[str, str]:
    """Return (sport, league) using Kalshi ticker as primary, slug as fallback."""
    ticker_upper = kalshi_ticker.upper()
    for pat, sport, league in _KALSHI_SPORT_COMPILED:
        if pat.search(ticker_upper):
            return sport, league

    # Fallback: try Polymarket slug prefix
    slug_lower = (poly_slug or "").lower()
    for prefix, (sport, league) in _SLUG_PREFIX_MAP.items():
        if slug_lower.startswith(prefix):
            return sport, league

    return "Sports", ""


# ---------------------------------------------------------------------------
# Ticker code → team nickname decoder
# Kalshi game tickers end with two concatenated 2-4 letter city codes,
# e.g. KXNHLGAME-26APR04BOSTB → suffix BOSTB → BOS+TB → Bruins+Lightning
# ---------------------------------------------------------------------------

_TICKER_CODE_MAP: dict[str, dict[str, str]] = {
    "Ice Hockey": {
        "ANA": "Ducks",        "BOS": "Bruins",       "BUF": "Sabres",
        "CGY": "Flames",       "CAR": "Hurricanes",   "CHI": "Blackhawks",
        "CBJ": "Blue Jackets", "COL": "Avalanche",    "DAL": "Stars",
        "DET": "Red Wings",    "EDM": "Oilers",        "FLA": "Panthers",
        "LA":  "Kings",        "MIN": "Wild",          "MTL": "Canadiens",
        "NSH": "Predators",    "NJ":  "Devils",        "NYI": "Islanders",
        "NYR": "Rangers",      "OTT": "Senators",      "PHI": "Flyers",
        "PIT": "Penguins",     "STL": "Blues",         "SJ":  "Sharks",
        "SEA": "Kraken",       "TB":  "Lightning",     "TOR": "Maple Leafs",
        "UTA": "Utah",         "VAN": "Canucks",       "VGK": "Golden Knights",
        "WPG": "Jets",         "WSH": "Capitals",
    },
    "Basketball": {
        "ATL": "Hawks",        "BKN": "Nets",          "BRK": "Nets",
        "BOS": "Celtics",      "CHA": "Hornets",       "CHI": "Bulls",
        "CLE": "Cavaliers",    "DAL": "Mavericks",     "DET": "Pistons",
        "DEN": "Nuggets",      "GSW": "Warriors",      "HOU": "Rockets",
        "IND": "Pacers",       "LAC": "Clippers",      "LAL": "Lakers",
        "MEM": "Grizzlies",    "MIA": "Heat",          "MIL": "Bucks",
        "MIN": "Timberwolves", "NOP": "Pelicans",      "NYK": "Knicks",
        "OKC": "Thunder",      "ORL": "Magic",         "PHX": "Suns",
        "PHO": "Suns",         "POR": "Trail Blazers", "SAC": "Kings",
        "SAS": "Spurs",        "TOR": "Raptors",       "UTA": "Jazz",
        "WAS": "Wizards",
    },
    "Baseball": {
        "ARI": "Diamondbacks", "ATL": "Braves",        "ATH": "Athletics",
        "AZ":  "Diamondbacks", "BAL": "Orioles",
        "BOS": "Red Sox",      "CHC": "Cubs",          "CHW": "White Sox",
        "CIN": "Reds",         "CLG": "Guardians",     "CLE": "Guardians",
        "COL": "Rockies",      "CWS": "White Sox",     "DET": "Tigers",
        "HOU": "Astros",       "KC":  "Royals",
        "LAA": "Angels",       "LAD": "Dodgers",        "MIA": "Marlins",
        "MIL": "Brewers",      "MIN": "Twins",          "NYM": "Mets",
        "NYY": "Yankees",      "OAK": "Athletics",      "PHI": "Phillies",
        "PIT": "Pirates",      "SD":  "Padres",         "SEA": "Mariners",
        "SF":  "Giants",       "STL": "Cardinals",      "TB":  "Rays",
        "TEX": "Rangers",      "TOR": "Blue Jays",      "WSH": "Nationals",
    },
    "American Football": {
        "ARI": "Cardinals",    "ATL": "Falcons",       "BAL": "Ravens",
        "CAR": "Panthers",     "CHI": "Bears",         "CIN": "Bengals",
        "CLE": "Browns",       "DAL": "Cowboys",       "DEN": "Broncos",
        "DET": "Lions",        "GNB": "Packers",       "GB":  "Packers",
        "HOU": "Texans",       "IND": "Colts",         "JAX": "Jaguars",
        "KC":  "Chiefs",       "LAC": "Chargers",      "LAR": "Rams",
        "LVR": "Raiders",      "LV":  "Raiders",       "MIA": "Dolphins",
        "MIN": "Vikings",      "NE":  "Patriots",      "NO":  "Saints",
        "NYG": "Giants",       "NYJ": "Jets",          "PHI": "Eagles",
        "PIT": "Steelers",     "SEA": "Seahawks",      "SF":  "49ers",
        "TB":  "Buccaneers",   "TEN": "Titans",        "WAS": "Commanders",
    },
    "Soccer": {
        # MLS city/abbreviation codes used in Kalshi KXMLS tickers
        "ATL":  "Atlanta United FC",  "CLB":  "Columbus Crew",
        "CHI":  "Chicago Fire FC",    "NSH":  "Nashville SC",
        "CLT":  "Charlotte FC",       "PHI":  "Philadelphia Union",
        "DCU":  "DC United",          "DAL":  "FC Dallas",
        "HOU":  "Houston Dynamo",     "SEA":  "Seattle Sounders FC",
        "LAFC": "Los Angeles FC",     "LAG":  "Los Angeles Galaxy",
        "MIN":  "Minnesota United FC","MIA":  "Inter Miami CF",
        "ATX":  "Austin FC",          "NEM":  "New England Revolution",
        "MTL":  "CF Montreal",        "NYC":  "New York City FC",
        "STL":  "St. Louis City SC",  "NYRB": "New York Red Bulls",
        "CIN":  "FC Cincinnati",      "RSL":  "Real Salt Lake",
        "SKC":  "Sporting Kansas City","SJ":  "San Jose Earthquakes",
        "SD":   "San Diego FC",       "POR":  "Portland Timbers",
        "VAN":  "Vancouver Whitecaps FC", "TOR": "Toronto FC",
        "ORL":  "Orlando City SC",    "COL":  "Colorado Rapids",
        "SLC":  "Real Salt Lake",     "NE":   "New England Revolution",
        # European / International
        "RMA":  "Real Madrid",        "BMU":  "Bayern Munich",
        "ARS":  "Arsenal",            "SPO":  "Sporting CP",
        "LIV":  "Liverpool",          "LFC":  "Liverpool",
        "MC":   "Manchester City",
        "MUN":  "Manchester United",  "BAR":  "Barcelona",
        "FCB":  "Barcelona",
        "INT":  "Inter Milan",        "ACM":  "AC Milan",
        "PSG":  "PSG",                "JUV":  "Juventus",
        "ATL":  "Atletico Madrid",    "ATM":  "Atletico Madrid",
        "DOR":  "Borussia Dortmund",
        "BAY":  "Bayern Munich",      "LEI":  "RB Leipzig",
        "LEV":  "Bayer Leverkusen",   "VIL":  "Villarreal",
        "NAP":  "Napoli",             "ROM":  "AS Roma",
        "BEN":  "Benfica",            "POR":  "Porto",
        "AJA":  "Ajax",               "PSV":  "PSV Eindhoven",
        "FEY":  "Feyenoord",
        "GIR":  "Girona",             "CAS":  "Casa Pia",
        # South American
        "ARG":  "Argentinos Juniors", "BAN":  "Banfield",
        "IACC": "Instituto Córdoba",  "DYJ":  "Defensa y Justicia",
        # Polymarket slug abbreviations
        "IAC":  "Instituto Córdoba",  "DEF":  "Defensa y Justicia",
        "LAN":  "Lanús",              "IND":  "Independiente",
        "TUC":  "CA Tucumán",         "RIV":  "River Plate",
        "BOC":  "Boca Juniors",
        "VIL":  "Villarreal",         "BEN":  "Benfica",
    },
    "MMA": {
        "ALD": "Aldrich",      "ANK": "Ankalaev",      "BAR": "Barbosa",
        "BLA": "Blaydes",      "BOS": "Boser",         "BUR": "Burns",
        "BUZ": "Buzukja",      "CAS": "Castaneda",     "COS": "Costa",
        "COW": "Cowan",        "DEL": "Delano",        "DVA": "Dvalishvili",
        "EDW": "Edwards",      "EWI": "Ewing",         "FIG": "Figueiredo",
        "GAM": "Gamrot",       "GAN": "Gane",          "GAR": "Garry",
        "GAS": "Gastelum",     "GAT": "Gatto",         "GOR": "Gore",
        "HOL": "Holloway",     "IMA": "Imavov",        "JAN": "Jandiroba",
        "KAP": "Kape",         "LIM": "Lima",          "LOP": "Lopes",
        "LUC": "Luciano",      "MAD": "Maddalena",     "MOI": "Moicano",
        "MUH": "Muhammad",     "NAL": "Nallo",         "NAS": "Nascimento",
        "NUR": "Nurmagomedov", "OLI": "Oliveira",      "PAN": "Pantoja",
        "PAV": "Pavlovich",    "PET": "Petersen",      "PHI": "Phillips",
        "PIM": "Pimblett",     "PIT": "Pitbull",       "PLE": "Plessis",
        "PRO": "Procházka",    "RAD": "Radtke",        "RAK": "Rakhmonov",
        "RIB": "Ribeiro",      "ROD": "Rodriguez",     "SAN": "Sandhagen",
        "SIL": "Silva",        "STE": "Sterling",      "STR": "Strickland",
        "SUA": "Suarez",       "SWA": "Swanson",       "TAI": "Taira",
        "TSA": "Tsarukyan",    "TYB": "Tybura",        "USM": "Usman",
        "VAL": "Valentin",     "VAN": "Vannata",       "VOL": "Volkov",
        "WAL": "Walker",       "ZEC": "Zecchini",      "ZHE": "Zhelezniakova",
    }
}

# Greedy left-to-right: try all split points, pick first valid 2-team split
_TICKER_SUFFIX_RE = re.compile(
    r"-\d{2}[A-Z]{3}\d{2}(?:\d{4})?([A-Z]+)$", re.IGNORECASE
)

# Only decode teams from tickers that represent team-vs-team markets,
# not player prop markets (AST/GOAL/PTS/FIRSTGOAL/HITS/KS/STAT/2D/etc.)
_GAME_TICKER_RE = re.compile(
    r"KX(?:NHL|NBA|MLB|NFL|MLS|UFC|NCAAMB|NCAAF|UCL|UEL|UECL|EPL|BUNDESLIGA|LALIGA|SERIEA|LIGUE1|EREDIVISIE|LIGAPORTUGAL|SUPERLIG|JLEAGUE|KLEAGUE|PSL|CHNSL|ALEAGUE|NPB|KBO|AHL|KHL|SHL|VHL|UFL|FL1|ELC|EL1|EL2|ENL|ERE|ES2|BL2|COL1|LIB|SUD|SVK1|FR2|NOR|CZE1|GTM|PER1|RUS|UKR1|ROU1|ISP|SEA|SCOP|SPL)"
    r"(?:GAME|SPREAD|TOTAL|BTTS|NEXTGM|1HWINNER|2HWINNER|F5|TB|TEAMTOTAL|WINNER|DISTANCE|METHOD|1H|2H|(?=-))",
    re.IGNORECASE,
)

def get_market_type(ticker: str, title: str = "", platform: str = "kalshi") -> str:
    """
    Standardize the market type (winner, spread, total, btts, 1h, 2h, f5).
    """
    ticker_upper = ticker.upper()
    title_lower  = (title or "").lower()
    text = (ticker_upper + " " + title_lower)

    if platform == "kalshi":
        if "BTTS" in ticker_upper or "both teams to score" in title_lower:
            return "btts"
        if "SPREAD" in ticker_upper:
            return "spread"
        if "TOTAL" in ticker_upper:
            return "total"
        # Team-batter / per-player prop event tickers (e.g. KXMLBTB-..., KXNHLTB-...).
        # The market-type suffix sits directly after the sport prefix. Use a
        # regex to avoid false positives on TB team abbreviations (Tampa Bay).
        if re.search(r"KX[A-Z]+TB-", ticker_upper) or "TEAMTOTAL" in ticker_upper:
            return "team_total"
        if any(x in ticker_upper for x in ["1HWINNER", "1H"]) or "first half" in title_lower:
            return "1h"
        if any(x in ticker_upper for x in ["2HWINNER", "2H"]) or "second half" in title_lower:
            return "2h"
        if "F5" in ticker_upper or "first 5 innings" in title_lower:
            return "f5"
        if "-TIE" in ticker_upper or "-DRAW" in ticker_upper or " end in a draw" in title_lower:
            return "draw"
        # Series / futures / championship tickers resolve on a different time
        # horizon than a single game, so they must not be classified as a
        # game-winner market (which would mis-pair with Poly single-game markets).
        if "SERIES" in ticker_upper or "FUTURES" in ticker_upper or "CHAMPION" in ticker_upper:
            return "other"
        # Only classify as "winner" on an affirmative signal. Many prop-style
        # Kalshi event tickers (RFI, HR, SO, NEXTGM, …) otherwise silently fall
        # through as "winner" and get mis-paired with game-winner Poly markets.
        if "GAME" in ticker_upper or "MATCH" in ticker_upper or "WINNER" in ticker_upper or "winner" in title_lower:
            return "winner"
        return "other"
    else:
        # Polymarket slug / title
        text_l = text.lower()
        if any(x in text_l for x in ["-btts", "both teams to score", "both teams score", "teams score"]):
            return "btts"
        if "-spread" in text_l:
            return "spread"
        if any(x in text_l for x in ["-total", "-over-", "-under-", "o/u", " ou ", "-ou-", "over/under"]):
            return "total"
        if any(x in text_l for x in ["-1h-", "first half", "-1st-half"]):
            return "1h"
        if any(x in text_l for x in ["-2h-", "second half", "-2nd-half"]):
            return "2h"
        if "-draw" in text_l:
            return "draw"
        # Series / futures / championship / finals — long-horizon slugs
        # that must not pair with single-game Kalshi winners.
        if any(x in text_l for x in ["-series", "-futures", "-champion", "-finals", "-playoff", "-standings"]):
            return "other"
        # Player / game-state prop slugs (method of victory, first inning,
        # home runs, strikeouts, etc.). Keep this list conservative — only
        # add tokens that clearly indicate a non-winner market.
        if any(x in text_l for x in ["-method-", "-mov-", "-distance-", "-rfi-", "-homeruns-", "-strikeouts-", "-propbet-",
                                       "-points-", "-assists-", "-rebounds-", "-threes-", "-blocks-", "-steals-",
                                       "-rushing-", "-passing-", "-receiving-", "-touchdowns-", "-goals-", "-saves-",
                                       "-kills-", "-aces-", "-double-fault"]):
            return "other"
        return "winner"


def extract_kalshi_outcome(market_id: str, ticker: str, title: str, teams: list[str], sport: str) -> str:
    """Identify which team is the 'Yes' outcome for this Kalshi market."""
    ticker_upper = ticker.upper()
    market_id_upper = market_id.upper()
    title_lower = (title or "").lower()
    
    # 1. Check market_id suffix (most reliable)
    # KXUCL1H-26APR07SPOARS-ARS -> ARS
    m = re.search(r"-([A-Z0-9]+)$", market_id_upper)
    if m:
        code = m.group(1)
        if sport in _TICKER_CODE_MAP and code in _TICKER_CODE_MAP[sport]:
            return _TICKER_CODE_MAP[sport][code]
        # Fallback: search all maps
        for d in _TICKER_CODE_MAP.values():
            if code in d:
                return d[code]
        # Fallback 2: try to match code against the teams list
        for team in teams:
            t_norm = to_ascii(team).upper()
            if t_norm.startswith(code) or code.startswith(t_norm[:3]):
                return team
                
    # 2. Check title for team names
    for team in teams:
        t_low = team.lower()
        if f"will {t_low} win" in title_lower or f"win the {t_low}" in title_lower:
            return team

    return ""


def decode_ticker_teams(ticker: str) -> list[str]:
    """
    Extract two team nicknames from the game-code suffix of a Kalshi ticker.
    Only fires on team-vs-team game markets (not player props).
    Returns [] if the ticker doesn't match or codes aren't recognised.
    """
    if not _GAME_TICKER_RE.match(ticker):
        return []
    
    # Determine the sport from the ticker
    sport = "Unknown"
    if "KXNHL" in ticker.upper(): sport = "Ice Hockey"
    elif "KXNBA" in ticker.upper(): sport = "Basketball"
    elif "KXMLB" in ticker.upper(): sport = "Baseball"
    elif "KXNFL" in ticker.upper(): sport = "American Football"
    elif "KXMLS" in ticker.upper(): sport = "Soccer"
    elif "KXUFC" in ticker.upper(): sport = "MMA"
    
    m = _TICKER_SUFFIX_RE.search(ticker)
    if not m:
        return []
    suffix = m.group(1).upper()
    
    # Try sport-specific first, then fallback to searching all
    dicts_to_check = []
    if sport in _TICKER_CODE_MAP:
        dicts_to_check.append(_TICKER_CODE_MAP[sport])
    else:
        dicts_to_check = list(_TICKER_CODE_MAP.values())
    
    for i in range(2, len(suffix) - 1):
        a, b = suffix[:i], suffix[i:]
        for d in dicts_to_check:
            if a in d and b in d:
                ta, tb = d[a], d[b]
                if ta != tb:
                    return [ta, tb]
    return []


def classify_poly_sport(slug: str) -> str:
    """Return sport bucket from Polymarket slug, or '' if unknown."""
    slug_lower = (slug or "").lower()
    for prefix, (sport, _) in _SLUG_PREFIX_MAP.items():
        if slug_lower.startswith(prefix):
            return sport
    # keyword fallback on slug text
    slug_words = slug_lower.replace("-", " ")
    for keyword, sport in (
        ("dota", "Esports"), ("cs2", "Esports"), ("valorant", "Esports"),
        ("lol", "Esports"), ("overwatch", "Esports"), ("rainbow", "Esports"),
        ("soccer", "Soccer"), ("football", "Soccer"),
        ("basketball", "Basketball"), ("baseball", "Baseball"),
        ("hockey", "Ice Hockey"), ("tennis", "Tennis"), ("golf", "Golf"),
        ("f1", "Motorsport"), ("formula", "Motorsport"), ("nascar", "Motorsport"),
        ("ufc", "MMA"), ("boxing", "Boxing"), ("cricket", "Cricket"),
        ("rugby", "Rugby"), ("afl", "Australian Football"),
        # Golf tournament slugs lack "golf" but have these phrases
        ("masters tournament", "Golf"), ("pga championship", "Golf"),
        ("pga tour", "Golf"), ("lpga tour", "Golf"),
    ):
        if keyword in slug_words:
            return sport
    return ""


# ---------------------------------------------------------------------------
# Team canonicalization map (Variant -> Nickname)
# Used to resolve City names (Kalshi) and Full names (Poly) to shared Nicknames.
# ---------------------------------------------------------------------------
TEAM_CANONICAL_MAP = {
    "Ice Hockey": {
        "Anaheim": "Ducks", "Anaheim Ducks": "Ducks",
        "Boston": "Bruins", "Boston Bruins": "Bruins",
        "Buffalo": "Sabres", "Buffalo Sabres": "Sabres",
        "Calgary": "Flames", "Calgary Flames": "Flames",
        "Carolina": "Hurricanes", "Carolina Hurricanes": "Hurricanes",
        "Chicago": "Blackhawks", "Chicago Blackhawks": "Blackhawks",
        "Columbus": "Blue Jackets", "Columbus Blue Jackets": "Blue Jackets",
        "Colorado": "Avalanche", "Colorado Avalanche": "Avalanche",
        "Dallas": "Stars", "Dallas Stars": "Stars",
        "Detroit": "Red Wings", "Detroit Red Wings": "Red Wings",
        "Edmonton": "Oilers", "Edmonton Oilers": "Oilers",
        "Florida": "Panthers", "Florida Panthers": "Panthers",
        "Los Angeles": "Kings", "Los Angeles Kings": "Kings",
        "Minnesota": "Wild", "Minnesota Wild": "Wild",
        "Montreal": "Canadiens", "Montréal": "Canadiens", "Montreal Canadiens": "Canadiens", "Montréal Canadiens": "Canadiens",
        "Nashville": "Predators", "Nashville Predators": "Predators",
        "New Jersey": "Devils", "New Jersey Devils": "Devils",
        "NY Rangers": "Rangers", "New York Rangers": "Rangers",
        "NY Islanders": "Islanders", "New York Islanders": "Islanders",
        "Ottawa": "Senators", "Ottawa Senators": "Senators",
        "Philadelphia": "Flyers", "Philadelphia Flyers": "Flyers",
        "Pittsburgh": "Penguins", "Pittsburgh Penguins": "Penguins",
        "St. Louis": "Blues", "St. Louis Blues": "Blues",
        "San Jose": "Sharks", "San Jose Sharks": "Sharks",
        "Seattle": "Kraken", "Seattle Kraken": "Kraken",
        "Tampa Bay": "Lightning", "Tampa Bay Lightning": "Lightning", "Tampa": "Lightning",
        "Toronto": "Maple Leafs", "Toronto Maple Leafs": "Maple Leafs",
        "Utah": "Utah", "Utah Mammoth": "Utah", "Utah Hockey Club": "Utah",
        "Vancouver": "Canucks", "Vancouver Canucks": "Canucks",
        "Vegas": "Golden Knights", "Vegas Golden Knights": "Golden Knights",
        "Winnipeg": "Jets", "Winnipeg Jets": "Jets",
        "Washington": "Capitals", "Washington Capitals": "Capitals",
    },
    "Basketball": {
        "Atlanta": "Hawks", "Atlanta Hawks": "Hawks",
        "Boston": "Celtics", "Boston Celtics": "Celtics",
        "Brooklyn": "Nets", "Brooklyn Nets": "Nets",
        "Charlotte": "Hornets", "Charlotte Hornets": "Hornets",
        "Chicago": "Bulls", "Chicago Bulls": "Bulls",
        "Cleveland": "Cavaliers", "Cleveland Cavaliers": "Cavaliers",
        "Dallas": "Mavericks", "Dallas Mavericks": "Mavericks",
        "Denver": "Nuggets", "Denver Nuggets": "Nuggets",
        "Detroit": "Pistons", "Detroit Pistons": "Pistons",
        "Golden State": "Warriors", "Golden State Warriors": "Warriors",
        "Houston": "Rockets", "Houston Rockets": "Rockets",
        "Indiana": "Pacers", "Indiana Pacers": "Pacers",
        "LA Clippers": "Clippers", "Los Angeles Clippers": "Clippers",
        "LA Lakers": "Lakers", "Los Angeles Lakers": "Lakers",
        "Memphis": "Grizzlies", "Memphis Grizzlies": "Grizzlies",
        "Miami": "Heat", "Miami Heat": "Heat",
        "Milwaukee": "Bucks", "Milwaukee Bucks": "Bucks",
        "Minnesota": "Timberwolves", "Minnesota Timberwolves": "Timberwolves",
        "New Orleans": "Pelicans", "New Orleans Pelicans": "Pelicans",
        "New York": "Knicks", "New York Knicks": "Knicks",
        "Oklahoma City": "Thunder", "Oklahoma City Thunder": "Thunder",
        "Orlando": "Magic", "Orlando Magic": "Magic",
        "Philadelphia": "76ers", "Philadelphia 76ers": "76ers",
        "Phoenix": "Suns", "Phoenix Suns": "Suns",
        "Portland": "Trail Blazers", "Portland Trail Blazers": "Trail Blazers",
        "Sacramento": "Kings", "Sacramento Kings": "Kings",
        "San Antonio": "Spurs", "San Antonio Spurs": "Spurs",
        "Toronto": "Raptors", "Toronto Raptors": "Raptors",
        "Utah": "Jazz", "Utah Jazz": "Jazz",
        "Washington": "Wizards", "Washington Wizards": "Wizards",
    },
    "Baseball": {
        "Arizona": "Diamondbacks", "Arizona Diamondbacks": "Diamondbacks",
        "Atlanta": "Braves", "Atlanta Braves": "Braves",
        "Baltimore": "Orioles", "Baltimore Orioles": "Orioles",
        "Boston": "Red Sox", "Boston Red Sox": "Red Sox",
        "Chicago C": "Cubs", "Chicago Cubs": "Cubs",
        "Chicago WS": "White Sox", "Chicago White Sox": "White Sox",
        "Cincinnati": "Reds", "Cincinnati Reds": "Reds",
        "Cleveland": "Guardians", "Cleveland Guardians": "Guardians",
        "Colorado": "Rockies", "Colorado Rockies": "Rockies",
        "Detroit": "Tigers", "Detroit Tigers": "Tigers",
        "Houston": "Astros", "Houston Astros": "Astros",
        "Kansas City": "Royals", "Kansas City Royals": "Royals",
        "Los Angeles A": "Angels", "Los Angeles Angels": "Angels",
        "Los Angeles D": "Dodgers", "Los Angeles Dodgers": "Dodgers",
        "Miami": "Marlins", "Miami Marlins": "Marlins",
        "Milwaukee": "Brewers", "Milwaukee Brewers": "Brewers",
        "Minnesota": "Twins", "Minnesota Twins": "Twins",
        "New York M": "Mets", "New York Mets": "Mets",
        "New York Y": "Yankees", "New York Yankees": "Yankees",
        "Oakland": "Athletics", "Oakland Athletics": "Athletics",
        "Sacramento": "Athletics", "Sacramento Athletics": "Athletics",
        "Athletics": "Athletics",
        "Philadelphia": "Phillies", "Philadelphia Phillies": "Phillies",
        "Pittsburgh": "Pirates", "Pittsburgh Pirates": "Pirates",
        "San Diego": "Padres", "San Diego Padres": "Padres",
        "San Francisco": "Giants", "San Francisco Giants": "Giants",
        "Seattle": "Mariners", "Seattle Mariners": "Mariners",
        "St. Louis": "Cardinals", "St. Louis Cardinals": "Cardinals",
        "Tampa Bay": "Rays", "Tampa Bay Rays": "Rays",
        "Texas": "Rangers", "Texas Rangers": "Rangers",
        "Toronto": "Blue Jays", "Toronto Blue Jays": "Blue Jays",
        "Washington": "Nationals", "Washington Nationals": "Nationals",
    },
    "American Football": {
        "Arizona": "Cardinals", "Arizona Cardinals": "Cardinals",
        "Atlanta": "Falcons", "Atlanta Falcons": "Falcons",
        "Baltimore": "Ravens", "Baltimore Ravens": "Ravens",
        "Buffalo": "Bills", "Buffalo Bills": "Bills",
        "Carolina": "Panthers", "Carolina Panthers": "Panthers",
        "Chicago": "Bears", "Chicago Bears": "Bears",
        "Cincinnati": "Bengals", "Cincinnati Bengals": "Bengals",
        "Cleveland": "Browns", "Cleveland Browns": "Browns",
        "Dallas": "Cowboys", "Dallas Cowboys": "Cowboys",
        "Denver": "Broncos", "Denver Broncos": "Broncos",
        "Detroit": "Lions", "Detroit Lions": "Lions",
        "Green Bay": "Packers", "Green Bay Packers": "Packers",
        "Houston": "Texans", "Houston Texans": "Texans",
        "Indianapolis": "Colts", "Indianapolis Colts": "Colts",
        "Jacksonville": "Jaguars", "Jacksonville Jaguars": "Jaguars",
        "Kansas City": "Chiefs", "Kansas City Chiefs": "Chiefs",
        "Las Vegas": "Raiders", "Las Vegas Raiders": "Raiders",
        "Los Angeles R": "Rams", "Los Angeles Rams": "Rams",
        "Los Angeles C": "Chargers", "Los Angeles Chargers": "Chargers",
        "Miami": "Dolphins", "Miami Dolphins": "Dolphins",
        "Minnesota": "Vikings", "Minnesota Vikings": "Vikings",
        "New England": "Patriots", "New England Patriots": "Patriots",
        "New Orleans": "Saints", "New Orleans Saints": "Saints",
        "New York G": "Giants", "New York Giants": "Giants",
        "New York J": "Jets", "New York Jets": "Jets",
        "Philadelphia": "Eagles", "Philadelphia Eagles": "Eagles",
        "Pittsburgh": "Steelers", "Pittsburgh Steelers": "Steelers",
        "San Francisco": "49ers", "San Francisco 49ers": "49ers",
        "Seattle": "Seahawks", "Seattle Seahawks": "Seahawks",
        "Tampa Bay": "Buccaneers", "Tampa Bay Buccaneers": "Buccaneers",
        "Tennessee": "Titans", "Tennessee Titans": "Titans",
        "Washington": "Commanders", "Washington Commanders": "Commanders",
    },
    "Soccer": {
        # Bundesliga variants
        "Bayern Munich": "Bayern Munich", "Bayern Munchen": "Bayern Munich", "Bayern München": "Bayern Munich",
        "Dortmund": "Borussia Dortmund", "Borussia Dortmund": "Borussia Dortmund",
        "Leipzig": "RB Leipzig", "RB Leipzig": "RB Leipzig",
        "Frankfurt": "Eintracht Frankfurt", "Eintracht Frankfurt": "Eintracht Frankfurt",
        "Leverkusen": "Bayer Leverkusen", "Bayer Leverkusen": "Bayer Leverkusen",
        "Mönchengladbach": "Borussia Mönchengladbach", "M'gladbach": "Borussia Mönchengladbach", "Mgladbach": "Borussia Mönchengladbach",
        # K League: Kalshi uses city/short name, Polymarket uses FC prefix
        "Seoul": "FC Seoul",
        "Incheon Utd": "Incheon United", "Incheon": "Incheon United",
        # A-League: normalize FC suffix variants
        "Melbourne Victory FC": "Melbourne Victory",
        "Wellington Phoenix FC": "Wellington Phoenix",
        "Wellington": "Wellington Phoenix",
        "Auckland FC": "Auckland FC",
        "Central Coast Mariners FC": "Central Coast Mariners",
        "Brisbane Roar FC": "Brisbane Roar",
        # MLS: Polymarket uses full names, canonicalize common variants
        "Los Angeles Galaxy": "LA Galaxy",
        "Houston Dynamo FC": "Houston Dynamo",
        "D.C. United": "DC United",
        "CF Montréal": "CF Montreal", "CF Montreal": "CF Montreal",
        "St. Louis City SC": "St. Louis City SC",
        "Colorado Rapids SC": "Colorado Rapids",
        "D.C. United SC": "DC United",
        "Vancouver Whitecaps FC": "Vancouver Whitecaps",
        "Seattle Sounders FC": "Seattle Sounders",
        # Brasileirao
        "CA Mineiro": "Atletico Mineiro", "Atletico Mineiro": "Atletico Mineiro",
        "CA Paranaense": "Athletico Paranaense", "Athletico Paranaense": "Athletico Paranaense",
        "Santos FC": "Santos",
        # La Liga
        "Girona FC": "Girona", "Villarreal CF": "Villarreal",
        # Serie A
        "AC Milan": "Milan", "SSC Napoli": "Napoli",
        # Liga Portugal
        "SL Benfica": "Benfica", "Sport Lisboa e Benfica": "Benfica",
        "Casa Pia AC": "Casa Pia",
        # Argentine Primera
        "AA Argentinos Juniors": "Argentinos Juniors", "CA Banfield": "Banfield",
        "Instituto AC Córdoba": "Instituto Córdoba", "Instituto Cordoba": "Instituto Córdoba",
        "CSyD Defensa y Justicia": "Defensa y Justicia",
    }
}

# ---------------------------------------------------------------------------
# ASCII normalizer — strips diacritics so ü→u, é→e, ö→o, etc.
# Applied to BOTH team patterns and source text so "Bayern Munich" matches
# "FC Bayern M\ufffdnchen" (corrupted unicode from DB encoding issues).
# ---------------------------------------------------------------------------

def to_ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")


# ---------------------------------------------------------------------------
# Build single alternation regex  (O(n) per text instead of O(k*n))
# ---------------------------------------------------------------------------

def decode_poly_slug_teams(slug: str, sport: str = "") -> list[str]:
    """Extract team abbreviations from Polymarket slugs (e.g. 'arg-iac-def-2026-04-06')."""
    if not slug:
        return []
    
    parts = slug.lower().split("-")
    if len(parts) < 3:
        return []
        
    # Potential sports are in _TICKER_CODE_MAP
    # Slugs like 'mlb-sd-pit-2026-04-06'
    # Try to match the first 3-4 parts as abbreviations
    results = []
    
    # We don't know the exact format, but usually it is: league-team1-team2-...
    # Let's check all codes in _TICKER_CODE_MAP for all sports
    # To be safe, we only check for the sport we think it is.
    
    potential_sports = [sport] if sport in _TICKER_CODE_MAP else list(_TICKER_CODE_MAP.keys())
    
    for part in parts:
        if len(part) < 2: continue
        # Skip date parts
        if part.isdigit() and len(part) >= 4: continue

        # Try raw part, then with trailing digits stripped (e.g. "psg1" → "psg")
        candidates = [part.upper()]
        stripped = part.rstrip("0123456789").upper()
        if stripped and stripped != part.upper():
            candidates.append(stripped)

        for s in potential_sports:
            code_map = _TICKER_CODE_MAP[s]
            for code in candidates:
                if code in code_map:
                    team = code_map[code]
                    if team not in results:
                        results.append(team)
                    break

    return results

def build_team_regex(filename="Sports.txt"):
    """
    Read Sports.txt, keep only proper-name entries, sort longest-first so the
    regex engine prefers multi-word names over substrings, compile ONE pattern.

    Patterns are ASCII-normalized so they match even when source data has
    corrupted or variant unicode (e.g. "Bayern Munchen" matches "Bayern Munich").

    Returns (pattern, canonical_map) where canonical_map: ascii_lower → canonical.
    """
    path = os.path.join(CATEGORIES_DIR, filename)
    names = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if not any(c.isupper() for c in name):
                continue         # skip generic lowercase keywords
            lower = name.lower()
            if lower in GENERIC_TERMS or len(lower) < MIN_TEAM_LEN:
                continue
            names.append(name)

    # Longest-first → regex engine picks "Manchester United" over "United"
    names.sort(key=len, reverse=True)

    # Build regex on ASCII-normalized names; periods stripped so "St. Pauli"
    # becomes "St Pauli" and matches normalized titles that drop punctuation.
    ascii_names = [to_ascii(n) for n in names]

    pattern = re.compile(
        r"\b(" + "|".join(re.escape(n) for n in ascii_names) + r")\b",
        re.IGNORECASE,
    )
    # canonical_map: ascii_lower → original canonical name
    canonical_map = {to_ascii(n).lower(): n for n in names}
    return pattern, canonical_map


# ---------------------------------------------------------------------------
# Team extractor — single findall pass on ASCII-normalized text
# ---------------------------------------------------------------------------

def extract_teams(text: str, pattern, canonical_map, sport: str = "") -> list[str]:
    """ASCII-normalize text, one regex pass, return de-duplicated canonical names."""
    seen, result = set(), []
    for m in pattern.findall(to_ascii(text)):
        key = m.lower()
        team_name = canonical_map.get(key, m)

        # Apply canonicalization if sport is specified
        if sport and sport in TEAM_CANONICAL_MAP:
            team_name = TEAM_CANONICAL_MAP[sport].get(team_name, team_name)

        if team_name.lower() not in seen:
            seen.add(team_name.lower())
            result.append(team_name)
    return result


# ---------------------------------------------------------------------------
# Date parsers
# ---------------------------------------------------------------------------

def parse_date(s: str):
    if not s:
        return None
    # Handle '2026-04-06 22:40:00+00' and similar
    s = s.replace("+00", "+0000")
    for fmt in (
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M%z",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(s[:26].strip(), fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_expiry_date(s: str):
    """Like parse_date, but treats date-only strings as end-of-day UTC (23:59:59).
    Prevents filtering out today's games whose Polymarket endDateIso is just a date."""
    if not s:
        return None
    dt = parse_date(s)
    if dt and len(s.strip()) <= 10:   # date-only: "2026-04-08"
        dt = dt.replace(hour=23, minute=59, second=59)
    return dt


# Kalshi event tickers embed the game date AND optional time:
#   KXBUNDESLIGA1H-26APR05UNISTP        → date only
#   KXLOLGAME-26APR051315G2FNC-FNC      → date + 1315 UTC
# close_time is ~14 days after the game (settlement period) — use ticker instead
_TICKER_DATE_RE = re.compile(
    r"-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{4})?",
    re.IGNORECASE,
)
_MONTH = {m: i for i, m in enumerate(
    ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"], 1
)}

def parse_ticker_date(ticker: str):
    """Extract game datetime from Kalshi event ticker (falls back to None).
    Captures embedded HHMM time when present (e.g. 26APR051315 → 13:15 UTC).
    """
    m = _TICKER_DATE_RE.search(ticker)
    if m:
        year  = 2000 + int(m.group(1))
        month = _MONTH[m.group(2).upper()]
        day   = int(m.group(3))
        try:
            if m.group(4):
                hhmm = m.group(4)
                hour, minute = int(hhmm[:2]), int(hhmm[2:])
                return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
            return datetime(year, month, day, tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


_VS_RE = re.compile(r"vs\.?\s+", re.IGNORECASE)
_WILL_WIN_RE = re.compile(r'\bwill\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+win\b', re.IGNORECASE)

_GOLF_TOURNAMENT_KEYWORDS = (
    "masters", "pga championship", "us open", "open championship",
    "british open", "tour championship", "lpga",
)


def extract_outright_winner(title: str, raw_data: dict = None) -> list[str]:
    """
    Extract a single player/team surname from outright winner markets.
    e.g. "Will Scottie Scheffler win the 2026 Masters tournament?" → ["Scheffler"]
    Uses groupItemTitle (Polymarket NegRisk field) when available, else regex.
    """
    if raw_data:
        git = (raw_data.get("groupItemTitle") or "").strip()
        if git and len(git.split()) <= 4:
            return [git.split()[-1]]   # surname
    m = _WILL_WIN_RE.search(title)
    if m:
        words = m.group(1).strip().split()
        if words:
            return [words[-1]]         # surname
    return []


def extract_player_names(title: str) -> list[str]:
    """
    Extract two player surnames from a head-to-head title.
    Handles:
      - Simple:  'Lehecka vs Nava'
      - Prefixed: 'Monte Carlo Masters: Baez vs Wawrinka'
      - Kalshi:  'Will Roberto Bautista Agut win the Bautista Agut vs Berrettini : Round Of 64 match?'
    Returns [] if fewer than 2 distinct surnames found.
    """
    # Find "vs" anywhere — split there, extract last cap word from left
    # and last cap word from right (after stripping trailing junk).
    parts = _VS_RE.split(title, maxsplit=1)
    if len(parts) < 2:
        return []

    left_raw  = parts[0].strip()
    right_raw = parts[1].strip()

    # Strip trailing junk from the right side:
    #   "Berrettini : Round Of 64 match?" → "Berrettini"
    #   "Wawrinka Winner?" → "Wawrinka"
    right_clean = re.sub(r"\s*[:|]\s*.*$", "", right_raw).strip()
    right_clean = re.sub(r"\s+[-–]\s+.*$", "", right_clean).strip()
    right_clean = re.sub(
        r"\s+(Round|Winner|Match|Final|Quarter|Semi|Game|Set)\b.*$",
        "", right_clean, flags=re.IGNORECASE,
    ).strip()

    left_words  = left_raw.split()
    right_words = right_clean.split()

    if not left_words or not right_words:
        return []

    # Use the last capitalised token of each side (surname)
    lname = next((w for w in reversed(left_words)  if w[0].isupper() and len(w) >= 3), None)
    rname = next((w for w in reversed(right_words) if w[0].isupper() and len(w) >= 3), None)

    if lname and rname and lname.lower() != rname.lower():
        return [lname, rname]
    return []


# Polymarket slug fragments that indicate a non-winner market type.
# These markets have the same two teams but a different outcome space
# (e.g. "will they draw?", "will the home side cover -1.5?") and cannot
# be paired with a Kalshi winner market.
_INCOMPATIBLE_SLUG_FRAGMENTS = (
    "-draw",
    "-spread-",
    "-total-",
    "-over-",
    "-under-",
    "-overtime",
    "-series",
    "-exact-score",
    "-score-",
    "-halftime-",
    # Tennis prop markets — only want full-match winner
    "-first-set-",
    "-set-winner",
    "-set-game",
    "-match-total",
    "-set-totals",
    "-set-total",
    "-set-handicap",
    "-handicap",
    # We now allow -1h- and -2h- but only if both platforms match
    # Baseball prop markets — first inning, run scoring props
    "-nrfi",
    "-yrfi",
    "-first-inning",
    "-1st-inning",
    "-run-scored",
    "-innings-",
    # Esports prop markets
    "-first-blood",
    "-first-tower",
    "-first-dragon",
    "-first-baron",
    "-any-player",
    "-game1",
    "-game2",
    "-game3",
    "-game4",
    "-game5",
    "-map1",
    "-map2",
    "-map3",
    # General prop/variant markets
    "-leading-at",
    "-halftime-result",
    "-corner",
    "-penalty",
    "-clean-sheet",
    "-anytime",
)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run():
    print("Building team regex from Sports.txt …")
    pattern, canonical_map = build_team_regex()
    print(f"  {len(canonical_map)} team/club names loaded")

    conn = get_connection()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")

    # ── Fetch Polymarket sports markets ────────────────────────────────────
    print("Fetching Polymarket sports markets …")
    poly_rows = conn.execute("""
        SELECT
            mn.market_id,
            mn.normalized_title,
            mn.outcome,
            mr.title                               AS raw_title,
            mr.raw_data                            AS poly_raw
        FROM markets_normalized mn
        JOIN markets_raw mr ON mn.raw_id = mr.id
        WHERE mn.platform = 'polymarket'
          AND (mn.category LIKE 'sports%' OR mn.category = '')
    """).fetchall()
    print(f"  {len(poly_rows)} Polymarket sports rows")

    # ── Fetch Kalshi sports markets ─────────────────────────────────────────
    print("Fetching Kalshi sports markets …")
    kalshi_rows = conn.execute("""
        SELECT
            mn.market_id,
            mn.normalized_title,
            mr.title                               AS raw_title,
            mr.raw_data                            AS kalshi_raw
        FROM markets_normalized mn
        JOIN markets_raw mr ON mn.raw_id = mr.id
        WHERE mn.platform = 'kalshi'
          AND mn.category = 'sports_fees_v2'
    """).fetchall()
    print(f"  {len(kalshi_rows)} Kalshi sports rows")

    conn.close()

    # ── Build Kalshi event records ──────────────────────────────────────────
    # Group by event_ticker; merge teams across contracts of the same event
    print("Extracting teams from Kalshi markets …")
    kalshi_events: dict[str, dict] = {}

    for row in kalshi_rows:
        raw_data = {}
        try:
            raw_data = json.loads(row["kalshi_raw"] or "{}")
        except:
            pass

        ticker = raw_data.get("event_ticker") or row["market_id"]

        # Skip known bundle/parlay event tickers
        if any(f in ticker.upper() for f in BUNDLE_TICKER_FRAGMENTS):
            continue

        ksport, _ = classify_sport(ticker)

        # Golf outright markets (KXPGATOUR, KXLPGATOUR, etc.) share a single
        # event_ticker across all players in the field. Grouping by event_ticker
        # would accumulate all ~80 golfers into one "event" and then the
        # MAX_TEAMS_KALSHI filter would discard it. Treat each player contract
        # as its own independent event instead.
        GOLF_OUTRIGHT_PREFIXES = ("KXPGATOUR", "KXPGAMAJOR", "KXLPGATOUR", "KXDPWORLDTOUR")
        if ksport == "Golf" and any(ticker.upper().startswith(p) for p in GOLF_OUTRIGHT_PREFIXES):
            ticker = row["market_id"]
        text  = (row["raw_title"] or "") + " " + (row["normalized_title"] or "")
        teams = extract_teams(text, pattern, canonical_map, ksport)

        if "Instituto" in text or "Defensa" in text:
            print(f"DEBUG Kalshi Soccer: {text} -> {teams}")

        # Supplement with ticker-decoded teams (handles city-name titles like
        # "Boston at Tampa Bay Winner?" where nicknames aren't in the text)
        ticker_teams = decode_ticker_teams(ticker)
        if ticker_teams:
            seen_lc = {t.lower() for t in teams}
            for t in ticker_teams:
                # Apply sport canonical map so decoded names match extract_teams output
                if ksport in TEAM_CANONICAL_MAP:
                    t = TEAM_CANONICAL_MAP[ksport].get(t, t)
                if t.lower() not in seen_lc:
                    teams.append(t)
                    seen_lc.add(t.lower())

        # For tennis / golf H2H: fall back to extracting player names from the title
        if not teams and ksport in ("Tennis", "Golf"):
            teams = extract_player_names(row["raw_title"] or "")
        # For golf outright winner markets: extract the single player name
        if not teams and ksport == "Golf":
            teams = extract_outright_winner(row["raw_title"] or "", raw_data)

        # If ticker decode produced exactly 2 teams but title extraction pushed the
        # total over the limit (e.g. "New York" extracted alongside "Sabres"+"Rangers"),
        # trust the ticker — it encodes exactly the two teams playing.
        if len(teams) > MAX_TEAMS_KALSHI and len(ticker_teams) == MAX_TEAMS_KALSHI:
            teams = ticker_teams

        # Skip markets where >MAX_TEAMS teams extracted (bundles, season winners)
        if len(teams) > MAX_TEAMS_KALSHI:
            continue

        if ticker not in kalshi_events:
            # Game date: prefer ticker date, then expected_expiration_time (actual
            # tournament/game end), then close_time (settlement, ~14d later).
            dt = (parse_ticker_date(ticker)
                  or parse_date(raw_data.get("expected_expiration_time"))
                  or parse_date(raw_data.get("close_time")))
            ksport, _ = classify_sport(ticker)

            kalshi_events[ticker] = {
                "event_ticker": ticker,
                "teams":        teams,
                "date":         dt,
                "sport":        ksport,
                "url":          f"https://kalshi.com/markets/{ticker}",
                "raw_data":     raw_data,
                "markets":      [],
            }
        
        # Accumulate teams from additional contracts of the same event
        ev      = kalshi_events[ticker]
        seen_lc = {t.lower() for t in ev["teams"]}
        for t in teams:
            if t.lower() not in seen_lc:
                ev["teams"].append(t)
                seen_lc.add(t.lower())
        
        # Add individual market details
        ev["markets"].append({
            "market_id":    row["market_id"],
            "title":        row["raw_title"] or row["normalized_title"],
            "market_type":  get_market_type(ticker, row["raw_title"], "kalshi"),
            "outcome_team": extract_kalshi_outcome(row["market_id"], ticker, row["raw_title"], ev["teams"], ev["sport"]),
        })

    # Post-accumulation filter: drop events whose total team count exceeds limit
    kalshi_events = {
        k: v for k, v in kalshi_events.items()
        if len(v["teams"]) <= MAX_TEAMS_KALSHI
    }

    # Drop Kalshi 3-way events (any event that has a -TIE/-DRAW contract).
    # V6.3 matcher cannot reliably align a 3-outcome Kalshi event against a
    # 2-outcome Polymarket market — avoid them entirely, per team decision
    # ("avoid 3-outcome markets completely until V6.4 is ready").
    # NOTE: check the per-contract market_id, not the event_ticker — the event
    # ticker itself does not carry the -TIE suffix.
    def _has_3way_contract(ev):
        for m in ev["markets"]:
            mid = (m.get("market_id") or "").upper()
            if "-TIE" in mid or "-DRAW" in mid:
                return True
            if (m.get("market_type") or "") == "draw":
                return True
        return False

    kalshi_events = {
        k: v for k, v in kalshi_events.items()
        if not _has_3way_contract(v)
    }

    print(f"  {len(kalshi_events)} unique Kalshi events after bundle filtering")

    # ── (team_lower, date) index for O(1) candidate lookup ─────────────────
    kalshi_index: dict[tuple, list] = defaultdict(list)
    for ev in kalshi_events.values():
        if ev["date"]:
            for team in ev["teams"]:
                kalshi_index[(team.lower(), ev["date"].date())].append(ev)

    # ── Match Polymarket → Kalshi ───────────────────────────────────────────
    # Strategy:
    #   1. For every poly market find all Kalshi events that share ≥1 team
    #      within ±DATE_WINDOW days (order-independent via set intersection).
    #   2. Score = (shared_team_count, -days_apart).
    #   3. Keep only HIGH confidence (≥2 shared teams).
    #   4. Deduplicate: each Kalshi market gets its single best Poly match.
    print("Matching Polymarket -> Kalshi (order-independent) ...")

    # best_for_kalshi[market_id] = (score_tuple, result_dict)
    best_for_kalshi: dict[str, tuple] = {}

    for row in poly_rows:
        poly_raw = {}
        try:
            poly_raw = json.loads(row["poly_raw"] or "{}")
        except:
            pass

        slug       = poly_raw.get("slug") or ""

        # Skip non-winner market types (draw, spread, total, etc.) — they share
        # team names with winner markets but have a different outcome space and
        # cannot be validly paired with a Kalshi winner/1H-winner contract.
        slug_lc = slug.lower()
        if any(frag in slug_lc for frag in _INCOMPATIBLE_SLUG_FRAGMENTS):
            continue

        poly_market_type = get_market_type(slug, row["raw_title"], "polymarket")
        poly_sport       = classify_poly_sport(slug)
        # Include slug in text to help extract teams from abbreviations/identifiers
        text             = (row["outcome"] or "") + " " + (row["raw_title"] or "") + " " + (row["normalized_title"] or "") + " " + slug
        poly_teams       = extract_teams(text, pattern, canonical_map, poly_sport)

        # Supplement with slug-decoded teams (handles abbreviations like 'sd', 'pit' in slugs)
        slug_teams = decode_poly_slug_teams(slug, poly_sport)
        if slug_teams:
            seen_lc = {t.lower() for t in poly_teams}
            for t in slug_teams:
                # Apply sport canonical map to decoded names
                if poly_sport in TEAM_CANONICAL_MAP:
                    t = TEAM_CANONICAL_MAP[poly_sport].get(t, t)
                if t.lower() not in seen_lc:
                    poly_teams.append(t)
                    seen_lc.add(t.lower())

        # If slug decode produced exactly 2 teams but text extraction pushed the total
        # over 2 (e.g. city name "Cleveland" matching Cavaliers/Guardians/Browns alongside
        # the actual AHL team), trust the slug — it encodes exactly the two teams playing.
        if len(poly_teams) > 2 and len(slug_teams) == 2:
            poly_teams = slug_teams

        # Skip Polymarket markets where > 2 teams were extracted (bundle/season markets),
        # unless it is a tournament sport (Golf/Tennis) which legitimately has 1 team.
        if len(poly_teams) > 2 and poly_sport not in _TOURNAMENT_SPORTS:
            continue

        # Tennis / golf H2H: fall back to player names extracted from the title
        if not poly_teams and poly_sport in ("Tennis", "Golf"):
            poly_teams = extract_player_names(row["raw_title"] or "")
        # Golf outright winner: use groupItemTitle or "Will X win" regex
        if not poly_teams and poly_sport == "Golf":
            poly_teams = extract_outright_winner(row["raw_title"] or "", poly_raw)
        # Also try outright extraction on unknown-sport markets whose slug/title looks like golf
        if not poly_teams:
            raw_title_lc = (row["raw_title"] or "").lower()
            if any(kw in raw_title_lc for kw in _GOLF_TOURNAMENT_KEYWORDS):
                poly_teams = extract_outright_winner(row["raw_title"] or "", poly_raw)
                if poly_teams:
                    poly_sport = "Golf"

        if "Instituto" in text or "Defensa" in text:
            print(f"DEBUG Soccer: {text} -> {poly_teams}")

        poly_date = parse_date(poly_raw.get("gameStartTime") or poly_raw.get("endDateIso") or poly_raw.get("endDate") or poly_raw.get("closeTime"))
        if not poly_date:
            continue

        # Slugs encode the LOCAL game date (e.g. mlb-tex-lad-2026-04-11).
        # For late-evening US games that cross midnight UTC (e.g. 9 PM CT = 2 AM
        # UTC next day), gameStartTime rolls over to the next calendar date.
        # When the slug date is exactly 1 day before the UTC-derived date, trust
        # the slug — it is always the correct local game date for matching.
        _slug_date_m = re.search(r"(\d{4})-(\d{2})-(\d{2})(?:-|$)", slug)
        if _slug_date_m:
            try:
                slug_dt = datetime(
                    int(_slug_date_m.group(1)),
                    int(_slug_date_m.group(2)),
                    int(_slug_date_m.group(3)),
                    tzinfo=timezone.utc,
                )
                if (poly_date.date() - slug_dt.date()).days == 1:
                    poly_date = slug_dt
            except ValueError:
                pass

        poly_set = {t.lower() for t in poly_teams}
        poly_url = f"https://polymarket.com/event/{slug}" if slug else ""

        # Gather all Kalshi candidates that share at least one team.
        # Tennis/golf Polymarket markets use tournament end date (up to 2 weeks
        # away), so use a wider window for those sports.
        date_window = 14 if poly_sport in ("Tennis", "Golf") else DATE_WINDOW
        candidates: dict[str, dict] = {}
        for delta in range(-date_window, date_window + 1):
            check = (poly_date + timedelta(days=delta)).date()
            for team in poly_teams:                              # permutation: every team tried
                for ev in kalshi_index.get((team.lower(), check), []):
                    # Sport-gate: reject if both platforms have a known but
                    # different sport (e.g. Soccer vs Esports)
                    if (poly_sport and ev["sport"] != "Sports"
                            and poly_sport != ev["sport"]):
                        continue
                    candidates[ev["event_ticker"]] = ev

        for ev in candidates.values():
            kalshi_set = {t.lower() for t in ev["teams"]}
            shared     = poly_set & kalshi_set

            if len(shared) < 2:
                # Golf outright winner markets only share one player name.
                # Allow if: exactly 1 shared player + both titles name the same tournament.
                is_golf_outright = (
                    ev["sport"] == "Golf"
                    and len(shared) == 1
                    and len(ev["teams"]) == 1   # Kalshi side is also a single-player market
                )
                if not is_golf_outright:
                    continue

            # Golf: Kalshi markets are always "will X WIN the tournament".
            # Only pair with Polymarket markets that ask the same question.
            # Reject anything else (lowest round, debutant, make cut, etc.).
            if ev["sport"] == "Golf":
                slug_lower_g = slug.lower()
                poly_title_g = (row["raw_title"] or "").lower()
                is_win_market = (
                    "will-" in slug_lower_g and "-win-" in slug_lower_g
                ) or (
                    "will " in poly_title_g and " win " in poly_title_g
                )
                if not is_win_market:
                    continue
                k_title = ev.get("raw_data", {}).get("title", "").lower()
                p_title = (row["raw_title"] or "").lower()
                if not any(kw in k_title and kw in p_title for kw in _GOLF_TOURNAMENT_KEYWORDS):
                    continue

            days_apart = abs((poly_date.date() - ev["date"].date()).days)

            # For regular team sports, reject cross-day matches (different games).
            # Tournament sports (Golf, Tennis) resolve over multiple days so are exempt.
            if ev["sport"] not in _TOURNAMENT_SPORTS and days_apart > 1:
                continue

            score = (len(shared), -days_apart)             # higher shared > fewer days

            # For each market in the event, check if it matches poly_market_type and outcome
            for mkt in ev["markets"]:
                if poly_market_type != mkt["market_type"]:
                    continue
                
                # Outcome alignment: If both have specific outcome teams, they must match
                poly_outcome = row["outcome"]
                kalshi_outcome = mkt["outcome_team"]
                
                if poly_outcome and kalshi_outcome:
                    p_out_norm = to_ascii(poly_outcome.lower())
                    k_out_norm = to_ascii(kalshi_outcome.lower())
                    if p_out_norm not in k_out_norm and k_out_norm not in p_out_norm:
                        continue

                ticker = ev["event_ticker"]
                mkt_id = mkt["market_id"]
                if mkt_id not in best_for_kalshi or score > best_for_kalshi[mkt_id][0]:
                    sport, league = classify_sport(ticker, slug)
                    
                    # Get Kalshi raw_data
                    kalshi_raw = ev.get("raw_data", {})

                    # Outcomes and tokens
                    outcomes_raw = poly_raw.get("outcomes")
                    if isinstance(outcomes_raw, str):
                        try:
                            outcomes = json.loads(outcomes_raw)
                        except:
                            outcomes = [outcomes_raw]
                    else:
                        outcomes = outcomes_raw or []

                    primary_outcome = row["outcome"]
                    if not primary_outcome and outcomes:
                        primary_outcome = outcomes[0]

                    # Normalize token IDs and align with outcomes
                    token_ids = _normalize_token_ids_list(poly_raw.get("clobTokenIds", []))

                    # Reorder so primary_outcome token is always at index 0
                    if (primary_outcome and len(outcomes) >= 2 and len(token_ids) >= 2
                            and outcomes[0].strip().lower() != primary_outcome.strip().lower()
                            and outcomes[1].strip().lower() == primary_outcome.strip().lower()):
                        outcomes = [outcomes[1], outcomes[0]]
                        token_ids = [token_ids[1], token_ids[0]]

                    best_for_kalshi[mkt_id] = (score, {
                        "sport":               sport,
                        "league":              league,
                        "confidence":          "high",
                        "shared_teams":        "; ".join(sorted(shared)),
                        "days_apart":          days_apart,
                        "poly_market_id":      row["market_id"],
                        "poly_title":          " ".join(poly_teams).lower(),
                        "poly_outcome":        primary_outcome,
                        "poly_teams":          "; ".join(poly_teams),
                        "poly_date":           poly_date.strftime("%Y-%m-%d"),
                        "poly_url":            poly_url,
                        "poly_slug":           slug,
                        "poly_event_url":      poly_url,
                        "poly_outcomes":       json.dumps(outcomes),
                        "poly_token_ids":      json.dumps(token_ids),
                        "expiry_poly_utc":     poly_raw.get("endDateIso") or poly_raw.get("closeTime", ""),
                        "resolution_time":     poly_raw.get("endDateIso") or "",
                        "kalshi_event_ticker": ticker,
                        "kalshi_market_id":    mkt_id,
                        "kalshi_title":        mkt["title"],
                        "kalshi_teams":        "; ".join(ev["teams"]),
                        "kalshi_date":         ev["date"].strftime("%Y-%m-%d"),
                        "kalshi_url":          f"https://kalshi.com/markets/{mkt_id}",
                        "expiry_kalshi_utc":   kalshi_raw.get("close_time", ""),
                    })

    # V6.32: merge both Kalshi per-team tickers for the same game into one row.
    # When two rows share the same poly_market_id, the second Kalshi ticker is
    # stored in kalshi_market_id_b so the bot can see all 6 prices from a
    # single row: K teamA YES/NO, K teamB YES/NO, P teamA, P teamB.
    _seen_poly: dict[str, dict] = {}
    for rec in (rec for _, rec in best_for_kalshi.values()):
        pmid = rec["poly_market_id"]
        if pmid not in _seen_poly:
            rec.setdefault("kalshi_market_id_b", "")
            _seen_poly[pmid] = rec
        else:
            _seen_poly[pmid]["kalshi_market_id_b"] = rec["kalshi_market_id"]
    results = list(_seen_poly.values())

    # Filter out expired markets. Allow live/in-progress games whose
    # Polymarket endDateIso has already ticked past midnight UTC (date-only
    # timestamps parse as midnight), giving them a 6-hour grace window.
    # For tournament sports (Golf, Tennis) the resolution date can be weeks
    # away — skip the tonight-only ceiling for those.
    # For all other sports, only show games happening tonight (today in UTC,
    # +1 day buffer to capture late US evening games that resolve past midnight UTC).
    now_utc        = datetime.now(timezone.utc)
    tonight_cutoff = (now_utc + timedelta(days=1)).date()
    live_floor     = now_utc - timedelta(hours=6)
    results = [
        r for r in results
        if (r["sport"] in _TOURNAMENT_SPORTS
            or r["kalshi_date"] <= tonight_cutoff.isoformat())
        and (parse_expiry_date(r["expiry_poly_utc"]) or now_utc) > live_floor
    ]

    # Sort: most shared teams first, then fewest days apart
    results.sort(key=lambda r: (-len(r["shared_teams"].split(";")), r["days_apart"]))

    print(f"  {len(results)} high-confidence game pairs")

    # ── Write CSV ──────────────────────────────────────────────────────────
    if not results:
        print("No matches found — CSV not written.")
        return

    fieldnames = [
        "sport", "league", "confidence", "shared_teams", "days_apart",
        "poly_market_id", "poly_title", "poly_outcome",
        "poly_teams", "poly_date", "poly_url", "poly_slug",
        "poly_event_url", "poly_outcomes", "poly_token_ids",
        "expiry_poly_utc", "resolution_time",
        "kalshi_event_ticker", "kalshi_market_id", "kalshi_market_id_b", "kalshi_title",
        "kalshi_teams", "kalshi_date", "kalshi_url", "expiry_kalshi_utc",
    ]

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)

    print(f"Done. Written to {OUTPUT_FILE}")


if __name__ == "__main__":
    run()
