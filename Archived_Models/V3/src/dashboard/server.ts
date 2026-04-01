/**
 * V3 Dashboard Server — Express API + React SPA.
 * Receives pre-initialized services from index.ts.
 */

import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import fs from "fs";
import axios from "axios";
import * as XLSX from "xlsx";
import { getRedactedSettings, getSettings, getSettingsWithMeta, validateSettingsForMode, saveSettings, invalidateSettingsCache } from "../config";
import type { CrossPlatformScreener } from "../crossPlatformScreener";
import type { StateStore } from "../services/stateStore";
import type { PaperAccountService } from "../services/paperAccountService";
import type { ExecutionEngine } from "../services/executionEngine";
import type { PortfolioTracker } from "../services/portfolioTracker";
import type { RiskManager } from "../services/riskManager";
import type { NotificationService } from "../services/notificationService";
import type { LoopServices } from "../loop";
import { getLoopStatus, runOneCycle, startLoop, stopLoop } from "../loop";
import type { TrainingExample } from "../services/kimiMatchingService";

export interface ServerDeps {
  crossPlatformScreener: CrossPlatformScreener;
  stateStore: StateStore;
  paperAccount: PaperAccountService;
  executionEngine: ExecutionEngine;
  portfolioTracker: PortfolioTracker;
  riskManager: RiskManager;
  notificationService: NotificationService;
  loopServices: LoopServices;
}

