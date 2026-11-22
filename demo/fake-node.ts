/**
 * Stands in for `ssh` in the demo and the fleet integration test (see bin/ssh).
 * It answers as a synthetic DGX Spark: it opens no connection, never runs the
 * command it receives, and reads nothing about the machine it runs on.
 *
 * Environment:
 *   FAKE_FLEET_SIZE   nodes in the fleet, 1-8 (default 2); decides the fabric wiring
 *   FAKE_TOPOLOGY     ring (default), mesh or switch
 *   FAKE_INTERVAL_MS  telemetry period (default 1000)
 *   FAKE_STATE_DIR    optional; a file `drop-<host>` there takes that node offline,
 *                     and every one-shot command is recorded in `commands.log`
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ContainerInfo,
  ListeningPort,
  NetworkInterfaceMetric,
  NodeTelemetry,
  TopProcess,
} from "../shared/types";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DAY_SEC = 86400;
const TOPOLOGIES = ["ring", "mesh", "switch"];
const GPU_NAME = "NVIDIA GB10";
const DRIVER = "580.95.05";
const VLLM_IMAGE = "nvcr.io/nvidia/vllm:25.09-py3";
const PYTORCH_IMAGE = "nvcr.io/nvidia/pytorch:25.09-py3";
const VLLM_CMD =
  "python3 -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-3.3-70B-Instruct --tensor-parallel-size 2 --port 8000";
const FABRIC_NAMES = ["enp1s0f0np0", "enp1s0f1np1", "enP2p1s0f0np0", "enP2p1s0f1np1"];
const IDLE_SEC = 12;
const RAMP_SEC = 15;
/** Samples between refreshes of the process list, as in server/agent.py. */
const SLOW_EVERY = 4;

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const [host = "", ...commandWords] = separator === -1 ? [] : args.slice(separator + 1);
const command = commandWords.join(" ");
const size = Math.min(8, Math.max(1, Math.floor(Number(process.env.FAKE_FLEET_SIZE) || 2)));
const topology = process.env.FAKE_TOPOLOGY || "ring";
const intervalMs = Math.max(20, Number(process.env.FAKE_INTERVAL_MS) || 1000);
const stateDir = process.env.FAKE_STATE_DIR;
/** Zero-based: the trailing number of the host, minus one (`demo-spark-3` is 2). */
const index = Number(/\d+$/.exec(host)?.[0] ?? 0) - 1;
const hostname = `spark-0${index + 1}`;

const offline = () => !!stateDir && existsSync(join(stateDir, `drop-${host}`));

// --- Deterministic noise ------------------------------------------------------

/** Smooth noise in [-1, 1]. The same seed and time give the same value in every process. */
const wave = (seed: number, t: number) => 0.6 * Math.sin(t / 7 + seed) + 0.4 * Math.sin(t / 2.3 + seed * 1.7);
/** A stable value in [0, 1) for a seed. */
const hash01 = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const lerp = (from: number, to: number, k: number) => from + (to - from) * k;
const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

/** 0 while idle, 1 under full load; `age` is seconds since the stream started. */
function loadAt(age: number): number {
  const k = Math.min(1, Math.max(0, (age - IDLE_SEC) / RAMP_SEC));
  return k * k * (3 - 2 * k);
}

// --- Network ------------------------------------------------------------------

interface Port extends Pick<NetworkInterfaceMetric, "name" | "role" | "ip" | "subnet" | "speedMbps"> {
  /** Highest rate in bytes per second. */
  peak: number;
  /** Both ends of a link hold the same two seeds, swapped, so one's transmit is the other's receive. */
  txSeed: number;
  rxSeed: number;
}

