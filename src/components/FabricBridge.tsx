import type { FabricTelemetry, NodeSnapshot } from "../../shared/types";
import { formatBps, formatBytes } from "../utils/format";
import { Activity, RefreshCw, Zap } from "lucide-react";

interface FabricBridgeProps {
  spark0: NodeSnapshot;
  spark1: NodeSnapshot;
  fabric: FabricTelemetry;
  probing: boolean;
  onRunProbe: () => void;
}

export function FabricBridge({
  spark0,
  spark1,
  fabric,
  probing,
  onRunProbe,
}: FabricBridgeProps) {
  const renderLane = (
    name: string,
    hca: string,
    lane: FabricTelemetry["linkA"],
    rttMs: number | null | undefined
  ) => {
    const active = lane.state === "ACTIVE";
    const totalRate = lane.spark0To1Bps + lane.spark1To0Bps;
    return (
      <div className="fabric-lane">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div className="mono" style={{ fontSize: 11, fontWeight: 600 }}>
            <span style={{ color: active ? "var(--spark0)" : "var(--crimson)" }}>●</span>{" "}
            {name} <span style={{ color: "var(--fg-muted)" }}>({hca})</span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
            {lane.subnet} · <strong style={{ color: "var(--fg-primary)" }}>{lane.speedGbps} GbE</strong>
            {rttMs != null && (
              <span style={{ color: "var(--teal)", marginLeft: 8 }}>{rttMs} ms</span>
            )}
          </div>
        </div>

        <div className="lane-track">
          {active && (
            <div
              className="lane-flow"
              style={{
                opacity: totalRate > 200_000 ? 0.95 : 0.25,
                animationDuration: totalRate > 50_000_000 ? "0.45s" : "1.6s",
              }}
            />
          )}
        </div>

        <div
          className="mono"
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10.5,
            color: "var(--fg-secondary)",
          }}
        >
          <span>
            01 → 02: <strong style={{ color: "var(--spark0)" }}>{formatBps(lane.spark0To1Bps)}</strong>
          </span>
          <span style={{ color: "var(--fg-muted)" }}>
            CUMULATIVE {formatBytes(lane.totalBytesTransferred, 2)}
          </span>
          <span>
            02 → 01: <strong style={{ color: "var(--spark1)" }}>{formatBps(lane.spark1To0Bps)}</strong>
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="fabric-panel">
      <div className="panel-header">
        <div className="panel-title">
          <Zap size={14} color="var(--spark0)" />
          CONNECTX-7 DUAL 200GbE ROCE INTERCONNECT FABRIC
          <span className="nav-badge mono" style={{ color: "#bef264" }}>
            400 GbE AGGREGATE
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
            LIVE FLOW:{" "}
            <strong style={{ color: "var(--fg-primary)" }}>
              {formatBps(fabric.combinedThroughputBps)}
            </strong>
          </span>
          <button className="btn btn-sm" onClick={onRunProbe} disabled={probing}>
            <RefreshCw size={12} className={probing ? "spin" : ""} />
            {probing ? "PROBING..." : "PROBE FABRIC RTT"}
          </button>
        </div>
      </div>

      <div className="fabric-grid">
        {(() => {
          const s0Lan = spark0.interfaces.find((i) => i.role === "lan");
          const s0A = spark0.interfaces.find((i) => i.role === "fabric-a");
          const s0B = spark0.interfaces.find((i) => i.role === "fabric-b");
          const s1Lan = spark1.interfaces.find((i) => i.role === "lan");
          const s1A = spark1.interfaces.find((i) => i.role === "fabric-a");
          const s1B = spark1.interfaces.find((i) => i.role === "fabric-b");
          const fmtSpeed = (mbps?: number) =>
            mbps && mbps >= 1000 ? `${mbps / 1000}G` : mbps ? `${mbps}M` : "--";
          return (
            <>
              <div className="fabric-endpoint" style={{ borderLeft: "3px solid var(--spark0)" }}>
                <div className="display" style={{ fontSize: 13, fontWeight: 700, color: "var(--spark0)" }}>
                  {spark0.label}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)", marginTop: 4 }}>
                  LAN {s0Lan?.ip || spark0.hostname} · {fmtSpeed(s0Lan?.speedMbps)}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 2 }}>
                  ROCE-A {s0A?.ip || "--"}
                  <br />
                  ROCE-B {s0B?.ip || "--"}
                </div>
                <div className="mono" style={{ fontSize: 10.5, marginTop: 6, color: "var(--teal)" }}>
                  HOST RTT: {spark0.sshRttMs != null ? `${spark0.sshRttMs} ms` : "--"}
                </div>
              </div>

              <div className="fabric-pipes">
                {renderLane("LINK A · PRIMARY TENSOR", "rocep1s0f1 / enp1s0f1np1", fabric.linkA, fabric.lastProbe?.fabricAPingMs)}
                {renderLane("LINK B · SECONDARY MESH", "roceP2p1s0f1 / enP2p1s0f1np1", fabric.linkB, fabric.lastProbe?.fabricBPingMs)}
              </div>

              <div className="fabric-endpoint" style={{ borderRight: "3px solid var(--spark1)", textAlign: "right" }}>
                <div className="display" style={{ fontSize: 13, fontWeight: 700, color: "var(--spark1)" }}>
                  {spark1.label}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)", marginTop: 4 }}>
                  LAN {s1Lan?.ip || spark1.hostname} · {fmtSpeed(s1Lan?.speedMbps)}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 2 }}>
                  ROCE-A {s1A?.ip || "--"}
                  <br />
                  ROCE-B {s1B?.ip || "--"}
                </div>
                <div className="mono" style={{ fontSize: 10.5, marginTop: 6, color: "var(--teal)" }}>
                  HOST RTT: {spark1.sshRttMs != null ? `${spark1.sshRttMs} ms` : "--"}
                </div>
              </div>
            </>
          );
        })()}
      </div>

      {fabric.lastProbe && (
        <div
          className="mono"
          style={{
            padding: "7px 16px",
            borderTop: "1px solid var(--border-hair)",
            background: "rgba(0,0,0,0.22)",
            display: "flex",
            flexWrap: "wrap",
            gap: 18,
            fontSize: 10.5,
            color: "var(--fg-secondary)",
          }}
        >
          <span>
            <Activity size={11} style={{ verticalAlign: "-1px", marginRight: 5 }} />
            FABRIC-A RTT: <strong style={{ color: "var(--fg-primary)" }}>{fabric.lastProbe.fabricAPingMs ?? "--"} ms</strong>{" "}
            ({fabric.lastProbe.fabricALossPct ?? 0}% loss)
          </span>
          <span>
            FABRIC-B RTT: <strong style={{ color: "var(--fg-primary)" }}>{fabric.lastProbe.fabricBPingMs ?? "--"} ms</strong>{" "}
            ({fabric.lastProbe.fabricBLossPct ?? 0}% loss)
          </span>
          <span>
            LAN PEER RTT: <strong style={{ color: "var(--fg-primary)" }}>{fabric.lastProbe.lanPingMs ?? "--"} ms</strong>
          </span>
          <span style={{ marginLeft: "auto", color: "var(--fg-muted)" }}>
            PROBED {new Date(fabric.lastProbe.ts).toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
