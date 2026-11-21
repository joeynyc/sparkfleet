import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ExecResult, NodeId, NodeSnapshot } from "../../shared/types";
import { Play, Radio, RotateCw, Terminal as TermIcon } from "lucide-react";

interface SshTerminalPaneProps {
  node: NodeSnapshot;
  broadcastSignal: { seq: number; text: string } | null;
}

function SshTerminalPane({ node, broadcastSignal }: SshTerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");
  const [reconnectSeq, setReconnectSeq] = useState(0);

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
    termRef.current = term;

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?node=${node.id}`);
    wsRef.current = ws;
    setStatus("connecting");

    const sendResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        // ignore
      }
    };

    ws.onopen = () => {
      setStatus("live");
      sendResize();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; data?: string; code?: number };
        if (msg.type === "output" && msg.data) {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.writeln(`\r\n\x1b[31m[SSH session exited with code ${msg.code ?? 0}]\x1b[0m`);
          setStatus("closed");
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setStatus("closed");
    };

    const dataDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataDisp.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
    };
  }, [node.id, node.accent, reconnectSeq]);

  useEffect(() => {
    if (!broadcastSignal || !broadcastSignal.text) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data: broadcastSignal.text }));
    }
  }, [broadcastSignal]);

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <TermIcon size={14} color={node.accent} />
          {node.label} · INTERACTIVE PTY ({node.sshHost})
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color:
                status === "live"
                  ? "var(--spark0)"
                  : status === "connecting"
                    ? "var(--amber)"
                    : "var(--crimson)",
            }}
          >
            ● {status.toUpperCase()}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setReconnectSeq((s) => s + 1)}
          >
            <RotateCw size={11} /> RECONNECT
          </button>
        </div>
      </div>
      <div ref={containerRef} className="terminal-shell" />
    </div>
  );
}

interface OpsTerminalViewProps {
  nodes: Record<NodeId, NodeSnapshot>;
}

const PRESET_COMMANDS = [
  { label: "nvidia-smi", cmd: "nvidia-smi" },
  { label: "RDMA Links", cmd: "rdma link && ibv_devinfo -l" },
  { label: "NVMe Disk Top", cmd: "df -h / && du -sh ~/* 2>/dev/null | sort -hr | head -n 10" },
  { label: "Docker Running", cmd: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'" },
  { label: "Memory Detail", cmd: "free -h && ps -eo pid,pcpu,pmem,rss,comm --sort=-rss | head -n 8" },
];

export function OpsTerminalView({ nodes }: OpsTerminalViewProps) {
  const [command, setCommand] = useState("nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,clocks.gr --format=csv");
  const [targets, setTargets] = useState<NodeId[]>(["spark-0", "spark-1"]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ExecResult[]>([]);
  const [syncInput, setSyncInput] = useState("");
  const [broadcastSig, setBroadcastSig] = useState<{ seq: number; text: string } | null>(null);

  const toggleTarget = (id: NodeId) => {
    setTargets((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id]
    );
  };

  const executeBroadcast = async (overrideCmd?: string) => {
    const cmd = (overrideCmd ?? command).trim();
    if (!cmd) return;
    if (overrideCmd) setCommand(overrideCmd);
    setRunning(true);
    try {
      const res = await fetch("/api/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: targets, command: cmd }),
      });
      const data = (await res.json()) as { results?: ExecResult[] };
      setResults(data.results ?? []);
    } finally {
      setRunning(false);
    }
  };

  const sendToBothPtys = () => {
    if (!syncInput.trim()) return;
    setBroadcastSig((prev) => ({
      seq: (prev?.seq ?? 0) + 1,
      text: `${syncInput}\r`,
    }));
    setSyncInput("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Fleet Broadcast Command Runner */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <Radio size={14} color="var(--spark0)" />
            PARALLEL FLEET COMMAND RUNNER
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {(["spark-0", "spark-1"] as NodeId[]).map((id) => (
              <button
                key={id}
                className={`btn btn-sm ${targets.includes(id) ? "btn-primary" : ""}`}
                onClick={() => toggleTarget(id)}
              >
                {nodes[id].label.split(" // ")[0]}
              </button>
            ))}
          </div>
        </div>

        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="cmd-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && executeBroadcast()}
              placeholder="Run command simultaneously on selected DGX Sparks..."
            />
            <button
              className="btn btn-primary"
              onClick={() => executeBroadcast()}
              disabled={running}
            >
              <Play size={12} /> {running ? "RUNNING..." : "EXEC ON FLEET"}
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {PRESET_COMMANDS.map((p) => (
              <button
                key={p.label}
                className="btn btn-sm"
                disabled={running}
                onClick={() => executeBroadcast(p.cmd)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {results.length > 0 && (
            <div className="dual-grid">
              {results.map((r) => (
                <div key={r.nodeId} className="telemetry-box">
                  <div className="telemetry-box-head">
                    <span className="telemetry-box-label" style={{ color: nodes[r.nodeId].accent }}>
                      {nodes[r.nodeId].label} ({r.sshHost})
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: r.exitCode === 0 ? "var(--spark0)" : "var(--crimson)" }}>
                      EXIT {r.exitCode} · {r.durationMs}ms
                    </span>
                  </div>
                  <pre className="log-pre" style={{ maxHeight: 220 }}>
                    {r.stdout || r.stderr || "(no output)"}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Synchronized PTY Broadcast Input */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <TermIcon size={14} color="var(--spark1)" />
            DUAL-NODE INTERACTIVE SSH TERMINALS
          </div>
          <div style={{ display: "flex", gap: 8, width: "min(480px, 55%)" }}>
            <input
              className="cmd-input"
              style={{ padding: "5px 10px", fontSize: 11.5 }}
              value={syncInput}
              onChange={(e) => setSyncInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendToBothPtys()}
              placeholder="Broadcast line to BOTH live PTYs (Enter)..."
            />
            <button className="btn btn-sm btn-primary" onClick={sendToBothPtys}>
              SYNC SEND
            </button>
          </div>
        </div>
      </div>

      <div className="dual-grid">
        <SshTerminalPane node={nodes["spark-0"]} broadcastSignal={broadcastSig} />
        <SshTerminalPane node={nodes["spark-1"]} broadcastSignal={broadcastSig} />
      </div>
    </div>
  );
}
