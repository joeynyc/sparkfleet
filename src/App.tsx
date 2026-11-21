import { useEffect, useState } from "react";
import type { FleetStatePayload, NodeId } from "../shared/types";
import { formatBps, formatBytes } from "./utils/format";
import { FabricBridge } from "./components/FabricBridge";
import { NodeCard } from "./components/NodeCard";
import { DualTelemetryChart } from "./components/Sparkline";
import { WorkloadsView } from "./components/WorkloadsView";
import { OpsTerminalView } from "./components/OpsTerminalView";
import {
  Activity,
  AlertTriangle,
  Box,
  Cpu,
  HardDrive,
  Laptop,
  LayoutDashboard,
  Terminal,
  X,
} from "lucide-react";

type TabId = "overview" | "workloads" | "telemetry" | "ops";

export function App() {
  const [fleet, setFleet] = useState<FleetStatePayload | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const [probing, setProbing] = useState(false);
  const [storageAudit, setStorageAudit] = useState<{
    nodeId: NodeId;
    loading: boolean;
    output: string;
  } | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryTimer: number | undefined;
    let alive = true;

    const connect = () => {
      if (!alive) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws/telemetry`);
      ws.onopen = () => setWsConnected(true);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as {
            type: string;
            payload?: FleetStatePayload;
          };
          if (msg.type === "fleet_state" && msg.payload) {
            setFleet(msg.payload);
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (alive) retryTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      alive = false;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  const handleRunProbe = async () => {
    setProbing(true);
    try {
      await fetch("/api/fabric/probe", { method: "POST" });
    } finally {
      setProbing(false);
    }
  };

  const handleInspectStorage = async (nodeId: NodeId) => {
    setStorageAudit({
      nodeId,
      loading: true,
      output: "Scanning top directories & Docker disk usage over SSH...",
    });
    try {
      const res = await fetch(`/api/storage/analyze?node=${nodeId}`);
      const data = (await res.json()) as { output?: string; error?: string };
      setStorageAudit({
        nodeId,
        loading: false,
        output: data.output || data.error || "(no output)",
      });
    } catch (err) {
      setStorageAudit({
        nodeId,
        loading: false,
        output: String(err),
      });
    }
  };

  if (!fleet) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <div className="panel" style={{ padding: "24px 30px", maxWidth: 460 }}>
          <div className="display" style={{ fontSize: 16, fontWeight: 700, color: "var(--spark0)" }}>
            SPARKFLEET // INITIALIZING TELEMETRY BUS
          </div>
          <div className="mono" style={{ fontSize: 12, color: "var(--fg-secondary)", marginTop: 8 }}>
            Establishing persistent SSH telemetry channels to configured DGX Spark nodes...
          </div>
        </div>
      </div>
    );
  }

  const s0 = fleet.nodes["spark-0"];
  const s1 = fleet.nodes["spark-1"];
  const h0 = fleet.history["spark-0"] ?? [];
  const h1 = fleet.history["spark-1"] ?? [];

  const totalMemBytes = s0.memory.totalBytes + s1.memory.totalBytes;
  const usedMemBytes = s0.memory.usedBytes + s1.memory.usedBytes;
  const totalGpuAllocBytes = s0.memory.gpuAllocatedBytes + s1.memory.gpuAllocatedBytes;
  const combinedPowerW = s0.gpu.powerW + s1.gpu.powerW;
  const avgGpuUtil = (s0.gpu.utilPct + s1.gpu.utilPct) / 2;
  const runningContainers =
    s0.containers.filter((c) => c.state === "running").length +
    s1.containers.filter((c) => c.state === "running").length;
  const totalContainers = s0.containers.length + s1.containers.length;

  return (
    <div>
      {/* Top Command Rail */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-title">SPARKFLEET</div>
            <div className="brand-sub">DUAL NVIDIA DGX SPARK · GB10 + 400GbE CLUSTER COCKPIT</div>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Primary Views">
          <button
            className={`nav-tab ${tab === "overview" ? "active" : ""}`}
            onClick={() => setTab("overview")}
          >
            <LayoutDashboard size={13} /> Fleet Deck
          </button>
          <button
            className={`nav-tab ${tab === "workloads" ? "active" : ""}`}
            onClick={() => setTab("workloads")}
          >
            <Box size={13} /> Workloads
            <span className="nav-badge">{runningContainers}</span>
          </button>
          <button
            className={`nav-tab ${tab === "telemetry" ? "active" : ""}`}
            onClick={() => setTab("telemetry")}
          >
            <Activity size={13} /> Oscilloscopes
          </button>
          <button
            className={`nav-tab ${tab === "ops" ? "active" : ""}`}
            onClick={() => setTab("ops")}
          >
            <Terminal size={13} /> Dual Terminal &amp; Ops
          </button>
        </nav>

        <div className="topbar-right">
          <div className="host-pill" title={`Local Control Host: ${fleet.localHost.chip} · ${fleet.localHost.osVersion}`}>
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
            <span className={`pulse-dot ${wsConnected ? "" : "offline"}`} />
            <span>{wsConnected ? "1Hz LIVE" : "RECONNECTING"}</span>
          </div>
        </div>
      </header>

      <main className="workspace">
        {/* Live Alerts Strip */}
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
                  {a.id.includes("disk") && a.nodeId !== "cluster" && (
                    <button
                      className="btn btn-sm"
                      onClick={() => handleInspectStorage(a.nodeId as NodeId)}
                    >
                      ANALYZE DISK
                    </button>
                  )}
                  <span
                    className="alert-metric"
                    style={{
                      color: a.severity === "critical" ? "#fca5a5" : "#fcd34d",
                    }}
                  >
                    {a.metric}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Cluster-Wide KPI Ribbon */}
        <section className="summary-ribbon">
          <div className="kpi-tile" style={{ ["--tile-accent" as string]: "var(--spark0)" }}>
            <div className="kpi-label">
              <span>CLUSTER GB10 COMPUTE</span>
              <Cpu size={12} />
            </div>
            <div className="kpi-value">{avgGpuUtil.toFixed(1)}%</div>
            <div className="kpi-sub">
              S1 {s0.gpu.utilPct.toFixed(0)}% · S2 {s1.gpu.utilPct.toFixed(0)}% · 2× BLACKWELL
            </div>
          </div>

          <div className="kpi-tile" style={{ ["--tile-accent" as string]: "var(--spark1)" }}>
            <div className="kpi-label">
              <span>UNIFIED UMA POOL</span>
              <span>256 GB</span>
            </div>
            <div className="kpi-value">{formatBytes(usedMemBytes, 1)}</div>
            <div className="kpi-sub">
              GPU ALLOC {formatBytes(totalGpuAllocBytes, 1)} / {formatBytes(totalMemBytes, 0)}
            </div>
          </div>

          <div className="kpi-tile" style={{ ["--tile-accent" as string]: "var(--amber)" }}>
            <div className="kpi-label">
              <span>CLUSTER BOARD POWER</span>
              <span>DUAL GB10</span>
            </div>
            <div className="kpi-value">{combinedPowerW.toFixed(1)} W</div>
            <div className="kpi-sub">
              S1 {s0.gpu.powerW.toFixed(1)}W ({s0.gpu.tempC.toFixed(0)}°C) · S2 {s1.gpu.powerW.toFixed(1)}W ({s1.gpu.tempC.toFixed(0)}°C)
            </div>
          </div>

          <div className="kpi-tile" style={{ ["--tile-accent" as string]: "var(--teal)" }}>
            <div className="kpi-label">
              <span>ROCE FABRIC FLOW</span>
              <span>400 GbE</span>
            </div>
            <div className="kpi-value">{formatBps(fleet.fabric.combinedThroughputBps)}</div>
            <div className="kpi-sub">
              A: {fleet.fabric.linkA.state} · B: {fleet.fabric.linkB.state}
            </div>
          </div>

          <div className="kpi-tile" style={{ ["--tile-accent" as string]: "#a78bfa" }}>
            <div className="kpi-label">
              <span>WORKLOAD CONTAINERS</span>
              <span>DOCKER</span>
            </div>
            <div className="kpi-value">
              {runningContainers}
              <span style={{ fontSize: 13, color: "var(--fg-muted)", marginLeft: 4 }}>
                / {totalContainers}
              </span>
            </div>
            <div className="kpi-sub">
              TP2 RANK0+RANK1 · {s0.gpu.processes.length + s1.gpu.processes.length} GPU PIDs
            </div>
          </div>

          <div className="kpi-tile" style={{ ["--tile-accent" as string]: s1.disk.usedPct >= 95 ? "var(--crimson)" : "var(--fg-secondary)" }}>
            <div className="kpi-label">
              <span>NVME HEADROOM</span>
              <HardDrive size={12} />
            </div>
            <div className="kpi-value">
              {formatBytes(s0.disk.availBytes + s1.disk.availBytes, 1)}
            </div>
            <div className="kpi-sub">
              S1 {formatBytes(s0.disk.availBytes, 1)} · S2 {formatBytes(s1.disk.availBytes, 1)} free
            </div>
          </div>
        </section>

        {/* Storage Audit Drawer (triggered from NodeCard or Alert Strip) */}
        {storageAudit && (
          <div className="panel" style={{ borderColor: "var(--amber)" }}>
            <div className="panel-header">
              <div className="panel-title">
                <HardDrive size={14} color="var(--amber)" />
                NVME STORAGE INSPECTOR · {fleet.nodes[storageAudit.nodeId].label}
              </div>
              <button className="btn btn-sm" onClick={() => setStorageAudit(null)}>
                <X size={11} /> CLOSE
              </button>
            </div>
            <div className="panel-body">
              <pre className="log-pre">{storageAudit.output}</pre>
            </div>
          </div>
        )}

        {/* Active View */}
        {tab === "overview" && (
          <>
            <FabricBridge
              spark0={s0}
              spark1={s1}
              fabric={fleet.fabric}
              probing={probing}
              onRunProbe={handleRunProbe}
            />

            <div className="dual-grid">
              <NodeCard
                node={s0}
                history={h0}
                onOpenTerminal={() => setTab("ops")}
                onInspectStorage={() => handleInspectStorage("spark-0")}
              />
              <NodeCard
                node={s1}
                history={h1}
                onOpenTerminal={() => setTab("ops")}
                onInspectStorage={() => handleInspectStorage("spark-1")}
              />
            </div>
          </>
        )}

        {tab === "workloads" && <WorkloadsView nodes={fleet.nodes} />}

        {tab === "telemetry" && (
          <div className="dual-grid">
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">GB10 SM UTILIZATION COMPARISON (%)</div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  ROLLING {Math.max(h0.length, h1.length)}s
                </span>
              </div>
              <div className="panel-body">
                <DualTelemetryChart
                  seriesA={h0.map((p) => p.gpuUtil)}
                  seriesB={h1.map((p) => p.gpuUtil)}
                  labelA={s0.label}
                  labelB={s1.label}
                  colorA="#76b900"
                  colorB="#38bdf8"
                  max={100}
                  unit="%"
                  height={180}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">GPU BOARD POWER DRAW (WATTS)</div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  COMBINED {combinedPowerW.toFixed(1)}W
                </span>
              </div>
              <div className="panel-body">
                <DualTelemetryChart
                  seriesA={h0.map((p) => p.gpuPowerW)}
                  seriesB={h1.map((p) => p.gpuPowerW)}
                  labelA="SPARK-01 W"
                  labelB="SPARK-02 W"
                  colorA="#76b900"
                  colorB="#38bdf8"
                  max={70}
                  unit="W"
                  height={180}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">CONNECTX-7 FABRIC THROUGHPUT (MB/s)</div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  DUAL 200GbE ROCE
                </span>
              </div>
              <div className="panel-body">
                <DualTelemetryChart
                  seriesA={h0.map((p) => (p.fabricRxBps + p.fabricTxBps) / 1024 ** 2)}
                  seriesB={h1.map((p) => (p.fabricRxBps + p.fabricTxBps) / 1024 ** 2)}
                  labelA="SPARK-01 RX+TX"
                  labelB="SPARK-02 RX+TX"
                  colorA="#76b900"
                  colorB="#38bdf8"
                  unit=" MB/s"
                  height={180}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">THERMALS &amp; GRAPHICS CLOCKS</div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  GB10 DIE °C
                </span>
              </div>
              <div className="panel-body">
                <DualTelemetryChart
                  seriesA={h0.map((p) => p.gpuTempC)}
                  seriesB={h1.map((p) => p.gpuTempC)}
                  labelA="SPARK-01 °C"
                  labelB="SPARK-02 °C"
                  colorA="#f59e0b"
                  colorB="#ef4444"
                  max={95}
                  unit="°C"
                  height={180}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">GRACE 20-CORE CPU UTILIZATION (%)</div>
              </div>
              <div className="panel-body">
                <DualTelemetryChart
                  seriesA={h0.map((p) => p.cpuUtil)}
                  seriesB={h1.map((p) => p.cpuUtil)}
                  labelA="SPARK-01 CPU"
                  labelB="SPARK-02 CPU"
                  colorA="#76b900"
                  colorB="#38bdf8"
                  max={100}
                  unit="%"
                  height={180}
                />
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">UNIFIED MEMORY USAGE (GB / 128 GB)</div>
              </div>
              <div className="panel-body">
                <DualTelemetryChart
                  seriesA={h0.map((p) => p.memUsedGb)}
                  seriesB={h1.map((p) => p.memUsedGb)}
                  labelA="SPARK-01 GB"
                  labelB="SPARK-02 GB"
                  colorA="#76b900"
                  colorB="#38bdf8"
                  max={128}
                  unit="G"
                  height={180}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "ops" && <OpsTerminalView nodes={fleet.nodes} />}
      </main>
    </div>
  );
}
