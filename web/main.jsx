/**
 * Floodline - Enhanced Industrial SCADA Telemetry Dashboard
 * Real-Time Telemetry Monitoring Console for Stormwater Pump Stations
 * Includes Audio Alarms (Web Audio), Autonomous Guided Demo Tour, Live Throughput Controls,
 * ISO 10816 Vibration Gauges, and Incident CSV Data Export.
 */

import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Radio,
  RefreshCw,
  Server,
  Zap,
  Droplets,
  Gauge,
  Sliders,
  Flame,
  ShieldCheck,
  ShieldAlert,
  ChevronRight,
  Database,
  Layers,
  Clock,
  User,
  Settings,
  HelpCircle,
  X,
  Volume2,
  VolumeX,
  Play,
  Square,
  Download,
  CheckCircle2,
  Cpu
} from 'lucide-react';

import { STATIONS, STATION_MAP } from '../shared/telemetry.mjs';
import { useTelemetryStream } from './live.jsx';
import { TelemetryPlot } from './plot.jsx';
import './styles.css';

const faultLabels = {
  'storm-surge': 'Storm surge',
  'intake-blockage': 'Intake blockage',
  'motor-overload': 'Motor overload'
};

// Web Audio API Synthesizer for SCADA Control Room Alarms
function playScadaAlertChime(isCritical = false) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = isCritical ? 'sawtooth' : 'sine';
    const freq = isCritical ? 920 : 660;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(isCritical ? 460 : 520, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => { void ctx.close().catch(() => {}); };
  } catch (e) {
    // Audio context may be blocked before first user gesture
  }
}

