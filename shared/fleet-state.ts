import type { FleetStatePayload, FleetTick, HistoryPoint, NodeId } from "./types";

/** Rolling window kept per node: five minutes at one sample per second. */
export const HISTORY_LIMIT = 300;

/** Folds a tick into the previous state, appending its points and trimming to the window. */
export function applyTick(
  state: FleetStatePayload,
  tick: FleetTick,
  limit = HISTORY_LIMIT
): FleetStatePayload {
  const history = {} as Record<NodeId, HistoryPoint[]>;
  for (const [id, added] of Object.entries(tick.points)) {
    const prior = state.history[id] ?? [];
    const merged = added.length > 0 ? [...prior, ...added] : prior;
    history[id] = merged.length > limit ? merged.slice(merged.length - limit) : merged;
  }
  return {
    nodes: tick.nodes,
    history,
    probes: tick.probes,
    localHost: tick.localHost,
    alerts: tick.alerts,
  };
}
