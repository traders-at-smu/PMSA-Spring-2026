import { useState, useEffect, useCallback } from "react";

const API = import.meta.env.VITE_API_URL || "";

interface Settings {
  dashboard: {
    port: number;
    bindHost: string;
    initialRefreshOnBoot: boolean;
    refreshIntervalMs: number;
  };
  execution: {
    mode: "PAPER" | "LIVE";
    autoExecute: boolean;
    bankrollUsd: number;
    maxTradeUsd: number;
    minNetEdge: number;
    minAnnualizedReturn: number;
    defaultLegTickSize: string;
    kalshiUseMakerFees: boolean;
  };
  apiKeys: {
    polymarket: {
      privateKey: string;
      proxyWalletAddress: string;
      rpcUrl: string;
    };
    kalshi: {
      apiUrl: string;
      tradingApiUrl: string;
      apiKey: string;
      apiSecret: string;
      apiPassphrase: string;
      bearerToken: string;
      orderEndpoint: string;
    };
  };
  externalApis: {
    gammaApiUrl: string;
    clobHttpUrl: string;
    dataApiUrl: string;
    kalshiApiUrl: string;
  };
  python: {
    pythonExecutable: string;
    modelBridgePath: string;
    miguelScriptsDir: string;
    miguel: {
      pollIntervalSec: number;
      minPairs: number;
    };
  };
}

type SectionKey = "execution" | "apiKeys" | "dashboard" | "python";

function GlassCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-5 ${className}`}>
      {children}
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-zinc-100 tracking-tight">{title}</h3>
      <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-white/[0.04] last:border-0">
      <label className="text-xs text-zinc-400 font-medium shrink-0">{label}</label>
      <div className="flex-1 max-w-xs">{children}</div>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors ${mono ? "font-mono" : ""}`}
    />
  );
}