/** This node's end of each fabric link. Flow numbers name a direction on the link. */
function fabricLinks(): { link: number; octet: number; txFlow: number; rxFlow: number }[] {
  if (topology === "switch") {
    // Each node sends to its successor, so transmit and receive balance across the fleet.
    return [{ link: 0, octet: 11 + index, txFlow: index, rxFlow: (index + size - 1) % size }];
  }
  const pairs: [number, number][] = [];
  if (topology === "mesh") {
    for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) pairs.push([a, b]);
  } else if (size > 1) {
    // Two nodes get two parallel links: the ring closes over the same pair.
    for (let k = 0; k < size; k++) pairs.push([k, (k + 1) % size]);
  }
  return pairs.flatMap((pair, link) => {
    if (!pair.includes(index)) return [];
    const lower = index === Math.min(...pair);
    return [{ link, octet: lower ? 1 : 2, txFlow: lower ? 0 : 1, rxFlow: lower ? 1 : 0 }];
  });
}

function networkPorts(): Port[] {
  const flowSeed = (link: number, flow: number) => link * 7.3 + flow * 2.9;
  return [
    {
      name: "enP7s7",
      role: "lan",
      ip: `10.0.0.${11 + index}`,
      subnet: "10.0.0.0/24",
      speedMbps: 10000,
      peak: 2.5e5,
      txSeed: 500 + index * 3.1,
      rxSeed: 501.7 + index * 3.1,
    },
    ...fabricLinks().map(({ link, octet, txFlow, rxFlow }, slot): Port => ({
      name: FABRIC_NAMES[slot] ?? `enp3s0f${slot - 4}np${slot - 4}`,
      role: "fabric",
      ip: `192.168.${100 + link}.${octet}`,
      subnet: `192.168.${100 + link}.0/24`,
      speedMbps: 200000,
      // Link 0 carries the inference traffic; the others only see chatter.
      peak: (link === 0 ? 5.8e9 : 21e6) / 8,
      txSeed: flowSeed(link, txFlow),
      rxSeed: flowSeed(link, rxFlow),
    })),
  ];
}

/** Bytes per second in one direction: a trickle while idle, most of `peak` under load, never above it. */
function flowRate(peak: number, seed: number, t: number, load: number): number {
  return lerp(1000 * (1.2 + wave(seed + 1, t)), peak * (0.78 + 0.22 * wave(seed, t)), load);
}

// --- Node identity ------------------------------------------------------------

/** Where the GPU settles for a given load; the stream adds thermal lag on top. */
function gpuReading(t: number, load: number): { utilPct: number; powerW: number; tempC: number } {
  const seed = 40 + index * 1.9;
  return {
    utilPct: Math.round(lerp(1.5 + 1.5 * wave(seed, t), 94 + 4 * wave(seed, t), load)),
    powerW: round(lerp(12 + 0.6 * wave(seed + 1, t), 44 + 4 * wave(seed + 1, t), load), 2),
    tempC: lerp(45, 69 + 3 * wave(seed + 2, t), load),
  };
}

/** Root filesystem sizes in GiB. Node 2 is the one nearly full disk in the fleet. */
function diskGib(): { total: number; avail: number } {
  if (index === 1) return { total: 916, avail: 118.4 };
  const total = 3.67 * 1024;
  return { total, avail: total * (index === 0 ? 0.39 : 0.53 - 0.01 * index) };
}

function containerList(): ContainerInfo[] {
  const row = (name: string, image: string, status: string, ports = ""): ContainerInfo => {
    const seed = [...`${index}${name}`].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 1e9, 7);
    return {
      id: Math.floor(hash01(seed) * 16 ** 12).toString(16).padStart(12, "0"),
      name,
      image,
      state: status.startsWith("Up") ? "running" : "exited",
      status,
      ports,
    };
  };
  // Running first, then by name: the order server/agent.py reports.
  if (index > 0) {
    return [
      row(`vllm-rank${index}`, VLLM_IMAGE, "Up 5 days"),
      row("comfyui", "local/comfyui:cu126", "Exited (137) 4 days ago"),
    ];
  }
  return [
    row("open-webui", "ghcr.io/open-webui/open-webui:main", "Up 6 days (healthy)", "0.0.0.0:3000->8080/tcp"),
    row("searxng", "searxng/searxng:latest", "Up 6 days", "0.0.0.0:8080->8080/tcp"),
    row("vllm-rank0", VLLM_IMAGE, "Up 5 days"),
    row("finetune-lora", PYTORCH_IMAGE, "Exited (1) 2 days ago"),
    row("pytorch-notebook", PYTORCH_IMAGE, "Exited (0) 3 days ago"),
  ];
}

