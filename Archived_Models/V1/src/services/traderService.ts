import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getSettings } from "../runtimeSettings";
import { PythonModelClient } from "./pythonModelClient";

function parseCsv(filePath: string): Record<string, string>[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function asNum(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export class TraderService {
  private quoteProcess: ChildProcess | null = null;
  private quoteLogs: string[] = [];

  constructor(private modelClient: PythonModelClient) {}

  private getPaths() {
    const settings = getSettings();
    const scriptsDir = path.resolve(process.cwd(), settings.python.traderScriptsDir);
    return {
      pythonExecutable: settings.python.pythonExecutable,
      pollIntervalSec: settings.python.trader.pollIntervalSec,
      minPairs: settings.python.trader.minPairs,
      scriptsDir,
      buildPairs: path.join(scriptsDir, "build_pairs.py"),
      liveQuotes: path.join(scriptsDir, "live_quotes.py"),
      rawFilter: path.join(scriptsDir, "raw_boxed_filter.py"),
      pairsCsv: path.resolve(process.cwd(), "pairs.csv"),
      opportunitiesCsv: path.resolve(process.cwd(), "opportunities_raw.csv"),
      quotesCsv: path.resolve(process.cwd(), "python", "data", "live_quotes.csv"),
      sectionDJson: path.resolve(process.cwd(), "python", "data", "model_v1_section_d.json"),
    };
  }

  private runPython(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cfg = this.getPaths();
    return new Promise((resolve, reject) => {
      const child = spawn(cfg.pythonExecutable, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr || stdout || `exit ${code}`));
        resolve({ stdout, stderr });
      });
    });
  }

  async rebuildPairs() {
    const cfg = this.getPaths();
    return this.runPython([cfg.buildPairs, "--output", cfg.pairsCsv, "--min-pairs", String(cfg.minPairs)]);
  }

  async rebuildOpportunities() {
    const cfg = this.getPaths();
    const result = await this.runPython([
      cfg.rawFilter,
      "--pairs",
      cfg.pairsCsv,
      "--quotes",
      cfg.quotesCsv,
      "--out",
      cfg.opportunitiesCsv,
      "--section-d",
      path.resolve(process.cwd(), "python", "data", "model_v1_section_d_input.json"),
    ]);
    const top = await this.evaluateModelTop(3);
    fs.mkdirSync(path.dirname(cfg.sectionDJson), { recursive: true });
    fs.writeFileSync(
      cfg.sectionDJson,
      JSON.stringify({ generatedAt: new Date().toISOString(), count: top.length, top }, null, 2),
      "utf8"
    );
    return result;
  }

  startLiveQuotes() {
    const cfg = this.getPaths();
    if (this.quoteProcess && !this.quoteProcess.killed) {
      return { started: false, message: "live_quotes already running" };
    }

    const child = spawn(
      cfg.pythonExecutable,
      [
        cfg.liveQuotes,
        "--pairs",
        cfg.pairsCsv,
        "--out",
        cfg.quotesCsv,
        "--interval",
        String(cfg.pollIntervalSec),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );

    child.stdout.on("data", (d) => {
      this.quoteLogs = [`${new Date().toISOString()} ${d.toString().trim()}`, ...this.quoteLogs].slice(0, 100);
    });
    child.stderr.on("data", (d) => {
      this.quoteLogs = [`${new Date().toISOString()} ERR ${d.toString().trim()}`, ...this.quoteLogs].slice(0, 100);
    });
    child.on("close", () => {
      this.quoteProcess = null;
    });

    this.quoteProcess = child;
    return { started: true };
  }

  stopLiveQuotes() {
    if (!this.quoteProcess) return { stopped: false, message: "not running" };
    this.quoteProcess.kill();
    this.quoteProcess = null;
    return { stopped: true };
  }

  getLatestOpportunities(limit = 25) {
    const cfg = this.getPaths();
    return parseCsv(cfg.opportunitiesCsv).slice(0, limit);
  }

  async evaluateModelTop(limit = 3) {
    const rows = this.getLatestOpportunities(Math.max(1, limit));
    if (rows.length === 0) return [];
    const bankroll = getSettings().execution.bankrollUsd;

    const items = rows.slice(0, limit).map((row) => {
      let recentSnapshots: Array<{ timestamp: string; grossEdgePerDollar: number }> = [];
      try {
        const parsed = JSON.parse(row.recentSnapshotsJson || "[]");
        if (Array.isArray(parsed)) {
          recentSnapshots = parsed.map((s: any) => ({
            timestamp: String(s.timestamp || new Date().toISOString()),
            grossEdgePerDollar: asNum(s.grossEdgePerDollar),
          }));
        }
      } catch {
        recentSnapshots = [];
      }

      return {
        id: row.id || row.pair_id,
        opportunity_row: {
          id: row.id,
          venue: row.venue,
          strategy: row.strategy,
          market: row.market,
          yesAsk: asNum(row.yesAsk),
          noAsk: asNum(row.noAsk),
          bidDepth: asNum(row.bidDepth),
          askDepth: asNum(row.askDepth),
          liquidity: asNum(row.liquidity),
          profitPerDollar: asNum(row.profitPerDollar),
          numOutcomes: asNum(row.numOutcomes) || 2,
          sumAsks: asNum(row.best_cost || row.sumAsks),
        },
        lob_metrics: {
          topBookDepthUsd: asNum(row.topBookDepthUsd),
          depthWithinProfitableBandUsd: asNum(row.depthWithinProfitableBandUsd),
          edgePersistence: asNum(row.edgePersistence),
        },
        recent_snapshots: recentSnapshots,
      };
    });

    const decisions = await this.modelClient.evaluateBatch(items, bankroll);
    const byId = new Map(decisions.map((d) => [d.id, d.decision]));

    return rows.slice(0, limit).map((row) => ({
      ...row,
      modelDecision: byId.get(row.id || row.pair_id) || null,
    }));
  }

  getStatus() {
    const cfg = this.getPaths();
    const pairsRows = parseCsv(cfg.pairsCsv);
    const oppRows = parseCsv(cfg.opportunitiesCsv);

    return {
      running: Boolean(this.quoteProcess),
      pairsCount: pairsRows.length,
      opportunitiesCount: oppRows.length,
      files: {
        pairsCsv: cfg.pairsCsv,
        quotesCsv: cfg.quotesCsv,
        opportunitiesCsv: cfg.opportunitiesCsv,
        sectionDJson: cfg.sectionDJson,
      },
      logs: this.quoteLogs.slice(0, 10),
    };
  }
}
