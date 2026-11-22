import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Play, Radio, RotateCw, Terminal as TermIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecResult, NodeId, NodeSnapshot } from "../../shared/types";
import { errorMessage, postJson } from "../api";

type TerminalFrame = { type: "output"; data: string } | { type: "exit"; code: number };

interface SshTerminalPaneProps {
  node: NodeSnapshot;
  onSocketChange: (id: NodeId, socket: WebSocket | undefined) => void;
  onClose: () => void;
}

function SshTerminalPane({ node, onSocketChange, onClose }: SshTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");
  const [session, setSession] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` is the reconnect trigger
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: {
        background: "#06080b",
        foreground: "#e2e8f0",
        cursor: node.accent,
        selectionBackground: "rgba(118, 185, 0, 0.28)",
        green: "#76b900",
        cyan: "#38bdf8",
        yellow: "#f59e0b",
        red: "#ef4444",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws/terminal?node=${encodeURIComponent(node.id)}`);
    setStatus("connecting");

    const syncSize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => {
      setStatus("live");
      onSocketChange(node.id, ws);
      syncSize();
    };
    ws.onmessage = (ev) => {
      const frame = JSON.parse(ev.data) as TerminalFrame;
      if (frame.type === "output") {
        term.write(frame.data);
      } else {
        term.writeln(`\r\n\x1b[31m[SSH session exited with code ${frame.code}]\x1b[0m`);
        setStatus("closed");
        onSocketChange(node.id, undefined);
      }
    };
    ws.onclose = (ev) => {
      setStatus("closed");
      onSocketChange(node.id, undefined);
      if (!ev.wasClean) term.writeln("\r\n\x1b[31m[Terminal connection lost or refused]\x1b[0m");
    };

    const input = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      input.dispose();
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      onSocketChange(node.id, undefined);
      ws.close();
      term.dispose();
    };
  }, [node.id, node.accent, onSocketChange, session]);

  const statusColor =
    status === "live" ? "var(--spark0)" : status === "connecting" ? "var(--amber)" : "var(--crimson)";

  return (
    <div className="panel" style={{ minWidth: 0 }}>
      <div className="panel-header" style={{ flexWrap: "wrap" }}>
        <div className="panel-title">
          <TermIcon size={14} color={node.accent} />
          {node.label} · SSH ({node.sshHost})
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 10.5, color: statusColor }}>
            ● {status.toUpperCase()}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setSession((s) => s + 1)}>
            <RotateCw size={11} /> RECONNECT
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label={`Close terminal for ${node.id}`}>
            <X size={11} /> CLOSE
          </button>
        </div>
      </div>
      <div ref={containerRef} className="terminal-shell" />
    </div>
  );
}

