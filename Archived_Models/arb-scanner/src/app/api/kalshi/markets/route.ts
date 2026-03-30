import { NextRequest, NextResponse } from "next/server";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") || "";
  const status = req.nextUrl.searchParams.get("status") || "open";
  const limit = req.nextUrl.searchParams.get("limit") || "20";

  try {
    const params = new URLSearchParams({ status, limit });
    if (query) params.set("title", query);

    const url = `${KALSHI_BASE}/markets?${params.toString()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Kalshi API ${res.status}: ${text}` },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
