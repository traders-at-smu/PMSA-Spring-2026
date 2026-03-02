import { useState } from "react";
import { Layout } from "./components/Layout";
import { TopTraders } from "./components/TopTraders";
import { TradeAlerts } from "./components/TradeAlerts";
import { ArbitragePanel } from "./components/ArbitragePanel";
import { KalshiPanel } from "./components/KalshiPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { CrossMarketPanel } from "./components/CrossMarketPanel";
import { RawDataPanel } from "./components/RawDataPanel";

type Tab = "traders" | "alerts" | "arbitrage" | "kalshi" | "cross" | "execution" | "raw";

export default function App() {
  const [tab, setTab] = useState<Tab>("traders");
  const [paused, setPaused] = useState(false);

  return (
    <Layout activeTab={tab} onTabChange={setTab} paused={paused} onTogglePause={() => setPaused(!paused)}>
      {tab === "traders" && <TopTraders />}
      {tab === "alerts" && <TradeAlerts paused={paused} />}
      {tab === "arbitrage" && <ArbitragePanel paused={paused} />}
      {tab === "kalshi" && <KalshiPanel paused={paused} />}
      {tab === "cross" && <CrossMarketPanel paused={paused} />}
      {tab === "execution" && <ExecutionPanel paused={paused} />}
      {tab === "raw" && <RawDataPanel paused={paused} />}
    </Layout>
  );
}
