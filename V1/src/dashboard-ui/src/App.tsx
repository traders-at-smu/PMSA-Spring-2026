import { useState } from "react";
import { Layout, type Tab } from "./components/Layout";
import { OverviewPanel } from "./components/OverviewPanel";
import { CrossPlatformPanel } from "./components/CrossPlatformPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { HoldingsPanel } from "./components/HoldingsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ArbScannerPanel } from "./components/ArbScannerPanel";

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [paused, setPaused] = useState(false);

  return (
    <Layout activeTab={tab} onTabChange={setTab} paused={paused} onTogglePause={() => setPaused(!paused)}>
      {tab === "overview" && <OverviewPanel paused={paused} />}
      {tab === "scanner" && <CrossPlatformPanel paused={paused} />}
      {tab === "execution" && <ExecutionPanel paused={paused} />}
      {tab === "holdings" && <HoldingsPanel paused={paused} />}
      {tab === "arb-scanner" && <ArbScannerPanel />}
      {tab === "settings" && <SettingsPanel />}
    </Layout>
  );
}