const PRESET_COMMANDS = [
  { label: "nvidia-smi", cmd: "nvidia-smi" },
  { label: "RDMA Links", cmd: "rdma link && ibv_devinfo -l" },
  { label: "Disk Usage", cmd: "df -h / && du -sh ~/* 2>/dev/null | sort -hr | head -n 10" },
  { label: "Docker Running", cmd: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'" },
  { label: "Memory Detail", cmd: "free -h && ps -eo pid,pcpu,pmem,rss,comm --sort=-rss | head -n 8" },
];

const DEFAULT_COMMAND =
  "nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,clocks.gr --format=csv";

interface OpsTerminalViewProps {
  nodes: Record<NodeId, NodeSnapshot>;
  initialNodeId?: NodeId;
}

export default function OpsTerminalView({ nodes, initialNodeId }: OpsTerminalViewProps) {
  const nodeIds = Object.keys(nodes);
  const [openIds, setOpenIds] = useState<NodeId[]>(() => {
    if (initialNodeId !== undefined) return nodeIds.filter((id) => id === initialNodeId);
    return nodeIds.length <= 2 ? nodeIds : [];
  });
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  // Independent of the open panes: a command goes to the whole fleet unless a node was singled out.
  const [targets, setTargets] = useState<NodeId[]>(() =>
    initialNodeId !== undefined ? nodeIds.filter((id) => id === initialNodeId) : nodeIds
  );
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ExecResult[]>([]);
  const [execError, setExecError] = useState<string | null>(null);
  const [syncInput, setSyncInput] = useState("");
  const [sockets, setSockets] = useState<Partial<Record<NodeId, WebSocket>>>({});
  const onSocketChange = useCallback((id: NodeId, socket: WebSocket | undefined) => {
    if (!socket) setSyncInput("");
    setSockets((prev) => prev[id] === socket ? prev : { ...prev, [id]: socket });
  }, []);

  const paneIds = nodeIds.filter((id) => openIds.includes(id));
  const recipients = paneIds.map((id) => sockets[id]).filter((ws): ws is WebSocket => ws !== undefined);
  const allLive = paneIds.length > 0 && recipients.length === paneIds.length;

  const togglePane = (id: NodeId) => {
    setOpenIds((prev) => prev.includes(id) ? prev.filter((openId) => openId !== id) : [...prev, id]);
    // A draft intended for the old recipient set must not follow the operator to a new one.
    setSyncInput("");
  };

  const execute = async (cmd: string) => {
    if (running || targets.length === 0 || !cmd.trim()) return;
    setCommand(cmd);
    setRunning(true);
    setResults([]);
    setExecError(null);
    try {
      const res = await postJson<{ results: ExecResult[] }>("/api/exec", {
        nodes: nodeIds.filter((id) => targets.includes(id)),
        command: cmd,
      });
      setResults(res.results);
    } catch (err) {
      setExecError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const broadcast = () => {
    if (!syncInput.trim() || !allLive || recipients.some((ws) => ws.readyState !== WebSocket.OPEN)) return;
    // Send only to this render's indicated sessions. Never queue input for a future socket.
    const frame = JSON.stringify({ type: "input", data: `${syncInput}\r` });
    for (const ws of recipients) ws.send(frame);
    setSyncInput("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="panel">
        <div className="panel-header" style={{ flexWrap: "wrap" }}>
          <div className="panel-title">
            <Radio size={14} color="var(--spark0)" />
            PARALLEL COMMAND RUNNER
          </div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {nodeIds.length > 1 && (
              <button
                type="button"
                className={`btn btn-sm ${targets.length === nodeIds.length ? "btn-primary" : ""}`}
                aria-pressed={targets.length === nodeIds.length}
                disabled={running}
                onClick={() => setTargets(targets.length === nodeIds.length ? [] : nodeIds)}
              >
                ALL NODES
              </button>
            )}
            {nodeIds.map((id) => (
              <button
                key={id}
                type="button"
                className={`btn btn-sm ${targets.includes(id) ? "btn-primary" : ""}`}
                aria-pressed={targets.includes(id)}
                disabled={running}
                title={`Command target: ${id}`}
                onClick={() => setTargets((prev) =>
                  prev.includes(id) ? prev.filter((targetId) => targetId !== id) : [...prev, id]
                )}
              >
                {nodes[id].label}
              </button>
            ))}
          </div>
        </div>

        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <form
            style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
            onSubmit={(ev) => {
              ev.preventDefault();
              void execute(command);
            }}
          >
            <input
              className="cmd-input"
              style={{ minWidth: 0, flexBasis: 220 }}
              aria-label="Command to run on the selected nodes"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Run a command on the selected nodes..."
            />
            <button type="submit" className="btn btn-primary" disabled={running || !targets.length || !command.trim()}>
              <Play size={12} />
              {running ? "RUNNING..." : `EXEC ON ${targets.length} ${targets.length === 1 ? "NODE" : "NODES"}`}
            </button>
          </form>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRESET_COMMANDS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="btn btn-sm"
                disabled={running || !targets.length}
                onClick={() => execute(preset.cmd)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {execError && (
            <div className="notice-error" role="alert">
              Command was not run: {execError}
            </div>
          )}

          {results.length > 0 && (
            <div className="fleet-grid">
              {results.map((r) => {
                const flags = [r.timedOut && "TIMED OUT", r.truncated && "OUTPUT TRUNCATED"].filter(Boolean);
                const ok = r.exitCode === 0 && flags.length === 0;
                return (
                  <div key={r.nodeId} className="telemetry-box" style={{ minWidth: 0 }}>
                    <div className="telemetry-box-head" style={{ flexWrap: "wrap", gap: 6 }}>
                      <span className="telemetry-box-label" style={{ color: nodes[r.nodeId].accent }}>
                        {nodes[r.nodeId].label} ({r.sshHost})
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 10.5, color: ok ? "var(--spark0)" : "var(--crimson)" }}
                      >
                        {[`EXIT ${r.exitCode}`, `${r.durationMs}ms`, ...flags].join(" · ")}
                      </span>
                    </div>
                    <pre className="log-pre" style={{ maxHeight: 220 }}>
                      {r.stdout || (!r.stderr && "(no output)")}
                      {r.stdout && r.stderr ? "\n" : ""}
                      {r.stderr}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header" style={{ flexWrap: "wrap" }}>
          <div className="panel-title">
            <TermIcon size={14} color="var(--spark1)" />
            INTERACTIVE SSH TERMINALS
          </div>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {recipients.length}/{paneIds.length} PANES LIVE
          </span>
        </div>
        <div className="panel-body" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {nodeIds.map((id) => {
              const open = openIds.includes(id);
              return (
                <button
                  type="button"
                  key={id}
                  className={`btn btn-sm ${open ? "btn-primary" : ""}`}
                  aria-pressed={open}
                  title={`${open ? "Close" : "Open"} terminal for ${id}`}
                  onClick={() => togglePane(id)}
                >
                  {open ? "CLOSE" : "OPEN"} · {nodes[id].label}
                </button>
              );
            })}
          </div>
          <label htmlFor="terminal-broadcast" className="mono" style={{ fontSize: 11, color: "var(--fg-secondary)" }}>
            BROADCAST TO: {paneIds.length
              ? paneIds.map((id) => `${nodes[id].label} (${id})`).join(" · ")
              : "NO OPEN TERMINALS"}
          </label>
          <form
            style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
            onSubmit={(ev) => {
              ev.preventDefault();
              broadcast();
            }}
          >
            <input
              id="terminal-broadcast"
              className="cmd-input"
              style={{ minWidth: 0, flexBasis: 220, padding: "5px 10px", fontSize: 11.5 }}
              value={syncInput}
              onChange={(e) => setSyncInput(e.target.value)}
              disabled={!allLive}
              placeholder={allLive ? "Send a line to the listed terminals..." : "Open terminals; all listed panes must be live to send."}
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!allLive || !syncInput.trim()}>
              SYNC SEND
            </button>
          </form>
        </div>
      </div>

      <div className="fleet-grid">
        {paneIds.map((id) => (
          <SshTerminalPane key={id} node={nodes[id]} onSocketChange={onSocketChange} onClose={() => togglePane(id)} />
        ))}
      </div>
    </div>
  );
}
