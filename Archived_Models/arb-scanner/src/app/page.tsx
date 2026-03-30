"use client";

import { useState, useCallback } from "react";
import {
  ArrowRightLeft,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Zap,
  Link,
  Download,
} from "lucide-react";
import { OrderBookLevel, ArbResult, WalkRow } from "@/lib/types";
import { findBothArbitrages, contractCost } from "@/lib/arbitrage";

/* ── helpers ── */
function fmt(n: number, decimals = 2) {
  return n.toFixed(decimals);
}
function fmtUSD(n: number) {
  return "$" + fmt(n);
}
function fmtPct(n: number) {
  return fmt(n, 1) + "%";
}

/* ── Kalshi orderbook parser ── */
function parseKalshiBook(data: {
  orderbook: {
    yes: [number, number][];
    no: [number, number][];
  };
}) {
  const ob = data.orderbook;
  // Kalshi returns BIDS only: yes[] = YES bids, no[] = NO bids.
  // [price_cents, quantity], sorted ascending in the raw response.
  // We sort bids descending (best bid first) for display.
  const yesBids: OrderBookLevel[] = (ob.yes || [])
    .map(([p, q]: [number, number]) => ({ price: p / 100, size: q }))
    .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

  const noBids: OrderBookLevel[] = (ob.no || [])
    .map(([p, q]: [number, number]) => ({ price: p / 100, size: q }))
    .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

  // Derived asks (for display and verification):
  // YES ask = flip NO bids: NO bid at X → YES ask at (1-X)
  // NO ask  = flip YES bids: YES bid at X → NO ask at (1-X)
  const yesAsks: OrderBookLevel[] = noBids
    .map((b) => ({ price: Math.round((1 - b.price) * 100) / 100, size: b.size }))
    .sort((a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price);

  const noAsks: OrderBookLevel[] = yesBids
    .map((b) => ({ price: Math.round((1 - b.price) * 100) / 100, size: b.size }))
    .sort((a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price);

  return { yesBids, noBids, yesAsks, noAsks };
}

/* ── Polymarket orderbook parser ── */
function parsePolyBook(data: {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}) {
  const bids: OrderBookLevel[] = (data.bids || [])
    .map((l: { price: string; size: string }) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }))
    .sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);

  const asks: OrderBookLevel[] = (data.asks || [])
    .map((l: { price: string; size: string }) => ({
      price: parseFloat(l.price),
      size: parseFloat(l.size),
    }))
    .sort((a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price);

  return { bids, asks };
}

/* ── Partial fill calculator ── */
function calculatePartialFill(result: ArbResult, targetContracts: number | null): ArbResult {
  if (!result.hasArb || targetContracts === null || targetContracts >= result.totalContracts) {
    return result; // return original if no arb or target >= max
  }

  // Walk through fills until we hit the target
  let remaining = targetContracts;
  let partialFills: typeof result.fills = [];
  let totalCostKalshi = 0;
  let totalCostPoly = 0;
  let totalFees = 0;
  let cumProfit = 0;

  for (const fill of result.fills) {
    if (remaining <= 0) break;
    
    const takeContracts = Math.min(fill.contracts, remaining);
    const ratio = takeContracts / fill.contracts;
    
    const partialFill = {
      ...fill,
      contracts: takeContracts,
      costKalshi: fill.costKalshi * ratio,
      costPoly: fill.costPoly * ratio,
      totalCost: fill.totalCost * ratio,
      payout: fill.payout * ratio,
      profit: fill.profit * ratio,
    };
    
    partialFills.push(partialFill);
    totalCostKalshi += partialFill.costKalshi;
    totalCostPoly += partialFill.costPoly;
    totalFees += (partialFill.totalCost - partialFill.costKalshi - partialFill.costPoly);
    cumProfit += partialFill.profit;
    remaining -= takeContracts;
  }

  const totalCost = totalCostKalshi + totalCostPoly + totalFees;
  const totalPayout = targetContracts * 1.0;
  const totalProfit = totalPayout - totalCost;

  // Build partial walk rows
  let cumN = 0;
  let cumCost = 0;
  const walkRows: typeof result.walkRows = [];
  for (const f of partialFills) {
    cumN += f.contracts;
    cumCost += f.totalCost;
    const { cost: levelCost } = contractCost(f.kalshiPrice, f.polyPrice);
    walkRows.push({
      n: cumN,
      kalshiPrice: f.kalshiPrice,
      polyPrice: f.polyPrice,
      levelQty: f.contracts,
      levelCost,
      avgCost: cumCost / cumN,
      marginalEdge: 1.0 - levelCost,
      cumProfit: cumProfit,
    });
  }

  return {
    ...result,
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
    avgCostPerContract: totalCost / targetContracts,
    marginalEdge: walkRows.length > 0 ? walkRows[walkRows.length - 1].marginalEdge : 0,
    breakLevel: 0, // reset for partial fills
  };
}

