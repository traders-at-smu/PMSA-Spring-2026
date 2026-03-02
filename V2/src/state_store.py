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
