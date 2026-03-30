import { NextRequest, NextResponse } from "next/server";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  try {
    // First try as event_ticker to get sub-markets
    const eventRes = await fetch(
      `${KALSHI_BASE}/markets?event_ticker=${encodeURIComponent(ticker)}&limit=50`,
      { cache: "no-store" }
    );
    if (eventRes.ok) {
      const eventData = await eventRes.json();
      const markets = eventData.markets || [];
      if (markets.length > 1) {
        // Multiple sub-markets found — return them for selection
        return NextResponse.json({
          type: "event",
          eventTicker: ticker,
          markets: markets.map((m: Record<string, unknown>) => ({
            ticker: m.ticker as string,
            title: m.title as string,
            subtitle: m.subtitle as string,
            yes_bid: m.yes_bid as number,
            no_bid: m.no_bid as number,
            last_price: m.last_price as number,
            volume_24h: m.volume_24h as number,
            status: m.status as string,
          })),
        });
      }
      // Single market — treat as direct ticker
      if (markets.length === 1) {
        return NextResponse.json({
          type: "market",
          markets: [
            {
              ticker: markets[0].ticker as string,
              title: markets[0].title as string,
              subtitle: markets[0].subtitle as string,
              yes_bid: markets[0].yes_bid as number,
              no_bid: markets[0].no_bid as number,
              last_price: markets[0].last_price as number,
              status: markets[0].status as string,
            },
          ],
        });
      }
    }

    // Try as direct market ticker
    const mktRes = await fetch(
      `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`,
      { cache: "no-store" }
    );
    if (mktRes.ok) {
      const mktData = await mktRes.json();
      const m = mktData.market || mktData;
      return NextResponse.json({
        type: "market",
        markets: [
          {
            ticker: m.ticker,
            title: m.title,
            subtitle: m.subtitle,
            yes_bid: m.yes_bid,
            no_bid: m.no_bid,
            last_price: m.last_price,
            status: m.status,
          },
        ],
      });
    }

    return NextResponse.json(
      { error: `No markets found for "${ticker}". Try an event ticker like KXFEDDECISION-26MAR or a market ticker like KXBTCVSGOLD-26.` },
      { status: 404 }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
