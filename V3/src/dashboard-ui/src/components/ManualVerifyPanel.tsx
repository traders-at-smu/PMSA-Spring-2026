import { useState } from "react";
import { usePolling } from "../hooks/usePolling";

// ---- Types ----

interface MatchedPair {
  polymarketTitle: string;
  kalshiTitle: string;
  polymarketUrl: string;
  kalshiUrl: string;
  polymarketSlug: string;
  kalshiTicker: string;
  similarityScore: number;
  category: string;
  polyYesBid: number;
  polyYesAsk: number;
  kalshiYesBid: number;
  kalshiYesAsk: number;
  hasArb: boolean;
  endDate?: string;
}

interface PairsResponse {
  pairs: MatchedPair[];
  timestamp: string;
}

interface VerifiedPairsResponse {
  pairs: { pair_key: string; kalshi_ticker: string; polymarket_slug: string; label: string }[];
  keys: string[];
}

// ---- Component ----

export function ManualVerifyPanel({ paused }: { paused: boolean }) {
  const { data: pairsData, loading: pairsLoading, refetch: refetchPairs } = usePolling<PairsResponse>(
    "/api/cross-platform/pairs",
    30_000,
    paused
  );
  const { data: verifiedData, refetch: refetchVerified } = usePolling<VerifiedPairsResponse>(
    "/api/cross-platform/verified-pairs",
    10_000,
    paused
  );

  const [filter, setFilter] = useState<"all" | "unverified" | "verified" | "arb">("unverified");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [acting, setActing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const verifiedKeys = new Set(verifiedData?.keys ?? []);
  const pairs = pairsData?.pairs ?? [];

  // Build category list
  const categories = ["all", ...new Set(pairs.map((p) => p.category))];

  // Filter pairs
  const filtered = pairs.filter((p) => {
    const key = `${p.kalshiTicker}|${p.polymarketSlug}`;
    const isVerified = verifiedKeys.has(key);

    if (filter === "unverified" && isVerified) return false;
    if (filter === "verified" && !isVerified) return false;
    if (filter === "arb" && !p.hasArb) return false;
    if (catFilter !== "all" && p.category !== catFilter) return false;
    return true;
  });

  const handleVerdict = async (pair: MatchedPair, action: "approve" | "reject") => {
    const key = `${pair.kalshiTicker}|${pair.polymarketSlug}`;
    setActing(key);
    try {
      if (action === "approve") {
        await fetch("/api/cross-platform/pairs/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kalshiTicker: pair.kalshiTicker,
            polymarketSlug: pair.polymarketSlug,
            verified: true,
            label: `manual_${new Date().toISOString()}`,
          }),
        });
        // Also add as training example
        await fetch("/api/training/add-example", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            polymarketTitle: pair.polymarketTitle,
            kalshiTitle: pair.kalshiTitle,
            polymarketSlug: pair.polymarketSlug,
            kalshiTicker: pair.kalshiTicker,
            label: "correct",
            category: pair.category,
            notes: "Manually verified via dashboard",
          }),
        });
      } else {
        await fetch("/api/cross-platform/pairs/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kalshiTicker: pair.kalshiTicker,
            polymarketSlug: pair.polymarketSlug,
            verified: false,
          }),
        });
        // Add as negative training example
        await fetch("/api/training/add-example", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            polymarketTitle: pair.polymarketTitle,
            kalshiTitle: pair.kalshiTitle,
            polymarketSlug: pair.polymarketSlug,
            kalshiTicker: pair.kalshiTicker,
            label: "incorrect",
            category: pair.category,
            notes: "Manually rejected via dashboard",
          }),
        });
      }
      refetchVerified();
    } catch {
      // silently fail
    } finally {
      setActing(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/cross-platform/refresh", { method: "POST" });
      refetchPairs();
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Manual Pair Verification</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Click links to inspect markets, then approve or deny each pair. Approved pairs feed into the trading loop and AI training set.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {verifiedKeys.size} verified · {pairs.length} total pairs
          </span>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.06] text-zinc-300 hover:bg-white/[0.10] border border-white/[0.08] disabled:opacity-50"
          >
            {refreshing ? "Scanning..." : "Refresh Pairs"}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
          {(["all", "unverified", "verified", "arb"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f
                  ? "bg-[#CC0035]/20 text-[#CC0035] border-[#CC0035]/30"
                  : "bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06]"
              }`}
            >
              {f === "all" ? "All" : f === "unverified" ? "Unverified" : f === "verified" ? "Verified" : "Has Arb"}
            </button>
          ))}
        </div>

        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.06] text-zinc-300 border border-white/[0.08]"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === "all" ? "All Categories" : c}
            </option>
          ))}
        </select>

        <span className="text-xs text-zinc-500 ml-auto">
          Showing {filtered.length} of {pairs.length}
        </span>
      </div>

      {/* Pairs List */}
      {pairsLoading && pairs.length === 0 ? (
        <div className="text-center text-zinc-500 py-12 text-sm">Loading pairs...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-zinc-500 py-12 text-sm">No pairs match current filters</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((pair) => {
            const key = `${pair.kalshiTicker}|${pair.polymarketSlug}`;
            const isVerified = verifiedKeys.has(key);
            const isActing = acting === key;

            return (
              <div
                key={key}
                className={`rounded-xl border p-4 transition-colors ${
                  isVerified
                    ? "border-emerald-500/30 bg-emerald-500/[0.04]"
                    : "border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Left: Market details */}
                  <div className="flex-1 min-w-0 space-y-3">
                    {/* Polymarket */}
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold tracking-wider text-blue-400 uppercase">Polymarket</span>
                        {pair.hasArb && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-semibold">ARB</span>
                        )}
                      </div>
                      <a
                        href={pair.polymarketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-zinc-200 hover:text-blue-400 transition-colors leading-tight block truncate"
                      >
                        {pair.polymarketTitle}
                      </a>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                        <span>Bid {(pair.polyYesBid * 100).toFixed(0)}¢</span>
                        <span>Ask {(pair.polyYesAsk * 100).toFixed(0)}¢</span>
                      </div>
                    </div>

                    {/* Kalshi */}
                    <div>
                      <span className="text-[10px] font-bold tracking-wider text-orange-400 uppercase">Kalshi</span>
                      <a
                        href={pair.kalshiUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-zinc-200 hover:text-orange-400 transition-colors leading-tight block truncate mt-1"
                      >
                        {pair.kalshiTitle}
                      </a>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                        <span>Bid {(pair.kalshiYesBid * 100).toFixed(0)}¢</span>
                        <span>Ask {(pair.kalshiYesAsk * 100).toFixed(0)}¢</span>
                      </div>
                    </div>

                    {/* Meta */}
                    <div className="flex items-center gap-4 text-[11px] text-zinc-500">
                      <span>Score: {(pair.similarityScore * 100).toFixed(0)}%</span>
                      <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-zinc-400">{pair.category}</span>
                      {pair.endDate && (
                        <span>Expires: {new Date(pair.endDate).toLocaleDateString()}</span>
                      )}
                      {isVerified && (
                        <span className="text-emerald-400 font-semibold">Verified</span>
                      )}
                    </div>
                  </div>

                  {/* Right: Action buttons */}
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleVerdict(pair, "approve")}
                      disabled={isActing || isVerified}
                      className={`px-4 py-2 text-xs font-semibold rounded-lg transition-all ${
                        isVerified
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 cursor-default"
                          : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 hover:border-emerald-500/40"
                      } disabled:opacity-50`}
                    >
                      {isVerified ? "Approved" : "Approve"}
                    </button>
                    <button
                      onClick={() => handleVerdict(pair, "reject")}
                      disabled={isActing}
                      className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 transition-all disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
