import { expect, test } from "bun:test";
import { directionBps, type FabricLink, fabricLinks } from "./fabric-links";
import type { NetworkInterfaceMetric, NodeSnapshot } from "./types";

function nic(name: string, subnet: string, over: Partial<NetworkInterfaceMetric> = {}): NetworkInterfaceMetric {
  return {
    name,
    role: "fabric",
    ip: subnet.replace(/0\/\d+$/, "1"),
    subnet,
    operstate: "up",
    speedMbps: 200_000,
    rxBytes: 0,
    txBytes: 0,
    rxBps: 0,
    txBps: 0,
    ...over,
  };
}

function node(id: string, interfaces: NetworkInterfaceMetric[], connected = true): NodeSnapshot {
  return { id, label: id.toUpperCase(), connected, interfaces } as NodeSnapshot;
}

/** `subnet: node/iface node/iface` per link, for comparing topology at a glance. */
const shape = (links: FabricLink[]) =>
  links.map((link) => `${link.subnet}: ${link.ends.map((end) => `${end.node.id}/${end.iface.name}`).join(" ")}`);

test("two nodes joined by two links report each link once, sorted by subnet", () => {
  const lan = nic("eth0", "192.168.1.0/24", { role: "lan", txBps: 9_999 });
  const links = fabricLinks([
    node("a", [lan, nic("f1", "10.0.10.0/24", { txBps: 5, rxBps: 7 }), nic("f0", "10.0.2.0/24", { txBps: 100, rxBps: 12 })]),
    node("b", [lan, nic("g0", "10.0.2.0/24", { txBps: 10, rxBps: 90, speedMbps: 100_000 }), nic("g1", "10.0.10.0/24", { txBps: 8, rxBps: 4 })]),
  ]);
  expect(shape(links)).toEqual(["10.0.2.0/24: a/f0 b/g0", "10.0.10.0/24: a/f1 b/g1"]);
  expect(links.map((link) => link.state)).toEqual(["ACTIVE", "ACTIVE"]);
  expect(links[0].speedMbps).toBe(200_000);
  // a->b is max(100 sent, 90 received); b->a is max(10 sent, 12 received).
  expect(directionBps(links[0].ends[0], links[0].ends[1])).toBe(100);
  expect(directionBps(links[0].ends[1], links[0].ends[0])).toBe(12);
  expect(links[0].flowBps).toBe(112);
  expect(links[1].flowBps).toBe(5 + 8);
});

test("interfaces without a subnet are not links", () => {
  expect(fabricLinks([node("a", [nic("f0", "")]), node("b", [nic("g0", "")])])).toEqual([]);
  expect(fabricLinks([node("a", [])])).toEqual([]);
});

test("a ring of three nodes is three two-end links", () => {
  const links = fabricLinks([
    node("a", [nic("f0", "10.0.0.0/30"), nic("f1", "10.0.2.0/30")]),
    node("b", [nic("f0", "10.0.0.0/30"), nic("f1", "10.0.1.0/30")]),
    node("c", [nic("f0", "10.0.1.0/30"), nic("f1", "10.0.2.0/30")]),
  ]);
  expect(shape(links)).toEqual(["10.0.0.0/30: a/f0 b/f0", "10.0.1.0/30: b/f1 c/f0", "10.0.2.0/30: a/f1 c/f1"]);
  expect(links.every((link) => link.state === "ACTIVE")).toBe(true);
});

test("a shared segment of three ends sums transmit only", () => {
  const segment = (cOperstate: string) =>
    fabricLinks([
      node("a", [nic("f0", "10.1.0.0/24", { txBps: 300, rxBps: 50 })]),
      node("b", [nic("f0", "10.1.0.0/24", { txBps: 40, rxBps: 200 })]),
      node("c", [nic("f0", "10.1.0.0/24", { txBps: 10, rxBps: 100, operstate: cOperstate })]),
    ]);
  const [link, ...rest] = segment("up");
  expect(rest).toEqual([]);
  expect(link.ends).toHaveLength(3);
  expect(link.state).toBe("ACTIVE");
  expect(link.flowBps).toBe(350);
  expect(segment("down")[0].state).toBe("DEGRADED");
});

test("an end with no peer in the fleet is unpaired and counts both directions", () => {
  const [link] = fabricLinks([node("a", [nic("f0", "10.2.0.0/24", { txBps: 30, rxBps: 12 })]), node("b", [])]);
  expect(link.state).toBe("UNPAIRED");
  expect(link.flowBps).toBe(42);
});

test("an offline end is down and its stale counters are ignored", () => {
  const live = nic("f0", "10.3.0.0/24", { txBps: 20, rxBps: 5 });
  const stale = nic("f0", "10.3.0.0/24", { txBps: 7_000, rxBps: 9_000 });
  const [degraded] = fabricLinks([node("a", [live]), node("b", [stale], false)]);
  expect(degraded.ends.map((end) => end.up)).toEqual([true, false]);
  expect(degraded.state).toBe("DEGRADED");
  expect(degraded.flowBps).toBe(25);

  const [down] = fabricLinks([node("a", [live], false), node("b", [stale], false)]);
  expect(down.state).toBe("DOWN");
  expect(down.flowBps).toBe(0);
});

test("a link whose interfaces all lack carrier is down", () => {
  const dead = nic("f0", "10.4.0.0/24", { operstate: "down", speedMbps: 0 });
  const [link] = fabricLinks([node("a", [dead]), node("b", [dead])]);
  expect(link.state).toBe("DOWN");
  expect(link.speedMbps).toBe(0);
});

test("a node with four fabric interfaces takes part in four links", () => {
  const links = fabricLinks([
    node("hub", [nic("p0", "10.9.0.0/24"), nic("p1", "10.9.1.0/24"), nic("p2", "10.9.2.0/24"), nic("p3", "10.9.3.0/24")]),
    node("b", [nic("q0", "10.9.0.0/24"), nic("q1", "10.9.1.0/24")]),
    node("c", [nic("r0", "10.9.2.0/24", { operstate: "down" })]),
  ]);
  expect(shape(links)).toEqual([
    "10.9.0.0/24: hub/p0 b/q0",
    "10.9.1.0/24: hub/p1 b/q1",
    "10.9.2.0/24: hub/p2 c/r0",
    "10.9.3.0/24: hub/p3",
  ]);
  expect(links.map((link) => link.state)).toEqual(["ACTIVE", "ACTIVE", "DEGRADED", "UNPAIRED"]);
});
