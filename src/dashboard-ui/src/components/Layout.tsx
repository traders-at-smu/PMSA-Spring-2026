import { ReactNode, useEffect, useState } from "react";

type Tab = "traders" | "alerts" | "arbitrage" | "kalshi" | "execution";

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  paused: boolean;
  onTogglePause: () => void;
  children: ReactNode;
}

const tabs: { id: Tab; label: string }[] = [
  { id: "traders", label: "Top Traders" },
  { id: "alerts", label: "Smart Money Alerts" },
  { id: "arbitrage", label: "Arbitrage" },
  { id: "kalshi", label: "Kalshi" },
  { id: "execution", label: "Execution" },
];

export function Layout({ activeTab, onTabChange, paused, onTogglePause, children }: LayoutProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center font-bold text-sm">P</div>
            <h1 className="text-lg font-semibold tracking-tight">Polymarket Intelligence</h1>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={onTogglePause}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                paused
                  ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                  : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
              }`}
            >
              {paused ? "Paused" : "Live"}
            </button>
            <span className="text-xs text-zinc-500 font-mono">{now.toLocaleTimeString()}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-screen-2xl mx-auto px-6">
          <nav className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => onTabChange(t.id)}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
                  activeTab === t.id
                    ? "bg-zinc-800 text-white border-b-2 border-violet-500"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-screen-2xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