function NumberInput({ value, onChange, min, step }: { value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      step={step}
      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors"
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-9 h-5 rounded-full transition-colors ${value ? "bg-emerald-500/80" : "bg-zinc-700"}`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${value ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

function SelectInput({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-zinc-900">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  const isMasked = value.includes("***");

  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || (isMasked ? "Enter new value to update" : "Not set")}
        className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 pr-8 text-xs text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors"
      />
      <button
        onClick={() => setShow(!show)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-[10px]"
      >
        {show ? "HIDE" : "SHOW"}
      </button>
    </div>
  );
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["execution"]));

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/settings`);
      const data = await res.json();
      setSettings(data);
    } catch (err: any) {
      setStatus({ type: "error", msg: "Failed to load settings" });
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateDraft = (path: string, value: any) => {
    setDraft((prev) => {
      const parts = path.split(".");
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
    setStatus(null);
  };

  const getValue = (path: string): any => {
    const parts = path.split(".");
    // Check draft first
    let draftVal: any = draft;
    let foundInDraft = true;
    for (const p of parts) {
      if (draftVal && typeof draftVal === "object" && p in draftVal) {
        draftVal = draftVal[p];
      } else {
        foundInDraft = false;
        break;
      }
    }
    if (foundInDraft) return draftVal;

    // Fallback to settings
    let val: any = settings;
    for (const p of parts) {
      if (val && typeof val === "object") val = val[p];
      else return undefined;
    }
    return val;
  };

  const hasPendingChanges = Object.keys(draft).length > 0;

  const handleSave = async () => {
    if (!hasPendingChanges) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`${API}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Save failed");
      }
      const data = await res.json();
      setSettings(data);
      setDraft({});
      setStatus({ type: "success", msg: "Settings saved. Restart server for some changes to take effect." });
    } catch (err: any) {
      setStatus({ type: "error", msg: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraft({});
    setStatus(null);
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-zinc-500">Loading settings...</div>
      </div>
    );
  }

  const sections: { key: string; title: string; desc: string; icon: string; accent: string }[] = [
    { key: "execution", title: "Execution", desc: "Trading mode, bankroll, and edge thresholds", icon: "EX", accent: "from-rose-400 to-pink-500" },
    { key: "apiKeys", title: "API Keys", desc: "Polymarket and Kalshi credentials", icon: "KY", accent: "from-amber-400 to-orange-500" },
    { key: "dashboard", title: "Dashboard", desc: "Server port, refresh intervals", icon: "DB", accent: "from-violet-400 to-fuchsia-500" },
    { key: "python", title: "Python / Model", desc: "Python executable and model bridge paths", icon: "PY", accent: "from-cyan-400 to-teal-500" },
    { key: "externalApis", title: "External APIs", desc: "API endpoint URLs", icon: "AP", accent: "from-lime-400 to-green-500" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 tracking-tight">Settings</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Configure execution parameters, API keys, and system settings</p>
        </div>
        <div className="flex items-center gap-2">
          {hasPendingChanges && (
            <>
              <span className="text-xs text-amber-400 font-medium mr-2">Unsaved changes</span>
              <button
                onClick={handleDiscard}
                className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-white/[0.04] border border-white/[0.08] rounded-lg transition-colors"
              >
                Discard
              </button>
            </>
          )}
          <button
            onClick={handleSave}
            disabled={!hasPendingChanges || saving}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
              hasPendingChanges
                ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/30"
                : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
            }`}
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Status message */}
      {status && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-xs font-medium ${
            status.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          }`}
        >
          {status.msg}
        </div>
      )}

      {/* Sections */}
      <div className="space-y-3">
        {sections.map((sec) => {
          const isExpanded = expandedSections.has(sec.key);
          return (
            <GlassCard key={sec.key} className="overflow-hidden">
              {/* Section header - clickable */}
              <button
                onClick={() => toggleSection(sec.key)}
                className="w-full flex items-center gap-3 -m-5 p-5 hover:bg-white/[0.02] transition-colors"
              >
                <span
                  className={`w-7 h-6 rounded-md flex items-center justify-center text-[9px] font-bold tracking-widest bg-gradient-to-br ${sec.accent} text-white`}
                >
                  {sec.icon}
                </span>
                <div className="text-left flex-1">
                  <div className="text-sm font-semibold text-zinc-100">{sec.title}</div>
                  <div className="text-[10px] text-zinc-500">{sec.desc}</div>
                </div>
                <svg
                  className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Section content */}
              {isExpanded && (
                <div className="mt-5 pt-4 border-t border-white/[0.06]">
                  {sec.key === "execution" && (
                    <>
                      <FieldRow label="Mode">
                        <SelectInput
                          value={getValue("execution.mode")}
                          onChange={(v) => updateDraft("execution.mode", v)}
                          options={[
                            { value: "PAPER", label: "PAPER - Simulated trading" },
                            { value: "LIVE", label: "LIVE - Real money" },
                          ]}
                        />
                      </FieldRow>
                      <FieldRow label="Auto Execute">
                        <div className="flex justify-end">
                          <Toggle
                            value={getValue("execution.autoExecute")}
                            onChange={(v) => updateDraft("execution.autoExecute", v)}
                          />
                        </div>
                      </FieldRow>
                      <FieldRow label="Bankroll (USD)">
                        <NumberInput
                          value={getValue("execution.bankrollUsd")}
                          onChange={(v) => updateDraft("execution.bankrollUsd", v)}
                          min={0}
                          step={100}
                        />
                      </FieldRow>
                      <FieldRow label="Max Trade Size (USD)">
                        <NumberInput
                          value={getValue("execution.maxTradeUsd")}
                          onChange={(v) => updateDraft("execution.maxTradeUsd", v)}
                          min={1}
                          step={10}
                        />
                      </FieldRow>
                      <FieldRow label="Min Net Edge">
                        <NumberInput
                          value={getValue("execution.minNetEdge")}
                          onChange={(v) => updateDraft("execution.minNetEdge", v)}
                          min={0}
                          step={0.001}
                        />
                      </FieldRow>
                      <FieldRow label="Min Ann. Return (0–1)">
                        <NumberInput
                          value={getValue("execution.minAnnualizedReturn")}
                          onChange={(v) => updateDraft("execution.minAnnualizedReturn", v)}
                          min={0}
                          step={0.05}
                        />
                      </FieldRow>
                      <FieldRow label="Default Leg Tick Size">
                        <TextInput
                          value={getValue("execution.defaultLegTickSize")}
                          onChange={(v) => updateDraft("execution.defaultLegTickSize", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Kalshi Use Maker Fees">
                        <div className="flex justify-end">
                          <Toggle
                            value={getValue("execution.kalshiUseMakerFees")}
                            onChange={(v) => updateDraft("execution.kalshiUseMakerFees", v)}
                          />
                        </div>
                      </FieldRow>
                    </>
                  )}

                  {sec.key === "apiKeys" && (
                    <>
                      <SectionHeader title="Polymarket" description="On-chain trading credentials" />
                      <FieldRow label="Private Key">
                        <SecretInput
                          value={getValue("apiKeys.polymarket.privateKey")}
                          onChange={(v) => updateDraft("apiKeys.polymarket.privateKey", v)}
                        />
                      </FieldRow>
                      <FieldRow label="Proxy Wallet Address">
                        <SecretInput
                          value={getValue("apiKeys.polymarket.proxyWalletAddress")}
                          onChange={(v) => updateDraft("apiKeys.polymarket.proxyWalletAddress", v)}
                        />
                      </FieldRow>
                      <FieldRow label="RPC URL">
                        <TextInput
                          value={getValue("apiKeys.polymarket.rpcUrl")}
                          onChange={(v) => updateDraft("apiKeys.polymarket.rpcUrl", v)}
                          placeholder="https://..."
                          mono
                        />
                      </FieldRow>

                      <div className="mt-5 pt-4 border-t border-white/[0.06]">
                        <SectionHeader title="Kalshi" description="REST API credentials" />
                      </div>
                      <FieldRow label="API URL">
                        <TextInput
                          value={getValue("apiKeys.kalshi.apiUrl")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.apiUrl", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Trading API URL">
                        <TextInput
                          value={getValue("apiKeys.kalshi.tradingApiUrl")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.tradingApiUrl", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="API Key">
                        <SecretInput
                          value={getValue("apiKeys.kalshi.apiKey")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.apiKey", v)}
                        />
                      </FieldRow>
                      <FieldRow label="API Secret">
                        <SecretInput
                          value={getValue("apiKeys.kalshi.apiSecret")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.apiSecret", v)}
                        />
                      </FieldRow>
                      <FieldRow label="API Passphrase">
                        <SecretInput
                          value={getValue("apiKeys.kalshi.apiPassphrase")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.apiPassphrase", v)}
                        />
                      </FieldRow>
                      <FieldRow label="Bearer Token">
                        <SecretInput
                          value={getValue("apiKeys.kalshi.bearerToken")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.bearerToken", v)}
                        />
                      </FieldRow>
                      <FieldRow label="Order Endpoint">
                        <TextInput
                          value={getValue("apiKeys.kalshi.orderEndpoint")}
                          onChange={(v) => updateDraft("apiKeys.kalshi.orderEndpoint", v)}
                          mono
                        />
                      </FieldRow>
                    </>
                  )}

                  {sec.key === "dashboard" && (
                    <>
                      <FieldRow label="Port">
                        <NumberInput
                          value={getValue("dashboard.port")}
                          onChange={(v) => updateDraft("dashboard.port", v)}
                          min={1}
                        />
                      </FieldRow>
                      <FieldRow label="Bind Host">
                        <TextInput
                          value={getValue("dashboard.bindHost")}
                          onChange={(v) => updateDraft("dashboard.bindHost", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Refresh on Boot">
                        <div className="flex justify-end">
                          <Toggle
                            value={getValue("dashboard.initialRefreshOnBoot")}
                            onChange={(v) => updateDraft("dashboard.initialRefreshOnBoot", v)}
                          />
                        </div>
                      </FieldRow>
                      <FieldRow label="Refresh Interval (ms)">
                        <NumberInput
                          value={getValue("dashboard.refreshIntervalMs")}
                          onChange={(v) => updateDraft("dashboard.refreshIntervalMs", v)}
                          min={5000}
                          step={1000}
                        />
                      </FieldRow>
                    </>
                  )}

                  {sec.key === "python" && (
                    <>
                      <FieldRow label="Python Executable">
                        <TextInput
                          value={getValue("python.pythonExecutable")}
                          onChange={(v) => updateDraft("python.pythonExecutable", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Model Bridge Path">
                        <TextInput
                          value={getValue("python.modelBridgePath")}
                          onChange={(v) => updateDraft("python.modelBridgePath", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Miguel Scripts Dir">
                        <TextInput
                          value={getValue("python.miguelScriptsDir")}
                          onChange={(v) => updateDraft("python.miguelScriptsDir", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Poll Interval (sec)">
                        <NumberInput
                          value={getValue("python.miguel.pollIntervalSec")}
                          onChange={(v) => updateDraft("python.miguel.pollIntervalSec", v)}
                          min={1}
                        />
                      </FieldRow>
                      <FieldRow label="Min Pairs">
                        <NumberInput
                          value={getValue("python.miguel.minPairs")}
                          onChange={(v) => updateDraft("python.miguel.minPairs", v)}
                          min={1}
                        />
                      </FieldRow>
                    </>
                  )}

                  {sec.key === "externalApis" && (
                    <>
                      <FieldRow label="Gamma API URL">
                        <TextInput
                          value={getValue("externalApis.gammaApiUrl")}
                          onChange={(v) => updateDraft("externalApis.gammaApiUrl", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="CLOB HTTP URL">
                        <TextInput
                          value={getValue("externalApis.clobHttpUrl")}
                          onChange={(v) => updateDraft("externalApis.clobHttpUrl", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Data API URL">
                        <TextInput
                          value={getValue("externalApis.dataApiUrl")}
                          onChange={(v) => updateDraft("externalApis.dataApiUrl", v)}
                          mono
                        />
                      </FieldRow>
                      <FieldRow label="Kalshi API URL">
                        <TextInput
                          value={getValue("externalApis.kalshiApiUrl")}
                          onChange={(v) => updateDraft("externalApis.kalshiApiUrl", v)}
                          mono
                        />
                      </FieldRow>
                    </>
                  )}
                </div>
              )}
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
}
