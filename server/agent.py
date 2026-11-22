"""SparkFleet telemetry agent.

Streamed to each node over SSH and run by the system python3 (stdlib only, no
install step). Prints one JSON object per second on stdout, matching the
NodeTelemetry type in shared/types.ts, and exits when stdout closes.
"""

import glob
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import time

INTERVAL_SEC = 1.0
SLOW_EVERY = 4  # ticks between docker / ss / ps refreshes
TOPOLOGY_EVERY = 15  # ticks between interface re-detection
TOP_PROCESSES = 8
MIB = 1024 * 1024


def read_file(path, default=""):
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except OSError:
        return default


def read_int(path, default=0):
    try:
        return int(read_file(path))
    except ValueError:
        return default


def to_float(text):
    try:
        return float(text)
    except ValueError:
        return 0.0


def run_cmd(cmd, timeout=2.5):
    try:
        result = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout
        )
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


# --- CPU -------------------------------------------------------------------


def read_cpu_times():
    """{name: (total, idle, iowait)} for the aggregate ("cpu") and each core."""
    times = {}
    with open("/proc/stat", "r") as f:
        for line in f:
            if not line.startswith("cpu"):
                break  # the cpu rows come first
            parts = line.split()
            vals = [int(x) for x in parts[1:9]]
            times[parts[0]] = (sum(vals), vals[3] + vals[4], vals[4])
    return times


def cpu_usage(prev, cur):
    def busy_pct(name):
        total, idle, _ = cur[name]
        prev_total, prev_idle, _ = prev.get(name, cur[name])
        elapsed = total - prev_total
        return round(100.0 * (1.0 - (idle - prev_idle) / elapsed), 1) if elapsed > 0 else 0.0

    cores = sorted((n for n in cur if n != "cpu"), key=lambda n: int(n[3:]))
    total, _, iowait = cur["cpu"]
    prev_total, _, prev_iowait = prev.get("cpu", cur["cpu"])
    elapsed = total - prev_total
    return {
        "usagePct": busy_pct("cpu"),
        "perCorePct": [busy_pct(n) for n in cores],
        "freqMhz": [
            round(read_int(f"/sys/devices/system/cpu/{n}/cpufreq/scaling_cur_freq") / 1000)
            for n in cores
        ],
        "iowaitPct": round(100.0 * (iowait - prev_iowait) / elapsed, 1) if elapsed > 0 else 0.0,
    }


# --- Memory ----------------------------------------------------------------


def read_memory():
    info = {}
    with open("/proc/meminfo", "r") as f:
        for line in f:
            key, _, rest = line.partition(":")
            info[key] = int(rest.split()[0]) * 1024
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", 0)
    return {
        "totalBytes": total,
        "usedBytes": max(0, total - available),
        "availableBytes": available,
        "cachedBytes": info.get("Cached", 0) + info.get("SReclaimable", 0),
        "swapUsedBytes": max(0, info.get("SwapTotal", 0) - info.get("SwapFree", 0)),
    }


# --- GPU -------------------------------------------------------------------


def read_t_limit():
    out = run_cmd(["nvidia-smi", "-q", "-d", "TEMPERATURE"])
    match = re.search(r"GPU T\.Limit Temp\s*:\s*(\d+)", out)
    return int(match.group(1)) if match else None


def read_gpu(t_limit):
    """Returns (gpu, bytes allocated by compute processes). Reports the first GPU."""
    gpu = {
        "name": "GPU",
        "driver": "",
        "utilPct": 0.0,
        "tempC": 0.0,
        "tLimitMarginC": t_limit,
        "powerW": 0.0,
        "clockGrMhz": 0.0,
        "pstate": "",
        "processes": [],
    }
    out = run_cmd(
        [
            "nvidia-smi",
            "--query-gpu=name,driver_version,utilization.gpu,temperature.gpu,power.draw,clocks.gr,pstate",
            "--format=csv,noheader,nounits",
        ]
    )
    parts = [p.strip() for p in out.splitlines()[0].split(",")] if out else []
    if len(parts) >= 7:
        gpu["name"], gpu["driver"] = parts[0], parts[1]
        gpu["utilPct"] = to_float(parts[2])
        gpu["tempC"] = to_float(parts[3])
        gpu["powerW"] = to_float(parts[4])
        gpu["clockGrMhz"] = to_float(parts[5])
        gpu["pstate"] = parts[6]

    allocated = 0
    out = run_cmd(
        [
            "nvidia-smi",
            "--query-compute-apps=pid,process_name,used_gpu_memory",
            "--format=csv,noheader,nounits",
        ]
    )
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        pid, memory_mib = int(parts[0]), int(to_float(parts[2]))
        allocated += memory_mib * MIB
        cmdline = read_file(f"/proc/{pid}/cmdline").replace("\x00", " ").strip()
        gpu["processes"].append(
            {
                "pid": pid,
                "name": parts[1],
                "memoryMiB": memory_mib,
                "cmdline": (cmdline or parts[1])[:220],
            }
        )
    return gpu, allocated


