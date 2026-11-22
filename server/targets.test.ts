import { describe, expect, test } from "bun:test";
import { execTargets, isConfiguredNode } from "./targets";

const ids = ["spark-2", "spark-7"];

describe("configured targets", () => {
  test("accepts only configured IDs, including sparse inventories", () => {
    expect(isConfiguredNode(ids, "spark-7")).toBe(true);
    for (const bad of ["spark-0", "spark-8", "constructor", "__proto__", null, ["spark-2"]]) {
      expect(isConfiguredNode(ids, bad)).toBe(false);
    }
  });

  test("defaults a command-only request to the inventory and runs a repeated ID once", () => {
    expect(execTargets(ids, { command: "hostname" })).toBe(ids);
    expect(execTargets(ids, { nodes: ["spark-7", "spark-2", "spark-7"] })).toEqual(["spark-7", "spark-2"]);
  });

  test("refuses malformed and mixed targets instead of dispatching to a subset or the fleet", () => {
    for (const nodes of [[], null, "spark-2", {}, ["spark-7", "spark-1"], ["__proto__"], [null, "spark-2"]]) {
      expect(execTargets(ids, { nodes })).toBeNull();
    }
    const misspelled = { command: "hostname", node: "spark-7" };
    expect(execTargets(ids, misspelled)).toBeNull();
  });
});
