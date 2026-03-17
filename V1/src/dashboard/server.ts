import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import axios from "axios";
import { getRedactedSettings, getSettings, getSettingsWithMeta, validateSettingsForMode, saveSettings } from "../runtimeSettings";
import { ArbitrageScreener } from "../screener";
import { KalshiScreener } from "../kalshiScreener";
import { ArbitrageExecutionService } from "../services/arbitrageExecutionService";
import { PythonModelClient } from "../services/pythonModelClient";
import { MiguelService } from "../services/miguelService";
import { CrossPlatformScreener } from "../crossPlatformScreener";
import { SignalTrackerService } from "../services/signalTrackerService";
import { PaperAccountService } from "../services/paperAccountService";
import { TelegramService } from "../services/telegramService";
import { StateStore } from "../services/stateStore";
import { PortfolioTracker } from "../services/portfolioTracker";
import { RiskManager, DEFAULT_RISK_CONFIG } from "../services/riskManager";
import { ExecutionEngine, DEFAULT_LIVE_SAFETY } from "../services/executionEngine";
import { ManualPairsService } from "../services/manualPairsService";
import {
  evaluatePairSnapshot,
  DEFAULT_STRATEGY_PARAMS,
  computeKalshiFee,
  computePolymarketFee,
} from "../services/depthWalkingEngine";
import type { PairSnapshot, PairDepth, DepthLevel } from "../types";

const app = express();
const runtime = getSettings();
const settingsMeta = getSettingsWithMeta();
const PORT = runtime.dashboard.port;
const BIND_HOST = runtime.dashboard.bindHost;
const BOOT_AT = Date.now();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith("/stream")) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timed out" });
    }
  }, 30_000);
  res.on("finish", () => clearTimeout(timer));
  next();
});

// ---- Screener instance (cached) ----
const screener = new ArbitrageScreener();
let screenerCache: { data: any; expires: number } | null = null;
const SCREENER_TTL = 60 * 1000; // 60s

async function getCachedScreenerData() {
  if (screenerCache && Date.now() < screenerCache.expires) {
    return screenerCache.data;
  }
  const data = await screener.getScreenerData();
  screenerCache = { data, expires: Date.now() + SCREENER_TTL };
  return data;
}

// ---- Kalshi Screener instance (cached) ----
const kalshiScreener = new KalshiScreener();
let kalshiScreenerCache: { data: any; expires: number } | null = null;
const KALSHI_SCREENER_TTL = 60 * 1000; // 60s
const executionService = new ArbitrageExecutionService();
const modelClient = new PythonModelClient();
const miguelService = new MiguelService(modelClient);
const crossPlatformScreener = new CrossPlatformScreener(screener, kalshiScreener);
executionService.setCrossPlatformScreener(crossPlatformScreener);
// Wire stateStore after it's created (deferred below)
const telegramService = new TelegramService();
const signalTracker = new SignalTrackerService(telegramService);
const paperAccount = new PaperAccountService();
executionService.setPaperAccount(paperAccount);

// ---- V2 Feature Services (SQLite, Risk, Execution) ----
const stateStore = new StateStore(path.resolve(process.cwd(), "data/state.db"));
const portfolioTracker = new PortfolioTracker(stateStore);
const riskManager = new RiskManager(DEFAULT_RISK_CONFIG, portfolioTracker);
const executionEngineV2 = new ExecutionEngine(
  stateStore,
  riskManager,
  portfolioTracker,
  telegramService,
  DEFAULT_LIVE_SAFETY
);
crossPlatformScreener.setStateStore(stateStore);
console.log("  V2 services: SQLite + Risk + Execution engine initialized");
const manualPairsService = new ManualPairsService();

function getLocalIpv4Urls(port: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls: string[] = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return Array.from(new Set(urls));
}

async function getCachedKalshiScreenerData() {
  if (kalshiScreenerCache && Date.now() < kalshiScreenerCache.expires) {
    return kalshiScreenerCache.data;
  }
  const data = await kalshiScreener.getScreenerData();
  kalshiScreenerCache = { data, expires: Date.now() + KALSHI_SCREENER_TTL };
  return data;
}

// ---- Depth fetching for manual pairs ----

const KALSHI_API_BASE = getSettings().externalApis?.kalshiApiUrl || "https://api.elections.kalshi.com/trade-api/v2";
const CLOB_API_BASE = getSettings().externalApis?.clobHttpUrl || "https://clob.polymarket.com";

