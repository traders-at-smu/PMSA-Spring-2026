import { spawn } from "child_process";

const PORT = Number(process.env.SMOKE_DASHBOARD_PORT || "4567");
const BASE_URL = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOk(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs: number = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCmd, ["run", "dashboard:server"], {
    cwd: process.cwd(),
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DASHBOARD_BIND_HOST: "127.0.0.1",
      DASHBOARD_PORT: String(PORT),
    },
  });

  let combinedLogs = "";
  child.stdout.on("data", (buf) => {
    const s = buf.toString();
    combinedLogs += s;
  });
  child.stderr.on("data", (buf) => {
    const s = buf.toString();
    combinedLogs += s;
  });

  try {
    await waitForOk(`${BASE_URL}/api/health`, 60_000);

    const t0 = Date.now();
    const stateRes = await fetchWithTimeout(`${BASE_URL}/api/arbitrage/execution/state`, undefined, 5000);
    if (!stateRes.ok) throw new Error(`State endpoint failed: ${stateRes.status}`);
    const stateLatency = Date.now() - t0;
    if (stateLatency > 3000) {
      throw new Error(`State endpoint too slow: ${stateLatency}ms (>3000ms)`);
    }

    const refreshStart = Date.now();
    const refreshRes = await fetchWithTimeout(`${BASE_URL}/api/arbitrage/execution/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, 5000);
    if (!refreshRes.ok) throw new Error(`Refresh endpoint failed: ${refreshRes.status}`);
    const refreshLatency = Date.now() - refreshStart;
    if (refreshLatency > 2000) {
      throw new Error(`Refresh response too slow: ${refreshLatency}ms (>2000ms)`);
    }

    let sawRefreshing = false;
    const waitStart = Date.now();
    let finalState: any = null;
    while (Date.now() - waitStart < 20_000) {
      const state = await fetchWithTimeout(`${BASE_URL}/api/arbitrage/execution/state`, undefined, 8000).then((r) => r.json() as any);
      finalState = state;
      if (state.refreshing === true) sawRefreshing = true;
      if (state.refreshSeq >= 1) break;
      await sleep(1500);
    }

    if (!finalState || !Array.isArray(finalState.plans)) {
      throw new Error("Execution state missing plans array after refresh polling");
    }

    if (!sawRefreshing) {
      console.warn("Warning: did not observe refreshing=true; refresh may have completed very quickly.");
    }

    if (/Unhandled/i.test(combinedLogs)) {
      throw new Error("Detected unhandled error text in dashboard logs");
    }

    console.log("Smoke test passed");
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err.message || err);
  process.exit(1);
});
