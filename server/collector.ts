import { HISTORY_LIMIT, NODE_IDS } from "../shared/fleet-state";
import type {
  AlertItem,
  ExecResult,
  FabricLink,
  FabricProbeResult,
  FabricTelemetry,
  FleetStatePayload,
  FleetTick,
  HistoryPoint,
  InterfaceRole,
  LocalHostSnapshot,
  NetworkInterfaceMetric,
  NodeId,
  NodeSnapshot,
  NodeTelemetry,
} from "../shared/types";
import { NODES } from "./config";
import { sampleLocalHost } from "./local-host";
import { redactSecrets } from "./redact";
import { readCapped, runSsh, sshCommandArgs } from "./ssh";

const AGENT_SOURCE = new URL("./agent.py", import.meta.url);
const TICK_MS = 1000;
const RECONNECT_DELAY_MS = 2500;
const HOST_PING_INTERVAL_MS = 8000;
const FIRST_PROBE_DELAY_MS = 3000;
const MAX_CONCURRENT_EXECS_PER_NODE = 4;
const MAX_STREAM_STDERR_BYTES = 4096;

const DISK_WARN_PCT = 85;
const DISK_CRITICAL_PCT = 95;
const GPU_HOT_C = 82;
const MEMORY_WARN_PCT = 90;

const GIB = 1024 ** 3;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// macOS ping takes -W in milliseconds, Linux in seconds.
const PING_TIMEOUT_ARGS = process.platform === "darwin" ? ["-W", "1000"] : ["-W", "1"];

/** Thrown when a node already has the maximum number of commands in flight. */
export class FleetBusyError extends Error {}

function perNode<T>(make: (id: NodeId) => T): Record<NodeId, T> {
  return { "spark-0": make("spark-0"), "spark-1": make("spark-1") };
}

function emptySnapshot(id: NodeId): NodeSnapshot {
  const { sshHost, label, role, accent } = NODES[id];
  return {
    id,
    sshHost,
    label,
    role,
    accent,
    connected: false,
    error: "Connecting over SSH...",
    hostRttMs: null,
    hostname: sshHost,
    uptimeSec: 0,
    loadAvg: [0, 0, 0],
    cpu: { usagePct: 0, perCorePct: [], freqMhz: [], iowaitPct: 0 },
    memory: {
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      cachedBytes: 0,
      swapUsedBytes: 0,
      gpuAllocatedBytes: 0,
    },
    gpu: {
      name: "GPU",
      driver: "",
      utilPct: 0,
      tempC: 0,
      tLimitMarginC: null,
      powerW: 0,
      clockGrMhz: 0,
      pstate: "",
      processes: [],
    },
    thermals: [],
    fansRpm: [0, 0],
    disk: {
      device: "",
      totalBytes: 0,
      usedBytes: 0,
      availBytes: 0,
      usedPct: 0,
      readBps: 0,
      writeBps: 0,
    },
    interfaces: [],
    containers: [],
    topProcesses: [],
    ports: [],
  };
}

async function pingOnce(ip: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ping", "-c", "1", ...PING_TIMEOUT_ARGS, ip], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const match = (await new Response(proc.stdout).text()).match(/time=([0-9.]+)\s*ms/);
    return match ? Math.round(parseFloat(match[1]) * 100) / 100 : null;
  } catch {
    return null; // no ping binary on this host
  }
}

function parsePingSummary(output: string): { avgMs: number | null; lossPct: number | null } {
  const rtt = output.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)\//);
  const loss = output.match(/([0-9.]+)% packet loss/);
  return {
    avgMs: rtt ? Math.round(parseFloat(rtt[1]) * 1000) / 1000 : null,
    lossPct: loss ? parseFloat(loss[1]) : null,
  };
}

export class FleetCollector {
  private nodes = perNode(emptySnapshot);
  private history = perNode<HistoryPoint[]>(() => []);
  /** Points recorded since the last tick was sent. */
  private pendingPoints = perNode<HistoryPoint[]>(() => []);
  private activeExecs = perNode(() => 0);
  private streams = new Map<NodeId, Bun.Subprocess>();
  private timers: Timer[] = [];
  private lastProbe: FabricProbeResult | null = null;
  private stopped = false;

  private constructor(
    private readonly onTick: (tick: FleetTick) => void,
    private readonly agentSource: string,
    private localHost: LocalHostSnapshot
  ) {}

  /** Connects to both nodes and starts emitting one tick per second. */
  static async start(onTick: (tick: FleetTick) => void): Promise<FleetCollector> {
    const collector = new FleetCollector(
      onTick,
      await Bun.file(AGENT_SOURCE).text(),
      await sampleLocalHost()
    );
    for (const id of NODE_IDS) void collector.streamNode(id);
    collector.timers.push(
      setInterval(async () => {
        collector.localHost = await sampleLocalHost();
        collector.flush();
      }, TICK_MS),
      setInterval(() => void collector.pingNodes(), HOST_PING_INTERVAL_MS),
      setTimeout(() => {
        collector.runFabricProbe().catch((err) => console.warn("Initial fabric probe failed:", err));
      }, FIRST_PROBE_DELAY_MS)
    );
    return collector;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    for (const proc of this.streams.values()) proc.kill();
  }