async function fetchPairDepth(
  kalshiTicker: string,
  polyYesTokenId: string,
  polyNoTokenId: string,
  timeoutMs = 5000,
): Promise<PairDepth> {
  const empty: PairDepth = {
    kalshi: { buyYes: [], buyNo: [] },
    polymarket: { yesAsks: [], noAsks: [] },
  };

  try {
    const [kalshiBook, polyYesBook, polyNoBook] = await Promise.all([
      kalshiTicker
        ? axios.get(`${KALSHI_API_BASE}/markets/${kalshiTicker}/orderbook`, {
            params: { depth: 10 }, timeout: timeoutMs,
          }).then(r => r.data?.orderbook_fp || r.data?.orderbook || null).catch(() => null)
        : Promise.resolve(null),
      polyYesTokenId
        ? axios.get(`${CLOB_API_BASE}/book`, {
            params: { token_id: polyYesTokenId }, timeout: timeoutMs,
          }).then(r => r.data).catch(() => null)
        : Promise.resolve(null),
      polyNoTokenId
        ? axios.get(`${CLOB_API_BASE}/book`, {
            params: { token_id: polyNoTokenId }, timeout: timeoutMs,
          }).then(r => r.data).catch(() => null)
        : Promise.resolve(null),
    ]);

    const parseKalshi = (levels: any[]): DepthLevel[] =>
      (levels || []).map((l: any) => ({
        price: (l.price || 0) / 100,
        size: l.count || l.contracts || l.quantity || l.size || 0,
      })).filter((l: DepthLevel) => l.size > 0);

    const parsePoly = (book: any, side: "asks" | "bids"): DepthLevel[] => {
      if (!book) return [];
      return (book[side] || []).map((l: any) => ({
        price: parseFloat(l.price || "0"),
        size: parseFloat(l.size || "0"),
      })).filter((l: DepthLevel) => l.size > 0);
    };

    if (kalshiBook) {
      empty.kalshi.buyYes = parseKalshi(kalshiBook.yes || kalshiBook.asks);
      empty.kalshi.buyNo = parseKalshi(kalshiBook.no || []);
    }
    if (polyYesBook) empty.polymarket.yesAsks = parsePoly(polyYesBook, "asks");
    if (polyNoBook) empty.polymarket.noAsks = parsePoly(polyNoBook, "asks");
  } catch {
    // Return empty depth on any error
  }

  return empty;
}

// ---- API Routes ----


