/**
 * Runs the real server against the fake nodes in demo/ (no hardware, no network)
 * and checks it through its public HTTP and WebSocket API at several fleet sizes.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecResult, FabricProbeResult, FleetStatePayload, NodeId, ServerMessage } from "../shared/types";

const REPO = path.resolve(import.meta.dir, "..");
const TOKEN = "fleet-integration-test-token-0123456789";
const TEST_TIMEOUT_MS = 40_000;

// lib.dom's WebSocket type shadows Bun's in this project; Bun's constructor also takes request headers.
const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> }
) => WebSocket;

interface Fleet {
  ids: NodeId[];
  /** SSH hosts, in the order of `ids`. */
  hosts: string[];
  /** FAKE_STATE_DIR of the fake nodes. */
  stateDir: string;
  api(route: string, body?: unknown): Promise<Response>;
  state(): Promise<FleetStatePayload>;
  telemetry(): WebSocket;
  /** Hosts that were handed a one-shot command containing `marker`. */
  received(marker: string): string[];
}

let stopFleet: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopFleet?.();
  stopFleet = undefined;
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
  const port = Number(probe.url.port);
  probe.stop(true);
  return port;
}

/** Polls on the real clock: the server is another process, with no event this test could await instead. */
async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const offlineNodes = (state: FleetStatePayload) =>
  state.alerts.filter((alert) => alert.kind === "offline").map((alert) => alert.nodeId);
const connectedNodes = (state: FleetStatePayload) =>
  Object.values(state.nodes).filter((node) => node.connected).map((node) => node.id);

/** Starts the server on a free port with `size` fake nodes and waits until all of them report. */
async function startFleet(size: number, topology: "ring" | "mesh" | "switch"): Promise<Fleet> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "sparkpit-fleet-"));
  const port = freePort();
  const ids = Array.from({ length: size }, (_, i) => `spark-${i}`);
  const hosts = ids.map((_, i) => `demo-spark-${i + 1}`);
  const config = path.join(stateDir, "fleet.json");
  writeFileSync(config, JSON.stringify({ nodes: Object.fromEntries(ids.map((id, i) => [id, { sshHost: hosts[i] }])) }));

  // A developer's own SPARK<n>_HOST or SPARKPIT_* settings must not reach the server under test.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(SPARK\d+_|SPARKPIT_|FAKE_)/.test(key))
  );
  const server = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: REPO,
    env: {
      ...inherited,
      // demo/bin shadows ssh and ping; its ssh wrapper needs `bun` on the path.
      PATH: [path.join(REPO, "demo/bin"), path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
      SPARKPIT_CONFIG: config,
      SPARKPIT_PORT: String(port),
      SPARKPIT_TOKEN: TOKEN,
      FAKE_FLEET_SIZE: String(size),
      FAKE_TOPOLOGY: topology,
      FAKE_INTERVAL_MS: "200",
      FAKE_STATE_DIR: stateDir,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  stopFleet = async () => {
    server.kill();
    await Promise.race([server.exited, Bun.sleep(3000)]);
    server.kill("SIGKILL");
    await server.exited;
    rmSync(stateDir, { recursive: true, force: true });
  };

  const headers = { Cookie: `sparkpit_${port}=${TOKEN}` };
  const fleet: Fleet = {
    ids,
    hosts,
    stateDir,
    api: (route, body) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      }),
    state: async () => (await (await fleet.api("/api/state")).json()) as FleetStatePayload,
    telemetry: () => new HeaderWebSocket(`ws://127.0.0.1:${port}/ws/telemetry`, { headers }),
    received(marker) {
      const log = path.join(stateDir, "commands.log");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line): { host: string; command: string } => JSON.parse(line))
        .filter((entry) => entry.command.includes(marker))
        .map((entry) => entry.host);
    },
  };

  await until("every node to connect", async () => {
    if (server.exitCode !== null) throw new Error(`Server exited with code ${server.exitCode}`);
    const state = await fleet.state().catch(() => undefined); // not listening yet
    return state && ids.every((id) => state.nodes[id]?.connected && state.history[id]?.length);
  });
  return fleet;
}

