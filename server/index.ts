import fs from "node:fs";
import path from "node:path";
import type { FleetTick, NodeId, NodeUpdate, ServerMessage } from "../shared/types";
import { FleetBusyError, FleetCollector } from "./collector";
import { NODES, NODE_IDS, SERVER_PORT } from "./config";
import { ProbeError } from "./fabric-probe";
import {
  type AccessDenial,
  checkAccess,
  createAccessPolicy,
  hostAllowed,
  sessionCookie,
  tokenMatches,
} from "./security";
import { sshTerminalArgs } from "./ssh";
import { execTargets, isConfiguredNode } from "./targets";

const DIST_DIR = path.resolve(import.meta.dir, "../dist");
const MAX_TERMINALS = 8;
const MAX_COMMAND_LENGTH = 4096;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_WS_BACKLOG_BYTES = 4 * 1024 * 1024;

type WsData =
  | { kind: "telemetry"; sparseNodes: boolean }
  | {
      kind: "terminal";
      nodeId: NodeId;
      proc?: Bun.Subprocess;
    };

const policy = createAccessPolicy(SERVER_PORT, process.env.SPARKPIT_TOKEN || undefined);

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    // React style attributes and xterm.js both need inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${[...policy.allowedHosts].map((h) => `ws://${h}`).join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const DENIAL_MESSAGES: Record<AccessDenial, string> = {
  host: "Unrecognized Host header",
  origin: "Cross-origin requests are not allowed",
  auth: "Not authorized: open the access link printed by the SparkPit server",
};

