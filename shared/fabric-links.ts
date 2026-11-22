import type { NetworkInterfaceMetric, NodeSnapshot } from "./types";

export type FabricLinkState = "ACTIVE" | "DEGRADED" | "DOWN" | "UNPAIRED";

export interface FabricLinkEnd {
  node: NodeSnapshot;
  iface: NetworkInterfaceMetric;
  /** The node is connected and the interface reports carrier. */
  up: boolean;
}

/** The fabric interfaces that share one subnet: a cable between two nodes or a switched segment. */
export interface FabricLink {
  subnet: string;
  /** In fleet order, then in the order the node reports its interfaces. */
  ends: FabricLinkEnd[];
  /** `UNPAIRED` when only one end is known; otherwise how many of the ends are up. */
  state: FabricLinkState;
  /** Highest speed any end reports; 0 when none does. */
  speedMbps: number;
  /** Bytes per second crossing the link, each byte counted once. */
  flowBps: number;
}

/**
 * Rate from one end of a two-end link to the other. The sender's TX and the receiver's RX measure
 * the same bytes, so take the larger instead of adding them. A disconnected node's counters are
 * its last sample, not a current rate, and count as zero.
 */
export function directionBps(from: FabricLinkEnd, to: FabricLinkEnd): number {
  return Math.max(from.node.connected ? from.iface.txBps : 0, to.node.connected ? to.iface.rxBps : 0);
}

function flowBps(ends: FabricLinkEnd[]): number {
  if (ends.length === 2) return directionBps(ends[0], ends[1]) + directionBps(ends[1], ends[0]);
  // On a shared segment every byte is transmitted once, so TX alone covers it. A lone end has no
  // peer counters to stand in for what it receives.
  const lone = ends.length === 1;
  return ends.reduce(
    (sum, { node, iface }) => (node.connected ? sum + iface.txBps + (lone ? iface.rxBps : 0) : sum),
    0
  );
}

function linkState(ends: FabricLinkEnd[]): FabricLinkState {
  if (ends.length === 1) return "UNPAIRED";
  const up = ends.filter((end) => end.up).length;
  return up === ends.length ? "ACTIVE" : up === 0 ? "DOWN" : "DEGRADED";
}

/** Groups the fleet's addressed fabric interfaces by subnet, one link per subnet, sorted by subnet. */
export function fabricLinks(nodes: readonly NodeSnapshot[]): FabricLink[] {
  const bySubnet = new Map<string, FabricLinkEnd[]>();
  for (const node of nodes) {
    for (const iface of node.interfaces) {
      if (iface.role !== "fabric" || !iface.subnet) continue;
      const end = { node, iface, up: node.connected && iface.operstate === "up" };
      const ends = bySubnet.get(iface.subnet);
      if (ends) ends.push(end);
      else bySubnet.set(iface.subnet, [end]);
    }
  }
  return [...bySubnet]
    // Numeric collation puts 10.0.2.0/24 before 10.0.10.0/24.
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([subnet, ends]) => ({
      subnet,
      ends,
      state: linkState(ends),
      speedMbps: Math.max(...ends.map((end) => end.iface.speedMbps)),
      flowBps: flowBps(ends),
    }));
}