// Screener (snapshot)
app.get("/api/screener", async (req, res) => {
  try {
    const data = await getCachedScreenerData();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Screener SSE stream
app.get("/api/screener/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = async () => {
    try {
      // Invalidate cache so we get fresh data
      screenerCache = null;
      const data = await getCachedScreenerData();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Skip on error
    }
  };

  send();
  const interval = setInterval(send, 60_000);
  req.on("close", () => clearInterval(interval));
});

// New Markets — Polymarket (lightweight, fast-polling)
app.get("/api/screener/new-markets", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const markets = await screener.findNewMarkets(limit);
    res.json({ markets, timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// New Markets — Kalshi (lightweight, fast-polling)
app.get("/api/kalshi/screener/new-markets", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const markets = await kalshiScreener.findNewMarkets(limit);
    res.json({ markets, timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Cross-Platform: force re-scan (invalidate cache)
app.post("/api/cross-platform/refresh", async (_req, res) => {
  try {
    crossPlatformScreener.invalidateCache();
    const results = await crossPlatformScreener.getResults();
    signalTracker.tick(results.arbs);
    res.json({
      arbs: results.arbs.length,
      matchedPairs: results.matchedPairs,
      polymarketsScanned: results.polymarketsScanned,
      kalshiMarketsScanned: results.kalshiMarketsScanned,
      timestamp: results.timestamp,
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Cross-Platform Arbitrage Scanner
app.get("/api/cross-platform/arbs", async (_req, res) => {
  try {
    const { verifiedOnly } = stateStore.getRuntimeControl();

    if (verifiedOnly) {
      // Manual mode: build arbs from Excel pairs using mid-price arithmetic + fee calculation
      const settings = getSettings();
      const maxTradeUsd = settings.execution.maxTradeUsd ?? 100;
      const manualPairs = await manualPairsService.getPairs();

      const arbs: import("../crossPlatformScreener").CrossPlatformArb[] = [];
      for (const p of manualPairs) {
        if (!p.hasArb) continue;

        // Determine cheapest arb direction
        const cost1 = p.kalshiYesAsk > 0 && p.polyYesBid > 0
          ? p.kalshiYesAsk + (1 - p.polyYesBid) : 1; // Buy Kalshi YES + Poly NO
        const cost2 = p.polyYesAsk > 0 && p.kalshiYesBid > 0
          ? p.polyYesAsk + (1 - p.kalshiYesBid) : 1; // Buy Poly YES + Kalshi NO

        const useDir1 = cost1 <= cost2;
        const totalCost = useDir1 ? cost1 : cost2;
        if (totalCost >= 1) continue;

        const grossProfit = 1 - totalCost;
        const contracts = totalCost > 0 ? Math.max(1, Math.floor(maxTradeUsd / totalCost)) : 1;

        // Calculate fees per contract at mid-price
        const kalshiPrice = useDir1 ? p.kalshiYesAsk : (1 - p.kalshiYesBid);
        const polyPrice   = useDir1 ? (1 - p.polyYesBid) : p.polyYesAsk;
        const kalshiFeeAmt  = computeKalshiFee(contracts, kalshiPrice, 0.07);
        const polyFeeAmt    = computePolymarketFee(contracts, polyPrice, 0.0175, 1);
        const totalFees     = kalshiFeeAmt + polyFeeAmt;

        const netEdgeDollar = contracts * grossProfit - totalFees;
        const netProfit     = grossProfit - totalFees / contracts; // per-contract net
        if (netProfit <= 0) continue; // skip if fees eat the entire edge

        const endDate = p.endDate || p.resolutionTimeUtc || "";
        const endMs = endDate ? Date.parse(endDate) : NaN;
        const daysToResolution = Number.isFinite(endMs)
          ? Math.max((endMs - Date.now()) / 86_400_000, 0)
          : 0;
        const edgePct = totalCost > 0 ? netProfit / totalCost : 0;
        const annualizedEdge = daysToResolution > 0 ? (edgePct * 365) / daysToResolution : 0;

        arbs.push({
          event: p.polymarketTitle || p.kalshiTitle,
          outcome: "YES",
          polymarketSlug: p.polymarketSlug,
          kalshiTicker: p.kalshiTicker,
          polyYesBid: p.polyYesBid,
          polyYesAsk: p.polyYesAsk,
          kalshiYesBid: p.kalshiYesBid,
          kalshiYesAsk: p.kalshiYesAsk,
          buyYesVenue: useDir1 ? "KALSHI" : "POLYMARKET",
          buyYesPrice: useDir1 ? p.kalshiYesAsk : p.polyYesAsk,
          buyNoVenue: useDir1 ? "POLYMARKET" : "KALSHI",
          buyNoPrice: useDir1 ? (1 - p.polyYesBid) : (1 - p.kalshiYesBid),
          grossProfit,
          netProfit,
          roi: totalCost > 0 ? netProfit / totalCost : 0,
          priceDiff: Math.abs(p.polyYesAsk - p.kalshiYesAsk),
          polymarketUrl: p.polymarketUrl,
          kalshiUrl: p.kalshiUrl,
          similarityScore: p.similarityScore,
          category: p.category,
          polymarketLiquidity: 0,
          kalshiLiquidity: 0,
          polymarketVolume24h: 0,
          kalshiVolume24h: 0,
          endDate,
          polyConditionId: p.polyConditionId || "",
          polyYesTokenId: p.polyYesTokenId || "",
          polyNoTokenId: p.polyNoTokenId || "",
          polyNegRisk: p.polyNegRisk || false,
          contracts,
          kpTotalCost: contracts * totalCost,
          edgeDollar: netEdgeDollar,
          edgePct,
          annualizedEdge,
          kalshiLimitPrice: kalshiPrice,
          polymarketLimitPrice: polyPrice,
          kalshiFee: kalshiFeeAmt,
          polymarketFee: polyFeeAmt,
          daysToResolution,
          strategy: useDir1 ? "BUY_KY_BUY_PN" : "BUY_KN_BUY_PY",
          stopReason: "manual_pair",
        });
      }

      return res.json({
        arbs,
        matchedPairs: manualPairs.length,
        polymarketsScanned: 0,
        kalshiMarketsScanned: 0,
        timestamp: new Date().toISOString(),
      });
    }

    const results = await crossPlatformScreener.getResults();
    signalTracker.tick(results.arbs);
    res.json({
      arbs: results.arbs,
      matchedPairs: results.matchedPairs,
      polymarketsScanned: results.polymarketsScanned,
      kalshiMarketsScanned: results.kalshiMarketsScanned,
      timestamp: results.timestamp,
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/api/cross-platform/pairs", async (req, res) => {
  try {
    const filter = (req.query.filter as string) || "all"; // all | arb | no-arb
    // Allow explicit source override via query param; fall back to global toggle
    const sourceParam = req.query.source as string | undefined; // "manual" | "ai" | "both"
    const { verifiedOnly } = stateStore.getRuntimeControl();
    const effectiveSource = sourceParam || (verifiedOnly ? "manual" : "ai");

    let allPairs: import("../crossPlatformScreener").MatchedPairInfo[] = [];
    let timestamp = new Date().toISOString();
    const sources: string[] = [];

    if (effectiveSource === "manual" || effectiveSource === "both") {
      try {
        const manualPairs = await manualPairsService.getPairs();
        // Tag manual pairs for source identification
        for (const p of manualPairs) {
          (p as any)._source = "manual";
        }
        allPairs.push(...manualPairs);
        sources.push("manual");
      } catch (err: any) {
        console.log(`Manual pairs fetch failed: ${err.message}`);
      }
    }

    if (effectiveSource === "ai" || effectiveSource === "both") {
      try {
        const results = await crossPlatformScreener.getResults();
        // Tag AI pairs for source identification
        for (const p of results.pairs) {
          (p as any)._source = "ai";
        }
        if (effectiveSource === "both") {
          // Deduplicate: if a pair exists in both manual and AI, keep manual version
          const manualKeys = new Set(allPairs.map(p => `${p.kalshiTicker}::${p.polymarketSlug}`));
          const newAiPairs = results.pairs.filter(
            p => !manualKeys.has(`${p.kalshiTicker}::${p.polymarketSlug}`)
          );
          allPairs.push(...newAiPairs);
        } else {
          allPairs.push(...results.pairs);
        }
        timestamp = results.timestamp;
        sources.push("ai");
      } catch (err: any) {
        console.log(`AI pairs fetch failed: ${err.message}`);
      }
    }

    let pairs = allPairs;
    if (filter === "arb") pairs = pairs.filter(p => p.hasArb);
    else if (filter === "no-arb") pairs = pairs.filter(p => !p.hasArb);

    res.json({
      pairs,
      total: allPairs.length,
      filtered: pairs.length,
      timestamp,
      source: effectiveSource,
      sources,
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/api/cross-platform/diffs", async (_req, res) => {
  try {
    const results = await crossPlatformScreener.getResults();
    res.json({
      diffs: results.diffs,
      volumes: results.volumes,
      matchedPairs: results.matchedPairs,
      timestamp: results.timestamp,
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/api/cross-platform/signals", async (_req, res) => {
  try {
    const results = await crossPlatformScreener.getResults();
    signalTracker.tick(results.arbs);
    res.json(signalTracker.getState());
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Cross-Platform: scan status (lightweight — no API calls, just cached state)
app.get("/api/cross-platform/status", (_req, res) => {
  try {
    const status = crossPlatformScreener.getStatus();
    const { verifiedOnly } = stateStore.getRuntimeControl();
    const nowMs = Date.now();
    const nextScanIn = status.cacheExpiresAt > nowMs
      ? Math.ceil((status.cacheExpiresAt - nowMs) / 1000)
      : 0;

    res.json({
      lastScanAt: status.lastScanAt,
      scanning: status.scanning,
      lastScanDurationMs: status.lastScanDurationMs,
      nextScanIn,
      matchedPairs: status.matchedPairs,
      arbCount: status.arbCount,
      embeddingEnabled: status.embeddingEnabled,
      source: verifiedOnly ? "manual" : "ai",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Paper Account
app.get("/api/paper-account/state", async (_req, res) => {
  try {
    // Resolve any expired positions first
    paperAccount.resolveExpired();

    // Auto-execute available arbs into the paper account
    const results = await crossPlatformScreener.getResults();
    paperAccount.resetCycleDedup();
    for (const arb of results.arbs) {
      paperAccount.executeTrade(arb);
    }
    res.json(paperAccount.getState());
  } catch (err: any) {
    res.json(paperAccount.getState());
  }
});

app.post("/api/paper-account/reset", (_req, res) => {
  paperAccount.reset();
  res.json({ success: true, state: paperAccount.getState() });
});

// Overview — aggregated dashboard summary
app.get("/api/overview", async (_req, res) => {
  try {
    const results = await crossPlatformScreener.getResults();
    signalTracker.tick(results.arbs);
    const signals = signalTracker.getState();
    paperAccount.resolveExpired();
    const account = paperAccount.getState();

    // Top 3 arbs by ROI
    const topArbs = [...results.arbs]
      .sort((a, b) => b.roi - a.roi)
      .slice(0, 3)
      .map((a) => ({
        event: a.event,
        roi: a.roi,
        netProfit: a.netProfit,
        buyYesVenue: a.buyYesVenue,
        buyYesPrice: a.buyYesPrice,
        buyNoVenue: a.buyNoVenue,
        buyNoPrice: a.buyNoPrice,
        polymarketLiquidity: a.polymarketLiquidity,
        kalshiLiquidity: a.kalshiLiquidity,
        category: a.category,
      }));

    // Total liquidity across all arbs
    const totalLiquidity = results.arbs.reduce(
      (sum, a) => sum + (a.polymarketLiquidity || 0) + (a.kalshiLiquidity || 0),
      0
    );

    res.json({
      marketsScanned: {
        polymarket: results.polymarketsScanned,
        kalshi: results.kalshiMarketsScanned,
      },
      matchedPairs: results.matchedPairs,
      liveArbs: results.arbs.length,
      liveSignals: signals.stats.currentLive,
      totalSignalsEver: signals.stats.totalSignalsEver,
      avgSignalDuration: signals.stats.avgDurationSec,
      avgPeakRoi: signals.stats.avgPeakRoi,
      topArbs,
      totalLiquidity,
      account: {
        availableBalance: account.availableBalance,
        portfolioValue: account.portfolioValue,
        lockedCapital: account.lockedCapital,
        unrealizedProfit: account.unrealizedProfit,
        realizedProfit: account.realizedProfit,
        startingBalance: account.startingBalance,
        totalTrades: account.totalTrades,
        openPositionCount: account.openPositionCount,
        resolvedTradeCount: account.resolvedTradeCount,
        winRate: account.winRate,
        maxDrawdown: account.maxDrawdown,
        annualizedRoi: account.annualizedRoi,
        avgHoldDays: account.avgHoldDays,
        equityCurve: account.equityCurve,
        recentOpenPositions: account.openPositions.slice(0, 5),
        recentResolvedTrades: account.resolvedTrades.slice(0, 5),
      },
      uptimeMs: Date.now() - BOOT_AT,
      timestamp: results.timestamp,
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Kalshi Screener (snapshot)
app.get("/api/kalshi/screener", async (req, res) => {
  try {
    const data = await getCachedKalshiScreenerData();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Kalshi Screener SSE stream
app.get("/api/kalshi/screener/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = async () => {
    try {
      kalshiScreenerCache = null;
      const data = await getCachedKalshiScreenerData();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Skip on error
    }
  };

  send();
  const interval = setInterval(send, 60_000);
  req.on("close", () => clearInterval(interval));
});

// Arbitrage trade planning/execution state
app.get("/api/arbitrage/execution/state", async (_req, res) => {
  try {
    const state = executionService.getState();
    if (!state.lastRefreshAt) {
      executionService.refreshPlansInBackground();
    }
    res.json(executionService.getState());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/arbitrage/execution/settings", (req, res) => {
  try {
    const state = executionService.updateSettings(req.body || {});
    res.json(state);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/arbitrage/execution/refresh", async (_req, res) => {
  try {
    executionService.refreshPlansInBackground();
    res.json(executionService.getState());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/arbitrage/execution/execute/:planId", async (req, res) => {
  try {
    const record = await executionService.executePlan(req.params.planId);
    res.json(record);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/arbitrage/execution/execute-top", async (req, res) => {
  try {
    const limitRaw = parseInt(req.body?.limit ?? "3");
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const records = await executionService.executeTopPlans(limit);
    res.json(records);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/arbitrage/execution/health", (_req, res) => {
  try {
    res.json({
      ...executionService.getHealth(),
      model: executionService.getState().modelInvocation,
      uptimeMs: Date.now() - BOOT_AT,
      settingsRedacted: getRedactedSettings(),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/model-v1/health", async (_req, res) => {
  try {
    const health = await modelClient.health();
    res.status(health.ok ? 200 : 500).json(health);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/model-v1/evaluate", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const bankrollUsd = Number(req.body?.bankrollUsd ?? runtime.execution.bankrollUsd);
    const decisions = await modelClient.evaluateBatch(items, bankrollUsd);
    res.json({ ok: true, decisions, model: modelClient.getStatus() });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get("/api/miguel/status", (_req, res) => {
  try {
    res.json({ ok: true, ...miguelService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/miguel/pairs/rebuild", async (_req, res) => {
  try {
    const result = await miguelService.rebuildPairs();
    res.json({ ok: true, ...result, status: miguelService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/miguel/live-quotes/start", (_req, res) => {
  try {
    res.json({ ok: true, ...miguelService.startLiveQuotes(), status: miguelService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/miguel/live-quotes/stop", (_req, res) => {
  try {
    res.json({ ok: true, ...miguelService.stopLiveQuotes(), status: miguelService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/miguel/opportunities/rebuild", async (_req, res) => {
  try {
    const result = await miguelService.rebuildOpportunities();
    res.json({ ok: true, ...result, status: miguelService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/miguel/opportunities/latest", (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "25"), 10) || 25, 1), 200);
    res.json({ ok: true, rows: miguelService.getLatestOpportunities(limit), status: miguelService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/miguel/model-v1/top", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "3"), 10) || 3, 1), 10);
    const rows = await miguelService.evaluateModelTop(limit);
    res.json({ ok: true, rows, model: modelClient.getStatus() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/arbitrage/execution/export/plans.csv", (_req, res) => {
  try {
    const csv = executionService.exportPlansCsv();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"arbitrage-plans.csv\"");
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/arbitrage/execution/export/history.csv", (_req, res) => {
  try {
    const csv = executionService.exportHistoryCsv();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"execution-history.csv\"");
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/arbitrage/execution/export/history.json", (_req, res) => {
  try {
    const json = executionService.exportHistoryJson(true);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"execution-history.json\"");
    res.send(json);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/arbitrage/execution/export/history.jsonl", (_req, res) => {
  try {
    const jsonl = executionService.readHistoryJsonl();
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"execution-history.jsonl\"");
    res.send(jsonl);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (_req, res) => {
  try {
    res.json({
      ok: true,
      uptimeMs: Date.now() - BOOT_AT,
      execution: executionService.getHealth(),
      settingsRedacted: getRedactedSettings(),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ---- Settings ----

app.get("/api/settings", (_req, res) => {
  try {
    res.json(getRedactedSettings());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Telegram Notifications ----
app.get("/api/telegram/status", (_req, res) => {
  res.json(telegramService.getStatus());
});

app.post("/api/telegram/test", async (_req, res) => {
  try {
    const result = await telegramService.sendTest();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/telegram/toggle", (req, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }
  telegramService.setEnabled(enabled);
  res.json(telegramService.getStatus());
});

app.post("/api/settings", (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
    const saved = saveSettings(updates);
    // Return redacted version so secrets aren't leaked
    res.json(getRedactedSettings());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Execution Engine V2 Endpoints ----

app.get("/api/execution/runtime-control", (_req, res) => {
  try {
    const ctrl = stateStore.getRuntimeControl();
    // Mask token for security — only show last 4 chars
    const masked = ctrl.confirmToken
      ? `****${ctrl.confirmToken.slice(-4)}`
      : null;
    res.json({
      mode: ctrl.mode,
      armLive: ctrl.armLive === 1,
      hasToken: !!ctrl.confirmToken,
      tokenMasked: masked,
      tokenExpiresAt: ctrl.confirmExpiresAt,
      updatedAt: ctrl.updatedAt,
      verifiedOnly: ctrl.verifiedOnly,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/execution/mode", (req, res) => {
  try {
    const { mode } = req.body;
    if (mode !== "paper" && mode !== "live") {
      return res.status(400).json({ error: "mode must be 'paper' or 'live'" });
    }
    stateStore.updateRuntimeControl({ mode });
    res.json({ mode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/execution/arm-live", (_req, res) => {
  try {
    const token = executionEngineV2.armLive();
    const ctrl = stateStore.getRuntimeControl();
    res.json({
      armed: true,
      token,
      expiresAt: ctrl.confirmExpiresAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/execution/disarm-live", (_req, res) => {
  try {
    executionEngineV2.disarmLive();
    res.json({ armed: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/execution/execute", async (req, res) => {
  try {
    const { decisions, typedConfirm } = req.body;
    const ctrl = stateStore.getRuntimeControl();
    const mode = ctrl.mode as "paper" | "live";
    const cycleId = new Date().toISOString().replace(/[:.]/g, "").slice(0, 18) + "Z";

    const results = await executionEngineV2.execute(
      cycleId,
      decisions ?? [],
      mode,
      typedConfirm
    );

    res.json({ cycleId, mode, results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Verified Pairs & Verified-Only Toggle ----

app.post("/api/execution/verified-only", (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required" });
    }
    stateStore.updateRuntimeControl({ verifiedOnly: enabled ? 1 : 0 });
    // Switching modes: invalidate the manual pairs cache so it reloads on next fetch
    manualPairsService.invalidateCache();
    crossPlatformScreener.invalidateCache();
    res.json({ verifiedOnly: enabled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cross-platform/verified-pairs", (_req, res) => {
  try {
    const pairs = stateStore.listVerifiedPairs();
    const keys = pairs.map((p) => p.pair_key);
    res.json({ pairs, keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/cross-platform/pairs/verify", (req, res) => {
  try {
    const { kalshiTicker, polymarketSlug, verified, label } = req.body;
    if (!kalshiTicker || !polymarketSlug) {
      return res.status(400).json({ error: "kalshiTicker and polymarketSlug are required" });
    }
    if (verified === false) {
      stateStore.removeVerifiedPair(kalshiTicker, polymarketSlug);
    } else {
      stateStore.addVerifiedPair(kalshiTicker, polymarketSlug, label || "");
    }
    const keys = Array.from(stateStore.getVerifiedPairKeys());
    res.json({ success: true, verified: verified !== false, keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- AI Matching ----

app.get("/api/ai-matching/results", (req, res) => {
  try {
    const verdict = req.query.verdict as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
    const results = stateStore.listAiMatches({ verdict, limit });
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ai-matching/status", (_req, res) => {
  try {
    const screenerStatus = crossPlatformScreener.getStatus();
    const matchStats = stateStore.getAiMatchStats();
    res.json({
      aiVerifier: screenerStatus.aiVerifier,
      kimiStats: screenerStatus.kimiStats,
      matchStats,
      lastScanAt: screenerStatus.lastScanAt,
      scanning: screenerStatus.scanning,
      lastScanDurationMs: screenerStatus.lastScanDurationMs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-matching/override", (req, res) => {
  try {
    const { polySlug, kalshiTicker, action } = req.body;
    if (!polySlug || !kalshiTicker || !action) {
      return res.status(400).json({ error: "polySlug, kalshiTicker, and action are required" });
    }
    if (!["approved", "rejected"].includes(action)) {
      return res.status(400).json({ error: "action must be 'approved' or 'rejected'" });
    }
    stateStore.updateAiMatchVerdict(polySlug, kalshiTicker, action);
    res.json({ success: true, polySlug, kalshiTicker, action });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ai-matching/config", (_req, res) => {
  try {
    const settings = getRedactedSettings();
    res.json({
      model: settings.apiKeys.kimi.model,
      baseUrl: settings.apiKeys.kimi.baseUrl,
      apiKeySet: !!getSettings().apiKeys.kimi.apiKey,
      thresholds: {
        rerankLow: 0.20,
        rerankHigh: 0.60,
        kimiConfidenceMin: 0.70,
        kimiTextWeight: 0.40,
        kimiAiWeight: 0.60,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Risk Status ----

app.get("/api/risk/status", (_req, res) => {
  try {
    res.json(riskManager.getRiskStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Portfolio ----

app.get("/api/portfolio/summary", (_req, res) => {
  try {
    res.json(portfolioTracker.getPortfolioSummary());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/portfolio/positions", (_req, res) => {
  try {
    res.json(portfolioTracker.getOpenPositions());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/portfolio/pnl-history", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 30;
    res.json(portfolioTracker.getPnlHistory(limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Orders & Alerts ----

app.get("/api/orders", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 200;
    res.json(stateStore.listOrders(limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/v2/alerts", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(stateStore.listAlerts(limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Arb Scanner Proxy Routes ----

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// Kalshi lookup — tries event_ticker first, then direct market ticker, then title search
app.get("/api/arb-scanner/kalshi/lookup", async (req, res) => {
  const ticker = (req.query.ticker as string)?.trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const formatMarket = (m: any) => ({
    ticker: m.ticker, title: m.title, subtitle: m.subtitle,
    yes_bid: m.yes_bid, no_bid: m.no_bid, last_price: m.last_price,
    volume_24h: m.volume_24h, status: m.status,
  });

  // Strategy 1: Try as event_ticker via /markets?event_ticker=
  try {
    const eventResp = await axios.get(`${KALSHI_BASE}/markets`, {
      params: { event_ticker: ticker, limit: 50 },
    });
    const markets = eventResp.data?.markets || [];
    if (markets.length > 0) {
      return res.json({
        type: markets.length > 1 ? "event" : "market",
        eventTicker: ticker,
        markets: markets.map(formatMarket),
      });
    }
  } catch (_) { /* fall through */ }

  // Strategy 2: Direct market ticker via /markets/{ticker}
  try {
    const mktResp = await axios.get(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`);
    const m = mktResp.data?.market || mktResp.data;
    if (m && m.ticker) {
      return res.json({ type: "market", markets: [formatMarket(m)] });
    }
  } catch (_) { /* fall through */ }

  // Strategy 3: Direct event via /events/{ticker} with nested markets
  try {
    const evtResp = await axios.get(`${KALSHI_BASE}/events/${encodeURIComponent(ticker)}`, {
      params: { with_nested_markets: true },
    });
    const evt = evtResp.data?.event || evtResp.data;
    const markets = evt?.markets || [];
    if (markets.length > 0) {
      return res.json({
        type: markets.length > 1 ? "event" : "market",
        eventTicker: evt.event_ticker || ticker,
        markets: markets.map(formatMarket),
      });
    }
  } catch (_) { /* fall through */ }

  // Strategy 4: Try as series_ticker via /events?series_ticker= (strips trailing -NN suffix)
  const seriesTicker = ticker.replace(/-\d+$/, ""); // KXNEWPOPE-70 → KXNEWPOPE
  try {
    const seriesResp = await axios.get(`${KALSHI_BASE}/events`, {
      params: { series_ticker: seriesTicker, with_nested_markets: true, limit: 10, status: "open" },
    });
    const events = seriesResp.data?.events || [];
    if (events.length > 0) {
      // Flatten all markets from all matching events
      const allMarkets = events.flatMap((e: any) => (e.markets || []).map(formatMarket));
      if (allMarkets.length > 0) {
        return res.json({
          type: allMarkets.length > 1 ? "event" : "market",
          eventTicker: seriesTicker,
          markets: allMarkets,
        });
      }
    }
  } catch (_) { /* fall through */ }

  res.status(404).json({
    error: `No Kalshi markets found for "${ticker}". Enter an event ticker (e.g. KXNEWPOPE-70) or market ticker (e.g. KXNEWPOPE-70-PPIZ).`,
  });
});

// Kalshi orderbook — depth=50
app.get("/api/arb-scanner/kalshi/orderbook", async (req, res) => {
  const ticker = req.query.ticker as string;
  if (!ticker) return res.status(400).json({ error: "ticker required" });
  try {
    const resp = await axios.get(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`, {
      params: { depth: 50 },
    });
    res.json(resp.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// Kalshi search — uses /events endpoint with nested markets (the only reliable way)
app.get("/api/arb-scanner/kalshi/search", async (req, res) => {
  const q = (req.query.q as string || "").trim().toUpperCase();
  const limit = parseInt(req.query.limit as string || "20", 10);
  try {
    // Fetch open events with nested markets, then filter client-side by title/ticker
    const resp = await axios.get(`${KALSHI_BASE}/events`, {
      params: { status: "open", with_nested_markets: true, limit: 200 },
    });
    const events = resp.data?.events || [];
    const results: any[] = [];
    for (const e of events) {
      const title = (e.title || "").toUpperCase();
      const eTicker = (e.event_ticker || "").toUpperCase();
      const series = (e.series_ticker || "").toUpperCase();
      if (!q || title.includes(q) || eTicker.includes(q) || series.includes(q)) {
        for (const m of e.markets || []) {
          results.push({
            event_ticker: e.event_ticker,
            series_ticker: e.series_ticker,
            event_title: e.title,
            ticker: m.ticker,
            title: m.title,
            subtitle: m.subtitle,
            yes_bid: m.yes_bid,
            no_bid: m.no_bid,
            last_price: m.last_price,
            volume_24h: m.volume_24h,
            status: m.status,
          });
        }
      }
      if (results.length >= limit) break;
    }
    res.json({ markets: results.slice(0, limit) });
  } catch (err: any) {
    const status = err.response?.status || 500;
    const msg = err.response?.data?.error || err.message;
    res.status(status).json({ error: msg });
  }
});

// Poly lookup — tries event slug, market slug, sub-slug
app.get("/api/arb-scanner/poly/lookup", async (req, res) => {
  let rawSlug = req.query.slug as string;
  if (!rawSlug) return res.status(400).json({ error: "slug required" });

  // Clean slug from full URL — handle multiple URL formats
  let slug = rawSlug.trim();
  let subSlug: string | null = null;

  // https://polymarket.com/event/main-slug/sub-market-slug
  const eventWithSub = slug.match(/polymarket\.com\/event\/([^/?#]+)\/([^/?#]+)/);
  const eventOnly = slug.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (eventWithSub) {
    slug = eventWithSub[1];
    subSlug = eventWithSub[2];
  } else if (eventOnly) {
    slug = eventOnly[1];
  } else {
    // Raw input: strip protocol, path separators, query params
    slug = slug.replace(/^https?:\/\//, "").replace(/^polymarket\.com\//, "");
    slug = slug.split("?")[0].split("#")[0];
    // If has path separator, treat last segment as potential sub-slug
    if (slug.includes("/")) {
      const parts = slug.split("/").filter(Boolean);
      if (parts.length >= 2) {
        slug = parts[0];
        subSlug = parts[parts.length - 1];
      } else {
        slug = parts[0] || slug;
      }
    }
  }

  const formatResult = (title: string, markets: any[]) => ({
    type: markets.length > 1 ? "event" : "market",
    title,
    markets: markets.map((m: any) => ({
      question: m.question || m.groupItemTitle || "",
      conditionId: m.conditionId || "",
      slug: m.slug || "",
      tokens: extractTokens(m),
    })),
  });

  // Strategy 1: Try as event slug via /events?slug=
  try {
    const eventResp = await axios.get(`${GAMMA_BASE}/events`, { params: { slug } });
    const events = Array.isArray(eventResp.data) ? eventResp.data : eventResp.data ? [eventResp.data] : [];
    if (events.length > 0 && events[0]) {
      const event = events[0];
      const markets: any[] = event.markets || [];
      if (markets.length > 0) {
        // If sub-slug provided, try to auto-select that market
        if (subSlug) {
          const match = markets.find((m: any) => m.slug === subSlug);
          if (match) {
            return res.json(formatResult(event.title || slug, [match]));
          }
        }
        return res.json(formatResult(event.title || slug, markets));
      }
    }
  } catch (_) { /* fall through */ }

  // Strategy 2: Try as market slug via /markets?slug=
  try {
    const mktResp = await axios.get(`${GAMMA_BASE}/markets`, { params: { slug } });
    const mktData = mktResp.data;
    const markets = Array.isArray(mktData) ? mktData : mktData ? [mktData] : [];
    if (markets.length > 0 && markets[0] && markets[0].conditionId) {
      return res.json(formatResult(markets[0].question || markets[0].title || slug, markets));
    }
  } catch (_) { /* fall through */ }

  // Strategy 3: If sub-slug was provided, try it as the direct event slug
  if (subSlug) {
    try {
      const subResp = await axios.get(`${GAMMA_BASE}/events`, { params: { slug: subSlug } });
      const events = Array.isArray(subResp.data) ? subResp.data : subResp.data ? [subResp.data] : [];
      if (events.length > 0 && events[0]) {
        const event = events[0];
        const markets: any[] = event.markets || [];
        if (markets.length > 0) {
          return res.json(formatResult(event.title || subSlug, markets));
        }
      }
    } catch (_) { /* fall through */ }

    // Also try sub-slug as market slug
    try {
      const mktResp = await axios.get(`${GAMMA_BASE}/markets`, { params: { slug: subSlug } });
      const mktData = mktResp.data;
      const markets = Array.isArray(mktData) ? mktData : mktData ? [mktData] : [];
      if (markets.length > 0 && markets[0] && markets[0].conditionId) {
        return res.json(formatResult(markets[0].question || markets[0].title || subSlug, markets));
      }
    } catch (_) { /* fall through */ }
  }

  res.status(404).json({
    error: `No Polymarket markets found for "${slug}". Paste the full event URL (e.g. https://polymarket.com/event/fed-decision-in-march-885).`,
  });
});

// Poly CLOB book
app.get("/api/arb-scanner/poly/book", async (req, res) => {
  const tokenId = req.query.token_id as string;
  if (!tokenId) return res.status(400).json({ error: "token_id required" });
  try {
    const resp = await axios.get(`${CLOB_BASE}/book`, {
      params: { token_id: tokenId },
    });
    res.json(resp.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// Poly search — fetches events and filters client-side (Gamma API text search is unreliable)
app.get("/api/arb-scanner/poly/search", async (req, res) => {
  const q = (req.query.q as string || "").trim().toLowerCase();
  const limit = parseInt(req.query.limit as string || "20", 10);
  try {
    // Fetch active events sorted by volume, then filter client-side
    const resp = await axios.get(`${GAMMA_BASE}/events`, {
      params: { active: true, closed: false, limit: 200, order: "volume", ascending: false },
    });
    const events = Array.isArray(resp.data) ? resp.data : [];
    const results: any[] = [];
    for (const e of events) {
      const title = (e.title || "").toLowerCase();
      const eSlug = (e.slug || "").toLowerCase();
      if (!q || title.includes(q) || eSlug.includes(q)) {
        results.push({
          slug: e.slug,
          title: e.title,
          marketsCount: (e.markets || []).length,
          active: e.active,
        });
      }
      if (results.length >= limit) break;
    }
    res.json({ events: results });
  } catch (err: any) {
    const status = err.response?.status || 500;
    const msg = err.response?.data?.error || err.message;
    res.status(status).json({ error: msg });
  }
});

/** Extract token IDs from a Gamma API market object */
function extractTokens(market: any): { token_id: string; outcome: string }[] {
  if (market.tokens && market.tokens.length > 0) return market.tokens;
  if (!market.clobTokenIds) return [];
  try {
    const ids = JSON.parse(market.clobTokenIds);
    const outcomes = JSON.parse(market.outcomes || "[]");
    return ids.map((id: string, i: number) => ({
      token_id: id,
      outcome: outcomes[i] || (i === 0 ? "Yes" : "No"),
    }));
  } catch {
    return [];
  }
}

// ---- Static files (React SPA) ----
const staticDir = path.join(__dirname, "../dashboard-ui/dist");
app.use(express.static(staticDir));
app.get("/{*splat}", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(staticDir, "index.html"));
});

// ---- Start ----
app.listen(PORT, BIND_HOST, () => {
  console.log(`Loaded settings from: ${settingsMeta.loadedFrom.join(", ")}`);
  console.log(`Mode: ${runtime.execution.mode}`);
  const liveValidation = validateSettingsForMode(runtime.execution.mode, runtime);
  if (!liveValidation.ok && liveValidation.reasons.length > 0) {
    console.log(`Live readiness warnings: ${liveValidation.reasons.join(" | ")}`);
  }
  if (runtime.dashboard.initialRefreshOnBoot) {
    executionService.refreshPlansInBackground();
    console.log(`Execution refresh started (seq ${executionService.getState().refreshSeq})`);
  }
  if (runtime.dashboard.refreshIntervalMs > 0) {
    setInterval(() => executionService.refreshPlansInBackground(), runtime.dashboard.refreshIntervalMs);
  }
  // Pre-warm cross-platform screener cache so first page load is instant
  crossPlatformScreener.getResults().then((r) => {
    console.log(`Cross-platform cache warmed: ${r.matchedPairs} pairs, ${r.arbs.length} arbs`);
  }).catch((err) => {
    console.log(`Cross-platform pre-warm failed (will retry on first request): ${err.message}`);
  });

  const localUrls = getLocalIpv4Urls(PORT);
  console.log(`Dashboard running at http://localhost:${PORT}`);
  if (localUrls.length > 0) {
    console.log(`Dashboard LAN URL(s): ${localUrls.join(", ")}`);
  }
});
