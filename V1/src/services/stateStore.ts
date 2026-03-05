/**
 * SQLite-backed state store for runtime control, orders, positions, and alerts.
 * Port of V2/src/state_store.py using better-sqlite3 (synchronous API).
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { Position, RuntimeControl } from "../types";

// ---- Row types ----

export interface OrderRow {
  id: number;
  created_at: string;
  cycle_id: string;
  idempotency_key: string;
  pair_id: string;
  venue: string;
  mode: string;
  side: string;
  contracts: number;
  price: number;
  status: string;
  response_json: string;
}

export interface AlertRow {
  id: number;
  created_at: string;
  severity: string;
  pair_id: string | null;
  message: string;
  details_json: string;
}

export interface PnlSnapshotRow {
  id: number;
  snapshot_at: string;
  total_value: number;
  total_unrealized_pnl: number;
  total_realized_pnl: number;
  summary_json: string;
}

export interface CycleRow {
  cycle_id: string;
  created_at: string;
  snapshots_json: string;
  opportunities_json: string;
  errors_json: string;
}

// ---- Service ----

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initDb();
  }

  private initDb(): void {
    this.db.exec(`
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
    `);

    // Seed runtime_control singleton if empty
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM runtime_control").get() as { c: number };
    if (count.c === 0) {
      const now = new Date().toISOString();
      this.db.prepare(
        "INSERT INTO runtime_control (id, mode, arm_live, confirm_token, confirm_expires_at, updated_at) VALUES (1, 'paper', 0, NULL, NULL, ?)"
      ).run(now);
    }
  }

  // ---- Runtime Control ----

  getRuntimeControl(): RuntimeControl {
    const row = this.db.prepare("SELECT * FROM runtime_control WHERE id = 1").get() as Record<string, unknown>;
    return {
      id: row.id as number,
      mode: row.mode as RuntimeControl["mode"],
      armLive: row.arm_live as number,
      confirmToken: (row.confirm_token as string) || null,
      confirmExpiresAt: (row.confirm_expires_at as string) || null,
      updatedAt: row.updated_at as string,
    };
  }

  updateRuntimeControl(updates: Partial<{
    mode: string;
    armLive: number;
    confirmToken: string | null;
    confirmExpiresAt: string | null;
  }>): void {
    const mapping: Record<string, string> = {
      mode: "mode",
      armLive: "arm_live",
      confirmToken: "confirm_token",
      confirmExpiresAt: "confirm_expires_at",
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [tsKey, dbCol] of Object.entries(mapping)) {
      if (tsKey in updates) {
        setClauses.push(`${dbCol} = ?`);
        values.push((updates as Record<string, unknown>)[tsKey]);
      }
    }

    if (setClauses.length === 0) return;

    setClauses.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(1); // WHERE id = 1

    this.db.prepare(`UPDATE runtime_control SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
  }

  // ---- Cycles ----

  saveCycle(
    cycleId: string,
    snapshots: unknown[],
    opportunities: unknown[],
    errors: unknown[] = []
  ): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO cycles (cycle_id, created_at, snapshots_json, opportunities_json, errors_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      cycleId,
      new Date().toISOString(),
      JSON.stringify(snapshots),
      JSON.stringify(opportunities),
      JSON.stringify(errors)
    );
  }

  listRecentCycles(limit = 50): CycleRow[] {
    return this.db.prepare(
      "SELECT cycle_id, created_at, snapshots_json, opportunities_json, errors_json FROM cycles ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as CycleRow[];
  }

  // ---- Orders ----

  saveOrder(
    cycleId: string,
    idempotencyKey: string,
    pairId: string,
    venue: string,
    mode: string,
    side: string,
    contracts: number,
    price: number,
    status: string,
    response: unknown
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO orders
      (created_at, cycle_id, idempotency_key, pair_id, venue, mode, side, contracts, price, status, response_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      cycleId,
      idempotencyKey,
      pairId,
      venue,
      mode,
      side,
      contracts,
      price,
      status,
      JSON.stringify(response)
    );
  }

  listOrders(limit = 200): OrderRow[] {
    return this.db.prepare(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as OrderRow[];
  }

  // ---- Alerts ----

  saveAlert(
    severity: string,
    message: string,
    pairId?: string,
    details?: unknown
  ): void {
    this.db.prepare(
      "INSERT INTO alerts (created_at, severity, pair_id, message, details_json) VALUES (?, ?, ?, ?, ?)"
    ).run(
      new Date().toISOString(),
      severity,
      pairId ?? null,
      message,
      JSON.stringify(details ?? {})
    );
  }

  listAlerts(limit = 100): AlertRow[] {
    return this.db.prepare(
      "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as AlertRow[];
  }

  // ---- Positions ----

  upsertPosition(pos: Position): void {
    this.db.prepare(`
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
    `).run(
      pos.pairId, pos.venue, pos.side, pos.contracts, pos.avgEntryPrice,
      pos.currentPrice, pos.unrealizedPnl, pos.realizedPnl,
      pos.source, pos.status, pos.openedAt, pos.closedAt
    );
  }

  listPositions(status?: string, limit = 500): Record<string, unknown>[] {
    if (status) {
      return this.db.prepare(
        "SELECT * FROM positions WHERE status = ? ORDER BY opened_at DESC LIMIT ?"
      ).all(status, limit) as Record<string, unknown>[];
    }
    return this.db.prepare(
      "SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?"
    ).all(limit) as Record<string, unknown>[];
  }

  closePosition(pairId: string, venue: string, side: string, realizedPnl = 0): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE positions SET status = 'closed', realized_pnl = ?, closed_at = ?
      WHERE pair_id = ? AND venue = ? AND side = ? AND status = 'open'
    `).run(realizedPnl, now, pairId, venue, side);
  }

  // ---- P&L Snapshots ----

  savePnlSnapshot(snapshotAt: string, summary: Record<string, unknown>): void {
    this.db.prepare(
      "INSERT INTO pnl_snapshots (snapshot_at, total_value, total_unrealized_pnl, total_realized_pnl, summary_json) VALUES (?, ?, ?, ?, ?)"
    ).run(
      snapshotAt,
      (summary.totalValue as number) || 0,
      (summary.totalUnrealizedPnl as number) || 0,
      (summary.totalRealizedPnl as number) || 0,
      JSON.stringify(summary)
    );
  }

  listPnlSnapshots(limit = 30): PnlSnapshotRow[] {
    return this.db.prepare(
      "SELECT * FROM pnl_snapshots ORDER BY snapshot_at DESC LIMIT ?"
    ).all(limit) as PnlSnapshotRow[];
  }

  // ---- Cleanup ----

  close(): void {
    this.db.close();
  }
}
