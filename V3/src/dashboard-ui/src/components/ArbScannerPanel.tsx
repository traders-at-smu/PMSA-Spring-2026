import { useState, useMemo, useCallback, useEffect, useRef } from "react";

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

interface OrderBookLevel {
  price: number; // 0-1 range (e.g. 0.42 = 42 cents)
  size: number;
}

interface ArbFill {
  contracts: number;
  kalshiPrice: number;
  polyPrice: number;
  combinedPrice: number;
  costKalshi: number;
  costPoly: number;
  totalCost: number;
  payout: number;
  profit: number;
}

interface WalkRow {
  n: number;
  kalshiPrice: number;
  polyPrice: number;
  levelQty: number;
  levelCost: number;
  avgCost: number;
  marginalEdge: number;
  cumProfit: number;
}

interface ArbResult {
  hasArb: boolean;
  kalshiSide: "yes" | "no";
  polySide: "yes" | "no";
  fills: ArbFill[];
  totalContracts: number;
  totalCostKalshi: number;
  totalCostPoly: number;
  totalCost: number;
  totalPayout: number;
  totalProfit: number;
  profitPct: number;
  totalFees: number;
  kalshiDepth: number;
  polyDepth: number;
  thinSide: string | null;
  bestKalshiAsk: number;
  bestPolyAsk: number;
  bestKalshiFee: number;
  bestPolyFee: number;
  bestTotalCost: number;
  bestEdge: number;
  avgCostPerContract: number;
  marginalEdge: number;
  breakLevel: number;
  walkRows: WalkRow[];
}

// ──────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────

const KALSHI_FEE_RATE = 0.07;
const POLY_FEE = 0.0002;
const THIN_DEPTH_USD = 500;

// ──────────────────────────────────────────────────────────────────
// Arb Engine — pure math, no Node.js dependencies
// ──────────────────────────────────────────────────────────────────

function flatten(levels: OrderBookLevel[]): number[] {
  const stream: number[] = [];
  for (const { price, size } of levels) {
    for (let i = 0; i < Math.floor(size); i++) {
      stream.push(price);
    }
  }
  return stream;
}

function kalshiFeePerContract(price: number): number {
  const raw = KALSHI_FEE_RATE * price * (1 - price);
  return Math.ceil(raw * 100) / 100;
}

function contractCost(
  kp: number,
  pp: number
): { cost: number; kFee: number; pFee: number } {
  const kFee = kalshiFeePerContract(kp);
  const pFee = POLY_FEE * pp;
  return { cost: kp + pp + kFee + pFee, kFee, pFee };
}

