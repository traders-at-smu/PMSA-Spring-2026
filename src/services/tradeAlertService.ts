import axios from "axios";
import { TradeAlert } from "../types";

const DATA_API = process.env.DATA_API_URL || "https://data-api.polymarket.com";
const GAMMA_API = process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

// Caches
let expiringMarketsCache: { conditionIds: Set<string>; marketEndDates: Map<string, string>; expires: number } | null = null;
const profileCache = new Map<string, { createdAt: string; expires: number }>();
const MARKET_CACHE_TTL = 5 * 60 * 1000; // 5 min
const PROFILE_CACHE_TTL = 30 * 60 * 1000; // 30 min
const ALERT_HISTORY: TradeAlert[] = [];
const MAX_HISTORY = 200;

async function getExpiringMarkets(): Promise<{ conditionIds: Set<string>; endDates: Map<string, string> }> {
  if (expiringMarketsCache && Date.now() < expiringMarketsCache.expires) {
    return { conditionIds: expiringMarketsCache.conditionIds, endDates: expiringMarketsCache.marketEndDates };
  }

  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const resp = await axios.get(`${GAMMA_API}/markets`, {
    params: {
      active: true,
      closed: false,
      end_date_min: now.toISOString(),
      end_date_max: in48h.toISOString(),
      limit: 500,
    },
  });

  const conditionIds = new Set<string>();
  const endDates = new Map<string, string>();

  for (const m of resp.data || []) {
    if (m.conditionId) {
      conditionIds.add(m.conditionId);
      endDates.set(m.conditionId, m.endDate || "");
    }
  }

  expiringMarketsCache = { conditionIds, marketEndDates: endDates, expires: Date.now() + MARKET_CACHE_TTL };
  return { conditionIds, endDates };
}

async function getProfileCreatedAt(address: string): Promise<{ createdAt: string }> {
  const cached = profileCache.get(address);
  if (cached && Date.now() < cached.expires) {
    return { createdAt: cached.createdAt };
  }

  try {
    const resp = await axios.get(`${GAMMA_API}/public-profile`, {
      params: { address },
    });
    const createdAt = resp.data?.createdAt || "";
    profileCache.set(address, { createdAt, expires: Date.now() + PROFILE_CACHE_TTL });
    return { createdAt };
  } catch {
    return { createdAt: "" };
  }
}

async function isFirstLargeBetOnMarket(traderAddress: string, conditionId: string): Promise<boolean> {
  try {
    const resp = await axios.get(`${DATA_API}/trades`, {
      params: {
        user: traderAddress,
        market: conditionId,
        filterType: "CASH",
        filterAmount: 5000,
        limit: 5,
      },
    });
    return (resp.data || []).length <= 1;
  } catch {
    return false;
  }
}

export async function getTradeAlerts(): Promise<TradeAlert[]> {
  const { conditionIds, endDates } = await getExpiringMarkets();

  if (conditionIds.size === 0) {
    return ALERT_HISTORY;
  }

  // Fetch recent large trades globally
  const tradesResp = await axios.get(`${DATA_API}/trades`, {
    params: {
      filterType: "CASH",
      filterAmount: 5000,
      limit: 100,
      takerOnly: true,
    },
  });

  const rawTrades = tradesResp.data || [];

  // Filter to trades on expiring markets
  const expiringTrades = rawTrades.filter((t: any) => conditionIds.has(t.conditionId));

  // Deduplicate against history by transactionHash
  const existingHashes = new Set(ALERT_HISTORY.map((a) => a.transactionHash));
  const newTrades = expiringTrades.filter((t: any) => !existingHashes.has(t.transactionHash));

  // Enrich new trades (limit concurrent profile lookups)
  const alerts: TradeAlert[] = [];

  for (const t of newTrades.slice(0, 20)) {
    const traderAddr = t.proxyWallet || "";
    const now = new Date();
    const marketEnd = endDates.get(t.conditionId) || "";
    const hoursToExpiry = marketEnd
      ? Math.max(0, (new Date(marketEnd).getTime() - now.getTime()) / (1000 * 60 * 60))
      : 0;

    // Get profile and first-bet check in parallel
    const [profile, firstBet] = await Promise.all([
      getProfileCreatedAt(traderAddr),
      isFirstLargeBetOnMarket(traderAddr, t.conditionId),
    ]);

    let accountAgeDays = 0;
    let isNewAccount = false;
    if (profile.createdAt) {
      accountAgeDays = Math.floor(
        (now.getTime() - new Date(profile.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      );
      isNewAccount = accountAgeDays <= 30;
    }

    const cashValue = parseFloat(t.size) * parseFloat(t.price);

    alerts.push({
      trader: traderAddr,
      traderName: t.name || t.pseudonym || "Anonymous",
      profileImage: t.profileImage || "",
      side: t.side || "BUY",
      size: parseFloat(t.size) || 0,
      price: parseFloat(t.price) || 0,
      cashValue,
      market: t.title || "",
      outcome: t.outcome || "",
      conditionId: t.conditionId || "",
      marketEndDate: marketEnd,
      hoursToExpiry: Math.round(hoursToExpiry * 10) / 10,
      timestamp: t.timestamp || new Date().toISOString(),
      isNewAccount,
      accountAgeDays,
      isFirstLargeBet: firstBet,
      transactionHash: t.transactionHash || "",
    });
  }

  // Prepend new alerts to history
  ALERT_HISTORY.unshift(...alerts);
  if (ALERT_HISTORY.length > MAX_HISTORY) {
    ALERT_HISTORY.length = MAX_HISTORY;
  }

  return ALERT_HISTORY;
}

export function getAlertHistory(): TradeAlert[] {
  return ALERT_HISTORY;
}
