import type {
  AlertItem,
  ExecResult,
  FabricProbeResult,
  FabricTelemetry,
  FleetStatePayload,
  HistoryPoint,
  LocalHostSnapshot,
  NodeId,
  NodeSnapshot,
} from "../shared/types";
import { HISTORY_LIMIT, NODE_IDS, NODES } from "./config";
import { REMOTE_TELEMETRY_AGENT_PY } from "./remote-agent";
import { initLocalHostMeta, sampleLocalHost } from "./local-host";

const SSH_BASE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "StrictHostKeyChecking=no",
];

function emptySnapshot(id: NodeId): NodeSnapshot {
  const cfg = NODES[id];
  return {
    id,
    sshHost: cfg.sshHost,
    label: cfg.label,
    role: cfg.role,
    accent: cfg.accent,
    connected: false,
    error: "Connecting over SSH...",
    lastUpdated: 0,
    sshRttMs: null,
    hostname: cfg.sshHost,
    kernel: "",
    uptimeSec: 0,
    loadAvg: [0, 0, 0],
    cpu: { cores: 20, usagePct: 0, perCorePct: [], freqMhz: [], iowaitPct: 0 },
    memory: {
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      cachedBytes: 0,
      buffersBytes: 0,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      gpuAllocatedBytes: 0,
    },
    gpu: {
      name: "NVIDIA GB10",
      driver: "",
      utilPct: 0,
      memUtilPct: 0,
      tempC: 0,
      tLimitMarginC: null,
      powerW: 0,
      clockGrMhz: 0,
      pstate: "P0",
      processes: [],
    },
    thermals: [],
    fansRpm: [0, 0],
    disk: {
      mount: "/",
      device: "/dev/nvme0n1p2",
      totalBytes: 0,
      usedBytes: 0,
      availBytes: 0,
      usedPct: 0,
      readBps: 0,
      writeBps: 0,
    },
    interfaces: [],
    rdmaLinks: [],
    containers: [],
    topProcesses: [],
    ports: [],
  };
}

export class FleetCollector {
  private nodes: Record<NodeId, NodeSnapshot> = {
    "spark-0": emptySnapshot("spark-0"),
    "spark-1": emptySnapshot("spark-1"),
  };

  private history: Record<NodeId, HistoryPoint[]> = {
    "spark-0": [],
    "spark-1": [],
  };

  private localHost: LocalHostSnapshot = {
    hostname: "localhost",
    chip: "Local Host",
    osVersion: process.platform,
    memTotalBytes: 0,
    memUsedBytes: 0,
    cpuUsagePct: 0,
    loadAvg: [0, 0, 0],
    uptimeSec: 0,
    tailscaleSelfIp: "",
    lastUpdated: Date.now(),
  };

  private lastProbe: FabricProbeResult | null = null;
  private listeners = new Set<(payload: FleetStatePayload) => void>();
  private procs = new Map<NodeId, Bun.Subprocess>();
  private stopped = false;

  async start(): Promise<void> {
    await initLocalHostMeta();
    this.localHost = await sampleLocalHost();

    for (const id of NODE_IDS) {
      this.spawnNodeStream(id);
    }

    // Periodic local host sample + broadcast at 1Hz
    setInterval(async () => {
      if (this.stopped) return;
      this.localHost = await sampleLocalHost();
      this.broadcast();
    }, 1000);

    // Periodic SSH RTT ping every 8s
    const pingLoop = async () => {
      if (this.stopped) return;
      await Promise.all(
        NODE_IDS.map(async (id) => {
          const lan =
            this.nodes[id].interfaces.find((i) => i.role === "lan")?.ip ||
            NODES[id].lanIp ||
            NODES[id].sshHost;
          const rtt = lan ? await this.measureMacPing(lan) : null;
          this.nodes[id].sshRttMs = rtt;
        })
      );
    };
    pingLoop();
    setInterval(pingLoop, 8000);

    // Initial fabric probe after 3s
    setTimeout(() => {
      this.runFabricProbe().catch(() => {});
    }, 3000);
  }

  subscribe(fn: (payload: FleetStatePayload) => void): () => void {
    this.listeners.add(fn);
    fn(this.getPayload());
    return () => this.listeners.delete(fn);
  }

