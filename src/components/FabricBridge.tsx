import { Activity, Network, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";
import { directionBps, type FabricLink, type FabricLinkEnd } from "../../shared/fabric-links";
import type { FabricProbeResult, NodeId, NodeSnapshot, ProbePath } from "../../shared/types";
import { errorMessage, postJson } from "../api";
import { formatBps, formatBytes, formatGbe } from "../utils/format";

interface FabricBridgeProps {
  nodes: NodeSnapshot[];
  links: FabricLink[];
  probes: FabricProbeResult[];
}

/** Below this a link carries only background chatter (ARP, LLDP) and its lane stays still. */
const FLOW_MIN_BPS = 1024;
const FLOW_FAST_BPS = 50_000_000;

const pairKey = (source: NodeId, target: NodeId) => `${source}>${target}`;

interface ProbeRunner {
  /** Server-held results plus this browser's own responses; the same pair may appear twice. */
  results: FabricProbeResult[];
  /** `pairKey` of the probe in flight. One runs at a time. */
  running: string | null;
  failure: { pair: string; message: string } | null;
  run: (source: NodeId, target: NodeId) => void;
}

function useProbes(probes: FabricProbeResult[]): ProbeRunner {
  // Shown at once instead of waiting for the next tick to echo them back.
  const [responses, setResponses] = useState<FabricProbeResult[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [failure, setFailure] = useState<ProbeRunner["failure"]>(null);

  async function run(source: NodeId, target: NodeId) {
    const pair = pairKey(source, target);
    setRunning(pair);
    setFailure(null);
    try {
      const result = await postJson<FabricProbeResult>("/api/fabric/probe", { source, target });
      setResponses((prev) => [...prev.filter((p) => pairKey(p.source, p.target) !== pair), result]);
    } catch (err) {
      setFailure({ pair, message: `Probe ${source} → ${target} failed: ${errorMessage(err)}` });
    } finally {
      setRunning(null);
    }
  }

  return { results: [...probes, ...responses], running, failure, run };
}

/** The newest fabric measurement on a subnet between two nodes, in either direction. */
function linkProbePath(results: FabricProbeResult[], subnet: string, a: NodeId, b: NodeId): ProbePath | undefined {
  let newest: { ts: number; path: ProbePath } | undefined;
  for (const result of results) {
    const between = (result.source === a && result.target === b) || (result.source === b && result.target === a);
    if (!between || (newest && result.ts <= newest.ts)) continue;
    const path = result.paths.find((p) => p.kind === "fabric" && p.subnet === subnet);
    if (path) newest = { ts: result.ts, path };
  }
  return newest?.path;
}

/** A missing round trip time means either silence (loss is known) or a ping that never ran. */
function rttText(path: ProbePath): string {
  if (path.rttMs !== null) return `${path.rttMs} ms`;
  return path.lossPct === null ? "PING COULD NOT RUN" : "NO REPLY";
}

function EndLabel({ end }: { end: FabricLinkEnd }) {
  return (
    <span className="lane-end">
      <strong className="display" style={{ color: end.node.accent }}>{end.node.label}</strong>
      {end.iface.name}
      {!end.up && (
        <span className="lane-fault">{end.node.connected ? end.iface.operstate.toUpperCase() : "OFFLINE"}</span>
      )}
    </span>
  );
}

function LinkMeta({ link }: { link: FabricLink }) {
  return (
    <span>
      {link.subnet} · {link.speedMbps > 0 ? formatGbe(link.speedMbps) : "SPEED N/A"} ·{" "}
      <strong className="link-state" data-state={link.state}>● {link.state}</strong>
    </span>
  );
}

function LaneTrack({ link, reverse = false }: { link: FabricLink; reverse?: boolean }) {
  const active = link.state === "ACTIVE";
  const flowing = active && link.flowBps >= FLOW_MIN_BPS;
  return (
    <div className="lane-track" aria-hidden="true">
      {active && (
        <div
          className={flowing ? "lane-flow flowing" : "lane-flow"}
          style={flowing ? {
            animationDuration: link.flowBps > FLOW_FAST_BPS ? "0.45s" : "1.6s",
            animationDirection: reverse ? "reverse" : "normal",
          } : undefined}
        />
      )}
    </div>
  );
}

/** A link between two different nodes: both directions, cumulative bytes, and its probed latency. */
function PairLane({ link, probes }: { link: FabricLink; probes: ProbeRunner }) {
  const [a, b] = link.ends;
  const aToB = directionBps(a, b);
  const bToA = directionBps(b, a);
  // Same rule as the rates: each direction is seen by a TX counter and by the peer's RX counter.
  const bytes = Math.max(a.iface.txBytes, b.iface.rxBytes) + Math.max(b.iface.txBytes, a.iface.rxBytes);
  const path = linkProbePath(probes.results, link.subnet, a.node.id, b.node.id);
  const pair = pairKey(a.node.id, b.node.id);
  const probing = probes.running === pair;

  return (
    <article
      className="fabric-lane"
      style={{ ["--lane-from" as string]: a.node.accent, ["--lane-to" as string]: b.node.accent }}
    >
      <div className="lane-row">
        <EndLabel end={a} />
        <LinkMeta link={link} />
        <EndLabel end={b} />
      </div>
      <LaneTrack link={link} reverse={bToA > aToB} />
      <div className="lane-row">
        <span>{a.node.label} → {b.node.label} <strong style={{ color: a.node.accent }}>{formatBps(aToB)}</strong></span>
        <span className="lane-probe">
          CUMULATIVE {formatBytes(bytes, 2)} · RTT{" "}
          {path
            ? <strong style={{ color: path.rttMs === null ? "var(--amber)" : "var(--teal)" }}>{rttText(path)}</strong>
            : "NOT PROBED"}
          <button
            type="button"
            className="btn btn-sm"
            disabled={probes.running !== null}
            aria-label={`Probe RTT from ${a.node.label} to ${b.node.label}`}
            onClick={() => probes.run(a.node.id, b.node.id)}
          >
            <RefreshCw size={11} aria-hidden="true" className={probing ? "spin" : undefined} />
            {probing ? "PROBING…" : "PROBE"}
          </button>
        </span>
        <span>{b.node.label} → {a.node.label} <strong style={{ color: b.node.accent }}>{formatBps(bToA)}</strong></span>
      </div>
      {probes.failure?.pair === pair && <div className="notice-error" role="alert">{probes.failure.message}</div>}
    </article>
  );
}

/** A shared segment of three or more ends, or a lone end: per-end counters, no direction to attribute. */
function EndsLane({ link }: { link: FabricLink }) {
  const lone = link.ends.length === 1;
  return (
    <article className="fabric-lane">
      <div className="lane-row">
        <strong className="display">{lone ? "UNPAIRED END" : `SHARED SEGMENT · ${link.ends.length} ENDS`}</strong>
        <LinkMeta link={link} />
      </div>
      {!lone && <LaneTrack link={link} />}
      <ul className="lane-ends">
        {link.ends.map((end) => (
          <li key={`${end.node.id}/${end.iface.name}`} className="lane-row">
            <EndLabel end={end} />
            {end.node.connected && (
              <span>
                TX <strong>{formatBps(end.iface.txBps)}</strong> · RX <strong>{formatBps(end.iface.rxBps)}</strong>
              </span>
            )}
          </li>
        ))}
      </ul>
      {lone && <span>The peer on this subnet is not in this fleet or is not reporting.</span>}
    </article>
  );
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

function PeerProbe({ nodes, probes }: { nodes: NodeSnapshot[]; probes: ProbeRunner }) {
  const [source, setSource] = useState(nodes[0].id);
  const [target, setTarget] = useState(nodes[1].id);
  const pair = pairKey(source, target);
  const busy = probes.running !== null;
  const probing = probes.running === pair;
  let result: FabricProbeResult | undefined;
  for (const p of probes.results) {
    if (p.source === source && p.target === target && (!result || p.ts > result.ts)) result = p;
  }

  return (
    <div className="probe-console">
      <div className="probe-controls">
        <strong className="panel-title"><Activity size={13} aria-hidden="true" /> PEER RTT</strong>
        <label>
          Source
          <select
            value={source}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              if (next === target) setTarget(source);
              setSource(next);
            }}
          >
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.label} ({n.id})</option>)}
          </select>
        </label>
        <label>
          Target
          <select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
            {nodes.filter((n) => n.id !== source).map((n) => (
              <option key={n.id} value={n.id}>{n.label} ({n.id})</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={() => probes.run(source, target)} disabled={busy}>
          <RefreshCw size={12} aria-hidden="true" className={probing ? "spin" : undefined} />
          {probing ? "PROBING…" : "PROBE RTT"}
        </button>
      </div>
      {probes.failure?.pair === pair && <div className="notice-error" role="alert">{probes.failure.message}</div>}
      <div className="probe-result mono" aria-live="polite">
        {!result ? (
          <span>No probe recorded for {source} → {target}.</span>
        ) : (
          <>
            <strong>{result.source} → {result.target}</strong>
            <span>Probed {new Date(result.ts).toLocaleString()}</span>
            {result.paths.length === 0 && (
              <span>
                No shared network to probe: the two nodes have no fabric subnet in common and no LAN address on both ends.
              </span>
            )}
          </>
        )}
      </div>
      {result && result.paths.length > 0 && (
        <div className="interface-scroll">
          <table className="data-table interface-table" aria-label={`Probed paths from ${source} to ${target}`}>
            <thead>
              <tr>
                <th>Path</th>
                <th>Interfaces</th>
                <th>Subnet</th>
                <th>RTT</th>
                <th>Loss</th>
              </tr>
            </thead>
            <tbody>
              {result.paths.map((path) => (
                <tr key={`${path.sourceIface}>${path.targetIface}`}>
                  <th scope="row">{path.kind.toUpperCase()}</th>
                  <td>{path.sourceIface} → {path.targetIface}</td>
                  <td>{path.subnet}</td>
                  <td style={path.rttMs === null ? { color: "var(--amber)" } : undefined}>{rttText(path)}</td>
                  <td>{path.lossPct === null ? "Not measured" : `${path.lossPct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function FabricBridge({ nodes, links, probes }: FabricBridgeProps) {
  const runner = useProbes(probes);
  return (
    <div className="fabric-panel">
      <div className="panel-header">
        <div className="panel-title"><Zap size={14} color="var(--spark0)" aria-hidden="true" /> FABRIC LINKS</div>
        <span className="nav-badge">ONE LANE PER FABRIC SUBNET</span>
      </div>
      {links.length === 0 ? (
        <p className="fabric-note">No fabric links: no node reports a fabric interface with an address.</p>
      ) : (
        <div className="fleet-grid fabric-inventory">
          {links.map((link) =>
            link.ends.length === 2 && link.ends[0].node !== link.ends[1].node
              ? <PairLane key={link.subnet} link={link} probes={runner} />
              : <EndsLane key={link.subnet} link={link} />
          )}
        </div>
      )}
      <div className="panel-header fabric-subhead">
        <div className="panel-title"><Network size={14} color="var(--spark1)" aria-hidden="true" /> NETWORK INTERFACES</div>
        <span className="nav-badge">NODE-LOCAL COUNTERS</span>
      </div>
      <div className="fleet-grid fabric-inventory">
        {nodes.map((node) => <InterfacePanel key={node.id} node={node} />)}
      </div>
      {nodes.length > 1
        ? <PeerProbe nodes={nodes} probes={runner} />
        : <p className="fabric-note">Peer RTT requires a second configured node. Host RTT is shown above.</p>}
    </div>
  );
}