export function FloodlineApp() {
  const stationParam = new URLSearchParams(window.location.search).get('station');
  const {
    selectedStationId,
    selectStation,
    connectionStatus,
    socketId,
    currentUser,
    sessionChecked,
    signIn,
    signOut,
    seriesState,
    historyError,
    fleetSummary,
    incidents,
    metricsSummary,
    setWindowPreset,
    openIncidentReplay,
    returnToLive,
    shiftHistoricalWindow,
    triggerFault,
    clearFault,
    changeSimulatorRate,
    getLatestIncidents,
    testReconnect
  } = useTelemetryStream({ defaultStationId: STATION_MAP.has(stationParam) ? stationParam : 'canal-junction' });

  const [activeMetricTab, setActiveMetricTab] = useState('all');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [faultActionNotice, setFaultActionNotice] = useState(null);
  const noticeTimer = useRef(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [autoDemoStep, setAutoDemoStep] = useState(null); // null = inactive, { step, label }
  const [demoComplete, setDemoComplete] = useState(false);
  const [incidentFilter, setIncidentFilter] = useState('all');
  const [stationFilter, setStationFilter] = useState('all');
  const selectedSimRate = fleetSummary.metrics?.simulatorRate ?? 288;

  const currentStation = STATION_MAP.get(selectedStationId) || STATIONS[0];
  const stationSummary = fleetSummary.stations.find(s => s.id === selectedStationId);
  const currentSeverity = connectionStatus === 'disconnected' ? 'offline' : stationSummary?.severity || 'offline';
  const selectedFault = fleetSummary.activeFaults.find(fault => fault.stationId === selectedStationId);
  const canOperate = currentUser?.role === 'operator';

  // Severity Counts
  const normalCount = fleetSummary.stations.filter(s => s.severity === 'normal').length;
  const warningCount = fleetSummary.stations.filter(s => s.severity === 'warning').length;
  const criticalCount = fleetSummary.stations.filter(s => s.severity === 'critical').length;
  const offlineCount = fleetSummary.stations.filter(s => s.severity === 'offline').length;
  const visibleStations = STATIONS.filter(station => stationFilter === 'all' ||
    fleetSummary.stations.find(summary => summary.id === station.id)?.severity !== 'normal');
  const visibleIncidents = (incidentFilter === 'station'
    ? incidents.filter(incident => incident.stationId === selectedStationId)
    : incidents).slice(0, 5);

  function showNotice(message, duration = 4000) {
    clearTimeout(noticeTimer.current);
    setFaultActionNotice(message);
    if (duration) noticeTimer.current = setTimeout(() => setFaultActionNotice(null), duration);
  }

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // Sound Audio Alarm on Critical State transition
  const prevSeverityRef = useRef(currentSeverity);
  useEffect(() => {
    if (audioEnabled && currentSeverity === 'critical' && prevSeverityRef.current !== 'critical') {
      playScadaAlertChime(true);
    }
    prevSeverityRef.current = currentSeverity;
  }, [currentSeverity, audioEnabled]);

  // Handle Fault Trigger
  const handleTriggerFault = async (type, stationId = selectedStationId) => {
    showNotice(`Triggering ${faultLabels[type]}…`, 0);
    const res = await triggerFault(stationId, type, 60);
    if (res?.success) {
      showNotice(`${faultLabels[type]} simulation started.`);
      if (audioEnabled) playScadaAlertChime(true);
    } else showNotice(res?.error || 'Could not trigger the fault.');
    return Boolean(res?.success);
  };

  const handleClearFault = async (stationId = selectedStationId) => {
    showNotice('Clearing the fault…', 0);
    const result = await clearFault(stationId);
    showNotice(result?.success
      ? 'Fault cleared. Returning to nominal state.'
      : result?.error || 'Could not clear the fault.');
  };

  const handleSimRateChange = async (rate) => {
    const result = await changeSimulatorRate(rate);
    showNotice(result?.success
      ? `Simulator target updated to ${result.rate.toLocaleString()} readings/s`
      : result?.error || 'Could not update the simulator target.');
  };

  // Guided demo
  const autoDemoTimerRef = useRef(null);
  const autoDemoRunRef = useRef(0);
  const autoDemoFaultRef = useRef(false);
  const demoStation = 'canal-junction';

  useEffect(() => () => {
    autoDemoRunRef.current++;
    clearTimeout(autoDemoTimerRef.current);
  }, []);

  const startAutoDemo = () => {
    if (autoDemoStep) {
      stopAutoDemo();
      return;
    }

    setAudioEnabled(true);
    setDemoComplete(false);
    const runId = ++autoDemoRunRef.current;
    let stepIndex = 1;

    const runStep = async () => {
      if (runId !== autoDemoRunRef.current) return;
      if (stepIndex === 1) {
        setAutoDemoStep({ step: 1, total: 5, label: '1/5: Monitoring Canal Junction nominal telemetry (288 rps)' });
        returnToLive(demoStation);
        autoDemoTimerRef.current = setTimeout(() => { stepIndex = 2; runStep(); }, 3500);
      } else if (stepIndex === 2) {
        setAutoDemoStep({ step: 2, total: 5, label: '2/5: Inundation event! Injecting Storm Surge (+1.8m surge)' });
        const started = await handleTriggerFault('storm-surge', demoStation);
        if (runId !== autoDemoRunRef.current) {
          if (started) void clearFault(demoStation);
          return;
        }
        if (!started) {
          setAutoDemoStep(null);
          return;
        }
        autoDemoFaultRef.current = true;
        autoDemoTimerRef.current = setTimeout(() => { stepIndex = 3; runStep(); }, 4000);
      } else if (stepIndex === 3) {
        setAutoDemoStep({ step: 3, total: 5, label: '3/5: Station room isolation: East Sluice remains healthy while fleet alerts' });
        selectStation('east-sluice');
        autoDemoTimerRef.current = setTimeout(() => { stepIndex = 4; runStep(); }, 4000);
      } else if (stepIndex === 4) {
        setAutoDemoStep({ step: 4, total: 5, label: '4/5: Forensic Replay: Opening MongoDB archived storm incident' });
        const archive = await getLatestIncidents().catch(() => incidents);
        if (runId !== autoDemoRunRef.current) return;
        const incident = archive.find(item => item.stationId === demoStation && !item.resolved) ??
          archive.find(item => item.stationId === demoStation);
        if (incident) openIncidentReplay(incident);
        else returnToLive(demoStation);
        autoDemoTimerRef.current = setTimeout(() => { stepIndex = 5; runStep(); }, 4500);
      } else if (stepIndex === 5) {
        setAutoDemoStep({ step: 5, total: 5, label: '5/5: Resuming rolling live stream and clearing injected fault' });
        returnToLive(demoStation);
        if (autoDemoFaultRef.current) void handleClearFault(demoStation);
        autoDemoFaultRef.current = false;
        autoDemoTimerRef.current = setTimeout(() => {
          setDemoComplete(true);
          setAutoDemoStep(null);
        }, 3000);
      }
    };

    runStep();
  };

  const stopAutoDemo = () => {
    autoDemoRunRef.current++;
    if (autoDemoTimerRef.current) {
      clearTimeout(autoDemoTimerRef.current);
      autoDemoTimerRef.current = null;
    }
    setAutoDemoStep(null);
    setDemoComplete(false);
    returnToLive(demoStation);
    if (autoDemoFaultRef.current) void handleClearFault(demoStation);
    autoDemoFaultRef.current = false;
  };

  if (sessionChecked && !currentUser) return <SignIn onSignIn={signIn} />;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      {/* 1. Header Toolbar */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-40 backdrop-blur shadow-md">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20 text-slate-950 font-black text-lg">
            ≈
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold tracking-wider text-base text-white">FLOODLINE</span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/60">
                SCADA TELEMETRY v2.6
              </span>
            </div>
            <div className="text-xs text-slate-400 hidden sm:block">
              Stormwater Catchment Monitoring & Fault Diagnostics Console
            </div>
          </div>
        </div>

        {/* Global Connection & Status Controls */}
        <div className="flex items-center gap-2.5 sm:gap-3">
          {/* Audio Alarm Toggle */}
          <button
            onClick={() => setAudioEnabled(!audioEnabled)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium border transition ${
              audioEnabled
                ? 'bg-amber-950/80 text-amber-300 border-amber-700 shadow-[0_0_8px_#f59e0b40]'
                : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:text-white'
            }`}
            title={audioEnabled ? 'Alarm Sound: Enabled' : 'Alarm Sound: Muted (Click to enable)'}
          >
            {audioEnabled ? <Volume2 className="w-3.5 h-3.5 text-amber-400" /> : <VolumeX className="w-3.5 h-3.5" />}
            <span className="hidden md:inline">{audioEnabled ? 'Alarm ON' : 'Muted'}</span>
          </button>

          {/* Guided demo control */}
          <button
            onClick={startAutoDemo}
            disabled={!canOperate}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold border transition ${
              autoDemoStep
                ? 'bg-rose-600 text-white border-rose-500 animate-pulse'
                : 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white border-cyan-500/50 shadow'
            }`}
            title="Run guided demo"
          >
            {autoDemoStep ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
            <span>{autoDemoStep ? 'Stop Tour' : 'Run Demo'}</span>
          </button>

          {/* Connection Status Pill */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-950 border border-slate-800 text-xs font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                connectionStatus === 'connected'
                  ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                  : connectionStatus === 'connecting'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-rose-500'
              }`}
            />
            <span className="capitalize">{connectionStatus}</span>
            <span className="text-slate-500 hidden md:inline">| Seq #{seriesState.cursorSeq}</span>
          </div>

          {/* User Session / Role */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800/80 border border-slate-700 text-xs">
            <User className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-medium text-slate-200 hidden sm:inline">{currentUser?.displayName || 'Guest'}</span>
            <span className="text-[10px] uppercase px-1 py-0.2 bg-cyan-900/60 text-cyan-300 rounded font-mono">
              {currentUser?.role || 'signed out'}
            </span>
            {currentUser && currentUser.username !== 'demo-operator' &&
              <button className="text-cyan-300 hover:underline" onClick={() => {
                void signOut().catch(error => showNotice(error.message));
              }}>Sign out</button>}
          </div>

          {/* Diagnostics Button */}
          <button
            onClick={() => setShowDiagnostics(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium border border-slate-700 transition"
            title="Stream Diagnostics & Connection Simulation"
          >
            <Activity className="w-3.5 h-3.5 text-slate-300" />
            <span className="hidden lg:inline">Diagnostics</span>
          </button>
        </div>
      </header>

      {/* Auto-Demo Active Banner */}
      {demoComplete && <div role="status" className="flex items-center justify-between gap-2 border-b border-emerald-800 bg-emerald-950 px-4 py-2 text-sm text-emerald-200">
        <span>Demo walkthrough complete</span>
        <button onClick={() => setDemoComplete(false)} className="underline">Dismiss</button>
      </div>}
      {autoDemoStep && (
        <div className="bg-gradient-to-r from-cyan-950 via-blue-900 to-indigo-950 border-b border-cyan-500/50 px-4 py-2 text-xs font-mono flex items-center justify-between text-cyan-200 shadow-inner">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping"></span>
            <span className="font-bold text-white tracking-wide">AUTONOMOUS GUIDED DEMO ACTIVE:</span>
            <span>{autoDemoStep.label}</span>
          </div>
          <button
            onClick={stopAutoDemo}
            className="text-slate-300 hover:text-white underline text-xs"
          >
            Exit Tour
          </button>
        </div>
      )}

      {/* 2. Fleet Overview & Simulator Rate Bar */}
      <section className="bg-slate-900/60 border-b border-slate-800/70 px-4 py-2 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-y-2">
        {/* Real-Time Throughput Stats */}
        <div className="flex flex-wrap items-center gap-4 sm:gap-6 font-mono">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-cyan-400" />
            <span>Ingest:</span>
            <span className="font-bold text-white">
              {fleetSummary.metrics?.throughputEventsSec ?? selectedSimRate} <span className="text-slate-500">ev/s</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-emerald-400" />
            <span>Stored:</span>
            <span className="font-bold text-white">
              {fleetSummary.metrics?.persistedSec ?? 0} <span className="text-slate-500">readings/s</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-purple-400" />
            <span>Published:</span>
            <span className="font-bold text-white">
              {fleetSummary.metrics?.broadcastSec ?? 0} <span className="text-slate-500">readings/s</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 hidden md:flex">
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span>Queue:</span>
            <span className="font-bold text-white">
              {fleetSummary.metrics?.queueLength ?? 0} <span className="text-slate-500">/ 16k</span>
            </span>
          </div>
          {!!fleetSummary.metrics?.simulatorDroppedEvents && <span className="text-amber-300">
            Simulator drops: {fleetSummary.metrics.simulatorDroppedEvents.toLocaleString()}
          </span>}
          {fleetSummary.metrics?.storageReady === false && <span role="status" className="text-amber-300">
            MongoDB writes interrupted
          </span>}
        </div>

        {/* Live Simulator Rate Selector */}
        <div className="flex items-center gap-2 font-mono">
          <span className="text-slate-500 hidden xl:inline">Load Target:</span>
          <div className="flex items-center gap-1 bg-slate-950 p-0.5 rounded border border-slate-800 text-[11px]">
            {[
              { label: '48/s', val: 48 },
              { label: '288/s (Nominal)', val: 288 },
              { label: '1,000/s', val: 1000 },
              { label: '3,000/s (Storm)', val: 3000 }
            ].map(r => (
              <button
                key={r.val}
                disabled={!canOperate}
                onClick={() => handleSimRateChange(r.val)}
                className={`px-2 py-0.5 rounded transition ${
                  selectedSimRate === r.val
                    ? 'bg-cyan-600 text-white font-bold'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Network Severity Indicators */}
        <div className="flex items-center gap-3 font-mono">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/50 text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            Norm: {normalCount}
          </span>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/60 border border-amber-800/50 text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
            Warn: {warningCount}
          </span>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-rose-950/60 border border-rose-800/50 text-rose-300">
            <span className="w-2 h-2 rounded-full bg-rose-400"></span>
            Crit: {criticalCount}
          </span>
          {offlineCount > 0 && <span className="text-slate-300">No signal: {offlineCount}</span>}
        </div>
      </section>

      {/* Main Content Layout */}
      <main className="flex-1 p-3 sm:p-5 max-w-[1600px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Basin Schematic & Station Roster (4 cols) */}
        <div className="min-w-0 lg:col-span-4 flex flex-col gap-4">
          {/* Basin Schematic SVG Map */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 shadow-lg">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Droplets className="w-3.5 h-3.5 text-cyan-400" />
                Basin Catchment Schematic
              </h2>
              <span className="text-[10px] text-slate-500 font-mono">Click station to subscribe</span>
            </div>

            {/* SVG Basin Topology */}
            <div className="relative w-full aspect-[16/10] bg-slate-950 rounded-md border border-slate-800/80 overflow-hidden">
              <svg viewBox="0 0 1000 600" className="w-full h-full">
                <defs>
                  <pattern id="flowGrid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <line x1="0" y1="0" x2="20" y2="20" stroke="#1e293b" strokeWidth="0.5" />
                  </pattern>
                </defs>

                <rect width="1000" height="600" fill="url(#flowGrid)" opacity="0.3" />

                {/* Flow Lines */}
                <path d="M 260 120 Q 340 200, 420 280" fill="none" stroke="#0284c7" strokeWidth="6" strokeDasharray="8 6" className="animate-[dash_2s_linear_infinite]" />
                <path d="M 160 350 Q 290 310, 420 280" fill="none" stroke="#0284c7" strokeWidth="6" strokeDasharray="8 6" />
                <path d="M 420 280 Q 490 370, 560 460" fill="none" stroke="#0284c7" strokeWidth="8" strokeDasharray="10 6" />
                <path d="M 560 460 Q 650 425, 740 390" fill="none" stroke="#0284c7" strokeWidth="10" strokeDasharray="12 6" />
                <path d="M 740 390 L 960 390" fill="none" stroke="#0369a1" strokeWidth="14" strokeDasharray="14 8" />
                <path d="M 860 220 L 960 220" fill="none" stroke="#0369a1" strokeWidth="12" strokeDasharray="12 6" />

                <path d="M 940 150 Q 980 300, 960 450 L 1000 450 L 1000 150 Z" fill="#075985" opacity="0.4" />
                <text x="965" y="300" fill="#38bdf8" fontSize="12" transform="rotate(90 965 300)" fontFamily="monospace">
                  TIDAL ESTUARY
                </text>

                {/* Render Stations as Interactive Nodes */}
                {STATIONS.map((st) => {
                  const state = fleetSummary.stations.find(s => s.id === st.id);
                  const isSelected = selectedStationId === st.id;
                  const sev = state?.severity || 'offline';

                  const nodeColor = sev === 'critical' ? '#ef4444' : sev === 'warning' ? '#f59e0b' : sev === 'offline' ? '#64748b' : '#10b981';
                  const glowColor = sev === 'critical' ? 'rgba(239, 68, 68, 0.5)' : sev === 'warning' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(16, 185, 129, 0.3)';

                  return (
                    <g
                      key={st.id}
                      role="button"
                      tabIndex={0}
                      aria-label={st.name + ', ' + (sev === 'offline' ? 'no signal' : sev)}
                      aria-pressed={isSelected}
                      className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                      onClick={() => selectStation(st.id)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectStation(st.id);
                        }
                      }}
                    >
                      {(sev === 'critical' || sev === 'warning') && (
                        <circle cx={st.coordinates.x} cy={st.coordinates.y} r={isSelected ? 32 : 26} fill={glowColor} className="pointer-events-none animate-ping" />
                      )}
                      <circle cx={st.coordinates.x} cy={st.coordinates.y} r={isSelected ? 22 : 18} fill="#0f172a" stroke={isSelected ? '#38bdf8' : nodeColor} strokeWidth={isSelected ? 3.5 : 2} />
                      <circle cx={st.coordinates.x} cy={st.coordinates.y} r={6} fill={nodeColor} />
                      <text x={st.coordinates.x} y={st.coordinates.y - 28} textAnchor="middle" fill={isSelected ? '#38bdf8' : '#e2e8f0'} fontSize="12" fontWeight="bold" fontFamily="monospace">
                        {st.code}
                      </text>
                      <text x={st.coordinates.x} y={st.coordinates.y + 36} textAnchor="middle" fill="#94a3b8" fontSize="11" fontFamily="monospace">
                        {sev === 'offline' ? '--' : `${state.waterLevel.toFixed(1)}m`}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {/* Station Roster (List of all 6 stations) */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 shadow-lg flex-1">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">Basin Pump Stations</h2>
              <select aria-label="Filter stations" className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                value={stationFilter} onChange={event => setStationFilter(event.target.value)}>
                <option value="all">All stations</option>
                <option value="attention">Needs attention</option>
              </select>
            </div>

            <div className="space-y-1.5">
              {!visibleStations.length && <p className="p-2 text-xs text-slate-400">No stations need attention.</p>}
              {visibleStations.map((st) => {
                const state = fleetSummary.stations.find(s => s.id === st.id);
                const isSelected = selectedStationId === st.id;
                const sev = state?.severity || 'offline';

                return (
                  <div
                    key={st.id}
                    onClick={() => selectStation(st.id)}
                    className={`p-2.5 rounded-md border cursor-pointer transition flex items-center justify-between ${
                      isSelected
                        ? 'bg-slate-800/90 border-cyan-500/80 shadow-md ring-1 ring-cyan-500/30'
                        : 'bg-slate-950/60 border-slate-800 hover:bg-slate-850 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          sev === 'critical'
                            ? 'bg-rose-500 shadow-[0_0_8px_#f43f5e]'
                            : sev === 'warning'
                            ? 'bg-amber-400 shadow-[0_0_8px_#fbbf24]'
                            : sev === 'offline' ? 'bg-slate-500' : 'bg-emerald-400'
                        }`}
                      />
                      <div>
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                          <span>{st.name}</span>
                          <span className="text-[10px] text-slate-500 font-mono">[{st.code}]</span>
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-3 font-mono mt-0.5">
                          <span>WL: <strong className="text-cyan-400">{sev === 'offline' ? '--' : `${state.waterLevel.toFixed(2)}m`}</strong></span>
                          <span>Flow: <strong className="text-emerald-400">{sev === 'offline' ? '--' : `${state.outflow.toFixed(0)}L/s`}</strong></span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`text-[10px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border ${
                          sev === 'critical'
                            ? 'bg-rose-950/80 text-rose-300 border-rose-800'
                            : sev === 'warning'
                            ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                            : sev === 'offline' ? 'bg-slate-800 text-slate-300 border-slate-600' : 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                        }`}
                      >
                        {sev === 'offline' ? 'No signal' : sev}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column: Selected Station Header, Metric Cards, Canvas Plot, Incident Timeline (8 cols) */}
        <div className="min-w-0 lg:col-span-8 flex flex-col gap-4">
          {/* Selected Station Control & Fault Injection Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3.5 shadow-lg flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base sm:text-lg font-extrabold text-white">{currentStation.name}</h1>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-cyan-400 border border-slate-700">
                  {currentStation.code}
                </span>
                <span
                  className={`text-xs uppercase font-mono font-bold px-2 py-0.5 rounded border ${
                    currentSeverity === 'critical'
                      ? 'bg-rose-950 text-rose-300 border-rose-700 animate-pulse'
                      : currentSeverity === 'warning'
                      ? 'bg-amber-950 text-amber-300 border-amber-700'
                      : currentSeverity === 'offline'
                      ? 'bg-slate-800 text-slate-300 border-slate-600'
                      : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                  }`}
                >
                  {currentSeverity === 'offline' ? 'No signal' : currentSeverity}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {currentStation.description} • {currentStation.pumpCount} Pumps • Capacity: {currentStation.ratedCapacity} L/s
              </p>
              {selectedFault && <p className="mt-2 text-xs text-amber-300">
                {faultLabels[selectedFault.type]} simulation · {selectedFault.remainingSec}s remaining
              </p>}
            </div>

            {/* Operator Fault Injection Actions */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400 font-medium mr-1 hidden sm:inline">Fault Sim:</span>
              <button
                onClick={() => handleTriggerFault('storm-surge')}
                disabled={!canOperate}
                className="px-2.5 py-1 text-xs font-semibold rounded bg-rose-950/80 hover:bg-rose-900 text-rose-200 border border-rose-800/80 transition flex items-center gap-1"
                title="Inject Storm Surge: High water level, peak outflow"
              >
                <Flame className="w-3.5 h-3.5 text-rose-400" />
                Storm Surge
              </button>
              <button
                onClick={() => handleTriggerFault('intake-blockage')}
                disabled={!canOperate}
                className="px-2.5 py-1 text-xs font-semibold rounded bg-amber-950/80 hover:bg-amber-900 text-amber-200 border border-amber-800/80 transition flex items-center gap-1"
                title="Inject Intake Blockage: High water level, collapsed outflow, cavitation"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                Blockage
              </button>
              <button
                onClick={() => handleTriggerFault('motor-overload')}
                disabled={!canOperate}
                className="px-2.5 py-1 text-xs font-semibold rounded bg-purple-950/80 hover:bg-purple-900 text-purple-200 border border-purple-800/80 transition flex items-center gap-1"
                title="Inject Motor Overload: Severe vibration, electrical overcurrent"
              >
                <Zap className="w-3.5 h-3.5 text-purple-400" />
                Overload
              </button>
              <button
                onClick={() => handleClearFault()}
                disabled={!canOperate}
                className="px-2.5 py-1 text-xs font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                title="Clear all active faults on this station"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Fault Notice Notification */}
          {historyError && (
            <div role="alert" className="flex items-center justify-between gap-2 rounded border border-amber-800 bg-amber-950 p-2 text-xs text-amber-200">
              <span>{historyError}</span>
              <button className="underline" onClick={() => seriesState.isHistoricalLocked ? shiftHistoricalWindow(0) : returnToLive()}>Retry</button>
            </div>
          )}
          {faultActionNotice && (
            <div role="status" className="bg-cyan-950/80 border border-cyan-800 text-cyan-200 px-3 py-1.5 rounded-md text-xs font-mono flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              <span>{faultActionNotice}</span>
            </div>
          )}

          {/* 4 Enhanced SCADA Metric Cards with Live Meter Gauges */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Card 1: Water Level */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 shadow flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="flex items-center gap-1">
                    <Droplets className="w-3.5 h-3.5 text-cyan-400" />
                    Water Level
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">Warn &gt;3.0m</span>
                </div>
                <div className="text-xl sm:text-2xl font-black font-mono text-cyan-400">
                  {metricsSummary.waterLevel?.current?.toFixed(2) ?? '--'} <span className="text-xs font-normal text-slate-400">m</span>
                </div>
              </div>
              <div className="mt-2">
                {/* Visual Level Meter */}
                <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(5, ((metricsSummary.waterLevel?.current || 0) / 4.5) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
                  <span>Min: {metricsSummary.waterLevel?.min?.toFixed(2)}m</span>
                  <span>Max: {metricsSummary.waterLevel?.max?.toFixed(2)}m</span>
                </div>
              </div>
            </div>

            {/* Card 2: Outflow */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 shadow flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="flex items-center gap-1">
                    <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                    Discharge Flow
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">Rated {currentStation.ratedCapacity}</span>
                </div>
                <div className="text-xl sm:text-2xl font-black font-mono text-emerald-400">
                  {metricsSummary.outflow?.current?.toFixed(0) ?? '--'} <span className="text-xs font-normal text-slate-400">L/s</span>
                </div>
              </div>
              <div className="mt-2">
                {/* Visual Discharge Meter */}
                <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(5, ((metricsSummary.outflow?.current || 0) / currentStation.ratedCapacity) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
                  <span>Min: {metricsSummary.outflow?.min?.toFixed(0)}L/s</span>
                  <span>Max: {metricsSummary.outflow?.max?.toFixed(0)}L/s</span>
                </div>
              </div>
            </div>

            {/* Card 3: Vibration (ISO 10816 Severity Zones) */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 shadow flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                    Vibration (RMS)
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">Crit &gt;7.1</span>
                </div>
                <div className="text-xl sm:text-2xl font-black font-mono text-amber-400">
                  {metricsSummary.vibration?.current?.toFixed(2) ?? '--'} <span className="text-xs font-normal text-slate-400">mm/s</span>
                </div>
              </div>
              <div className="mt-2">
                {/* ISO 10816 4-zone meter */}
                <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800 flex">
                  <div className="w-[35%] bg-emerald-500/50" title="Zone A/B: Good" />
                  <div className="w-[30%] bg-amber-500/50" title="Zone C: Warning" />
                  <div className="w-[35%] bg-rose-500/50" title="Zone D: Danger" />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
                  <span>Min: {metricsSummary.vibration?.min?.toFixed(1)}</span>
                  <span>Max: {metricsSummary.vibration?.max?.toFixed(1)}</span>
                </div>
              </div>
            </div>

            {/* Card 4: Motor Current */}
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 shadow flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5 text-purple-400" />
                    Motor Current
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">Crit &gt;105A</span>
                </div>
                <div className="text-xl sm:text-2xl font-black font-mono text-purple-400">
                  {metricsSummary.current?.current?.toFixed(1) ?? '--'} <span className="text-xs font-normal text-slate-400">A</span>
                </div>
              </div>
              <div className="mt-2">
                {/* Motor Amperage Capacity Meter */}
                <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="bg-gradient-to-r from-purple-500 to-indigo-400 h-full transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(5, ((metricsSummary.current?.current || 0) / 125) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
                  <span>Min: {metricsSummary.current?.min?.toFixed(0)}A</span>
                  <span>Max: {metricsSummary.current?.max?.toFixed(0)}A</span>
                </div>
              </div>
            </div>
          </div>

          {/* Real-Time Canvas Plot */}
          <TelemetryPlot
            points={seriesState.points}
            station={currentStation}
            activeMetric={activeMetricTab}
            onMetricChange={setActiveMetricTab}
            windowPreset={seriesState.windowPreset}
            onWindowPresetChange={setWindowPreset}
            isHistoricalLocked={seriesState.isHistoricalLocked}
            historicalRange={seriesState.historicalRange}
            onReturnToLive={returnToLive}
            onShiftWindow={shiftHistoricalWindow}
          />

          {/* Incident Timeline & Historical Replay Selector with CSV Export */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-3.5 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                Incident Timeline
              </h2>
              <select aria-label="Filter incidents by station" className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                value={incidentFilter} onChange={event => setIncidentFilter(event.target.value)}>
                <option value="all">All stations</option>
                <option value="station">Selected station</option>
              </select>
            </div>

            {visibleIncidents.length === 0 ? (
              <div className="text-xs text-slate-500 font-mono py-3 text-center">
                No incidents in this view.
              </div>
            ) : (
              <div className="space-y-2">
                {visibleIncidents.map((inc) => {
                  const durationSec = Math.round(((inc.endTime || Date.now()) - inc.startTime) / 1000);
                  const isCrit = inc.severity === 'critical';

                  return (
                    <div
                      key={inc.incidentId}
                      className={`p-2.5 rounded-md border transition flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                        isCrit
                          ? 'bg-rose-950/40 border-rose-800/70 hover:bg-rose-950/70'
                          : 'bg-amber-950/40 border-amber-800/70 hover:bg-amber-950/70'
                      }`}
                    >
                      <div className="cursor-pointer" onClick={() => openIncidentReplay(inc)}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-[10px] font-mono font-bold uppercase px-1.5 py-0.2 rounded border ${
                              isCrit ? 'bg-rose-900 text-rose-200 border-rose-700' : 'bg-amber-900 text-amber-200 border-amber-700'
                            }`}
                          >
                            {inc.severity}
                          </span>
                          <span className="text-xs font-bold text-white capitalize">
                            {inc.stationId.replace('-', ' ')}
                          </span>
                          <span className="text-[11px] text-slate-400 font-mono">
                            {new Date(inc.startTime).toLocaleTimeString()}
                          </span>
                          <span className="text-[11px] text-slate-500 font-mono">
                            ({durationSec}s duration)
                          </span>
                          <span className={`text-[10px] px-1.5 rounded border font-mono ${inc.resolved
                            ? 'text-emerald-400 bg-emerald-950/60 border-emerald-800'
                            : 'text-amber-300 bg-amber-950/60 border-amber-800'}`}>
                            {inc.resolved ? 'Resolved' : 'Active'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 mt-1">
                          {inc.reasons?.[0] || 'Anomalous telemetry conditions detected'}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <a
                          href={`/api/incidents/${encodeURIComponent(inc.incidentId)}/export`}
                          download
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-mono border border-slate-700 transition flex items-center gap-1"
                          title="Export incident telemetry as CSV"
                        >
                          <Download className="w-3 h-3 text-cyan-400" />
                          <span>CSV</span>
                        </a>
                        <button
                          onClick={() => openIncidentReplay(inc)}
                          className="px-2.5 py-1 bg-cyan-700 hover:bg-cyan-600 text-white rounded text-xs font-medium transition flex items-center gap-1"
                        >
                          <span>Replay</span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Stream Diagnostics Modal */}
      {showDiagnostics && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-5 shadow-2xl relative">
            <button
              onClick={() => setShowDiagnostics(false)}
              aria-label="Close diagnostics"
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-base font-bold text-white flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4 text-cyan-400" />
              Stream Diagnostics & Handshake Verification
            </h3>

            <div className="space-y-2.5 text-xs font-mono bg-slate-950 p-4 rounded-lg border border-slate-800 text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-500">Connection State:</span>
                <span className="font-bold text-emerald-400 uppercase">{connectionStatus}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Socket ID:</span>
                <span>{socketId || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Subscribed Room:</span>
                <span className="text-cyan-400 font-bold">station:{selectedStationId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Latest Cursor Seq:</span>
                <span className="text-purple-400 font-bold">#{seriesState.cursorSeq}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Buffered Sync Packets:</span>
                <span>{seriesState.bufferedCount} pkts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Active Viewport Points:</span>
                <span>{seriesState.points.length} samples</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Ingest Queue Backpressure:</span>
                <span className="text-emerald-400 font-bold">{fleetSummary.metrics?.queueLength || 0} / 16,000</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Client Repaint Rate:</span>
                <span className="text-cyan-400 font-bold">4 Hz (250ms throttled)</span>
              </div>
            </div>

            {/* Test Reconnect Action */}
            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
              <p className="text-[11px] text-slate-400">
                Simulates network drop and tests reconnect cursor gap reconciliation.
              </p>
              <button
                onClick={testReconnect}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-bold transition flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Test Reconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-slate-950 border-t border-slate-800/80 px-4 py-2.5 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2 font-mono">
        <div>
          FLOODLINE SCADA Telemetry Console • MERN Stack & Socket.IO Telemetry
        </div>
        <div>
          MongoDB Community 8.0 • 6 Distributed Stations • Monotonic Cursor Handshake
        </div>
      </footer>
    </div>
  );
}

function SignIn({ onSignIn }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await onSignIn(fields.get('username'), fields.get('password'));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return <main className="min-h-screen grid place-items-center px-4">
    <form className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-6 space-y-4" onSubmit={submit}>
      <h1 className="text-xl font-bold">Sign in to Floodline</h1>
      <label className="block text-sm">Username
        <input className="block w-full mt-1 rounded bg-slate-950 border border-slate-700 p-2" name="username" autoComplete="username" required />
      </label>
      <label className="block text-sm">Password
        <input className="block w-full mt-1 rounded bg-slate-950 border border-slate-700 p-2" name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p role="alert" className="text-rose-300 text-sm">{error}</p>}
      <button type="submit" disabled={busy} className="rounded bg-cyan-700 px-4 py-2 text-sm font-semibold disabled:opacity-50">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  </main>;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<FloodlineApp />);
}
