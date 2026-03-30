/**
 * Order execution flow for paper/live modes with ARM LIVE safety checks.
 * Port of V2/src/execution.py.
 */

import crypto from "crypto";
import type { ExecutionMode, OpportunityDecision, RiskCheckResult } from "../types";
import type { StateStore } from "./stateStore";
import type { RiskManager } from "./riskManager";
import type { PortfolioTracker } from "./portfolioTracker";
import type { TelegramService } from "./telegramService";

export interface LiveSafetyConfig {
  requireArm: boolean;
  requireTypedConfirm: boolean;
  confirmTokenTtlSec: number;
}

export interface ExecutionResult {
  decision: OpportunityDecision;
  status: "executed" | "risk_blocked" | "blocked" | "kalshi_failed" | "partial_failure";
  reason?: string;
  kalshi?: Record<string, unknown>;
  polymarket?: Record<string, unknown>;
  error?: string;
}

export const DEFAULT_LIVE_SAFETY: LiveSafetyConfig = {
  requireArm: true,
  requireTypedConfirm: true,
  confirmTokenTtlSec: 600,
};

export class ExecutionEngine {
  private liveSafety: LiveSafetyConfig;

  constructor(
    private store: StateStore,
    private riskManager: RiskManager,
    private portfolio: PortfolioTracker,
    private telegram: TelegramService | null,
    liveSafety?: Partial<LiveSafetyConfig>
  ) {
    this.liveSafety = { ...DEFAULT_LIVE_SAFETY, ...liveSafety };
  }

  // ---- ARM LIVE flow ----

  armLive(confirmToken?: string): string {
    const token = confirmToken ?? crypto.randomBytes(6).toString("hex");
    const expiresAt = new Date(Date.now() + this.liveSafety.confirmTokenTtlSec * 1000).toISOString();
    this.store.updateRuntimeControl({
      armLive: 1,
      confirmToken: token,
      confirmExpiresAt: expiresAt,
    });
    return token;
  }

  disarmLive(): void {
    this.store.updateRuntimeControl({
      armLive: 0,
      confirmToken: null,
      confirmExpiresAt: null,
    });
  }

  private liveAllowed(typedConfirm?: string): RiskCheckResult {
    const ctrl = this.store.getRuntimeControl();

    if (this.liveSafety.requireArm && ctrl.armLive !== 1) {
      return { allowed: false, reason: "Live blocked: ARM LIVE is off" };
    }

    if (this.liveSafety.requireTypedConfirm) {
      const token = ctrl.confirmToken;
      const exp = ctrl.confirmExpiresAt;
      if (!token || !typedConfirm || token.trim() !== typedConfirm.trim()) {
        return { allowed: false, reason: "Live blocked: typed confirmation token mismatch" };
      }
      if (exp && new Date() > new Date(exp)) {
        return { allowed: false, reason: "Live blocked: typed confirmation token expired" };
      }
    }

    return { allowed: true, reason: "ok" };
  }

  // ---- Execute decisions ----

  async execute(
    cycleId: string,
    decisions: OpportunityDecision[],
    mode: ExecutionMode,
    typedConfirm?: string
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const tradable = decisions.filter((d) => d.trade);

    // Live safety gate
    if (mode === "live") {
      const { allowed, reason } = this.liveAllowed(typedConfirm);
      if (!allowed) {
        this.store.saveAlert("high", reason, undefined, { cycleId });
        return [{ decision: tradable[0] ?? decisions[0], status: "blocked", reason }];
      }
    }

    for (const d of tradable) {
      // Risk check
      const riskCheck = this.riskManager.checkPreTrade(d);
      if (!riskCheck.allowed) {
        this.store.saveAlert("medium", `Trade blocked by risk: ${riskCheck.reason}`, d.pairId);
        if (this.telegram) {
          this.telegram.sendMessage(`\u26A0\uFE0F *Risk Block*\n${riskCheck.reason}`).catch(() => {});
        }
        results.push({ decision: d, status: "risk_blocked", reason: riskCheck.reason });
        continue;
      }

      const idemBase = `${cycleId}:${d.pairId}:${d.strategy}:${d.contracts}`;

      if (mode === "paper") {
        // Paper mode: simulated fills
        const paperRespK = {
          simulated: true,
          venue: "kalshi",
          side: d.kalshiSide,
          contracts: d.contracts,
          price: d.kalshiPrice,
        };
        const paperRespP = {
          simulated: true,
          venue: "polymarket",
          side: d.polymarketSide,
          contracts: d.contracts,
          price: d.polymarketPrice,
        };

        this.store.saveOrder(cycleId, `${idemBase}:kalshi`, d.pairId, "kalshi", mode, d.kalshiSide, d.contracts, d.kalshiPrice, "filled", paperRespK);
        this.store.saveOrder(cycleId, `${idemBase}:polymarket`, d.pairId, "polymarket", mode, d.polymarketSide, d.contracts, d.polymarketPrice, "filled", paperRespP);

        // Sync positions after paper fills
        this.portfolio.syncPositionsFromOrders();

        // Notify
        if (this.telegram) {
          const roiPct = (d.edgePct * 100).toFixed(1);
          const annPct = (d.annualizedEdge * 100).toFixed(1);
          this.telegram.sendMessage(
            `\u{1F4B0} *Paper Trade*\n` +
            `${d.pairId}\n` +
            `${d.contracts} contracts | $${d.kpTotalCost.toFixed(2)} cost\n` +
            `Edge: $${d.edgeDollar.toFixed(4)} (${roiPct}%) | Ann: ${annPct}%`
          ).catch(() => {});
        }

        results.push({ decision: d, status: "executed", kalshi: paperRespK, polymarket: paperRespP });
        continue;
      }

      // Live mode: place actual orders
      // (Kalshi first, then Polymarket — sequential for safety)
      // TODO: Implement live Kalshi + Polymarket order placement
      // For now, block live with a clear message
      this.store.saveAlert("high", "Live execution not yet implemented", d.pairId);
      results.push({ decision: d, status: "blocked", reason: "Live execution not yet implemented — use paper mode" });
    }

    return results;
  }
}
