import { expect, test } from "bun:test";
import { resolveRoster } from "./roster";

for (let count = 1; count <= 8; count++) {
  test(`${count} configured Sparks produce exactly ${count} SSH destinations in slot order`, () => {
    const rows = Array.from({ length: count }, (_, i) => [`spark-${i}`, { sshHost: `lab-${i + 1}` }] as const);
    const nodes = resolveRoster(Object.fromEntries([...rows].reverse()), {});
    expect(Object.values(nodes).map((n) => [n.id, n.sshHost])).toEqual(rows.map(([id, n]) => [id, n.sshHost]));
  });
}

test("a sparse, env-only roster does not enroll the missing slots", () => {
  const env = { SPARK5_HOST: "lab-east", SPARK5_LABEL: "East", SPARK0_LABEL: "unconfigured" };
  const nodes = Object.values(resolveRoster(undefined, env));
  expect(nodes.map(({ id, sshHost, label }) => ({ id, sshHost, label }))).toEqual([
    { id: "spark-5", sshHost: "lab-east", label: "East" },
  ]);
});

test("a host override changes the destination, not file membership or presentation", () => {
  const nodes = resolveRoster({ "spark-3": { sshHost: "lab-old", label: "GPU bench" } }, { SPARK3_HOST: "lab-new" });
  expect(Object.values(nodes).map(({ id, sshHost, label }) => [id, sshHost, label])).toEqual([
    ["spark-3", "lab-new", "GPU bench"],
  ]);
  expect(() => resolveRoster(nodes, { SPARK4_HOST: "other" })).toThrow(/not in the configured nodes/);
});

test("an invalid roster fails before any SSH fan-out", () => {
  expect(() => resolveRoster(undefined, {})).toThrow(/Configure 1–8/);
  expect(() => resolveRoster({}, { SPARK1_HOST: "extra" })).toThrow();
  for (const input of [[], null, { "spark-8": { sshHost: "extra" } }, { "spark-7": null },
    { "spark-7": {} }, { "spark-7": { sshHost: 7 } }, { "spark-0": { sshHost: "-V" } }]) {
    expect(() => resolveRoster(input, {})).toThrow();
  }
  expect(() => resolveRoster(undefined, { SPARK8_HOST: "ninth" })).toThrow(/Invalid node index/);
  expect(() => resolveRoster({ "spark-0": { sshHost: "same" }, "spark-7": { sshHost: "same" } }, {})).toThrow(/Duplicate sshHost/);
});
