import {
  Activity,
  AlertTriangle,
  Box,
  Cpu,
  HardDrive,
  Laptop,
  LayoutDashboard,
  type LucideIcon,
  Terminal,
  X,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import type { HistoryPoint, NodeId } from "../shared/types";
import { api, errorMessage, postJson } from "./api";
import { FabricBridge } from "./components/FabricBridge";
import { NodeCard } from "./components/NodeCard";
import { DualTelemetryChart } from "./components/Sparkline";
import { WorkloadsView } from "./components/WorkloadsView";
import { useFleet } from "./useFleet";
import { formatBps, formatBytes } from "./utils/format";

// xterm.js is most of the bundle; fetch it only when the terminal tab opens.
const OpsTerminalView = lazy(() => import("./components/OpsTerminalView"));

type TabId = "overview" | "workloads" | "telemetry" | "ops";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Fleet Deck", icon: LayoutDashboard },
  { id: "workloads", label: "Workloads", icon: Box },
  { id: "telemetry", label: "Oscilloscopes", icon: Activity },
  { id: "ops", label: "Dual Terminal & Ops", icon: Terminal },
];

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

interface ChartSpec {
  title: string;
  unit: string;
  /** Lower bound for the top of the axis; the chart grows past it if the data does. */
  max?: number;
  colors?: [string, string];
  value: (point: HistoryPoint) => number;
}

function chartSpecs(memoryTotalGb: number): ChartSpec[] {
  return [
    { title: "GPU UTILIZATION (%)", unit: "%", max: 100, value: (p) => p.gpuUtil },
    { title: "GPU POWER DRAW (W)", unit: "W", max: 70, value: (p) => p.gpuPowerW },
    { title: "FABRIC THROUGHPUT (MB/s)", unit: " MB/s", value: (p) => p.fabricBps / MIB },
    {
      title: "GPU DIE TEMPERATURE (°C)",
      unit: "°C",
      max: 95,
      colors: ["#f59e0b", "#ef4444"],
      value: (p) => p.gpuTempC,
    },
    { title: "CPU UTILIZATION (%)", unit: "%", max: 100, value: (p) => p.cpuUtil },
    { title: "MEMORY IN USE (GB)", unit: " GB", max: memoryTotalGb, value: (p) => p.memUsedGb },
  ];
}

