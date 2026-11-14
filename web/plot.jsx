/**
 * Floodline - High-Performance Real-Time Canvas Telemetry Plot
 * Industrial SCADA Historian & Oscilloscope Canvas Panel
 * Renders hydraulic & mechanical channels with threshold alarm lines,
 * anomaly region shading, and precision crosshair scrubbing.
 */

import React, { useRef, useEffect, useState } from 'react';
import { Play, SkipBack, SkipForward, Activity, Clock } from 'lucide-react';

const METRIC_CONFIG = {
  waterLevel: {
    label: 'Water Level',
    unit: 'm',
    color: '#38bdf8', // Industrial Sky Blue
    min: 0,
    max: 5.0,
    warning: 3.0,
    critical: 3.8
  },
  outflow: {
    label: 'Discharge Outflow',
    unit: 'L/s',
    color: '#10b981', // Industrial Emerald
    min: 0,
    max: 1800,
    warning: 200,
    critical: 100
  },
  vibration: {
    label: 'Pump Vibration (RMS)',
    unit: 'mm/s',
    color: '#f59e0b', // Safety Amber
    min: 0,
    max: 12.0,
    warning: 4.5,
    critical: 7.1
  },
  current: {
    label: 'Motor Current',
    unit: 'A',
    color: '#c084fc', // Telemetry Violet
    min: 0,
    max: 130,
    warning: 85,
    critical: 105
  }
};

