export type NodeId = "spark-0" | "spark-1";

export interface NodeConfig {
  id: NodeId;
  sshHost: string;
  label: string;
  role: string;
  lanIp: string;
  tailscaleIp: string;
  fabricIps: string[];
  accent: string;
}

export interface GpuProcess {
  pid: number;
  name: string;
  memoryMiB: number;
  cmdline?: string;
}

export interface NetworkInterfaceMetric {
  name: string;
  role: "fabric-a" | "fabric-b" | "lan" | "tailscale" | "other";
  ip: string;
  operstate: string;
  speedMbps: number;
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
  rxErrors: number;
  txErrors: number;
}

export interface RdmaLinkState {
  hca: string;
  netdev: string;
  state: string;
  physicalState: string;
  portXmitData: number;
  portRcvData: number;
  errors: number;
}

export interface ThermalSensor {
  label: string;
  category: "gpu" | "soc" | "nic" | "nvme" | "wifi";
  tempC: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  created: string;
}

export interface TopProcess {
  pid: number;
  cpuPct: number;
  memPct: number;
  rssBytes: number;
  comm: string;
  args: string;
}

export interface ListeningPort {
  addr: string;
  port: number;
  process: string;
  pid: number | null;
}

export interface NodeSnapshot {
  id: NodeId;
  sshHost: string;
  label: string;
  role: string;
  accent: string;
  connected: boolean;
  error: string | null;
  lastUpdated: number;
  sshRttMs: number | null;
  hostname: string;
  kernel: string;
  uptimeSec: number;
  loadAvg: [number, number, number];
  cpu: {
    cores: number;
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
    buffersBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
    gpuAllocatedBytes: number;
  };
  gpu: {
    name: string;
    driver: string;
    utilPct: number;
    memUtilPct: number;
    tempC: number;
    tLimitMarginC: number | null;
    powerW: number;
    clockGrMhz: number;
    pstate: string;
    processes: GpuProcess[];
  };
  thermals: ThermalSensor[];
  fansRpm: [number, number];
  disk: {
    mount: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    availBytes: number;
    usedPct: number;
    readBps: number;
    writeBps: number;
  };
  interfaces: NetworkInterfaceMetric[];
  rdmaLinks: RdmaLinkState[];
  containers: ContainerInfo[];
  topProcesses: TopProcess[];
  ports: ListeningPort[];
}

export interface HistoryPoint {
  ts: number;
  gpuUtil: number;
  gpuPowerW: number;
  gpuTempC: number;
  gpuClockMhz: number;
  cpuUtil: number;
  memUsedGb: number;
  gpuMemGb: number;
  fabricRxBps: number;
  fabricTxBps: number;
  lanRxBps: number;
  lanTxBps: number;
  diskReadBps: number;
  diskWriteBps: number;
  fanRpmAvg: number;
}

export interface LocalHostSnapshot {
  hostname: string;
  chip: string;
  osVersion: string;
  memTotalBytes: number;
  memUsedBytes: number;
  cpuUsagePct: number;
  loadAvg: [number, number, number];
  uptimeSec: number;
  tailscaleSelfIp: string;
  lastUpdated: number;
}

export interface FabricTelemetry {
  linkA: {
    subnet: string;
    speedGbps: number;
    state: "ACTIVE" | "DEGRADED" | "DOWN";
    spark0To1Bps: number;
    spark1To0Bps: number;
    totalBytesTransferred: number;
  };
  linkB: {
    subnet: string;
    speedGbps: number;
    state: "ACTIVE" | "DEGRADED" | "DOWN";
    spark0To1Bps: number;
    spark1To0Bps: number;
    totalBytesTransferred: number;
  };
  combinedThroughputBps: number;
  lastProbe: FabricProbeResult | null;
}

export interface FabricProbeResult {
  ts: number;
  fabricAPingMs: number | null;
  fabricBPingMs: number | null;
  lanPingMs: number | null;
  macToSpark0Ms: number | null;
  macToSpark1Ms: number | null;
  fabricALossPct: number | null;
  fabricBLossPct: number | null;
  rdmaSummary: string;
}

export interface AlertItem {
  id: string;
  severity: "critical" | "warn" | "info";
  nodeId: NodeId | "cluster";
  title: string;
  detail: string;
  metric: string;
}

export interface FleetStatePayload {
  ts: number;
  nodes: Record<NodeId, NodeSnapshot>;
  history: Record<NodeId, HistoryPoint[]>;
  fabric: FabricTelemetry;
  localHost: LocalHostSnapshot;
  alerts: AlertItem[];
}

export interface ExecResult {
  nodeId: NodeId;
  sshHost: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