export function startServer(deps: ServerDeps): void {
  const {
    crossPlatformScreener,
    stateStore,
    paperAccount,
    executionEngine,
    portfolioTracker,
    riskManager,
    notificationService,
    loopServices,
  } = deps;

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
      if (!res.headersSent) res.status(504).json({ error: "Request timed out" });
    }, 30_000);
    res.on("finish", () => clearTimeout(timer));
    next();
  });

  const KALSHI_BASE = runtime.externalApis?.kalshiApiUrl || "https://api.elections.kalshi.com/trade-api/v2";
  const GAMMA_BASE = runtime.externalApis?.gammaApiUrl || "https://gamma-api.polymarket.com";
  const CLOB_BASE = runtime.externalApis?.clobHttpUrl || "https://clob.polymarket.com";

  // ---- Cross-Platform ----

  app.post("/api/cross-platform/refresh", async (_req, res) => {
    try {
      crossPlatformScreener.invalidateAll();
      const results = await crossPlatformScreener.getResults();
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

  // Incremental scan — reuse existing matched pairs, only process NEW markets
  app.post("/api/cross-platform/rescan", async (_req, res) => {
    try {
      const results = await crossPlatformScreener.getResultsIncremental();
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

  // Stop a running scan
  app.post("/api/cross-platform/stop", (_req, res) => {
    crossPlatformScreener.abortScan();
    res.json({ ok: true });
  });

  // Update AI matching confidence threshold at runtime
  app.post("/api/ai-matching/confidence", (req, res) => {
    const { threshold } = req.body;
    if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
      return res.status(400).json({ error: "threshold must be a number between 0 and 1" });
    }
    const settings = runtime;
    settings.aiMatching.confidenceThreshold = threshold;
    res.json({ ok: true, confidenceThreshold: threshold });
  });

  // Get current AI matching confidence threshold
  app.get("/api/ai-matching/confidence", (_req, res) => {
    res.json({ confidenceThreshold: runtime.aiMatching.confidenceThreshold });
  });

  // Scan mode: "fast" (~30 min, 500 candidates) or "deep" (~14 hr, 5000 candidates)
  let _scanMode: "fast" | "deep" = "fast";

  app.get("/api/ai-matching/scan-mode", (_req, res) => {
    res.json({ scanMode: _scanMode });
  });

  app.post("/api/ai-matching/scan-mode", (req, res) => {
    const { mode } = req.body;
    if (mode !== "fast" && mode !== "deep") {
      return res.status(400).json({ error: "mode must be 'fast' or 'deep'" });
    }
    _scanMode = mode;
    if (mode === "deep") {
      runtime.aiMatching.maxAiCandidates = 0;           // 0 = no cap, evaluate everything
      runtime.aiMatching.textScoreAiZone = [0.25, 0.99]; // lower threshold = more candidates
      runtime.aiMatching.maxMatchesPerPoly = 5;          // top-5 Kalshi per Poly market
    } else {
      runtime.aiMatching.maxAiCandidates = 500;
      runtime.aiMatching.textScoreAiZone = [0.50, 0.99];
      runtime.aiMatching.maxMatchesPerPoly = 3;
    }
    res.json({ ok: true, scanMode: _scanMode, maxAiCandidates: runtime.aiMatching.maxAiCandidates, maxMatchesPerPoly: runtime.aiMatching.maxMatchesPerPoly });
  });

  app.get("/api/cross-platform/arbs", async (_req, res) => {
    try {
      const results = await crossPlatformScreener.getResults();
      res.json({ arbs: results.arbs, timestamp: results.timestamp });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/cross-platform/pairs", async (_req, res) => {
    try {
      const results = await crossPlatformScreener.getResults();
      res.json({ pairs: results.pairs, timestamp: results.timestamp });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/cross-platform/diffs", async (_req, res) => {
    try {
      const results = await crossPlatformScreener.getResults();
      res.json({ diffs: results.diffs, timestamp: results.timestamp });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/cross-platform/status", (_req, res) => {
    try {
      res.json(crossPlatformScreener.getStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Overview ----

  app.get("/api/overview", async (_req, res) => {
    try {
      const results = await crossPlatformScreener.getResults();
      const paperState = paperAccount.getState();
      const loopStatus = getLoopStatus();

      // Build top arbs sorted by ROI
      const topArbs = results.arbs
        .sort((a, b) => b.roi - a.roi)
        .slice(0, 10)
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
        (sum, a) => sum + a.polymarketLiquidity + a.kalshiLiquidity,
        0
      );

      // Recent open positions from paper account
      const recentOpenPositions = paperState.openPositions.slice(0, 10).map((p) => ({
        id: p.id,
        openedAt: p.openedAt,
        endDate: p.endDate,
        event: p.event,
        contracts: p.contracts,
        costUsd: p.costUsd,
        expectedProfitUsd: p.expectedProfitUsd,
        daysToExpiry: p.daysToExpiry,
      }));

      // Recent resolved trades
      const recentResolvedTrades = paperState.resolvedTrades.slice(0, 10).map((t) => ({
        id: t.id,
        resolvedAt: t.resolvedAt,
        event: t.event,
        contracts: t.contracts,
        profitUsd: t.profitUsd,
        holdDays: t.holdDays,
        annualizedRoi: t.annualizedRoi,
      }));

      res.json({
        marketsScanned: {
          polymarket: results.polymarketsScanned,
          kalshi: results.kalshiMarketsScanned,
        },
        matchedPairs: results.matchedPairs,
        liveArbs: results.arbs.length,
        liveSignals: results.arbs.filter((a) => a.roi > 0).length,
        totalSignalsEver: paperState.totalTrades,
        avgSignalDuration: paperState.avgHoldDays,
        avgPeakRoi: results.arbs.length > 0
          ? results.arbs.reduce((s, a) => s + a.roi, 0) / results.arbs.length
          : 0,
        topArbs,
        totalLiquidity,
        account: {
          availableBalance: paperState.availableBalance,
          portfolioValue: paperState.portfolioValue,
          lockedCapital: paperState.lockedCapital,
          unrealizedProfit: paperState.unrealizedProfit,
          realizedProfit: paperState.realizedProfit,
          startingBalance: paperState.startingBalance,
          totalTrades: paperState.totalTrades,
          openPositionCount: paperState.openPositionCount,
          resolvedTradeCount: paperState.resolvedTradeCount,
          winRate: paperState.winRate,
          maxDrawdown: paperState.maxDrawdown,
          annualizedRoi: paperState.annualizedRoi,
          avgHoldDays: paperState.avgHoldDays,
          equityCurve: paperState.equityCurve,
          recentOpenPositions,
          recentResolvedTrades,
        },
        loop: loopStatus,
        uptimeMs: process.uptime() * 1000,
        timestamp: results.timestamp,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Paper Account ----

  app.get("/api/paper-account/state", (_req, res) => {
    try {
      res.json(paperAccount.getState());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/paper-account/reset", (_req, res) => {
    paperAccount.reset();
    res.json({ reset: true });
  });

  // ---- Loop Control (NEW) ----

  app.get("/api/loop/status", (_req, res) => {
    res.json(getLoopStatus());
  });

  app.post("/api/loop/start", (_req, res) => {
    startLoop(loopServices).catch((err) => {
      console.error("[Loop] Error:", err);
    });
    res.json({ started: true });
  });

  app.post("/api/loop/stop", (_req, res) => {
    stopLoop();
    res.json({ stopped: true });
  });

  app.post("/api/loop/run-once", async (_req, res) => {
    try {
      const result = await runOneCycle(loopServices);
      res.json(result);
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

  // Export verified matches as V5-compatible Excel
  app.get("/api/ai-matching/export", (req, res) => {
    try {
      const minConf = req.query.minConfidence ? parseFloat(req.query.minConfidence as string) : 0.90;
      const allResults = stateStore.listAiMatches({ verdict: "verified", limit: 5000 });

      // Filter by confidence threshold
      const matches = allResults.filter(r => r.ai_confidence >= minConf);

      // Build V5-compatible rows
      let pairCounter = 1;
      const rows = matches.map(r => ({
        pair_id: `ai-${String(pairCounter++).padStart(4, "0")}`,
        title_clean: r.poly_title || r.kalshi_title || "",
        category_tag: "ai-matched",
        similarity_score: r.text_score?.toFixed(4) ?? "",
        poly_market_id: r.poly_slug,
        poly_slug: r.poly_slug,
        poly_url: r.poly_url || `https://polymarket.com/market/${r.poly_slug}`,
        kalshi_market_id: r.kalshi_ticker,
        kalshi_url: r.kalshi_url || `https://kalshi.com/markets/${r.kalshi_ticker}`,
        ai_confidence: r.ai_confidence?.toFixed(4) ?? "",
        ai_reasoning: r.ai_reasoning || "",
        resolution_time_utc: "",
        active: "true",
      }));

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Pairs");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="AI_Matched_Pairs_${new Date().toISOString().slice(0, 10)}.xlsx"`);
      res.send(buf);
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
        scanProgress: screenerStatus.scanProgress,
        lastScanDurationMs: screenerStatus.lastScanDurationMs,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE endpoint for live scan logs
  app.get("/api/scan-logs/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent history first
    const recent = crossPlatformScreener.getRecentLogs(100);
    for (const entry of recent) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Subscribe to new entries
    const unsub = crossPlatformScreener.onLog((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    // Keep-alive ping every 15s
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      unsub();
      clearInterval(ping);
    });
  });

  // GET recent logs (non-streaming fallback)
  app.get("/api/scan-logs", (_req, res) => {
    res.json({ logs: crossPlatformScreener.getRecentLogs(200) });
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
      const settings = getSettings();
      const redacted = getRedactedSettings();
      res.json({
        model: redacted.apiKeys.kimi.model,
        baseUrl: redacted.apiKeys.kimi.baseUrl,
        apiKeySet: !!settings.apiKeys.kimi.apiKey,
        thresholds: {
          confidenceThreshold: settings.aiMatching.confidenceThreshold,
          textScoreAiZone: settings.aiMatching.textScoreAiZone,
          fewShotExampleCount: settings.aiMatching.fewShotExampleCount,
          fewShotSelectionStrategy: settings.aiMatching.fewShotSelectionStrategy,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ai-matching/reload-prompt", (_req, res) => {
    try {
      res.json({ reloaded: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Training (NEW) ----

  app.post("/api/training/add-example", (req, res) => {
    try {
      const { polymarketTitle, kalshiTitle, polymarketSlug, kalshiTicker, label, category, notes } = req.body;
      if (!polymarketTitle || !kalshiTitle || !label) {
        return res.status(400).json({ error: "polymarketTitle, kalshiTitle, and label are required" });
      }
      if (label !== "correct" && label !== "incorrect") {
        return res.status(400).json({ error: "label must be 'correct' or 'incorrect'" });
      }

      const trainingSetPath = path.resolve(process.cwd(), getSettings().paths.trainingSet);
      let existing: TrainingExample[] = [];
      try {
        if (fs.existsSync(trainingSetPath)) {
          existing = JSON.parse(fs.readFileSync(trainingSetPath, "utf8"));
        }
      } catch { existing = []; }

      const example: TrainingExample = {
        polymarketTitle,
        kalshiTitle,
        polymarketSlug: polymarketSlug || "",
        kalshiTicker: kalshiTicker || "",
        label,
        category: category || "other",
        notes: notes || undefined,
      };

      existing.push(example);
      fs.writeFileSync(trainingSetPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
      res.json({ success: true, totalExamples: existing.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Verified-Only Mode ----

  app.post("/api/execution/verified-only", (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) is required" });
      }
      stateStore.updateRuntimeControl({ verifiedOnly: enabled ? 1 : 0 });
      crossPlatformScreener.invalidateCache();
      res.json({ verifiedOnly: enabled });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Execution Engine ----

  app.get("/api/execution/runtime-control", (_req, res) => {
    try {
      const ctrl = stateStore.getRuntimeControl();
      const masked = ctrl.confirmToken ? `****${ctrl.confirmToken.slice(-4)}` : null;
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
      const token = executionEngine.armLive();
      const ctrl = stateStore.getRuntimeControl();
      res.json({ armed: true, token, expiresAt: ctrl.confirmExpiresAt });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/execution/disarm-live", (_req, res) => {
    try {
      executionEngine.disarmLive();
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
      const results = await executionEngine.execute(cycleId, decisions ?? [], mode, typedConfirm);
      res.json({ cycleId, mode, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Verified Pairs ----

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

  // ---- Risk ----

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

  // ---- Settings ----

  app.get("/api/settings", (_req, res) => {
    try {
      res.json(getRedactedSettings());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/settings", (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object" });
      }
      saveSettings(updates);
      res.json(getRedactedSettings());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Kimi API Key (save + hot-reload) ----

  app.post("/api/settings/kimi", (req, res) => {
    try {
      const { apiKey, baseUrl, model } = req.body ?? {};
      if (!apiKey || typeof apiKey !== "string") {
        return res.status(400).json({ error: "apiKey is required" });
      }
      // Persist to settings.json
      saveSettings({
        apiKeys: {
          kimi: {
            apiKey,
            ...(baseUrl ? { baseUrl } : {}),
            ...(model ? { model } : {}),
          },
        },
      });
      // Hot-reload the Kimi service so it takes effect immediately
      const result = crossPlatformScreener.reloadKimiService();
      res.json({ saved: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Notifications ----

  app.post("/api/notifications/test", async (_req, res) => {
    try {
      const result = await notificationService.sendTest();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Health ----

  app.get("/api/health", (_req, res) => {
    try {
      res.json({
        ok: true,
        uptimeMs: Date.now() - BOOT_AT,
        settingsRedacted: getRedactedSettings(),
        loop: getLoopStatus(),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---- Arb Scanner Proxy Routes ----

  app.get("/api/arb-scanner/kalshi/lookup", async (req, res) => {
    const ticker = (req.query.ticker as string)?.trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "ticker required" });

    const formatMarket = (m: any) => ({
      ticker: m.ticker, title: m.title, subtitle: m.subtitle,
      yes_bid: m.yes_bid, no_bid: m.no_bid, last_price: m.last_price,
      volume_24h: m.volume_24h, status: m.status,
    });

    try {
      const eventResp = await axios.get(`${KALSHI_BASE}/markets`, { params: { event_ticker: ticker, limit: 50 } });
      const markets = eventResp.data?.markets || [];
      if (markets.length > 0) {
        return res.json({ type: markets.length > 1 ? "event" : "market", eventTicker: ticker, markets: markets.map(formatMarket) });
      }
    } catch { /* fall through */ }

    try {
      const mktResp = await axios.get(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`);
      const m = mktResp.data?.market || mktResp.data;
      if (m && m.ticker) return res.json({ type: "market", markets: [formatMarket(m)] });
    } catch { /* fall through */ }

    try {
      const evtResp = await axios.get(`${KALSHI_BASE}/events/${encodeURIComponent(ticker)}`, { params: { with_nested_markets: true } });
      const evt = evtResp.data?.event || evtResp.data;
      const markets = evt?.markets || [];
      if (markets.length > 0) return res.json({ type: markets.length > 1 ? "event" : "market", eventTicker: evt.event_ticker || ticker, markets: markets.map(formatMarket) });
    } catch { /* fall through */ }

    res.status(404).json({ error: `No Kalshi markets found for "${ticker}"` });
  });

  app.get("/api/arb-scanner/kalshi/orderbook", async (req, res) => {
    const ticker = req.query.ticker as string;
    if (!ticker) return res.status(400).json({ error: "ticker required" });
    try {
      const resp = await axios.get(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`, { params: { depth: 50 } });
      res.json(resp.data);
    } catch (err: any) {
      res.status(err.response?.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/arb-scanner/poly/lookup", async (req, res) => {
    let rawSlug = req.query.slug as string;
    if (!rawSlug) return res.status(400).json({ error: "slug required" });

    let slug = rawSlug.trim();
    const eventMatch = slug.match(/polymarket\.com\/event\/([^/?#]+)/);
    if (eventMatch) slug = eventMatch[1];

    try {
      const eventResp = await axios.get(`${GAMMA_BASE}/events`, { params: { slug } });
      const events = Array.isArray(eventResp.data) ? eventResp.data : eventResp.data ? [eventResp.data] : [];
      if (events.length > 0 && events[0]?.markets?.length > 0) {
        const event = events[0];
        return res.json({
          type: event.markets.length > 1 ? "event" : "market",
          title: event.title,
          markets: event.markets.map((m: any) => ({
            question: m.question || "", conditionId: m.conditionId || "", slug: m.slug || "",
            tokens: extractPolyTokens(m),
          })),
        });
      }
    } catch { /* fall through */ }

    res.status(404).json({ error: `No Polymarket markets found for "${slug}"` });
  });

  app.get("/api/arb-scanner/poly/book", async (req, res) => {
    const tokenId = req.query.token_id as string;
    if (!tokenId) return res.status(400).json({ error: "token_id required" });
    try {
      const resp = await axios.get(`${CLOB_BASE}/book`, { params: { token_id: tokenId } });
      res.json(resp.data);
    } catch (err: any) {
      res.status(err.response?.status || 500).json({ error: err.message });
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
      crossPlatformScreener.getResults().then((r) => {
        console.log(`Cross-platform cache warmed: ${r.matchedPairs} pairs, ${r.arbs.length} arbs`);
      }).catch((err) => {
        console.log(`Cross-platform pre-warm failed: ${err.message}`);
      });
    } else {
      console.log("Skipping initial scan (initialRefreshOnBoot=false). Use Run Cycle to scan.");
    }
    const localUrls = getLocalIpv4Urls(PORT);
    console.log(`Dashboard running at http://localhost:${PORT}`);
    if (localUrls.length > 0) console.log(`LAN: ${localUrls.join(", ")}`);
  });
}

function getLocalIpv4Urls(port: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return Array.from(new Set(urls));
}

function extractPolyTokens(market: any): { token_id: string; outcome: string }[] {
  if (market.tokens && market.tokens.length > 0) return market.tokens;
  if (!market.clobTokenIds) return [];
  try {
    const ids = JSON.parse(market.clobTokenIds);
    const outcomes = JSON.parse(market.outcomes || "[]");
    return ids.map((id: string, i: number) => ({ token_id: id, outcome: outcomes[i] || (i === 0 ? "Yes" : "No") }));
  } catch { return []; }
}