export function TelemetryPlot({
  points = [],
  station = null,
  activeMetric = 'all',
  onMetricChange = () => {},
  windowPreset = '5m',
  onWindowPresetChange = () => {},
  isHistoricalLocked = false,
  historicalRange = null,
  onReturnToLive = () => {},
  onShiftWindow = () => {}
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [hoveredData, setHoveredData] = useState(null);
  const [size, setSize] = useState(null);

  useEffect(() => {
    setHoveredData(null);
  }, [station, historicalRange?.from, historicalRange?.to]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size?.width || !size.height) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI displays
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = size.width;
    const h = size.height;

    // Technical Oscilloscope Background
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, w, h);

    if (!points || points.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('AWAITING TELEMETRY STREAM…', w / 2, h / 2);
      return;
    }

    const padding = { top: 32, right: 24, bottom: 32, left: 54 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    const minTime = historicalRange?.from ?? points[0].timestamp;
    const maxTime = historicalRange?.to ?? Math.max(points[points.length - 1].timestamp, minTime + 1000);

    // Grid lines (Crisp 1px industrial grid)
    ctx.strokeStyle = '#172033';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);

    const numGridY = 4;
    for (let i = 0; i <= numGridY; i++) {
      const y = Math.round(padding.top + (plotH / numGridY) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    const numGridX = w < 520 ? 3 : 6;
    for (let i = 0; i <= numGridX; i++) {
      const x = Math.round(padding.left + (plotW / numGridX) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, h - padding.bottom);
      ctx.stroke();

      const timeAtX = minTime + (maxTime - minTime) * (i / numGridX);
      const dateStr = new Date(timeAtX).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(dateStr, x, h - padding.bottom + 18);
    }
    ctx.setLineDash([]);

    // Highlight Warning / Critical Anomaly Regions
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.severity === 'warning' || p.severity === 'critical') {
        const x1 = padding.left + ((p.timestamp - minTime) / (maxTime - minTime)) * plotW;
        const next = points[i + 1]?.timestamp ?? p.timestamp;
        const x2 = padding.left + ((next - minTime) / (maxTime - minTime)) * plotW;
        ctx.fillStyle = p.severity === 'critical' ? 'rgba(239, 68, 68, 0.16)' : 'rgba(245, 158, 11, 0.10)';
        ctx.fillRect(x1, padding.top, Math.max(2, x2 - x1), plotH);
      }
    }

    const metricsToDraw = activeMetric === 'all'
      ? ['waterLevel', 'outflow', 'vibration', 'current']
      : [activeMetric];

    // Draw Metric Lines
    metricsToDraw.forEach(metricKey => {
      const cfg = METRIC_CONFIG[metricKey];
      const toY = value => padding.top + plotH * (1 - Math.max(0, Math.min(1, (value - cfg.min) / (cfg.max - cfg.min))));
      const stationWarn = station ? (station[`nominal${metricKey.charAt(0).toUpperCase() + metricKey.slice(1)}`]?.warning || cfg.warning) : cfg.warning;
      const stationCrit = station ? (station[`nominal${metricKey.charAt(0).toUpperCase() + metricKey.slice(1)}`]?.critical || cfg.critical) : cfg.critical;

      // Draw Threshold Lines if single metric selected
      if (activeMetric !== 'all') {
        if (stationWarn != null) {
          const yWarn = padding.top + plotH - ((stationWarn - cfg.min) / (cfg.max - cfg.min)) * plotH;
          if (yWarn >= padding.top && yWarn <= padding.top + plotH) {
            ctx.strokeStyle = '#f59e0b';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(padding.left, yWarn);
            ctx.lineTo(w - padding.right, yWarn);
            ctx.stroke();
            ctx.fillStyle = '#f59e0b';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`WARN ${stationWarn} ${cfg.unit}`, w - padding.right - 6, yWarn - 4);
          }
        }

        if (stationCrit != null) {
          const yCrit = padding.top + plotH - ((stationCrit - cfg.min) / (cfg.max - cfg.min)) * plotH;
          if (yCrit >= padding.top && yCrit <= padding.top + plotH) {
            ctx.strokeStyle = '#ef4444';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(padding.left, yCrit);
            ctx.lineTo(w - padding.right, yCrit);
            ctx.stroke();
            ctx.fillStyle = '#ef4444';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`CRIT ${stationCrit} ${cfg.unit}`, w - padding.right - 6, yCrit - 4);
          }
        }
        ctx.setLineDash([]);
      }

      // Min/Max envelope band for aggregate windows
      if (activeMetric === metricKey) {
        ctx.strokeStyle = cfg.color;
        ctx.globalAlpha = 0.20;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const point of points) {
          if (!point.min || !point.max) continue;
          const x = padding.left + ((point.timestamp - minTime) / (maxTime - minTime)) * plotW;
          ctx.moveTo(x, toY(point.min[metricKey]));
          ctx.lineTo(x, toY(point.max[metricKey]));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Primary trace line
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = activeMetric === metricKey ? 2 : 1.5;
      ctx.beginPath();

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const val = p.metrics ? p.metrics[metricKey] : 0;
        const x = padding.left + ((p.timestamp - minTime) / (maxTime - minTime)) * plotW;
        const y = toY(val);

        if (i === 0) ctx.moveTo(x, y);
        else if (p.timestamp - points[i - 1].timestamp > (maxTime - minTime) / 15) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Axis ticks on left
      if (activeMetric === metricKey) {
        ctx.fillStyle = cfg.color;
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        for (let i = 0; i <= 4; i++) {
          const stepVal = cfg.min + (cfg.max - cfg.min) * (i / 4);
          const y = padding.top + plotH - (i / 4) * plotH;
          ctx.fillText(`${stepVal.toFixed(1)}${cfg.unit}`, padding.left - 8, y + 4);
        }
      }
    });

    // Crosshair scrubber
    if (hoveredData && hoveredData.point) {
      const hx = padding.left + ((hoveredData.point.timestamp - minTime) / (maxTime - minTime)) * plotW;
      ctx.strokeStyle = '#94a3b8';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, padding.top);
      ctx.lineTo(hx, h - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [points, activeMetric, station, hoveredData, size, historicalRange]);

  const handleMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas || !points || points.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const paddingLeft = 54;
    const paddingRight = 24;
    const plotW = rect.width - paddingLeft - paddingRight;

    if (mouseX < paddingLeft || mouseX > rect.width - paddingRight) {
      setHoveredData(null);
      return;
    }

    const minTime = historicalRange?.from ?? points[0].timestamp;
    const maxTime = historicalRange?.to ?? Math.max(points[points.length - 1].timestamp, minTime + 1000);
    const timeRatio = (mouseX - paddingLeft) / plotW;
    const targetTime = minTime + timeRatio * (maxTime - minTime);

    let closest = points[0];
    let minDiff = Math.abs(closest.timestamp - targetTime);

    for (let i = 1; i < points.length; i++) {
      const diff = Math.abs(points[i].timestamp - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = points[i];
      }
    }

    setHoveredData({ point: closest, x: mouseX });
  };

  const handleMouseLeave = () => {
    setHoveredData(null);
  };

  return (
    <div className="flex flex-col bg-[#0b101b] border border-[#1e293b] rounded shadow-md overflow-hidden" ref={containerRef}>
      {/* Chart Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-3.5 py-2 bg-[#0e1422] border-b border-[#1e293b] gap-2">
        {/* Metric Selector Tabs */}
        <div className="flex items-center gap-1 bg-[#070b12] p-0.5 rounded border border-[#1e293b]">
          <button
            onClick={() => onMetricChange('all')}
            className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition ${
              activeMetric === 'all'
                ? 'bg-[#1e293b] text-white border border-slate-600'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#131b2e]'
            }`}
          >
            All Channels
          </button>
          {Object.entries(METRIC_CONFIG).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => onMetricChange(key)}
              style={{ color: activeMetric === key ? '#ffffff' : cfg.color }}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition ${
                activeMetric === key ? 'bg-[#1e293b] border border-slate-600 shadow-sm' : 'hover:bg-[#131b2e]'
              }`}
            >
              {cfg.label.split(' ')[0]}
            </button>
          ))}
        </div>

        {/* Time Window & Historical Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {isHistoricalLocked && (
            <div className="flex items-center gap-1.5 bg-amber-950/80 text-amber-300 border border-amber-700/80 px-2 py-0.5 rounded text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              <span className="font-mono font-bold tracking-tight">HISTORICAL REPLAY</span>
              <button
                onClick={() => onShiftWindow(-60000)}
                title="Step earlier by 1m"
                className="p-1 hover:bg-amber-800/60 rounded"
              >
                <SkipBack className="w-3 h-3" />
              </button>
              <button
                onClick={() => onShiftWindow(60000)}
                title="Step later by 1m"
                className="p-1 hover:bg-amber-800/60 rounded"
              >
                <SkipForward className="w-3 h-3" />
              </button>
              <button
                onClick={() => onReturnToLive()}
                className="ml-1 bg-amber-600 hover:bg-amber-500 text-slate-950 px-2 py-0.5 rounded text-xs font-mono font-bold transition"
              >
                Return to Live
              </button>
            </div>
          )}

          {/* Time Window Buttons */}
          <div className="flex items-center gap-0.5 bg-[#070b12] p-0.5 rounded border border-[#1e293b]">
            {['1m', '5m', '15m', '1h'].map(preset => (
              <button
                key={preset}
                onClick={() => onWindowPresetChange(preset)}
                className={`px-2 py-0.5 text-xs font-mono font-medium rounded transition ${
                  windowPreset === preset && !isHistoricalLocked
                    ? 'bg-[#0284c7] text-white font-bold'
                    : 'text-slate-400 hover:text-white hover:bg-[#131b2e]'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Canvas Area */}
      <div className="relative w-full h-72 sm:h-80 md:h-96">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="w-full h-full cursor-crosshair block"
        />

        {/* Hover Readout Tooltip */}
        {hoveredData && hoveredData.point && (
          <div
            className="absolute top-2.5 pointer-events-none bg-[#090d16]/95 border border-[#334155] p-2.5 rounded shadow-xl backdrop-blur-sm text-xs z-20 font-mono"
            style={{
              left: Math.min(Math.max(hoveredData.x - 100, 15), canvasRef.current?.clientWidth - 220 || 300)
            }}
          >
            <div className="text-slate-400 text-[10px] mb-1 pb-1 border-b border-[#1e293b] flex justify-between gap-4">
              <span>{new Date(hoveredData.point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}</span>
              <span className="text-slate-500">SEQ #{hoveredData.point.seq}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
              <div className="text-[#38bdf8]">
                Level: <span className="font-bold">{hoveredData.point.metrics?.waterLevel?.toFixed(2)} m</span>
              </div>
              <div className="text-[#10b981]">
                Flow: <span className="font-bold">{hoveredData.point.metrics?.outflow?.toFixed(0)} L/s</span>
              </div>
              <div className="text-[#f59e0b]">
                Vib: <span className="font-bold">{hoveredData.point.metrics?.vibration?.toFixed(2)} mm/s</span>
              </div>
              <div className="text-[#c084fc]">
                Current: <span className="font-bold">{hoveredData.point.metrics?.current?.toFixed(1)} A</span>
              </div>
            </div>
            {hoveredData.point.anomalyReason && hoveredData.point.anomalyReason !== 'Nominal operating conditions' && (
              <div className="mt-1 pt-1 border-t border-[#1e293b] text-[10px] text-amber-300">
                STATUS: {hoveredData.point.anomalyReason}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend / Status Bar */}
      <div className="flex flex-wrap items-center justify-between px-3.5 py-1.5 bg-[#0e1422] border-t border-[#1e293b] text-[11px] text-slate-400 font-mono">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-[#38bdf8]"></span>
            Water Level (m)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-[#10b981]"></span>
            Outflow (L/s)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-[#f59e0b]"></span>
            Vibration (mm/s)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-[#c084fc]"></span>
            Current (A)
          </span>
        </div>
        <div className="text-slate-500 tabular-nums">
          {points.reduce((count, point) => count + (point.count ?? 1), 0).toLocaleString()} readings · {points.length} points
        </div>
      </div>
    </div>
  );
}
