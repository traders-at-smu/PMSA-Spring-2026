import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import { getRedactedSettings, getSettings, getSettingsWithMeta, validateSettingsForMode } from "../runtimeSettings";
import { getTopTraders, getTraderProfile } from "../services/traderService";
import { getTradeAlerts, getAlertHistory } from "../services/tradeAlertService";
import { ArbitrageScreener } from "../screener";
import { KalshiScreener } from "../kalshiScreener";
import { ArbitrageExecutionService } from "../services/arbitrageExecutionService";
import { PythonModelClient } from "../services/pythonModelClient";
import { MiguelService } from "../services/miguelService";

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
    const alerts = await getTradeAlerts();
    res.json(alerts);
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
    const limit = Math.min(Math.max(limitRaw, 1), 10);
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
  const localUrls = getLocalIpv4Urls(PORT);
  console.log(`Dashboard running at http://localhost:${PORT}`);
  if (localUrls.length > 0) {
    console.log(`Dashboard LAN URL(s): ${localUrls.join(", ")}`);
  }
});