  private broadcast(): void {
    if (this.listeners.size === 0) return;
    const payload = this.getPayload();
    for (const fn of this.listeners) {
      try {
        fn(payload);
      } catch {
        // ignore listener failure
      }
    }
  }

  private spawnNodeStream(id: NodeId): void {
    if (this.stopped) return;
    const cfg = NODES[id];
    const encoded = Buffer.from(REMOTE_TELEMETRY_AGENT_PY, "utf8").toString("base64");
    const remoteCmd = `python3 -u -c "import base64; exec(base64.b64decode('${encoded}').decode())"`;

    const proc = Bun.spawn(["ssh", ...SSH_BASE_ARGS, cfg.sshHost, remoteCmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    this.procs.set(id, proc);

    this.readNodeStdout(id, proc.stdout);
    this.readNodeStderr(id, proc.stderr);

    proc.exited.then((code) => {
      if (this.stopped) return;
      this.nodes[id].connected = false;
      this.nodes[id].error = `SSH stream disconnected (exit ${code}), reconnecting...`;
      this.broadcast();
      setTimeout(() => this.spawnNodeStream(id), 2500);
    });
  }

  private async readNodeStdout(id: NodeId, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("{")) {
            this.ingestTelemetryLine(id, line);
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch {
      // handled by exit watcher
    }
  }

  private async readNodeStderr(id: NodeId, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const msg = decoder.decode(value, { stream: true }).trim();
        if (msg && !this.nodes[id].connected) {
          this.nodes[id].error = msg.slice(0, 180);
        }
      }
    } catch {
      // ignore
    }
  }

  private ingestTelemetryLine(id: NodeId, raw: string): void {
    try {
      const data = JSON.parse(raw);
      const prev = this.nodes[id];
      const next: NodeSnapshot = {
        ...prev,
        connected: true,
        error: null,
        lastUpdated: Date.now(),
        hostname: data.hostname ?? prev.hostname,
        kernel: data.kernel ?? prev.kernel,
        uptimeSec: data.uptimeSec ?? 0,
        loadAvg: data.loadAvg ?? [0, 0, 0],
        cpu: data.cpu ?? prev.cpu,
        memory: data.memory ?? prev.memory,
        gpu: data.gpu ?? prev.gpu,
        thermals: data.thermals ?? [],
        fansRpm: data.fansRpm ?? [0, 0],
        disk: data.disk ?? prev.disk,
        interfaces: data.interfaces ?? [],
        rdmaLinks: data.rdmaLinks ?? [],
        containers: data.containers ?? [],
        topProcesses: data.topProcesses ?? [],
        ports: data.ports ?? [],
      };
      this.nodes[id] = next;

      const fabricIfs = next.interfaces.filter(
        (i) => i.role === "fabric-a" || i.role === "fabric-b"
      );
      const lanIf = next.interfaces.find((i) => i.role === "lan");
      const fabricRx = fabricIfs.reduce((a, b) => a + b.rxBps, 0);
      const fabricTx = fabricIfs.reduce((a, b) => a + b.txBps, 0);

      const point: HistoryPoint = {
        ts: Date.now(),
        gpuUtil: next.gpu.utilPct,
        gpuPowerW: next.gpu.powerW,
        gpuTempC: next.gpu.tempC,
        gpuClockMhz: next.gpu.clockGrMhz,
        cpuUtil: next.cpu.usagePct,
        memUsedGb: Math.round((next.memory.usedBytes / 1024 ** 3) * 100) / 100,
        gpuMemGb: Math.round((next.memory.gpuAllocatedBytes / 1024 ** 3) * 100) / 100,
        fabricRxBps: fabricRx,
        fabricTxBps: fabricTx,
        lanRxBps: lanIf?.rxBps ?? 0,
        lanTxBps: lanIf?.txBps ?? 0,
        diskReadBps: next.disk.readBps,
        diskWriteBps: next.disk.writeBps,
        fanRpmAvg: Math.round((next.fansRpm[0] + next.fansRpm[1]) / 2),
      };

      const arr = this.history[id];
      arr.push(point);
      if (arr.length > HISTORY_LIMIT) {
        arr.splice(0, arr.length - HISTORY_LIMIT);
      }
    } catch {
      // ignore malformed line
    }
  }

