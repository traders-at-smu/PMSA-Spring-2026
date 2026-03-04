import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTraderProfile } from "../../src/services/traderService";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

  try {
    const address = req.query.address as string;
    const profile = await getTraderProfile(address);
    if (!profile) return res.status(404).json({ error: "Trader not found" });
    return res.status(200).json(profile);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
