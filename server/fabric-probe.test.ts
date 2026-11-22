import { describe, expect, test } from "bun:test";
import type { InterfaceRole } from "../shared/types";
import { planProbe, probeCommand, ProbeError, probeResult } from "./fabric-probe";

const iface = (name: string, role: InterfaceRole, ip: string, subnet: string) => ({ name, role, ip, subnet });
const nodes = {
  "spark-2": { connected: true, interfaces: [
    iface("eth0", "lan", "198.51.100.10", "198.51.100.0/24"),
    iface("enp1s0f0np0", "fabric", "192.0.2.1", "192.0.2.0/30"),
    iface("enp1s0f1np1", "fabric", "192.0.2.5", "192.0.2.4/30"),
    iface("enp2s0f0np0", "fabric", "192.0.2.13", "192.0.2.12/30"),
  ] },
  "spark-7": { connected: true, interfaces: [
    iface("rocep9s0", "fabric", "192.0.2.9", "192.0.2.8/30"),
    iface("rocep7s0", "fabric", "192.0.2.14", "192.0.2.12/30"),
    iface("rocep8s0", "fabric", "192.0.2.2", "192.0.2.0/30"),
    iface("enP7s7", "lan", "203.0.113.20", "203.0.113.0/24"),
  ] },
};
const summary = (sent: number, received: number) =>
  `${sent} packets transmitted, ${received} received, ${Math.round((1 - received / sent) * 100)}% packet loss, time 699ms`;
const rtt = (avg: string) => `rtt min/avg/max/mdev = 0.101/${avg}/1.200/0.199 ms`;

describe("directed probes", () => {
  test("plans one path per shared fabric subnet across differing interface names, plus a routed LAN path", () => {
    const forward = planProbe(nodes, "spark-2", "spark-7");
    expect(forward.paths).toEqual([
      { kind: "fabric", subnet: "192.0.2.0/30", sourceIface: "enp1s0f0np0", targetIface: "rocep8s0",
        sourceIp: "192.0.2.1", targetIp: "192.0.2.2" },
      { kind: "fabric", subnet: "192.0.2.12/30", sourceIface: "enp2s0f0np0", targetIface: "rocep7s0",
        sourceIp: "192.0.2.13", targetIp: "192.0.2.14" },
      { kind: "lan", subnet: "198.51.100.0/24", sourceIface: "eth0", targetIface: "enP7s7",
        sourceIp: "198.51.100.10", targetIp: "203.0.113.20" },
    ]);
    expect(probeCommand(forward.paths)).toBe([
      "echo '===0==='; LC_ALL=C ping -n -I 192.0.2.1 -c 4 -i 0.2 -W 1 192.0.2.2 2>&1 || true",
      "echo '===1==='; LC_ALL=C ping -n -I 192.0.2.13 -c 4 -i 0.2 -W 1 192.0.2.14 2>&1 || true",
      "echo '===2==='; LC_ALL=C ping -n -I 198.51.100.10 -c 3 -i 0.2 -W 1 203.0.113.20 2>&1 || true",
    ].join("; "));

    const reverse = planProbe(nodes, "spark-7", "spark-2");
    expect(reverse.paths.map((p) => [p.kind, p.sourceIface, p.targetIface, p.subnet])).toEqual([
      ["fabric", "rocep7s0", "enp2s0f0np0", "192.0.2.12/30"],
      ["fabric", "rocep8s0", "enp1s0f0np0", "192.0.2.0/30"],
      ["lan", "enP7s7", "eth0", "203.0.113.0/24"],
    ]);
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
        a: { connected: true, interfaces: [iface("x0", "fabric", source, subnet)] },
        b: { connected: true, interfaces: [iface("y0", "fabric", target, subnet)] },
      }, "a", "b");
      expect(paths).toEqual([]);
      expect(probeCommand(paths)).toBe("");
      expect(probeResult("a", "b", paths, "")).toMatchObject({ source: "a", target: "b", paths: [] });
    }
    // A LAN address never stands in for a fabric peer, even on the same subnet.
    expect(planProbe({
      a: { connected: true, interfaces: [iface("x0", "fabric", "192.0.2.1", "192.0.2.0/30")] },
      b: { connected: true, interfaces: [iface("y0", "lan", "192.0.2.2", "192.0.2.0/30")] },
    }, "a", "b").paths).toEqual([]);
  });

  test("reports each path separately: measured, total loss, and unparsable", () => {
    const { source, target, paths } = planProbe(nodes, "spark-2", "spark-7");
    const output = [
      "===0===", "PING 192.0.2.2 (192.0.2.2) from 192.0.2.1 : 56(84) bytes of data.", "",
      "--- 192.0.2.2 ping statistics ---", summary(4, 0), "",
      "===1===", "ping: bind: Cannot assign requested address",
      "===2===", summary(3, 3), rtt("1.1404"),
    ].join("\n");
    const result = probeResult(source, target, paths, output);
    expect(result).toMatchObject({ source, target });
    expect(result.ts).toBeGreaterThan(0);
    expect(result.paths).toEqual([
      { kind: "fabric", subnet: "192.0.2.0/30", sourceIface: "enp1s0f0np0", targetIface: "rocep8s0", rttMs: null, lossPct: 100 },
      { kind: "fabric", subnet: "192.0.2.12/30", sourceIface: "enp2s0f0np0", targetIface: "rocep7s0", rttMs: null, lossPct: null },
      { kind: "lan", subnet: "198.51.100.0/24", sourceIface: "eth0", targetIface: "enP7s7", rttMs: 1.14, lossPct: 0 },
    ]);
  });

  test("handles CRLF output, partial loss, and sections missing from truncated output", () => {
    const { source, target, paths } = planProbe(nodes, "spark-2", "spark-7");
    const result = probeResult(source, target, paths, ["===0===", summary(4, 3), rtt("0.250"), ""].join("\r\n"));
    expect(result.paths.map((p) => [p.rttMs, p.lossPct])).toEqual([[0.25, 25], [null, null], [null, null]]);
  });

  test("throws 502 only when no section is parsable", () => {
    const { source, target, paths } = planProbe(nodes, "spark-2", "spark-7");
    for (const output of ["", "===0===\nping: not found\n===1===\nping: not found\n===2===\nping: not found"]) {
      let error: unknown;
      try {
        probeResult(source, target, paths, output);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ProbeError);
      expect((error as ProbeError).status).toBe(502);
    }
  });
});
