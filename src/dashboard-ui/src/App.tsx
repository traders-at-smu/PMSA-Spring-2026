import { useState } from "react";
import { Layout } from "./components/Layout";
import { TopTraders } from "./components/TopTraders";
import { TradeAlerts } from "./components/TradeAlerts";
import { ArbitragePanel } from "./components/ArbitragePanel";
import { KalshiPanel } from "./components/KalshiPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";

type Tab = "traders" | "alerts" | "arbitrage" | "kalshi" | "execution";

export default function App() {
  const [tab, setTab] = useState<Tab>("traders");
  const [paused, setPaused] = useState(false);

  return (
    <Layout activeTab={tab} onTabChange={setTab} paused={paused} onTogglePause={() => setPaused(!paused)}>
      {tab === "traders" && <TopTraders />}
      {tab === "alerts" && <TradeAlerts paused={paused} />}
      {tab === "arbitrage" && <ArbitragePanel paused={paused} />}
      {tab === "kalshi" && <KalshiPanel paused={paused} />}
      {tab === "execution" && <ExecutionPanel paused={paused} />}
    </Layout>
  );
}
