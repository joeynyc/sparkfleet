import { expect, test } from "bun:test";
import { applyTick } from "./fleet-state";
import type { FleetStatePayload, FleetTick, HistoryPoint } from "./types";

const point = (gpuUtil: number): HistoryPoint => ({
  ts: 0,
  gpuUtil,
  gpuPowerW: 0,
  gpuTempC: 0,
  cpuUtil: 0,
  memUsedGb: 0,
  fabricBps: 0,
});

const live = {
  nodes: {} as FleetStatePayload["nodes"],
  probes: [],
  localHost: {} as FleetStatePayload["localHost"],
  alerts: [],
};

function stateWith(spark0: number[], spark1: number[]): FleetStatePayload {
  return { ...live, history: { "spark-0": spark0.map(point), "spark-1": spark1.map(point) } };
}

function tickWith(spark0: number[], spark1: number[]): FleetTick {
  return { ...live, points: { "spark-0": spark0.map(point), "spark-1": spark1.map(point) } };
}

const utils = (points: HistoryPoint[]) => points.map((p) => p.gpuUtil);

test("appends each node's new points in order", () => {
  const next = applyTick(stateWith([1, 2], [10]), tickWith([3], [11, 12]));
  expect(utils(next.history["spark-0"])).toEqual([1, 2, 3]);
  expect(utils(next.history["spark-1"])).toEqual([10, 11, 12]);
});

test("a node that reported nothing keeps its history", () => {
  const next = applyTick(stateWith([1, 2], [10]), tickWith([], [11]));
  expect(utils(next.history["spark-0"])).toEqual([1, 2]);
});

test("drops the oldest points once the window is full", () => {
  const next = applyTick(stateWith([1, 2, 3], []), tickWith([4, 5], []), 3);
  expect(utils(next.history["spark-0"])).toEqual([3, 4, 5]);
});

test("does not mutate the previous state", () => {
  const prev = stateWith([1], []);
  applyTick(prev, tickWith([2], []));
  expect(utils(prev.history["spark-0"])).toEqual([1]);
});

test("a tick keeps sparse configured IDs and never adds placeholder nodes", () => {
  const history = { "spark-7": [point(17)], "spark-2": [point(2)] };
  const points = { "spark-7": [point(18)], "spark-2": [] };
  const next = applyTick({ ...live, history }, { ...live, points });
  expect(Object.keys(next.history)).toEqual(["spark-7", "spark-2"]);
  expect(utils(next.history["spark-7"])).toEqual([17, 18]);
  expect(next.history["spark-2"]).toBe(history["spark-2"]);
});

test("a tick without a node's slow sections keeps the ones already held", () => {
  const containers = [{ id: "c1", name: "job", image: "img", state: "running", status: "Up", ports: "" }];
  const held = { connected: true, containers, ports: [], topProcesses: [] } as unknown as FleetStatePayload["nodes"][string];
  const state = { ...stateWith([], []), nodes: { "spark-0": held } };
  const update = { connected: false } as FleetTick["nodes"][string];
  const next = applyTick(state, { ...tickWith([], []), nodes: { "spark-0": update } });
  expect(next.nodes["spark-0"].connected).toBe(false);
  expect(next.nodes["spark-0"].containers).toBe(containers);

  const replaced = applyTick(next, { ...tickWith([], []), nodes: { "spark-0": { ...update, containers: [] } } });
  expect(replaced.nodes["spark-0"].containers).toEqual([]);
});

test("takes live sections from the tick", () => {
  const alerts: FleetTick["alerts"] = [
    { id: "a", severity: "warn", kind: "disk", nodeId: "spark-0", title: "t", detail: "d", metric: "m" },
  ];
  const next = applyTick(stateWith([], []), { ...tickWith([], []), alerts });
  expect(next.alerts).toBe(alerts);
});
