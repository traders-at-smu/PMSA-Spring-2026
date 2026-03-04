import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CrossPlatformScreener } from "../../src/crossPlatformScreener";

const screener = new CrossPlatformScreener();

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

  try {
    const results = await screener.getResults();
    return res.status(200).json({
      arbs: results.arbs,
      matchedPairs: results.matchedPairs,
      polymarketsScanned: results.polymarketsScanned,
      kalshiMarketsScanned: results.kalshiMarketsScanned,
      timestamp: results.timestamp,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
