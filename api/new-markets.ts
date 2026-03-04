import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ArbitrageScreener } from "../src/screener";

const screener = new ArbitrageScreener();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");

  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const markets = await screener.findNewMarkets(limit);
    return res.status(200).json({ markets, timestamp: new Date().toISOString() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
