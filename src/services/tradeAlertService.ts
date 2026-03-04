import axios from "axios";
import { TradeAlert } from "../types";

const DATA_API = process.env.DATA_API_URL || "https://data-api.polymarket.com";
const GAMMA_API = process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

// --- Insider suspicion scoring ---

interface SuspicionResult {
  score: number;
  signals: string[];
}

function fmtCash(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function computeSuspicionScore(alert: TradeAlert): SuspicionResult {
  let score = 0;
  const signals: string[] = [];

  // Signal 1: Fresh account
  if (alert.accountAgeDays > 0 && alert.accountAgeDays < 7) {
    score += 30;
    signals.push(`Account only ${alert.accountAgeDays}d old`);
  } else if (alert.isNewAccount) {
    score += 15;
    signals.push(`New account (${alert.accountAgeDays}d)`);
  }

  // Signal 2: First large bet on this market
  if (alert.isFirstLargeBet) {
    score += 20;
    signals.push("First large bet on this market");
  }

  // Signal 3: Timing — large bet close to market resolution
  if (alert.hoursToExpiry > 0 && alert.hoursToExpiry < 12 && alert.cashValue >= 5000) {
    score += 20;
    signals.push(`${alert.hoursToExpiry.toFixed(1)}h to expiry with ${fmtCash(alert.cashValue)} bet`);
  } else if (alert.hoursToExpiry > 0 && alert.hoursToExpiry < 24 && alert.cashValue >= 5000) {
    score += 10;
    signals.push(`${alert.hoursToExpiry.toFixed(1)}h to expiry`);
  }

  // Signal 4: Outsized position value
  if (alert.cashValue >= 50000) {
    score += 25;
    signals.push(`Massive position: ${fmtCash(alert.cashValue)}`);
  } else if (alert.cashValue >= 20000) {
    score += 15;
    signals.push(`Large position: ${fmtCash(alert.cashValue)}`);
  } else if (alert.cashValue >= 10000) {
    score += 10;
    signals.push(`Sizable position: ${fmtCash(alert.cashValue)}`);
  }

  // Signal 5: Accumulation pattern
  if (alert.isAggregated && (alert.tradeCount ?? 0) > 5) {
    score += 15;
    signals.push(`Accumulated via ${alert.tradeCount} trades`);
  } else if (alert.isAggregated && (alert.tradeCount ?? 0) > 2) {
    score += 8;
    signals.push(`Built position over ${alert.tradeCount} trades`);
  }

  return { score: Math.min(score, 100), signals };
}

function attachSuspicionScores(alerts: TradeAlert[]): void {
  for (const alert of alerts) {
    const { score, signals } = computeSuspicionScore(alert);
    alert.suspicionScore = score;
    alert.suspicionSignals = signals;
  }
}

// Caches
let expiringMarketsCache: { conditionIds: Set<string>; marketEndDates: Map<string, string>; expires: number } | null = null;
const profileCache = new Map<string, { createdAt: string; expires: number }>();
const MARKET_CACHE_TTL = 5 * 60 * 1000; // 5 min
const PROFILE_CACHE_TTL = 30 * 60 * 1000; // 30 min
const ALERT_HISTORY: TradeAlert[] = [];
const MAX_HISTORY = 200;

/** Convert Polymarket timestamp (unix seconds, millis, or ISO) → ISO string */
function normalizeTimestamp(raw: any): string {
  if (!raw) return new Date().toISOString();
  // If it's a number or numeric string, treat as unix timestamp
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!isNaN(num) && num > 0) {
    // If it looks like seconds (< 1e12 ≈ year 2001 in millis), multiply by 1000
    const ms = num < 1e12 ? num * 1000 : num;
    return new Date(ms).toISOString();
  }
  // Already a string date — try parsing
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

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

// --- Market end-date enrichment for any stream ---

const endDateCache = new Map<string, { endDate: string; expires: number }>();

async function enrichMarketEndDates(alerts: TradeAlert[]): Promise<void> {
  const now = Date.now();
  // Collect conditionIds that aren't cached yet
  const uncached = new Set<string>();
  for (const a of alerts) {
    if (!a.conditionId) continue;
    const cached = endDateCache.get(a.conditionId);
    if (!cached || now > cached.expires) uncached.add(a.conditionId);
  }

  if (uncached.size > 0) {
    // Fetch in parallel, up to 20 at a time
    const ids = Array.from(uncached);
    const concurrency = 20;
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((cid) =>
          axios.get(`${GAMMA_API}/markets`, {
            params: { condition_id: cid, limit: 1 },
          })
        )
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          const markets = r.value.data || [];
          for (const m of markets) {
            if (m.conditionId) {
              endDateCache.set(m.conditionId, {
                endDate: m.endDate || "",
                expires: now + MARKET_CACHE_TTL,
              });
            }
          }
        }
      }
    }
  }

  // Apply cached end dates to alerts
  const nowDate = new Date();
  for (const a of alerts) {
    const cached = endDateCache.get(a.conditionId);
    if (cached && cached.endDate) {
      a.marketEndDate = cached.endDate;
      const endMs = new Date(cached.endDate).getTime();
      if (!isNaN(endMs)) {
        a.hoursToExpiry = Math.max(0, (endMs - nowDate.getTime()) / (1000 * 60 * 60));
      }
    }
  }
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
      limit: 500,
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

  for (const t of newTrades.slice(0, 50)) {
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
      timestamp: normalizeTimestamp(t.timestamp),
      isNewAccount,
      accountAgeDays,
      isFirstLargeBet: firstBet,
      transactionHash: t.transactionHash || "",
    });
  }

  // Score insider suspicion
  attachSuspicionScores(alerts);

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