function bookDepthUSD(levels: OrderBookLevel[]): number {
  return levels.reduce((sum, l) => sum + l.price * l.size, 0);
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyResult(
  kalshiSide: "yes" | "no",
  polySide: "yes" | "no",
  kalshiAsks: OrderBookLevel[] = [],
  polyAsks: OrderBookLevel[] = []
): ArbResult {
  const kalshiDepth = bookDepthUSD(kalshiAsks);
  const polyDepth = bookDepthUSD(polyAsks);
  const kThin = kalshiDepth < THIN_DEPTH_USD;
  const pThin = polyDepth < THIN_DEPTH_USD;
  const thinSide =
    kThin && pThin ? "Both" : kThin ? "Kalshi" : pThin ? "Poly" : null;

  const ys = flatten(kalshiAsks);
  const ns = flatten(polyAsks);
  const bestKalshiAsk = ys.length > 0 ? ys[0] : 0;
  const bestPolyAsk = ns.length > 0 ? ns[0] : 0;
  const bestKalshiFee =
    bestKalshiAsk > 0 ? kalshiFeePerContract(bestKalshiAsk) : 0;
  const bestPolyFee = POLY_FEE * bestPolyAsk;
  const bestTotalCost =
    bestKalshiAsk + bestPolyAsk + bestKalshiFee + bestPolyFee;
  const bestEdge = 1.0 - bestTotalCost;

  return {
    hasArb: false,
    kalshiSide,
    polySide,
    fills: [],
    walkRows: [],
    totalContracts: 0,
    totalCostKalshi: 0,
    totalCostPoly: 0,
    totalCost: 0,
    totalPayout: 0,
    totalProfit: 0,
    profitPct: 0,
    totalFees: 0,
    kalshiDepth,
    polyDepth,
    thinSide,
    bestKalshiAsk,
    bestPolyAsk,
    bestKalshiFee,
    bestPolyFee,
    bestTotalCost,
    bestEdge,
    avgCostPerContract: 0,
    marginalEdge: 0,
    breakLevel: 0,
  };
}

function calculateArbitrage(
  kalshiAsks: OrderBookLevel[],
  polyAsks: OrderBookLevel[],
  kalshiSide: "yes" | "no",
  polySide: "yes" | "no"
): ArbResult {
  const ys = flatten(kalshiAsks);
  const ns = flatten(polyAsks);
  const cap = Math.min(ys.length, ns.length);

  if (cap === 0) {
    return emptyResult(kalshiSide, polySide, kalshiAsks, polyAsks);
  }

  const fills: ArbFill[] = [];
  const walkRows: WalkRow[] = [];
  let totalContracts = 0;
  let totalCostKalshi = 0;
  let totalCostPoly = 0;
  let totalFees = 0;
  let cumTotalCost = 0;
  let breakLevel = 0;

  let currentKPrice = -1;
  let currentPPrice = -1;
  let currentFill: ArbFill | null = null;
  let lastEdge = 0;

  for (let i = 0; i < cap; i++) {
    const kp = ys[i];
    const pp = ns[i];
    const { cost, kFee, pFee } = contractCost(kp, pp);
    const edge = 1.0 - cost;

    if (edge <= 0 && breakLevel === 0) {
      breakLevel = i + 1;
    }

    if (edge <= 0) break;

    const fee = kFee + pFee;

    if (kp === currentKPrice && pp === currentPPrice && currentFill) {
      currentFill.contracts += 1;
      currentFill.costKalshi += kp;
      currentFill.costPoly += pp;
      currentFill.totalCost += cost;
      currentFill.payout += 1.0;
      currentFill.profit += edge;
    } else {
      currentFill = {
        contracts: 1,
        kalshiPrice: kp,
        polyPrice: pp,
        combinedPrice: kp + pp,
        costKalshi: kp,
        costPoly: pp,
        totalCost: cost,
        payout: 1.0,
        profit: edge,
      };
      fills.push(currentFill);
      currentKPrice = kp;
      currentPPrice = pp;
    }

    totalContracts += 1;
    totalCostKalshi += kp;
    totalCostPoly += pp;
    totalFees += fee;
    cumTotalCost += cost;
    lastEdge = edge;
  }

  let cumN = 0;
  let cumCost = 0;
  let cumProfit = 0;
  for (const f of fills) {
    cumN += f.contracts;
    cumCost += f.totalCost;
    cumProfit += f.profit;
    const { cost: levelCost } = contractCost(f.kalshiPrice, f.polyPrice);
    walkRows.push({
      n: cumN,
      kalshiPrice: f.kalshiPrice,
      polyPrice: f.polyPrice,
      levelQty: f.contracts,
      levelCost,
      avgCost: cumCost / cumN,
      marginalEdge: 1.0 - levelCost,
      cumProfit,
    });
  }

  const totalCost = totalCostKalshi + totalCostPoly + totalFees;
  const totalPayout = totalContracts * 1.0;
  const totalProfit = totalPayout - totalCost;

  const kalshiDepth = bookDepthUSD(kalshiAsks);
  const polyDepth = bookDepthUSD(polyAsks);
  const kThin = kalshiDepth < THIN_DEPTH_USD;
  const pThin = polyDepth < THIN_DEPTH_USD;
  const thinSide =
    kThin && pThin ? "Both" : kThin ? "Kalshi" : pThin ? "Poly" : null;

  const bestKalshiAsk = ys.length > 0 ? ys[0] : 0;
  const bestPolyAsk = ns.length > 0 ? ns[0] : 0;
  const bestKalshiFee =
    bestKalshiAsk > 0 ? kalshiFeePerContract(bestKalshiAsk) : 0;
  const bestPolyFee = POLY_FEE * bestPolyAsk;
  const bestTotalCost =
    bestKalshiAsk + bestPolyAsk + bestKalshiFee + bestPolyFee;
  const bestEdge = 1.0 - bestTotalCost;

  return {
    hasArb: fills.length > 0,
    kalshiSide,
    polySide,
    fills,
    walkRows,
    totalContracts,
    totalCostKalshi,
    totalCostPoly,
    totalCost,
    totalPayout,
    totalProfit,
    profitPct: totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
    totalFees,
    kalshiDepth,
    polyDepth,
    thinSide,
    bestKalshiAsk,
    bestPolyAsk,
    bestKalshiFee,
    bestPolyFee,
    bestTotalCost,
    bestEdge,
    avgCostPerContract: totalContracts > 0 ? totalCost / totalContracts : 0,
    marginalEdge: lastEdge,
    breakLevel,
  };
}

function kalshiBidsToAsks(bids: OrderBookLevel[]): OrderBookLevel[] {
  return bids
    .map((b) => ({ price: roundCents(1 - b.price), size: b.size }))
    .sort((a, b) => a.price - b.price);
}

function findBothArbitrages(
  kalshiYesBids: OrderBookLevel[],
  kalshiNoBids: OrderBookLevel[],
  polyYesAsks: OrderBookLevel[],
  polyNoAsks: OrderBookLevel[]
): { arbA: ArbResult; arbB: ArbResult } {
  const kalshiYesAsks = kalshiBidsToAsks(kalshiNoBids);
  const kalshiNoAsks = kalshiBidsToAsks(kalshiYesBids);

  const arbA = calculateArbitrage(kalshiYesAsks, polyNoAsks, "yes", "no");
  const arbB = calculateArbitrage(kalshiNoAsks, polyYesAsks, "no", "yes");

  return { arbA, arbB };
}

function calculatePartialFill(
  fullResult: ArbResult,
  targetContracts: number
): ArbResult {
  if (targetContracts >= fullResult.totalContracts || targetContracts <= 0) {
    return fullResult;
  }

  let remaining = targetContracts;
  const partialFills: ArbFill[] = [];
  let totalCostKalshi = 0;
  let totalCostPoly = 0;
  let totalFees = 0;

  for (const fill of fullResult.fills) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, fill.contracts);
    const ratio = take / fill.contracts;

    const pf: ArbFill = {
      contracts: take,
      kalshiPrice: fill.kalshiPrice,
      polyPrice: fill.polyPrice,
      combinedPrice: fill.combinedPrice,
      costKalshi: fill.costKalshi * ratio,
      costPoly: fill.costPoly * ratio,
      totalCost: fill.totalCost * ratio,
      payout: fill.payout * ratio,
      profit: fill.profit * ratio,
    };
    partialFills.push(pf);

    const { kFee, pFee } = contractCost(fill.kalshiPrice, fill.polyPrice);
    totalCostKalshi += fill.kalshiPrice * take;
    totalCostPoly += fill.polyPrice * take;
    totalFees += (kFee + pFee) * take;
    remaining -= take;
  }

  const totalCost = totalCostKalshi + totalCostPoly + totalFees;
  const totalPayout = targetContracts * 1.0;
  const totalProfit = totalPayout - totalCost;

  // Rebuild walk rows for partial
  const walkRows: WalkRow[] = [];
  let cumN = 0;
  let cumCost = 0;
  let cumProfit = 0;
  for (const f of partialFills) {
    cumN += f.contracts;
    cumCost += f.totalCost;
    cumProfit += f.profit;
    const { cost: levelCost } = contractCost(f.kalshiPrice, f.polyPrice);
    walkRows.push({
      n: cumN,
      kalshiPrice: f.kalshiPrice,
      polyPrice: f.polyPrice,
      levelQty: f.contracts,
      levelCost,
      avgCost: cumCost / cumN,
      marginalEdge: 1.0 - levelCost,
      cumProfit,
    });
  }

  const lastFill = partialFills[partialFills.length - 1];
  const lastLevelCost = lastFill
    ? contractCost(lastFill.kalshiPrice, lastFill.polyPrice).cost
    : 0;

  return {
    ...fullResult,
    fills: partialFills,
    walkRows,
    totalContracts: targetContracts,
    totalCostKalshi,
    totalCostPoly,
    totalCost,
    totalPayout,
    totalProfit,
    profitPct: totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
    totalFees,
    avgCostPerContract: targetContracts > 0 ? totalCost / targetContracts : 0,
    marginalEdge: lastFill ? 1.0 - lastLevelCost : 0,
  };
}

// ──────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtCents(n: number): string {
  return (n * 100).toFixed(1) + "\u00A2";
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

// ──────────────────────────────────────────────────────────────────
// Inline SVG icons (no external library)
// ──────────────────────────────────────────────────────────────────

function ChevronDown({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`border-2 border-current border-t-transparent rounded-full animate-spin ${className}`}
    />
  );
}

