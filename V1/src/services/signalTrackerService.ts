import fs from "fs";
import path from "path";
import { CrossPlatformArb } from "../crossPlatformScreener";

// ---- Types ----

export type SignalStatus = "LIVE" | "CLOSED";

export interface ArbSignal {
  key: string;
  event: string;
  polymarketSlug: string;
  kalshiTicker: string;
  category: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyNoVenue: "POLYMARKET" | "KALSHI";
  polymarketUrl: string;
  kalshiUrl: string;
  similarityScore: number;

  status: SignalStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;

  peakRoi: number;
  peakNetProfit: number;
  currentRoi: number;
  currentNetProfit: number;
  currentBuyYesPrice: number;
  currentBuyNoPrice: number;

  durationSec: number;
  ticksSeen: number;
}

export interface SignalTrackerState {
  liveSignals: ArbSignal[];
  closedSignals: ArbSignal[];
  stats: {
    totalSignalsEver: number;
    currentLive: number;
    avgDurationSec: number;
    avgPeakRoi: number;
  };
  lastTickAt: string | null;
}

// ---- Service ----

const MAX_CLOSED_IN_MEMORY = 200;
const TICK_DEBOUNCE_MS = 5_000;

export class SignalTrackerService {
  private liveMap = new Map<string, ArbSignal>();
  private closedSignals: ArbSignal[] = [];
  private totalSignalsEver = 0;
  private lastTickAt: number = 0;
  private logPath: string;

  constructor() {
    const logDir = path.resolve(process.cwd(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, "signal-history.jsonl");
    this.loadFromDisk();
  }

  tick(currentArbs: CrossPlatformArb[]): void {
    const now = Date.now();
    if (now - this.lastTickAt < TICK_DEBOUNCE_MS) return;
    this.lastTickAt = now;
    const nowIso = new Date(now).toISOString();

    // Build set of current arb keys
    const currentKeys = new Set<string>();
    const arbByKey = new Map<string, CrossPlatformArb>();
    for (const arb of currentArbs) {
      const key = `${arb.polymarketSlug}|${arb.kalshiTicker}`;
      currentKeys.add(key);
      arbByKey.set(key, arb);
    }

    // Update existing or create new signals
    for (const [key, arb] of arbByKey) {
      const existing = this.liveMap.get(key);
      if (existing) {
        existing.lastSeenAt = nowIso;
        existing.currentRoi = arb.roi;
        existing.currentNetProfit = arb.netProfit;
        existing.currentBuyYesPrice = arb.buyYesPrice;
        existing.currentBuyNoPrice = arb.buyNoPrice;
        existing.ticksSeen++;
        if (arb.roi > existing.peakRoi) existing.peakRoi = arb.roi;
        if (arb.netProfit > existing.peakNetProfit) existing.peakNetProfit = arb.netProfit;
        existing.durationSec = Math.round((now - Date.parse(existing.firstSeenAt)) / 1000);
      } else {
        const signal: ArbSignal = {
          key,
          event: arb.event,
          polymarketSlug: arb.polymarketSlug,
          kalshiTicker: arb.kalshiTicker,
          category: arb.category,
          buyYesVenue: arb.buyYesVenue,
          buyNoVenue: arb.buyNoVenue,
          polymarketUrl: arb.polymarketUrl,
          kalshiUrl: arb.kalshiUrl,
          similarityScore: arb.similarityScore,
          status: "LIVE",
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          closedAt: null,
          peakRoi: arb.roi,
          peakNetProfit: arb.netProfit,
          currentRoi: arb.roi,
          currentNetProfit: arb.netProfit,
          currentBuyYesPrice: arb.buyYesPrice,
          currentBuyNoPrice: arb.buyNoPrice,
          durationSec: 0,
          ticksSeen: 1,
        };
        this.liveMap.set(key, signal);
        this.totalSignalsEver++;
      }
    }

    // Close signals that disappeared
    for (const [key, signal] of this.liveMap) {
      if (!currentKeys.has(key)) {
        signal.status = "CLOSED";
        signal.closedAt = nowIso;
        signal.durationSec = Math.round((now - Date.parse(signal.firstSeenAt)) / 1000);
        this.closedSignals.unshift(signal);
        this.liveMap.delete(key);
        // Persist to disk
        try {
          fs.appendFileSync(this.logPath, `${JSON.stringify(signal)}\n`, "utf8");
        } catch (_) { /* ignore write errors */ }
      }
    }

    // Cap in-memory closed signals
    if (this.closedSignals.length > MAX_CLOSED_IN_MEMORY) {
      this.closedSignals = this.closedSignals.slice(0, MAX_CLOSED_IN_MEMORY);
    }
  }

  getState(): SignalTrackerState {
    const live = Array.from(this.liveMap.values()).sort(
      (a, b) => b.durationSec - a.durationSec
    );
    const closed = this.closedSignals;

    const allClosed = closed.length;
    const avgDuration =
      allClosed > 0
        ? Math.round(closed.reduce((s, c) => s + c.durationSec, 0) / allClosed)
        : 0;
    const avgPeakRoi =
      allClosed > 0
        ? closed.reduce((s, c) => s + c.peakRoi, 0) / allClosed
        : 0;

    return {
      liveSignals: live,
      closedSignals: closed,
      stats: {
        totalSignalsEver: this.totalSignalsEver,
        currentLive: live.length,
        avgDurationSec: avgDuration,
        avgPeakRoi,
      },
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const lines = fs.readFileSync(this.logPath, "utf8").trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const signal = JSON.parse(line) as ArbSignal;
          this.closedSignals.push(signal);
          this.totalSignalsEver++;
        } catch (_) { /* skip malformed lines */ }
      }
      // Sort by closedAt descending, keep most recent
      this.closedSignals.sort(
        (a, b) => Date.parse(b.closedAt || "0") - Date.parse(a.closedAt || "0")
      );
      if (this.closedSignals.length > MAX_CLOSED_IN_MEMORY) {
        this.closedSignals = this.closedSignals.slice(0, MAX_CLOSED_IN_MEMORY);
      }
      console.log(`  Signal tracker: loaded ${this.closedSignals.length} closed signals from disk`);
    } catch (_) { /* ignore read errors */ }
  }
}
