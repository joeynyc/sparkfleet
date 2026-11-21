import { useState } from "react";
import type { ContainerInfo, NodeId, NodeSnapshot } from "../../shared/types";
import { formatBytes } from "../utils/format";
import { Box, FileText, Network, Play, RotateCw, Square, X } from "lucide-react";

interface WorkloadsViewProps {
  nodes: Record<NodeId, NodeSnapshot>;
}

export function WorkloadsView({ nodes }: WorkloadsViewProps) {
  const [filterNode, setFilterNode] = useState<NodeId | "all">("all");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [logModal, setLogModal] = useState<{
    nodeId: NodeId;
    name: string;
    logs: string;
    loading: boolean;
  } | null>(null);

  const allContainers: Array<{ nodeId: NodeId; nodeLabel: string; accent: string; c: ContainerInfo }> = [];
  (["spark-0", "spark-1"] as NodeId[]).forEach((id) => {
    if (filterNode !== "all" && filterNode !== id) return;
    const n = nodes[id];
    for (const c of n.containers) {
      if (onlyRunning && c.state !== "running") continue;
      allContainers.push({ nodeId: id, nodeLabel: n.label, accent: n.accent, c });
    }
  });

  const runAction = async (nodeId: NodeId, name: string, action: "start" | "stop" | "restart") => {
    const key = `${nodeId}:${name}:${action}`;
    setBusyKey(key);
    try {
      await fetch("/api/containers/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, name, action }),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const openLogs = async (nodeId: NodeId, name: string) => {
    setLogModal({ nodeId, name, logs: "Streaming docker logs over SSH...", loading: true });
    try {
      const res = await fetch(
        `/api/containers/logs?node=${encodeURIComponent(nodeId)}&name=${encodeURIComponent(name)}&tail=180`
      );
      const data = (await res.json()) as { logs?: string; error?: string };
      setLogModal({
        nodeId,
        name,
        logs: data.logs || data.error || "(no log output)",
        loading: false,
      });
    } catch (err) {
      setLogModal({
        nodeId,
        name,
        logs: String(err),
        loading: false,
      });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Log Viewer Drawer (opens right above table for immediate visibility) */}
      {logModal && (
        <div className="panel" style={{ borderColor: "var(--spark0)" }}>
          <div className="panel-header">
            <div className="panel-title">
              <FileText size={14} color="var(--spark0)" />
              CONTAINER LOGS · {nodes[logModal.nodeId].label} · {logModal.name}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-sm"
                onClick={() => openLogs(logModal.nodeId, logModal.name)}
                disabled={logModal.loading}
              >
                <RotateCw size={11} /> REFRESH
              </button>
              <button className="btn btn-sm" onClick={() => setLogModal(null)}>
                <X size={11} /> CLOSE
              </button>
            </div>
          </div>
          <div className="panel-body">
            <pre className="log-pre">{logModal.logs}</pre>
          </div>
        </div>
      )}

      {/* Docker Containers Panel */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Box size={14} color="var(--spark0)" />
            FLEET DOCKER CONTAINERS
            <span className="nav-badge mono">{allContainers.length}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className={`btn btn-sm ${filterNode === "all" ? "btn-primary" : ""}`}
              onClick={() => setFilterNode("all")}
            >
              BOTH SPARKS
            </button>
            <button
              className={`btn btn-sm ${filterNode === "spark-0" ? "btn-primary" : ""}`}
              onClick={() => setFilterNode("spark-0")}
            >
              SPARK-01
            </button>
            <button
              className={`btn btn-sm ${filterNode === "spark-1" ? "btn-primary" : ""}`}
              onClick={() => setFilterNode("spark-1")}
            >
              SPARK-02
            </button>
            <button
              className={`btn btn-sm ${onlyRunning ? "btn-primary" : ""}`}
              onClick={() => setOnlyRunning((v) => !v)}
            >
              {onlyRunning ? "RUNNING ONLY: ON" : "RUNNING ONLY: OFF"}
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
              {allContainers.map(({ nodeId, nodeLabel, accent, c }) => {
                const running = c.state === "running";
                return (
                  <tr key={`${nodeId}-${c.id}`}>
                    <td>
                      <span style={{ color: accent, fontWeight: 600 }}>
                        {nodeLabel.split(" // ")[0]}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td style={{ color: "var(--fg-secondary)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.image}
                    </td>
                    <td>
                      <span className={`state-pill ${running ? "running" : "exited"}`}>
                        {c.state}
                      </span>
                    </td>
                    <td style={{ color: "var(--fg-secondary)" }}>{c.status}</td>
                    <td style={{ color: "var(--teal)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.ports || "host / none"}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: 5 }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => openLogs(nodeId, c.name)}
                        >
                          <FileText size={11} /> LOGS
                        </button>
                        {running ? (
                          <>
                            <button
                              className="btn btn-sm"
                              disabled={busyKey !== null}
                              onClick={() => runAction(nodeId, c.name, "restart")}
                            >
                              <RotateCw size={11} />
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={busyKey !== null}
                              onClick={() => runAction(nodeId, c.name, "stop")}
                            >
                              <Square size={11} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn-sm"
                            disabled={busyKey !== null}
                            onClick={() => runAction(nodeId, c.name, "start")}
                          >
                            <Play size={11} /> START
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {allContainers.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--fg-muted)" }}>
                    No containers match current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dual-Node Process + Listening Ports Matrix */}
      <div className="dual-grid">
        {(["spark-0", "spark-1"] as NodeId[]).map((id) => {
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
                    {n.topProcesses.slice(0, 7).map((p) => (
                      <tr key={p.pid}>
                        <td style={{ color: n.accent }}>{p.pid}</td>
                        <td style={{ fontWeight: 600 }}>{p.comm}</td>
                        <td>{p.cpuPct.toFixed(1)}%</td>
                        <td>{formatBytes(p.rssBytes, 1)}</td>
                        <td style={{ color: "var(--fg-secondary)", maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.args}
                        </td>
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
                {n.ports.slice(0, 14).map((p) => (
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
                    <strong style={{ color: "var(--fg-primary)" }}>:{p.port}</strong>{" "}
                    {p.addr} ({p.process})
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
