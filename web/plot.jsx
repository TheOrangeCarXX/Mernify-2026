/**
 * Floodline - High-Performance Real-Time Canvas Telemetry Plot
 * Renders multiple hydraulic and mechanical telemetry channels with warning/critical threshold lines,
 * incident anomaly highlights, and interactive crosshair scrubbing.
 */

import React, { useRef, useEffect, useState } from 'react';
import { Play, SkipBack, SkipForward, Maximize2, Activity } from 'lucide-react';

const METRIC_CONFIG = {
  waterLevel: {
    label: 'Water Level',
    unit: 'm',
    color: '#00e5ff',
    bg: 'rgba(0, 229, 255, 0.1)',
    min: 0,
    max: 5.0,
    warning: 3.0,
    critical: 3.8
  },
  outflow: {
    label: 'Discharge Outflow',
    unit: 'L/s',
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.1)',
    min: 0,
    max: 1800,
    warning: 200,
    critical: 100
  },
  vibration: {
    label: 'Pump Vibration (RMS)',
    unit: 'mm/s',
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.1)',
    min: 0,
    max: 12.0,
    warning: 4.5,
    critical: 7.1
  },
  current: {
    label: 'Motor Current',
    unit: 'A',
    color: '#a855f7',
    bg: 'rgba(168, 85, 247, 0.1)',
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
  onReturnToLive = () => {},
  onShiftWindow = () => {}
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [hoveredData, setHoveredData] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI displays
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // Background
    ctx.fillStyle = '#0a0f18';
    ctx.fillRect(0, 0, w, h);

    if (!points || points.length === 0) {
      ctx.fillStyle = '#475569';
      ctx.font = '14px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('WAITING FOR TELEMETRY STREAM OR HISTORICAL DATA...', w / 2, h / 2);
      return;
    }

    const padding = { top: 35, right: 25, bottom: 35, left: 55 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    const minTime = points[0].timestamp;
    const maxTime = Math.max(points[points.length - 1].timestamp, minTime + 1000);

    // Draw Grid Lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    const numGridY = 5;
    for (let i = 0; i <= numGridY; i++) {
      const y = padding.top + (plotH / numGridY) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    const numGridX = 6;
    for (let i = 0; i <= numGridX; i++) {
      const x = padding.left + (plotW / numGridX) * i;
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
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      if (p.severity === 'warning' || p.severity === 'critical') {
        const x1 = padding.left + ((p.timestamp - minTime) / (maxTime - minTime)) * plotW;
        const x2 = padding.left + ((points[i + 1].timestamp - minTime) / (maxTime - minTime)) * plotW;
        ctx.fillStyle = p.severity === 'critical' ? 'rgba(239, 68, 68, 0.18)' : 'rgba(245, 158, 11, 0.12)';
        ctx.fillRect(x1, padding.top, Math.max(2, x2 - x1), plotH);
      }
    }

    const metricsToDraw = activeMetric === 'all'
      ? ['waterLevel', 'outflow', 'vibration', 'current']
      : [activeMetric];

    // Draw Metric Lines
    metricsToDraw.forEach(metricKey => {
      const cfg = METRIC_CONFIG[metricKey];
      const stationWarn = station ? (station[`nominal${metricKey.charAt(0).toUpperCase() + metricKey.slice(1)}`]?.warning || cfg.warning) : cfg.warning;
      const stationCrit = station ? (station[`nominal${metricKey.charAt(0).toUpperCase() + metricKey.slice(1)}`]?.critical || cfg.critical) : cfg.critical;

      // Draw Threshold Lines if single metric selected
      if (activeMetric !== 'all') {
        // Warning threshold line
        if (stationWarn != null) {
          const yWarn = padding.top + plotH - ((stationWarn - cfg.min) / (cfg.max - cfg.min)) * plotH;
          if (yWarn >= padding.top && yWarn <= padding.top + plotH) {
            ctx.strokeStyle = '#f59e0b';
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(padding.left, yWarn);
            ctx.lineTo(w - padding.right, yWarn);
            ctx.stroke();
            ctx.fillStyle = '#f59e0b';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`WARN ${stationWarn} ${cfg.unit}`, w - padding.right - 5, yWarn - 4);
          }
        }

        // Critical threshold line
        if (stationCrit != null) {
          const yCrit = padding.top + plotH - ((stationCrit - cfg.min) / (cfg.max - cfg.min)) * plotH;
          if (yCrit >= padding.top && yCrit <= padding.top + plotH) {
            ctx.strokeStyle = '#ef4444';
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(padding.left, yCrit);
            ctx.lineTo(w - padding.right, yCrit);
            ctx.stroke();
            ctx.fillStyle = '#ef4444';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`CRIT ${stationCrit} ${cfg.unit}`, w - padding.right - 5, yCrit - 4);
          }
        }
        ctx.setLineDash([]);
      }

      // Plot curve
      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = activeMetric === metricKey ? 2.5 : 1.5;
      ctx.beginPath();

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const val = p.metrics ? p.metrics[metricKey] : 0;
        const normVal = Math.max(0, Math.min(1, (val - cfg.min) / (cfg.max - cfg.min)));

        const x = padding.left + ((p.timestamp - minTime) / (maxTime - minTime)) * plotW;
        const y = padding.top + plotH - normVal * plotH;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Axis labels on left
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

    // Crosshair scrubber if mouse is hovering
    if (hoveredData && hoveredData.point) {
      const hx = padding.left + ((hoveredData.point.timestamp - minTime) / (maxTime - minTime)) * plotW;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, padding.top);
      ctx.lineTo(hx, h - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [points, activeMetric, station, hoveredData]);

  // Handle Mouse Hover Scrubbing
  const handleMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas || !points || points.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const paddingLeft = 55;
    const paddingRight = 25;
    const plotW = rect.width - paddingLeft - paddingRight;

    if (mouseX < paddingLeft || mouseX > rect.width - paddingRight) {
      setHoveredData(null);
      return;
    }

    const minTime = points[0].timestamp;
    const maxTime = Math.max(points[points.length - 1].timestamp, minTime + 1000);
    const timeRatio = (mouseX - paddingLeft) / plotW;
    const targetTime = minTime + timeRatio * (maxTime - minTime);

    // Find closest data point
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
    <div className="flex flex-col bg-slate-900/90 border border-slate-800 rounded-lg overflow-hidden shadow-xl" ref={containerRef}>
      {/* Chart Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2.5 bg-slate-950/70 border-b border-slate-800 gap-2">
        {/* Metric Selector Tabs */}
        <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-md border border-slate-800">
          <button
            onClick={() => onMetricChange('all')}
            className={`px-2.5 py-1 text-xs font-semibold rounded transition ${
              activeMetric === 'all'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }`}
          >
            All Channels
          </button>
          {Object.entries(METRIC_CONFIG).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => onMetricChange(key)}
              style={{ color: activeMetric === key ? '#fff' : cfg.color }}
              className={`px-2.5 py-1 text-xs font-semibold rounded transition ${
                activeMetric === key ? 'bg-slate-800 shadow border border-slate-700' : 'hover:bg-slate-800/60'
              }`}
            >
              {cfg.label.split(' ')[0]}
            </button>
          ))}
        </div>

        {/* Time Window & Historical Controls */}
        <div className="flex items-center gap-2">
          {isHistoricalLocked && (
            <div className="flex items-center gap-1.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded text-xs">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
              <span className="font-mono font-medium">HISTORICAL REPLAY</span>
              <button
                onClick={() => onShiftWindow(-60000)}
                title="Step earlier by 1m"
                className="p-1 hover:bg-amber-500/30 rounded"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onShiftWindow(60000)}
                title="Step later by 1m"
                className="p-1 hover:bg-amber-500/30 rounded"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onReturnToLive}
                className="ml-1 bg-amber-600 hover:bg-amber-500 text-white px-2 py-0.5 rounded text-xs font-semibold transition"
              >
                Return to Live
              </button>
            </div>
          )}

          {/* Time Window Buttons */}
          <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-md border border-slate-800">
            {['1m', '5m', '15m', '1h'].map(preset => (
              <button
                key={preset}
                onClick={() => onWindowPresetChange(preset)}
                className={`px-2 py-0.5 text-xs font-mono font-medium rounded transition ${
                  windowPreset === preset && !isHistoricalLocked
                    ? 'bg-cyan-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
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
            className="absolute top-3 pointer-events-none bg-slate-950/95 border border-cyan-500/60 p-2.5 rounded-lg shadow-2xl backdrop-blur text-xs z-20 font-mono"
            style={{
              left: Math.min(Math.max(hoveredData.x - 100, 15), canvasRef.current?.clientWidth - 220 || 300)
            }}
          >
            <div className="text-slate-400 text-[11px] mb-1 pb-1 border-b border-slate-800 flex justify-between gap-4">
              <span>{new Date(hoveredData.point.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}</span>
              <span className="text-slate-500">Seq #{hoveredData.point.seq}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div className="text-cyan-400">
                Level: <span className="font-bold">{hoveredData.point.metrics?.waterLevel?.toFixed(2)} m</span>
              </div>
              <div className="text-emerald-400">
                Flow: <span className="font-bold">{hoveredData.point.metrics?.outflow?.toFixed(0)} L/s</span>
              </div>
              <div className="text-amber-400">
                Vib: <span className="font-bold">{hoveredData.point.metrics?.vibration?.toFixed(2)} mm/s</span>
              </div>
              <div className="text-purple-400">
                Current: <span className="font-bold">{hoveredData.point.metrics?.current?.toFixed(1)} A</span>
              </div>
            </div>
            {hoveredData.point.anomalyReason && hoveredData.point.anomalyReason !== 'Nominal operating conditions' && (
              <div className="mt-1.5 pt-1 border-t border-slate-800 text-[11px] text-amber-300 font-sans">
                ⚠ {hoveredData.point.anomalyReason}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend / Status Bar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2 bg-slate-950/90 border-t border-slate-800/80 text-xs text-slate-400 font-mono">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400"></span>
            Water Level (m)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
            Outflow (L/s)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
            Vibration (mm/s)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-400"></span>
            Current (A)
          </span>
        </div>
        <div className="text-slate-500">
          {points.length} samples in active viewport
        </div>
      </div>
    </div>
  );
}