const LOCKED_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>SparkPit · locked</title></head>
<body style="background:#08090c;color:#edf2f7;font-family:ui-monospace,monospace;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:520px;padding:24px;border:1px solid rgba(255,255,255,.16)">
<h1 style="font-size:16px;letter-spacing:.1em;color:#76b900;margin:0 0 10px">SPARKPIT // LOCKED</h1>
<p style="font-size:13px;line-height:1.6;color:#98a4b5;margin:0">This browser is not authorized. Open the access link printed in the terminal where the SparkPit server is running. A new link is issued each time the server starts.</p>
</div>
</body>
</html>`;

function respond(body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function json(data: unknown, status = 200): Response {
  return respond(JSON.stringify(data), status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
}

function isValidNodeId(value: unknown): value is NodeId {
  return isConfiguredNode(NODE_IDS, value);
}

function sanitizeContainerName(name: unknown): string | null {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ? name : null;
}

const telemetryClients = new Set<Bun.ServerWebSocket<WsData>>();
let openTerminals = 0;
let collector: FleetCollector;

function legacyNodeTick(tick: FleetTick): FleetTick {
  const currentNodes = collector.getPayload().nodes;
  const nodes = {} as Record<NodeId, NodeUpdate>;
  for (const id of NODE_IDS) {
    const update: NodeUpdate = { ...currentNodes[id] };
    delete update.containers;
    delete update.topProcesses;
    delete update.ports;

    const changed = tick.nodes[id];
    if (changed) {
      if ("containers" in changed) update.containers = changed.containers;
      if ("topProcesses" in changed) update.topProcesses = changed.topProcesses;
      if ("ports" in changed) update.ports = changed.ports;
    }
    nodes[id] = update;
  }
  return { ...tick, nodes };
}

function broadcastTick(tick: FleetTick): void {
  if (telemetryClients.size === 0) return;
  let sparseFrame: string | undefined;
  let legacyFrame: string | undefined;
  for (const ws of telemetryClients) {
    if (ws.getBufferedAmount() > MAX_WS_BACKLOG_BYTES) {
      // A stalled tab would otherwise make the server buffer frames forever.
      // It reconnects and receives a fresh snapshot.
      ws.close(1013, "telemetry backlog");
      continue;
    }
    if (ws.data.kind !== "telemetry") continue;
    if (ws.data.sparseNodes) {
      if (!sparseFrame) sparseFrame = JSON.stringify({ type: "tick", payload: tick } satisfies ServerMessage);
      ws.send(sparseFrame);
    } else {
      if (!legacyFrame) {
        legacyFrame = JSON.stringify({ type: "tick", payload: legacyNodeTick(tick) } satisfies ServerMessage);
      }
      ws.send(legacyFrame);
    }
  }
}

collector = await FleetCollector.start(broadcastTick);

async function handleApi(req: Request, url: URL): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/session") {
    return json({ ok: true });
  }

  if (route === "GET /api/state") {
    return json(collector.getPayload());
  }

  if (route === "POST /api/fabric/probe") {
    const body = (await req.json().catch(() => null)) as { source?: unknown; target?: unknown } | null;
    return json(await collector.runFabricProbe(body?.source, body?.target));
  }

  if (route === "POST /api/exec") {
    const body = (await req.json().catch(() => null)) as {
      nodes?: unknown;
      command?: unknown;
    } | null;
    const command = typeof body?.command === "string" ? body.command.trim() : "";
    if (!body || !command) return json({ error: "command required" }, 400);
    if (command.length > MAX_COMMAND_LENGTH) {
      return json({ error: `command exceeds ${MAX_COMMAND_LENGTH} characters` }, 400);
    }
    const targets = execTargets(NODE_IDS, body);
    if (!targets) return json({ error: "targets must be a nonempty array of configured node IDs" }, 400);

    const results = await Promise.all(
      targets.map((id) => collector.execOnNode(id, command, 30000))
    );
    return json({ command, results });
  }

  if (route === "GET /api/containers/logs") {
    const nodeParam = url.searchParams.get("node");
    const safeName = sanitizeContainerName(url.searchParams.get("name") ?? "");
    const tailParam = Number(url.searchParams.get("tail"));
    const tail = Number.isFinite(tailParam) ? Math.min(500, Math.max(20, Math.floor(tailParam))) : 120;
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
      truncated: res.truncated,
    });
  }

  if (route === "POST /api/containers/action") {
    const body = (await req.json().catch(() => null)) as {
      nodeId?: string;
      name?: string;
      action?: string;
    } | null;
    const safeName = sanitizeContainerName(body?.name ?? "");
    const action = body?.action ?? "";
    if (!isValidNodeId(body?.nodeId) || !safeName || !["start", "stop", "restart"].includes(action)) {
      return json({ error: "invalid action request" }, 400);
    }
    return json(await collector.execOnNode(body.nodeId, `docker ${action} '${safeName}' 2>&1`, 25000));
  }

  if (route === "GET /api/storage/analyze") {
    const nodeParam = url.searchParams.get("node");
    if (!isValidNodeId(nodeParam)) return json({ error: "invalid node" }, 400);
    const res = await collector.execOnNode(
      nodeParam,
      [
        "echo '=== TOP HOME DIRECTORIES ==='",
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
      timedOut: res.timedOut,
    });
  }

  return json({ error: "not found" }, 404);
}

function serveStatic(url: URL): Response {
  const indexFile = path.join(DIST_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    return respond("SparkPit API online. Run `bun run build` to serve the UI.", 503);
  }
  const candidate = path.join(DIST_DIR, url.pathname);
  const insideDist = candidate.startsWith(DIST_DIR + path.sep);
  const file = insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : indexFile;
  return new Response(Bun.file(file), { headers: SECURITY_HEADERS });
}

const server = Bun.serve<WsData>({
  port: SERVER_PORT,
  hostname: "127.0.0.1",
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  async fetch(req, srv) {
    const url = new URL(req.url);

    // The one route reachable without a session: it trades the launch token for the cookie.
    if (url.pathname === "/auth" && req.method === "GET") {
      if (!hostAllowed(req, policy) || !tokenMatches(url.searchParams.get("token"), policy)) {
        return respond("This access link is invalid or has expired. Use the link from the current server launch.", 403);
      }
      return respond(null, 303, {
        Location: "/",
        "Set-Cookie": sessionCookie(policy),
        "Cache-Control": "no-store",
      });
    }

    const denial = checkAccess(req, policy);
    const isPage = !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/ws/");
    if (denial === "auth" && isPage) {
      return respond(LOCKED_PAGE, 401, { "Content-Type": "text/html; charset=utf-8" });
    }
    if (denial) {
      return json({ error: DENIAL_MESSAGES[denial] }, denial === "auth" ? 401 : 403);
    }

    if (url.pathname === "/ws/telemetry") {
      if (srv.upgrade(req, { data: { kind: "telemetry", sparseNodes: url.searchParams.get("sparse") === "1" } })) return;
      return respond("Upgrade failed", 400);
    }

    if (url.pathname === "/ws/terminal") {
      const nodeParam = url.searchParams.get("node");
      if (!isValidNodeId(nodeParam)) return respond("Invalid node", 400);
      if (openTerminals >= MAX_TERMINALS) return respond("Too many open terminals", 429);
      if (!srv.upgrade(req, { data: { kind: "terminal", nodeId: nodeParam } })) return respond("Upgrade failed", 400);
      openTerminals++;
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, url);
      } catch (err) {
        if (err instanceof FleetBusyError) return json({ error: err.message }, 429);
        if (err instanceof ProbeError) return json({ error: err.message }, err.status);
        console.error(`${req.method} ${url.pathname} failed:`, err);
        return json({ error: "internal error" }, 500);
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return respond("Method not allowed", 405);
    return serveStatic(url);
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "telemetry") {
        // Flush first so the snapshot and the next tick do not overlap.
        collector.flush();
        ws.send(JSON.stringify({ type: "init", payload: collector.getPayload() } satisfies ServerMessage));
        telemetryClients.add(ws);
        return;
      }

      // Streaming decode: a multi-byte character may straddle two PTY chunks.
      const decoder = new TextDecoder();
      const proc = Bun.spawn(sshTerminalArgs(NODES[ws.data.nodeId].sshHost), {
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: {
          cols: 100,
          rows: 28,
          data(_term, chunk) {
            ws.send(JSON.stringify({ type: "output", data: decoder.decode(chunk, { stream: true }) }));
          },
        },
      });
      ws.data.proc = proc;
      proc.exited.then((code) => {
        ws.send(JSON.stringify({ type: "exit", code }));
        ws.close();
      });
    },
    message(ws, message) {
      if (ws.data.kind !== "terminal" || !ws.data.proc?.terminal) return;
      let frame: unknown;
      try {
        frame = JSON.parse(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
      } catch {
        return; // not a protocol frame
      }
      const parsed = frame as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      if (parsed.type === "input" && typeof parsed.data === "string") {
        ws.data.proc.terminal.write(parsed.data);
      } else if (parsed.type === "resize") {
        const cols = Math.max(20, Math.min(300, Math.floor(Number(parsed.cols) || 100)));
        const rows = Math.max(6, Math.min(120, Math.floor(Number(parsed.rows) || 28)));
        ws.data.proc.terminal.resize(cols, rows);
      }
    },
    close(ws) {
      if (ws.data.kind === "telemetry") {
        telemetryClients.delete(ws);
        return;
      }
      openTerminals--;
      ws.data.proc?.terminal?.close();
      ws.data.proc?.kill();
    },
  },
});

console.log(`SparkPit Control Plane listening on http://127.0.0.1:${server.port}`);
console.log("Open this link once to authorize your browser:");
console.log(`  http://127.0.0.1:${server.port}/auth?token=${policy.token}`);

function shutdown(): void {
  collector.stop();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
