import { isIPv4 } from "node:net";
import type { FabricProbeResult, InterfaceRole, NetworkInterfaceMetric, NodeId } from "../shared/types";

type Endpoint = Pick<NetworkInterfaceMetric, "role" | "ip" | "subnet">;
interface ProbePath {
  role: InterfaceRole;
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

/** The agent reports IPv4 networks in canonical CIDR form. Do not assume role names match. */
function onSameFabric(a: Endpoint, b: Endpoint): boolean {
  if ((b.role !== "fabric-a" && b.role !== "fabric-b") || !a.subnet || a.subnet !== b.subnet) return false;
  const cidr = /^([^/]+)\/(\d{1,2})$/.exec(a.subnet);
  if (!cidr || !isIPv4(cidr[1])) return false;
  const prefix = Number(cidr[2]);
  if (prefix > 32) return false;
  const network = networkNumber(cidr[1], prefix);
  return networkNumber(a.ip, prefix) === network && networkNumber(b.ip, prefix) === network;
}

function selectProbePaths(source: readonly Endpoint[], target: readonly Endpoint[]): ProbePath[] {
  const paths: ProbePath[] = [];
  for (const role of ["fabric-a", "fabric-b", "lan"] as const) {
    const from = source.find((iface) => iface.role === role && isIPv4(iface.ip));
    if (!from) continue;
    const to = target.find((peer) => isIPv4(peer.ip) && from.ip !== peer.ip && (
      from.role === "lan" ? peer.role === "lan" : onSameFabric(from, peer)
    ));
    if (to) paths.push({ role: from.role, sourceIp: from.ip, targetIp: to.ip });
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

export function probeCommand(paths: readonly ProbePath[]): string {
  return paths.map(({ role, sourceIp, targetIp }) =>
    `echo '===${role}==='; LC_ALL=C ping -n -I ${sourceIp} -c ${role === "lan" ? 3 : 4} -i 0.2 -W 1 ${targetIp} 2>&1 || true`
  ).join("; ");
}

/** No matching path is unmeasured (null); a completed ping with no replies reports 100% loss. */
export function probeResult(source: NodeId, target: NodeId, paths: readonly ProbePath[], stdout: string): FabricProbeResult {
  const result: FabricProbeResult = {
    source, target, ts: Date.now(),
    fabricAPingMs: null, fabricALossPct: null,
    fabricBPingMs: null, fabricBLossPct: null,
    lanPingMs: null,
  };
  for (const { role } of paths) {
    const section = stdout.match(new RegExp(`===${role}===\\r?\\n([\\s\\S]*?)(?=\\n===|$)`))?.[1] ?? "";
    const loss = section.match(/([0-9.]+)% packet loss/);
    const rtt = section.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)\//);
    if (!loss || (!rtt && Number(loss[1]) < 100)) {
      throw new ProbeError(502, `Ping failed on ${source} (${role}); no usable measurement`);
    }
    const avg = rtt ? Math.round(Number(rtt[1]) * 1000) / 1000 : null;
    if (role === "fabric-a") {
      result.fabricAPingMs = avg;
      result.fabricALossPct = Number(loss[1]);
    } else if (role === "fabric-b") {
      result.fabricBPingMs = avg;
      result.fabricBLossPct = Number(loss[1]);
    } else {
      result.lanPingMs = avg;
    }
  }
  return result;
}
