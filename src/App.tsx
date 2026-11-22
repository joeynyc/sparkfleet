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
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { fabricLinks } from "../shared/fabric-links";
import type { FleetStatePayload, HistoryPoint, NodeId, NodeSnapshot } from "../shared/types";
import { api, errorMessage } from "./api";
import { FabricBridge } from "./components/FabricBridge";
import { NodeCard } from "./components/NodeCard";
import { TelemetryChart } from "./components/Sparkline";
import { WorkloadsView } from "./components/WorkloadsView";
import { type LinkStatus, useFleet } from "./useFleet";
import { formatBps, formatBytes, formatGbe } from "./utils/format";

// xterm.js is most of the bundle; fetch it only when the terminal tab opens.
const OpsTerminalView = lazy(() => import("./components/OpsTerminalView"));

type TabId = "overview" | "workloads" | "telemetry" | "ops";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "Fleet Deck", icon: LayoutDashboard },
  { id: "workloads", label: "Workloads", icon: Box },
  { id: "telemetry", label: "Oscilloscopes", icon: Activity },
  { id: "ops", label: "Terminal & Ops", icon: Terminal },
];

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

interface ChartSpec {
  title: string;
  unit: string;
  /** Lower bound for the top of the axis; the chart grows past it if the data does. */
  max?: number;
  value: (point: HistoryPoint) => number;
}

