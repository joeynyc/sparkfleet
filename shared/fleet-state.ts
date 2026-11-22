import type { FleetStatePayload, FleetTick, HistoryPoint, NodeId } from "./types";

export const NODE_IDS: readonly NodeId[] = ["spark-0", "spark-1"];

/** Rolling window kept per node: five minutes at one sample per second. */
export const HISTORY_LIMIT = 300;

/** Folds a tick into the previous state, appending its points and trimming to the window. */
export function applyTick(
  state: FleetStatePayload,
  tick: FleetTick,
  limit = HISTORY_LIMIT
): FleetStatePayload {
  const history = {} as Record<NodeId, HistoryPoint[]>;
  for (const id of NODE_IDS) {
    const added = tick.points[id];
    const merged = added.length > 0 ? [...state.history[id], ...added] : state.history[id];
    history[id] = merged.length > limit ? merged.slice(merged.length - limit) : merged;
  }
  return {
    nodes: tick.nodes,
    history,
    fabric: tick.fabric,
    localHost: tick.localHost,
    alerts: tick.alerts,
  };
}