function Splash({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="panel" style={{ padding: "24px 30px", maxWidth: 480 }}>
        <div className="display" style={{ fontSize: 16, fontWeight: 700, color: "var(--spark0)" }}>
          {title}
        </div>
        <div className="mono" style={{ fontSize: 12, color: "var(--fg-secondary)", marginTop: 8 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

interface KpiProps {
  accent: string;
  label: string;
  tag?: ReactNode;
  value: ReactNode;
  sub: ReactNode;
}

function Kpi({ accent, label, tag, value, sub }: KpiProps) {
  return (
    <div className="kpi-tile" style={{ ["--tile-accent" as string]: accent }}>
      <div className="kpi-label">
        <span>{label}</span>
        {tag != null && <span>{tag}</span>}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

export function App() {
  const { fleet, status } = useFleet();
  const [tab, setTab] = useState<TabId>("overview");
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageAudit, setStorageAudit] = useState<{ nodeId: NodeId; output: string } | null>(null);

  if (status === "locked") {
    return (
      <Splash title="SPARKFLEET // LOCKED">
        This browser is not authorized. Open the access link printed in the terminal where the
        SparkFleet server is running, then reload.
      </Splash>
    );
  }
  if (!fleet) {
    return (
      <Splash title="SPARKFLEET // CONNECTING">
        Opening SSH telemetry channels to the configured nodes...
      </Splash>
    );
  }

  const runProbe = async () => {
    setProbing(true);
    try {
      await postJson("/api/fabric/probe");
      setError(null);
    } catch (err) {
      setError(`Fabric probe failed: ${errorMessage(err)}`);
    } finally {
      setProbing(false);
    }
  };

  const inspectStorage = async (nodeId: NodeId) => {
    setStorageAudit({ nodeId, output: "Scanning home directories and Docker disk usage over SSH..." });
    try {
      const res = await api<{ output: string; timedOut: boolean }>(`/api/storage/analyze?node=${nodeId}`);
      const note = res.timedOut ? "\n\n[scan timed out; results are partial]" : "";
      setStorageAudit({ nodeId, output: (res.output || "(no output)") + note });
    } catch (err) {
      setStorageAudit({ nodeId, output: `Scan failed: ${errorMessage(err)}` });
    }
  };

  const s0 = fleet.nodes["spark-0"];
  const s1 = fleet.nodes["spark-1"];
  const h0 = fleet.history["spark-0"];
  const h1 = fleet.history["spark-1"];
  const nodes = [s0, s1];

  const totalMemBytes = s0.memory.totalBytes + s1.memory.totalBytes;
  const usedMemBytes = s0.memory.usedBytes + s1.memory.usedBytes;
  const gpuAllocBytes = s0.memory.gpuAllocatedBytes + s1.memory.gpuAllocatedBytes;
  const gpuPowerW = s0.gpu.powerW + s1.gpu.powerW;
  const containers = nodes.flatMap((n) => n.containers);
  const runningContainers = containers.filter((c) => c.state === "running").length;
  const gpuProcesses = s0.gpu.processes.length + s1.gpu.processes.length;
  const activeFabricGbps = [fleet.fabric.linkA, fleet.fabric.linkB].reduce(
    (sum, link) => (link.state === "ACTIVE" ? sum + link.speedGbps : sum),
    0
  );
  const worstDiskPct = Math.max(s0.disk.usedPct, s1.disk.usedPct);
  const diskAccent =
    worstDiskPct >= 95 ? "var(--crimson)" : worstDiskPct >= 85 ? "var(--amber)" : "var(--fg-secondary)";

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-title">SPARKFLEET</div>
            <div className="brand-sub">DUAL DGX SPARK CLUSTER COCKPIT</div>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Primary views">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`nav-tab ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon size={13} /> {label}
              {id === "workloads" && <span className="nav-badge">{runningContainers}</span>}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div
            className="host-pill"
            title={`Control host: ${fleet.localHost.chip} · ${fleet.localHost.osVersion}`}
          >
            <Laptop size={12} color="var(--fg-muted)" />
            <span>{fleet.localHost.hostname}</span>
            <span style={{ color: "var(--fg-muted)" }}>|</span>
            <span>CPU {fleet.localHost.cpuUsagePct.toFixed(0)}%</span>
            <span>
              RAM {formatBytes(fleet.localHost.memUsedBytes, 1)}/
              {formatBytes(fleet.localHost.memTotalBytes, 0)}
            </span>
          </div>
          <div className="host-pill">
            <span className={`pulse-dot ${status === "live" ? "" : "offline"}`} />
            <span>{status === "live" ? "1Hz LIVE" : "RECONNECTING"}</span>
          </div>
        </div>
      </header>

      <main className="workspace">
        {error && (
          <div className="notice-error" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
              <X size={11} /> DISMISS
            </button>
          </div>
        )}

        {fleet.alerts.length > 0 && (
          <div className="alert-strip">
            {fleet.alerts.map((a) => (
              <div key={a.id} className={`alert-chip ${a.severity}`}>
                <div className="alert-chip-left">
                  <AlertTriangle
                    size={15}
                    color={a.severity === "critical" ? "#f87171" : "#fbbf24"}
                    style={{ flexShrink: 0 }}
                  />
                  <div>
                    <div className="display" style={{ fontSize: 11.5, fontWeight: 700 }}>
                      {a.title}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
                      {a.detail}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {a.kind === "disk" && (
                    <button type="button" className="btn btn-sm" onClick={() => inspectStorage(a.nodeId)}>
                      ANALYZE DISK
                    </button>
                  )}
                  <span
                    className="alert-metric"
                    style={{ color: a.severity === "critical" ? "#fca5a5" : "#fcd34d" }}
                  >
                    {a.metric}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <section className="summary-ribbon">
          <Kpi
            accent="var(--spark0)"
            label="CLUSTER GPU LOAD"
            tag={<Cpu size={12} />}
            value={`${((s0.gpu.utilPct + s1.gpu.utilPct) / 2).toFixed(1)}%`}
            sub={`S1 ${s0.gpu.utilPct.toFixed(0)}% · S2 ${s1.gpu.utilPct.toFixed(0)}%`}
          />
          <Kpi
            accent="var(--spark1)"
            label="UNIFIED MEMORY"
            tag={formatBytes(totalMemBytes, 0)}
            value={formatBytes(usedMemBytes, 1)}
            sub={`GPU ALLOC ${formatBytes(gpuAllocBytes, 1)}`}
          />
          <Kpi
            accent="var(--amber)"
            label="CLUSTER GPU POWER"
            value={`${gpuPowerW.toFixed(1)} W`}
            sub={`S1 ${s0.gpu.powerW.toFixed(1)}W (${s0.gpu.tempC.toFixed(0)}°C) · S2 ${s1.gpu.powerW.toFixed(1)}W (${s1.gpu.tempC.toFixed(0)}°C)`}
          />
          <Kpi
            accent="var(--teal)"
            label="FABRIC FLOW"
            tag={activeFabricGbps > 0 ? `${activeFabricGbps} GbE` : "DOWN"}
            value={formatBps(fleet.fabric.combinedThroughputBps)}
            sub={`A: ${fleet.fabric.linkA.state} · B: ${fleet.fabric.linkB.state}`}
          />
          <Kpi
            accent="#a78bfa"
            label="CONTAINERS"
            tag="DOCKER"
            value={
              <>
                {runningContainers}
                <span style={{ fontSize: 13, color: "var(--fg-muted)", marginLeft: 4 }}>
                  / {containers.length}
                </span>
              </>
            }
            sub={`${gpuProcesses} GPU ${gpuProcesses === 1 ? "PROCESS" : "PROCESSES"}`}
          />
          <Kpi
            accent={diskAccent}
            label="DISK HEADROOM"
            tag={<HardDrive size={12} />}
            value={formatBytes(s0.disk.availBytes + s1.disk.availBytes, 1)}
            sub={`S1 ${formatBytes(s0.disk.availBytes, 1)} · S2 ${formatBytes(s1.disk.availBytes, 1)} free`}
          />
        </section>

        {storageAudit && (
          <div className="panel" style={{ borderColor: "var(--amber)" }}>
            <div className="panel-header">
              <div className="panel-title">
                <HardDrive size={14} color="var(--amber)" />
                STORAGE INSPECTOR · {fleet.nodes[storageAudit.nodeId].label}
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setStorageAudit(null)}>
                <X size={11} /> CLOSE
              </button>
            </div>
            <div className="panel-body">
              <pre className="log-pre">{storageAudit.output}</pre>
            </div>
          </div>
        )}

        {tab === "overview" && (
          <>
            <FabricBridge
              spark0={s0}
              spark1={s1}
              fabric={fleet.fabric}
              probing={probing}
              onRunProbe={runProbe}
            />
            <div className="dual-grid">
              <NodeCard
                node={s0}
                history={h0}
                onOpenTerminal={() => setTab("ops")}
                onInspectStorage={() => inspectStorage("spark-0")}
              />
              <NodeCard
                node={s1}
                history={h1}
                onOpenTerminal={() => setTab("ops")}
                onInspectStorage={() => inspectStorage("spark-1")}
              />
            </div>
          </>
        )}

        {tab === "workloads" && <WorkloadsView nodes={fleet.nodes} />}

        {tab === "telemetry" && (
          <div className="dual-grid">
            {chartSpecs(Math.max(s0.memory.totalBytes, s1.memory.totalBytes) / GIB).map((chart) => (
              <div key={chart.title} className="panel">
                <div className="panel-header">
                  <div className="panel-title">{chart.title}</div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                    ROLLING {Math.max(h0.length, h1.length)}s
                  </span>
                </div>
                <div className="panel-body">
                  <DualTelemetryChart
                    seriesA={h0.map(chart.value)}
                    seriesB={h1.map(chart.value)}
                    labelA={s0.label}
                    labelB={s1.label}
                    colorA={chart.colors?.[0] ?? "#76b900"}
                    colorB={chart.colors?.[1] ?? "#38bdf8"}
                    max={chart.max}
                    unit={chart.unit}
                    height={180}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "ops" && (
          <Suspense fallback={<div className="panel panel-body mono">Loading terminals...</div>}>
            <OpsTerminalView nodes={fleet.nodes} />
          </Suspense>
        )}
      </main>
    </div>
  );
}