/* ── Component ── */
export default function Home() {
  // Kalshi
  const [kalshiInput, setKalshiInput] = useState("");
  const [kalshiTicker, setKalshiTicker] = useState("");
  const [kalshiTitle, setKalshiTitle] = useState("");
  const [kalshiMarkets, setKalshiMarkets] = useState<
    { ticker: string; title: string; subtitle: string; last_price: number }[]
  >([]);
  const [kalshiLooking, setKalshiLooking] = useState(false);

  // Polymarket
  const [polySlug, setPolySlug] = useState("");
  const [polyYesTokenId, setPolyYesTokenId] = useState("");
  const [polyNoTokenId, setPolyNoTokenId] = useState("");
  const [polyQuestion, setPolyQuestion] = useState("");
  const [polyMarkets, setPolyMarkets] = useState<
    { question: string; tokens: { token_id: string; outcome: string }[] }[]
  >([]);
  const [polyLooking, setPolyLooking] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Raw order book data for display
  const [kalshiYesBids, setKalshiYesBids] = useState<OrderBookLevel[]>([]);
  const [kalshiNoBids, setKalshiNoBids] = useState<OrderBookLevel[]>([]);
  const [kalshiYesAsks, setKalshiYesAsks] = useState<OrderBookLevel[]>([]);
  const [kalshiNoAsks, setKalshiNoAsks] = useState<OrderBookLevel[]>([]);
  const [polyYesBook, setPolyYesBook] = useState<{
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  }>({ bids: [], asks: [] });
  const [polyNoBook, setPolyNoBook] = useState<{
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  }>({ bids: [], asks: [] });

  // Both directions
  const [arbA, setArbA] = useState<ArbResult | null>(null);
  const [arbB, setArbB] = useState<ArbResult | null>(null);
  const [showFillsA, setShowFillsA] = useState(false);
  const [showFillsB, setShowFillsB] = useState(false);
  
  // Size slider (percentage-based)
  const [fillPercentage, setFillPercentage] = useState<number>(100); // 1-100%
  const [customSize, setCustomSize] = useState<string>(""); // custom contract input

  /* ── Kalshi lookup ── */
  const lookupKalshi = useCallback(async () => {
    if (!kalshiInput) return;
    setKalshiLooking(true);
    setError(null);
    setKalshiMarkets([]);
    setKalshiTitle("");
    setKalshiTicker("");
    try {
      const res = await fetch(
        `/api/kalshi/lookup?ticker=${encodeURIComponent(kalshiInput)}`
      );
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      const markets = data.markets || [];
      if (markets.length === 0) {
        setError("No Kalshi markets found.");
        return;
      }
      setKalshiMarkets(markets);
      if (data.type === "event") {
        setKalshiTitle(`Event: ${data.eventTicker} (${markets.length} markets)`);
      }
      // Auto-select if only one market
      if (markets.length === 1) {
        setKalshiTicker(markets[0].ticker);
        setKalshiTitle(markets[0].title || markets[0].subtitle || "");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError("Kalshi lookup: " + msg);
    } finally {
      setKalshiLooking(false);
    }
  }, [kalshiInput]);

  const selectKalshiMarket = useCallback(
    (idx: number) => {
      const m = kalshiMarkets[idx];
      if (!m) return;
      setKalshiTicker(m.ticker);
      setKalshiTitle(m.title || m.subtitle || "");
    },
    [kalshiMarkets]
  );

  /* ── Polymarket lookup ── */
  const selectPolyMarket = useCallback(
    (idx: number) => {
      const m = polyMarkets[idx];
      if (!m) return;
      setPolyQuestion(m.question);
      const tokens = m.tokens || [];
      if (tokens.length >= 2) {
        const yesToken = tokens.find(
          (t: { outcome: string }) => t.outcome?.toLowerCase() === "yes"
        );
        const noToken = tokens.find(
          (t: { outcome: string }) => t.outcome?.toLowerCase() === "no"
        );
        setPolyYesTokenId(yesToken?.token_id || tokens[0]?.token_id || "");
        setPolyNoTokenId(noToken?.token_id || tokens[1]?.token_id || "");
      }
    },
    [polyMarkets]
  );

  const lookupPoly = useCallback(async () => {
    if (!polySlug) return;
    setPolyLooking(true);
    setError(null);
    setPolyMarkets([]);
    setPolyQuestion("");
    setPolyYesTokenId("");
    setPolyNoTokenId("");
    try {
      const res = await fetch(
        `/api/poly/lookup?slug=${encodeURIComponent(polySlug)}`
      );
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      const markets = data.markets || [];

      if (markets.length === 0) {
        setError("No Polymarket markets found.");
        return;
      }

      setPolyQuestion(data.title || "");
      setPolyMarkets(markets);

      if (markets.length === 1) {
        const m = markets[0];
        const tokens = m.tokens || [];
        if (tokens.length >= 2) {
          const yesToken = tokens.find(
            (t: { outcome: string }) => t.outcome?.toLowerCase() === "yes"
          );
          const noToken = tokens.find(
            (t: { outcome: string }) => t.outcome?.toLowerCase() === "no"
          );
          setPolyYesTokenId(yesToken?.token_id || tokens[0]?.token_id || "");
          setPolyNoTokenId(noToken?.token_id || tokens[1]?.token_id || "");
          setPolyQuestion(m.question || data.title || "");
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError("Poly lookup: " + msg);
    } finally {
      setPolyLooking(false);
    }
  }, [polySlug]);

  const scan = useCallback(async () => {
    if (!kalshiTicker || !polyYesTokenId || !polyNoTokenId) {
      setError("Please fill in Kalshi ticker + both Polymarket token IDs.");
      return;
    }
    setLoading(true);
    setError(null);
    setArbA(null);
    setArbB(null);

    try {
      const [kRes, pyRes, pnRes] = await Promise.all([
        fetch(
          `/api/kalshi/orderbook?ticker=${encodeURIComponent(kalshiTicker)}`
        ),
        fetch(
          `/api/poly/book?token_id=${encodeURIComponent(polyYesTokenId)}`
        ),
        fetch(
          `/api/poly/book?token_id=${encodeURIComponent(polyNoTokenId)}`
        ),
      ]);

      if (!kRes.ok) throw new Error(`Kalshi: ${(await kRes.json()).error}`);
      if (!pyRes.ok)
        throw new Error(`Poly YES: ${(await pyRes.json()).error}`);
      if (!pnRes.ok)
        throw new Error(`Poly NO: ${(await pnRes.json()).error}`);

      const kData = await kRes.json();
      const pyData = await pyRes.json();
      const pnData = await pnRes.json();

      // Parse
      const kalshi = parseKalshiBook(kData);
      setKalshiYesBids(kalshi.yesBids);
      setKalshiNoBids(kalshi.noBids);
      setKalshiYesAsks(kalshi.yesAsks);
      setKalshiNoAsks(kalshi.noAsks);

      const polyYes = parsePolyBook(pyData);
      const polyNo = parsePolyBook(pnData);
      setPolyYesBook(polyYes);
      setPolyNoBook(polyNo);

      // Calculate both directions
      // findBothArbitrages receives raw Kalshi bids and internally flips them
      const { arbA: a, arbB: b } = findBothArbitrages(
        kalshi.yesBids,
        kalshi.noBids,
        polyYes.asks,
        polyNo.asks
      );
      setArbA(a);
      setArbB(b);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [kalshiTicker, polyYesTokenId, polyNoTokenId]);

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <ArrowRightLeft className="w-8 h-8 text-emerald-400" />
        <div>
          <h1 className="text-2xl font-bold">Arb Scanner</h1>
          <p className="text-gray-400 text-sm">
            Kalshi × Polymarket cross-market arbitrage · Fees included (Kalshi
            7% profit, Poly 2bps)
          </p>
        </div>
      </div>

      {/* Inputs */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Market Inputs
        </h2>

        {/* Row 1: Kalshi + Poly lookups */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Kalshi Ticker (event or market)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={kalshiInput}
                onChange={(e) => setKalshiInput(e.target.value.toUpperCase())}
                placeholder="e.g. KXFEDDECISION-26MAR or KXBTCVSGOLD-26"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500 placeholder-gray-600"
              />
              <button
                onClick={lookupKalshi}
                disabled={kalshiLooking || !kalshiInput}
                className="flex items-center gap-1 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm px-3 py-2 rounded-lg transition-colors whitespace-nowrap"
              >
                {kalshiLooking ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Link className="w-3 h-3" />
                )}
                Lookup
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Polymarket Slug (auto-fills token IDs)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={polySlug}
                onChange={(e) => setPolySlug(e.target.value)}
                placeholder="slug or full URL, e.g. fed-decision-in-march-885"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500 placeholder-gray-600"
              />
              <button
                onClick={lookupPoly}
                disabled={polyLooking || !polySlug}
                className="flex items-center gap-1 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm px-3 py-2 rounded-lg transition-colors whitespace-nowrap"
              >
                {polyLooking ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <Link className="w-3 h-3" />
                )}
                Lookup
              </button>
            </div>
          </div>
        </div>

        {/* Kalshi market picker */}
        {kalshiTitle && (
          <p className="text-xs text-blue-300 mb-1">
            Kalshi: <strong>{kalshiTitle}</strong>
            {kalshiTicker && (
              <span className="ml-2 font-mono text-blue-400">[{kalshiTicker}]</span>
            )}
          </p>
        )}
        {kalshiMarkets.length > 1 && (
          <div className="mb-3">
            <label className="block text-xs text-gray-500 mb-1">
              Select Kalshi sub-market ({kalshiMarkets.length} found)
            </label>
            <div className="flex flex-wrap gap-2">
              {kalshiMarkets.map((m, i) => (
                <button
                  key={i}
                  onClick={() => selectKalshiMarket(i)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    kalshiTicker === m.ticker
                      ? "bg-blue-700 border-blue-500 text-white"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:border-blue-600 hover:text-gray-200"
                  }`}
                >
                  {m.subtitle || m.title} · {m.last_price}¢
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Polymarket info */}
        {polyQuestion && (
          <p className="text-xs text-purple-300 mb-1">
            Poly: <strong>{polyQuestion}</strong>
          </p>
        )}
        {polyMarkets.length > 1 && (
          <div className="mb-3">
            <label className="block text-xs text-gray-500 mb-1">
              Select market ({polyMarkets.length} found)
            </label>
            <div className="flex flex-wrap gap-2">
              {polyMarkets.map((m, i) => (
                <button
                  key={i}
                  onClick={() => selectPolyMarket(i)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    polyYesTokenId &&
                    m.tokens?.some(
                      (t: { token_id: string }) => t.token_id === polyYesTokenId
                    )
                      ? "bg-purple-700 border-purple-500 text-white"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:border-purple-600 hover:text-gray-200"
                  }`}
                >
                  {m.question || `Market ${i + 1}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Row 2: Token IDs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Polymarket YES Token ID
            </label>
            <input
              type="text"
              value={polyYesTokenId}
              onChange={(e) => setPolyYesTokenId(e.target.value)}
              placeholder="Long numeric token ID for YES"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-purple-500 placeholder-gray-600"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Polymarket NO Token ID
            </label>
            <input
              type="text"
              value={polyNoTokenId}
              onChange={(e) => setPolyNoTokenId(e.target.value)}
              placeholder="Long numeric token ID for NO"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-purple-500 placeholder-gray-600"
            />
          </div>
        </div>

        <button
          onClick={scan}
          disabled={loading}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
        >
          {loading ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          {loading ? "Scanning..." : "Scan for Arbitrage"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-950/50 border border-red-800 text-red-300 rounded-lg px-4 py-3 mb-6">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Arb Results — Both Directions */}
      {arbA && arbB && (
        <div className="space-y-4 mb-6">
          {/* Size slider */}
          {(arbA.hasArb || arbB.hasArb) && (
            <div className="bg-gray-800/60 rounded-xl border border-gray-700/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-semibold text-gray-300">
                  Fill Size
                </label>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-mono text-gray-400">
                    {customSize ? `${customSize} contracts` : `${fillPercentage}% (${Math.floor(Math.max(arbA.totalContracts, arbB.totalContracts) * fillPercentage / 100)} contracts)`}
                  </span>
                  <button
                    onClick={() => {
                      setCustomSize("");
                      setFillPercentage(100);
                    }}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    Reset
                  </button>
                </div>
              </div>
              
              {/* Custom input */}
              <div className="mb-3">
                <input
                  type="number"
                  min="1"
                  max={Math.max(arbA.totalContracts, arbB.totalContracts)}
                  value={customSize}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "") {
                      setCustomSize("");
                    } else {
                      const num = parseInt(val);
                      if (num >= 1 && num <= Math.max(arbA.totalContracts, arbB.totalContracts)) {
                        setCustomSize(val);
                      }
                    }
                  }}
                  placeholder="Custom contract count"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-purple-500 placeholder-gray-600"
                />
              </div>

              {/* Percentage slider */}
              <div className={customSize ? "opacity-50 pointer-events-none" : ""}>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={fillPercentage}
                  onChange={(e) => setFillPercentage(parseInt(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
                />
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  <span>1%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>
          )}

          {/* CSV export */}
          {(arbA.hasArb || arbB.hasArb) && (
            <div className="flex justify-end">
              <button
                onClick={() => exportCSV(kalshiTicker, arbA, arbB)}
                className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-lg border border-gray-700 transition-colors"
              >
                <Download className="w-3 h-3" />
                Export CSV
              </button>
            </div>
          )}
          <ArbCard
            label="Direction A"
            subtitle="Buy Kalshi YES + Buy Poly NO"
            result={calculatePartialFill(arbA, customSize ? parseInt(customSize) : Math.floor(arbA.totalContracts * fillPercentage / 100))}
            kalshiAsks={kalshiYesAsks}
            polyAsks={polyNoBook.asks}
            showFills={showFillsA}
            setShowFills={setShowFillsA}
          />
          <ArbCard
            label="Direction B"
            subtitle="Buy Kalshi NO + Buy Poly YES"
            result={calculatePartialFill(arbB, customSize ? parseInt(customSize) : Math.floor(arbB.totalContracts * fillPercentage / 100))}
            kalshiAsks={kalshiNoAsks}
            polyAsks={polyYesBook.asks}
            showFills={showFillsB}
            setShowFills={setShowFillsB}
          />
        </div>
      )}

      {/* Order Books — What you'd pay to BUY each side */}
      {(kalshiYesAsks.length > 0 || polyYesBook.asks.length > 0) && (
        <div className="space-y-4 mb-6">
          {/* YES side */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-1">Buy YES — Ask Books</h3>
            <p className="text-xs text-gray-600 mb-3">Price to buy YES on each platform (cheapest first)</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="text-xs text-blue-400 font-semibold mb-1">Kalshi YES Asks ({kalshiYesAsks.length} levels)</h4>
                <BookTable levels={kalshiYesAsks} type="ask" />
              </div>
              <div>
                <h4 className="text-xs text-purple-400 font-semibold mb-1">Polymarket YES Asks ({polyYesBook.asks.length} levels)</h4>
                <BookTable levels={polyYesBook.asks} type="ask" />
              </div>
            </div>
          </div>

          {/* NO side */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-1">Buy NO — Ask Books</h3>
            <p className="text-xs text-gray-600 mb-3">Price to buy NO on each platform (cheapest first)</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="text-xs text-blue-400 font-semibold mb-1">Kalshi NO Asks ({kalshiNoAsks.length} levels)</h4>
                <BookTable levels={kalshiNoAsks} type="ask" />
              </div>
              <div>
                <h4 className="text-xs text-purple-400 font-semibold mb-1">Polymarket NO Asks ({polyNoBook.asks.length} levels)</h4>
                <BookTable levels={polyNoBook.asks} type="ask" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="bg-gray-900/50 rounded-xl border border-gray-800 p-6">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          How it works
        </h3>
        <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
          <li>
            Find the same binary event on Kalshi and Polymarket.
          </li>
          <li>
            Enter the Kalshi ticker. Use the <strong>slug lookup</strong> to
            auto-fill Polymarket token IDs (slug is the last part of the
            Polymarket event URL).
          </li>
          <li>
            Click <strong>Scan</strong>. The tool fetches order books from both
            platforms and walks ask levels contract-by-contract.
          </li>
          <li>
            For each contract pair, it calculates: cost = kalshi_price +
            poly_price + fees. If cost &lt; $1.00, there is edge.
          </li>
          <li>
            It keeps filling until cost reaches $1.00 — that is the max
            contracts you can arb.
          </li>
        </ol>
        <div className="mt-3 text-xs text-gray-500">
          <strong>Fees:</strong> Kalshi taker fee = ⌈0.07 × P × (1−P)⌉ per
          contract (rounded up to nearest cent). Polymarket 0.02% (2bps) of
          notional.{" "}
          <strong>Thin book:</strong> warns when either side has &lt; $500 of
          ask depth — size estimates may be unreliable.
        </div>
      </div>
    </main>
  );
}

/* ── Sub-components ── */

/* ── CSV export ── */
function exportCSV(pairId: string, arbA: ArbResult, arbB: ArbResult) {
  const ts = new Date().toISOString();
  const rows = [
    "timestamp,pair_id,direction,max_contracts,max_notional,avg_cost_at_max,marginal_edge_at_max,break_level,total_profit,return_pct",
  ];
  for (const [dir, r] of [["A_kalshi_yes_poly_no", arbA], ["B_kalshi_no_poly_yes", arbB]] as const) {
    rows.push(
      [
        ts,
        pairId,
        dir,
        r.totalContracts,
        r.totalCost.toFixed(4),
        r.avgCostPerContract.toFixed(6),
        r.marginalEdge.toFixed(6),
        r.breakLevel || "beyond_depth",
        r.totalProfit.toFixed(4),
        r.profitPct.toFixed(2) + "%",
      ].join(",")
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lob_size_${pairId}_${ts.slice(0, 19).replace(/:/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function ArbCard({
  label,
  subtitle,
  result,
  kalshiAsks,
  polyAsks,
  showFills,
  setShowFills,
}: {
  label: string;
  subtitle: string;
  result: ArbResult;
  kalshiAsks: OrderBookLevel[];
  polyAsks: OrderBookLevel[];
  showFills: boolean;
  setShowFills: (v: boolean) => void;
}) {
  const hasArb = result.hasArb;
  return (
    <div
      className={`rounded-xl border p-5 ${
        hasArb
          ? "bg-emerald-950/30 border-emerald-700"
          : "bg-gray-900 border-gray-800"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-300">{label}</h3>
        <div className="flex items-center gap-2">
          {result.thinSide && (
            <Tip text={`${result.thinSide} side has < $500 ask depth (K: $${fmtCompact(result.kalshiDepth)}, P: $${fmtCompact(result.polyDepth)}). Size may be unreliable.`}>
              <span className="text-xs bg-yellow-900/50 text-yellow-400 px-2 py-0.5 rounded cursor-help">
                THIN: {result.thinSide} &lt;$500
              </span>
            </Tip>
          )}
          {hasArb && (
            <span className="flex items-center gap-1 text-xs bg-emerald-900/50 text-emerald-400 px-2 py-0.5 rounded font-bold">
              <TrendingUp className="w-3 h-3" /> ARB
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-3">{subtitle}</p>

      {hasArb ? (
        <>
          {/* Key metrics row 1 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat
              label="N_max"
              tip="Maximum contracts you can fill before the combined cost (yes + no + fees) reaches $1.00 per contract."
              value={fmt(result.totalContracts, 0)}
              color="text-white"
              large
            />
            <Stat
              label="Avg cost @ N_max"
              tip="Weighted average cost per contract across all N_max fills. = total_cost / N_max. Must be < 100¢ for profit."
              value={fmt(result.avgCostPerContract * 100, 2) + "¢"}
            />
            <Stat
              label="Edge @ N_max"
              tip="Edge on the last (most expensive) contract filled. This is 100¢ minus the marginal cost of contract #N_max. The closer to 0, the tighter the arb."
              value={fmt(result.marginalEdge * 100, 2) + "¢"}
              color="text-emerald-400"
            />
            <Stat
              label="Break level"
              tip="The contract number where marginal cost first hits $1.00 — i.e., the arb dies. 'Beyond depth' means the book ran out before the arb disappeared."
              value={
                result.breakLevel > 0
                  ? `#${result.breakLevel}`
                  : "Beyond depth"
              }
              color="text-yellow-400"
            />
          </div>
          {/* ── Cost vs Payout Receipt ── */}
          <div className="bg-gray-800/60 rounded-xl border border-gray-700/60 p-5 mb-4">
            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
              Full Cost vs Payout Breakdown
            </h4>
            <p className="text-[11px] text-gray-600 mb-4">
              Buy {result.totalContracts} {result.kalshiSide.toUpperCase()} on Kalshi + {result.totalContracts} {result.polySide.toUpperCase()} on Polymarket → one side always pays $1.00/contract
            </p>

            {/* Two-column: what you spend vs what you get */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              {/* LEFT: What you spend */}
              <div className="space-y-0">
                <div className="text-[11px] font-bold text-red-400 uppercase tracking-wider mb-2">You Spend</div>
                <div className="font-mono text-sm space-y-1.5">
                  {/* Kalshi leg */}
                  <div className="flex justify-between">
                    <span className="text-blue-400">{result.totalContracts} × Kalshi {result.kalshiSide.toUpperCase()}</span>
                    <span className="text-blue-300">{fmtUSD(result.totalCostKalshi)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span className="text-[10px]">Avg fill price</span>
                    <span className="text-[10px]">{fmt(result.totalCostKalshi / result.totalContracts * 100, 2)}¢</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <Tip text={`Kalshi fee = ceil(7% × P × (1−P)) per contract, summed across ${result.totalContracts} fills at varying prices.`}>
                      <span className="cursor-help pl-3">+ Kalshi fees <span className="text-[10px]">(⌈7% × P(1−P)⌉)</span></span>
                    </Tip>
                    <span>{fmtUSD(result.totalCostKalshi > 0 ? result.totalFees - (0.0002 * result.totalCostPoly) : 0)}</span>
                  </div>
                  <div className="border-t border-gray-700/50 my-1" />
                  {/* Poly leg */}
                  <div className="flex justify-between">
                    <span className="text-purple-400">{result.totalContracts} × Poly {result.polySide.toUpperCase()}</span>
                    <span className="text-purple-300">{fmtUSD(result.totalCostPoly)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span className="text-[10px]">Avg fill price</span>
                    <span className="text-[10px]">{fmt(result.totalCostPoly / result.totalContracts * 100, 2)}¢</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <Tip text={`Polymarket fee = 0.02% (2 bps) of notional = 0.0002 × $${fmt(result.totalCostPoly)}.`}>
                      <span className="cursor-help pl-3">+ Poly fees <span className="text-[10px]">(0.02% notional)</span></span>
                    </Tip>
                    <span>{fmtUSD(0.0002 * result.totalCostPoly)}</span>
                  </div>
                  <div className="border-t border-gray-600 mt-2 pt-2 flex justify-between font-bold text-white">
                    <span>Total Spent</span>
                    <span className="text-red-400">{fmtUSD(result.totalCost)}</span>
                  </div>
                </div>
              </div>

              {/* RIGHT: What you get back */}
              <div className="space-y-0">
                <div className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider mb-2">You Get Back</div>
                <div className="font-mono text-sm space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-gray-300">Payout per contract</span>
                    <span className="text-gray-200">$1.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-300">× Contracts filled</span>
                    <span className="text-gray-200">{result.totalContracts}</span>
                  </div>
                  <div className="border-t border-gray-600 mt-2 pt-2 flex justify-between font-bold text-white">
                    <span>Total Payout</span>
                    <span className="text-emerald-400">{fmtUSD(result.totalPayout)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom: Profit bar */}
            <div className="bg-emerald-950/40 border border-emerald-800/50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-emerald-300">Guaranteed Profit</span>
                <span className="text-lg font-bold font-mono text-emerald-400">{fmtUSD(result.totalProfit)}</span>
              </div>
              <div className="font-mono text-xs text-gray-400 mb-2">
                = {fmtUSD(result.totalPayout)} payout − {fmtUSD(result.totalCost)} spent
              </div>
              {/* Visual bar: cost vs payout */}
              <div className="relative h-6 bg-gray-900 rounded overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-red-900/60 border-r border-red-500"
                  style={{ width: `${Math.min((result.totalCost / result.totalPayout) * 100, 100)}%` }}
                >
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-red-300">
                    Cost {fmt((result.totalCost / result.totalPayout) * 100, 1)}%
                  </span>
                </div>
                <div
                  className="absolute inset-y-0 right-0 bg-emerald-900/40"
                  style={{ width: `${Math.max(100 - (result.totalCost / result.totalPayout) * 100, 0)}%` }}
                >
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-emerald-300">
                    Profit {fmtPct(result.profitPct)}
                  </span>
                </div>
              </div>
              <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                <span>$0</span>
                <span>Payout: {fmtUSD(result.totalPayout)}</span>
              </div>
            </div>

            {/* Formula reference */}
            <div className="mt-3 text-[11px] text-gray-600 font-mono leading-relaxed">
              <span className="text-gray-500 font-sans font-semibold">Formula:</span>{" "}
              per contract cost = K_ask + P_ask + ⌈0.07 × K_ask × (1−K_ask)⌉ + 0.0002 × P_ask
              <br />
              <span className="text-gray-500 font-sans font-semibold">Arb exists when:</span>{" "}
              cost &lt; $1.00 → edge = $1.00 − cost
              <br />
              <span className="text-gray-500 font-sans font-semibold">Avg cost/contract:</span>{" "}
              {fmt(result.avgCostPerContract * 100, 2)}¢ &nbsp;·&nbsp;
              <span className="text-gray-500 font-sans font-semibold">Edge on last fill:</span>{" "}
              {fmt(result.marginalEdge * 100, 2)}¢ &nbsp;·&nbsp;
              <span className="text-gray-500 font-sans font-semibold">Break level:</span>{" "}
              {result.breakLevel > 0 ? `contract #${result.breakLevel}` : "beyond depth"}
            </div>
          </div>

          {/* Depth info */}
          <div className="flex gap-4 text-xs text-gray-500 mb-3">
            <Tip text="Total dollar value of the Kalshi ask ladder used for this leg.">
              <span className="cursor-help">K depth: <span className="text-blue-400">${fmtCompact(result.kalshiDepth)}</span></span>
            </Tip>
            <Tip text="Total dollar value of the Polymarket ask ladder used for this leg.">
              <span className="cursor-help">P depth: <span className="text-purple-400">${fmtCompact(result.polyDepth)}</span></span>
            </Tip>
          </div>

          {/* Walk table toggle */}
          <button
            onClick={() => setShowFills(!showFills)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 mb-2"
          >
            {showFills ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showFills ? "Hide" : "Show"} walk analysis ({result.walkRows.length} levels)
          </button>

          {showFills && (
            <>
              {/* Ask ladders side by side */}
              <div className="grid grid-cols-2 gap-4 mb-3">
                <div>
                  <h4 className="text-xs text-blue-400 font-semibold mb-1">
                    Kalshi {result.kalshiSide.toUpperCase()} asks (this leg)
                  </h4>
                  <BookTable levels={kalshiAsks} type="ask" />
                </div>
                <div>
                  <h4 className="text-xs text-purple-400 font-semibold mb-1">
                    Poly {result.polySide.toUpperCase()} asks (this leg)
                  </h4>
                  <BookTable levels={polyAsks} type="ask" />
                </div>
              </div>

              {/* Edge by level table */}
              <h4 className="text-xs text-gray-400 font-semibold mb-1 mt-4">
                Edge by level (per contract)
              </h4>
              <p className="text-xs text-gray-600 mb-3">
                Shows marginal edge for each contract pair: green = good arb, yellow = thin, red = no edge
              </p>
              <div className="overflow-x-auto">
                <BookTableWithEdge 
                  kalshiLevels={kalshiAsks}
                  polyLevels={polyAsks}
                  maxContracts={result.totalContracts}
                />
              </div>

              {/* Walk table */}
              <h4 className="text-xs text-gray-400 font-semibold mb-1 mt-4">
                Contract-by-contract walk (grouped by price levels)
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-gray-500 uppercase">
                      <Th tip="Running total of contracts filled so far">Cum N</Th>
                      <Th tip="Contracts available at this price pair">Lvl Qty</Th>
                      <Th tip="Kalshi ask price for this level">K Price</Th>
                      <Th tip="Polymarket ask price for this level">P Price</Th>
                      <Th tip="Cost per contract at this level = K price + P price + fees">Lvl Cost</Th>
                      <Th tip="Running weighted average cost across all contracts filled so far">Avg Cost</Th>
                      <Th tip="Edge per contract at this level = 100¢ − level cost. Green > 2¢, yellow > 0.5¢, red < 0.5¢">Marg Edge</Th>
                      <Th tip="Running cumulative profit across all contracts filled">Cum $</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.walkRows.map((w: WalkRow, i: number) => (
                      <tr key={i} className="border-t border-gray-800">
                        <td className="py-1 px-1 text-right">{w.n}</td>
                        <td className="py-1 px-1 text-right text-gray-400">{w.levelQty}</td>
                        <td className="py-1 px-1 text-right text-blue-400">
                          {fmt(w.kalshiPrice * 100, 1)}¢
                        </td>
                        <td className="py-1 px-1 text-right text-purple-400">
                          {fmt(w.polyPrice * 100, 1)}¢
                        </td>
                        <td className="py-1 px-1 text-right">
                          {fmt(w.levelCost * 100, 2)}¢
                        </td>
                        <td className="py-1 px-1 text-right text-gray-300">
                          {fmt(w.avgCost * 100, 2)}¢
                        </td>
                        <td
                          className={`py-1 px-1 text-right ${
                            w.marginalEdge > 0.02
                              ? "text-emerald-400"
                              : w.marginalEdge > 0.005
                              ? "text-yellow-400"
                              : "text-red-400"
                          }`}
                        >
                          {fmt(w.marginalEdge * 100, 2)}¢
                        </td>
                        <td className="py-1 px-1 text-right text-emerald-300">
                          {fmtUSD(w.cumProfit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-gray-500">
            <DollarSign className="w-4 h-4" />
            <span className="text-sm font-semibold">No arb — combined cost ≥ $1.00 after fees</span>
          </div>

          {/* Best-ask cost breakdown */}
          {(result.bestKalshiAsk > 0 || result.bestPolyAsk > 0) && (
            <div className="bg-gray-800/50 rounded-lg border border-gray-700/50 p-4">
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Best-ask cost breakdown (1 contract)
              </h4>
              <div className="space-y-1.5 font-mono text-sm">
                <div className="flex justify-between">
                  <Tip text={`Best available ask on Kalshi ${result.kalshiSide.toUpperCase()} side.`}>
                    <span className="text-blue-400 cursor-help">Kalshi {result.kalshiSide.toUpperCase()} ask</span>
                  </Tip>
                  <span className="text-blue-400">{fmt(result.bestKalshiAsk * 100, 2)}¢</span>
                </div>
                <div className="flex justify-between">
                  <Tip text={`Best available ask on Polymarket ${result.polySide.toUpperCase()} side.`}>
                    <span className="text-purple-400 cursor-help">Poly {result.polySide.toUpperCase()} ask</span>
                  </Tip>
                  <span className="text-purple-400">{fmt(result.bestPolyAsk * 100, 2)}¢</span>
                </div>
                <div className="flex justify-between text-gray-500">
                  <Tip text={`Kalshi taker fee = ⌈0.07 × ${fmt(result.bestKalshiAsk * 100, 1)}¢ × ${fmt((1 - result.bestKalshiAsk) * 100, 1)}¢ / 100⌉ = ${fmt(result.bestKalshiFee * 100, 2)}¢`}>
                    <span className="cursor-help">Kalshi fee</span>
                  </Tip>
                  <span>+{fmt(result.bestKalshiFee * 100, 2)}¢</span>
                </div>
                <div className="flex justify-between text-gray-500">
                  <Tip text="Polymarket fee = 0.02% (2bps) of notional.">
                    <span className="cursor-help">Poly fee</span>
                  </Tip>
                  <span>+{fmt(result.bestPolyFee * 100, 4)}¢</span>
                </div>
                <div className="border-t border-gray-600 pt-1.5 flex justify-between font-bold">
                  <span className="text-gray-300">Total cost</span>
                  <span className={result.bestTotalCost >= 1 ? "text-red-400" : "text-emerald-400"}>
                    {fmt(result.bestTotalCost * 100, 2)}¢
                  </span>
                </div>
                <div className="flex justify-between font-bold">
                  <span className="text-gray-300">Payout</span>
                  <span className="text-gray-300">100.00¢</span>
                </div>
                <div className="border-t border-gray-600 pt-1.5 flex justify-between font-bold text-lg">
                  <Tip text="Edge = 100¢ − total cost. Negative means you lose money on every contract.">
                    <span className="text-gray-300 cursor-help">Edge</span>
                  </Tip>
                  <span className={result.bestEdge >= 0 ? "text-emerald-400" : "text-red-400"}>
                    {result.bestEdge >= 0 ? "+" : ""}{fmt(result.bestEdge * 100, 2)}¢
                  </span>
                </div>
              </div>
              {result.bestEdge < 0 && (
                <p className="text-xs text-red-400/70 mt-2">
                  You would lose {fmt(Math.abs(result.bestEdge) * 100, 2)}¢ per contract even at the best available prices.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Tooltip wrapper ── */
function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="relative group/tip inline-block">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-64 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-xs text-gray-300 opacity-0 group-hover/tip:opacity-100 transition-opacity z-50 shadow-lg leading-relaxed">
        {text}
      </span>
    </span>
  );
}

/* ── Walk table header with tooltip ── */
function Th({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <th className="text-right py-1 px-1">
      <Tip text={tip}>
        <span className="cursor-help border-b border-dotted border-gray-600">{children}</span>
      </Tip>
    </th>
  );
}

function Stat({
  label,
  tip,
  value,
  color,
  large,
}: {
  label: string;
  tip?: string;
  value: string;
  color?: string;
  large?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-0.5">
        {tip ? (
          <Tip text={tip}>
            <span className="cursor-help border-b border-dotted border-gray-600">{label}</span>
          </Tip>
        ) : (
          label
        )}
      </div>
      <div
        className={`font-mono font-bold ${large ? "text-lg" : "text-sm"} ${
          color || "text-gray-200"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function BookTable({
  levels,
  type,
}: {
  levels: OrderBookLevel[];
  type: "bid" | "ask";
}) {
  if (levels.length === 0) {
    return <p className="text-xs text-gray-600 italic">Empty</p>;
  }

  const displayed = levels.slice(0, 15);
  const color = type === "bid" ? "text-green-400" : "text-red-400";

  // Running cumulative $ total
  let cumTotal = 0;
  const rows = displayed.map((l) => {
    const dollarTotal = l.price * l.size;
    cumTotal += dollarTotal;
    return { ...l, dollarTotal, cumTotal };
  });

  // Grand total across ALL levels
  const grandTotal = levels.reduce((sum, l) => sum + l.price * l.size, 0);

  return (
    <table className="w-full text-xs font-mono">
      <thead>
        <tr className="text-gray-600">
          <th className="text-left py-0.5">Price</th>
          <th className="text-right py-0.5">Size</th>
          <th className="text-right py-0.5">$ Total</th>
          <th className="text-right py-0.5">$ Cum</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l, i) => (
          <tr key={i} className="border-t border-gray-800/50">
            <td className={`py-0.5 ${color}`}>
              {fmt(l.price * 100, 1)}¢
            </td>
            <td className="py-0.5 text-right text-gray-400">
              {fmtCompact(l.size)}
            </td>
            <td className="py-0.5 text-right text-gray-300">
              ${fmtCompact(l.dollarTotal)}
            </td>
            <td className="py-0.5 text-right text-gray-500">
              ${fmtCompact(l.cumTotal)}
            </td>
          </tr>
        ))}
        {levels.length > 15 && (
          <tr>
            <td colSpan={4} className="text-gray-600 text-center py-1">
              +{levels.length - 15} more · total depth ${fmtCompact(grandTotal)}
            </td>
          </tr>
        )}
        <tr className="border-t border-gray-700">
          <td colSpan={2} className="py-1 text-gray-500 font-semibold">Total depth</td>
          <td colSpan={2} className="py-1 text-right text-gray-300 font-semibold">
            ${fmtCompact(grandTotal)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function BookTableWithEdge({
  kalshiLevels,
  polyLevels,
  maxContracts,
}: {
  kalshiLevels: OrderBookLevel[];
  polyLevels: OrderBookLevel[];
  maxContracts: number;
}) {
  if (kalshiLevels.length === 0 || polyLevels.length === 0) {
    return <p className="text-xs text-gray-600 italic">Empty</p>;
  }

  // Flatten to individual contract prices
  const kalshiPrices = kalshiLevels.flatMap(l => Array(Math.floor(l.size)).fill(l.price));
  const polyPrices = polyLevels.flatMap(l => Array(Math.floor(l.size)).fill(l.price));
  
  const cap = Math.min(kalshiPrices.length, polyPrices.length, maxContracts);
  
  const rows = [];
  let cumKalshi = 0;
  let cumPoly = 0;
  let lastKPrice = -1;
  let lastPPrice = -1;
  let contractCount = 0;
  
  for (let i = 0; i < cap; i++) {
    const kPrice = kalshiPrices[i];
    const pPrice = polyPrices[i];
    
    // Only show row when price changes on either platform
    if (kPrice !== lastKPrice || pPrice !== lastPPrice) {
      const { cost } = contractCost(kPrice, pPrice);
      const edge = 1.0 - cost;
      
      cumKalshi += kPrice;
      cumPoly += pPrice;
      contractCount++;
      
      rows.push({
        level: i + 1,
        contractCount,
        kPrice,
        pPrice,
        cost,
        edge,
        cumKalshi,
        cumPoly,
        qtyAtThisPrice: 1, // Will be updated below
      });
      
      lastKPrice = kPrice;
      lastPPrice = pPrice;
    } else {
      // Same price as previous, just increment quantity
      if (rows.length > 0) {
        rows[rows.length - 1].qtyAtThisPrice++;
        cumKalshi += kPrice;
        cumPoly += pPrice;
        rows[rows.length - 1].cumKalshi = cumKalshi;
        rows[rows.length - 1].cumPoly = cumPoly;
      }
    }
  }

  return (
    <table className="w-full text-xs font-mono">
      <thead>
        <tr className="text-gray-600">
          <th className="text-right py-0.5">Contract #</th>
          <th className="text-right py-0.5">Qty</th>
          <th className="text-right py-0.5">K Price</th>
          <th className="text-right py-0.5">P Price</th>
          <th className="text-right py-0.5">Cost</th>
          <th className="text-right py-0.5">Edge</th>
          <th className="text-right py-0.5">K Cum</th>
          <th className="text-right py-0.5">P Cum</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.level} className="border-t border-gray-800/50">
            <td className="py-0.5 text-right text-gray-400">{r.level}</td>
            <td className="py-0.5 text-right text-gray-400">{r.qtyAtThisPrice}</td>
            <td className="py-0.5 text-right text-blue-400">{fmt(r.kPrice * 100, 1)}¢</td>
            <td className="py-0.5 text-right text-purple-400">{fmt(r.pPrice * 100, 1)}¢</td>
            <td className="py-0.5 text-right text-gray-300">{fmt(r.cost * 100, 2)}¢</td>
            <td className={`py-0.5 text-right ${
              r.edge > 0.02 ? "text-emerald-400" : r.edge > 0.005 ? "text-yellow-400" : "text-red-400"
            }`}>
              {fmt(r.edge * 100, 2)}¢
            </td>
            <td className="py-0.5 text-right text-blue-300">${fmtCompact(r.cumKalshi)}</td>
            <td className="py-0.5 text-right text-purple-300">${fmtCompact(r.cumPoly)}</td>
          </tr>
        ))}
        {cap < Math.min(kalshiPrices.length, polyPrices.length) && (
          <tr>
            <td colSpan={8} className="text-gray-600 text-center py-1">
              +{Math.min(kalshiPrices.length, polyPrices.length) - cap} more levels (beyond max arb size)
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(1) + "k";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "k";
  return n.toFixed(0);
}