/** Every node is connected, in roster order, with one LAN interface and timestamped history. */
async function expectFullState(fleet: Fleet, fabricPerNode: number): Promise<FleetStatePayload> {
  const state = await fleet.state();
  expect(Object.keys(state.nodes)).toEqual(fleet.ids);
  expect(Object.keys(state.history)).toEqual(fleet.ids);
  expect(offlineNodes(state)).toEqual([]);
  for (const [i, id] of fleet.ids.entries()) {
    const node = state.nodes[id];
    expect(node).toMatchObject({ id, sshHost: fleet.hosts[i], hostname: `spark-0${i + 1}`, connected: true, error: null });
    expect(node.interfaces.map((nic) => nic.role).sort()).toEqual([...Array(fabricPerNode).fill("fabric"), "lan"]);
    expect(node.containers.length).toBeGreaterThan(0);
    expect(node.ports.length).toBeGreaterThan(0);
    expect(state.history[id].length).toBeGreaterThan(0);
    for (const point of state.history[id]) {
      expect(Math.abs(Date.now() - point.ts)).toBeLessThan(TEST_TIMEOUT_MS);
    }
  }
  return state;
}

/** `init` carries full snapshots; ticks carry points for every node and drop unchanged slow sections. */
async function expectTelemetryProtocol(fleet: Fleet): Promise<void> {
  const frames: ServerMessage[] = [];
  const socket = fleet.telemetry();
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as ServerMessage);
  const withPoints = new Set<NodeId>();
  let sawSlimTick = false;
  let checked = 1;
  try {
    await until("ticks with points for every node and one without containers", async () => {
      for (; checked < frames.length; checked++) {
        const frame = frames[checked];
        if (frame.type !== "tick") throw new Error(`Frame ${checked} is "${frame.type}", expected a tick`);
        const { nodes, points } = frame.payload;
        expect(Object.keys(nodes)).toEqual(fleet.ids);
        for (const id of fleet.ids) {
          // Fast sections are in every tick.
          expect(typeof nodes[id].gpu.utilPct).toBe("number");
          expect(nodes[id].interfaces.length).toBeGreaterThan(0);
          if (!("containers" in nodes[id])) sawSlimTick = true;
          if (points[id]?.length) {
            expect(typeof points[id][0].ts).toBe("number");
            withPoints.add(id);
          }
        }
      }
      return sawSlimTick && withPoints.size === fleet.ids.length;
    });
  } finally {
    socket.close();
  }

  const [init] = frames;
  if (init.type !== "init") throw new Error(`First frame is "${init.type}", expected init`);
  expect(Object.keys(init.payload.nodes)).toEqual(fleet.ids);
  for (const id of fleet.ids) {
    const node = init.payload.nodes[id];
    expect(node.connected).toBe(true);
    for (const section of ["containers", "topProcesses", "ports"] as const) {
      expect(node[section].length).toBeGreaterThan(0);
    }
    expect(init.payload.history[id].length).toBeGreaterThan(0);
  }
}

/** A target list runs only on those nodes, no list means the whole fleet, and a bad list runs nowhere. */
async function expectExecTargeting(fleet: Fleet): Promise<void> {
  const { ids, hosts } = fleet;
  const last = ids.length - 1;
  const exec = (body: unknown) => fleet.api("/api/exec", body);
  const resultsOf = async (res: Response) => {
    const body: { results: ExecResult[] } = await res.json();
    return body.results;
  };

  const one = await exec({ command: "hostname # only-last", nodes: [ids[last]] });
  expect(one.status).toBe(200);
  expect(await resultsOf(one)).toMatchObject([
    { nodeId: ids[last], sshHost: hosts[last], exitCode: 0, stdout: `spark-0${last + 1}\n`, timedOut: false },
  ]);
  expect(fleet.received("only-last")).toEqual([hosts[last]]);

  const all = await exec({ command: "hostname # whole-fleet" });
  expect(all.status).toBe(200);
  expect(await resultsOf(all)).toMatchObject(
    ids.map((nodeId, i) => ({ nodeId, exitCode: 0, stdout: `spark-0${i + 1}\n` }))
  );
  expect(fleet.received("whole-fleet").sort()).toEqual(hosts);

  // One unknown ID spoils the whole request, even next to a valid one.
  for (const nodes of [["spark-9"], [ids[0], "spark-9"], ["demo-spark-1"]]) {
    const refused = await exec({ command: "hostname # nobody", nodes });
    expect(refused.status).toBe(400);
  }
  expect(fleet.received("nobody")).toEqual([]);
}

