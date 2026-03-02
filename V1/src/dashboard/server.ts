import express from "express";
import cors from "cors";
import path from "path";
import os from "os";
import fs from "fs";
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
const KALSHI_REFRESH_INTERVAL_MS = 60_000;
const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_ARCHIVE_DIR = path.join(LOG_DIR, "archive");
let RUNTIME_LOG_PATH = path.join(LOG_DIR, "dashboard-runtime.log");
const LONG_RUNNING_PATHS = new Set([
  "/api/miguel/pairs/rebuild",
  "/api/miguel/opportunities/rebuild",
  "/api/miguel/model-v1/top",
  "/api/arbitrage/execution/refresh",
  "/api/arbitrage/execution/execute-top",
]);

function toSafeTimestamp(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${y}${mo}${da}-${h}${mi}${s}${ms}`;
}

function setupRuntimeLogCapture(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });

  // One-time migration for legacy single-file logs.
  const legacyLog = path.join(LOG_DIR, "dashboard-runtime.log");
  if (fs.existsSync(legacyLog)) {
    const stat = fs.statSync(legacyLog);
    if (stat.size > 0) {
      const migrated = path.join(LOG_ARCHIVE_DIR, `dashboard-runtime-legacy-${toSafeTimestamp(new Date())}.txt`);
      fs.renameSync(legacyLog, migrated);
    } else {
      fs.unlinkSync(legacyLog);
    }
  }

  // Move prior session runtime text logs to archive so each launch has one active output log in logs/.
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!/^dashboard-runtime-\d{8}-\d{9}(?:-p\d+)?\.txt$/.test(name)) continue;
    const src = path.join(LOG_DIR, name);
    const dest = path.join(LOG_ARCHIVE_DIR, name);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.renameSync(src, dest);
    }
  }

  // Each launch gets a dedicated text log file.
  RUNTIME_LOG_PATH = path.join(LOG_DIR, `dashboard-runtime-${toSafeTimestamp(new Date())}-p${process.pid}.txt`);
  fs.writeFileSync(RUNTIME_LOG_PATH, `[${new Date().toISOString()}] INFO Runtime log session started\n`, "utf8");

  const writeLine = (level: string, args: unknown[]) => {
    const rendered = args
      .map((arg) => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        if (typeof arg === "string") {
          return arg;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
    const line = `[${new Date().toISOString()}] ${level} ${rendered}\n`;
    fs.appendFileSync(RUNTIME_LOG_PATH, line, "utf8");
  };

  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalDebug = console.debug.bind(console);

  console.log = (...args: unknown[]) => {
    writeLine("INFO", args);
    originalLog(...args);
  };
  console.info = (...args: unknown[]) => {
    writeLine("INFO", args);
    originalInfo(...args);
  };
  console.warn = (...args: unknown[]) => {
    writeLine("WARN", args);
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeLine("ERROR", args);
    originalError(...args);
  };
  console.debug = (...args: unknown[]) => {
    writeLine("DEBUG", args);
    originalDebug(...args);
  };
}

function readLastLogLines(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) return [];

  // Read only the tail window to avoid loading very large logs into heap.
  const TAIL_BYTES = 512 * 1024;
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    const content = buffer.toString("utf8", 0, bytesRead);
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

setupRuntimeLogCapture();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith("/stream") || LONG_RUNNING_PATHS.has(req.path)) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent && !res.writableEnded) {
      res.status(504).json({ error: "Request timed out" });
    }
  }, 30_000);
  res.on("finish", () => clearTimeout(timer));
  res.on("close", () => clearTimeout(timer));
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
const KALSHI_SCREENER_TTL = KALSHI_REFRESH_INTERVAL_MS;
const RAW_CONTRACTS_TTL = 30_000;
let rawContractsCache: { data: any; expires: number } | null = null;
let rawContractsInFlight: Promise<any> | null = null;
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

async function getRawContractsData(forceRefresh = false) {
  if (!forceRefresh && rawContractsCache && Date.now() < rawContractsCache.expires) {
    return rawContractsCache.data;
  }
  if (!forceRefresh && rawContractsInFlight) {
    return rawContractsInFlight;
  }

  rawContractsInFlight = (async () => {
    const [polymarket, kalshi] = await Promise.all([
      screener.fetchAllActiveMarkets(),
      kalshiScreener.fetchAllActiveMarkets(),
    ]);

    const payload = {
      timestamp: new Date().toISOString(),
      counts: {
        polymarket: polymarket.length,
        kalshi: kalshi.length,
      },
      polymarket,
      kalshi,
    };
    rawContractsCache = { data: payload, expires: Date.now() + RAW_CONTRACTS_TTL };
    return payload;
  })();

  try {
    return await rawContractsInFlight;
  } finally {
    rawContractsInFlight = null;
  }
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

  let sendInFlight = false;
  const send = async () => {
    if (sendInFlight) return;
    sendInFlight = true;
    try {
      const alerts = await getTradeAlerts();
      res.write(`data: ${JSON.stringify(alerts)}\n\n`);
    } catch {
      // Skip on error
    } finally {
      sendInFlight = false;
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

  let sendInFlight = false;
  const send = async () => {
    if (sendInFlight) return;
    sendInFlight = true;
    try {
      // Invalidate cache so we get fresh data
      screenerCache = null;
      const data = await getCachedScreenerData();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Skip on error
    } finally {
      sendInFlight = false;
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

  let sendInFlight = false;
  const send = async () => {
    if (sendInFlight) return;
    sendInFlight = true;
    try {
      kalshiScreenerCache = null;
      const data = await getCachedKalshiScreenerData();
      const payload = {
        ...data,
        nextRefreshAt: new Date(Date.now() + KALSHI_REFRESH_INTERVAL_MS).toISOString(),
        refreshEverySeconds: Math.floor(KALSHI_REFRESH_INTERVAL_MS / 1000),
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Skip on error
    } finally {
      sendInFlight = false;
    }
  };

  send();
  const interval = setInterval(send, KALSHI_REFRESH_INTERVAL_MS);
  req.on("close", () => clearInterval(interval));
});

// Raw contracts from both venues (Polymarket + Kalshi)
app.get("/api/raw/contracts", async (req, res) => {
  try {
    const force = String(req.query.force || "").toLowerCase() === "true";
    const data = await getRawContractsData(force);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

app.get("/api/arbitrage/cross-opportunities", (_req, res) => {
  try {
    const state = executionService.getState();
    const plans = executionService.getCrossOpportunities();
    res.json({
      ok: true,
      refreshSeq: state.refreshSeq,
      lastRefreshAt: state.lastRefreshAt,
      count: plans.length,
      opportunities: plans,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
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
    if (res.headersSent || res.writableEnded) return;
    res.json({ ok: true, ...result, status: miguelService.getStatus() });
  } catch (err: any) {
    if (res.headersSent || res.writableEnded) return;
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
    if (res.headersSent || res.writableEnded) return;
    res.json({ ok: true, ...result, status: miguelService.getStatus() });
  } catch (err: any) {
    if (res.headersSent || res.writableEnded) return;
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
    if (res.headersSent || res.writableEnded) return;
    res.json({ ok: true, rows, model: modelClient.getStatus() });
  } catch (err: any) {
    if (res.headersSent || res.writableEnded) return;
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

app.get("/api/logs/runtime", (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "200"), 10) || 200, 10), 2000);
    const lines = readLastLogLines(RUNTIME_LOG_PATH, limit);
    const errorLines = lines.filter((line) => line.includes(" ERROR ") || line.toLowerCase().includes("error"));
    res.json({
      ok: true,
      path: RUNTIME_LOG_PATH,
      tradeLogPath: executionService.getTradeLogPath(),
      lines,
      errorLines,
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
