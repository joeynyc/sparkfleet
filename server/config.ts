import fs from "node:fs";
import path from "node:path";
import { resolveRoster } from "./roster";

interface ConfigFile {
  port?: number;
  nodes?: unknown;
}

const DEFAULT_PORT = 7700;

function loadConfigFile(): ConfigFile {
  const file = path.resolve(
    process.env.SPARKFLEET_CONFIG ?? path.join(import.meta.dir, "../sparkfleet.config.json")
  );
  if (!process.env.SPARKFLEET_CONFIG && !fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a configuration object");
    }
    return parsed as ConfigFile;
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

export const SERVER_PORT = resolvePort();
export const NODES = resolveRoster(fileConfig.nodes, process.env);
export const NODE_IDS: readonly string[] = Object.keys(NODES);
