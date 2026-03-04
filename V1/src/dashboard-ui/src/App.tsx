import { useState } from "react";
import { Layout, type Tab } from "./components/Layout";
import { OverviewPanel } from "./components/OverviewPanel";
import { CrossPlatformPanel } from "./components/CrossPlatformPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { SettingsPanel } from "./components/SettingsPanel";

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [paused, setPaused] = useState(false);

  return (
    <Layout activeTab={tab} onTabChange={setTab} paused={paused} onTogglePause={() => setPaused(!paused)}>
      {tab === "overview" && <OverviewPanel paused={paused} />}
      {tab === "scanner" && <CrossPlatformPanel paused={paused} />}
      {tab === "execution" && <ExecutionPanel paused={paused} />}
      {tab === "analytics" && <AnalyticsPanel paused={paused} />}
      {tab === "settings" && <SettingsPanel />}
    </Layout>
  );
}
