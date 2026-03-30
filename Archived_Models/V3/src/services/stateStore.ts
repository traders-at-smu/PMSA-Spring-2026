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

export interface VerifiedPairRow {
  pair_key: string;
  kalshi_ticker: string;
  polymarket_slug: string;
  verified_at: string;
  label: string;
}

export interface CycleRow {
  cycle_id: string;
  created_at: string;
  snapshots_json: string;
  opportunities_json: string;
  errors_json: string;
}

export interface AiMatchRow {
  id: number;
  created_at: string;
  poly_slug: string;
  kalshi_ticker: string;
  poly_title: string;
  kalshi_title: string;
  text_score: number;
  ai_match: number;
  ai_confidence: number;
  ai_reasoning: string;
  ai_model: string;
  ai_latency_ms: number;
  from_cache: number;
  final_verdict: string;
  user_override: string | null;
  poly_url: string | null;
  kalshi_url: string | null;
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

      CREATE TABLE IF NOT EXISTS verified_pairs (
        pair_key TEXT PRIMARY KEY,
        kalshi_ticker TEXT NOT NULL,
        polymarket_slug TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS ai_match_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        poly_slug TEXT NOT NULL,
        kalshi_ticker TEXT NOT NULL,
        poly_title TEXT NOT NULL,
        kalshi_title TEXT NOT NULL,
        text_score REAL NOT NULL,
        ai_match INTEGER NOT NULL,
        ai_confidence REAL NOT NULL,
        ai_reasoning TEXT NOT NULL,
        ai_model TEXT NOT NULL DEFAULT 'kimi-k2.5',
        ai_latency_ms INTEGER NOT NULL DEFAULT 0,
        from_cache INTEGER NOT NULL DEFAULT 0,
        final_verdict TEXT NOT NULL DEFAULT 'pending',
        user_override TEXT,
        UNIQUE(poly_slug, kalshi_ticker)
      );
    `);

    // Add verified_only column to runtime_control if it doesn't exist yet
    try {
      this.db.prepare("SELECT verified_only FROM runtime_control LIMIT 1").get();
    } catch (_) {
      this.db.prepare("ALTER TABLE runtime_control ADD COLUMN verified_only INTEGER NOT NULL DEFAULT 0").run();
    }

    // Add URL columns to ai_match_results if they don't exist yet
    try {
      this.db.prepare("SELECT poly_url FROM ai_match_results LIMIT 1").get();
    } catch (_) {
      this.db.prepare("ALTER TABLE ai_match_results ADD COLUMN poly_url TEXT").run();
      this.db.prepare("ALTER TABLE ai_match_results ADD COLUMN kalshi_url TEXT").run();
    }

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
      verifiedOnly: ((row.verified_only as number) ?? 0) === 1,
    };
  }

  updateRuntimeControl(updates: Partial<{
    mode: string;
    armLive: number;
    confirmToken: string | null;
    confirmExpiresAt: string | null;
    verifiedOnly: number;
  }>): void {
    const mapping: Record<string, string> = {
      mode: "mode",
      armLive: "arm_live",
      confirmToken: "confirm_token",
      confirmExpiresAt: "confirm_expires_at",
      verifiedOnly: "verified_only",
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

  // ---- Verified Pairs ----

  addVerifiedPair(kalshiTicker: string, polymarketSlug: string, label = ""): void {
    const pairKey = `${polymarketSlug}::${kalshiTicker}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO verified_pairs (pair_key, kalshi_ticker, polymarket_slug, verified_at, label)
      VALUES (?, ?, ?, ?, ?)
    `).run(pairKey, kalshiTicker, polymarketSlug, new Date().toISOString(), label);
  }

  removeVerifiedPair(kalshiTicker: string, polymarketSlug: string): void {
    const pairKey = `${polymarketSlug}::${kalshiTicker}`;
    this.db.prepare("DELETE FROM verified_pairs WHERE pair_key = ?").run(pairKey);
  }

  isVerifiedPair(kalshiTicker: string, polymarketSlug: string): boolean {
    const pairKey = `${polymarketSlug}::${kalshiTicker}`;
    const row = this.db.prepare("SELECT 1 FROM verified_pairs WHERE pair_key = ?").get(pairKey);
    return !!row;
  }

  listVerifiedPairs(): VerifiedPairRow[] {
    return this.db.prepare("SELECT * FROM verified_pairs ORDER BY verified_at DESC").all() as VerifiedPairRow[];
  }

  getVerifiedPairKeys(): Set<string> {
    const rows = this.db.prepare("SELECT pair_key FROM verified_pairs").all() as { pair_key: string }[];
    return new Set(rows.map((r) => r.pair_key));
  }

  // ---- AI Match Results ----

  upsertAiMatch(row: {
    polySlug: string;
    kalshiTicker: string;
    polyTitle: string;
    kalshiTitle: string;
    textScore: number;
    aiMatch: boolean;
    aiConfidence: number;
    aiReasoning: string;
    aiModel: string;
    aiLatencyMs: number;
    fromCache: boolean;
    finalVerdict?: string;
    polyUrl?: string;
    kalshiUrl?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO ai_match_results
        (created_at, poly_slug, kalshi_ticker, poly_title, kalshi_title,
         text_score, ai_match, ai_confidence, ai_reasoning, ai_model,
         ai_latency_ms, from_cache, final_verdict, poly_url, kalshi_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(poly_slug, kalshi_ticker) DO UPDATE SET
        created_at = excluded.created_at,
        poly_title = excluded.poly_title,
        kalshi_title = excluded.kalshi_title,
        text_score = excluded.text_score,
        ai_match = excluded.ai_match,
        ai_confidence = excluded.ai_confidence,
        ai_reasoning = excluded.ai_reasoning,
        ai_model = excluded.ai_model,
        ai_latency_ms = excluded.ai_latency_ms,
        from_cache = excluded.from_cache,
        final_verdict = excluded.final_verdict,
        poly_url = excluded.poly_url,
        kalshi_url = excluded.kalshi_url
    `).run(
      new Date().toISOString(),
      row.polySlug,
      row.kalshiTicker,
      row.polyTitle,
      row.kalshiTitle,
      row.textScore,
      row.aiMatch ? 1 : 0,
      row.aiConfidence,
      row.aiReasoning,
      row.aiModel,
      row.aiLatencyMs,
      row.fromCache ? 1 : 0,
      row.finalVerdict ?? "pending",
      row.polyUrl ?? null,
      row.kalshiUrl ?? null
    );
  }

  listAiMatches(options?: { verdict?: string; limit?: number }): AiMatchRow[] {
    const limit = options?.limit ?? 200;
    if (options?.verdict) {
      return this.db.prepare(
        "SELECT * FROM ai_match_results WHERE final_verdict = ? ORDER BY created_at DESC LIMIT ?"
      ).all(options.verdict, limit) as AiMatchRow[];
    }
    return this.db.prepare(
      "SELECT * FROM ai_match_results ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as AiMatchRow[];
  }

  updateAiMatchVerdict(polySlug: string, kalshiTicker: string, userOverride: string): void {
    const verdict = userOverride === "approved" ? "verified" : userOverride === "rejected" ? "rejected" : userOverride;
    this.db.prepare(
      "UPDATE ai_match_results SET user_override = ?, final_verdict = ? WHERE poly_slug = ? AND kalshi_ticker = ?"
    ).run(userOverride, verdict, polySlug, kalshiTicker);

    // Sync verified_pairs table
    if (userOverride === "approved") {
      this.addVerifiedPair(kalshiTicker, polySlug);
    } else if (userOverride === "rejected") {
      this.removeVerifiedPair(kalshiTicker, polySlug);
    }
  }

  getAiMatchStats(): { total: number; verified: number; rejected: number; pending: number; avgConfidence: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN final_verdict = 'verified' THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN final_verdict = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN final_verdict = 'pending' THEN 1 ELSE 0 END) AS pending,
        AVG(ai_confidence) AS avg_confidence
      FROM ai_match_results
    `).get() as Record<string, number>;
    return {
      total: row.total || 0,
      verified: row.verified || 0,
      rejected: row.rejected || 0,
      pending: row.pending || 0,
      avgConfidence: Math.round((row.avg_confidence || 0) * 1000) / 1000,
    };
  }

  // ---- Cleanup ----

  close(): void {
    this.db.close();
  }
}
