import { isIPv4 } from "node:net";
import type { FabricProbeResult, NetworkInterfaceMetric, NodeId, ProbePath } from "../shared/types";

type Endpoint = Pick<NetworkInterfaceMetric, "name" | "role" | "ip" | "subnet">;

export interface PlannedPath extends Pick<ProbePath, "kind" | "subnet" | "sourceIface" | "targetIface"> {
  sourceIp: string;
  targetIp: string;
}

export class ProbeError extends Error {
  constructor(readonly status: 400 | 409 | 502, message: string) {
    super(message);
  }
}

function networkNumber(ip: string, prefix: number): number {
  const address = ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
  return Math.floor(address / 2 ** (32 - prefix));
}

/** The agent reports IPv4 networks in canonical CIDR form. Interface names can differ per node. */
function onSameFabric(a: Endpoint, b: Endpoint): boolean {
  if (b.role !== "fabric" || !a.subnet || a.subnet !== b.subnet) return false;
  const cidr = /^([^/]+)\/(\d{1,2})$/.exec(a.subnet);
  if (!cidr || !isIPv4(cidr[1])) return false;
  const prefix = Number(cidr[2]);
  if (prefix > 32) return false;
  const network = networkNumber(cidr[1], prefix);
  return networkNumber(a.ip, prefix) === network && networkNumber(b.ip, prefix) === network;
}

/** Fabric paths in the source's interface order, then the LAN path. */
function selectProbePaths(source: readonly Endpoint[], target: readonly Endpoint[]): PlannedPath[] {
  const paths: PlannedPath[] = [];
  const lan = source.find((iface) => iface.role === "lan" && isIPv4(iface.ip));
  const sources = source.filter((iface) => iface.role === "fabric" && isIPv4(iface.ip));
  if (lan) sources.push(lan);
  for (const from of sources) {
    const to = target.find((peer) => isIPv4(peer.ip) && peer.ip !== from.ip && (
      from.role === "lan" ? peer.role === "lan" : onSameFabric(from, peer)
    ));
    if (!to) continue;
    paths.push({
      kind: from.role, subnet: from.subnet,
      sourceIface: from.name, targetIface: to.name,
      sourceIp: from.ip, targetIp: to.ip,
    });
  }
  return paths;
}

export function planProbe(
  nodes: Readonly<Record<NodeId, { connected: boolean; interfaces: readonly Endpoint[] }>>,
  source: unknown,
  target: unknown
) {
  if (typeof source !== "string" || !Object.hasOwn(nodes, source) ||
      typeof target !== "string" || !Object.hasOwn(nodes, target) || source === target) {
    throw new ProbeError(400, "Select two different configured nodes");
  }
  if (!nodes[source].connected || !nodes[target].connected) {
    throw new ProbeError(409, "Both nodes must be online to probe");
  }
  return { source, target, paths: selectProbePaths(nodes[source].interfaces, nodes[target].interfaces) };
}

export function probeCommand(paths: readonly PlannedPath[]): string {
  return paths.map(({ kind, sourceIp, targetIp }, n) =>
    `echo '===${n}==='; LC_ALL=C ping -n -I ${sourceIp} -c ${kind === "lan" ? 3 : 4} -i 0.2 -W 1 ${targetIp} 2>&1 || true`
  ).join("; ");
}

/**
 * A path whose ping printed no summary is unmeasured (nulls) so one dead interface
 * does not hide the others; a completed ping with no replies reports 100% loss.
 */
export function probeResult(source: NodeId, target: NodeId, paths: readonly PlannedPath[], stdout: string): FabricProbeResult {
  let parsed = 0;
  const measured = paths.map(({ kind, subnet, sourceIface, targetIface }, n): ProbePath => {
    const section = stdout.match(new RegExp(`===${n}===\\r?\\n([\\s\\S]*?)(?=\\n===\\d+===|$)`))?.[1] ?? "";
    const loss = section.match(/([0-9.]+)% packet loss/);
    const rtt = section.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)\//);
    if (loss) parsed++;
    return {
      kind, subnet, sourceIface, targetIface,
      rttMs: loss && rtt ? Math.round(Number(rtt[1]) * 1000) / 1000 : null,
      lossPct: loss ? Number(loss[1]) : null,
    };
  });
  if (paths.length && !parsed) throw new ProbeError(502, `Ping failed on ${source}; no usable measurement`);
  return { source, target, ts: Date.now(), paths: measured };
}