# --- Thermals and fans -----------------------------------------------------


def read_hwmon(gpu_temp):
    fans, soc, nic, nvme, wifi = [], [], [], [], []
    for path in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        name = read_file(f"{path}/name")
        if name == "acpi_fan":
            fans.append(read_int(f"{path}/fan1_input"))
            continue
        millideg = read_int(f"{path}/temp1_input", None)
        if millideg is None:
            continue
        temp = millideg / 1000.0
        if name.startswith("acpitz"):
            soc.append(temp)
        elif name == "mlx5":
            nic.append(temp)
        elif name == "nvme":
            nvme.append(temp)
        elif "phy" in name:
            wifi.append(temp)

    sensors = [("GPU Die", gpu_temp)]
    if soc:
        sensors += [("SoC Peak", max(soc)), ("SoC Avg", sum(soc) / len(soc))]
    if nic:
        sensors.append(("ConnectX NIC", max(nic)))
    if nvme:
        sensors.append(("NVMe", max(nvme)))
    if wifi:
        sensors.append(("Wi-Fi Radio", max(wifi)))
    thermals = [{"label": label, "tempC": round(temp, 1)} for label, temp in sensors]
    return thermals, (fans + [0, 0])[:2]


# --- Disk ------------------------------------------------------------------


def detect_root_disk():
    """Returns (device mounted at /, its name in /proc/diskstats)."""
    device = ""
    try:
        with open("/proc/mounts", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "/" and parts[0].startswith("/dev/"):
                    device = parts[0]
    except OSError:
        pass
    if not device:
        return "", ""
    name = os.path.basename(os.path.realpath(device))
    if os.path.exists(f"/sys/class/block/{name}/partition"):
        # I/O counters live on the whole disk, the parent of the partition.
        name = os.path.basename(os.path.dirname(os.path.realpath(f"/sys/class/block/{name}")))
    return device, name


def read_disk_sectors(stat_name):
    try:
        with open("/proc/diskstats", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 10 and parts[2] == stat_name:
                    return int(parts[5]), int(parts[9])
    except OSError:
        pass
    return None


def read_disk(device, stat_name, prev_sectors, elapsed):
    st = os.statvfs("/")
    used = (st.f_blocks - st.f_bfree) * st.f_frsize
    avail = st.f_bavail * st.f_frsize
    # Same formula as df: root-reserved blocks count as unavailable, so a disk
    # that ordinary processes can no longer write to reads as 100%.
    used_pct = round(100.0 * used / (used + avail), 2) if used + avail > 0 else 0.0

    sectors = read_disk_sectors(stat_name)
    read_bps = write_bps = 0.0
    if sectors and prev_sectors and elapsed > 0:
        read_bps = max(0.0, (sectors[0] - prev_sectors[0]) * 512.0 / elapsed)
        write_bps = max(0.0, (sectors[1] - prev_sectors[1]) * 512.0 / elapsed)
    disk = {
        "device": device,
        "totalBytes": st.f_blocks * st.f_frsize,
        "usedBytes": used,
        "availBytes": avail,
        "usedPct": used_pct,
        "readBps": round(read_bps, 1),
        "writeBps": round(write_bps, 1),
    }
    return disk, sectors


# --- Network ---------------------------------------------------------------


def ipv4_interfaces():
    """{interface: ip_interface} using the first IPv4 address of each interface."""
    found = {}
    for line in run_cmd(["ip", "-o", "-4", "addr", "show"]).splitlines():
        parts = line.split()
        if len(parts) < 4 or parts[1] in found:
            continue
        try:
            found[parts[1]] = ipaddress.ip_interface(parts[3])
        except ValueError:
            continue
    return found


def default_route_interface():
    best = None
    try:
        with open("/proc/net/route", "r") as f:
            next(f, None)  # header
            for line in f:
                parts = line.split()
                if len(parts) > 6 and parts[1] == "00000000":
                    metric = int(parts[6])
                    if best is None or metric < best[0]:
                        best = (metric, parts[0])
    except (OSError, ValueError):
        pass
    return best[1] if best else ""


def classify_interfaces():
    """Returns ([(interface, role)], addresses).

    The NIC holding the default route is the LAN. Other wired NICs with an
    address are fabric interfaces, RDMA-capable ones first. The A/B slot labels
    are local to this node; peers can have different interfaces on the same subnet.
    """
    addrs = ipv4_interfaces()
    lan = default_route_interface()
    fabric = []
    for name in addrs:
        base = f"/sys/class/net/{name}"
        wired = os.path.exists(f"{base}/device") and not os.path.exists(f"{base}/wireless")
        if wired and name != lan:
            fabric.append(name)
    fabric.sort(
        key=lambda n: (
            not os.path.isdir(f"/sys/class/net/{n}/device/infiniband"),
            int(addrs[n].network.network_address),
        )
    )
    roles = [(lan, "lan")] if lan in addrs else []
    roles += list(zip(fabric, ("fabric-a", "fabric-b")))
    return roles, addrs


def read_interfaces(roles, addrs, prev_counters, elapsed):
    interfaces = []
    for name, role in roles:
        base = f"/sys/class/net/{name}"
        rx = read_int(f"{base}/statistics/rx_bytes")
        tx = read_int(f"{base}/statistics/tx_bytes")
        rx_bps = tx_bps = 0.0
        if name in prev_counters and elapsed > 0:
            prev_rx, prev_tx = prev_counters[name]
            rx_bps = max(0.0, (rx - prev_rx) / elapsed)
            tx_bps = max(0.0, (tx - prev_tx) / elapsed)
        prev_counters[name] = (rx, tx)
        interfaces.append(
            {
                "name": name,
                "role": role,
                "ip": str(addrs[name].ip),
                "subnet": str(addrs[name].network),
                "operstate": read_file(f"{base}/operstate", "unknown"),
                # The kernel reports -1 (or an error) while the link is down.
                "speedMbps": max(0, read_int(f"{base}/speed")),
                "rxBytes": rx,
                "txBytes": tx,
                "rxBps": round(rx_bps, 1),
                "txBps": round(tx_bps, 1),
            }
        )
    return interfaces


# --- Workloads -------------------------------------------------------------


def read_containers():
    out = run_cmd(
        [
            "docker",
            "ps",
            "-a",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}",
        ]
    )
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 5:
            rows.append(
                {
                    "id": parts[0],
                    "name": parts[1],
                    "image": parts[2],
                    "state": parts[3],
                    "status": parts[4],
                    "ports": parts[5] if len(parts) > 5 else "",
                }
            )
    rows.sort(key=lambda r: (r["state"] != "running", r["name"]))
    return rows


def read_top_processes():
    out = run_cmd(["ps", "-eo", "pid,pcpu,rss,comm,args", "--sort=-rss", "--no-headers"])
    rows = []
    for line in out.splitlines()[:TOP_PROCESSES]:
        parts = line.split(None, 4)
        if len(parts) >= 4 and parts[0].isdigit():
            rows.append(
                {
                    "pid": int(parts[0]),
                    "cpuPct": to_float(parts[1]),
                    "rssBytes": int(parts[2]) * 1024,
                    "comm": parts[3],
                    "args": (parts[4] if len(parts) > 4 else parts[3])[:160],
                }
            )
    return rows


def read_listening_ports():
    seen = set()
    rows = []
    for line in run_cmd(["ss", "-tlnpH"]).splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        addr, _, port = parts[3].rpartition(":")
        if not port.isdigit() or (addr, port) in seen:
            continue
        seen.add((addr, port))
        owner = re.search(r'\(\("([^"]+)"', " ".join(parts[5:]))
        rows.append({"addr": addr, "port": int(port), "process": owner.group(1) if owner else "system"})
    rows.sort(key=lambda r: r["port"])
    return rows


# --- Main loop -------------------------------------------------------------


def main():
    hostname = socket.gethostname()
    root_device, root_stat_name = detect_root_disk()
    prev_cpu = {}
    prev_net = {}
    prev_sectors = None
    prev_ts = None
    roles, addrs = [], {}
    t_limit = None
    containers, ports, top = [], [], []
    tick = 0

    while True:
        now = time.time()
        elapsed = now - prev_ts if prev_ts else 0.0
        prev_ts = now

        if tick % TOPOLOGY_EVERY == 0:
            roles, addrs = classify_interfaces()
            t_limit = read_t_limit()
        if tick % SLOW_EVERY == 0:
            containers = read_containers()
            ports = read_listening_ports()
            top = read_top_processes()

        cpu_times = read_cpu_times()
        gpu, gpu_allocated = read_gpu(t_limit)
        memory = read_memory()
        memory["gpuAllocatedBytes"] = gpu_allocated
        thermals, fans = read_hwmon(gpu["tempC"])
        disk, prev_sectors = read_disk(root_device, root_stat_name, prev_sectors, elapsed)
        load = (read_file("/proc/loadavg", "0 0 0").split() + ["0", "0", "0"])[:3]

        payload = {
            "hostname": hostname,
            "uptimeSec": int(to_float(read_file("/proc/uptime", "0").split()[0])),
            "loadAvg": [to_float(x) for x in load],
            "cpu": cpu_usage(prev_cpu, cpu_times),
            "memory": memory,
            "gpu": gpu,
            "thermals": thermals,
            "fansRpm": fans,
            "disk": disk,
            "interfaces": read_interfaces(roles, addrs, prev_net, elapsed),
            "containers": containers,
            "topProcesses": top,
            "ports": ports,
        }
        prev_cpu = cpu_times

        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        tick += 1
        time.sleep(max(0.1, INTERVAL_SEC - (time.time() - now)))


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        # The control plane disconnected; nothing left to report to.
        pass
