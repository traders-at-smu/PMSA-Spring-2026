import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "..", "markets.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    # Global WAL mode and memory-mapped I/O for faster reads (ResearchNotes §4)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA mmap_size=2147483648")  # 2 GB
    return conn


def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS markets_raw (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            platform     TEXT    NOT NULL,
            market_id    TEXT    NOT NULL,
            title        TEXT,
            description  TEXT,
            category     TEXT,
            end_date     TEXT,
            raw_data     TEXT,
            fetched_at   TEXT    DEFAULT (datetime('now')),
            UNIQUE(platform, market_id)
        );

        CREATE TABLE IF NOT EXISTS markets_normalized (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            raw_id            INTEGER REFERENCES markets_raw(id),
            platform          TEXT    NOT NULL,
            market_id         TEXT    NOT NULL,
            outcome           TEXT    NOT NULL DEFAULT '',
            category          TEXT,
            normalized_title  TEXT,
            UNIQUE(platform, market_id, outcome)
        );

        -- Incremental scraping: track last successful fetch per platform (ResearchNotes §5)
        CREATE TABLE IF NOT EXISTS scrape_state (
            platform       TEXT PRIMARY KEY,
            last_fetched_at TEXT NOT NULL
        );
    """)

    # Migrations
    for col, definition in [
        ("outcome",  "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT"),
    ]:
        try:
            cursor.execute(f"ALTER TABLE markets_normalized ADD COLUMN {col} {definition}")
            conn.commit()
        except sqlite3.OperationalError:
            pass

    # Composite index on (platform, market_id) — ResearchNotes §4
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_raw_platform_market
        ON markets_raw(platform, market_id)
    """)
    # Index for the title-matching join
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_norm_title
        ON markets_normalized(normalized_title)
    """)

    conn.commit()
    conn.close()
    print("Database initialized.")


def get_last_fetched(platform: str) -> str | None:
    """Return the ISO timestamp of the last successful scrape, or None."""
    conn = get_connection()
    row = conn.execute(
        "SELECT last_fetched_at FROM scrape_state WHERE platform = ?", (platform,)
    ).fetchone()
    conn.close()
    return row["last_fetched_at"] if row else None


def set_last_fetched(platform: str, timestamp: str):
    """Record a successful scrape timestamp for incremental scraping."""
    conn = get_connection()
    conn.execute(
        "INSERT OR REPLACE INTO scrape_state (platform, last_fetched_at) VALUES (?, ?)",
        (platform, timestamp),
    )
    conn.commit()
    conn.close()