function listeningPorts(): ListeningPort[] {
  const ports: ListeningPort[] = [
    { addr: "0.0.0.0", port: 22, process: "sshd" },
    { addr: "127.0.0.53%lo", port: 53, process: "systemd-resolve" },
    { addr: "0.0.0.0", port: 111, process: "rpcbind" },
    { addr: "127.0.0.1", port: 631, process: "cupsd" },
    { addr: "0.0.0.0", port: 8000, process: "python3" },
    { addr: "127.0.0.1", port: 11000, process: "dgx-dashboard" },
  ];
  if (index === 0) {
    ports.push(
      { addr: "0.0.0.0", port: 3000, process: "docker-proxy" },
      { addr: "0.0.0.0", port: 8080, process: "docker-proxy" }
    );
  }
  return ports.sort((a, b) => a.port - b.port);
}

function topProcesses(t: number, load: number): TopProcess[] {
  const row = (pid: number, cpuPct: number, rssMib: number, comm: string, args: string): TopProcess => ({
    pid,
    cpuPct,
    rssBytes: rssMib * MIB,
    comm,
    args,
  });
  return [
    row(4127 + index * 13, round(lerp(4, 236, load) + 3 * wave(index, t), 1), 9870 + index * 21, "python3", VLLM_CMD),
    row(2310, 0.6, 214, "dockerd", "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock"),
    row(3541, 0.4, 187, "gnome-shell", "/usr/bin/gnome-shell"),
    row(1989, 0.3, 96, "containerd", "/usr/bin/containerd"),
    row(1422, 0.1, 88, "systemd-journal", "/usr/lib/systemd/systemd-journald"),
    row(2977, 0.2, 71, "Xorg", "/usr/lib/xorg/Xorg vt2 -displayfd 3 -nolisten tcp"),
    row(1877, 0, 42, "nvidia-persiste", "/usr/bin/nvidia-persistenced --user nvidia-persistenced"),
    row(2244, 0, 23, "NetworkManager", "/usr/sbin/NetworkManager --no-daemon"),
  ];
}

// --- Telemetry stream ---------------------------------------------------------

