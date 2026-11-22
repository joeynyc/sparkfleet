import fs from "node:fs";
import path from "node:path";
import type { NodeConfig, NodeId } from "../shared/types";
import { assertSafeSshHost } from "./ssh";

type NodeOverride = Partial<Omit<NodeConfig, "id">>;

interface ConfigFile {
  port?: number;
  nodes?: Partial<Record<NodeId, NodeOverride>>;
}

const DEFAULT_PORT = 7700;

const DEFAULT_NODES: Record<NodeId, NodeConfig> = {
  "spark-0": {
    id: "spark-0",
    sshHost: "spark-1",
    label: "SPARK-01",
    role: "RANK 0 · PRIMARY",
    accent: "#76B900",
  },
  "spark-1": {
    id: "spark-1",
    sshHost: "spark-2",
    label: "SPARK-02",
    role: "RANK 1 · PEER",
    accent: "#38BDF8",
  },
};

function loadConfigFile(): ConfigFile {
  const file = path.resolve(
    process.env.SPARKFLEET_CONFIG ?? path.join(import.meta.dir, "../sparkfleet.config.json")
  );
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ConfigFile;
  } catch (err) {
    // Falling back to defaults here would silently point at the wrong hosts.
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

const fileConfig = loadConfigFile();

function resolvePort(): number {
  const port = Number(process.env.SPARKFLEET_PORT || fileConfig.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${process.env.SPARKFLEET_PORT || fileConfig.port}"`);
  }
  return port;
}

function resolveNode(id: NodeId, envPrefix: string): NodeConfig {
  const base = DEFAULT_NODES[id];
  const override = fileConfig.nodes?.[id] ?? {};
  return {
    id,
    sshHost: assertSafeSshHost(process.env[`${envPrefix}_HOST`] || override.sshHost || base.sshHost),
    label: process.env[`${envPrefix}_LABEL`] || override.label || base.label,
    role: process.env[`${envPrefix}_ROLE`] || override.role || base.role,
    accent: override.accent || base.accent,
  };
}

export const SERVER_PORT = resolvePort();

export const NODES: Record<NodeId, NodeConfig> = {
  "spark-0": resolveNode("spark-0", "SPARK0"),
  "spark-1": resolveNode("spark-1", "SPARK1"),
};