  /**
   * Emits a tick with everything gathered since the previous one. Call before
   * sending `getPayload()` to a new client so no point is delivered twice.
   */
  flush(): void {
    const tick: FleetTick = {
      nodes: this.nodes,
      points: this.pendingPoints,
      fabric: this.computeFabric(),
      localHost: this.localHost,
      alerts: this.computeAlerts(),
    };
    this.pendingPoints = perNode<HistoryPoint[]>(() => []);
    this.onTick(tick);
  }

  getPayload(): FleetStatePayload {
    return {
      nodes: this.nodes,
      history: this.history,
      fabric: this.computeFabric(),
      localHost: this.localHost,
      alerts: this.computeAlerts(),
    };
  }

  /** Runs the agent on a node for as long as the collector lives, reconnecting on failure. */
  private async streamNode(id: NodeId): Promise<void> {
    while (!this.stopped) {
      // The script arrives on stdin, so it never appears in the node's process list.
      const proc = Bun.spawn(sshCommandArgs(NODES[id].sshHost, "python3 -u -"), {
        stdin: new Blob([this.agentSource]),
        stdout: "pipe",
        stderr: "pipe",
      });
      this.streams.set(id, proc);

      const [, stderr, exitCode] = await Promise.all([
        this.consumeTelemetry(id, proc.stdout),
        readCapped(proc.stderr, MAX_STREAM_STDERR_BYTES),
        proc.exited,
      ]);
      if (this.stopped) return;

      const reason = stderr.text.trim().split("\n").pop() || `exit code ${exitCode}`;
      this.nodes[id].connected = false;
      this.nodes[id].error = `SSH stream ended (${reason}). Reconnecting...`;
      await Bun.sleep(RECONNECT_DELAY_MS);
    }
  }