function chartSpecs(memoryTotalGiB: number): ChartSpec[] {
  return [
    { title: "GPU UTILIZATION (%)", unit: "%", max: 100, value: (p) => p.gpuUtil },
    { title: "GPU POWER DRAW (W)", unit: "W", max: 70, value: (p) => p.gpuPowerW },
    { title: "FABRIC RX + TX PER NODE (MiB/s)", unit: " MiB/s", value: (p) => p.fabricBps / MIB },
    {
      title: "GPU DIE TEMPERATURE (°C)",
      unit: "°C",
      max: 95,
      value: (p) => p.gpuTempC,
    },
    { title: "CPU UTILIZATION (%)", unit: "%", max: 100, value: (p) => p.cpuUtil },
    { title: "MEMORY IN USE (GiB)", unit: " GiB", max: memoryTotalGiB, value: (p) => p.memUsedGb },
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
  if (status === "locked") {
    return (
      <Splash title="SPARKPIT // LOCKED">
        This browser is not authorized. Open the access link printed in the terminal where the
        SparkPit server is running, then reload.
      </Splash>
    );
  }
  if (!fleet) {
    return (
      <Splash title="SPARKPIT // CONNECTING">
        Opening SSH telemetry channels to the configured nodes...
      </Splash>
    );
  }

  // A new inventory invalidates outstanding scans, probe choices, and open terminals.
  const inventory = JSON.stringify(Object.values(fleet.nodes).map((node) => [node.id, node.sshHost]));
  return <FleetDeck key={inventory} fleet={fleet} status={status} />;
}

function FleetDeck({ fleet, status }: { fleet: FleetStatePayload; status: LinkStatus }) {
  const [tab, setTab] = useState<TabId>("overview");
  const [terminalNodeId, setTerminalNodeId] = useState<NodeId>();
  const [storageAudit, setStorageAudit] = useState<{ nodeId: NodeId; output: string; pending: boolean } | null>(null);
  const inspector = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (storageAudit?.pending) inspector.current?.scrollIntoView({ block: "center" });
  }, [storageAudit]);

  const inspectStorage = async (nodeId: NodeId) => {
    const scan = { nodeId, output: "Scanning home directories and Docker disk usage over SSH…", pending: true };
    setStorageAudit(scan);
    let output: string;
    try {
      const res = await api<{ output: string; timedOut: boolean }>(`/api/storage/analyze?node=${nodeId}`);
      const note = res.timedOut ? "\n\n[scan timed out; results are partial]" : "";
      output = (res.output || "(no output)") + note;
    } catch (err) {
      output = `Scan failed: ${errorMessage(err)}`;
    }
    setStorageAudit((current) => current === scan ? { nodeId, output, pending: false } : current);
  };

  const nodes = Object.values(fleet.nodes);
  const online = nodes.filter((node) => node.connected);
  const hasData = online.length > 0;
  const coverage = `${online.length}/${nodes.length} NODES ONLINE`;
  const sum = (value: (node: NodeSnapshot) => number) =>
    online.reduce((total, node) => total + value(node), 0);
  const totalMemBytes = sum((n) => n.memory.totalBytes);
  const usedMemBytes = sum((n) => n.memory.usedBytes);
  const gpuAllocBytes = sum((n) => n.memory.gpuAllocatedBytes);
  const meanGpuUtil = hasData ? sum((n) => n.gpu.utilPct) / online.length : null;
  const gpuPowerW = sum((n) => n.gpu.powerW);
  const containerCount = sum((n) => n.containers.length);
  const runningContainers = sum((n) => n.containers.filter((c) => c.state === "running").length);
  const gpuProcesses = sum((n) => n.gpu.processes.length);
  const links = fabricLinks(nodes);
  const activeLinks = links.filter((link) => link.state === "ACTIVE");
  // An end with no peer in the fleet can never be active, so it is reported apart from the ratio.
  const unpairedEnds = links.filter((link) => link.state === "UNPAIRED").length;
  const fabricFlowBps = links.reduce((total, link) => total + link.flowBps, 0);
  const activeMbps = activeLinks.reduce((total, link) => total + link.speedMbps, 0);
  const freeDiskBytes = sum((n) => n.disk.availBytes);
  const worstDiskPct = Math.max(0, ...online.map((n) => n.disk.usedPct));
  const diskAccent =
    worstDiskPct >= 95 ? "var(--crimson)" : worstDiskPct >= 85 ? "var(--amber)" : "var(--fg-secondary)";

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-title">SPARKPIT</div>
            <div className="brand-sub">DGX SPARK FLEET COCKPIT</div>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Primary views">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`nav-tab ${tab === id ? "active" : ""}`}
              onClick={() => {
                // Arriving from the nav is not a request for one node's terminal.
                setTerminalNodeId(undefined);
                setTab(id);
              }}
            >
              <Icon size={13} /> {label}
              {id === "workloads" && <span className="nav-badge">{hasData ? runningContainers : "—"}</span>}
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
            <span className={`pulse-dot ${status === "live" && hasData ? "" : "offline"}`} />
            <span>{status === "live" ? `1Hz · ${coverage}` : "RECONNECTING · LAST SNAPSHOT"}</span>
          </div>
        </div>
      </header>

      <main className="workspace">
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
            value={meanGpuUtil === null ? "No data" : `${meanGpuUtil.toFixed(1)}%`}
            sub={`MEAN · ${coverage}`}
          />
          <Kpi
            accent="var(--spark1)"
            label="UNIFIED MEMORY"
            tag={hasData ? formatBytes(totalMemBytes, 0) : undefined}
            value={hasData ? formatBytes(usedMemBytes, 1) : "No data"}
            sub={hasData ? `GPU ALLOC ${formatBytes(gpuAllocBytes, 1)}` : coverage}
          />
          <Kpi
            accent="var(--amber)"
            label="CLUSTER GPU POWER"
            value={hasData ? `${gpuPowerW.toFixed(1)} W` : "No data"}
            sub={`SUM · ${coverage}`}
          />
          <Kpi
            accent="var(--teal)"
            label="FABRIC FLOW"
            tag={activeLinks.length ? formatGbe(activeMbps) : "NO LINKS"}
            value={hasData ? formatBps(fabricFlowBps) : "No data"}
            sub={hasData
              ? `${activeLinks.length}/${links.length - unpairedEnds} LINKS ACTIVE${unpairedEnds ? ` · ${unpairedEnds} UNPAIRED` : ""}`
              : coverage}
          />
          <Kpi
            accent="#a78bfa"
            label="CONTAINERS"
            tag="DOCKER"
            value={hasData ? (
              <>
                {runningContainers}
                <span style={{ fontSize: 13, color: "var(--fg-muted)", marginLeft: 4 }}>
                  / {containerCount}
                </span>
              </>
            ) : "No data"}
            sub={hasData ? `${gpuProcesses} GPU ${gpuProcesses === 1 ? "PROCESS" : "PROCESSES"}` : coverage}
          />
          <Kpi
            accent={diskAccent}
            label="DISK HEADROOM"
            tag={<HardDrive size={12} />}
            value={hasData ? formatBytes(freeDiskBytes, 1) : "No data"}
            sub={hasData ? `HIGHEST DISK USE ${worstDiskPct.toFixed(0)}%` : coverage}
          />
        </section>

        {storageAudit && (
          <div className="panel" ref={inspector} style={{ borderColor: "var(--amber)" }}>
            <div className="panel-header">
              <div className="panel-title">
                <HardDrive size={14} color="var(--amber)" />
                STORAGE INSPECTOR · {fleet.nodes[storageAudit.nodeId].label} ({storageAudit.nodeId})
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
            <FabricBridge nodes={nodes} links={links} probes={fleet.probes} />
            <div className="fleet-grid">
              {nodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  history={fleet.history[node.id] ?? []}
                  onOpenTerminal={() => {
                    setTerminalNodeId(node.id);
                    setTab("ops");
                  }}
                  onInspectStorage={() => inspectStorage(node.id)}
                />
              ))}
            </div>
          </>
        )}

        {tab === "workloads" && <WorkloadsView nodes={fleet.nodes} />}

        {tab === "telemetry" && (
          <div className="fleet-grid">
            {chartSpecs(Math.max(0, ...online.map((n) => n.memory.totalBytes)) / GIB).map((chart) => (
              <div key={chart.title} className="panel">
                <div className="panel-header">
                  <div className="panel-title">{chart.title}</div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                    1Hz HISTORY
                  </span>
                </div>
                <div className="panel-body">
                  <TelemetryChart
                    series={nodes.map((node) => ({
                      id: node.id,
                      label: node.label,
                      color: node.accent,
                      connected: node.connected,
                      points: fleet.history[node.id] ?? [],
                    }))}
                    value={chart.value}
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
            <OpsTerminalView nodes={fleet.nodes} initialNodeId={terminalNodeId} />
          </Suspense>
        )}
      </main>
    </div>
  );
}
