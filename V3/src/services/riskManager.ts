/**
 * Pre-trade risk checks and circuit breaker logic.
 * Port of V2/src/risk.py.
 */

import type { OpportunityDecision, RiskCheckResult, RiskConfig } from "../types";
import type { PortfolioTracker } from "./portfolioTracker";

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxOpenPositionsPerPair: 5,
  maxNotionalPerPair: 250,
  maxTotalExposure: 5000,
  maxDrawdownPct: 0.15,
  circuitBreakerCooldownMin: 60,
};

export class RiskManager {
  private config: RiskConfig;
  /** Timestamp (ms) when the circuit breaker last tripped. 0 = never tripped. */
  private _lastCircuitBreakerTripMs = 0;

  constructor(
    config: Partial<RiskConfig>,
    private portfolio: PortfolioTracker
  ) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
  }

  /**
   * Run all pre-trade risk checks. Returns { allowed, reason }.
   */
  checkPreTrade(decision: OpportunityDecision): RiskCheckResult {
    // 1. Circuit breaker (drawdown check + cooldown timer)
    if (this.circuitBreakerActive()) {
      const cooldownRemaining = this.circuitBreakerCooldownRemainingMin();
      const reason = cooldownRemaining > 0
        ? `Circuit breaker active: cooldown ${Math.ceil(cooldownRemaining)}min remaining`
        : "Circuit breaker active: drawdown exceeds limit";
      return { allowed: false, reason };
    }

    // 2. Per-pair position count
    const openPositions = this.portfolio.getOpenPositions();
    const pairPositions = openPositions.filter((p) => p.pairId === decision.pairId);
    if (pairPositions.length >= this.config.maxOpenPositionsPerPair) {
      return {
        allowed: false,
        reason: `Max positions per pair (${this.config.maxOpenPositionsPerPair}) reached for ${decision.pairId}`,
      };
    }

    // 3. Per-pair notional
    const pairNotional = pairPositions.reduce((s, p) => s + p.contracts * p.avgEntryPrice, 0);
    const tradeNotional = decision.contracts * (decision.kalshiPrice + decision.polymarketPrice);
    if (pairNotional + tradeNotional > this.config.maxNotionalPerPair) {
      return {
        allowed: false,
        reason: `Max notional per pair ($${this.config.maxNotionalPerPair}) would be exceeded for ${decision.pairId}`,
      };
    }

    // 4. Total portfolio exposure
    const summary = this.portfolio.getPortfolioSummary();
    if (summary.totalCost + tradeNotional > this.config.maxTotalExposure) {
      return {
        allowed: false,
        reason: `Max total exposure ($${this.config.maxTotalExposure}) would be exceeded`,
      };
    }

    return { allowed: true, reason: "ok" };
  }

  /**
   * True if portfolio drawdown exceeds the configured max OR cooldown is still active.
   * When drawdown first exceeds the limit, we record the trip time. Trading stays blocked
   * until BOTH drawdown recovers AND the cooldown period has elapsed.
   */
  circuitBreakerActive(): boolean {
    const drawdownExceeded = this._isDrawdownExceeded();

    // Track when the breaker first trips
    if (drawdownExceeded && this._lastCircuitBreakerTripMs === 0) {
      this._lastCircuitBreakerTripMs = Date.now();
      console.warn(
        `[RiskManager] ⚡ Circuit breaker TRIPPED — cooldown ${this.config.circuitBreakerCooldownMin}min started`
      );
    }

    // If drawdown has recovered, check if cooldown is still active
    if (!drawdownExceeded && this._lastCircuitBreakerTripMs > 0) {
      const elapsedMin = (Date.now() - this._lastCircuitBreakerTripMs) / 60_000;
      if (elapsedMin >= this.config.circuitBreakerCooldownMin) {
        // Cooldown expired — reset and allow trading
        this._lastCircuitBreakerTripMs = 0;
        console.log("[RiskManager] ✅ Circuit breaker cooldown expired — trading resumed");
        return false;
      }
      // Drawdown recovered but still in cooldown window
      return true;
    }

    return drawdownExceeded;
  }

  /** Returns remaining cooldown in minutes (0 if not in cooldown). */
  circuitBreakerCooldownRemainingMin(): number {
    if (this._lastCircuitBreakerTripMs === 0) return 0;
    const elapsedMin = (Date.now() - this._lastCircuitBreakerTripMs) / 60_000;
    return Math.max(0, this.config.circuitBreakerCooldownMin - elapsedMin);
  }

  private _isDrawdownExceeded(): boolean {
    const summary = this.portfolio.getPortfolioSummary();
    if (summary.totalCost <= 0) return false;
    const drawdown = summary.totalPnl < 0 ? -summary.totalPnl / summary.totalCost : 0;
    return drawdown >= this.config.maxDrawdownPct;
  }

  getConfig(): RiskConfig {
    return { ...this.config };
  }

  getRiskStatus(): {
    circuitBreakerActive: boolean;
    circuitBreakerCooldownRemainingMin: number;
    currentExposure: number;
    maxExposure: number;
    drawdownPct: number;
    maxDrawdownPct: number;
  } {
    const summary = this.portfolio.getPortfolioSummary();
    const drawdown = summary.totalCost > 0 && summary.totalPnl < 0
      ? -summary.totalPnl / summary.totalCost
      : 0;

    return {
      circuitBreakerActive: this.circuitBreakerActive(),
      circuitBreakerCooldownRemainingMin: Math.round(this.circuitBreakerCooldownRemainingMin() * 10) / 10,
      currentExposure: summary.totalCost,
      maxExposure: this.config.maxTotalExposure,
      drawdownPct: Math.round(drawdown * 10000) / 10000,
      maxDrawdownPct: this.config.maxDrawdownPct,
    };
  }
}
