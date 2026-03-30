import axios from "axios";

// ---- Types ----

interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface ArbAlert {
  event: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  roi: number;
  netProfit: number;
  similarityScore: number;
  category: string;
  polymarketUrl: string;
  kalshiUrl: string;
}

export interface TradeAlert {
  event: string;
  contracts: number;
  costUsd: number;
  lockedCapital: number;
  expectedProfit: number;
  roi: number;
  endDate: string;
}

// ---- Service ----

export class TelegramService {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly baseUrl: string;
  private enabled: boolean;

  // Dedup: track notified arb keys within a 10-min window
  private notifiedKeys = new Map<string, number>();
  private readonly DEDUP_WINDOW_MS = 600_000; // 10 minutes

  // Rate limiter: queue messages and send max 1/sec
  private sendQueue: Array<{ text: string; parseMode: string }> = [];
  private sending = false;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
    this.chatId = process.env.TELEGRAM_CHAT_ID?.trim() || "";
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.enabled = !!(this.botToken && this.chatId);

    if (this.enabled) {
      console.log(`  Telegram notifications: ENABLED (chat ${this.maskChatId()})`);
    } else {
      console.log("  Telegram notifications: DISABLED (no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    }
  }

  // ---- Public API ----

  isConfigured(): boolean {
    return !!(this.botToken && this.chatId);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (!this.isConfigured()) return;
    this.enabled = on;
  }

  getStatus(): { configured: boolean; enabled: boolean; chatId: string } {
    return {
      configured: this.isConfigured(),
      enabled: this.enabled,
      chatId: this.maskChatId(),
    };
  }

  /** Send notification for new arb opportunities. Deduplicates by key. */
  async notifyNewArbs(arbs: ArbAlert[]): Promise<void> {
    if (!this.enabled) return;

    // Clean expired dedup keys
    const now = Date.now();
    for (const [k, t] of this.notifiedKeys) {
      if (now - t > this.DEDUP_WINDOW_MS) this.notifiedKeys.delete(k);
    }

    // Filter to truly new arbs
    const newArbs = arbs.filter((a) => {
      const key = `${a.polymarketUrl}|${a.kalshiUrl}`;
      if (this.notifiedKeys.has(key)) return false;
      this.notifiedKeys.set(key, now);
      return true;
    });

    if (newArbs.length === 0) return;

    // Send individual messages for up to 5 arbs, batch the rest
    const toSend = newArbs.slice(0, 5);
    for (const arb of toSend) {
      const msg = this.formatArbMessage(arb);
      this.queueMessage(msg, "Markdown");
    }

    if (newArbs.length > 5) {
      const batchMsg =
        `\u{1F4E2} *${newArbs.length - 5} more arbs detected*\n` +
        `Check the dashboard for full details.`;
      this.queueMessage(batchMsg, "Markdown");
    }
  }

  /** Send notification for paper trade execution */
  async notifyTradeExecuted(trade: TradeAlert): Promise<void> {
    if (!this.enabled) return;
    const msg = this.formatTradeMessage(trade);
    this.queueMessage(msg, "Markdown");
  }

  /** Send a test message to verify setup */
  async sendTest(): Promise<TelegramSendResult> {
    const msg =
      `\u{2705} *Traders@SMU Bot Connected*\n\n` +
      `Your Telegram notifications are working\\!\n` +
      `You'll receive alerts when new cross\\-platform arbitrage opportunities are detected\\.`;
    return this.sendMessage(msg, "MarkdownV2");
  }

  /** Send raw text message */
  async sendMessage(text: string, parseMode = "Markdown"): Promise<TelegramSendResult> {
    if (!this.botToken || !this.chatId) {
      return { ok: false, error: "Not configured" };
    }

    try {
      const resp = await axios.post(
        `${this.baseUrl}/sendMessage`,
        {
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        },
        { timeout: 10_000 }
      );

      return {
        ok: resp.data?.ok ?? false,
        messageId: resp.data?.result?.message_id,
      };
    } catch (err: any) {
      const errMsg = err?.response?.data?.description || err.message;
      console.error(`  Telegram send error: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  // ---- Private ----

  private formatArbMessage(arb: ArbAlert): string {
    const roiPct = (arb.roi * 100).toFixed(1);
    const profitCents = (arb.netProfit * 100).toFixed(1);
    const matchPct = (arb.similarityScore * 100).toFixed(0);
    const yesPrice = (arb.buyYesPrice * 100).toFixed(0);
    const noPrice = (arb.buyNoPrice * 100).toFixed(0);

    return (
      `\u{1F514} *New Arb Detected*\n\n` +
      `\u{1F4CA} *${this.escapeMarkdown(arb.event)}*\n` +
      `\u{251C} Buy YES on ${arb.buyYesVenue} @ ${yesPrice}\u00A2\n` +
      `\u{251C} Buy NO on ${arb.buyNoVenue} @ ${noPrice}\u00A2\n` +
      `\u{251C} ROI: *${roiPct}%* | Profit: +${profitCents}\u00A2/contract\n` +
      `\u{251C} Match: ${matchPct}% | ${arb.category}\n` +
      `\u{2514} [Polymarket](${arb.polymarketUrl}) \u00B7 [Kalshi](${arb.kalshiUrl})`
    );
  }

  private formatTradeMessage(trade: TradeAlert): string {
    const roiPct = (trade.roi * 100).toFixed(1);
    const expiry = new Date(trade.endDate).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    return (
      `\u{1F4B0} *Paper Trade Executed*\n\n` +
      `\u{1F4CA} *${this.escapeMarkdown(trade.event)}*\n` +
      `\u{251C} ${trade.contracts} contracts @ $${trade.costUsd.toFixed(2)}\n` +
      `\u{251C} Locked: $${trade.lockedCapital.toFixed(2)}\n` +
      `\u{251C} Expected: +$${trade.expectedProfit.toFixed(2)} (${roiPct}% ROI)\n` +
      `\u{2514} Expires: ${expiry}`
    );
  }

  private escapeMarkdown(text: string): string {
    // Escape characters that break Markdown V1 links/bold
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => {
      // Only escape * and _ lightly — we use them for formatting
      if (c === "*" || c === "_") return c;
      return `\\${c}`;
    });
  }

  private maskChatId(): string {
    if (!this.chatId) return "";
    if (this.chatId.length <= 4) return "***";
    return `${this.chatId.slice(0, 2)}***${this.chatId.slice(-2)}`;
  }

  private queueMessage(text: string, parseMode: string): void {
    this.sendQueue.push({ text, parseMode });
    if (!this.sending) this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    this.sending = true;
    while (this.sendQueue.length > 0) {
      const item = this.sendQueue.shift()!;
      await this.sendMessage(item.text, item.parseMode);
      // Rate limit: wait 1s between messages
      if (this.sendQueue.length > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.sending = false;
  }
}
