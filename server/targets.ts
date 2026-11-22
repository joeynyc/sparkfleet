import type { NodeId } from "../shared/types";

export function isConfiguredNode(ids: readonly NodeId[], value: unknown): value is NodeId {
  return typeof value === "string" && ids.includes(value);
}

/** A command alone means the whole fleet. Never widen a malformed target selection. */
export function execTargets(ids: readonly NodeId[], request: { command?: unknown; nodes?: unknown }): readonly NodeId[] | null {
  if (!Object.hasOwn(request, "nodes")) {
    return Object.keys(request).every((key) => key === "command") ? ids : null;
  }
  const { nodes } = request;
  if (!Array.isArray(nodes) || !nodes.length || !nodes.every((id) => isConfiguredNode(ids, id))) return null;
  return [...new Set(nodes)];
}
