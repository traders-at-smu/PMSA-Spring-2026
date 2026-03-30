import { NextRequest, NextResponse } from "next/server";

const CLOB_BASE = "https://clob.polymarket.com";

export async function GET(req: NextRequest) {
  const tokenId = req.nextUrl.searchParams.get("token_id");
  if (!tokenId) {
    return NextResponse.json({ error: "token_id required" }, { status: 400 });
  }

  try {
    const url = `${CLOB_BASE}/book?token_id=${tokenId}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Polymarket API ${res.status}: ${text}` },
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
