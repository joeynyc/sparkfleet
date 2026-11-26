import type { FleetStatePayload, ServerMessage } from "../shared/types";

const PORT = Number(process.env.SPARKPIT_PORT || 7799);
const TOKEN = process.env.SPARKPIT_TOKEN;
const WARMUP_MS = Number(process.env.SPARKPIT_BENCH_WARMUP_MS || 10_000);
const MEASURE_MS = Number(process.env.SPARKPIT_BENCH_MS || 60_000);
const READY_TIMEOUT_MS = 45_000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const headers = { Cookie: `sparkpit_${PORT}=${TOKEN}` };

const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> }
) => WebSocket;

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
}

async function waitForFleet(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/state`, { headers });
      if (res.ok) {
        const state = (await res.json()) as FleetStatePayload;
        const nodes = Object.values(state.nodes);
        if (nodes.length === 8 && nodes.every((node) => node.connected)) return;
      }
    } catch {
      // The demo server may still be starting.
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for all eight simulated Sparks");
}

async function main(): Promise<void> {
  if (!TOKEN || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Set SPARKPIT_TOKEN and a valid SPARKPIT_PORT");
  }

  await waitForFleet();
  await Bun.sleep(WARMUP_MS);

  const socket = new HeaderWebSocket(`ws://127.0.0.1:${PORT}/ws/telemetry`, { headers });
  const ages: number[] = [];
  let tickFrames = 0;
  let nonemptyNodeFrames = 0;
  let tickBytes = 0;
  let initFrameBytes = 0;
  let measuring = false;

  const initialized = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket init")), 10_000);
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    };
    socket.onmessage = (event) => {
      const raw = String(event.data);
      const frame = JSON.parse(raw) as ServerMessage;
      if (frame.type === "init") {
        clearTimeout(timeout);
        initFrameBytes = Buffer.byteLength(raw);
        resolve();
        return;
      }
      if (!measuring || frame.type !== "tick") return;
      tickFrames++;
      tickBytes += Buffer.byteLength(raw);
      for (const points of Object.values(frame.payload.points)) {
        if (points.length > 0) nonemptyNodeFrames++;
        for (const point of points) ages.push(Date.now() - point.ts);
      }
    };
  });

  try {
    await initialized;
    measuring = true;
    await Bun.sleep(MEASURE_MS);
  } finally {
    measuring = false;
    socket.close();
  }

  if (ages.length === 0) throw new Error("No telemetry points arrived during the measurement window");
  const sorted = ages.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      workload: {
        nodes: 8,
        fakeIntervalMs: Number(process.env.FAKE_INTERVAL_MS || 1000),
        warmupMs: WARMUP_MS,
        measureMs: MEASURE_MS,
      },
      result: {
        initFrameBytes,
        tickFrames,
        nonemptyNodeFrames,
        tickBytes,
        points: sorted.length,
        pointAgeMs: {
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          p99: percentile(sorted, 0.99),
          max: sorted.at(-1),
        },
      },
    })
  );
}

await main();
