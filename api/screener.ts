import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ArbitrageScreener } from "../src/screener";

const screener = new ArbitrageScreener();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  try {
    const data = await screener.getScreenerData();
    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
