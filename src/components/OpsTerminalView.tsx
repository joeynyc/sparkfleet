import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Play, Radio, RotateCw, Terminal as TermIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NODE_IDS } from "../../shared/fleet-state";
import type { ExecResult, NodeId, NodeSnapshot } from "../../shared/types";
import { errorMessage, postJson } from "../api";

type TerminalFrame = { type: "output"; data: string } | { type: "exit"; code: number };

interface SshTerminalPaneProps {
  node: NodeSnapshot;
  /** A line to type into this terminal; `seq` changes on every send. */
  broadcast: { seq: number; text: string } | null;
}

function SshTerminalPane({ node, broadcast }: SshTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
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
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws/terminal?node=${node.id}`);
    wsRef.current = ws;
    setStatus("connecting");

    const syncSize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => {
      setStatus("live");
      syncSize();
    };
    ws.onmessage = (ev) => {
      const frame = JSON.parse(ev.data) as TerminalFrame;
      if (frame.type === "output") {
        term.write(frame.data);
      } else {
        term.writeln(`\r\n\x1b[31m[SSH session exited with code ${frame.code}]\x1b[0m`);
      }
    };
    ws.onclose = () => setStatus("closed");

    const input = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
    };
  }, [node.id, node.accent, session]);

  useEffect(() => {
    const ws = wsRef.current;
    if (broadcast && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: broadcast.text }));
    }
  }, [broadcast]);

  const statusColor =
    status === "live" ? "var(--spark0)" : status === "connecting" ? "var(--amber)" : "var(--crimson)";

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <TermIcon size={14} color={node.accent} />
          {node.label} · SSH ({node.sshHost})
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 10.5, color: statusColor }}>
            ● {status.toUpperCase()}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setSession((s) => s + 1)}>
            <RotateCw size={11} /> RECONNECT
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
}

export default function OpsTerminalView({ nodes }: OpsTerminalViewProps) {
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  const [targets, setTargets] = useState<NodeId[]>([...NODE_IDS]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ExecResult[]>([]);
  const [execError, setExecError] = useState<string | null>(null);
  const [syncInput, setSyncInput] = useState("");
  const [broadcast, setBroadcast] = useState<{ seq: number; text: string } | null>(null);

  // At least one node stays selected.
  const toggleTarget = (id: NodeId) =>
    setTargets((prev) => {
      if (!prev.includes(id)) return [...prev, id];
      return prev.length > 1 ? prev.filter((x) => x !== id) : prev;
    });

  const execute = async (cmd: string) => {
    if (!cmd.trim()) return;
    setCommand(cmd);
    setRunning(true);
    try {
      const res = await postJson<{ results: ExecResult[] }>("/api/exec", { nodes: targets, command: cmd });
      setResults(res.results);
      setExecError(null);
    } catch (err) {
      setExecError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const sendToBothTerminals = () => {
    if (!syncInput.trim()) return;
    setBroadcast((prev) => ({ seq: (prev?.seq ?? 0) + 1, text: `${syncInput}\r` }));
    setSyncInput("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Radio size={14} color="var(--spark0)" />
            PARALLEL COMMAND RUNNER
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {NODE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`btn btn-sm ${targets.includes(id) ? "btn-primary" : ""}`}
                onClick={() => toggleTarget(id)}
              >
                {nodes[id].label}
              </button>
            ))}
          </div>
        </div>

        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="cmd-input"
              aria-label="Command to run on the selected nodes"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && execute(command)}
              placeholder="Run a command on the selected nodes..."
            />
            <button type="button" className="btn btn-primary" onClick={() => execute(command)} disabled={running}>
              <Play size={12} /> {running ? "RUNNING..." : "EXEC ON FLEET"}
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRESET_COMMANDS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="btn btn-sm"
                disabled={running}
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
            <div className="dual-grid">
              {results.map((r) => {
                const flags = [r.timedOut && "TIMED OUT", r.truncated && "OUTPUT TRUNCATED"].filter(Boolean);
                const ok = r.exitCode === 0 && flags.length === 0;
                return (
                  <div key={r.nodeId} className="telemetry-box">
                    <div className="telemetry-box-head">
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
                      {r.stdout || r.stderr || "(no output)"}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <TermIcon size={14} color="var(--spark1)" />
            INTERACTIVE SSH TERMINALS
          </div>
          <div style={{ display: "flex", gap: 8, width: "min(480px, 55%)" }}>
            <input
              className="cmd-input"
              aria-label="Line to send to both terminals"
              style={{ padding: "5px 10px", fontSize: 11.5 }}
              value={syncInput}
              onChange={(e) => setSyncInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendToBothTerminals()}
              placeholder="Send a line to BOTH terminals (Enter)..."
            />
            <button type="button" className="btn btn-sm btn-primary" onClick={sendToBothTerminals}>
              SYNC SEND
            </button>
          </div>
        </div>
      </div>

      <div className="dual-grid">
        {NODE_IDS.map((id) => (
          <SshTerminalPane key={id} node={nodes[id]} broadcast={broadcast} />
        ))}
      </div>
    </div>
  );
}
