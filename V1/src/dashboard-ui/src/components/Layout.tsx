import { ReactNode, useState, useEffect } from "react";

type Tab = "traders" | "alerts" | "arbitrage" | "kalshi" | "execution" | "new" | "cross";

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  paused: boolean;
  onTogglePause: () => void;
  children: ReactNode;
}

const tabs: { id: Tab; label: string; badge: string; accent: string }[] = [
  { id: "traders", label: "Top Traders", badge: "LB", accent: "from-emerald-400 to-emerald-600" },
  { id: "alerts", label: "Smart Money", badge: "SM", accent: "from-amber-400 to-orange-500" },
  { id: "arbitrage", label: "Polymarket", badge: "PM", accent: "from-violet-400 to-fuchsia-500" },
  { id: "kalshi", label: "Kalshi", badge: "KA", accent: "from-cyan-400 to-teal-500" },
  { id: "execution", label: "Execution", badge: "EX", accent: "from-rose-400 to-pink-500" },
  { id: "new", label: "New Markets", badge: "NW", accent: "from-lime-400 to-green-500" },
  { id: "cross", label: "Cross-Arb", badge: "XA", accent: "from-orange-400 to-amber-500" },
];

export function Layout({ activeTab, onTabChange, paused, onTogglePause, children }: LayoutProps) {
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const activeAccent = tabs.find((t) => t.id === activeTab)?.accent ?? "from-violet-400 to-fuchsia-500";

  return (
    <div className="min-h-screen noise-bg">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#0a0a0f]/80 backdrop-blur-xl">
        <div className="max-w-screen-2xl mx-auto px-6">
          {/* Top bar */}
          <div className="flex items-center justify-between h-14">
            {/* Brand */}
            <div className="flex items-center gap-3.5">
              <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${activeAccent} flex items-center justify-center font-bold text-[13px] text-white shadow-lg shadow-violet-500/20 transition-all duration-500`}>
                PM
              </div>
              <div>
                <h1 className="text-[15px] font-semibold tracking-tight text-zinc-100 leading-tight">
                  Polymarket Intelligence
                </h1>
                <p className="text-[10px] text-zinc-500 font-medium tracking-wide uppercase">
                  Market Screener & Trader Analytics
                </p>
              </div>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-5">
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
                  className={`text-xs font-medium tracking-wide transition-colors ${
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
              <div className="text-xs text-zinc-500 font-mono tabular-nums tracking-tight">
                {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
            </div>
          </div>

          {/* Tab nav */}
          <nav className="flex gap-0.5 -mb-px">
            {tabs.map((t) => {
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onTabChange(t.id)}
                  className={`relative px-4 py-2.5 flex items-center gap-2.5 text-[13px] font-medium rounded-t-lg transition-all duration-200 ${
                    isActive
                      ? "text-zinc-100 bg-white/[0.04]"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02]"
                  }`}
                >
                  {/* Badge */}
                  <span
                    className={`w-6 h-5 rounded-[5px] flex items-center justify-center text-[9px] font-bold tracking-widest transition-all duration-300 ${
                      isActive
                        ? `bg-gradient-to-br ${t.accent} text-white shadow-sm`
                        : "bg-zinc-800/80 text-zinc-500"
                    }`}
                  >
                    {t.badge}
                  </span>
                  {t.label}
                  {/* Active indicator line */}
                  {isActive && (
                    <div
                      className={`absolute bottom-0 left-3 right-3 h-[2px] rounded-full bg-gradient-to-r ${t.accent}`}
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Gradient separator */}
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-700/50 to-transparent" />
      </header>

      {/* ── Content ── */}
      <main className="max-w-screen-2xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
