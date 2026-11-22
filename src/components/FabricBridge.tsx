import { Activity, RefreshCw, Zap } from "lucide-react";
import type { FabricLink, FabricTelemetry, NodeSnapshot } from "../../shared/types";
import { formatBps, formatBytes } from "../utils/format";

interface FabricBridgeProps {
  spark0: NodeSnapshot;
  spark1: NodeSnapshot;
  fabric: FabricTelemetry;
  probing: boolean;
  onRunProbe: () => void;
}

function formatLinkSpeed(mbps: number | undefined): string {
  if (!mbps) return "--";
  return mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
}

function Endpoint({ node, side }: { node: NodeSnapshot; side: "left" | "right" }) {
  const address = (role: "lan" | "fabric-a" | "fabric-b") =>
    node.interfaces.find((i) => i.role === role);
  const lan = address("lan");
  const color = side === "left" ? "var(--spark0)" : "var(--spark1)";
  return (
    <div
      className="fabric-endpoint"
      style={
        side === "left"
          ? { borderLeft: `3px solid ${color}` }
          : { borderRight: `3px solid ${color}`, textAlign: "right" }
      }
    >
      <div className="display" style={{ fontSize: 13, fontWeight: 700, color }}>
        {node.label}
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)", marginTop: 4 }}>
        LAN {lan?.ip || "--"} · {formatLinkSpeed(lan?.speedMbps)}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 2 }}>
        LINK A {address("fabric-a")?.ip || "--"}
        <br />
        LINK B {address("fabric-b")?.ip || "--"}
      </div>
      <div className="mono" style={{ fontSize: 10.5, marginTop: 6, color: "var(--teal)" }}>
        HOST RTT: {node.hostRttMs != null ? `${node.hostRttMs} ms` : "--"}
      </div>
    </div>
  );
}

function Lane({ name, link, rttMs }: { name: string; link: FabricLink; rttMs: number | null | undefined }) {
  const active = link.state === "ACTIVE";
  const rate = link.spark0To1Bps + link.spark1To0Bps;
  const netdevs = [...new Set(link.netdevs.filter(Boolean))].join(" / ") || "not detected";
  return (
    <div className="fabric-lane">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="mono" style={{ fontSize: 11, fontWeight: 600 }}>
          <span style={{ color: active ? "var(--spark0)" : "var(--crimson)" }}>●</span> {name}{" "}
          <span style={{ color: "var(--fg-muted)" }}>({netdevs})</span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
          {link.subnet || "no address"} ·{" "}
          <strong style={{ color: "var(--fg-primary)" }}>
            {link.speedGbps > 0 ? `${link.speedGbps} GbE` : link.state}
          </strong>
          {rttMs != null && <span style={{ color: "var(--teal)", marginLeft: 8 }}>{rttMs} ms</span>}
        </div>
      </div>

      <div className="lane-track">
        {active && (
          <div
            className="lane-flow"
            style={{
              opacity: rate > 200_000 ? 0.95 : 0.25,
              animationDuration: rate > 50_000_000 ? "0.45s" : "1.6s",
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
          01 → 02: <strong style={{ color: "var(--spark0)" }}>{formatBps(link.spark0To1Bps)}</strong>
        </span>
        <span style={{ color: "var(--fg-muted)" }}>
          CUMULATIVE {formatBytes(link.totalBytesTransferred, 2)}
        </span>
        <span>
          02 → 01: <strong style={{ color: "var(--spark1)" }}>{formatBps(link.spark1To0Bps)}</strong>
        </span>
      </div>
    </div>
  );
}

export function FabricBridge({ spark0, spark1, fabric, probing, onRunProbe }: FabricBridgeProps) {
  const probe = fabric.lastProbe;
  const activeGbps = [fabric.linkA, fabric.linkB].reduce(
    (sum, link) => (link.state === "ACTIVE" ? sum + link.speedGbps : sum),
    0
  );

  return (
    <div className="fabric-panel">
      <div className="panel-header">
        <div className="panel-title">
          <Zap size={14} color="var(--spark0)" />
          NODE-TO-NODE FABRIC
          <span className="nav-badge mono" style={{ color: activeGbps > 0 ? "#bef264" : "#fca5a5" }}>
            {activeGbps > 0 ? `${activeGbps} GbE ACTIVE` : "NO ACTIVE LINKS"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
            LIVE FLOW:{" "}
            <strong style={{ color: "var(--fg-primary)" }}>
              {formatBps(fabric.combinedThroughputBps)}
            </strong>
          </span>
          <button type="button" className="btn btn-sm" onClick={onRunProbe} disabled={probing}>
            <RefreshCw size={12} className={probing ? "spin" : undefined} />
            {probing ? "PROBING..." : "PROBE FABRIC RTT"}
          </button>
        </div>
      </div>

      <div className="fabric-grid">
        <Endpoint node={spark0} side="left" />
        <div className="fabric-pipes">
          <Lane name="LINK A" link={fabric.linkA} rttMs={probe?.fabricAPingMs} />
          <Lane name="LINK B" link={fabric.linkB} rttMs={probe?.fabricBPingMs} />
        </div>
        <Endpoint node={spark1} side="right" />
      </div>

      {probe && (
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
            LINK A RTT: <strong style={{ color: "var(--fg-primary)" }}>{probe.fabricAPingMs ?? "--"} ms</strong>{" "}
            ({probe.fabricALossPct ?? "--"}% loss)
          </span>
          <span>
            LINK B RTT: <strong style={{ color: "var(--fg-primary)" }}>{probe.fabricBPingMs ?? "--"} ms</strong>{" "}
            ({probe.fabricBLossPct ?? "--"}% loss)
          </span>
          <span>
            LAN PEER RTT: <strong style={{ color: "var(--fg-primary)" }}>{probe.lanPingMs ?? "--"} ms</strong>
          </span>
          <span style={{ marginLeft: "auto", color: "var(--fg-muted)" }}>
            PROBED {new Date(probe.ts).toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
