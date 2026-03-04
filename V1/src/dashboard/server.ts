import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import { getRedactedSettings, getSettings, getSettingsWithMeta, validateSettingsForMode, saveSettings } from "../runtimeSettings";
import { getTopTraders, getTraderProfile } from "../services/traderService";
import { getTradeAlerts, getAlertHistory, getRecentLargeTrades, getAggregatedAlerts } from "../services/tradeAlertService";
import { ArbitrageScreener } from "../screener";
import { KalshiScreener } from "../kalshiScreener";
import { ArbitrageExecutionService } from "../services/arbitrageExecutionService";
import { PythonModelClient } from "../services/pythonModelClient";
import { MiguelService } from "../services/miguelService";
import { CrossPlatformScreener } from "../crossPlatformScreener";
import { getCopyTarget, setCopyTarget, clearCopyTarget } from "../services/copyTargetService";
import { SignalTrackerService } from "../services/signalTrackerService";
import { PaperAccountService } from "../services/paperAccountService";
import { TelegramService } from "../services/telegramService";

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
const telegramService = new TelegramService();
const signalTracker = new SignalTrackerService(telegramService);
const paperAccount = new PaperAccountService();
executionService.setPaperAccount(paperAccount);

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

// ---- API Routes ----

// Traders leaderboard
app.get("/api/traders", async (req, res) => {
  try {
    const orderBy = (req.query.orderBy as string) === "VOL" ? "VOL" : "PNL";
    const timePeriod = (["DAY", "WEEK", "MONTH", "ALL"].includes(req.query.timePeriod as string)
      ? req.query.timePeriod
      : "ALL") as "DAY" | "WEEK" | "MONTH" | "ALL";
    const category = (req.query.category as string) || "OVERALL";
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 50);

    const traders = await getTopTraders(orderBy, timePeriod, category, limit);
    res.json(traders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single trader profile
app.get("/api/traders/:address", async (req, res) => {
  try {
    const profile = await getTraderProfile(req.params.address);
    if (!profile) return res.status(404).json({ error: "Trader not found" });
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trade alerts (snapshot)
app.get("/api/alerts", async (req, res) => {
  try {
    const [alerts, recent, aggregated] = await Promise.all([
      getTradeAlerts(),
      getRecentLargeTrades(),
      getAggregatedAlerts(),
    ]);
    res.json({ alerts, recent, aggregated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trade alerts SSE stream
app.get("/api/alerts/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = async () => {
    try {
      const alerts = await getTradeAlerts();
      res.write(`data: ${JSON.stringify(alerts)}\n\n`);
    } catch {
      // Skip on error
    }
  };

  send();
  const interval = setInterval(send, 30_000);
  req.on("close", () => clearInterval(interval));
});

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
    res.status(500).json({ error: err.message });
  }
});

// Cross-Platform Arbitrage Scanner
app.get("/api/cross-platform/arbs", async (_req, res) => {
  try {
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
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cross-platform/pairs", async (req, res) => {
  try {
    const results = await crossPlatformScreener.getResults();
    const filter = (req.query.filter as string) || "all"; // all | arb | no-arb
    let pairs = results.pairs;
    if (filter === "arb") pairs = pairs.filter(p => p.hasArb);
    else if (filter === "no-arb") pairs = pairs.filter(p => !p.hasArb);
    res.json({
      pairs,
      total: results.pairs.length,
      filtered: pairs.length,
      timestamp: results.timestamp,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cross-platform/signals", async (_req, res) => {
  try {
    const results = await crossPlatformScreener.getResults();
    signalTracker.tick(results.arbs);
    res.json(signalTracker.getState());
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
    res.status(500).json({ error: err.message });
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

// ---- Copy Trading Target ----

app.get("/api/copy-trading/target", (_req, res) => {
  res.json({ target: getCopyTarget() });
});

app.post("/api/copy-trading/target", (req, res) => {
  const { address, name } = req.body || {};
  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "address is required" });
  }
  const target = setCopyTarget(address, name || "");
  res.json({ target });
});

app.delete("/api/copy-trading/target", (_req, res) => {
  clearCopyTarget();
  res.json({ target: null });
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