/** Fetch the most recent large trades (any market) */
export async function getRecentLargeTrades(): Promise<TradeAlert[]> {
  const tradesResp = await axios.get(`${DATA_API}/trades`, {
    params: {
      filterType: "CASH",
      filterAmount: 2000,
      limit: 500,
      takerOnly: true,
    },
  });

  const rawTrades = tradesResp.data || [];
  const alerts: TradeAlert[] = [];

  for (const t of rawTrades) {
    const cashValue = parseFloat(t.size) * parseFloat(t.price);
    alerts.push({
      trader: t.proxyWallet || "",
      traderName: t.name || t.pseudonym || "Anonymous",
      profileImage: t.profileImage || "",
      side: t.side || "BUY",
      size: parseFloat(t.size) || 0,
      price: parseFloat(t.price) || 0,
      cashValue,
      market: t.title || "",
      outcome: t.outcome || "",
      conditionId: t.conditionId || "",
      marketEndDate: "",
      hoursToExpiry: 0,
      timestamp: normalizeTimestamp(t.timestamp),
      isNewAccount: false,
      accountAgeDays: 0,
      isFirstLargeBet: false,
      transactionHash: t.transactionHash || "",
    });
  }

  await enrichMarketEndDates(alerts);
  attachSuspicionScores(alerts);
  return alerts;
}

// --- Aggregated small-trade detection ---

const AGG_CACHE: { data: TradeAlert[]; expires: number } = { data: [], expires: 0 };
const AGG_CACHE_TTL = 60_000; // 1 min
const AGG_THRESHOLD = 5000; // $5k combined
const AGG_MIN_TRADES = 2; // at least 2 trades to count as "accumulated"

/**
 * Fetch recent trades with NO minimum amount, group by trader+market+side,
 * and surface wallets that have accumulated $5k+ across multiple smaller trades.
 */
export async function getAggregatedAlerts(): Promise<TradeAlert[]> {
  if (Date.now() < AGG_CACHE.expires) return AGG_CACHE.data;

  try {
    // Fetch recent trades — low threshold to catch small accumulations
    const tradesResp = await axios.get(`${DATA_API}/trades`, {
      params: {
        filterType: "CASH",
        filterAmount: 100, // $100 minimum per trade (catches small buys that add up)
        limit: 1000,
        takerOnly: true,
      },
    });

    const rawTrades = tradesResp.data || [];

    // Group by trader + conditionId + side
    const groups = new Map<string, any[]>();
    for (const t of rawTrades) {
      const key = `${t.proxyWallet}|${t.conditionId}|${t.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }

    const aggregated: TradeAlert[] = [];

    for (const [, trades] of groups) {
      if (trades.length < AGG_MIN_TRADES) continue;

      // Sum up cash values
      let totalCash = 0;
      let totalSize = 0;
      let weightedPrice = 0;
      for (const t of trades) {
        const size = parseFloat(t.size) || 0;
        const price = parseFloat(t.price) || 0;
        const cash = size * price;
        totalCash += cash;
        totalSize += size;
        weightedPrice += price * size;
      }

      if (totalCash < AGG_THRESHOLD) continue;

      const avgPrice = totalSize > 0 ? weightedPrice / totalSize : 0;
      // Use the most recent trade for metadata
      const latest = trades[0];
      // Use the earliest trade for the timestamp range
      const earliest = trades[trades.length - 1];

      aggregated.push({
        trader: latest.proxyWallet || "",
        traderName: latest.name || latest.pseudonym || "Anonymous",
        profileImage: latest.profileImage || "",
        side: latest.side || "BUY",
        size: totalSize,
        price: avgPrice,
        cashValue: totalCash,
        market: latest.title || "",
        outcome: latest.outcome || "",
        conditionId: latest.conditionId || "",
        marketEndDate: "",
        hoursToExpiry: 0,
        timestamp: normalizeTimestamp(latest.timestamp),
        isNewAccount: false,
        accountAgeDays: 0,
        isFirstLargeBet: false,
        // Use a synthetic hash so it's unique per group
        transactionHash: `agg-${latest.proxyWallet}-${latest.conditionId}-${latest.side}`,
        isAggregated: true,
        tradeCount: trades.length,
        avgPrice,
      });
    }

    await enrichMarketEndDates(aggregated);

    // Sort by total cash value descending
    aggregated.sort((a, b) => b.cashValue - a.cashValue);

    attachSuspicionScores(aggregated);

    AGG_CACHE.data = aggregated.slice(0, 50);
    AGG_CACHE.expires = Date.now() + AGG_CACHE_TTL;
    return AGG_CACHE.data;
  } catch {
    return AGG_CACHE.data;
  }
}
