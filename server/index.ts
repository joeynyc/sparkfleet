import type { NodeId } from "../shared/types";
import { NODE_IDS, NODES, SERVER_PORT } from "./config";
import { FleetCollector } from "./collector";
import path from "node:path";
import fs from "node:fs";

const DIST_DIR = path.resolve(import.meta.dir, "../dist");

type WsData =
  | { kind: "telemetry" }
  | {
      kind: "terminal";
      nodeId: NodeId;
      proc?: Bun.Subprocess;
    };

const collector = new FleetCollector();
const telemetryClients = new Set<Bun.ServerWebSocket<WsData>>();

function isValidNodeId(v: string | null | undefined): v is NodeId {
  return v === "spark-0" || v === "spark-1";
}

function sanitizeContainerName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) return null;
  return name;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

collector.subscribe((payload) => {
  if (telemetryClients.size === 0) return;
  const serialized = JSON.stringify({ type: "fleet_state", payload });
  for (const ws of telemetryClients) {
    try {
      ws.send(serialized);
    } catch {
      telemetryClients.delete(ws);
    }
  }
});

await collector.start();

const server = Bun.serve<WsData>({
  port: SERVER_PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return json({ ok: true });
    }

    // WebSocket: live telemetry stream
    if (url.pathname === "/ws/telemetry") {
      if (srv.upgrade(req, { data: { kind: "telemetry" } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    // WebSocket: interactive SSH PTY terminal
    if (url.pathname === "/ws/terminal") {
      const nodeParam = url.searchParams.get("node");
      if (!isValidNodeId(nodeParam)) {
        return new Response("Invalid node", { status: 400 });
      }
      if (srv.upgrade(req, { data: { kind: "terminal", nodeId: nodeParam } })) return;
      return new Response("Upgrade failed", { status: 400 });
    }

    // API routes
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(collector.getPayload());
    }

    if (url.pathname === "/api/fabric/probe" && req.method === "POST") {
      const probe = await collector.runFabricProbe();
      return json(probe);
    }

    if (url.pathname === "/api/exec" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        nodes?: string[];
        command?: string;
      } | null;
      const command = body?.command?.trim();
      if (!command) return json({ error: "command required" }, 400);
      const targetNodes = (body?.nodes ?? NODE_IDS).filter(isValidNodeId);
      if (targetNodes.length === 0) return json({ error: "no valid target nodes" }, 400);

      const results = await Promise.all(
        targetNodes.map((id) => collector.execOnNode(id, command, 30000))
      );
      return json({ command, ts: Date.now(), results });
    }

    if (url.pathname === "/api/containers/logs" && req.method === "GET") {
      const nodeParam = url.searchParams.get("node");
      const nameParam = url.searchParams.get("name") ?? "";
      const tail = Math.min(500, Math.max(20, Number(url.searchParams.get("tail") || 120)));
      const safeName = sanitizeContainerName(nameParam);
      if (!isValidNodeId(nodeParam) || !safeName) {
        return json({ error: "invalid node or container name" }, 400);
      }
      const res = await collector.execOnNode(
        nodeParam,
        `docker logs --tail ${tail} --timestamps '${safeName}' 2>&1`,
        15000
      );
      return json({
        nodeId: nodeParam,
        name: safeName,
        logs: res.stdout || res.stderr,
        exitCode: res.exitCode,
      });
    }

    if (url.pathname === "/api/containers/action" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        nodeId?: string;
        name?: string;
        action?: string;
      } | null;
      const safeName = sanitizeContainerName(body?.name ?? "");
      const action = body?.action;
      if (
        !isValidNodeId(body?.nodeId) ||
        !safeName ||
        !["start", "stop", "restart"].includes(action ?? "")
      ) {
        return json({ error: "invalid action request" }, 400);
      }
      const res = await collector.execOnNode(
        body.nodeId,
        `docker ${action} '${safeName}' 2>&1`,
        25000
      );
      return json(res);
    }

    if (url.pathname === "/api/storage/analyze" && req.method === "GET") {
      const nodeParam = url.searchParams.get("node");
      if (!isValidNodeId(nodeParam)) return json({ error: "invalid node" }, 400);
      const res = await collector.execOnNode(
        nodeParam,
        [
          "echo '=== TOP HOME/MODELS ==='",
          "du -h --max-depth=2 ~ 2>/dev/null | sort -hr | head -n 16",
          "echo '=== DOCKER DISK ==='",
          "docker system df 2>/dev/null || true",
        ].join("; "),
        25000
      );
      return json({
        nodeId: nodeParam,
        output: res.stdout || res.stderr,
        durationMs: res.durationMs,
      });
    }

    // Serve built frontend static files
    if (fs.existsSync(DIST_DIR)) {
      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const candidate = path.join(DIST_DIR, reqPath);
      if (candidate.startsWith(DIST_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return new Response(Bun.file(candidate));
      }
      const indexFile = path.join(DIST_DIR, "index.html");
      if (fs.existsSync(indexFile)) {
        return new Response(Bun.file(indexFile));
      }
    }

    return new Response("SparkFleet API online. Run `bun run build` to serve UI.", {
      status: 200,
    });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "telemetry") {
        telemetryClients.add(ws);
        ws.send(JSON.stringify({ type: "fleet_state", payload: collector.getPayload() }));
        return;
      }

      if (ws.data.kind === "terminal") {
        const cfg = NODES[ws.data.nodeId];
        const proc = Bun.spawn(
          [
            "ssh",
            "-tt",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=10",
            cfg.sshHost,
          ],
          {
            env: {
              ...process.env,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
            },
            terminal: {
              cols: 100,
              rows: 28,
              data(_term, chunk) {
                try {
                  ws.send(
                    JSON.stringify({
                      type: "output",
                      data: Buffer.from(chunk).toString("utf8"),
                    })
                  );
                } catch {
                  // socket closed
                }
              },
            },
          }
        );
        ws.data.proc = proc;
        proc.exited.then((code) => {
          try {
            ws.send(
              JSON.stringify({
                type: "exit",
                code,
              })
            );
            ws.close();
          } catch {
            // ignore
          }
        });
      }
    },
    message(ws, message) {
      if (ws.data.kind !== "terminal" || !ws.data.proc?.terminal) return;
      try {
        const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
        const parsed = JSON.parse(text) as
          | { type: "input"; data: string }
          | { type: "resize"; cols: number; rows: number };
        if (parsed.type === "input" && typeof parsed.data === "string") {
          ws.data.proc.terminal.write(parsed.data);
        } else if (parsed.type === "resize") {
          const cols = Math.max(20, Math.min(300, Math.floor(parsed.cols || 100)));
          const rows = Math.max(6, Math.min(120, Math.floor(parsed.rows || 28)));
          ws.data.proc.terminal.resize(cols, rows);
        }
      } catch {
        // ignore malformed frame
      }
    },
    close(ws) {
      if (ws.data.kind === "telemetry") {
        telemetryClients.delete(ws);
      } else if (ws.data.kind === "terminal" && ws.data.proc) {
        try {
          ws.data.proc.terminal?.close();
          ws.data.proc.kill();
        } catch {
          // ignore
        }
      }
    },
  },
});

console.log(`SparkFleet Control Plane listening on http://127.0.0.1:${server.port}`);

process.on("SIGINT", () => {
  collector.stop();
  server.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  collector.stop();
  server.stop();
  process.exit(0);
});
