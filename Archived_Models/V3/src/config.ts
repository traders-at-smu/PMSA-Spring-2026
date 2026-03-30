import fs from "fs";
import path from "path";

export type ExecutionMode = "PAPER" | "LIVE";

// ---- Section Interfaces ----

export interface DashboardSettings {
  port: number;
  bindHost: string;
  initialRefreshOnBoot: boolean;
  refreshIntervalMs: number;
}

export interface ExecutionSettings {
  mode: ExecutionMode;
  autoExecute: boolean;
  bankrollUsd: number;
  maxTradeUsd: number;
  minNetEdge: number;
  minAnnualizedReturn: number;
  defaultLegTickSize: string;
  kalshiUseMakerFees: boolean;
}

export interface LoopConfig {
  enabled: boolean;
  intervalMs: number;
  executeOnArb: boolean;
}

export interface StrategyConfig {
  fixedContractSize: number;
  kpMaxPerTrade: number;
  annualizedEdgeMin: number;
  fees: {
    kalshi: { rate: number; roundMode: string };
    polymarket: {
      default: { feeRate: number; exponent: number };
      categories: Record<string, { feeRate: number; exponent: number; makerRebate?: number }>;
    };
  };
}

export interface AiMatchingConfig {
  confidenceThreshold: number;
  textScoreAutoAcceptMin: number;
  textScoreAiZone: [number, number];
  maxAiCandidates: number;
  fewShotExampleCount: number;
  fewShotSelectionStrategy: "diverse" | "recent" | "hard";
}

export interface RiskConfig {
  maxOpenPositionsPerPair: number;
  maxNotionalPerPair: number;
  maxTotalExposure: number;
  maxDrawdownPct: number;
  circuitBreakerCooldownMin: number;
}

export interface NotificationConfig {
  enabled: boolean;
  telegram: { botToken: string; chatId: string };
  discord: { webhookUrl: string };
  notifyOn: {
    tradeExecuted: boolean;
    arbFound: boolean;
    riskAlert: boolean;
    circuitBreaker: boolean;
  };
}

export interface LiveSafetyConfig {
  requireArm: boolean;
  requireTypedConfirm: boolean;
  confirmTokenTtlSec: number;
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
  kimi: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
}

export interface ExternalApiSettings {
  gammaApiUrl: string;
  clobHttpUrl: string;
  dataApiUrl: string;
  kalshiApiUrl: string;
}

export interface PathsConfig {
  stateDb: string;
  trainingSet: string;
  kimiCache: string;
  embeddingCache: string;
}

export interface RuntimeSettings {
  dashboard: DashboardSettings;
  execution: ExecutionSettings;
  loop: LoopConfig;
  strategy: StrategyConfig;
  aiMatching: AiMatchingConfig;
  risk: RiskConfig;
  notifications: NotificationConfig;
  liveSafety: LiveSafetyConfig;
  apiKeys: ApiKeysSettings;
  externalApis: ExternalApiSettings;
  paths: PathsConfig;
}

