import { Activity, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";
import type { FabricProbeResult, NodeSnapshot } from "../../shared/types";
import { errorMessage, postJson } from "../api";
import { formatBps, formatBytes } from "../utils/format";

interface FabricBridgeProps {
  nodes: NodeSnapshot[];
  probes: FabricProbeResult[];
}

function InterfacePanel({ node }: { node: NodeSnapshot }) {
  return (
    <section className="fabric-endpoint" style={{ borderLeftColor: node.accent }}>
      <div className="fabric-endpoint-head">
        <strong className="display" style={{ color: node.accent }}>{node.label}</strong>
        <span className="mono">{node.id} · {node.connected ? "ONLINE" : "OFFLINE"}</span>
        <span className="host-rtt">
          LAST HOST RTT · {node.hostRttMs !== null ? `${node.hostRttMs} ms` : "—"}
        </span>
      </div>
      {!node.connected ? (
        <p className="fabric-note">Node offline. No live interface data.</p>
      ) : node.interfaces.length === 0 ? (
        <p className="fabric-note">No interfaces reported.</p>
      ) : (
        <div className="interface-scroll">
          <table className="data-table interface-table" aria-label={`${node.label} network interfaces`}>
            <thead>
              <tr>
                <th>Interface</th>
                <th>Address / subnet</th>
                <th>Link</th>
                <th>RX / total</th>
                <th>TX / total</th>
              </tr>
            </thead>
            <tbody>
              {node.interfaces.map((nic) => (
                <tr key={nic.name}>
                  <th scope="row">
                    {nic.name}<small>{nic.role.toUpperCase()}</small>
                  </th>
                  <td>{nic.ip || "—"}<small>{nic.subnet || "No subnet"}</small></td>
                  <td>
                    {nic.operstate.toUpperCase()}
                    <small>{nic.speedMbps > 0 ? `${nic.speedMbps} Mbps` : "Speed unknown"}</small>
                  </td>
                  <td>{formatBps(nic.rxBps)}<small>{formatBytes(nic.rxBytes, 2)}</small></td>
                  <td>{formatBps(nic.txBps)}<small>{formatBytes(nic.txBytes, 2)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PeerProbe({ nodes, probes }: FabricBridgeProps) {
  const [source, setSource] = useState(nodes[0].id);
  const [target, setTarget] = useState(nodes[1].id);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<FabricProbeResult | null>(null);
  const cached = probes.find((p) => p.source === source && p.target === target);
  const result = response?.source === source && response.target === target && (!cached || response.ts > cached.ts)
    ? response : cached;

  async function runProbe() {
    setProbing(true);
    setError("");
    try {
      setResponse(await postJson<FabricProbeResult>("/api/fabric/probe", { source, target }));
    } catch (err) {
      setError(`Probe ${source} → ${target} failed: ${errorMessage(err)}`);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="probe-console">
      <div className="probe-controls">
        <strong className="panel-title"><Activity size={13} aria-hidden="true" /> PEER RTT</strong>
        <label>
          Source
          <select
            value={source}
            disabled={probing}
            onChange={(event) => {
              const next = event.target.value;
              if (next === target) setTarget(source);
              setSource(next);
              setError("");
            }}
          >
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.label} ({n.id})</option>)}
          </select>
        </label>
        <label>
          Target
          <select
            value={target}
            disabled={probing}
            onChange={(event) => { setTarget(event.target.value); setError(""); }}
          >
            {nodes.filter((n) => n.id !== source).map((n) => (
              <option key={n.id} value={n.id}>{n.label} ({n.id})</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={runProbe} disabled={probing}>
          <RefreshCw size={12} aria-hidden="true" className={probing ? "spin" : undefined} />
          {probing ? "PROBING…" : "PROBE RTT"}
        </button>
      </div>
      {error && <div className="notice-error" role="alert">{error}</div>}
      <div className="probe-result mono" aria-live="polite">
        {result ? (
          <>
            <strong>{result.source} → {result.target}</strong>
            <span>Source fabric A: {result.fabricAPingMs === null ? "No RTT" : `${result.fabricAPingMs} ms`}
              {result.fabricALossPct !== null && ` (${result.fabricALossPct}% loss)`}
            </span>
            <span>Source fabric B: {result.fabricBPingMs === null ? "No RTT" : `${result.fabricBPingMs} ms`}
              {result.fabricBLossPct !== null && ` (${result.fabricBLossPct}% loss)`}
            </span>
            <span>LAN: {result.lanPingMs === null ? "No RTT" : `${result.lanPingMs} ms`}</span>
            <span>Probed {new Date(result.ts).toLocaleString()}</span>
          </>
        ) : <span>No probe recorded for {source} → {target}.</span>}
      </div>
    </div>
  );
}

export function FabricBridge({ nodes, probes }: FabricBridgeProps) {
  return (
    <div className="fabric-panel">
      <div className="panel-header">
        <div className="panel-title"><Zap size={14} color="var(--spark0)" aria-hidden="true" /> NETWORK INTERFACES</div>
        <span className="nav-badge">NODE-LOCAL COUNTERS</span>
      </div>
      <div className="fleet-grid fabric-inventory">
        {nodes.map((node) => <InterfacePanel key={node.id} node={node} />)}
      </div>
      {nodes.length > 1
        ? <PeerProbe nodes={nodes} probes={probes} />
        : <p className="fabric-note">Peer RTT requires a second configured node. Host RTT is shown above.</p>}
    </div>
  );
}