/** Returns a sampler; each call is one line of the agent's output. */
function telemetrySource(): () => NodeTelemetry {
  const started = Date.now();
  const ports = networkPorts();
  const containers = containerList();
  const listening = listeningPorts();
  const disk = diskGib();
  const diskTotal = Math.round(disk.total * GIB);
  const diskAvail = Math.round(disk.avail * GIB);
  const memoryTotal = Math.round(121.7 * GIB);
  const gpuMemoryMib = 57984 + index * 32;
  // Counters start from a wall-clock baseline, so they look days old and a
  // restarted stream resumes near where the last one stopped.
  const clock = 5.5 * DAY_SEC + ((started / 1000) % DAY_SEC);
  const baseline = (peak: number, seed: number) => clock * peak * (0.8 + 0.2 * hash01(seed));
  const counters = ports.map((p) => ({ rx: baseline(p.peak, p.rxSeed), tx: baseline(p.peak, p.txSeed) }));
  let last = started;
  let samples = 0;
  let dieTempC = 45;
  let top: TopProcess[] = [];

  return () => {
    const now = Date.now();
    const t = now / 1000;
    const dt = (now - last) / 1000;
    last = now;
    const load = loadAt((now - started) / 1000);
    const seed = 80 + index * 2.3;

    const gpu = gpuReading(t, load);
    // The die warms and cools a few seconds behind the power draw.
    dieTempC += (gpu.tempC - dieTempC) * (1 - Math.exp(-dt / 6));
    const tempC = Math.round(dieTempC);
    // Containers and ports never change here; the process list refreshes on the agent's slow cadence.
    if (samples++ % SLOW_EVERY === 0) top = topProcesses(t, load);

    const perCorePct = Array.from({ length: 20 }, (_, core) => {
      const coreSeed = index * 31 + core;
      const busy = hash01(coreSeed + 0.5) * (0.4 + 0.6 * load) + 0.1 * wave(coreSeed, t);
      return round(5 + 65 * Math.min(1, Math.max(0, busy)), 1);
    });
    const usagePct = round(perCorePct.reduce((sum, pct) => sum + pct, 0) / perCorePct.length, 1);
    const usedBytes = Math.round((67.4 + 0.3 * index + 2.6 * load + 0.25 * wave(seed, t)) * GIB);

    return {
      hostname,
      uptimeSec: Math.floor(clock + index * 137 + (now - started) / 1000),
      loadAvg: [round(usagePct / 5, 2), round(usagePct / 5.4, 2), round(usagePct / 5.9, 2)],
      cpu: {
        usagePct,
        perCorePct,
        // Ten efficiency cores, then ten performance cores.
        freqMhz: perCorePct.map((pct, core) => Math.round(lerp(1378, core < 10 ? 2808 : 3900, pct / 70))),
        iowaitPct: round(0.4 + 0.3 * wave(seed + 1, t), 1),
      },
      memory: {
        totalBytes: memoryTotal,
        usedBytes,
        availableBytes: memoryTotal - usedBytes,
        cachedBytes: Math.round(31.6 * GIB),
        swapUsedBytes: 0,
        gpuAllocatedBytes: gpuMemoryMib * MIB,
      },
      gpu: {
        name: GPU_NAME,
        driver: DRIVER,
        utilPct: gpu.utilPct,
        tempC,
        tLimitMarginC: 95 - tempC,
        powerW: gpu.powerW,
        clockGrMhz: Math.round(lerp(642, 2416, load)),
        pstate: "P0",
        processes: [{ pid: 4127 + index * 13, name: "python3", memoryMiB: gpuMemoryMib, cmdline: VLLM_CMD }],
      },
      thermals: [
        { label: "GPU Die", tempC },
        { label: "SoC Peak", tempC: round(dieTempC + 4.2 + 0.5 * wave(seed + 2, t), 1) },
        { label: "SoC Avg", tempC: round(dieTempC - 1.8, 1) },
        { label: "ConnectX NIC", tempC: round(48 + 8 * load + 0.6 * wave(seed + 3, t), 1) },
        { label: "NVMe", tempC: round(39 + 3 * load + 0.4 * wave(seed + 4, t), 1) },
        { label: "Wi-Fi Radio", tempC: round(43 + 2 * load, 1) },
      ],
      fansRpm: [
        Math.round(2350 + 250 * load + 30 * wave(seed + 5, t)),
        Math.round(2330 + 250 * load + 30 * wave(seed + 6, t)),
      ],
      disk: {
        device: "/dev/nvme0n1p2",
        totalBytes: diskTotal,
        usedBytes: diskTotal - diskAvail,
        availBytes: diskAvail,
        usedPct: round((100 * (diskTotal - diskAvail)) / diskTotal, 2),
        readBps: Math.round(4e5 * (1.2 + wave(seed + 7, t))),
        writeBps: Math.round(2.5e6 * (1.2 + wave(seed + 8, t))),
      },
      interfaces: ports.map(({ peak, txSeed, rxSeed, ...identity }, i) => {
        const rxBps = flowRate(peak, rxSeed, t, load);
        const txBps = flowRate(peak, txSeed, t, load);
        counters[i].rx += rxBps * dt;
        counters[i].tx += txBps * dt;
        return {
          ...identity,
          operstate: "up",
          rxBytes: Math.floor(counters[i].rx),
          txBytes: Math.floor(counters[i].tx),
          rxBps: round(rxBps, 1),
          txBps: round(txBps, 1),
        };
      }),
      containers,
      topProcesses: top,
      ports: listening,
    };
  };
}

