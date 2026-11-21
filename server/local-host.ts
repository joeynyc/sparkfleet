import type { LocalHostSnapshot } from "../shared/types";
import os from "node:os";

let cachedChip = "Apple Silicon";
let cachedOsVersion = "macOS";
let cachedTailscaleIp = "";
let prevCpuTimes: { idle: number; total: number } | null = null;

async function runSimple(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return "";
  }
}

export async function initLocalHostMeta(): Promise<void> {
  const [chip, ver, tsIp] = await Promise.all([
    runSimple(["sysctl", "-n", "machdep.cpu.brand_string"]),
    runSimple(["sw_vers", "-productVersion"]),
    runSimple(["tailscale", "ip", "-4"]),
  ]);
  if (chip) cachedChip = chip;
  if (ver) cachedOsVersion = `macOS ${ver}`;
  if (tsIp) cachedTailscaleIp = tsIp.split("\n")[0]?.trim() ?? "";
}

function getCpuUsagePct(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  let pct = 0;
  if (prevCpuTimes) {
    const dTotal = Math.max(1, total - prevCpuTimes.total);
    const dIdle = idle - prevCpuTimes.idle;
    pct = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
  }
  prevCpuTimes = { idle, total };
  return pct;
}

export async function sampleLocalHost(): Promise<LocalHostSnapshot> {
  const memTotal = os.totalmem();
  let memUsed = memTotal - os.freemem();

  // More accurate macOS active+wired+compressed via vm_stat
  const vm = await runSimple(["vm_stat"]);
  if (vm) {
    const pageMatch = vm.match(/page size of (\d+) bytes/);
    const pageSize = pageMatch ? Number(pageMatch[1]) : 16384;
    const getPages = (label: string) => {
      const m = vm.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const active = getPages("Pages active");
    const wired = getPages("Pages wired down");
    const compressed = getPages("Pages occupied by compressor");
    const computed = (active + wired + compressed) * pageSize;
    if (computed > 0 && computed <= memTotal) {
      memUsed = computed;
    }
  }

  const load = os.loadavg();
  return {
    hostname: os.hostname().replace(/\.local$/, ""),
    chip: cachedChip,
    osVersion: cachedOsVersion,
    memTotalBytes: memTotal,
    memUsedBytes: memUsed,
    cpuUsagePct: getCpuUsagePct(),
    loadAvg: [
      Math.round((load[0] ?? 0) * 100) / 100,
      Math.round((load[1] ?? 0) * 100) / 100,
      Math.round((load[2] ?? 0) * 100) / 100,
    ],
    uptimeSec: Math.floor(os.uptime()),
    tailscaleSelfIp: cachedTailscaleIp,
    lastUpdated: Date.now(),
  };
}