// ---- Defaults ----

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
    maxTradeUsd: 100,
    minNetEdge: 0.005,
    minAnnualizedReturn: 0,
    defaultLegTickSize: "0.01",
    kalshiUseMakerFees: false,
  },
  loop: {
    enabled: false,
    intervalMs: 300_000,
    executeOnArb: true,
  },
  strategy: {
    fixedContractSize: 5,
    kpMaxPerTrade: 4.95,
    annualizedEdgeMin: 0.10,
    fees: {
      kalshi: { rate: 0.07, roundMode: "ceil_cent" },
      polymarket: {
        default: { feeRate: 0.0175, exponent: 1 },
        categories: {},
      },
    },
  },
  aiMatching: {
    confidenceThreshold: 0.90,
    textScoreAutoAcceptMin: 0.99,
    textScoreAiZone: [0.50, 0.99],
    maxAiCandidates: 1000,
    fewShotExampleCount: 15,
    fewShotSelectionStrategy: "diverse",
  },
  risk: {
    maxOpenPositionsPerPair: 5,
    maxNotionalPerPair: 250,
    maxTotalExposure: 5000,
    maxDrawdownPct: 0.15,
    circuitBreakerCooldownMin: 60,
  },
  notifications: {
    enabled: false,
    telegram: { botToken: "", chatId: "" },
    discord: { webhookUrl: "" },
    notifyOn: {
      tradeExecuted: true,
      arbFound: false,
      riskAlert: true,
      circuitBreaker: true,
    },
  },
  liveSafety: {
    requireArm: true,
    requireTypedConfirm: true,
    confirmTokenTtlSec: 600,
  },
  apiKeys: {
    polymarket: { privateKey: "", proxyWalletAddress: "", rpcUrl: "" },
    kalshi: {
      apiUrl: "https://api.elections.kalshi.com/trade-api/v2",
      tradingApiUrl: "", apiKey: "", apiSecret: "",
      apiPassphrase: "", bearerToken: "", orderEndpoint: "",
    },
    kimi: { apiKey: "", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k2.5" },
  },
  externalApis: {
    gammaApiUrl: "https://gamma-api.polymarket.com",
    clobHttpUrl: "https://clob.polymarket.com",
    dataApiUrl: "https://data-api.polymarket.com",
    kalshiApiUrl: "https://api.elections.kalshi.com/trade-api/v2",
  },
  paths: {
    stateDb: "data/state.db",
    trainingSet: "data/training-set.json",
    kimiCache: "data/kimi-match-cache.json",
    embeddingCache: "data/embedding-cache.json",
  },
};

// ---- Internals ----

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
  const s = { ...settings };

  // Dashboard
  if (process.env.DASHBOARD_PORT) s.dashboard.port = parseInt(process.env.DASHBOARD_PORT, 10);
  if (process.env.DASHBOARD_BIND_HOST) s.dashboard.bindHost = process.env.DASHBOARD_BIND_HOST;

  // Execution
  const mode = process.env.ARB_EXECUTION_MODE;
  if (mode === "PAPER" || mode === "LIVE") s.execution.mode = mode;
  if (process.env.ARB_AUTO_EXECUTE) s.execution.autoExecute = process.env.ARB_AUTO_EXECUTE === "true";
  if (process.env.ARB_BANKROLL_USD) s.execution.bankrollUsd = Number(process.env.ARB_BANKROLL_USD);
  if (process.env.ARB_MIN_NET_EDGE) s.execution.minNetEdge = Number(process.env.ARB_MIN_NET_EDGE);
  if (process.env.ARB_DEFAULT_TICK_SIZE) s.execution.defaultLegTickSize = process.env.ARB_DEFAULT_TICK_SIZE;
  if (process.env.KALSHI_USE_MAKER_FEES) s.execution.kalshiUseMakerFees = process.env.KALSHI_USE_MAKER_FEES === "true";

  // Loop
  if (process.env.LOOP_INTERVAL_MS) s.loop.intervalMs = Number(process.env.LOOP_INTERVAL_MS);

  // AI Matching
  if (process.env.AI_CONFIDENCE_THRESHOLD) s.aiMatching.confidenceThreshold = Number(process.env.AI_CONFIDENCE_THRESHOLD);

  // Polymarket keys
  if (process.env.PRIVATE_KEY) s.apiKeys.polymarket.privateKey = process.env.PRIVATE_KEY;
  if (process.env.MY_PROXY_WALLET_ADDRESS) s.apiKeys.polymarket.proxyWalletAddress = process.env.MY_PROXY_WALLET_ADDRESS;
  if (process.env.RPC_URL) s.apiKeys.polymarket.rpcUrl = process.env.RPC_URL;

  // Kalshi keys
  if (process.env.KALSHI_API_URL) s.apiKeys.kalshi.apiUrl = process.env.KALSHI_API_URL;
  if (process.env.KALSHI_TRADING_API_URL) s.apiKeys.kalshi.tradingApiUrl = process.env.KALSHI_TRADING_API_URL;
  if (process.env.KALSHI_API_KEY) s.apiKeys.kalshi.apiKey = process.env.KALSHI_API_KEY;
  if (process.env.KALSHI_API_SECRET) s.apiKeys.kalshi.apiSecret = process.env.KALSHI_API_SECRET;
  if (process.env.KALSHI_API_PASSPHRASE) s.apiKeys.kalshi.apiPassphrase = process.env.KALSHI_API_PASSPHRASE;
  if (process.env.KALSHI_BEARER_TOKEN) s.apiKeys.kalshi.bearerToken = process.env.KALSHI_BEARER_TOKEN;
  if (process.env.KALSHI_ORDER_ENDPOINT) s.apiKeys.kalshi.orderEndpoint = process.env.KALSHI_ORDER_ENDPOINT;

  // Kimi keys
  if (process.env.KIMI_API_KEY) s.apiKeys.kimi.apiKey = process.env.KIMI_API_KEY;
  if (process.env.KIMI_BASE_URL) s.apiKeys.kimi.baseUrl = process.env.KIMI_BASE_URL;
  if (process.env.KIMI_MODEL) s.apiKeys.kimi.model = process.env.KIMI_MODEL;

  // Notifications
  if (process.env.TELEGRAM_BOT_TOKEN) s.notifications.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) s.notifications.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
  if (process.env.DISCORD_WEBHOOK_URL) s.notifications.discord.webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  // External APIs
  if (process.env.GAMMA_API_URL) s.externalApis.gammaApiUrl = process.env.GAMMA_API_URL;
  if (process.env.CLOB_HTTP_URL) s.externalApis.clobHttpUrl = process.env.CLOB_HTTP_URL;
  if (process.env.DATA_API_URL) s.externalApis.dataApiUrl = process.env.DATA_API_URL;
  if (process.env.KALSHI_API_URL) s.externalApis.kalshiApiUrl = process.env.KALSHI_API_URL;

  return s;
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
  if (!Number.isFinite(settings.loop.intervalMs) || settings.loop.intervalMs < 10_000) {
    throw new Error("loop.intervalMs must be >= 10000 (10 seconds)");
  }
  if (settings.aiMatching.confidenceThreshold < 0 || settings.aiMatching.confidenceThreshold > 1) {
    throw new Error("aiMatching.confidenceThreshold must be between 0 and 1");
  }
}

