import { NextRequest, NextResponse } from "next/server";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

interface RawMarket {
  question?: string;
  title?: string;
  conditionId?: string;
  slug?: string;
  tokens?: { token_id: string; outcome: string }[];
  clobTokenIds?: string;
  outcomes?: string;
  groupItemTitle?: string;
}

function extractTokens(market: RawMarket) {
  if (market.tokens && market.tokens.length > 0) return market.tokens;
  if (!market.clobTokenIds) return [];
  try {
    const ids = JSON.parse(market.clobTokenIds);
    const outcomes = JSON.parse(market.outcomes || "[]");
    return ids.map((id: string, i: number) => ({
      token_id: id,
      outcome: outcomes[i] || (i === 0 ? "Yes" : "No"),
    }));
  } catch {
    return [];
  }
}

function cleanSlug(raw: string): string {
  let s = raw.trim();
  // Handle full URLs: https://polymarket.com/event/slug or /event/slug
  const eventMatch = s.match(/polymarket\.com\/event\/([^/?#]+)/);
  if (eventMatch) s = eventMatch[1];
  // Strip path after slug (e.g. /event/slug/sub-slug)
  s = s.split("/").pop() || s;
  return s;
}

export async function GET(req: NextRequest) {
  const rawSlug = req.nextUrl.searchParams.get("slug");
  if (!rawSlug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  const slug = cleanSlug(rawSlug);

  try {
    // 1. Try as event slug first (events contain multiple markets)
    const eventRes = await fetch(
      `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`,
      { cache: "no-store" }
    );
    if (eventRes.ok) {
      const eventData = await eventRes.json();
      const events = Array.isArray(eventData) ? eventData : [eventData];
      if (events.length > 0 && events[0]) {
        const event = events[0];
        const markets: RawMarket[] = event.markets || [];
        if (markets.length > 0) {
          return NextResponse.json({
            type: "event",
            title: event.title || event.slug || slug,
            markets: markets.map((m: RawMarket) => ({
              question: m.question || m.groupItemTitle || "",
              conditionId: m.conditionId || "",
              slug: m.slug || "",
              tokens: extractTokens(m),
            })),
          });
        }
      }
    }

    // 2. Fall back to market slug
    const mktRes = await fetch(
      `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`,
      { cache: "no-store" }
    );
    if (mktRes.ok) {
      const mktData = await mktRes.json();
      const market: RawMarket | undefined = Array.isArray(mktData) ? mktData[0] : mktData;
      if (market) {
        return NextResponse.json({
          type: "market",
          title: market.question || market.title || "",
          markets: [
            {
              question: market.question || market.title || "",
              conditionId: market.conditionId || "",
              slug: market.slug || slug,
              tokens: extractTokens(market),
            },
          ],
        });
      }
    }

    return NextResponse.json({ error: "Not found. Try pasting the full Polymarket URL." }, { status: 404 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