/** Last node to first: one fabric path on their shared network plus the LAN path, each measured. */
async function expectProbePaths(fleet: Fleet, state: FleetStatePayload): Promise<void> {
  const source = fleet.ids[fleet.ids.length - 1];
  const target = fleet.ids[0];
  const res = await fleet.api("/api/fabric/probe", { source, target });
  expect(res.status).toBe(200);
  const result = (await res.json()) as FabricProbeResult;
  expect(result).toMatchObject({ source, target });
  expect(typeof result.ts).toBe("number");
  expect(Array.isArray(result.paths)).toBe(true);
  expect(result.paths.map((p) => p.kind).sort()).toEqual(["fabric", "lan"]);
  for (const probed of result.paths) {
    const from = state.nodes[source].interfaces.find((nic) => nic.name === probed.sourceIface);
    const to = state.nodes[target].interfaces.find((nic) => nic.name === probed.targetIface);
    expect(from).toMatchObject({ role: probed.kind, subnet: probed.subnet });
    expect(to).toMatchObject(probed.kind === "fabric" ? { role: "fabric", subnet: probed.subnet } : { role: "lan" });
    expect(probed.lossPct).toBe(0);
    // The fake nodes answer in well under a millisecond.
    expect(probed.rttMs).toBeGreaterThan(0);
    expect(probed.rttMs).toBeLessThan(1);
  }
}

test(
  "one node: no fabric, and nothing to probe",
  async () => {
    const fleet = await startFleet(1, "ring");
    await expectFullState(fleet, 0);
    await expectTelemetryProtocol(fleet);
    await expectExecTargeting(fleet);

    const probe = await fleet.api("/api/fabric/probe", { source: "spark-0", target: "spark-0" });
    expect(probe.status).toBe(400);
  },
  TEST_TIMEOUT_MS
);

test(
  "four nodes in a mesh: every node reports three fabric interfaces",
  async () => {
    const fleet = await startFleet(4, "mesh");
    const state = await expectFullState(fleet, 3);
    for (const id of fleet.ids) {
      // N-1 links per node, each on its own network: more than the two a Spark pair uses.
      const fabric = state.nodes[id].interfaces.filter((nic) => nic.role === "fabric");
      expect(fabric.length).toBeGreaterThan(2);
      expect(new Set(fabric.map((nic) => nic.subnet)).size).toBe(fabric.length);
    }
    await expectTelemetryProtocol(fleet);
    await expectExecTargeting(fleet);
    await expectProbePaths(fleet, state);
  },
  TEST_TIMEOUT_MS
);

test(
  "eight nodes in a ring: one node drops out and comes back alone",
  async () => {
    const fleet = await startFleet(8, "ring");
    const state = await expectFullState(fleet, 2);
    await expectTelemetryProtocol(fleet);
    await expectExecTargeting(fleet);
    await expectProbePaths(fleet, state);

    const victim = 4;
    const others = fleet.ids.filter((_, i) => i !== victim);
    const dropFile = path.join(fleet.stateDir, `drop-${fleet.hosts[victim]}`);
    writeFileSync(dropFile, "");
    const isDown = async () => {
      const now = await fleet.state();
      return !now.nodes[fleet.ids[victim]].connected && offlineNodes(now).length > 0 && now;
    };
    const down = await until("the dropped node to go offline", isDown);
    expect(offlineNodes(down)).toEqual([fleet.ids[victim]]);
    expect(connectedNodes(down)).toEqual(others);

    // The node must stay down, alone, across one of the server's 2.5 s reconnect attempts. A real
    // delay: that timer runs in the server process, and the expectation is that nothing changes.
    await Bun.sleep(3000);
    const stillDown = await fleet.state();
    expect(offlineNodes(stillDown)).toEqual([fleet.ids[victim]]);
    expect(connectedNodes(stillDown)).toEqual(others);

    rmSync(dropFile);
    const back = await until("the dropped node to reconnect", async () => {
      const now = await fleet.state();
      return now.nodes[fleet.ids[victim]].connected && now;
    });
    expect(offlineNodes(back)).toEqual([]);
    expect(connectedNodes(back)).toEqual(fleet.ids);
  },
  TEST_TIMEOUT_MS
);
