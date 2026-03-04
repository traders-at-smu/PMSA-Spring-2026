import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getCopyTarget, setCopyTarget, clearCopyTarget } from "../src/services/copyTargetService";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    return res.status(200).json({ target: getCopyTarget() });
  }

  if (req.method === "POST") {
    const { address, name } = req.body || {};
    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "address is required" });
    }
    const target = setCopyTarget(address, name || "");
    return res.status(200).json({ target });
  }

  if (req.method === "DELETE") {
    clearCopyTarget();
    return res.status(200).json({ target: null });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
