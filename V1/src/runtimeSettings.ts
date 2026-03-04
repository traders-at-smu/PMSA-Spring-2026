import fs from "fs";
import path from "path";

export type ExecutionMode = "PAPER" | "LIVE";

export interface DashboardSettings {
  port: number;
  bindHost: string;
  initialRefreshOnBoot: boolean;
  refreshIntervalMs: number;
}

export interface ExecutionSettingsFile {
  mode: ExecutionMode;
  autoExecute: boolean;
  bankrollUsd: number;
  minNetEdge: number;
  defaultLegTickSize: string;
  kalshiUseMakerFees: boolean;
}

export interface ApiKeysSettings {
  polymarket: {
    privateKey: string;
    proxyWalletAddress: string;
    rpcUrl: string;
  };
  kalshi: {
    apiUrl: string;
    tradingApiUrl: string;
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    bearerToken: string;
    orderEndpoint: string;
  };
}

export interface ExternalApiSettings {
  gammaApiUrl: string;
  clobHttpUrl: string;
  dataApiUrl: string;
  kalshiApiUrl: string;
}

export interface RuntimeSettings {
  dashboard: DashboardSettings;
  execution: ExecutionSettingsFile;
  apiKeys: ApiKeysSettings;
  externalApis: ExternalApiSettings;
  python: {
    pythonExecutable: string;
    modelBridgePath: string;
    miguelScriptsDir: string;
    miguel: {
      pollIntervalSec: number;
      minPairs: number;
    };
  };
}

const defaults: RuntimeSettings = {
  dashboard: {
    port: 3456,
    bindHost: "0.0.0.0",
    initialRefreshOnBoot: true,
    refreshIntervalMs: 60_000,
  },
  execution: {
    mode: "PAPER",
    autoExecute: false,
    bankrollUsd: 10000,
    minNetEdge: 0.005,
    defaultLegTickSize: "0.01",
    kalshiUseMakerFees: false,
  },
  apiKeys: {
    polymarket: {
      privateKey: "",
      proxyWalletAddress: "",
      rpcUrl: "",
    },
    kalshi: {
      apiUrl: "https://api.elections.kalshi.com/trade-api/v2",
      tradingApiUrl: "",
      apiKey: "",
      apiSecret: "",
      apiPassphrase: "",
      bearerToken: "",
      orderEndpoint: "",
    },
  },
  externalApis: {
    gammaApiUrl: "https://gamma-api.polymarket.com",
    clobHttpUrl: "https://clob.polymarket.com",
    dataApiUrl: "https://data-api.polymarket.com",
    kalshiApiUrl: "https://api.elections.kalshi.com/trade-api/v2",
  },
  python: {
    pythonExecutable: "python",
    modelBridgePath: "python/model_v1_bridge.py",
    miguelScriptsDir: "python",
    miguel: {
      pollIntervalSec: 30,
      minPairs: 50,
    },
  },
};

const SETTINGS_PATH = path.resolve(process.cwd(), "config", "settings.json");
const SETTINGS_LOCAL_PATH = path.resolve(process.cwd(), "config", "settings.local.json");

let cached: { settings: RuntimeSettings; loadedFrom: string[] } | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isObject(base) || !isObject(overlay)) return (overlay as T) ?? base;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const cur = merged[k];
    if (isObject(cur) && isObject(v)) {
      merged[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      merged[k] = v;
    }
  }
  return merged as T;
}