  private async consumeTelemetry(id: NodeId, stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        // Login banners and shell noise can precede the agent's JSON lines.
        if (!line.startsWith("{")) continue;
        let telemetry: NodeTelemetry;
        try {
          telemetry = JSON.parse(line) as NodeTelemetry;
        } catch {
          continue; // a line cut short by a dropped connection
        }
        this.ingest(id, telemetry);
      }
    }
  }

  private ingest(id: NodeId, telemetry: NodeTelemetry): void {
    const node: NodeSnapshot = {
      ...this.nodes[id],
      ...telemetry,
      gpu: {
        ...telemetry.gpu,
        processes: telemetry.gpu.processes.map((p) => ({ ...p, cmdline: redactSecrets(p.cmdline) })),
      },
      topProcesses: telemetry.topProcesses.map((p) => ({ ...p, args: redactSecrets(p.args) })),
      connected: true,
      error: null,
    };
    this.nodes[id] = node;

    const point: HistoryPoint = {
      gpuUtil: node.gpu.utilPct,
      gpuPowerW: node.gpu.powerW,
      gpuTempC: node.gpu.tempC,
      cpuUtil: node.cpu.usagePct,
      memUsedGb: Math.round((node.memory.usedBytes / GIB) * 100) / 100,
      fabricBps: node.interfaces.reduce(
        (sum, i) => (i.role === "lan" ? sum : sum + i.rxBps + i.txBps),
        0
      ),
    };
    this.pendingPoints[id].push(point);
    const history = this.history[id];
    history.push(point);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  }

  private iface(id: NodeId, role: InterfaceRole): NetworkInterfaceMetric | undefined {
    return this.nodes[id].interfaces.find((i) => i.role === role);
  }

  private computeFabric(): FabricTelemetry {
    const link = (role: "fabric-a" | "fabric-b"): FabricLink => {
      const a = this.iface("spark-0", role);
      const b = this.iface("spark-1", role);
      const endsUp = [a, b].filter((i) => i?.operstate === "up").length;
      return {
        subnet: a?.subnet || b?.subnet || "",
        speedGbps: Math.max(a?.speedMbps ?? 0, b?.speedMbps ?? 0) / 1000,
        state: endsUp === 2 ? "ACTIVE" : endsUp === 1 ? "DEGRADED" : "DOWN",
        // Each direction is seen by both ends; take whichever counter moved more.
        spark0To1Bps: Math.max(a?.txBps ?? 0, b?.rxBps ?? 0),
        spark1To0Bps: Math.max(b?.txBps ?? 0, a?.rxBps ?? 0),
        totalBytesTransferred: (a?.rxBytes ?? 0) + (a?.txBytes ?? 0),
        netdevs: [a?.name ?? "", b?.name ?? ""],
      };
    };
    const linkA = link("fabric-a");
    const linkB = link("fabric-b");
    return {
      linkA,
      linkB,
      combinedThroughputBps:
        linkA.spark0To1Bps + linkA.spark1To0Bps + linkB.spark0To1Bps + linkB.spark1To0Bps,
      lastProbe: this.lastProbe,
    };
  }

  private computeAlerts(): AlertItem[] {
    const alerts: AlertItem[] = [];
    for (const id of NODE_IDS) {
      const n = this.nodes[id];
      if (!n.connected) {
        alerts.push({
          id: `${id}-offline`,
          severity: "critical",
          kind: "offline",
          nodeId: id,
          title: `${n.label} SSH stream offline`,
          detail: n.error ?? "Unable to reach node",
          metric: "OFFLINE",
        });
        continue;
      }
      if (n.disk.usedPct >= DISK_WARN_PCT) {
        const critical = n.disk.usedPct >= DISK_CRITICAL_PCT;
        alerts.push({
          id: `${id}-disk`,
          severity: critical ? "critical" : "warn",
          kind: "disk",
          nodeId: id,
          title: `${n.label} disk ${critical ? "critically full" : "filling up"}`,
          detail: `${(n.disk.availBytes / GIB).toFixed(1)} GB writable space left on / (${n.disk.device})`,
          metric: `${n.disk.usedPct.toFixed(1)}%`,
        });
      }
      if (n.gpu.tempC >= GPU_HOT_C) {
        alerts.push({
          id: `${id}-gpu-temp`,
          severity: "critical",
          kind: "thermal",
          nodeId: id,
          title: `${n.label} GPU running hot`,
          detail: `${n.gpu.name} die temperature at ${n.gpu.tempC}°C`,
          metric: `${n.gpu.tempC}°C`,
        });
      }
      const memPct = n.memory.totalBytes > 0 ? (n.memory.usedBytes / n.memory.totalBytes) * 100 : 0;
      if (memPct >= MEMORY_WARN_PCT) {
        alerts.push({
          id: `${id}-memory`,
          severity: "warn",
          kind: "memory",
          nodeId: id,
          title: `${n.label} memory pressure`,
          detail: `${(n.memory.availableBytes / GIB).toFixed(1)} GB memory available`,
          metric: `${memPct.toFixed(0)}%`,
        });
      }
    }
    return alerts;
  }

  async execOnNode(id: NodeId, command: string, timeoutMs = 20000): Promise<ExecResult> {
    if (this.activeExecs[id] >= MAX_CONCURRENT_EXECS_PER_NODE) {
      throw new FleetBusyError(
        `${this.nodes[id].label} already has ${MAX_CONCURRENT_EXECS_PER_NODE} commands running`
      );
    }
    const { sshHost } = NODES[id];
    this.activeExecs[id]++;
    try {
      return { nodeId: id, sshHost, ...(await runSsh(sshHost, command, timeoutMs)) };
    } finally {
      this.activeExecs[id]--;
    }
  }

  /** The node's address for a role, only if it is safe to place in a command line. */
  private address(id: NodeId, role: InterfaceRole): string {
    const ip = this.iface(id, role)?.ip ?? "";
    return IPV4.test(ip) ? ip : "";
  }

  private async pingNodes(): Promise<void> {
    await Promise.all(
      NODE_IDS.map(async (id) => {
        const ip = this.address(id, "lan");
        const rtt = ip ? await pingOnce(ip) : null;
        this.nodes[id].hostRttMs = rtt;
      })
    );
  }

  /** Pings spark-1 from spark-0 over each fabric link and the LAN. */
  async runFabricProbe(): Promise<FabricProbeResult> {
    const section = (tag: string, role: InterfaceRole, count: number) => {
      const ip = this.address("spark-1", role);
      const ping = ip ? `; ping -c ${count} -i 0.2 -W 1 ${ip} 2>&1 || true` : "";
      return `echo '===${tag}==='${ping}`;
    };
    const { stdout } = await this.execOnNode(
      "spark-0",
      [section("A", "fabric-a", 4), section("B", "fabric-b", 4), section("LAN", "lan", 3)].join("; "),
      12000
    );
    const summary = (tag: string) =>
      parsePingSummary(stdout.match(new RegExp(`===${tag}===\\n([\\s\\S]*?)(?====[A-Z]+===|$)`))?.[1] ?? "");

    const a = summary("A");
    const b = summary("B");
    this.lastProbe = {
      ts: Date.now(),
      fabricAPingMs: a.avgMs,
      fabricBPingMs: b.avgMs,
      lanPingMs: summary("LAN").avgMs,
      fabricALossPct: a.lossPct,
      fabricBLossPct: b.lossPct,
    };
    this.flush();
    return this.lastProbe;
  }
}
