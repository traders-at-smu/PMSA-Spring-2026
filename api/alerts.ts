import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTradeAlerts, getRecentLargeTrades, getAggregatedAlerts } from "../src/services/tradeAlertService";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

  try {
    const [alerts, recent, aggregated] = await Promise.all([
      getTradeAlerts(),
      getRecentLargeTrades(),
      getAggregatedAlerts(),
    ]);
    return res.status(200).json({ alerts, recent, aggregated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
