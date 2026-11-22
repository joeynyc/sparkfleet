import { describe, expect, test } from "bun:test";
import type { InterfaceRole } from "../shared/types";
import { planProbe, probeCommand, probeResult } from "./fabric-probe";

const iface = (role: InterfaceRole, ip: string, subnet: string) => ({ role, ip, subnet });
const nodes = {
  "spark-2": { connected: true, interfaces: [
    iface("fabric-a", "192.0.2.1", "192.0.2.0/30"),
    iface("fabric-b", "192.0.2.5", "192.0.2.4/30"),
    iface("lan", "198.51.100.10", "198.51.100.0/24"),
  ] },
  "spark-7": { connected: true, interfaces: [
    iface("fabric-a", "192.0.2.9", "192.0.2.8/30"),
    iface("fabric-b", "192.0.2.2", "192.0.2.0/30"),
    iface("lan", "203.0.113.20", "203.0.113.0/24"),
  ] },
};

describe("directed probes", () => {
  test("matches fabric subnets across differing roles, with LAN on a routed network", () => {
    const forward = planProbe(nodes, "spark-2", "spark-7");
    expect(forward.paths).toEqual([
      { role: "fabric-a", sourceIp: "192.0.2.1", targetIp: "192.0.2.2" },
      { role: "lan", sourceIp: "198.51.100.10", targetIp: "203.0.113.20" },
    ]);
    expect(probeCommand(forward.paths)).toContain("-I 192.0.2.1 -c 4 -i 0.2 -W 1 192.0.2.2");
    const reverse = planProbe(nodes, "spark-7", "spark-2");
    expect(reverse.paths[0]).toEqual({ role: "fabric-b", sourceIp: "192.0.2.2", targetIp: "192.0.2.1" });
  });

  test("rejects self, missing, unknown, non-string, inherited and offline endpoints", () => {
    for (const [source, target] of [
      ["spark-2", "spark-2"], ["spark-0", "spark-7"], ["spark-2", undefined],
      [null, "spark-7"], ["spark-2", ["spark-7"]], ["constructor", "spark-2"],
    ]) expect(() => planProbe(nodes, source, target)).toThrow("different configured nodes");
    const offline = { ...nodes, "spark-7": { ...nodes["spark-7"], connected: false } };
    expect(() => planProbe(offline, "spark-2", "spark-7")).toThrow("online");
    expect(() => planProbe(offline, "spark-7", "spark-2")).toThrow("online");
  });

  test("does not ping missing, duplicate, malformed, or mismatched fabric addresses", () => {
    for (const [source, target, subnet] of [
      ["192.0.2.1", "192.0.2.2", ""], ["192.0.2.1", "192.0.2.2", "not a CIDR"],
      ["192.0.2.1", "192.0.2.1", "192.0.2.0/30"], ["192.0.2.1", "192.0.2.5", "192.0.2.0/30"],
      ["192.0.2.256", "192.0.2.2", "192.0.2.0/30"], ["192.0.2.1", "-not-an-address", "192.0.2.0/30"],
    ]) {
      const { paths } = planProbe({
        a: { connected: true, interfaces: [iface("fabric-a", source, subnet)] },
        b: { connected: true, interfaces: [iface("fabric-b", target, subnet)] },
      }, "a", "b");
      expect(paths).toEqual([]);
      expect(probeCommand(paths)).toBe("");
    }
  });

  test("records actual loss separately from no path; rejects a failed measurement", () => {
    const { source, target, paths } = planProbe(nodes, "spark-2", "spark-7");
    const output = [
      "===fabric-a===", "4 packets transmitted, 0 received, 100% packet loss, time 699ms",
      "===lan===", "3 packets transmitted, 3 received, 0% packet loss, time 400ms",
      "rtt min/avg/max/mdev = 1.001/1.140/1.200/0.199 ms",
    ].join("\n");
    expect(probeResult(source, target, paths, output)).toMatchObject({
      source, target, fabricAPingMs: null, fabricALossPct: 100,
      fabricBPingMs: null, fabricBLossPct: null, lanPingMs: 1.14,
    });
    expect(() => probeResult(source, target, paths, "===fabric-a===\nping: not found")).toThrow("Ping failed");
  });
});