async function streamTelemetry(): Promise<void> {
  await Bun.stdin.text(); // the agent source a real node would run
  // The control plane closed the stream; the real agent exits the same way.
  process.stdout.on("error", () => process.exit(0));
  const sample = telemetrySource();
  while (!offline()) {
    process.stdout.write(`${JSON.stringify(sample())}\n`);
    await Bun.sleep(intervalMs);
  }
  console.error(`Connection to ${host} closed by remote host.`);
  process.exitCode = 1;
}

// --- One-shot commands --------------------------------------------------------

/** Undoes `withRemoteDeadline` in server/ssh.ts: the command inside `timeout ... bash -c '<quoted>'`. */
function unwrap(remote: string): string {
  const quoted = /^timeout .*? bash -c '(.*)'$/s.exec(remote)?.[1];
  return quoted === undefined ? remote : quoted.replaceAll(`'\\''`, "'");
}

/** Answers the server's probe: `echo '===n==='; ... ping -I <source> -c <count> ... <target>` per path. */
function pingSections(cmd: string): string | null {
  const sections = [...cmd.matchAll(/===([\w-]+)===(.*?)(?====|$)/gs)].filter(([, , body]) => /\bping\b/.test(body));
  if (!sections.length) return null;
  return sections
    .map(([, tag, body]) => {
      const [source, target = source] = body.match(/\d+\.\d+\.\d+\.\d+/g) ?? ["0.0.0.0"];
      const count = Math.max(1, Number(/-c (\d+)/.exec(body)?.[1] ?? 4));
      // Fabric links are direct cables; the LAN path crosses a switch.
      const typical = target.startsWith("192.168.") ? 0.11 : 0.38;
      const times = Array.from({ length: count }, () => typical * (0.85 + 0.4 * Math.random()));
      const avg = times.reduce((sum, ms) => sum + ms, 0) / count;
      const mdev = Math.sqrt(times.reduce((sum, ms) => sum + (ms - avg) ** 2, 0) / count);
      const rtt = [Math.min(...times), avg, Math.max(...times), mdev].map((ms) => ms.toFixed(3)).join("/");
      return [
        `===${tag}===`,
        `PING ${target} (${target}) from ${source} : 56(84) bytes of data.`,
        ...times.map((ms, i) => `64 bytes from ${target}: icmp_seq=${i + 1} ttl=64 time=${ms.toFixed(3)} ms`),
        "",
        `--- ${target} ping statistics ---`,
        `${count} packets transmitted, ${count} received, 0% packet loss, time ${(count - 1) * 200 + 2}ms`,
        `rtt min/avg/max/mdev = ${rtt} ms`,
      ].join("\n");
    })
    .join("\n");
}

/** The container a `docker <verb> [options] <name>` invocation names: its last plain word. */
function dockerTarget(cmd: string, verb: string): string {
  const words = new RegExp(`docker ${verb}\\b([^;|&]*)`).exec(cmd)?.[1].split(/\s+/) ?? [];
  // Drops options, their numeric values and the `2>` left of a redirect.
  return words.filter((word) => word && !/^[-\d]/.test(word)).at(-1)?.replaceAll("'", "") ?? "";
}