function readJson(filePath: string, required: boolean): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Missing required settings file: ${filePath}`);
    return {};
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error("Settings root must be an object");
    return parsed;
  } catch (err: any) {
    throw new Error(`Failed parsing settings JSON at ${filePath}: ${err?.message || err}`);
  }
}

function envOverride(settings: RuntimeSettings): RuntimeSettings {
  const mode = process.env.ARB_EXECUTION_MODE;
  const withEnv = { ...settings };

  if (process.env.DASHBOARD_PORT) withEnv.dashboard.port = parseInt(process.env.DASHBOARD_PORT, 10);
  if (process.env.DASHBOARD_BIND_HOST) withEnv.dashboard.bindHost = process.env.DASHBOARD_BIND_HOST;

  if (mode === "PAPER" || mode === "LIVE") withEnv.execution.mode = mode;
  if (process.env.ARB_AUTO_EXECUTE) withEnv.execution.autoExecute = process.env.ARB_AUTO_EXECUTE === "true";
  if (process.env.ARB_BANKROLL_USD) withEnv.execution.bankrollUsd = Number(process.env.ARB_BANKROLL_USD);
  if (process.env.ARB_MIN_NET_EDGE) withEnv.execution.minNetEdge = Number(process.env.ARB_MIN_NET_EDGE);
  if (process.env.ARB_DEFAULT_TICK_SIZE) withEnv.execution.defaultLegTickSize = process.env.ARB_DEFAULT_TICK_SIZE;
  if (process.env.KALSHI_USE_MAKER_FEES) withEnv.execution.kalshiUseMakerFees = process.env.KALSHI_USE_MAKER_FEES === "true";

  if (process.env.PRIVATE_KEY) withEnv.apiKeys.polymarket.privateKey = process.env.PRIVATE_KEY;
  if (process.env.MY_PROXY_WALLET_ADDRESS) withEnv.apiKeys.polymarket.proxyWalletAddress = process.env.MY_PROXY_WALLET_ADDRESS;
  if (process.env.RPC_URL) withEnv.apiKeys.polymarket.rpcUrl = process.env.RPC_URL;

  if (process.env.KALSHI_API_URL) withEnv.apiKeys.kalshi.apiUrl = process.env.KALSHI_API_URL;
  if (process.env.KALSHI_TRADING_API_URL) withEnv.apiKeys.kalshi.tradingApiUrl = process.env.KALSHI_TRADING_API_URL;
  if (process.env.KALSHI_API_KEY) withEnv.apiKeys.kalshi.apiKey = process.env.KALSHI_API_KEY;
  if (process.env.KALSHI_API_SECRET) withEnv.apiKeys.kalshi.apiSecret = process.env.KALSHI_API_SECRET;
  if (process.env.KALSHI_API_PASSPHRASE) withEnv.apiKeys.kalshi.apiPassphrase = process.env.KALSHI_API_PASSPHRASE;
  if (process.env.KALSHI_BEARER_TOKEN) withEnv.apiKeys.kalshi.bearerToken = process.env.KALSHI_BEARER_TOKEN;
  if (process.env.KALSHI_ORDER_ENDPOINT) withEnv.apiKeys.kalshi.orderEndpoint = process.env.KALSHI_ORDER_ENDPOINT;

  if (process.env.GAMMA_API_URL) withEnv.externalApis.gammaApiUrl = process.env.GAMMA_API_URL;
  if (process.env.CLOB_HTTP_URL) withEnv.externalApis.clobHttpUrl = process.env.CLOB_HTTP_URL;
  if (process.env.DATA_API_URL) withEnv.externalApis.dataApiUrl = process.env.DATA_API_URL;
  if (process.env.KALSHI_API_URL) withEnv.externalApis.kalshiApiUrl = process.env.KALSHI_API_URL;
  if (process.env.PYTHON_EXECUTABLE) withEnv.python.pythonExecutable = process.env.PYTHON_EXECUTABLE;
  if (process.env.MODEL_V1_BRIDGE_PATH) withEnv.python.modelBridgePath = process.env.MODEL_V1_BRIDGE_PATH;
  if (process.env.MIGUEL_SCRIPTS_DIR) withEnv.python.miguelScriptsDir = process.env.MIGUEL_SCRIPTS_DIR;
  if (process.env.MIGUEL_POLL_INTERVAL_SEC) withEnv.python.miguel.pollIntervalSec = Number(process.env.MIGUEL_POLL_INTERVAL_SEC);
  if (process.env.MIGUEL_MIN_PAIRS) withEnv.python.miguel.minPairs = Number(process.env.MIGUEL_MIN_PAIRS);

  return withEnv;
}

function validateShape(settings: RuntimeSettings): void {
  if (!Number.isFinite(settings.dashboard.port) || settings.dashboard.port <= 0) {
    throw new Error("dashboard.port must be a positive integer");
  }
  if (!["PAPER", "LIVE"].includes(settings.execution.mode)) {
    throw new Error("execution.mode must be PAPER or LIVE");
  }
  if (!Number.isFinite(settings.execution.bankrollUsd) || settings.execution.bankrollUsd <= 0) {
    throw new Error("execution.bankrollUsd must be a positive number");
  }
  if (!Number.isFinite(settings.execution.minNetEdge) || settings.execution.minNetEdge < 0) {
    throw new Error("execution.minNetEdge must be >= 0");
  }
  if (!settings.python.pythonExecutable) {
    throw new Error("python.pythonExecutable must be provided");
  }
  if (!settings.python.modelBridgePath) {
    throw new Error("python.modelBridgePath must be provided");
  }
  if (!Number.isFinite(settings.python.miguel.pollIntervalSec) || settings.python.miguel.pollIntervalSec < 1) {
    throw new Error("python.miguel.pollIntervalSec must be >= 1");
  }
  if (!Number.isFinite(settings.python.miguel.minPairs) || settings.python.miguel.minPairs < 1) {
    throw new Error("python.miguel.minPairs must be >= 1");
  }
}

export function validateSettingsForMode(mode: ExecutionMode, settings = getSettings()): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const poly = settings.apiKeys.polymarket;
  if (!poly.privateKey || !poly.proxyWalletAddress || !poly.rpcUrl) {
    reasons.push("Polymarket live trading requires privateKey, proxyWalletAddress, rpcUrl");
  }

  if (!hasKalshiLiveTradingCredentials(settings)) {
    reasons.push(
      "Kalshi market data is public, but LIVE Kalshi trading requires a real private apiKey/apiSecret; until then Kalshi opportunities are paper-only"
    );
  }

  if (mode === "LIVE" && reasons.length > 0) return { ok: false, reasons };
  return { ok: true, reasons };
}

function isRealCredential(value: string): boolean {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  if (upper.startsWith("YOUR_")) return false;
  if (upper.includes("PLACEHOLDER")) return false;
  if (upper.includes("REPLACE_ME")) return false;
  if (trimmed.includes("<") && trimmed.includes(">")) return false;
  return true;
}

export function hasKalshiLiveTradingCredentials(settings = getSettings()): boolean {
  const kalshi = settings.apiKeys.kalshi;
  const hasApiBase = Boolean((kalshi.tradingApiUrl || kalshi.apiUrl || "").trim());
  return hasApiBase && isRealCredential(kalshi.apiKey) && isRealCredential(kalshi.apiSecret);
}

export function getSettingsWithMeta(): { settings: RuntimeSettings; loadedFrom: string[] } {
  if (cached) return cached;

  const base = readJson(SETTINGS_PATH, true);
  const local = readJson(SETTINGS_LOCAL_PATH, false);

  let merged = deepMerge(defaults, base);
  merged = deepMerge(merged, local);
  const settings = envOverride(merged);
  validateShape(settings);

  // Bridge existing env-based modules during migration.
  process.env.GAMMA_API_URL = settings.externalApis.gammaApiUrl;
  process.env.CLOB_HTTP_URL = settings.externalApis.clobHttpUrl;
  process.env.DATA_API_URL = settings.externalApis.dataApiUrl;
  process.env.KALSHI_API_URL = settings.externalApis.kalshiApiUrl;
  process.env.DASHBOARD_PORT = String(settings.dashboard.port);
  process.env.RPC_URL = process.env.RPC_URL || settings.apiKeys.polymarket.rpcUrl;
  process.env.PRIVATE_KEY = process.env.PRIVATE_KEY || settings.apiKeys.polymarket.privateKey;
  process.env.MY_PROXY_WALLET_ADDRESS = process.env.MY_PROXY_WALLET_ADDRESS || settings.apiKeys.polymarket.proxyWalletAddress;

  cached = {
    settings,
    loadedFrom: [SETTINGS_PATH, ...(fs.existsSync(SETTINGS_LOCAL_PATH) ? [SETTINGS_LOCAL_PATH] : [])],
  };

  return cached;
}

export function getSettings(): RuntimeSettings {
  return getSettingsWithMeta().settings;
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function saveSettings(updates: Record<string, unknown>): RuntimeSettings {
  // Read existing settings file
  const existing = readJson(SETTINGS_PATH, true);
  // Deep merge updates into existing
  const merged = deepMerge(existing, updates) as Record<string, unknown>;
  // Write back
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  // Invalidate cache so next getSettings() picks up changes
  cached = null;
  return getSettings();
}

export function getRedactedSettings(): RuntimeSettings {
  const s = getSettings();
  return {
    ...s,
    apiKeys: {
      polymarket: {
        privateKey: mask(s.apiKeys.polymarket.privateKey),
        proxyWalletAddress: mask(s.apiKeys.polymarket.proxyWalletAddress),
        rpcUrl: s.apiKeys.polymarket.rpcUrl,
      },
      kalshi: {
        apiUrl: s.apiKeys.kalshi.apiUrl,
        tradingApiUrl: s.apiKeys.kalshi.tradingApiUrl,
        apiKey: mask(s.apiKeys.kalshi.apiKey),
        apiSecret: mask(s.apiKeys.kalshi.apiSecret),
        apiPassphrase: mask(s.apiKeys.kalshi.apiPassphrase),
        bearerToken: mask(s.apiKeys.kalshi.bearerToken),
        orderEndpoint: s.apiKeys.kalshi.orderEndpoint,
      },
    },
  };
}
