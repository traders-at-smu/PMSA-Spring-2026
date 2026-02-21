import express from "express";
import cors from "cors";
import path from "path";
import { getTopTraders, getTraderProfile } from "../services/traderService";
import { getTradeAlerts, getAlertHistory } from "../services/tradeAlertService";
import { ArbitrageScreener } from "../screener";
import { KalshiScreener } from "../kalshiScreener";

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || "3456");

app.use(cors());
app.use(express.json());

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

// ---- Static files (React SPA) ----
const staticDir = path.join(__dirname, "../dashboard-ui/dist");
app.use(express.static(staticDir));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(staticDir, "index.html"));
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
