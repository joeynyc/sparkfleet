import { useEffect, useState } from "react";
import { applyTick } from "../shared/fleet-state";
import type { FleetStatePayload, ServerMessage } from "../shared/types";

/** `locked` means the server refused this browser: its access link has not been opened. */
export type LinkStatus = "connecting" | "live" | "reconnecting" | "locked";

const RETRY_MS = 1500;

export function useFleet(): { fleet: FleetStatePayload | null; status: LinkStatus } {
  const [fleet, setFleet] = useState<FleetStatePayload | null>(null);
  const [status, setStatus] = useState<LinkStatus>("connecting");

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retryTimer: number | undefined;
    let alive = true;

    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${window.location.host}/ws/telemetry`);
      ws.onopen = () => setStatus("live");
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        setFleet((prev) => (msg.type === "init" ? msg.payload : prev && applyTick(prev, msg.payload)));
      };
      ws.onclose = async () => {
        if (!alive) return;
        // A refused upgrade is indistinguishable from a dropped socket, so ask the API.
        const session = await fetch("/api/session").catch(() => null);
        if (!alive) return;
        setStatus(session?.status === 401 ? "locked" : "reconnecting");
        retryTimer = window.setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      alive = false;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  return { fleet, status };
}