function containerLogs(name: string): string {
  const vllm = name.startsWith("vllm");
  const now = Date.now();
  return Array.from({ length: 15 }, (_, i) => {
    const iso = new Date(now - (14 - i) * 2100 - 400).toISOString();
    // docker prints nanoseconds.
    const stamp = `${iso.slice(0, -1)}${100000 + i * 7919}Z`;
    if (vllm && i % 5 === 4) {
      return (
        `${stamp} INFO ${iso.slice(5, 19).replace("T", " ")} [loggers.py:123] Engine 000: ` +
        `Avg prompt throughput: ${(380 + i * 9.5).toFixed(1)} tokens/s, ` +
        `Avg generation throughput: ${(84 + i * 0.7).toFixed(1)} tokens/s, ` +
        `Running: ${2 + (i % 3)} reqs, Waiting: 0 reqs, GPU KV cache usage: ${(9 + i * 0.4).toFixed(1)}%, ` +
        "Prefix cache hit rate: 61.3%"
      );
    }
    const request = vllm ? "POST /v1/chat/completions" : i % 4 === 3 ? "GET /api/config" : "GET /health";
    return `${stamp} INFO:     10.0.0.${21 + (i % 3)}:${51200 + i * 37} - "${request} HTTP/1.1" 200 OK`;
  }).join("\n");
}

/** One csv row for the fields of `--query-gpu=`, or a default set; honors `noheader` and `nounits`. */
function nvidiaSmi(cmd: string): string {
  const fields = /--query-gpu=([\w.,]+)/.exec(cmd)?.[1].split(",") ?? [
    "name",
    "utilization.gpu",
    "temperature.gpu",
    "power.draw",
  ];
  const gpu = gpuReading(Date.now() / 1000, 1);
  type Column = [header: string, value: string, unit?: string];
  const known: Record<string, Column> = {
    index: ["index", "0"],
    name: ["name", GPU_NAME],
    driver_version: ["driver_version", DRIVER],
    "utilization.gpu": ["utilization.gpu [%]", `${gpu.utilPct}`, " %"],
    "temperature.gpu": ["temperature.gpu", `${Math.round(gpu.tempC)}`],
    "power.draw": ["power.draw [W]", gpu.powerW.toFixed(2), " W"],
    "clocks.gr": ["clocks.current.graphics [MHz]", "2416", " MHz"],
    pstate: ["pstate", "P0"],
  };
  // Anything else reads [N/A], as the GB10's memory fields really do (memory is shared with the CPU).
  const columns = fields.map((field): Column => (Object.hasOwn(known, field) ? known[field] : [field, "[N/A]"]));
  const units = !cmd.includes("nounits");
  const rows = [columns.map(([, value, unit = ""]) => value + (units ? unit : "")).join(", ")];
  if (!cmd.includes("noheader")) rows.unshift(columns.map(([header]) => header).join(", "));
  return rows.join("\n");
}

const HOME_USAGE: [share: number, path: string][] = [
  [1, ""],
  [0.55, "/.cache"],
  [0.52, "/.cache/huggingface"],
  [0.24, "/models"],
  [0.14, "/models/gguf"],
  [0.11, "/datasets"],
  [0.09, "/models/checkpoints"],
  [0.07, "/datasets/finetune"],
  [0.05, "/workspace"],
  [0.035, "/workspace/eval-runs"],
  [0.03, "/.local"],
  [0.027, "/.local/share"],
  [0.02, "/.cache/pip"],
  [0.012, "/snap"],
];

