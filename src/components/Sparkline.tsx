import { useEffect, useRef } from "react";
import type { HistoryPoint } from "../../shared/types";

interface SparklineProps {
  values: number[];
  max?: number;
  min?: number;
  color: string;
  height?: number;
  fillAlpha?: number;
  unit?: string;
}

export function Sparkline({
  values,
  max,
  min = 0,
  color,
  height = 54,
  fillAlpha = 0.2,
  unit = "",
}: SparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 240;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Subtle oscilloscope gridlines
    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = Math.round((height / 4) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (values.length < 2) {
      ctx.fillStyle = "rgba(152,164,181,0.45)";
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.fillText("SAMPLING...", 6, height - 8);
      return;
    }

    const samplePeak = Math.max(...values);
    const peak = Math.max(samplePeak, max ?? 1);
    const floor = min;
    const span = Math.max(0.001, peak - floor);
    const padTop = 6;
    const padBottom = 4;
    const usableH = height - padTop - padBottom;

    const stepX = width / Math.max(1, values.length - 1);

    const points = values.map((v, i) => {
      const clamped = Math.max(floor, Math.min(peak, v));
      const norm = (clamped - floor) / span;
      return {
        x: i * stepX,
        y: padTop + (1 - norm) * usableH,
      };
    });

    // Area gradient
    const grad = ctx.createLinearGradient(0, padTop, 0, height);
    grad.addColorStop(0, hexToRgba(color, fillAlpha));
    grad.addColorStop(1, hexToRgba(color, 0.01));

    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    for (const pt of points) ctx.lineTo(pt.x, pt.y);
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Signal trace
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.65;
    ctx.stroke();

    // Active head dot
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x - 1.5, last.y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Peak watermark
    ctx.fillStyle = "rgba(152,164,181,0.55)";
    ctx.font = '9.5px "IBM Plex Mono", monospace';
    ctx.fillText(`PK ${samplePeak.toFixed(samplePeak >= 100 ? 0 : 1)}${unit}`, 4, 11);
  }, [values, max, min, color, height, fillAlpha, unit]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: `${height}px`, display: "block" }}
    />
  );
}

/** Longest span the shared time axis covers: the five minutes of history kept per node. */
const WINDOW_MS = 300_000;
/** Samples arrive once a second; a longer silence is an outage and is drawn as a gap. */
const GAP_MS = 3_000;

interface ChartSeries {
  id: string;
  label: string;
  color: string;
  connected: boolean;
  points: HistoryPoint[];
}

interface ChartProps {
  series: ChartSeries[];
  value: (point: HistoryPoint) => number;
  max?: number;
  unit?: string;
  height?: number;
}

export function TelemetryChart({
  series,
  value,
  max,
  unit = "",
  height = 148,
}: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 500;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // One time axis for every series: it ends at the newest sample any node has and reaches back
    // to the oldest, capped at the window. Older samples of a node that fell behind are clipped.
    let end = Number.NEGATIVE_INFINITY;
    let oldest = Number.POSITIVE_INFINITY;
    for (const { points } of series) {
      if (!points.length) continue;
      oldest = Math.min(oldest, points[0].ts);
      end = Math.max(end, points[points.length - 1].ts);
    }
    const start = Math.max(oldest, end - WINDOW_MS);
    const spanMs = end - start;

    let peak = Math.max(1, max ?? 0);
    for (const { points } of series) {
      for (const point of points) if (point.ts >= start) peak = Math.max(peak, value(point));
    }
    ctx.font = '10px "IBM Plex Mono", monospace';
    const padLeft = Math.ceil(ctx.measureText(`${peak.toFixed(1)}${unit}`).width) + 10;
    const padRight = 10;
    const padTop = 14;
    const padBottom = 18;
    const plotW = Math.max(40, width - padLeft - padRight);
    const plotH = Math.max(40, height - padTop - padBottom);

    // Horizontal grid + axis labels
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(padTop + (plotH / 4) * i) + 0.5;
      ctx.strokeStyle = i === 4 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const val = peak * (1 - i / 4);
      ctx.fillStyle = "rgba(152,164,181,0.6)";
      ctx.textAlign = "right";
      ctx.fillText(
        `${val >= 100 ? val.toFixed(0) : val.toFixed(1)}${unit}`,
        padLeft - 6,
        y + 3
      );
    }

    for (const { points, color } of series) {
      const line = new Path2D();
      const dots = new Path2D();
      let prevTs = Number.NEGATIVE_INFINITY;
      let run = 0;
      let x = 0;
      let y = 0;
      // A sample with no neighbour inside GAP_MS has no line to carry it, so it gets a dot.
      const endRun = () => {
        if (run !== 1) return;
        dots.moveTo(x + 2, y);
        dots.arc(x, y, 2, 0, Math.PI * 2);
      };
      for (const point of points) {
        if (point.ts < start) continue;
        const gap = point.ts - prevTs > GAP_MS;
        if (gap) endRun();
        x = padLeft + (spanMs > 0 ? (point.ts - start) / spanMs : 1) * plotW;
        y = padTop + (1 - Math.min(peak, Math.max(0, value(point))) / peak) * plotH;
        if (gap) line.moveTo(x, y);
        else line.lineTo(x, y);
        run = gap ? 1 : run + 1;
        prevTs = point.ts;
      }
      endRun();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke(line);
      ctx.fillStyle = color;
      ctx.fill(dots);
    }

    // Time axis: the span on the left, the newest sample on the right.
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(93,104,120,0.9)";
    ctx.fillText(Number.isFinite(spanMs) ? `−${Math.round(spanMs / 1000)} s` : "NO SAMPLES", padLeft, height - 4);
    ctx.textAlign = "right";
    ctx.fillText("NOW", width - padRight, height - 4);
  }, [series, value, max, unit, height]);

  return (
    <>
      <div className="legend-row chart-legend">
        {series.map(({ id, label, color, points, connected }) => (
          <span key={id}>
            <i className="legend-dot" style={{ background: color }} />
            {label} ({id}) · {points.length ? `${value(points[points.length - 1]).toFixed(1)}${unit}` : "No data"}
            {!connected && " · Offline"}
          </span>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Telemetry history in ${unit.trim()}; latest values are listed in the legend.`}
        style={{ width: "100%", height: `${height}px`, display: "block" }}
      />
    </>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return `rgba(118,185,0,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
