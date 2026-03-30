import { spawn } from "child_process";
import path from "path";
import { getSettings } from "../runtimeSettings";

export interface ModelBatchItem {
  id: string;
  opportunity_row: Record<string, unknown>;
  lob_metrics: {
    topBookDepthUsd: number;
    depthWithinProfitableBandUsd: number;
    edgePersistence: number;
  };
  recent_snapshots: Array<{ timestamp: string; grossEdgePerDollar: number }>;
}

export interface ModelBatchDecision {
  id: string;
  decision: {
    expected_slippage: number;
    fill_prob_20s: number;
    expected_net_edge: number;
    recommended_cap: number;
  };
}

function runPythonWithJson(args: string[], payload: unknown): Promise<any> {
  const settings = getSettings();
  const exe = settings.python.pythonExecutable || "python";

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: path.resolve(process.cwd()),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Python exited ${code}: ${stderr || stdout}`));
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (err: any) {
        reject(new Error(`Invalid JSON from python bridge: ${err?.message || err}\n${stdout}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export class PythonModelClient {
  private lastInvocationAt: string | null = null;
  private lastInvocationError: string | null = null;

  getStatus() {
    return {
      modelEngine: "python:model_v1",
      lastInvocationAt: this.lastInvocationAt,
      lastInvocationError: this.lastInvocationError,
    };
  }

  async health() {
    const settings = getSettings();
    const bridgePath = path.resolve(process.cwd(), settings.python.modelBridgePath);
    try {
      const result = await runPythonWithJson([bridgePath], { items: [] });
      return {
        ok: Boolean(result?.ok),
        pythonExecutable: settings.python.pythonExecutable,
        bridgePath,
        error: result?.ok ? null : result?.error || "Unknown bridge error",
      };
    } catch (err: any) {
      return {
        ok: false,
        pythonExecutable: settings.python.pythonExecutable,
        bridgePath,
        error: err?.message || String(err),
      };
    }
  }

  async evaluateBatch(items: ModelBatchItem[], bankrollUsd: number): Promise<ModelBatchDecision[]> {
    const settings = getSettings();
    const bridgePath = path.resolve(process.cwd(), settings.python.modelBridgePath);

    const result = await runPythonWithJson([bridgePath], {
      bankroll_usd: bankrollUsd,
      items,
    });

    this.lastInvocationAt = new Date().toISOString();

    if (!result?.ok) {
      this.lastInvocationError = result?.error || "Bridge returned failure";
      throw new Error(this.lastInvocationError || "Bridge returned failure");
    }

    this.lastInvocationError = null;
    const rows = Array.isArray(result.results) ? result.results : [];
    return rows.map((r: any) => ({
      id: String(r.id ?? ""),
      decision: r.decision,
    }));
  }
}