// ---- Public API ----

export function getSettingsWithMeta(): { settings: RuntimeSettings; loadedFrom: string[] } {
  if (cached) return cached;

  const base = readJson(SETTINGS_PATH, true);
  const local = readJson(SETTINGS_LOCAL_PATH, false);

  let merged = deepMerge(defaults, base);
  merged = deepMerge(merged, local);
  const settings = envOverride(merged);
  validateShape(settings);

  // Bridge env-based modules
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

export function invalidateSettingsCache(): void {
  cached = null;
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function saveSettings(updates: Record<string, unknown>): RuntimeSettings {
  const existing = readJson(SETTINGS_PATH, true);
  const merged = deepMerge(existing, updates) as Record<string, unknown>;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
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
      kimi: {
        apiKey: mask(s.apiKeys.kimi.apiKey),
        baseUrl: s.apiKeys.kimi.baseUrl,
        model: s.apiKeys.kimi.model,
      },
    },
    notifications: {
      ...s.notifications,
      telegram: {
        botToken: mask(s.notifications.telegram.botToken),
        chatId: s.notifications.telegram.chatId,
      },
      discord: { webhookUrl: mask(s.notifications.discord.webhookUrl) },
    },
  };
}

export function validateSettingsForMode(mode: ExecutionMode, settings = getSettings()): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const poly = settings.apiKeys.polymarket;
  if (!poly.privateKey || !poly.proxyWalletAddress || !poly.rpcUrl) {
    reasons.push("Polymarket live trading requires privateKey, proxyWalletAddress, rpcUrl");
  }
  if (!hasKalshiLiveTradingCredentials(settings)) {
    reasons.push("Kalshi live trading requires a real apiKey/apiSecret");
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
