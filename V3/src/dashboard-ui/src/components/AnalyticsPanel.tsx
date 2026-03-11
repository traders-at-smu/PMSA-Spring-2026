import { useState } from "react";
import { TopTraders } from "./TopTraders";
import { TradeAlerts } from "./TradeAlerts";
import { ArbitragePanel } from "./ArbitragePanel";
import { KalshiPanel } from "./KalshiPanel";
import { NewMarketsPanel } from "./NewMarketsPanel";

type SubTab = "traders" | "alerts" | "polymarket" | "kalshi" | "new-markets";

const subTabs: { id: SubTab; label: string; desc: string }[] = [
  { id: "traders", label: "Top Traders", desc: "Leaderboard" },
  { id: "alerts", label: "Smart Money", desc: "Large trade alerts" },
  { id: "polymarket", label: "Polymarket", desc: "Single-venue screener" },
  { id: "kalshi", label: "Kalshi", desc: "Single-venue screener" },
  { id: "new-markets", label: "New Markets", desc: "Recently listed" },
];

export function AnalyticsPanel({ paused }: { paused: boolean }) {
  const [sub, setSub] = useState<SubTab>("traders");

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-lg font-serif text-zinc-100 tracking-tight">
          Market Analytics
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Trader intelligence, alerts, and single-venue screeners
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="glass-card rounded-xl p-1.5 inline-flex gap-1">
        {subTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
              sub === t.id
                ? "bg-[#CC0035]/15 text-[#ff3d6a] shadow-inner shadow-[#CC0035]/5"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {sub === "traders" && <TopTraders />}
      {sub === "alerts" && <TradeAlerts paused={paused} />}
      {sub === "polymarket" && <ArbitragePanel paused={paused} />}
      {sub === "kalshi" && <KalshiPanel paused={paused} />}
      {sub === "new-markets" && <NewMarketsPanel paused={paused} />}
    </div>
  );
}
