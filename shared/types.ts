/** A configured fleet key, not an SSH destination supplied by a client. */
export type NodeId = string;

export interface NodeConfig {
  id: NodeId;
  /** Alias from ~/.ssh/config, or a hostname. */
  sshHost: string;
  label: string;
  role: string;
  accent: string;
}

export interface GpuProcess {
  pid: number;
  name: string;
  memoryMiB: number;
  cmdline: string;
}

/** A node has one LAN interface (its default route) and any number of fabric interfaces. */
export type InterfaceRole = "lan" | "fabric";

export interface NetworkInterfaceMetric {
  name: string;
  role: InterfaceRole;
  ip: string;
  /** Network in CIDR form, e.g. `10.0.0.0/24`. */
  subnet: string;
  operstate: string;
  /** 0 when the link is down or the driver does not report a speed. */
  speedMbps: number;
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
}

export interface ThermalSensor {
  label: string;
  tempC: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface TopProcess {
  pid: number;
  cpuPct: number;
  rssBytes: number;
  comm: string;
  args: string;
}

export interface ListeningPort {
  addr: string;
  port: number;
  process: string;
}

/** One sample from the agent running on a node (see server/agent.py). */
export interface NodeTelemetry {
  hostname: string;
  uptimeSec: number;
  loadAvg: [number, number, number];
  cpu: {
    usagePct: number;
    perCorePct: number[];
    freqMhz: number[];
    iowaitPct: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    cachedBytes: number;
    swapUsedBytes: number;
    gpuAllocatedBytes: number;
  };
  gpu: {
    name: string;
    driver: string;
    utilPct: number;
    tempC: number;
    /** Degrees of headroom before the GPU's thermal limit, when the driver reports it. */
    tLimitMarginC: number | null;
    powerW: number;
    clockGrMhz: number;
    pstate: string;
    processes: GpuProcess[];
  };
  thermals: ThermalSensor[];
  fansRpm: [number, number];
  disk: {
    device: string;
    totalBytes: number;
    usedBytes: number;
    /** Space an unprivileged process can still write; excludes root-reserved blocks. */
    availBytes: number;
    /** used / (used + avail), the figure `df` prints. */
    usedPct: number;
    readBps: number;
    writeBps: number;
  };
  interfaces: NetworkInterfaceMetric[];
  containers: ContainerInfo[];
  topProcesses: TopProcess[];
  ports: ListeningPort[];
}

export interface NodeSnapshot extends NodeTelemetry {
  id: NodeId;
  sshHost: string;
  label: string;
  role: string;
  accent: string;
  connected: boolean;
  error: string | null;
  /** ICMP round trip from the control host to the node's LAN address. */
  hostRttMs: number | null;
}

export interface HistoryPoint {
  /** When the control plane received the sample, in ms since the epoch. */
  ts: number;
  gpuUtil: number;
  gpuPowerW: number;
  gpuTempC: number;
  cpuUtil: number;
  memUsedGb: number;
  /** Receive plus transmit across all of the node's fabric interfaces. */
  fabricBps: number;
}

export interface LocalHostSnapshot {
  hostname: string;
  chip: string;
  osVersion: string;
  memTotalBytes: number;
  memUsedBytes: number;
  cpuUsagePct: number;
}

/** One ping run from a source interface to the peer's interface on the same network. */
export interface ProbePath {
  kind: InterfaceRole;
  /** The shared network for a fabric path; the source's LAN network for a LAN path. */
  subnet: string;
  sourceIface: string;
  targetIface: string;
  /** Null when no reply came back or the ping could not run. */
  rttMs: number | null;
  /** Null when the ping could not run. */
  lossPct: number | null;
}

/** A directed measurement. `paths` is empty when the two nodes share no probeable network. */
export interface FabricProbeResult {
  source: NodeId;
  target: NodeId;
  ts: number;
  paths: ProbePath[];
}

export interface AlertItem {
  id: string;
  severity: "critical" | "warn";
  kind: "offline" | "disk" | "thermal" | "memory";
  nodeId: NodeId;
  title: string;
  detail: string;
  metric: string;
}

export interface FleetStatePayload {
  nodes: Record<NodeId, NodeSnapshot>;
  history: Record<NodeId, HistoryPoint[]>;
  probes: FabricProbeResult[];
  localHost: LocalHostSnapshot;
  alerts: AlertItem[];
}

/** Sections of a node snapshot that change rarely; a tick carries one only when it changed. */
export type SlowNodeField = "containers" | "topProcesses" | "ports";

export type NodeUpdate = Omit<NodeSnapshot, SlowNodeField> & Partial<Pick<NodeSnapshot, SlowNodeField>>;

/** A periodic update: current state plus history points added since the last tick. */
export interface FleetTick {
  nodes: Partial<Record<NodeId, NodeUpdate>>;
  points: Record<NodeId, HistoryPoint[]>;
  probes: FabricProbeResult[];
  localHost: LocalHostSnapshot;
  alerts: AlertItem[];
}

/** Telemetry WebSocket protocol: one `init` on connect, then ticks when collector state changes. */
export type ServerMessage =
  | { type: "init"; payload: FleetStatePayload }
  | { type: "tick"; payload: FleetTick };

export interface ExecResult {
  nodeId: NodeId;
  sshHost: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Output exceeded the server's cap and the command was stopped. */
  truncated: boolean;
  timedOut: boolean;
}
