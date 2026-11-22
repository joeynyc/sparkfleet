import fs from "node:fs";
import os from "node:os";
import type { LocalHostSnapshot } from "../shared/types";

async function commandOutput(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return ""; // tool not installed on this platform
  }
}

async function describeOs(): Promise<string> {
  if (process.platform === "darwin") {
    const version = await commandOutput(["sw_vers", "-productVersion"]);
    if (version) return `macOS ${version}`;
  }
  if (process.platform === "linux" && fs.existsSync("/etc/os-release")) {
    const pretty = fs.readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (pretty) return pretty[1];
  }
  return `${os.type()} ${os.release()}`;
}

const osVersion = describeOs();

async function usedMemoryBytes(totalBytes: number): Promise<number> {
  if (process.platform === "linux") {
    const availableKb = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m);
    if (availableKb) return totalBytes - Number(availableKb[1]) * 1024;
  }
  if (process.platform === "darwin") {
    // os.freemem() counts reclaimable cache as used on macOS. Active + wired +
    // compressed is what Activity Monitor reports as memory used.
    const vm = await commandOutput(["vm_stat"]);
    const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] ?? 0);
    const pages = (label: string) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
    const used =
      (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) *
      pageSize;
    if (used > 0) return used;
  }
  return totalBytes - os.freemem();
}

let prevCpu: { idle: number; total: number } | null = null;

/** CPU busy share since the previous call; 0 on the first call. */
function cpuUsagePct(): number {
  let idle = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  const prev = prevCpu;
  prevCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  const busy = 1 - (idle - prev.idle) / (total - prev.total);
  return Math.max(0, Math.min(100, Math.round(busy * 1000) / 10));
}

export async function sampleLocalHost(): Promise<LocalHostSnapshot> {
  const memTotalBytes = os.totalmem();
  return {
    hostname: os.hostname().replace(/\.local$/, ""),
    chip: os.cpus()[0]?.model || os.arch(),
    osVersion: await osVersion,
    memTotalBytes,
    memUsedBytes: await usedMemoryBytes(memTotalBytes),
    cpuUsagePct: cpuUsagePct(),
  };
}
