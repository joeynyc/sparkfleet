import type { NodeConfig, NodeId } from "../shared/types";
import { assertSafeSshHost } from "./ssh";

const ACCENTS = ["#76B900", "#38BDF8", "#FBBF24", "#C084FC", "#2DD4BF", "#FB7185", "#A5B4FC", "#FDBA74"];
const SLOT_ID = /^spark-[0-7]$/;
const SETUP_HINT = "Configure 1–8 SSH hosts in sparkpit.config.json (spark-0 through spark-7), or set SPARK0_HOST to an SSH alias.";

type Env = Readonly<Record<string, string | undefined>>;

type NodeFields = Partial<Record<"sshHost" | "label" | "role" | "accent", unknown>>;

/** The file defines membership when present. Without a list, only explicit HOST variables create nodes. */
export function resolveRoster(input: unknown, env: Env): Record<NodeId, NodeConfig> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new Error(`nodes must be an object. ${SETUP_HINT}`);
  }
  const configured = input as Record<string, NodeFields> | undefined;
  const slots = new Set(Object.keys(configured ?? {}));
  for (const id of slots) {
    if (!SLOT_ID.test(id)) throw new Error(`Invalid node ID: ${id}. ${SETUP_HINT}`);
  }
  for (const key of Object.keys(env)) {
    const match = /^SPARK(\d+)_HOST$/.exec(key);
    if (!match || !env[key]) continue;
    const id = `spark-${match[1]}`;
    if (!SLOT_ID.test(id)) throw new Error(`Invalid node index in ${key}. ${SETUP_HINT}`);
    if (configured && !slots.has(id)) throw new Error(`${key} refers to ${id}, which is not in the configured nodes.`);
    slots.add(id);
  }
  if (!slots.size) throw new Error(SETUP_HINT);

  const nodes: Record<NodeId, NodeConfig> = {};
  const hosts = new Set<string>();
  for (const id of [...slots].sort()) {
    const slot = Number(id.slice("spark-".length));
    const row = configured ? configured[id] : {};
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`nodes.${id} must be an object with an sshHost.`);
    }
    const field = (name: string, value: unknown): string => {
      if (typeof value !== "string" || !value.trim()) throw new Error(`nodes.${id}.${name} must be a nonempty string.`);
      return value;
    };
    // An empty variable is the same as an unset one.
    const fromEnv = (name: string) => env[`SPARK${slot}_${name}`] || undefined;
    const sshHost = assertSafeSshHost(field("sshHost", fromEnv("HOST") ?? row.sshHost));
    if (hosts.has(sshHost)) throw new Error(`Duplicate sshHost on ${id}; use one entry per Spark.`);
    hosts.add(sshHost);
    const accent = field("accent", row.accent ?? ACCENTS[slot]);
    if (!/^#[a-f\d]{6}$/i.test(accent)) throw new Error(`nodes.${id}.accent must be a six-digit hex color (#RRGGBB).`);
    nodes[id] = {
      id, sshHost, accent,
      label: field("label", fromEnv("LABEL") ?? row.label ?? `SPARK-0${slot + 1}`),
      role: field("role", fromEnv("ROLE") ?? row.role ?? "DGX SPARK"),
    };
  }
  return nodes;
}
