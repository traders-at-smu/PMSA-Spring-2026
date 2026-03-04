"""SQLite-backed state store for raw pulls, opportunities, controls, and order ledger."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class StateStore:
    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS runtime_control (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    mode TEXT NOT NULL,
                    arm_live INTEGER NOT NULL,
                    confirm_token TEXT,
                    confirm_expires_at TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS cycles (
                    cycle_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    raw_kalshi_json TEXT NOT NULL,
                    raw_polymarket_json TEXT NOT NULL,
                    snapshots_json TEXT NOT NULL,
                    opportunities_json TEXT NOT NULL,
                    errors_json TEXT NOT NULL DEFAULT '[]'
                );

                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    cycle_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    pair_id TEXT NOT NULL,
                    venue TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    side TEXT NOT NULL,
                    contracts INTEGER NOT NULL,
                    price REAL NOT NULL,
                    status TEXT NOT NULL,
                    response_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    pair_id TEXT,
                    message TEXT NOT NULL,
                    details_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS positions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair_id TEXT NOT NULL,
                    venue TEXT NOT NULL,
                    side TEXT NOT NULL,
                    contracts INTEGER NOT NULL,
                    avg_entry_price REAL NOT NULL,
                    current_price REAL NOT NULL DEFAULT 0,
                    unrealized_pnl REAL NOT NULL DEFAULT 0,
                    realized_pnl REAL NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT 'arb',
                    status TEXT NOT NULL DEFAULT 'open',
                    opened_at TEXT NOT NULL,
                    closed_at TEXT,
                    UNIQUE(pair_id, venue, side, source)
                );

                CREATE TABLE IF NOT EXISTS pnl_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    snapshot_at TEXT NOT NULL,
                    total_value REAL NOT NULL,
                    total_unrealized_pnl REAL NOT NULL,
                    total_realized_pnl REAL NOT NULL,
                    summary_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS copy_targets (
                    address TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    set_at TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1
                );

                CREATE TABLE IF NOT EXISTS copy_signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    trader_address TEXT NOT NULL,
                    condition_id TEXT NOT NULL,
                    side TEXT NOT NULL,
                    size REAL NOT NULL,
                    price REAL NOT NULL,
                    cash_value REAL NOT NULL,
                    market_title TEXT NOT NULL,
                    suspicion_score INTEGER NOT NULL DEFAULT 0,
                    acted_on INTEGER NOT NULL DEFAULT 0
                );
                """
            )
            cur = conn.execute("SELECT COUNT(*) AS c FROM runtime_control")
            if cur.fetchone()["c"] == 0:
                now = datetime.now(timezone.utc).isoformat()
                conn.execute(
                    "INSERT INTO runtime_control (id, mode, arm_live, confirm_token, confirm_expires_at, updated_at) VALUES (1, 'paper', 0, NULL, NULL, ?)",
                    (now,),
                )
            cycle_cols = [r["name"] for r in conn.execute("PRAGMA table_info(cycles)").fetchall()]
            if "errors_json" not in cycle_cols:
                conn.execute("ALTER TABLE cycles ADD COLUMN errors_json TEXT NOT NULL DEFAULT '[]'")

    def get_runtime_control(self) -> dict[str, Any]:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM runtime_control WHERE id = 1").fetchone()
            return dict(row)

    def update_runtime_control(self, **kwargs) -> None:
        allowed = {"mode", "arm_live", "confirm_token", "confirm_expires_at"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return

        updates["updated_at"] = datetime.now(timezone.utc).isoformat()

        cols = ", ".join([f"{k} = ?" for k in updates])
        vals = list(updates.values())
        vals.append(1)

        with self._conn() as conn:
            conn.execute(f"UPDATE runtime_control SET {cols} WHERE id = ?", vals)

    def save_cycle(
        self,
        cycle_id: str,
        raw_kalshi: dict,
        raw_poly: dict,
        snapshots: list[dict],
        opportunities: list[dict],
        errors: list[dict] | None = None,
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO cycles
                (cycle_id, created_at, raw_kalshi_json, raw_polymarket_json, snapshots_json, opportunities_json, errors_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    cycle_id,
                    datetime.now(timezone.utc).isoformat(),
                    json.dumps(raw_kalshi),
                    json.dumps(raw_poly),
                    json.dumps(snapshots),
                    json.dumps(opportunities),
                    json.dumps(errors or []),
                ),
            )

    def list_recent_cycles(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT cycle_id, created_at, opportunities_json FROM cycles ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_cycle(self, cycle_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM cycles WHERE cycle_id = ?", (cycle_id,)).fetchone()
            return dict(row) if row else None

    def save_order(self, cycle_id: str, idempotency_key: str, pair_id: str, venue: str, mode: str, side: str, contracts: int, price: float, status: str, response: dict) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO orders
                (created_at, cycle_id, idempotency_key, pair_id, venue, mode, side, contracts, price, status, response_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    cycle_id,
                    idempotency_key,
                    pair_id,
                    venue,
                    mode,
                    side,
                    contracts,
                    price,
                    status,
                    json.dumps(response),
                ),
            )

    def list_orders(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    def save_alert(self, severity: str, message: str, pair_id: str | None = None, details: dict[str, Any] | None = None) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO alerts (created_at, severity, pair_id, message, details_json) VALUES (?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).isoformat(),
                    severity,
                    pair_id,
                    message,
                    json.dumps(details or {}),
                ),
            )

    def list_alerts(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    # --- Position tracking ---

    def upsert_position(self, pos) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO positions (pair_id, venue, side, contracts, avg_entry_price, current_price,
                    unrealized_pnl, realized_pnl, source, status, opened_at, closed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(pair_id, venue, side, source) DO UPDATE SET
                    contracts = excluded.contracts,
                    avg_entry_price = excluded.avg_entry_price,
                    current_price = excluded.current_price,
                    unrealized_pnl = excluded.unrealized_pnl,
                    realized_pnl = excluded.realized_pnl,
                    status = excluded.status,
                    closed_at = excluded.closed_at
                """,
                (pos.pair_id, pos.venue, pos.side, pos.contracts, pos.avg_entry_price,
                 pos.current_price, pos.unrealized_pnl, pos.realized_pnl,
                 pos.source, pos.status, pos.opened_at, pos.closed_at),
            )

    def list_positions(self, status: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        with self._conn() as conn:
            if status:
                rows = conn.execute(
                    "SELECT * FROM positions WHERE status = ? ORDER BY opened_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?", (limit,)
                ).fetchall()
            return [dict(r) for r in rows]

    def close_position(self, pair_id: str, venue: str, side: str, realized_pnl: float = 0.0) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._conn() as conn:
            conn.execute(
                """UPDATE positions SET status = 'closed', realized_pnl = ?, closed_at = ?
                   WHERE pair_id = ? AND venue = ? AND side = ? AND status = 'open'""",
                (realized_pnl, now, pair_id, venue, side),
            )

    def save_pnl_snapshot(self, snapshot_at: str, summary: dict[str, Any]) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO pnl_snapshots (snapshot_at, total_value, total_unrealized_pnl, total_realized_pnl, summary_json) VALUES (?, ?, ?, ?, ?)",
                (snapshot_at, summary.get("total_value", 0.0), summary.get("total_unrealized_pnl", 0.0),
                 summary.get("total_realized_pnl", 0.0), json.dumps(summary)),
            )

    def list_pnl_snapshots(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM pnl_snapshots ORDER BY snapshot_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    # --- Copy trading ---

    def save_copy_target(self, address: str, name: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO copy_targets (address, name, set_at, active) VALUES (?, ?, ?, 1)",
                (address, name, now),
            )

    def remove_copy_target(self, address: str) -> None:
        with self._conn() as conn:
            conn.execute("UPDATE copy_targets SET active = 0 WHERE address = ?", (address,))

    def list_copy_targets(self, active_only: bool = True) -> list[dict[str, Any]]:
        with self._conn() as conn:
            if active_only:
                rows = conn.execute("SELECT * FROM copy_targets WHERE active = 1").fetchall()
            else:
                rows = conn.execute("SELECT * FROM copy_targets").fetchall()
            return [dict(r) for r in rows]

    def save_copy_signal(self, signal: dict[str, Any]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO copy_signals (created_at, trader_address, condition_id, side, size, price,
                   cash_value, market_title, suspicion_score, acted_on)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (now, signal["trader_address"], signal["condition_id"], signal["side"],
                 signal["size"], signal["price"], signal["cash_value"],
                 signal["market_title"], signal.get("suspicion_score", 0),
                 signal.get("acted_on", 0)),
            )

    def list_copy_signals(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM copy_signals ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]
