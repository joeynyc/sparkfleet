import type { NodeConfig, NodeId } from "../shared/types";
import fs from "node:fs";
import path from "node:path";

interface UserNodeOverride {
  sshHost?: string;
  label?: string;
  role?: string;
  lanIp?: string;
  tailscaleIp?: string;
  fabricIps?: string[];
  accent?: string;
}

interface UserConfigFile {
  port?: number;
  nodes?: Partial<Record<NodeId, UserNodeOverride>>;
}

export const HISTORY_LIMIT = 300; // 5 minutes at 1Hz
export const NODE_IDS: NodeId[] = ["spark-0", "spark-1"];

const DEFAULT_NODES: Record<NodeId, NodeConfig> = {
  "spark-0": {
    id: "spark-0",
    sshHost: "spark-1",
    label: "SPARK-01",
    role: "RANK 0 · PRIMARY",
    lanIp: "",
    tailscaleIp: "",
    fabricIps: [],
    accent: "#76B900",
  },
  "spark-1": {
    id: "spark-1",
    sshHost: "spark-2",
    label: "SPARK-02",
    role: "RANK 1 · PEER",
    lanIp: "",
    tailscaleIp: "",
    fabricIps: [],
    accent: "#38BDF8",
  },
};

function loadConfigFile(): UserConfigFile {
  const customPath = process.env.SPARKFLEET_CONFIG;
  const candidate = customPath
    ? path.resolve(customPath)
    : path.resolve(import.meta.dir, "../sparkfleet.config.json");

  if (!fs.existsSync(candidate)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf8")) as UserConfigFile;
  } catch (err) {
    console.warn(`Warning: failed to parse ${candidate}:`, err);
    return {};
  }
}

const fileCfg = loadConfigFile();

export const SERVER_PORT = Number(
  process.env.SPARKFLEET_PORT || fileCfg.port || 7700
);

function resolveNode(id: NodeId, envPrefix: string): NodeConfig {
  const base = DEFAULT_NODES[id];
  const ov = fileCfg.nodes?.[id] ?? {};
  const envHost = process.env[`${envPrefix}_HOST`];
  const envLabel = process.env[`${envPrefix}_LABEL`];
  const envRole = process.env[`${envPrefix}_ROLE`];
  const envLan = process.env[`${envPrefix}_LAN_IP`];

  return {
    id,
    sshHost: envHost || ov.sshHost || base.sshHost,
    label: envLabel || ov.label || base.label,
    role: envRole || ov.role || base.role,
    lanIp: envLan ?? ov.lanIp ?? base.lanIp,
    tailscaleIp: ov.tailscaleIp ?? base.tailscaleIp,
    fabricIps: ov.fabricIps ?? base.fabricIps,
    accent: ov.accent || base.accent,
  };
}

export const NODES: Record<NodeId, NodeConfig> = {
  "spark-0": resolveNode("spark-0", "SPARK0"),
  "spark-1": resolveNode("spark-1", "SPARK1"),
};
