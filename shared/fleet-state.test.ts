import { expect, test } from "bun:test";
import { applyTick } from "./fleet-state";
import type { FleetStatePayload, FleetTick, HistoryPoint } from "./types";

const point = (gpuUtil: number): HistoryPoint => ({
  gpuUtil,
  gpuPowerW: 0,
  gpuTempC: 0,
  cpuUtil: 0,
  memUsedGb: 0,
  fabricBps: 0,
});

const live = {
  nodes: {} as FleetStatePayload["nodes"],
  fabric: {} as FleetStatePayload["fabric"],
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

test("takes live sections from the tick", () => {
  const alerts: FleetTick["alerts"] = [
    { id: "a", severity: "warn", kind: "disk", nodeId: "spark-0", title: "t", detail: "d", metric: "m" },
  ];
  const next = applyTick(stateWith([], []), { ...tickWith([], []), alerts });
  expect(next.alerts).toBe(alerts);
});
