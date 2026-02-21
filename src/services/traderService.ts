import axios from "axios";
import { LeaderboardEntry, TraderProfile } from "../types";

const DATA_API = process.env.DATA_API_URL || "https://data-api.polymarket.com";
const GAMMA_API = process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

// Cache with TTL
let leaderboardCache: { data: LeaderboardEntry[]; key: string; expires: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getTopTraders(
  orderBy: "PNL" | "VOL" = "PNL",
  timePeriod: "DAY" | "WEEK" | "MONTH" | "ALL" = "ALL",
  category: string = "OVERALL",
  limit: number = 50
): Promise<LeaderboardEntry[]> {
  const cacheKey = `${orderBy}-${timePeriod}-${category}-${limit}`;
  if (leaderboardCache && leaderboardCache.key === cacheKey && Date.now() < leaderboardCache.expires) {
    return leaderboardCache.data;
  }

  const resp = await axios.get(`${DATA_API}/v1/leaderboard`, {
    params: { orderBy, timePeriod, category, limit },
  });

  const entries: LeaderboardEntry[] = (resp.data || []).map((e: any) => ({
    rank: parseInt(e.rank) || 0,
    proxyWallet: e.proxyWallet || "",
    userName: e.userName || e.pseudonym || "Anonymous",
    pnl: parseFloat(e.pnl) || 0,
    vol: parseFloat(e.vol) || 0,
    profileImage: e.profileImage || "",
    xUsername: e.xUsername || "",
    verifiedBadge: e.verifiedBadge || false,
  }));

  leaderboardCache = { data: entries, key: cacheKey, expires: Date.now() + CACHE_TTL };
  return entries;
}

export async function getTraderProfile(address: string): Promise<TraderProfile | null> {
  try {
    // Fetch leaderboard rank
    const rankResp = await axios.get(`${DATA_API}/v1/leaderboard`, {
      params: { user: address, timePeriod: "ALL" },
    });
    const rankData = rankResp.data?.[0];

    // Fetch positions and portfolio value in parallel
    const [posResp, valueResp] = await Promise.all([
      axios.get(`${DATA_API}/positions`, {
        params: { user: address, sortBy: "CASHPNL", sortDirection: "DESC", limit: 10, sizeThreshold: 0 },
      }),
      axios.get(`${DATA_API}/value`, {
        params: { user: address },
      }),
    ]);

    const portfolioValue = posResp.data?.length > 0
      ? (valueResp.data?.[0]?.value ? parseFloat(valueResp.data[0].value) : 0)
      : 0;

    const topPositions = (posResp.data || []).map((p: any) => ({
      title: p.title || "",
      outcome: p.outcome || "",
      size: parseFloat(p.size) || 0,
      curPrice: parseFloat(p.curPrice) || 0,
      cashPnl: parseFloat(p.cashPnl) || 0,
      percentPnl: parseFloat(p.percentPnl) || 0,
    }));

    return {
      rank: parseInt(rankData?.rank) || 0,
      proxyWallet: address,
      userName: rankData?.userName || rankData?.pseudonym || "Anonymous",
      pnl: parseFloat(rankData?.pnl) || 0,
      vol: parseFloat(rankData?.vol) || 0,
      profileImage: rankData?.profileImage || "",
      xUsername: rankData?.xUsername || "",
      verifiedBadge: rankData?.verifiedBadge || false,
      portfolioValue,
      topPositions,
    };
  } catch {
    return null;
  }
}
