import { useEffect, useRef } from "react";

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

interface ChartSeries {
  id: string;
  label: string;
  color: string;
  connected: boolean;
  values: number[];
}

interface ChartProps {
  series: ChartSeries[];
  max?: number;
  unit?: string;
  height?: number;
}

export function TelemetryChart({
  series,
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

    let peak = Math.max(1, max ?? 0);
    let sampleCount = 0;
    for (const { values } of series) {
      sampleCount = Math.max(sampleCount, values.length);
      for (const value of values) peak = Math.max(peak, value);
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

    // Right-align the latest sample. Short histories must not stretch across the entire window.
    const stepX = plotW / Math.max(1, sampleCount - 1);
    for (const { values, color } of series) {
      if (!values.length) continue;
      ctx.beginPath();
      values.forEach((v, idx) => {
        const x = padLeft + plotW - (values.length - idx - 1) * stepX;
        const y = padTop + (1 - Math.min(peak, Math.max(0, v)) / peak) * plotH;
        if (values.length === 1) ctx.arc(x, y, 2, 0, Math.PI * 2);
        else if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (values.length === 1) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }

    // Time axis hints
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(93,104,120,0.9)";
    ctx.fillText(sampleCount ? `${sampleCount} SAMPLES` : "NO SAMPLES", padLeft, height - 4);
    ctx.textAlign = "right";
    ctx.fillText("LATEST SAMPLE", width - padRight, height - 4);
  }, [series, max, unit, height]);

  return (
    <>
      <div className="legend-row chart-legend">
        {series.map(({ id, label, color, values, connected }) => (
          <span key={id}>
            <i className="legend-dot" style={{ background: color }} />
            {label} ({id}) · {values.length ? `${values[values.length - 1].toFixed(1)}${unit}` : "No data"}
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
