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

    const peak = Math.max(...values, max ?? 1);
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
    ctx.fillText(`PK ${peak.toFixed(peak >= 100 ? 0 : 1)}${unit}`, 4, 11);
  }, [values, max, min, color, height, fillAlpha, unit]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: `${height}px`, display: "block" }}
    />
  );
}

interface DualChartProps {
  seriesA: number[];
  seriesB: number[];
  labelA: string;
  labelB: string;
  colorA: string;
  colorB: string;
  max?: number;
  unit?: string;
  height?: number;
}

export function DualTelemetryChart({
  seriesA,
  seriesB,
  labelA,
  labelB,
  colorA,
  colorB,
  max,
  unit = "",
  height = 148,
}: DualChartProps) {
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

    const padLeft = 64;
    const padRight = 10;
    const padTop = 14;
    const padBottom = 18;
    const plotW = Math.max(40, width - padLeft - padRight);
    const plotH = Math.max(40, height - padTop - padBottom);

    const all = [...seriesA, ...seriesB];
    const peak = Math.max(max ?? 10, ...all, 1);

    // Horizontal grid + axis labels
    ctx.font = '10px "IBM Plex Mono", monospace';
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

    const drawSeries = (vals: number[], color: string) => {
      if (vals.length < 2) return;
      const stepX = plotW / Math.max(1, vals.length - 1);
      ctx.beginPath();
      vals.forEach((v, idx) => {
        const x = padLeft + idx * stepX;
        const y = padTop + (1 - Math.min(peak, Math.max(0, v)) / peak) * plotH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    };

    drawSeries(seriesA, colorA);
    drawSeries(seriesB, colorB);

    // Time axis hints
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(93,104,120,0.9)";
    const windowSec = Math.max(seriesA.length, seriesB.length);
    ctx.fillText(`-${windowSec}s`, padLeft, height - 4);
    ctx.textAlign = "right";
    ctx.fillText("LIVE 1Hz", width - padRight, height - 4);

    // Inline legend
    ctx.textAlign = "left";
    ctx.fillStyle = colorA;
    ctx.fillRect(padLeft + 4, 3, 8, 3);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(labelA, padLeft + 16, 8);

    const offsetB = padLeft + 16 + ctx.measureText(labelA).width + 16;
    ctx.fillStyle = colorB;
    ctx.fillRect(offsetB, 3, 8, 3);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(labelB, offsetB + 12, 8);
  }, [seriesA, seriesB, labelA, labelB, colorA, colorB, max, unit, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: `${height}px`, display: "block" }}
    />
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