  private computeFabric(): FabricTelemetry {
    const s0 = this.nodes["spark-0"];
    const s1 = this.nodes["spark-1"];

    const s0A = s0.interfaces.find((i) => i.role === "fabric-a");
    const s1A = s1.interfaces.find((i) => i.role === "fabric-a");
    const s0B = s0.interfaces.find((i) => i.role === "fabric-b");
    const s1B = s1.interfaces.find((i) => i.role === "fabric-b");

    const linkState = (
      a?: { operstate: string },
      b?: { operstate: string }
    ): "ACTIVE" | "DEGRADED" | "DOWN" => {
      const aUp = a?.operstate === "up";
      const bUp = b?.operstate === "up";
      if (aUp && bUp) return "ACTIVE";
      if (aUp || bUp) return "DEGRADED";
      return "DOWN";
    };

    const a0to1 = Math.max(s0A?.txBps ?? 0, s1A?.rxBps ?? 0);
    const a1to0 = Math.max(s1A?.txBps ?? 0, s0A?.rxBps ?? 0);
    const b0to1 = Math.max(s0B?.txBps ?? 0, s1B?.rxBps ?? 0);
    const b1to0 = Math.max(s1B?.txBps ?? 0, s0B?.rxBps ?? 0);

    const ipToSubnet = (ip?: string): string => {
      if (!ip) return "auto-detect";
      const parts = ip.split(".");
      return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
    };

    return {
      linkA: {
        subnet: ipToSubnet(s0A?.ip || s1A?.ip || NODES["spark-0"].fabricIps[0]),
        speedGbps: Math.round(Math.max(s0A?.speedMbps ?? 200000, s1A?.speedMbps ?? 200000) / 1000),
        state: linkState(s0A, s1A),
        spark0To1Bps: a0to1,
        spark1To0Bps: a1to0,
        totalBytesTransferred: (s0A?.rxBytes ?? 0) + (s0A?.txBytes ?? 0),
      },
      linkB: {
        subnet: ipToSubnet(s0B?.ip || s1B?.ip || NODES["spark-0"].fabricIps[1]),
        speedGbps: Math.round(Math.max(s0B?.speedMbps ?? 200000, s1B?.speedMbps ?? 200000) / 1000),
        state: linkState(s0B, s1B),
        spark0To1Bps: b0to1,
        spark1To0Bps: b1to0,
        totalBytesTransferred: (s0B?.rxBytes ?? 0) + (s0B?.txBytes ?? 0),
      },
      combinedThroughputBps: a0to1 + a1to0 + b0to1 + b1to0,
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
          nodeId: id,
          title: `${n.label} SSH stream offline`,
          detail: n.error ?? "Unable to reach node",
          metric: "OFFLINE",
        });
        continue;
      }
      if (n.disk.usedPct >= 95) {
        const freeGb = (n.disk.availBytes / 1024 ** 3).toFixed(1);
        alerts.push({
          id: `${id}-disk-crit`,
          severity: "critical",
          nodeId: id,
          title: `${n.label} NVMe critically full`,
          detail: `Only ${freeGb} GB free on / (${n.disk.device}) — risk of model/container write failure`,
          metric: `${n.disk.usedPct.toFixed(1)}%`,
        });
      } else if (n.disk.usedPct >= 85) {
        alerts.push({
          id: `${id}-disk-warn`,
          severity: "warn",
          nodeId: id,
          title: `${n.label} NVMe capacity high`,
          detail: `Root filesystem exceeds 85% utilization`,
          metric: `${n.disk.usedPct.toFixed(1)}%`,
        });
      }
      if (n.gpu.tempC >= 82) {
        alerts.push({
          id: `${id}-gpu-temp`,
          severity: "critical",
          nodeId: id,
          title: `${n.label} GB10 thermal throttle zone`,
          detail: `GPU die temperature at ${n.gpu.tempC}°C`,
          metric: `${n.gpu.tempC}°C`,
        });
      }
      const memPct = n.memory.totalBytes > 0 ? (n.memory.usedBytes / n.memory.totalBytes) * 100 : 0;
      if (memPct >= 90) {
        alerts.push({
          id: `${id}-mem-high`,
          severity: "warn",
          nodeId: id,
          title: `${n.label} UMA memory pressure`,
          detail: `${(n.memory.availableBytes / 1024 ** 3).toFixed(1)} GB unified memory remaining`,
          metric: `${memPct.toFixed(0)}%`,
        });
      }
    }
    return alerts;
  }

  getPayload(): FleetStatePayload {
    return {
      ts: Date.now(),
      nodes: this.nodes,
      history: this.history,
      fabric: this.computeFabric(),
      localHost: this.localHost,
      alerts: this.computeAlerts(),
    };
  }

  async execOnNode(id: NodeId, command: string, timeoutMs = 20000): Promise<ExecResult> {
    const cfg = NODES[id];
    const started = Date.now();
    const proc = Bun.spawn(["ssh", ...SSH_BASE_ARGS, cfg.sshHost, command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    return {
      nodeId: id,
      sshHost: cfg.sshHost,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  }

  private async measureMacPing(ip: string): Promise<number | null> {
    try {
      const proc = Bun.spawn(["ping", "-c", "1", "-W", "1000", ip], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const m = out.match(/time=([0-9.]+)\s*ms/);
      return m ? Math.round(parseFloat(m[1]) * 100) / 100 : null;
    } catch {
      return null;
    }
  }

  async runFabricProbe(): Promise<FabricProbeResult> {
    const parseLinuxPing = (out: string) => {
      const rtt = out.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)\//);
      const loss = out.match(/([0-9.]+)% packet loss/);
      return {
        avgMs: rtt ? Math.round(parseFloat(rtt[1]) * 1000) / 1000 : null,
        lossPct: loss ? parseFloat(loss[1]) : null,
      };
    };

    const s0Lan =
      this.nodes["spark-0"].interfaces.find((i) => i.role === "lan")?.ip ||
      NODES["spark-0"].lanIp ||
      NODES["spark-0"].sshHost;
    const s1Lan =
      this.nodes["spark-1"].interfaces.find((i) => i.role === "lan")?.ip ||
      NODES["spark-1"].lanIp ||
      NODES["spark-1"].sshHost;
    const s1FabA =
      this.nodes["spark-1"].interfaces.find((i) => i.role === "fabric-a")?.ip ||
      NODES["spark-1"].fabricIps[0] ||
      "";
    const s1FabB =
      this.nodes["spark-1"].interfaces.find((i) => i.role === "fabric-b")?.ip ||
      NODES["spark-1"].fabricIps[1] ||
      "";

    const probeCmds = [
      s1FabA ? `echo '===A==='; ping -c 4 -i 0.2 -W 1 ${s1FabA} 2>&1 || true` : "echo '===A==='",
      s1FabB ? `echo '===B==='; ping -c 4 -i 0.2 -W 1 ${s1FabB} 2>&1 || true` : "echo '===B==='",
      s1Lan ? `echo '===LAN==='; ping -c 3 -i 0.2 -W 1 ${s1Lan} 2>&1 || true` : "echo '===LAN==='",
      "echo '===RDMA==='; rdma link 2>&1 || true",
    ].join("; ");

    const [mac0, mac1, fabricRes] = await Promise.all([
      s0Lan ? this.measureMacPing(s0Lan) : Promise.resolve(null),
      s1Lan ? this.measureMacPing(s1Lan) : Promise.resolve(null),
      this.execOnNode("spark-0", probeCmds, 12000),
    ]);

    const raw = fabricRes.stdout;
    const seg = (tag: string) => {
      const re = new RegExp(`===${tag}===\\n([\\s\\S]*?)(?====[A-Z]+===|$)`);
      return raw.match(re)?.[1] ?? "";
    };

    const pA = parseLinuxPing(seg("A"));
    const pB = parseLinuxPing(seg("B"));
    const pL = parseLinuxPing(seg("LAN"));
    const rdmaLines = seg("RDMA")
      .split("\n")
      .filter((l) => l.includes("ACTIVE"))
      .map((l) => l.trim())
      .join(" | ");

    this.lastProbe = {
      ts: Date.now(),
      fabricAPingMs: pA.avgMs,
      fabricBPingMs: pB.avgMs,
      lanPingMs: pL.avgMs,
      macToSpark0Ms: mac0,
      macToSpark1Ms: mac1,
      fabricALossPct: pA.lossPct,
      fabricBLossPct: pB.lossPct,
      rdmaSummary: rdmaLines || "No ACTIVE RoCE links detected",
    };

    this.broadcast();
    return this.lastProbe;
  }

  stop(): void {
    this.stopped = true;
    for (const proc of this.procs.values()) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }
}
