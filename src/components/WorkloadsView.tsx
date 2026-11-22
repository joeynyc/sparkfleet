import { Box, FileText, Network, Play, RotateCw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NODE_IDS } from "../../shared/fleet-state";
import type { ExecResult, NodeId, NodeSnapshot } from "../../shared/types";
import { api, errorMessage, postJson } from "../api";
import { formatBytes } from "../utils/format";

interface WorkloadsViewProps {
  nodes: Record<NodeId, NodeSnapshot>;
}

type ContainerAction = "start" | "stop" | "restart";

interface LogDrawer {
  nodeId: NodeId;
  name: string;
  logs: string;
  loading: boolean;
}

const VISIBLE_PROCESSES = 7;
const VISIBLE_PORTS = 14;

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

export function WorkloadsView({ nodes }: WorkloadsViewProps) {
  const [filterNode, setFilterNode] = useState<NodeId | "all">("all");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logDrawer, setLogDrawer] = useState<LogDrawer | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const openDrawerKey = logDrawer && `${logDrawer.nodeId}/${logDrawer.name}`;

  // The drawer renders above the table; bring it into view when a row far down opens it.
  useEffect(() => {
    if (openDrawerKey) drawerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openDrawerKey]);

  const rows = NODE_IDS.filter((id) => filterNode === "all" || filterNode === id).flatMap((id) =>
    nodes[id].containers
      .filter((c) => !onlyRunning || c.state === "running")
      .map((container) => ({ node: nodes[id], container }))
  );

  const runAction = async (nodeId: NodeId, name: string, action: ContainerAction) => {
    setBusy(true);
    try {
      const res = await postJson<ExecResult>("/api/containers/action", { nodeId, name, action });
      // docker reports failures on stdout here (stderr is merged) with a non-zero exit.
      setActionError(
        res.exitCode === 0
          ? null
          : `docker ${action} ${name} on ${nodes[nodeId].label} failed: ${res.stdout.trim() || `exit ${res.exitCode}`}`
      );
    } catch (err) {
      setActionError(`docker ${action} ${name} on ${nodes[nodeId].label} failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openLogs = async (nodeId: NodeId, name: string) => {
    setLogDrawer({ nodeId, name, logs: "Fetching docker logs over SSH...", loading: true });
    try {
      const res = await api<{ logs: string; truncated: boolean }>(
        `/api/containers/logs?node=${nodeId}&name=${encodeURIComponent(name)}&tail=180`
      );
      const note = res.truncated ? "\n\n[output truncated]" : "";
      setLogDrawer({ nodeId, name, logs: (res.logs || "(no log output)") + note, loading: false });
    } catch (err) {
      setLogDrawer({ nodeId, name, logs: `Could not fetch logs: ${errorMessage(err)}`, loading: false });
    }
  };

  const filters: { id: NodeId | "all"; label: string }[] = [
    { id: "all", label: "BOTH NODES" },
    ...NODE_IDS.map((id) => ({ id, label: nodes[id].label })),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {actionError && (
        <div className="notice-error sticky-notice" role="alert">
          <span>{actionError}</span>
          <button type="button" className="btn btn-sm" onClick={() => setActionError(null)}>
            <X size={11} /> DISMISS
          </button>
        </div>
      )}

      {logDrawer && (
        <div
          ref={drawerRef}
          className="panel"
          style={{ borderColor: "var(--spark0)", scrollMarginTop: 66 }}
        >
          <div className="panel-header">
            <div className="panel-title">
              <FileText size={14} color="var(--spark0)" />
              CONTAINER LOGS · {nodes[logDrawer.nodeId].label} · {logDrawer.name}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openLogs(logDrawer.nodeId, logDrawer.name)}
                disabled={logDrawer.loading}
              >
                <RotateCw size={11} /> REFRESH
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setLogDrawer(null)}>
                <X size={11} /> CLOSE
              </button>
            </div>
          </div>
          <div className="panel-body">
            <pre className="log-pre">{logDrawer.logs}</pre>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Box size={14} color="var(--spark0)" />
            DOCKER CONTAINERS
            <span className="nav-badge mono">{rows.length}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {filters.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`btn btn-sm ${filterNode === f.id ? "btn-primary" : ""}`}
                onClick={() => setFilterNode(f.id)}
              >
                {f.label}
              </button>
            ))}
            <button
              type="button"
              className={`btn btn-sm ${onlyRunning ? "btn-primary" : ""}`}
              onClick={() => setOnlyRunning((v) => !v)}
            >
              RUNNING ONLY: {onlyRunning ? "ON" : "OFF"}
            </button>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>NODE</th>
                <th>CONTAINER</th>
                <th>IMAGE</th>
                <th>STATE</th>
                <th>STATUS</th>
                <th>PORTS</th>
                <th style={{ textAlign: "right" }}>CONTROL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, container: c }) => {
                const running = c.state === "running";
                return (
                  <tr key={`${node.id}-${c.id}`}>
                    <td>
                      <span style={{ color: node.accent, fontWeight: 600 }}>{node.label}</span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td style={{ color: "var(--fg-secondary)", maxWidth: 260, ...ellipsis }}>{c.image}</td>
                    <td>
                      <span className={`state-pill ${running ? "running" : "exited"}`}>{c.state}</span>
                    </td>
                    <td style={{ color: "var(--fg-secondary)" }}>{c.status}</td>
                    <td style={{ color: "var(--teal)", maxWidth: 220, ...ellipsis }}>{c.ports || "--"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: 5 }}>
                        <button type="button" className="btn btn-sm" onClick={() => openLogs(node.id, c.name)}>
                          <FileText size={11} /> LOGS
                        </button>
                        {running ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-sm"
                              title="Restart"
                              disabled={busy}
                              onClick={() => runAction(node.id, c.name, "restart")}
                            >
                              <RotateCw size={11} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              title="Stop"
                              disabled={busy}
                              onClick={() => runAction(node.id, c.name, "stop")}
                            >
                              <Square size={11} />
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => runAction(node.id, c.name, "start")}
                          >
                            <Play size={11} /> START
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--fg-muted)" }}>
                    No containers match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dual-grid">
        {NODE_IDS.map((id) => {
          const n = nodes[id];
          return (
            <div key={id} className="panel">
              <div className="panel-header">
                <div className="panel-title">
                  <Network size={14} color={n.accent} />
                  {n.label} · TOP MEMORY PROCESSES & PORTS
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  {n.ports.length} TCP LISTENERS
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>PROC</th>
                      <th>CPU%</th>
                      <th>RSS</th>
                      <th>COMMAND</th>
                    </tr>
                  </thead>
                  <tbody>
                    {n.topProcesses.slice(0, VISIBLE_PROCESSES).map((p) => (
                      <tr key={p.pid}>
                        <td style={{ color: n.accent }}>{p.pid}</td>
                        <td style={{ fontWeight: 600 }}>{p.comm}</td>
                        <td>{p.cpuPct.toFixed(1)}%</td>
                        <td>{formatBytes(p.rssBytes, 1)}</td>
                        <td style={{ color: "var(--fg-secondary)", maxWidth: 250, ...ellipsis }}>{p.args}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                style={{
                  padding: "10px 12px",
                  borderTop: "1px solid var(--border-hair)",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                {n.ports.slice(0, VISIBLE_PORTS).map((p) => (
                  <span
                    key={`${p.addr}:${p.port}`}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: "3px 7px",
                      background: "var(--bg-recess)",
                      border: "1px solid var(--border-hair)",
                      color: "var(--fg-secondary)",
                    }}
                  >
                    <strong style={{ color: "var(--fg-primary)" }}>:{p.port}</strong> {p.addr} ({p.process})
                  </span>
                ))}
                {n.ports.length > VISIBLE_PORTS && (
                  <span className="mono" style={{ fontSize: 10.5, padding: "3px 7px", color: "var(--fg-muted)" }}>
                    +{n.ports.length - VISIBLE_PORTS} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
