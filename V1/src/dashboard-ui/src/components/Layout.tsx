import { ReactNode, useState, useEffect } from "react";

export type Tab = "overview" | "scanner" | "execution" | "holdings" | "arb-scanner" | "settings";

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  paused: boolean;
  onTogglePause: () => void;
  children: ReactNode;
}

const tabs: { id: Tab; label: string; desc: string }[] = [
  { id: "overview", label: "Overview", desc: "Executive summary" },
  { id: "scanner", label: "Scanner", desc: "Cross-platform arb detection" },
  { id: "execution", label: "Execution", desc: "Trade plans & paper account" },
  { id: "holdings", label: "Holdings", desc: "Current open positions" },
  { id: "arb-scanner", label: "Arb Scanner", desc: "Manual depth-walking calculator" },
  { id: "settings", label: "Settings", desc: "Configuration" },
];

// Candlestick logo SVG matching pitch.html
function Logo() {
  return (
    <svg viewBox="0 0 60 28" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-6 w-auto">
      <rect x="4" y="8" width="3" height="12" rx="1" fill="#CC0035" />
      <line x1="5.5" y1="4" x2="5.5" y2="8" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="5.5" y1="20" x2="5.5" y2="24" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="14" y="4" width="3" height="16" rx="1" fill="#e4e4e7" />
      <line x1="15.5" y1="1" x2="15.5" y2="4" stroke="#e4e4e7" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="15.5" y1="20" x2="15.5" y2="26" stroke="#e4e4e7" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="24" y="10" width="3" height="8" rx="1" fill="#CC0035" />
      <line x1="25.5" y1="6" x2="25.5" y2="10" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="25.5" y1="18" x2="25.5" y2="22" stroke="#CC0035" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Layout({ activeTab, onTabChange, paused, onTogglePause, children }: LayoutProps) {
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen noise-bg">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#0a0a0f]/80 backdrop-blur-xl">
        <div className="max-w-screen-2xl mx-auto px-6">
          {/* Top bar */}
          <div className="flex items-center justify-between h-14">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <Logo />
              <div>
                <h1 className="text-[16px] font-serif tracking-tight text-zinc-100 leading-tight">
                  Traders<span className="text-[#CC0035]">@</span>SMU
                </h1>
                <p className="text-[9px] text-zinc-500 font-medium tracking-[0.12em] uppercase">
                  Prediction Market Spatial Arbitrage
                </p>
              </div>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-5">
              {/* Mode badge */}
              <div className="px-2.5 py-1 rounded-md bg-[#CC0035]/10 border border-[#CC0035]/20">
                <span className="text-[9px] font-bold tracking-[0.1em] uppercase text-[#CC0035]">
                  Paper Mode
                </span>
              </div>

              {/* Separator */}
              <div className="w-px h-5 bg-zinc-800" />

              {/* Status */}
              <button
                onClick={onTogglePause}
                className="flex items-center gap-2 group"
              >
                <div className="relative">
                  <div
                    className={`w-2 h-2 rounded-full transition-colors ${
                      paused ? "bg-amber-500" : "bg-emerald-400 status-live"
                    }`}
                  />
                </div>
                <span
                  className={`text-[10px] font-semibold tracking-[0.08em] transition-colors ${
                    paused
                      ? "text-amber-400/80 group-hover:text-amber-300"
                      : "text-emerald-400/80 group-hover:text-emerald-300"
                  }`}
                >
                  {paused ? "PAUSED" : "LIVE"}
                </span>
              </button>

              {/* Separator */}
              <div className="w-px h-5 bg-zinc-800" />

              {/* Clock */}
              <div className="text-[11px] text-zinc-500 font-mono tabular-nums tracking-tight">
                {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>

              {/* Spring 2026 */}
              <div className="text-[9px] text-zinc-600 tracking-[0.08em] uppercase font-medium">
                Spring 2026
              </div>
            </div>
          </div>

          {/* Tab nav */}
          <nav className="flex gap-1 -mb-px">
            {tabs.map((t) => {
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onTabChange(t.id)}
                  className={`relative px-5 py-2.5 text-[13px] font-medium rounded-t-lg transition-all duration-200 ${
                    isActive
                      ? "text-zinc-100 bg-white/[0.04]"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02]"
                  }`}
                >
                  {t.label}
                  {/* Active indicator — SMU red */}
                  {isActive && (
                    <div className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-[#CC0035]" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Separator */}
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-700/50 to-transparent" />
      </header>

      {/* ── Content ── */}
      <main className="max-w-screen-2xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
