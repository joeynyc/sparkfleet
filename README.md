# SparkFleet

Localhost telemetry and control-plane cockpit for dual **NVIDIA DGX Spark (GB10)** clusters connected over **dual 200GbE ConnectX-7 RoCE**, run from a Mac or Linux workstation over your existing SSH configuration.

Zero agents to install on the Sparks: SparkFleet streams a lightweight Python telemetry collector over persistent SSH sessions and exposes a Bun + React dashboard on `127.0.0.1:7700`.

## Features

- **1Hz Dual-Node GB10 Telemetry:** SM utilization, graphics clocks, board power draw, thermal limit margin, multi-zone hwmon sensors (GB10 die, Grace SoC, ConnectX-7 NIC, NVMe, Wi-Fi), dual fan RPMs, and active GPU compute PIDs.
- **256 GB Unified Memory (UMA) Breakdown:** Splits GPU compute allocations, active host memory, page cache, and swap across both 128 GB LPDDR5X nodes.
- **20-Core Grace ARMv9 Matrix:** Real-time per-core utilization bars across all 10x Cortex-X925 + 10x Cortex-A725 cores per node.
- **ConnectX-7 400GbE Fabric Bridge:** Live bidirectional throughput, cumulative bytes transferred, RDMA HCA status (`rocep1s0f1` / `roceP2p1s0f1`), and one-click inter-Spark + workstation-to-Spark RTT probes.
- **Workloads & Docker Control:** Fleet-wide container inventory across both nodes with start/stop/restart actions, live log streaming drawer, top RSS processes, and TCP listening port map.
- **Dual Oscilloscopes:** Rolling 5-minute 1Hz Canvas charts comparing GPU util, power draw, fabric throughput, thermals, CPU, and UMA usage.
- **Parallel Fleet Ops & Synchronized SSH PTYs:** Execute commands across both nodes simultaneously with timed output panes, plus two full interactive `xterm.js` SSH terminals with a broadcast **Sync Send** bar.
- **NVMe Capacity Alerts & Inspector:** Automatic capacity warnings with one-click home/Docker disk breakdown over SSH.

## Requirements

- [Bun](https://bun.sh) 1.3+ on the local control workstation (macOS or Linux)
- Passwordless SSH access to both DGX Spark nodes configured in `~/.ssh/config` (works out of the box with NVIDIA Sync SSH configs)
- `python3`, `nvidia-smi`, and `docker` available on the Spark nodes (preinstalled on DGX OS)

## Quick Start

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create your local cluster config (this file is gitignored):
   ```bash
   cp sparkfleet.config.example.json sparkfleet.config.json
   ```
   Edit `sparkfleet.config.json` to set your SSH host aliases (`sshHost`) matching `~/.ssh/config`. LAN and RoCE IPs are auto-discovered from the live nodes once connected, so only `sshHost` is strictly required.

   Alternatively, configure via environment variables:
   ```bash
   SPARK0_HOST=my-spark-1 SPARK1_HOST=my-spark-2 bun run start
   ```

3. Build and start the localhost control plane:
   ```bash
   bun run start
   ```
   Open [http://127.0.0.1:7700](http://127.0.0.1:7700).

## Development

Run the Bun API/WebSocket server and Vite dev server in two terminals:

```bash
bun run dev       # http://127.0.0.1:7700 (telemetry + PTY WebSockets)
bun run dev:web   # http://127.0.0.1:5173 (Vite HMR proxied to :7700)
```

## Security Model

- Binds strictly to `127.0.0.1` by default (never exposed to the LAN unless explicitly modified).
- Stores no SSH keys or credentials; delegates authentication to your local `ssh` binary and `~/.ssh/config`.
- Local cluster hostnames and IPs live in `sparkfleet.config.json` (listed in `.gitignore`).

## License

MIT
