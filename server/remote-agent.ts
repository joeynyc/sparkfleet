export const REMOTE_TELEMETRY_AGENT_PY = String.raw`
import json, os, re, subprocess, sys, time, glob, socket

def read_file(path, default=""):
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except Exception:
        return default

def run_cmd(cmd, timeout=2.5):
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""

hostname = socket.gethostname()
kernel = run_cmd(["uname", "-r"])
prev_cpu = {}
prev_net = {}
prev_disk = None
prev_ts = None
tick = 0
cached_containers = []
cached_ports = []
cached_top = []
cached_rdma = []
cached_ips = {}
cached_tlimit = None

def parse_proc_stat():
    stats = {}
    try:
        with open("/proc/stat", "r") as f:
            for line in f:
                if line.startswith("cpu"):
                    parts = line.split()
                    name = parts[0]
                    vals = [int(x) for x in parts[1:9]]
                    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
                    total = sum(vals)
                    iowait = vals[4] if len(vals) > 4 else 0
                    stats[name] = (total, idle, iowait)
    except Exception:
        pass
    return stats

def parse_meminfo():
    m = {}
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    k = parts[0].strip()
                    v = int(parts[1].strip().split()[0]) * 1024
                    m[k] = v
    except Exception:
        pass
    total = m.get("MemTotal", 0)
    avail = m.get("MemAvailable", 0)
    cached = m.get("Cached", 0) + m.get("SReclaimable", 0)
    buffers = m.get("Buffers", 0)
    used = max(0, total - avail)
    swap_total = m.get("SwapTotal", 0)
    swap_free = m.get("SwapFree", 0)
    return {
        "totalBytes": total,
        "usedBytes": used,
        "availableBytes": avail,
        "cachedBytes": cached,
        "buffersBytes": buffers,
        "swapTotalBytes": swap_total,
        "swapUsedBytes": max(0, swap_total - swap_free),
    }

def parse_gpu():
    out = run_cmd([
        "nvidia-smi",
        "--query-gpu=name,driver_version,utilization.gpu,utilization.memory,temperature.gpu,power.draw,clocks.gr,pstate",
        "--format=csv,noheader,nounits"
    ])
    gpu = {
        "name": "NVIDIA GB10",
        "driver": "",
        "utilPct": 0.0,
        "memUtilPct": 0.0,
        "tempC": 0.0,
        "tLimitMarginC": cached_tlimit,
        "powerW": 0.0,
        "clockGrMhz": 0.0,
        "pstate": "P0",
        "processes": [],
    }
    if out:
        line = out.splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 8:
            def fnum(s):
                try:
                    return float(s)
                except Exception:
                    return 0.0
            gpu["name"] = parts[0]
            gpu["driver"] = parts[1]
            gpu["utilPct"] = fnum(parts[2])
            gpu["memUtilPct"] = fnum(parts[3])
            gpu["tempC"] = fnum(parts[4])
            gpu["powerW"] = fnum(parts[5])
            gpu["clockGrMhz"] = fnum(parts[6])
            gpu["pstate"] = parts[7]
    pout = run_cmd([
        "nvidia-smi",
        "--query-compute-apps=pid,process_name,used_gpu_memory",
        "--format=csv,noheader,nounits"
    ])
    procs = []
    gpu_alloc = 0
    if pout:
        for line in pout.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3 and parts[0].isdigit():
                pid = int(parts[0])
                mem = 0
                try:
                    mem = int(float(parts[2]))
                except Exception:
                    mem = 0
                gpu_alloc += mem * 1024 * 1024
                cmdline = read_file(f"/proc/{pid}/cmdline").replace("\x00", " ").strip()
                procs.append({
                    "pid": pid,
                    "name": parts[1],
                    "memoryMiB": mem,
                    "cmdline": cmdline[:220] if cmdline else parts[1],
                })
    gpu["processes"] = procs
    return gpu, gpu_alloc

def parse_hwmon():
    thermals = []
    fans = [0, 0]
    fan_idx = 0
    mlx_temps = []
    nvme_temps = []
    soc_temps = []
    wifi_temp = None
    for d in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        name = read_file(os.path.join(d, "name"))
        if name == "acpi_fan":
            v = read_file(os.path.join(d, "fan1_input"))
            if v.isdigit() and fan_idx < 2:
                fans[fan_idx] = int(v)
                fan_idx += 1
        elif name == "mlx5":
            v = read_file(os.path.join(d, "temp1_input"))
            if v.lstrip("-").isdigit():
                mlx_temps.append(int(v) / 1000.0)
        elif name == "nvme":
            v = read_file(os.path.join(d, "temp1_input"))
            if v.lstrip("-").isdigit():
                nvme_temps.append(int(v) / 1000.0)
        elif name.startswith("acpitz"):
            v = read_file(os.path.join(d, "temp1_input"))
            if v.lstrip("-").isdigit():
                soc_temps.append((name, int(v) / 1000.0))
        elif "mt7925" in name:
            v = read_file(os.path.join(d, "temp1_input"))
            if v.lstrip("-").isdigit():
                wifi_temp = int(v) / 1000.0
    if soc_temps:
        peak_soc = max(t for _, t in soc_temps)
        avg_soc = sum(t for _, t in soc_temps) / len(soc_temps)
        thermals.append({"label": "Grace SoC Peak", "category": "soc", "tempC": round(peak_soc, 1)})
        thermals.append({"label": "Grace SoC Avg", "category": "soc", "tempC": round(avg_soc, 1)})
    if mlx_temps:
        thermals.append({"label": "ConnectX-7 NIC", "category": "nic", "tempC": round(max(mlx_temps), 1)})
    if nvme_temps:
        thermals.append({"label": "NVMe Controller", "category": "nvme", "tempC": round(max(nvme_temps), 1)})
    if wifi_temp is not None:
        thermals.append({"label": "Wi-Fi 7 Radio", "category": "wifi", "tempC": round(wifi_temp, 1)})
    return thermals, fans

def refresh_ips():
    ips = {}
    out = run_cmd(["ip", "-o", "-4", "addr", "show"])
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            iface = parts[1]
            ip = parts[3].split("/")[0]
            if iface not in ips:
                ips[iface] = ip
    return ips

def parse_interfaces(dt):
    global prev_net
    wanted = [
        ("enp1s0f1np1", "fabric-a"),
        ("enP2p1s0f1np1", "fabric-b"),
        ("enP7s7", "lan"),
        ("tailscale0", "tailscale"),
    ]
    res = []
    for name, role in wanted:
        base = f"/sys/class/net/{name}"
        if not os.path.exists(base):
            continue
        oper = read_file(f"{base}/operstate", "unknown")
        spd_raw = read_file(f"{base}/speed", "0")
        spd = int(spd_raw) if spd_raw.isdigit() else 0
        rx = int(read_file(f"{base}/statistics/rx_bytes", "0") or 0)
        tx = int(read_file(f"{base}/statistics/tx_bytes", "0") or 0)
        rxe = int(read_file(f"{base}/statistics/rx_errors", "0") or 0)
        txe = int(read_file(f"{base}/statistics/tx_errors", "0") or 0)
        rx_bps = 0.0
        tx_bps = 0.0
        if name in prev_net and dt > 0:
            prx, ptx = prev_net[name]
            rx_bps = max(0.0, (rx - prx) / dt)
            tx_bps = max(0.0, (tx - ptx) / dt)
        prev_net[name] = (rx, tx)
        res.append({
            "name": name,
            "role": role,
            "ip": cached_ips.get(name, ""),
            "operstate": oper,
            "speedMbps": spd,
            "rxBytes": rx,
            "txBytes": tx,
            "rxBps": round(rx_bps, 1),
            "txBps": round(tx_bps, 1),
            "rxErrors": rxe,
            "txErrors": txe,
        })
    return res

def parse_rdma():
    links = []
    out = run_cmd(["rdma", "link"])
    for line in out.splitlines():
        m = re.search(r"link\s+(\S+)/1\s+state\s+(\S+)\s+physical_state\s+(\S+)\s+netdev\s+(\S+)", line)
        if m:
            hca, state, pstate, netdev = m.groups()
            cbase = f"/sys/class/infiniband/{hca}/ports/1/counters"
            xmit = int(read_file(f"{cbase}/port_xmit_data", "0") or 0) * 4
            rcv = int(read_file(f"{cbase}/port_rcv_data", "0") or 0) * 4
            errs = (
                int(read_file(f"{cbase}/port_rcv_errors", "0") or 0)
                + int(read_file(f"{cbase}/symbol_error", "0") or 0)
                + int(read_file(f"{cbase}/link_downed", "0") or 0)
            )
            links.append({
                "hca": hca,
                "netdev": netdev,
                "state": state,
                "physicalState": pstate,
                "portXmitData": xmit,
                "portRcvData": rcv,
                "errors": errs,
            })
    return links

def parse_disk(dt):
    global prev_disk
    st = os.statvfs("/")
    total = st.f_blocks * st.f_frsize
    avail = st.f_bavail * st.f_frsize
    used = total - (st.f_bfree * st.f_frsize)
    used_pct = round((used / total) * 100.0, 2) if total > 0 else 0.0
    read_bps = 0.0
    write_bps = 0.0
    try:
        with open("/proc/diskstats", "r") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 14 and parts[2] == "nvme0n1":
                    r_sec = int(parts[5])
                    w_sec = int(parts[9])
                    if prev_disk is not None and dt > 0:
                        read_bps = max(0.0, ((r_sec - prev_disk[0]) * 512.0) / dt)
                        write_bps = max(0.0, ((w_sec - prev_disk[1]) * 512.0) / dt)
                    prev_disk = (r_sec, w_sec)
                    break
    except Exception:
        pass
    return {
        "mount": "/",
        "device": "/dev/nvme0n1p2",
        "totalBytes": total,
        "usedBytes": used,
        "availBytes": avail,
        "usedPct": used_pct,
        "readBps": round(read_bps, 1),
        "writeBps": round(write_bps, 1),
    }

def parse_containers():
    out = run_cmd(["docker", "ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.RunningFor}}"])
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 6:
            rows.append({
                "id": parts[0],
                "name": parts[1],
                "image": parts[2],
                "state": parts[3],
                "status": parts[4],
                "ports": parts[5] if len(parts) > 5 else "",
                "created": parts[6] if len(parts) > 6 else "",
            })
    # running first, then newest
    rows.sort(key=lambda r: (0 if r["state"] == "running" else 1, r["name"]))
    return rows[:24]

def parse_top():
    out = run_cmd(["ps", "-eo", "pid,pcpu,pmem,rss,comm,args", "--sort=-rss", "--no-headers"])
    rows = []
    for line in out.splitlines()[:10]:
        parts = line.strip().split(None, 5)
        if len(parts) >= 5 and parts[0].isdigit():
            rows.append({
                "pid": int(parts[0]),
                "cpuPct": float(parts[1]),
                "memPct": float(parts[2]),
                "rssBytes": int(parts[3]) * 1024,
                "comm": parts[4],
                "args": (parts[5] if len(parts) > 5 else parts[4])[:160],
            })
    return rows

def parse_ports():
    out = run_cmd(["ss", "-tlnpH"])
    seen = set()
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        local = parts[3]
        if ":" not in local:
            continue
        addr, port_s = local.rsplit(":", 1)
        if not port_s.isdigit():
            continue
        port = int(port_s)
        key = (addr, port)
        if key in seen:
            continue
        seen.add(key)
        proc = ""
        pid = None
        rest = " ".join(parts[5:]) if len(parts) > 5 else ""
        m = re.search(r'\(\("([^"]+)",pid=(\d+)', rest)
        if m:
            proc = m.group(1)
            pid = int(m.group(2))
        rows.append({"addr": addr, "port": port, "process": proc or "system", "pid": pid})
    rows.sort(key=lambda r: (0 if r["port"] in (18080, 8000, 8080, 11000, 11434, 28028, 29775, 22) else 1, r["port"]))
    return rows[:24]

def parse_tlimit():
    out = run_cmd(["nvidia-smi", "-q", "-d", "TEMPERATURE"])
    m = re.search(r"GPU T\.Limit Temp\s*:\s*(\d+)", out)
    return int(m.group(1)) if m else None

while True:
    now = time.time()
    dt = (now - prev_ts) if prev_ts is not None else 0.0
    prev_ts = now

    if tick % 15 == 0:
        cached_ips = refresh_ips()
        cached_tlimit = parse_tlimit()
    if tick % 4 == 0:
        cached_containers = parse_containers()
        cached_ports = parse_ports()
        cached_top = parse_top()
        cached_rdma = parse_rdma()

    cur_cpu = parse_proc_stat()
    cpu_pct = 0.0
    iowait_pct = 0.0
    per_core = []
    if prev_cpu:
        if "cpu" in cur_cpu and "cpu" in prev_cpu:
            t1, i1, w1 = cur_cpu["cpu"]
            t0, i0, w0 = prev_cpu["cpu"]
            dt_t = max(1, t1 - t0)
            cpu_pct = round(100.0 * (1.0 - (i1 - i0) / dt_t), 1)
            iowait_pct = round(100.0 * ((w1 - w0) / dt_t), 1)
        for idx in range(64):
            k = f"cpu{idx}"
            if k not in cur_cpu:
                break
            t1, i1, _ = cur_cpu[k]
            t0, i0, _ = prev_cpu.get(k, (t1, i1, 0))
            dt_t = max(1, t1 - t0)
            per_core.append(round(100.0 * (1.0 - (i1 - i0) / dt_t), 1))
    else:
        for idx in range(64):
            if f"cpu{idx}" not in cur_cpu:
                break
            per_core.append(0.0)
    prev_cpu = cur_cpu

    freqs = []
    for idx in range(len(per_core)):
        fraw = read_file(f"/sys/devices/system/cpu/cpu{idx}/cpufreq/scaling_cur_freq")
        freqs.append(round(int(fraw) / 1000.0) if fraw.isdigit() else 0)

    uptime_s = 0.0
    try:
        uptime_s = float(read_file("/proc/uptime", "0").split()[0])
    except Exception:
        pass
    load = [0.0, 0.0, 0.0]
    try:
        lp = read_file("/proc/loadavg", "0 0 0").split()
        load = [float(lp[0]), float(lp[1]), float(lp[2])]
    except Exception:
        pass

    mem = parse_meminfo()
    gpu, gpu_alloc = parse_gpu()
    mem["gpuAllocatedBytes"] = gpu_alloc
    thermals, fans = parse_hwmon()
    thermals.insert(0, {"label": "GB10 GPU Die", "category": "gpu", "tempC": round(gpu["tempC"], 1)})
    ifaces = parse_interfaces(dt)
    disk = parse_disk(dt)

    payload = {
        "ts": int(now * 1000),
        "hostname": hostname,
        "kernel": kernel,
        "uptimeSec": int(uptime_s),
        "loadAvg": load,
        "cpu": {
            "cores": len(per_core),
            "usagePct": cpu_pct,
            "perCorePct": per_core,
            "freqMhz": freqs,
            "iowaitPct": iowait_pct,
        },
        "memory": mem,
        "gpu": gpu,
        "thermals": thermals,
        "fansRpm": fans,
        "disk": disk,
        "interfaces": ifaces,
        "rdmaLinks": cached_rdma,
        "containers": cached_containers,
        "topProcesses": cached_top,
        "ports": cached_ports,
    }
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    tick += 1
    elapsed = time.time() - now
    sleep_s = max(0.15, 1.0 - elapsed)
    time.sleep(sleep_s)
`;
