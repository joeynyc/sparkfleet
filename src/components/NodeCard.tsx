import type { HistoryPoint, NodeSnapshot } from "../../shared/types";
import { formatBps, formatBytes, formatDiskBps, formatUptime, tempColor } from "../utils/format";
import { Sparkline } from "./Sparkline";
import { Cpu, Fan, HardDrive, MemoryStick, Terminal, Thermometer } from "lucide-react";

interface NodeCardProps {
  node: NodeSnapshot;
  history: HistoryPoint[];
  onOpenTerminal: () => void;
  onInspectStorage: () => void;
}

export function NodeCard({
  node,
  history,
  onOpenTerminal,
  onInspectStorage,
}: NodeCardProps) {
  const memTotal = Math.max(1, node.memory.totalBytes);
  const gpuAllocPct = Math.min(100, (node.memory.gpuAllocatedBytes / memTotal) * 100);
  const sysUsedBytes = Math.max(0, node.memory.usedBytes - node.memory.gpuAllocatedBytes);
  const sysUsedPct = Math.min(100 - gpuAllocPct, (sysUsedBytes / memTotal) * 100);
  const cachePct = Math.min(
    100 - gpuAllocPct - sysUsedPct,
    (node.memory.cachedBytes / memTotal) * 100
  );

  const gpuUtilSeries = history.map((h) => h.gpuUtil);
  const gpuPowerSeries = history.map((h) => h.gpuPowerW);
  const lanIf = node.interfaces.find((i) => i.role === "lan");

  const tint =
    node.id === "spark-0" ? "rgba(118, 185, 0, 0.14)" : "rgba(56, 189, 248, 0.14)";

  return (
    <section
      className="node-card"
      style={{ ["--node-tint" as string]: tint }}
    >
      {/* Header */}
      <div className="node-card-header">
        <div>
          <div className="node-name">
            <span className={`pulse-dot ${node.connected ? "" : "offline"}`} style={node.connected ? { background: node.accent, boxShadow: `0 0 8px ${node.accent}` } : undefined} />
            {node.label}
            <span className="nav-badge mono" style={{ fontSize: 10 }}>
              {node.hostname}
            </span>
          </div>
          <div className="node-meta">
            {node.role} · UP {formatUptime(node.uptimeSec)} · LOAD{" "}
            {node.loadAvg.map((v) => v.toFixed(2)).join(" / ")}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button className="btn btn-sm" onClick={onOpenTerminal}>
            <Terminal size={12} /> SSH
          </button>
        </div>
      </div>

      {!node.connected && (
        <div
          className="mono"
          style={{
            padding: "10px 15px",
            background: "var(--crimson-dim)",
            borderBottom: "1px solid rgba(239,68,68,0.35)",
            color: "#fca5a5",
            fontSize: 11.5,
          }}
        >
          STREAM INTERRUPTED: {node.error}
        </div>
      )}

      <div className="node-body">
        {/* GB10 GPU Hero + Power Oscilloscope */}
        <div className="node-hero-grid">
          <div className="telemetry-box">
            <div className="telemetry-box-head">
              <span className="telemetry-box-label">
                {node.gpu.name} · SM UTILIZATION
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
                {node.gpu.pstate} · DRV {node.gpu.driver || "--"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
              <span className="big-readout" style={{ color: node.accent }}>
                {node.gpu.utilPct.toFixed(0)}%
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-secondary)" }}>
                {node.gpu.clockGrMhz.toFixed(0)} MHz
              </span>
              <span
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: 12,
                  fontWeight: 600,
                  color: tempColor(node.gpu.tempC),
                }}
              >
                {node.gpu.tempC.toFixed(0)}°C
              </span>
            </div>
            <Sparkline values={gpuUtilSeries} max={100} color={node.accent} height={54} unit="%" />
            <div className="sub-stats-row">
              <div>
                <div className="mini-stat-label">GPU ALLOC</div>
                <div className="mini-stat-val">
                  {formatBytes(node.memory.gpuAllocatedBytes, 1)}
                </div>
              </div>
              <div>
                <div className="mini-stat-label">T.LIMIT MARGIN</div>
                <div className="mini-stat-val">
                  {node.gpu.tLimitMarginC != null ? `+${node.gpu.tLimitMarginC}°C` : "--"}
                </div>
              </div>
              <div>
                <div className="mini-stat-label">COMPUTE PIDs</div>
                <div className="mini-stat-val">{node.gpu.processes.length}</div>
              </div>
            </div>
          </div>

          <div className="telemetry-box">
            <div className="telemetry-box-head">
              <span className="telemetry-box-label">BOARD POWER DRAW</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
                {node.fansRpm[0] + node.fansRpm[1] > 0
                  ? `FAN ${node.fansRpm[0]}/${node.fansRpm[1]} RPM`
                  : "FAN N/A"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span className="big-readout" style={{ color: "var(--amber)" }}>
                {node.gpu.powerW.toFixed(1)}
                <span style={{ fontSize: 14, marginLeft: 3 }}>W</span>
              </span>
            </div>
            <Sparkline values={gpuPowerSeries} max={65} color="#f59e0b" height={54} unit="W" />
            <div className="sub-stats-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <div className="mini-stat-label">LAN RX / TX</div>
                <div className="mini-stat-val" style={{ fontSize: 11 }}>
                  {formatBps(lanIf?.rxBps ?? 0)} / {formatBps(lanIf?.txBps ?? 0)}
                </div>
              </div>
              <div>
                <div className="mini-stat-label">NVME R / W</div>
                <div className="mini-stat-val" style={{ fontSize: 11 }}>
                  {formatDiskBps(node.disk.readBps)} / {formatDiskBps(node.disk.writeBps)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Unified 128GB UMA Memory Breakdown */}
        <div className="telemetry-box">
          <div className="telemetry-box-head">
            <span className="telemetry-box-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <MemoryStick size={12} /> 128GB LPDDR5X UNIFIED MEMORY (UMA)
            </span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              <strong>{formatBytes(node.memory.usedBytes, 1)}</strong> /{" "}
              {formatBytes(node.memory.totalBytes, 1)}{" "}
              <span style={{ color: "var(--fg-muted)" }}>
                ({formatBytes(node.memory.availableBytes, 1)} free)
              </span>
            </span>
          </div>

          <div className="seg-bar-track">
            <div
              className="seg-bar-fill"
              style={{ width: `${gpuAllocPct}%`, background: node.accent }}
              title={`GPU Compute: ${formatBytes(node.memory.gpuAllocatedBytes)}`}
            />
            <div
              className="seg-bar-fill"
              style={{ width: `${sysUsedPct}%`, background: "#f59e0b" }}
              title={`Host/Processes: ${formatBytes(sysUsedBytes)}`}
            />
            <div
              className="seg-bar-fill"
              style={{ width: `${cachePct}%`, background: "rgba(148,163,184,0.35)" }}
              title={`Page Cache: ${formatBytes(node.memory.cachedBytes)}`}
            />
          </div>

          <div className="legend-row">
            <span>
              <i className="legend-dot" style={{ background: node.accent }} />
              GPU Compute {formatBytes(node.memory.gpuAllocatedBytes, 1)}
            </span>
            <span>
              <i className="legend-dot" style={{ background: "#f59e0b" }} />
              Host Active {formatBytes(sysUsedBytes, 1)}
            </span>
            <span>
              <i className="legend-dot" style={{ background: "rgba(148,163,184,0.45)" }} />
              Page Cache {formatBytes(node.memory.cachedBytes, 1)}
            </span>
            {node.memory.swapUsedBytes > 0 && (
              <span style={{ color: "var(--amber)" }}>
                Swap {formatBytes(node.memory.swapUsedBytes, 1)}
              </span>
            )}
          </div>
        </div>

        {/* 20-Core Grace ARM CPU Matrix */}
        <div className="telemetry-box">
          <div className="telemetry-box-head">
            <span className="telemetry-box-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Cpu size={12} /> GRACE 20-CORE ARMv9 (10× X925 + 10× A725)
            </span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              <strong>{node.cpu.usagePct.toFixed(1)}%</strong>
              <span style={{ color: "var(--fg-muted)", marginLeft: 8 }}>
                IOWAIT {node.cpu.iowaitPct.toFixed(1)}%
              </span>
            </span>
          </div>

          <div className="core-matrix">
            {(node.cpu.perCorePct.length > 0 ? node.cpu.perCorePct : new Array(20).fill(0)).map(
              (pct, idx) => {
                const hot = pct > 75 ? "#ef4444" : pct > 40 ? "#f59e0b" : node.accent;
                return (
                  <div
                    key={idx}
                    className="core-cell"
                    title={`Core ${idx}: ${pct.toFixed(1)}% @ ${node.cpu.freqMhz[idx] ?? 0} MHz`}
                  >
                    <div className="core-bar-bg">
                      <div
                        className="core-bar-fill"
                        style={{ height: `${Math.max(4, Math.min(100, pct))}%`, background: hot }}
                      />
                    </div>
                    <span className="core-id">C{idx < 10 ? `0${idx}` : idx}</span>
                  </div>
                );
              }
            )}
          </div>
        </div>

        {/* Thermals + Fans + NVMe Storage Pressure */}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10 }}>
          <div className="telemetry-box">
            <div className="telemetry-box-head">
              <span className="telemetry-box-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Thermometer size={12} /> THERMAL SENSORS & ACOUSTICS
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
                <Fan size={11} />{" "}
                {node.fansRpm[0] + node.fansRpm[1] > 0
                  ? `${node.fansRpm[0]} / ${node.fansRpm[1]} RPM`
                  : "N/A"}
              </span>
            </div>
            <div className="thermal-grid">
              {node.thermals.slice(0, 6).map((t) => (
                <div key={t.label} className="thermal-pill">
                  <span style={{ color: "var(--fg-secondary)", fontSize: 10 }}>{t.label}</span>
                  <strong style={{ color: tempColor(t.tempC) }}>{t.tempC.toFixed(0)}°C</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="telemetry-box">
            <div className="telemetry-box-head">
              <span className="telemetry-box-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <HardDrive size={12} /> NVME STORAGE
              </span>
              <button className="btn btn-sm" onClick={onInspectStorage}>
                INSPECT
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span
                className="display"
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color:
                    node.disk.usedPct >= 95
                      ? "var(--crimson)"
                      : node.disk.usedPct >= 85
                        ? "var(--amber)"
                        : "var(--fg-primary)",
                }}
              >
                {node.disk.usedPct.toFixed(1)}%
              </span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
                {formatBytes(node.disk.availBytes, 1)} free
              </span>
            </div>
            <div className="seg-bar-track" style={{ height: 7 }}>
              <div
                className="seg-bar-fill"
                style={{
                  width: `${Math.min(100, node.disk.usedPct)}%`,
                  background:
                    node.disk.usedPct >= 95
                      ? "var(--crimson)"
                      : node.disk.usedPct >= 85
                        ? "var(--amber)"
                        : node.accent,
                }}
              />
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
              {formatBytes(node.disk.usedBytes, 2)} / {formatBytes(node.disk.totalBytes, 2)}
            </div>
          </div>
        </div>

        {/* Active GPU Compute Processes */}
        {node.gpu.processes.length > 0 && (
          <div className="telemetry-box" style={{ padding: "8px 11px" }}>
            <div className="telemetry-box-label" style={{ marginBottom: 5 }}>
              ACTIVE GPU COMPUTE WORKLOADS
            </div>
            {node.gpu.processes.map((p) => (
              <div
                key={p.pid}
                className="mono"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  fontSize: 11,
                  padding: "4px 0",
                  borderTop: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <span style={{ color: "var(--fg-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ color: node.accent }}>PID {p.pid}</span> · {p.cmdline || p.name}
                </span>
                <strong style={{ color: "#bef264", whiteSpace: "nowrap" }}>
                  {(p.memoryMiB / 1024).toFixed(1)} GiB
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
