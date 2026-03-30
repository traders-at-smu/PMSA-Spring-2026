import { usePolling } from "../hooks/usePolling";

interface OpenPosition {
  id: string;
  openedAt: string;
  endDate: string;
  event: string;
  category: string;
  polymarketSlug: string;
  kalshiTicker: string;
  buyYesVenue: "POLYMARKET" | "KALSHI";
  buyYesPrice: number;
  buyNoVenue: "POLYMARKET" | "KALSHI";
  buyNoPrice: number;
  contracts: number;
  costUsd: number;
  feesUsd: number;
  expectedProfitUsd: number;
  daysToExpiry: number;
}

interface PaperAccountState {
  startingBalance: number;
  availableBalance: number;
  lockedCapital: number;
  portfolioValue: number;
  unrealizedProfit: number;
  realizedProfit: number;
  totalFees: number;
  openPositionCount: number;
  resolvedTradeCount: number;
  winRate: number;
  annualizedRoi: number;
  avgHoldDays: number;
  openPositions: OpenPosition[];
}

interface Props {
  paused: boolean;
}

function fmt(v: number, decimals = 2) {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtDays(endDate: string): string {
  const ms = Date.parse(endDate) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  const days = ms / 86_400_000;
  if (days < 0) return "expired";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function estimatedArr(pos: OpenPosition): number {
  const endMs = Date.parse(pos.endDate);
  if (!Number.isFinite(endMs)) return 0;
  const holdDays = Math.max(0.5, (endMs - Date.parse(pos.openedAt)) / 86_400_000);
  const roi = pos.costUsd > 0 ? pos.expectedProfitUsd / pos.costUsd : 0;
  return Math.pow(1 + roi, 365 / holdDays) - 1;
}

export function HoldingsPanel({ paused }: Props) {
  const { data, loading, lastUpdated } = usePolling<PaperAccountState>(
    "/api/paper-account/state",
    15_000,
    paused
  );

  const positions = data?.openPositions ?? [];

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Available Balance", value: data ? `$${fmt(data.availableBalance)}` : "—" },
          { label: "Locked Capital", value: data ? `$${fmt(data.lockedCapital)}` : "—" },
          { label: "Unrealized Profit", value: data ? `$${fmt(data.unrealizedProfit)}` : "—" },
          { label: "Ann. ROI", value: data ? `${fmt(data.annualizedRoi * 100, 1)}%` : "—" },
        ].map((m) => (
          <div key={m.label} className="glass-card rounded-xl px-4 py-3">
            <div className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold mb-1">
              {m.label}
            </div>
            <div className="text-[20px] font-mono font-semibold text-zinc-100 tabular-nums">
              {m.value}
            </div>
          </div>
        ))}
      </div>

      {/* Positions table */}
      <div className="glass-card rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <h2 className="text-[13px] font-semibold text-zinc-200">
            Open Positions
            {positions.length > 0 && (
              <span className="ml-2 text-[11px] text-zinc-500">({positions.length})</span>
            )}
          </h2>
          {lastUpdated && (
            <span className="text-[10px] text-zinc-600">
              updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>

        {loading && positions.length === 0 ? (
          <div className="px-4 py-12 text-center text-zinc-500 text-sm">Loading positions…</div>
        ) : positions.length === 0 ? (
          <div className="px-4 py-12 text-center text-zinc-500 text-sm">No open positions</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {["Event", "Venue", "Contracts", "Cost", "Exp. Profit", "Est. ARR", "Expires"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold"
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const arr = estimatedArr(p);
                return (
                  <tr
                    key={p.id}
                    className="data-row border-b border-white/[0.03] last:border-0"
                  >
                    <td className="px-4 py-3 max-w-xs">
                      <div className="text-[13px] text-zinc-200 font-medium leading-snug line-clamp-2">
                        {p.event}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">{p.category}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[11px] font-mono">
                        <span className="text-violet-400">YES@{p.buyYesVenue.slice(0, 4)}</span>
                        <span className="text-zinc-600 mx-1">·</span>
                        <span className="text-cyan-400">NO@{p.buyNoVenue.slice(0, 4)}</span>
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        {(p.buyYesPrice * 100).toFixed(1)}¢ + {(p.buyNoPrice * 100).toFixed(1)}¢
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[13px] text-zinc-200">
                      {p.contracts}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[13px] text-zinc-200">
                      ${fmt(p.costUsd)}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[13px] text-emerald-400">
                      ${fmt(p.expectedProfitUsd)}
                    </td>
                    <td
                      className={`px-4 py-3 font-mono tabular-nums text-[13px] ${
                        arr >= 0.5
                          ? "text-emerald-400"
                          : arr >= 0.2
                          ? "text-amber-400"
                          : "text-zinc-400"
                      }`}
                    >
                      {fmt(arr * 100, 1)}%
                    </td>
                    <td className="px-4 py-3 text-[12px] text-zinc-400 font-mono">
                      {fmtDays(p.endDate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