function CheckIcon() {
  return (
    <svg
      className="w-4 h-4 text-emerald-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      className="w-3 h-3"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function MetricBox({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "emerald" | "red" | "amber" | "zinc";
}) {
  const colors: Record<string, string> = {
    emerald: "text-emerald-400",
    red: "text-red-400",
    amber: "text-amber-400",
    zinc: "text-zinc-300",
  };
  return (
    <div className="bg-white/[0.02] rounded-lg p-3 border border-white/[0.04] text-center flex-1 min-w-0">
      <div className="text-[9px] text-zinc-600 uppercase tracking-[0.12em] font-semibold">
        {label}
      </div>
      <div
        className={`font-mono text-base mt-0.5 tabular-nums font-semibold ${
          colors[accent ?? "zinc"]
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-zinc-600 mt-0.5 font-mono tabular-nums">
          {sub}
        </div>
      )}
    </div>
  );
}

function ArbCard({
  label,
  result,
  fullResult,
  showWalk,
  onToggleWalk,
}: {
  label: string;
  result: ArbResult;
  fullResult: ArbResult;
  showWalk: boolean;
  onToggleWalk: () => void;
}) {
  const dirLabel = `Buy ${result.kalshiSide.toUpperCase()} Kalshi + Buy ${result.polySide.toUpperCase()} Poly`;

  if (!result.hasArb) {
    return (
      <div className="glass-card rounded-xl overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-white/[0.04]">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                {label}
              </span>
              <div className="text-[13px] text-zinc-300 font-medium mt-0.5">
                {dirLabel}
              </div>
            </div>
            <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
              NO ARB
            </span>
          </div>
        </div>

        {/* Best-ask breakdown when we have data */}
        {result.bestTotalCost > 0 && (
          <div className="p-4">
            <div className="text-[10px] text-zinc-600 uppercase tracking-[0.1em] font-semibold mb-3">
              Best Ask Breakdown
            </div>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <div className="bg-white/[0.02] rounded-lg p-2.5 border border-white/[0.04]">
                <div className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                  K Ask
                </div>
                <div className="font-mono tabular-nums text-zinc-300 mt-0.5">
                  {fmtCents(result.bestKalshiAsk)}
                </div>
              </div>
              <div className="bg-white/[0.02] rounded-lg p-2.5 border border-white/[0.04]">
                <div className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                  P Ask
                </div>
                <div className="font-mono tabular-nums text-zinc-300 mt-0.5">
                  {fmtCents(result.bestPolyAsk)}
                </div>
              </div>
              <div className="bg-white/[0.02] rounded-lg p-2.5 border border-white/[0.04]">
                <div className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                  K Fee
                </div>
                <div className="font-mono tabular-nums text-zinc-400 mt-0.5">
                  {fmtCents(result.bestKalshiFee)}
                </div>
              </div>
              <div className="bg-white/[0.02] rounded-lg p-2.5 border border-white/[0.04]">
                <div className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                  P Fee
                </div>
                <div className="font-mono tabular-nums text-zinc-400 mt-0.5">
                  {fmtCents(result.bestPolyFee)}
                </div>
              </div>
              <div className="bg-white/[0.02] rounded-lg p-2.5 border border-white/[0.04]">
                <div className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                  Total Cost
                </div>
                <div className="font-mono tabular-nums text-zinc-300 mt-0.5">
                  {fmtCents(result.bestTotalCost)}
                </div>
              </div>
              <div className="bg-white/[0.02] rounded-lg p-2.5 border border-white/[0.04]">
                <div className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                  Edge
                </div>
                <div
                  className={`font-mono tabular-nums mt-0.5 font-semibold ${
                    result.bestEdge > 0 ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {result.bestEdge > 0 ? "+" : ""}
                  {fmtCents(result.bestEdge)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 mt-3 text-[11px] text-zinc-600">
              <span>Payout</span>
              <span className="font-mono tabular-nums text-zinc-400">
                $1.00
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Has arb ----
  const costPct =
    result.totalPayout > 0
      ? (result.totalCost / result.totalPayout) * 100
      : 100;
  const profitPct = 100 - costPct;

  // Kalshi leg averages
  const kalshiAvgPrice =
    result.totalContracts > 0
      ? result.totalCostKalshi / result.totalContracts
      : 0;
  const kalshiFees =
    result.totalFees > 0
      ? result.fills.reduce((s, f) => {
          const { kFee } = contractCost(f.kalshiPrice, f.polyPrice);
          return s + kFee * f.contracts;
        }, 0)
      : 0;
  const polyAvgPrice =
    result.totalContracts > 0
      ? result.totalCostPoly / result.totalContracts
      : 0;
  const polyFees = result.totalFees - kalshiFees;

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-white/[0.04]">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[10px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
              {label}
            </span>
            <div className="text-[13px] text-zinc-300 font-medium mt-0.5">
              {dirLabel}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {result.thinSide && (
              <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20">
                THIN: {result.thinSide}
              </span>
            )}
            <span className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              ARB
            </span>
          </div>
        </div>
      </div>

      {/* 4 metric boxes */}
      <div className="p-4 flex gap-2">
        <MetricBox
          label="N max"
          value={String(fullResult.totalContracts)}
          sub={
            result.totalContracts !== fullResult.totalContracts
              ? `Using ${result.totalContracts}`
              : undefined
          }
          accent="zinc"
        />
        <MetricBox
          label="Avg Cost"
          value={`$${fmt(result.avgCostPerContract, 4)}`}
          sub="/contract"
          accent="zinc"
        />
        <MetricBox
          label={`Edge @ N${result.totalContracts !== fullResult.totalContracts ? "" : " max"}`}
          value={fmtCents(result.marginalEdge)}
          accent={result.marginalEdge > 0.02 ? "emerald" : "amber"}
        />
        <MetricBox
          label="Break Level"
          value={fullResult.breakLevel > 0 ? `#${fullResult.breakLevel}` : "--"}
          accent={fullResult.breakLevel > 0 ? "red" : "zinc"}
        />
      </div>

      {/* Cost vs Payout */}
      <div className="px-4 pb-4">
        <div className="glass-card rounded-lg p-4">
          <div className="grid grid-cols-2 gap-4">
            {/* Left — You Spend */}
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-[0.1em] font-semibold mb-2">
                You Spend
              </div>
              <div className="space-y-1.5 text-[12px]">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Kalshi leg</span>
                  <span className="font-mono tabular-nums text-zinc-300">
                    {fmtUsd(result.totalCostKalshi)}
                    <span className="text-zinc-600 ml-1">
                      ({fmtCents(kalshiAvgPrice)} avg)
                    </span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-600 text-[11px] pl-2">
                    + fees
                  </span>
                  <span className="font-mono tabular-nums text-zinc-500 text-[11px]">
                    {fmtUsd(kalshiFees)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Poly leg</span>
                  <span className="font-mono tabular-nums text-zinc-300">
                    {fmtUsd(result.totalCostPoly)}
                    <span className="text-zinc-600 ml-1">
                      ({fmtCents(polyAvgPrice)} avg)
                    </span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-600 text-[11px] pl-2">
                    + fees
                  </span>
                  <span className="font-mono tabular-nums text-zinc-500 text-[11px]">
                    {fmtUsd(polyFees)}
                  </span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-white/[0.04]">
                  <span className="text-red-400 font-medium">Total</span>
                  <span className="font-mono tabular-nums text-red-400 font-semibold">
                    {fmtUsd(result.totalCost)}
                  </span>
                </div>
              </div>
            </div>

            {/* Right — You Get Back */}
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-[0.1em] font-semibold mb-2">
                You Get Back
              </div>
              <div className="space-y-1.5 text-[12px]">
                <div className="flex justify-between">
                  <span className="text-zinc-500">
                    $1.00/contract x {result.totalContracts}
                  </span>
                  <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                    {fmtUsd(result.totalPayout)}
                  </span>
                </div>
              </div>
              <div className="flex justify-between pt-3 mt-3 border-t border-white/[0.04] text-[13px]">
                <span className="text-emerald-400 font-medium">Profit</span>
                <span className="font-mono tabular-nums text-emerald-400 font-bold">
                  +{fmtUsd(result.totalProfit)}{" "}
                  <span className="text-emerald-400/60 text-[11px] font-normal">
                    ({fmtPct(result.profitPct)})
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* Stacked bar */}
          <div className="mt-3 h-2 rounded-full overflow-hidden bg-white/[0.04] flex">
            <div
              className="bg-red-400/60 h-full transition-all duration-300"
              style={{ width: `${Math.min(costPct, 100)}%` }}
            />
            <div
              className="bg-emerald-400/60 h-full transition-all duration-300"
              style={{ width: `${Math.max(profitPct, 0)}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-zinc-600">
            <span>Cost {fmt(costPct, 1)}%</span>
            <span>Profit {fmt(Math.max(profitPct, 0), 1)}%</span>
          </div>
        </div>
      </div>

      {/* Depth info */}
      <div className="px-4 pb-3 flex gap-4 text-[11px] text-zinc-500">
        <span>
          Kalshi depth:{" "}
          <span
            className={`font-mono tabular-nums ${
              result.kalshiDepth < THIN_DEPTH_USD
                ? "text-amber-400"
                : "text-zinc-400"
            }`}
          >
            {fmtUsd(result.kalshiDepth)}
          </span>
        </span>
        <span>
          Poly depth:{" "}
          <span
            className={`font-mono tabular-nums ${
              result.polyDepth < THIN_DEPTH_USD
                ? "text-amber-400"
                : "text-zinc-400"
            }`}
          >
            {fmtUsd(result.polyDepth)}
          </span>
        </span>
      </div>

      {/* Walk toggle */}
      <div className="border-t border-white/[0.04]">
        <button
          onClick={onToggleWalk}
          className="w-full px-4 py-2.5 flex items-center justify-between text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02] transition-colors"
        >
          <span>
            {showWalk
              ? "Hide walk analysis"
              : `Show walk analysis (${result.walkRows.length} levels)`}
          </span>
          <ChevronDown
            className={`w-4 h-4 transition-transform duration-200 ${
              showWalk ? "rotate-180" : ""
            }`}
          />
        </button>

        {showWalk && (
          <div className="px-4 pb-4 overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="pb-2 text-left text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    Cum N
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    Lvl Qty
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    K Price
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    P Price
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    Lvl Cost
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    Avg Cost
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    Marg Edge
                  </th>
                  <th className="pb-2 text-right text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
                    Cum $
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.walkRows.map((row, i) => {
                  const edgeColor =
                    row.marginalEdge > 0.02
                      ? "text-emerald-400"
                      : row.marginalEdge >= 0.005
                        ? "text-amber-400"
                        : "text-red-400";
                  return (
                    <tr
                      key={i}
                      className="border-b border-white/[0.03] last:border-0"
                    >
                      <td className="py-1.5 font-mono tabular-nums text-zinc-300">
                        {row.n}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-zinc-400">
                        {row.levelQty}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-zinc-300">
                        {fmtCents(row.kalshiPrice)}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-zinc-300">
                        {fmtCents(row.polyPrice)}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-zinc-400">
                        {fmtCents(row.levelCost)}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-zinc-400">
                        {fmtCents(row.avgCost)}
                      </td>
                      <td
                        className={`py-1.5 text-right font-mono tabular-nums font-medium ${edgeColor}`}
                      >
                        {fmtCents(row.marginalEdge)}
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-emerald-400">
                        {fmtUsd(row.cumProfit)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RawBookTable({
  title,
  levels,
  type,
}: {
  title: string;
  levels: OrderBookLevel[];
  type: "bids" | "asks";
}) {
  const sorted =
    type === "bids"
      ? [...levels].sort((a, b) => b.price - a.price)
      : [...levels].sort((a, b) => a.price - b.price);
  const display = sorted.slice(0, 15);

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/[0.04]">
        <span className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
          {title}
        </span>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th className="px-3 py-1.5 text-left text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
              Price
            </th>
            <th className="px-3 py-1.5 text-right text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
              Size
            </th>
            <th className="px-3 py-1.5 text-right text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
              $ Total
            </th>
          </tr>
        </thead>
        <tbody>
          {display.length === 0 ? (
            <tr>
              <td
                colSpan={3}
                className="px-3 py-4 text-center text-zinc-600 text-[11px]"
              >
                No data
              </td>
            </tr>
          ) : (
            display.map((l, i) => (
              <tr key={i} className="border-b border-white/[0.02] last:border-0">
                <td
                  className={`px-3 py-1 font-mono tabular-nums ${
                    type === "bids" ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {fmtCents(l.price)}
                </td>
                <td className="px-3 py-1 text-right font-mono tabular-nums text-zinc-400">
                  {l.size}
                </td>
                <td className="px-3 py-1 text-right font-mono tabular-nums text-zinc-500">
                  {fmtUsd(l.price * l.size)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────

export function ArbScannerPanel() {
  // ---- Market lookup state ----
  const [kalshiInput, setKalshiInput] = useState("");
  const [kalshiTicker, setKalshiTicker] = useState("");
  const [kalshiTitle, setKalshiTitle] = useState("");
  const [kalshiMarkets, setKalshiMarkets] = useState<any[]>([]);
  const [kalshiLooking, setKalshiLooking] = useState(false);

  const [polyInput, setPolyInput] = useState("");
  const [polyYesTokenId, setPolyYesTokenId] = useState("");
  const [polyNoTokenId, setPolyNoTokenId] = useState("");
  const [polyQuestion, setPolyQuestion] = useState("");
  const [polyMarkets, setPolyMarkets] = useState<any[]>([]);
  const [polyLooking, setPolyLooking] = useState(false);

  // ---- Search state ----
  const [kalshiSearchResults, setKalshiSearchResults] = useState<any[]>([]);
  const [kalshiSearching, setKalshiSearching] = useState(false);
  const [polySearchResults, setPolySearchResults] = useState<any[]>([]);
  const [polySearching, setPolySearching] = useState(false);

  // ---- Order books ----
  const [kalshiYesBids, setKalshiYesBids] = useState<OrderBookLevel[]>([]);
  const [kalshiNoBids, setKalshiNoBids] = useState<OrderBookLevel[]>([]);
  const [polyYesBook, setPolyYesBook] = useState<{
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  }>({ bids: [], asks: [] });
  const [polyNoBook, setPolyNoBook] = useState<{
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  }>({ bids: [], asks: [] });

  // ---- Results ----
  const [arbA, setArbA] = useState<ArbResult | null>(null);
  const [arbB, setArbB] = useState<ArbResult | null>(null);
  const [showWalkA, setShowWalkA] = useState(false);
  const [showWalkB, setShowWalkB] = useState(false);

  // ---- Sizing ----
  const [fillPct, setFillPct] = useState(100);
  const [customSize, setCustomSize] = useState<number | null>(null);

  // ---- Loading/error ----
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  // ---- Raw books toggle ----
  const [showRawBooks, setShowRawBooks] = useState(false);

  // ---- Import queue (verified matches from AI panel) ----
  interface ImportedPair {
    kalshi_ticker: string;
    kalshi_title: string;
    poly_slug: string;
    poly_title: string;
    ai_confidence: number;
    text_score: number;
  }
  const [importQueue, setImportQueue] = useState<ImportedPair[]>([]);
  const [importIdx, setImportIdx] = useState(0);
  const [importing, setImporting] = useState(false);

  // ---- Derived sized results ----
  const sizedArbA = useMemo(() => {
    if (!arbA || !arbA.hasArb) return arbA;
    const target =
      customSize ??
      Math.max(1, Math.floor(arbA.totalContracts * fillPct / 100));
    return calculatePartialFill(arbA, target);
  }, [arbA, fillPct, customSize]);

  const sizedArbB = useMemo(() => {
    if (!arbB || !arbB.hasArb) return arbB;
    const target =
      customSize ??
      Math.max(1, Math.floor(arbB.totalContracts * fillPct / 100));
    return calculatePartialFill(arbB, target);
  }, [arbB, fillPct, customSize]);

  const hasAnyArb = arbA?.hasArb || arbB?.hasArb;
  const hasResults = arbA !== null || arbB !== null;

  // ---- Import verified matches ----

  const handleImportVerified = useCallback(async () => {
    setImporting(true);
    setError("");
    try {
      const res = await fetch("/api/ai-matching/results?verdict=verified&limit=500");
      if (!res.ok) throw new Error("Failed to fetch verified matches");
      const data = await res.json();
      const pairs: ImportedPair[] = (data.results || []).map((r: any) => ({
        kalshi_ticker: r.kalshi_ticker,
        kalshi_title: r.kalshi_title,
        poly_slug: r.poly_slug,
        poly_title: r.poly_title,
        ai_confidence: r.ai_confidence,
        text_score: r.text_score,
      }));
      if (pairs.length === 0) {
        setError("No verified matches found. Run a scan first.");
        return;
      }
      setImportQueue(pairs);
      setImportIdx(0);
      // Auto-load the first pair
      loadImportedPair(pairs[0]);
    } catch (e: any) {
      setError(e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  }, []);

  const loadImportedPair = useCallback((pair: ImportedPair) => {
    // Reset current state
    setArbA(null);
    setArbB(null);
    setKalshiMarkets([]);
    setKalshiSearchResults([]);
    setPolyMarkets([]);
    setPolySearchResults([]);

    // Load Kalshi side — set the ticker input and trigger lookup
    setKalshiInput(pair.kalshi_ticker);
    setKalshiTicker("");
    setKalshiTitle("");
    setTimeout(async () => {
      setKalshiLooking(true);
      try {
        const res = await fetch(`/api/arb-scanner/kalshi/lookup?ticker=${encodeURIComponent(pair.kalshi_ticker)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.type === "event" && data.markets?.length > 1) {
            setKalshiMarkets(data.markets);
          } else if (data.markets?.length >= 1) {
            const m = data.markets[0];
            setKalshiTicker(m.ticker);
            setKalshiTitle(m.title || m.subtitle || m.ticker);
          }
        }
      } catch { /* silent */ }
      setKalshiLooking(false);
    }, 50);

    // Load Poly side — set the slug and trigger lookup
    setPolyInput(pair.poly_slug);
    setPolyYesTokenId("");
    setPolyNoTokenId("");
    setPolyQuestion("");
    setTimeout(async () => {
      setPolyLooking(true);
      try {
        const res = await fetch(`/api/arb-scanner/poly/lookup?slug=${encodeURIComponent(pair.poly_slug)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.type === "event" && data.markets?.length > 1) {
            setPolyMarkets(data.markets);
          } else if (data.markets?.length >= 1) {
            const m = data.markets[0];
            setPolyQuestion(m.question || data.title || pair.poly_slug);
            // Extract tokens
            if (m.tokens) {
              for (const t of m.tokens) {
                if (t.outcome?.toLowerCase() === "yes") setPolyYesTokenId(t.token_id);
                if (t.outcome?.toLowerCase() === "no") setPolyNoTokenId(t.token_id);
              }
            } else if (m.clobTokenIds) {
              const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
              if (ids[0]) setPolyYesTokenId(ids[0]);
              if (ids[1]) setPolyNoTokenId(ids[1]);
            }
          }
        }
      } catch { /* silent */ }
      setPolyLooking(false);
    }, 50);
  }, []);

  const handleImportPrev = useCallback(() => {
    if (importQueue.length === 0) return;
    const newIdx = Math.max(0, importIdx - 1);
    setImportIdx(newIdx);
    loadImportedPair(importQueue[newIdx]);
  }, [importQueue, importIdx, loadImportedPair]);

  const handleImportNext = useCallback(() => {
    if (importQueue.length === 0) return;
    const newIdx = Math.min(importQueue.length - 1, importIdx + 1);
    setImportIdx(newIdx);
    loadImportedPair(importQueue[newIdx]);
  }, [importQueue, importIdx, loadImportedPair]);

  // ---- Handlers ----

  const handleKalshiLookup = useCallback(async () => {
    if (!kalshiInput.trim()) return;
    setKalshiLooking(true);
    setError("");
    setKalshiMarkets([]);
    setKalshiTicker("");
    setKalshiTitle("");
    setKalshiSearchResults([]);

    try {
      const res = await fetch(
        `/api/arb-scanner/kalshi/lookup?ticker=${encodeURIComponent(kalshiInput.trim())}`
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `Kalshi lookup failed: ${res.status}`);
      }
      const data = await res.json();

      if (data.type === "event" && data.markets && data.markets.length > 1) {
        setKalshiMarkets(data.markets);
      } else if (data.markets && data.markets.length >= 1) {
        const m = data.markets[0];
        setKalshiTicker(m.ticker);
        setKalshiTitle(m.title || m.subtitle || m.ticker);
      } else {
        setError("No Kalshi markets found for that ticker.");
      }
    } catch (e: any) {
      setError(e.message || "Kalshi lookup failed");
    } finally {
      setKalshiLooking(false);
    }
  }, [kalshiInput]);

  const handlePolyLookup = useCallback(async () => {
    if (!polyInput.trim()) return;
    setPolyLooking(true);
    setError("");
    setPolyMarkets([]);
    setPolyYesTokenId("");
    setPolyNoTokenId("");
    setPolyQuestion("");
    setPolySearchResults([]);

    try {
      // Send the raw input — the server handles URL extraction
      const slug = polyInput.trim();

      const res = await fetch(
        `/api/arb-scanner/poly/lookup?slug=${encodeURIComponent(slug)}`
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `Poly lookup failed: ${res.status}`);
      }
      const data = await res.json();

      if (data.type === "event" && data.markets && data.markets.length > 1) {
        setPolyMarkets(data.markets);
      } else if (data.markets && data.markets.length >= 1) {
        const m = data.markets[0];
        setPolyQuestion(m.question || data.title || slug);
        extractPolyTokens(m);
      } else {
        setError("No Polymarket markets found for that slug.");
      }
    } catch (e: any) {
      setError(e.message || "Poly lookup failed");
    } finally {
      setPolyLooking(false);
    }
  }, [polyInput]);

  const extractPolyTokens = (market: any) => {
    if (market.tokens && market.tokens.length >= 2) {
      const yesToken = market.tokens.find(
        (t: any) => t.outcome === "Yes" || t.outcome === "yes"
      );
      const noToken = market.tokens.find(
        (t: any) => t.outcome === "No" || t.outcome === "no"
      );
      if (yesToken) setPolyYesTokenId(yesToken.token_id);
      if (noToken) setPolyNoTokenId(noToken.token_id);
    } else if (market.tokens && market.tokens.length === 1) {
      setPolyYesTokenId(market.tokens[0].token_id);
    }
  };

  const handleSelectKalshiMarket = useCallback((market: any) => {
    setKalshiTicker(market.ticker);
    setKalshiTitle(market.title || market.subtitle || market.ticker);
    setKalshiMarkets([]);
  }, []);

  const handleSelectPolyMarket = useCallback((market: any) => {
    setPolyQuestion(market.question || "");
    extractPolyTokens(market);
    setPolyMarkets([]);
  }, []);

  // ---- Inline search (debounced) ----
  const kalshiSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polySearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Debounce Kalshi search: triggers after 400ms of no input changes
    if (kalshiSearchTimer.current) clearTimeout(kalshiSearchTimer.current);
    const q = kalshiInput.trim();
    if (q.length < 2 || kalshiTicker) {
      setKalshiSearchResults([]);
      return;
    }
    kalshiSearchTimer.current = setTimeout(async () => {
      setKalshiSearching(true);
      try {
        const res = await fetch(`/api/arb-scanner/kalshi/search?q=${encodeURIComponent(q)}&limit=8`);
        if (res.ok) {
          const data = await res.json();
          setKalshiSearchResults(data.markets || []);
        }
      } catch { /* ignore */ }
      setKalshiSearching(false);
    }, 400);
    return () => { if (kalshiSearchTimer.current) clearTimeout(kalshiSearchTimer.current); };
  }, [kalshiInput, kalshiTicker]);

  useEffect(() => {
    // Debounce Poly search: triggers after 400ms of no input changes
    if (polySearchTimer.current) clearTimeout(polySearchTimer.current);
    const q = polyInput.trim();
    if (q.length < 2 || polyYesTokenId) {
      setPolySearchResults([]);
      return;
    }
    polySearchTimer.current = setTimeout(async () => {
      setPolySearching(true);
      try {
        const res = await fetch(`/api/arb-scanner/poly/search?q=${encodeURIComponent(q)}&limit=8`);
        if (res.ok) {
          const data = await res.json();
          setPolySearchResults(data.events || []);
        }
      } catch { /* ignore */ }
      setPolySearching(false);
    }, 400);
    return () => { if (polySearchTimer.current) clearTimeout(polySearchTimer.current); };
  }, [polyInput, polyYesTokenId]);

  const handleSelectKalshiSearchResult = useCallback((result: any) => {
    const eventTicker = result.event_ticker || result.ticker || "";
    setKalshiInput(eventTicker);
    setKalshiSearchResults([]);
    // Trigger a full lookup to properly resolve events with sub-markets
    setTimeout(async () => {
      setKalshiLooking(true);
      setError("");
      try {
        const res = await fetch(`/api/arb-scanner/kalshi/lookup?ticker=${encodeURIComponent(eventTicker)}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error || `Kalshi lookup failed: ${res.status}`);
        }
        const data = await res.json();
        if (data.type === "event" && data.markets && data.markets.length > 1) {
          setKalshiMarkets(data.markets);
        } else if (data.markets && data.markets.length >= 1) {
          const m = data.markets[0];
          setKalshiTicker(m.ticker);
          setKalshiTitle(m.title || m.subtitle || m.ticker);
        }
      } catch (e: any) {
        setError(e.message || "Kalshi lookup failed");
      } finally {
        setKalshiLooking(false);
      }
    }, 50);
  }, []);

  const handleSelectPolySearchResult = useCallback((result: any) => {
    setPolyInput(result.slug || "");
    setPolySearchResults([]);
    // Trigger lookup with the selected slug
    setTimeout(async () => {
      setPolyLooking(true);
      setError("");
      try {
        const res = await fetch(`/api/arb-scanner/poly/lookup?slug=${encodeURIComponent(result.slug)}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error || `Poly lookup failed: ${res.status}`);
        }
        const data = await res.json();
        if (data.type === "event" && data.markets && data.markets.length > 1) {
          setPolyMarkets(data.markets);
        } else if (data.markets && data.markets.length >= 1) {
          const m = data.markets[0];
          setPolyQuestion(m.question || data.title || result.slug);
          extractPolyTokens(m);
        }
      } catch (e: any) {
        setError(e.message || "Poly lookup failed");
      } finally {
        setPolyLooking(false);
      }
    }, 50);
  }, []);

  const handleScan = useCallback(async () => {
    if (!kalshiTicker || !polyYesTokenId) {
      setError("Select both a Kalshi market and Polymarket market first.");
      return;
    }
    setScanning(true);
    setError("");
    setArbA(null);
    setArbB(null);
    setShowWalkA(false);
    setShowWalkB(false);

    try {
      const [kalshiOBRes, polyYesRes, polyNoRes] = await Promise.all([
        fetch(
          `/api/arb-scanner/kalshi/orderbook?ticker=${encodeURIComponent(kalshiTicker)}`
        ),
        fetch(
          `/api/arb-scanner/poly/book?token_id=${encodeURIComponent(polyYesTokenId)}`
        ),
        polyNoTokenId
          ? fetch(
              `/api/arb-scanner/poly/book?token_id=${encodeURIComponent(polyNoTokenId)}`
            )
          : Promise.resolve(null),
      ]);

      if (!kalshiOBRes.ok) {
        const e = await kalshiOBRes.json().catch(() => null);
        throw new Error(e?.error || `Kalshi orderbook failed: ${kalshiOBRes.status}`);
      }
      if (!polyYesRes.ok) {
        const e = await polyYesRes.json().catch(() => null);
        throw new Error(e?.error || `Poly YES book failed: ${polyYesRes.status}`);
      }
      if (polyNoRes && !polyNoRes.ok) {
        const e = await polyNoRes.json().catch(() => null);
        throw new Error(e?.error || `Poly NO book failed: ${polyNoRes.status}`);
      }

      const kalshiOB = await kalshiOBRes.json();
      const polyYesData = await polyYesRes.json();
      const polyNoData = polyNoRes ? await polyNoRes.json() : { bids: [], asks: [] };

      // Parse Kalshi orderbook: { orderbook: { yes: [[cents, qty], ...], no: [...] } }
      const rawYes: [number, number][] = kalshiOB?.orderbook?.yes ?? [];
      const rawNo: [number, number][] = kalshiOB?.orderbook?.no ?? [];

      const yesBids: OrderBookLevel[] = rawYes
        .map(([c, q]: [number, number]) => ({
          price: c / 100,
          size: q,
        }))
        .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

      const noBids: OrderBookLevel[] = rawNo
        .map(([c, q]: [number, number]) => ({
          price: c / 100,
          size: q,
        }))
        .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

      setKalshiYesBids(yesBids);
      setKalshiNoBids(noBids);

      // Parse Poly books: { bids: [{price: "0.42", size: "100"},...], asks: [...] }
      const parsePolyLevels = (
        levels: any[]
      ): OrderBookLevel[] =>
        (levels || []).map((l: any) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }));

      const polyYesAsks = parsePolyLevels(polyYesData.asks).sort(
        (a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price
      );
      const polyYesBids = parsePolyLevels(polyYesData.bids).sort(
        (a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price
      );
      const polyNoAsks = parsePolyLevels(polyNoData.asks).sort(
        (a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price
      );
      const polyNoBids = parsePolyLevels(polyNoData.bids).sort(
        (a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price
      );

      setPolyYesBook({ bids: polyYesBids, asks: polyYesAsks });
      setPolyNoBook({ bids: polyNoBids, asks: polyNoAsks });

      // Run arb calculation
      const { arbA: a, arbB: b } = findBothArbitrages(
        yesBids,
        noBids,
        polyYesAsks,
        polyNoAsks
      );

      setArbA(a);
      setArbB(b);
      setFillPct(100);
      setCustomSize(null);
    } catch (e: any) {
      setError(e.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  }, [kalshiTicker, polyYesTokenId, polyNoTokenId]);

  const handleExportCSV = useCallback(() => {
    if (!arbA && !arbB) return;

    const ts = new Date().toISOString();
    const pairId = `${kalshiTicker}__${polyQuestion || "poly"}`;
    const rows: string[] = [];
    rows.push(
      "timestamp,pair_id,direction,kalshi_side,poly_side,max_contracts,total_cost,total_profit,profit_pct,total_fees,avg_cost,marginal_edge,break_level,thin_side,best_edge"
    );

    const addRow = (dir: string, r: ArbResult | null) => {
      if (!r) return;
      rows.push(
        [
          ts,
          pairId,
          dir,
          r.kalshiSide,
          r.polySide,
          r.totalContracts,
          fmt(r.totalCost, 4),
          fmt(r.totalProfit, 4),
          fmt(r.profitPct, 2),
          fmt(r.totalFees, 4),
          fmt(r.avgCostPerContract, 4),
          fmt(r.marginalEdge, 4),
          r.breakLevel,
          r.thinSide ?? "",
          fmt(r.bestEdge, 4),
        ].join(",")
      );
    };

    addRow("A", arbA);
    addRow("B", arbB);

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `arb-scan-${kalshiTicker}-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [arbA, arbB, kalshiTicker, polyQuestion]);

  // ---- Ready states ----
  const kalshiReady = kalshiTicker.length > 0;
  const polyReady = polyYesTokenId.length > 0;
  const canScan = kalshiReady && polyReady && !scanning;

  // ---- Computed sizing label ----
  const sizingLabel = useMemo(() => {
    if (!hasAnyArb) return "";
    const bestArb = arbA?.hasArb ? arbA : arbB;
    if (!bestArb) return "";
    if (customSize !== null) {
      return `Custom: ${customSize} contracts`;
    }
    const target = Math.max(
      1,
      Math.floor(bestArb.totalContracts * fillPct / 100)
    );
    return `Using ${fillPct}% \u2192 ${target} contracts`;
  }, [hasAnyArb, arbA, arbB, fillPct, customSize]);

  // ──────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* 1. Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">
            Arb Scanner
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Manual depth-walking arbitrage calculator{" "}
          <span className="text-zinc-600">
            &middot; Kalshi 7% taker fee &middot; Polymarket 2bps
          </span>
        </p>
        </div>

        {/* Import Verified Matches */}
        <div className="flex items-center gap-2">
          {importQueue.length > 0 && (
            <div className="flex items-center gap-1.5 mr-2">
              <button
                onClick={handleImportPrev}
                disabled={importIdx === 0}
                className="px-2 py-1 rounded text-[11px] font-semibold bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                ‹ Prev
              </button>
              <span className="text-[11px] text-zinc-500 font-mono tabular-nums min-w-[48px] text-center">
                {importIdx + 1}/{importQueue.length}
              </span>
              <button
                onClick={handleImportNext}
                disabled={importIdx >= importQueue.length - 1}
                className="px-2 py-1 rounded text-[11px] font-semibold bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next ›
              </button>
            </div>
          )}
          <button
            onClick={handleImportVerified}
            disabled={importing}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all border ${
              importing
                ? "bg-zinc-800/50 text-zinc-600 border-zinc-700 cursor-not-allowed"
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
            }`}
          >
            {importing ? "Loading..." : importQueue.length > 0 ? "Refresh" : "Import Verified"}
          </button>
        </div>
      </div>

      {/* Import queue info bar */}
      {importQueue.length > 0 && (
        <div className="glass-card rounded-xl px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Imported Pair</span>
            <span className="text-[12px] text-zinc-300 truncate max-w-[300px]">{importQueue[importIdx]?.poly_title}</span>
            <span className="text-[10px] text-zinc-600">×</span>
            <span className="text-[12px] text-zinc-300 truncate max-w-[300px]">{importQueue[importIdx]?.kalshi_title}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-zinc-500">
              Text: <span className="text-zinc-400 font-mono">{((importQueue[importIdx]?.text_score ?? 0) * 100).toFixed(0)}%</span>
            </span>
            <span className="text-[10px] text-zinc-500">
              AI: <span className="text-emerald-400 font-mono">{((importQueue[importIdx]?.ai_confidence ?? 0) * 100).toFixed(0)}%</span>
            </span>
          </div>
        </div>
      )}

      {/* 2. Market Inputs */}
      <div className="glass-card rounded-xl p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Left — Kalshi */}
          <div className="space-y-3">
            <label className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
              Kalshi Ticker / Event
            </label>
            <div className="relative">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={kalshiInput}
                  onChange={(e) => { setKalshiInput(e.target.value); setKalshiTicker(""); setKalshiTitle(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleKalshiLookup()}
                  placeholder="e.g. KXNEWPOPE-70 or search by name..."
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-white/[0.15] focus:ring-1 focus:ring-white/[0.08] font-mono transition-colors"
                />
                <button
                  onClick={handleKalshiLookup}
                  disabled={kalshiLooking || !kalshiInput.trim()}
                  className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-white/[0.06] text-zinc-300 hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2 shrink-0"
                >
                  {kalshiLooking && (
                    <Spinner className="w-3.5 h-3.5 border-zinc-400" />
                  )}
                  Lookup
                </button>
              </div>

              {/* Inline search results dropdown */}
              {kalshiSearchResults.length > 0 && !kalshiTicker && (
                <div className="absolute z-30 mt-1 w-full bg-zinc-900 border border-white/[0.1] rounded-lg shadow-2xl max-h-[260px] overflow-y-auto">
                  {kalshiSearching && (
                    <div className="px-3 py-2 text-[11px] text-zinc-500 flex items-center gap-2">
                      <Spinner className="w-3 h-3 border-zinc-500" /> Searching...
                    </div>
                  )}
                  {kalshiSearchResults.map((r: any, i: number) => (
                    <button
                      key={r.ticker || i}
                      onClick={() => handleSelectKalshiSearchResult(r)}
                      className="w-full text-left px-3 py-2 hover:bg-white/[0.06] transition-colors border-b border-white/[0.04] last:border-b-0"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] text-zinc-300 truncate">{r.title || r.event_title || r.ticker}</span>
                        <span className="text-[10px] font-mono text-zinc-500 ml-2 shrink-0">
                          {r.last_price != null ? `${typeof r.last_price === 'number' && r.last_price < 1 ? (r.last_price * 100).toFixed(0) : r.last_price}¢` : ""}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-zinc-600 mt-0.5">
                        {r.event_ticker || r.ticker}
                        {r.subtitle ? ` · ${r.subtitle}` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Market picker pills */}
            {kalshiMarkets.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {kalshiMarkets.map((m: any) => (
                  <button
                    key={m.ticker}
                    onClick={() => handleSelectKalshiMarket(m)}
                    className="px-3 py-1.5 rounded-lg text-[11px] bg-white/[0.04] border border-white/[0.06] text-zinc-300 hover:bg-white/[0.08] hover:border-white/[0.12] transition-colors"
                  >
                    <span className="text-zinc-400">{m.subtitle || m.title || m.ticker}</span>
                    {m.last_price != null && (
                      <span className="ml-1.5 font-mono tabular-nums text-zinc-500">
                        {m.last_price}¢
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Selected indicator */}
            {kalshiReady && (
              <div className="flex items-center gap-2 text-[12px]">
                <CheckIcon />
                <span className="font-mono text-emerald-400/80 tabular-nums">
                  {kalshiTicker}
                </span>
                <span className="text-zinc-500 truncate">{kalshiTitle}</span>
              </div>
            )}
          </div>

          {/* Right — Polymarket */}
          <div className="space-y-3">
            <label className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold">
              Polymarket Slug / URL
            </label>
            <div className="relative">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={polyInput}
                  onChange={(e) => { setPolyInput(e.target.value); setPolyYesTokenId(""); setPolyNoTokenId(""); setPolyQuestion(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handlePolyLookup()}
                  placeholder="e.g. fed-decision-in-march-885 or search..."
                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-white/[0.15] focus:ring-1 focus:ring-white/[0.08] font-mono transition-colors"
                />
                <button
                  onClick={handlePolyLookup}
                  disabled={polyLooking || !polyInput.trim()}
                  className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-white/[0.06] text-zinc-300 hover:bg-white/[0.1] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2 shrink-0"
                >
                  {polyLooking && (
                    <Spinner className="w-3.5 h-3.5 border-zinc-400" />
                  )}
                  Lookup
                </button>
              </div>

              {/* Inline search results dropdown */}
              {polySearchResults.length > 0 && !polyYesTokenId && (
                <div className="absolute z-30 mt-1 w-full bg-zinc-900 border border-white/[0.1] rounded-lg shadow-2xl max-h-[260px] overflow-y-auto">
                  {polySearching && (
                    <div className="px-3 py-2 text-[11px] text-zinc-500 flex items-center gap-2">
                      <Spinner className="w-3 h-3 border-zinc-500" /> Searching...
                    </div>
                  )}
                  {polySearchResults.map((r: any, i: number) => (
                    <button
                      key={r.slug || i}
                      onClick={() => handleSelectPolySearchResult(r)}
                      className="w-full text-left px-3 py-2 hover:bg-white/[0.06] transition-colors border-b border-white/[0.04] last:border-b-0"
                    >
                      <div className="text-[12px] text-zinc-300 truncate">{r.title}</div>
                      <div className="text-[10px] font-mono text-zinc-600 mt-0.5">
                        {r.slug}
                        {r.marketsCount > 1 ? ` · ${r.marketsCount} markets` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Market picker pills */}
            {polyMarkets.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {polyMarkets.map((m: any, i: number) => (
                  <button
                    key={m.conditionId || i}
                    onClick={() => handleSelectPolyMarket(m)}
                    className="px-3 py-1.5 rounded-lg text-[11px] bg-white/[0.04] border border-white/[0.06] text-zinc-300 hover:bg-white/[0.08] hover:border-white/[0.12] transition-colors text-left"
                  >
                    {m.question || m.slug || `Market ${i + 1}`}
                  </button>
                ))}
              </div>
            )}

            {/* Selected indicator */}
            {polyReady && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[12px]">
                  <CheckIcon />
                  <span className="text-zinc-300 truncate">
                    {polyQuestion}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                      YES Token
                    </label>
                    <input
                      type="text"
                      value={polyYesTokenId}
                      onChange={(e) => setPolyYesTokenId(e.target.value)}
                      className="w-full mt-0.5 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 text-[10px] text-zinc-500 font-mono truncate focus:outline-none focus:border-white/[0.12]"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">
                      NO Token
                    </label>
                    <input
                      type="text"
                      value={polyNoTokenId}
                      onChange={(e) => setPolyNoTokenId(e.target.value)}
                      className="w-full mt-0.5 bg-white/[0.03] border border-white/[0.06] rounded px-2 py-1 text-[10px] text-zinc-500 font-mono truncate focus:outline-none focus:border-white/[0.12]"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Scan button */}
        <div className="flex justify-center mt-5">
          <button
            onClick={handleScan}
            disabled={!canScan}
            className="px-8 py-2.5 rounded-lg text-[13px] font-semibold text-white transition-all duration-200 flex items-center gap-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              backgroundColor: canScan ? "#CC0035" : undefined,
              ...(canScan
                ? {}
                : { backgroundColor: "rgba(204,0,53,0.25)" }),
            }}
          >
            {scanning && (
              <Spinner className="w-4 h-4 border-white/60" />
            )}
            Scan for Arbitrage
          </button>
        </div>
      </div>

      {/* 3. Error Banner */}
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-400 shrink-0 mt-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="text-[13px] text-red-300">{error}</span>
          <button
            onClick={() => setError("")}
            className="ml-auto text-red-400 hover:text-red-300 transition-colors"
          >
            <XIcon />
          </button>
        </div>
      )}

      {/* 4. Size Control */}
      {hasAnyArb && (
        <div className="glass-card rounded-xl px-4 py-3 flex items-center gap-4 flex-wrap">
          <span className="text-[10px] text-zinc-500 uppercase tracking-[0.1em] font-semibold shrink-0">
            Position Size
          </span>

          <input
            type="range"
            min={1}
            max={100}
            value={customSize !== null ? 100 : fillPct}
            onChange={(e) => {
              setFillPct(Number(e.target.value));
              setCustomSize(null);
            }}
            disabled={customSize !== null}
            className="flex-1 min-w-[120px] accent-[#CC0035] h-1.5 bg-white/[0.06] rounded-full appearance-none cursor-pointer disabled:opacity-40"
          />

          <span className="font-mono tabular-nums text-[13px] text-zinc-300 w-12 text-right shrink-0">
            {customSize !== null ? "--" : `${fillPct}%`}
          </span>

          <div className="w-px h-5 bg-zinc-800 shrink-0" />

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-zinc-600">Custom:</span>
            <input
              type="number"
              min={1}
              value={customSize ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setCustomSize(v ? Number(v) : null);
              }}
              placeholder="#"
              className="w-20 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-[12px] text-zinc-200 font-mono tabular-nums focus:outline-none focus:border-white/[0.15] placeholder:text-zinc-700"
            />
          </div>

          {(fillPct !== 100 || customSize !== null) && (
            <button
              onClick={() => {
                setFillPct(100);
                setCustomSize(null);
              }}
              className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
              title="Reset to 100%"
            >
              <XIcon />
            </button>
          )}

          <span className="text-[11px] text-zinc-500 shrink-0">
            {sizingLabel}
          </span>
        </div>
      )}

      {/* 5. Direction Cards */}
      {hasResults && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {sizedArbA && arbA && (
            <ArbCard
              label="Direction A"
              result={sizedArbA}
              fullResult={arbA}
              showWalk={showWalkA}
              onToggleWalk={() => setShowWalkA(!showWalkA)}
            />
          )}
          {sizedArbB && arbB && (
            <ArbCard
              label="Direction B"
              result={sizedArbB}
              fullResult={arbB}
              showWalk={showWalkB}
              onToggleWalk={() => setShowWalkB(!showWalkB)}
            />
          )}
        </div>
      )}

      {/* 6. CSV Export */}
      {hasResults && (
        <div className="flex justify-end">
          <button
            onClick={handleExportCSV}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-white/[0.06] text-zinc-400 hover:bg-white/[0.1] hover:text-zinc-200 transition-colors flex items-center gap-2"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            Export CSV
          </button>
        </div>
      )}

      {/* 7. Raw Order Books */}
      {hasResults && (
        <div className="glass-card rounded-xl overflow-hidden">
          <button
            onClick={() => setShowRawBooks(!showRawBooks)}
            className="w-full px-4 py-3 flex items-center justify-between text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02] transition-colors"
          >
            <span>Show Raw Order Books</span>
            <ChevronDown
              className={`w-4 h-4 transition-transform duration-200 ${
                showRawBooks ? "rotate-180" : ""
              }`}
            />
          </button>

          {showRawBooks && (
            <div className="p-4 pt-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
              <RawBookTable
                title="Kalshi YES Bids"
                levels={kalshiYesBids}
                type="bids"
              />
              <RawBookTable
                title="Kalshi NO Bids"
                levels={kalshiNoBids}
                type="bids"
              />
              <RawBookTable
                title="Poly YES Asks"
                levels={polyYesBook.asks}
                type="asks"
              />
              <RawBookTable
                title="Poly NO Asks"
                levels={polyNoBook.asks}
                type="asks"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
