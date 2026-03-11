import { useState } from "react";
import { Layout, type Tab } from "./components/Layout";
import { OverviewPanel } from "./components/OverviewPanel";
import { CrossPlatformPanel } from "./components/CrossPlatformPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { SettingsPanel } from "./components/SettingsPanel";

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [paused, setPaused] = useState(false);

  return (
    <Layout activeTab={tab} onTabChange={setTab} paused={paused} onTogglePause={() => setPaused(!paused)}>
      {/* Keep OverviewPanel mounted so it doesn't re-boot on every tab switch */}
      <div style={{ display: tab === "overview" ? undefined : "none" }}>
        <OverviewPanel paused={paused || tab !== "overview"} />
      </div>
      {tab === "scanner" && <CrossPlatformPanel paused={paused} />}
      {tab === "execution" && <ExecutionPanel paused={paused} />}
      {tab === "settings" && <SettingsPanel />}
    </Layout>
  );
}