/** Answers each `;`-separated statement of the storage analysis: its echoed headers, `du` and `docker system df`. */
function storageReport(cmd: string): string {
  const { total, avail } = diskGib();
  const home = 0.86 * (total - avail);
  // The sizes `du -h` prints: 2.0T, 612G, 9.5G.
  const human = (gib: number) =>
    gib >= 1024 ? `${(gib / 1024).toFixed(1)}T` : gib >= 10 ? `${Math.round(gib)}G` : `${gib.toFixed(1)}G`;
  const containers = containerList();
  const running = containers.filter((c) => c.state === "running").length;
  const table = [
    ["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
    ["Images", "7", `${running}`, "84.6GB", "41.2GB (48%)"],
    ["Containers", `${containers.length}`, `${running}`, "1.31GB", "212MB (16%)"],
    ["Local Volumes", "4", "2", "38.9GB", "11.4GB (29%)"],
    ["Build Cache", "61", "0", "9.71GB", "9.71GB"],
  ];
  return cmd
    .split(/;\s*/)
    .flatMap((statement) => {
      const echoed = /^echo '(.*)'$/.exec(statement)?.[1];
      if (echoed !== undefined) return [echoed];
      if (statement.includes("du -h")) return HOME_USAGE.map(([share, dir]) => `${human(home * share)}\t/home/user${dir}`);
      if (statement.includes("docker system df")) {
        return table.map(([type, ...cells]) => (type.padEnd(16) + cells.map((cell) => cell.padEnd(10)).join("")).trimEnd());
      }
      return [];
    })
    .join("\n");
}

function answer(cmd: string): { text: string; exitCode: number } {
  const ok = (text: string) => ({ text, exitCode: 0 });
  const pings = pingSections(cmd);
  if (pings) return ok(pings);
  if (/\bdocker logs\b/.test(cmd)) return ok(containerLogs(dockerTarget(cmd, "logs")));
  const action = /\bdocker (start|stop|restart)\b/.exec(cmd)?.[1];
  if (action) {
    const name = dockerTarget(cmd, action);
    if (action === "start" && name === "finetune-lora") {
      return {
        exitCode: 1,
        text:
          "Error response from daemon: error while creating mount source path '/data/checkpoints/lora-r16': " +
          "mkdir /data/checkpoints: read-only file system\nError: failed to start containers: finetune-lora",
      };
    }
    return ok(name);
  }
  if (/\bnvidia-smi\b/.test(cmd)) return ok(nvidiaSmi(cmd));
  if (/\bdu -h|\bdocker system df\b/.test(cmd)) return ok(storageReport(cmd));
  if (/\bhostname\b/.test(cmd)) return ok(hostname);
  return ok(`demo node ${hostname}: command accepted`);
}

// --- Interactive shell --------------------------------------------------------

/** Runs under the terminal's PTY, whose line discipline echoes input and delivers whole lines. */
async function shell(): Promise<never> {
  const prompt = `user@${hostname}:~$ `;
  const print = (text: string) => process.stdout.write(text);
  // ^C clears the line, as in a real shell, instead of ending the session.
  process.on("SIGINT", () => print(`\n${prompt}`));
  print(`Welcome to NVIDIA DGX Spark (GNU/Linux aarch64)\n\n${prompt}`);
  for await (const line of console) {
    const typed = line.trim();
    if (typed === "exit" || typed === "logout") break;
    if (typed === "nvidia-smi") print(`${nvidiaSmi("")}\n`);
    else if (typed === "hostname") print(`${hostname}\n`);
    else if (typed) print(`demo node ${hostname}: only nvidia-smi, hostname and exit work in this shell\n`);
    print(prompt);
  }
  print("logout\n");
  process.exit(0);
}

// --- Entry --------------------------------------------------------------------

if (!TOPOLOGIES.includes(topology)) {
  console.error(`fake-node: FAKE_TOPOLOGY must be one of ${TOPOLOGIES.join(", ")}`);
  process.exitCode = 255;
} else if (index < 0 || index >= size) {
  console.error(`ssh: Could not resolve hostname ${host}: Name or service not known`);
  process.exitCode = 255;
} else if (offline()) {
  console.error(`ssh: connect to host ${host} port 22: Connection timed out`);
  process.exitCode = 1;
} else if (command === "python3 -u -") {
  await streamTelemetry();
} else if (!command) {
  await shell();
} else {
  if (stateDir) appendFileSync(join(stateDir, "commands.log"), `${JSON.stringify({ host, command })}\n`);
  const cmd = unwrap(command);
  const { text, exitCode } = answer(cmd);
  // A failing command writes to stderr; the caller's `2>&1` decides where that lands.
  (exitCode === 0 || cmd.includes("2>&1") ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = exitCode;
}
