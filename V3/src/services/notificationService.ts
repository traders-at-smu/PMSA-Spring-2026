/**
 * Unified notification service — Telegram + Discord.
 * Non-blocking: errors are swallowed and logged (never crash the bot).
 */

import axios from "axios";
import type { NotificationConfig } from "../config";

type Severity = "info" | "warning" | "high";

const DISCORD_COLORS: Record<Severity, number> = {
  info: 3447003,     // blue
  warning: 16776960, // yellow
  high: 15158332,    // red
};

export class NotificationService {
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  /** Generic send — dispatches to all enabled channels */
  send(title: string, body: string, severity: Severity = "info"): void {
    if (!this.config.enabled) return;
    this._sendTelegram(title, body).catch(() => {});
    this._sendDiscord(title, body, severity).catch(() => {});
  }

  notifyTradeExecuted(decision: { pairId: string; strategy: string; contracts: number; edgePct: number }, mode: string): void {
    if (!this.config.notifyOn.tradeExecuted) return;
    const pct = (decision.edgePct * 100).toFixed(2);
    this.send(
      `Trade Executed (${mode})`,
      `${decision.pairId}\n${decision.strategy} x${decision.contracts} — ${pct}% edge`,
      "info"
    );
  }

  notifyArbFound(pairId: string, edgePct: number, annualized: number): void {
    if (!this.config.notifyOn.arbFound) return;
    this.send(
      "Arb Opportunity",
      `${pairId}\nEdge: ${(edgePct * 100).toFixed(2)}% | Annualized: ${(annualized * 100).toFixed(1)}%`,
      "info"
    );
  }

  notifyRiskAlert(message: string, details?: string): void {
    if (!this.config.notifyOn.riskAlert) return;
    this.send("Risk Alert", `${message}${details ? `\n${details}` : ""}`, "warning");
  }

  notifyCircuitBreaker(reason: string): void {
    if (!this.config.notifyOn.circuitBreaker) return;
    this.send("Circuit Breaker Triggered", reason, "high");
  }

  /** Send a test notification to all channels */
  async sendTest(): Promise<{ telegram: boolean; discord: boolean }> {
    const results = { telegram: false, discord: false };
    try {
      await this._sendTelegram("Test", "V3 notification test");
      results.telegram = true;
    } catch { /* failed */ }
    try {
      await this._sendDiscord("Test", "V3 notification test", "info");
      results.discord = true;
    } catch { /* failed */ }
    return results;
  }

  private async _sendTelegram(title: string, body: string): Promise<void> {
    const { botToken, chatId } = this.config.telegram;
    if (!botToken || !chatId) return;
    const text = `*${title}*\n${body}`;
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "Markdown" },
      { timeout: 10_000 }
    );
  }

  private async _sendDiscord(title: string, body: string, severity: Severity): Promise<void> {
    const { webhookUrl } = this.config.discord;
    if (!webhookUrl) return;
    await axios.post(
      webhookUrl,
      {
        embeds: [
          {
            title,
            description: body,
            color: DISCORD_COLORS[severity],
            timestamp: new Date().toISOString(),
          },
        ],
      },
      { timeout: 10_000 }
    );
  }
}
