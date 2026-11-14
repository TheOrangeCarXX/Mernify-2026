/**
 * Floodline - Municipal SCADA Stormwater Telemetry Console
 * High-Throughput Stream Monitoring & Fault Diagnostics Platform
 * Complies with High-Performance HMI (ISA-101) Ergonomics.
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
  X,
  Volume2,
  VolumeX,
  Play,
  Square,
  Download,
  Terminal,
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
    const freq = isCritical ? 880 : 587;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(isCritical ? 440 : 493, ctx.currentTime + 0.18);

    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.18);
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
  const [autoDemoStep, setAutoDemoStep] = useState(null);
  const [demoComplete, setDemoComplete] = useState(false);
  const [incidentFilter, setIncidentFilter] = useState('all');
  const [stationFilter, setStationFilter] = useState('all');
  const [systemClock, setSystemClock] = useState(() => new Date().toISOString().slice(11, 19) + ' UTC');
  const selectedSimRate = fleetSummary.metrics?.simulatorRate ?? 288;

  // Real-time ticking system clock
  useEffect(() => {
    const timer = setInterval(() => {
      setSystemClock(new Date().toISOString().slice(11, 19) + ' UTC');
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
    <div className="min-h-screen max-w-full overflow-x-hidden bg-[#070b12] text-slate-200 flex flex-col font-sans selection:bg-sky-600 selection:text-white">
      {/* 1. Industrial SCADA Control Room Header Toolbar */}
      <header className="bg-[#0b101b] border-b border-[#1e293b] px-4 py-2 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-40 shadow-sm">
        <div className="flex items-center gap-3">
          {/* Industrial Station Glyph */}
          <div className="flex items-center justify-center w-7 h-7 rounded bg-[#131b2e] border border-sky-500/40 text-sky-400 font-mono font-bold text-sm">
            FL
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-tight text-sm text-slate-100 font-mono">FLOODLINE</span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-[#131b2e] text-sky-400 border border-[#1e293b]">
                SCADA TELEMETRY v2.6
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono hidden sm:flex items-center gap-2">
              <span>MUNICIPAL STORMWATER TELEMETRY</span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400 tabular-nums">{systemClock}</span>
            </div>
          </div>
        </div>

        {/* Global Connection & Status Controls */}
        <div className="flex items-center gap-2 sm:gap-2.5">
          {/* Audio Alarm Toggle */}
          <button
            onClick={() => setAudioEnabled(!audioEnabled)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono border transition ${
              audioEnabled
                ? 'bg-amber-950/70 text-amber-300 border-amber-600'
                : 'bg-[#101726] text-slate-400 border-[#1e293b] hover:text-slate-200'
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
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-semibold border transition ${
              autoDemoStep
                ? 'bg-rose-700 text-white border-rose-500 animate-pulse'
                : 'bg-[#0369a1] hover:bg-[#0284c7] text-white border-sky-500/50'
            }`}
            title="Run guided demo"
          >
            {autoDemoStep ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
            <span>{autoDemoStep ? 'Stop Tour' : 'Run Demo'}</span>
          </button>

          {/* Connection Status Pill */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-[#070b12] border border-[#1e293b] text-xs font-mono">
            <span
              className={`w-2 h-2 rounded-sm ${
                connectionStatus === 'connected'
                  ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                  : connectionStatus === 'connecting'
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-rose-500'
              }`}
            />
            <span className="capitalize">{connectionStatus}</span>
            <span className="text-slate-500 hidden md:inline tabular-nums">| Seq #{seriesState.cursorSeq}</span>
          </div>

          {/* User Session / Role */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#101726] border border-[#1e293b] text-xs font-mono">
            <User className="w-3 h-3 text-sky-400" />
            <span className="text-slate-300 hidden sm:inline">{currentUser?.displayName || 'Guest'}</span>
            <span className="text-[10px] uppercase px-1 py-0.2 bg-[#131b2e] text-sky-300 rounded border border-[#1e293b]">
              {currentUser?.role || 'signed out'}
            </span>
            {currentUser && currentUser.username !== 'demo-operator' &&
              <button className="text-sky-300 hover:underline" onClick={() => {
                void signOut().catch(error => showNotice(error.message));
              }}>Sign out</button>}
          </div>

          {/* Diagnostics Button */}
          <button
            onClick={() => setShowDiagnostics(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#101726] hover:bg-[#162238] text-xs font-mono border border-[#1e293b] transition"
            title="Stream Diagnostics & Connection Simulation"
          >
            <Activity className="w-3.5 h-3.5 text-slate-400" />
            <span className="hidden lg:inline">Diagnostics</span>
          </button>
        </div>
      </header>

      {/* Auto-Demo Active Banner */}
      {demoComplete && (
        <div role="status" className="flex items-center justify-between gap-2 border-b border-emerald-800 bg-[#062c1d] px-4 py-1.5 text-xs font-mono text-emerald-200">
          <span>Demo walkthrough complete</span>
          <button onClick={() => setDemoComplete(false)} className="underline hover:text-white">Dismiss</button>
        </div>
      )}
      {autoDemoStep && (
        <div className="bg-[#0b192e] border-b border-sky-600/50 px-4 py-1.5 text-xs font-mono flex items-center justify-between text-sky-200">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-sm bg-sky-400 animate-ping"></span>
            <span className="font-bold text-white tracking-wide">AUTONOMOUS GUIDED DEMO:</span>
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

      {/* 2. Fleet Telemetry & Rate Bar */}
      <section className="bg-[#0b101b]/80 border-b border-[#1e293b] px-4 py-1.5 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-y-2">
        {/* Real-Time Throughput Stats */}
        <div className="flex flex-wrap items-center gap-4 sm:gap-5 font-mono tabular-nums">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-slate-400">Ingest:</span>
            <span className="font-bold text-slate-100">
              {fleetSummary.metrics?.throughputEventsSec ?? selectedSimRate} <span className="text-slate-500 font-normal">ev/s</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-slate-400">Stored:</span>
            <span className="font-bold text-slate-100">
              {fleetSummary.metrics?.persistedSec ?? 0} <span className="text-slate-500 font-normal">readings/s</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-slate-400">Published:</span>
            <span className="font-bold text-slate-100">
              {fleetSummary.metrics?.broadcastSec ?? 0} <span className="text-slate-500 font-normal">readings/s</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 hidden md:flex">
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-slate-400">Queue:</span>
            <span className="font-bold text-slate-100">
              {fleetSummary.metrics?.queueLength ?? 0} <span className="text-slate-500 font-normal">/ 16k</span>
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
          <span className="text-slate-400 hidden xl:inline text-[11px]">Load Target:</span>
          <div className="flex items-center gap-0.5 bg-[#070b12] p-0.5 rounded border border-[#1e293b] text-[11px]">
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
                    ? 'bg-[#0284c7] text-white font-bold'
                    : 'text-slate-400 hover:text-white hover:bg-[#131b2e]'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Network Severity Indicators */}
        <div className="flex items-center gap-2 font-mono tabular-nums text-[11px]">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#071d15] border border-emerald-800/60 text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-sm bg-emerald-400"></span>
            Norm: {normalCount}
          </span>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#271b05] border border-amber-800/60 text-amber-300">
            <span className="w-1.5 h-1.5 rounded-sm bg-amber-400"></span>
            Warn: {warningCount}
          </span>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#2a0b12] border border-rose-800/60 text-rose-300">
            <span className="w-1.5 h-1.5 rounded-sm bg-rose-400"></span>
            Crit: {criticalCount}
          </span>
          {offlineCount > 0 && <span className="text-slate-400">No signal: {offlineCount}</span>}
        </div>
      </section>

      {/* Main Content Layout */}
      <main className="flex-1 p-3 sm:p-4 max-w-[1680px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Column: Basin Schematic & Station Roster (4 cols) */}
        <div className="min-w-0 lg:col-span-4 flex flex-col gap-3.5">
          {/* Basin Schematic SVG Map */}
          <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm">
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-[#172033]">
              <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Droplets className="w-3.5 h-3.5 text-sky-400" />
                Basin Catchment Schematic
              </h2>
              <span className="text-[10px] text-slate-400 font-mono">P&ID Topology</span>
            </div>

            {/* SVG Basin Topology */}
            <div className="relative w-full aspect-[16/10] bg-[#070b12] rounded border border-[#172033] overflow-hidden scada-grid">
              <svg viewBox="0 0 1000 600" className="w-full h-full">
                {/* Conduit Lines */}
                <path d="M 260 120 Q 340 200, 420 280" fill="none" stroke="#0369a1" strokeWidth="5" strokeDasharray="6 4" />
                <path d="M 160 350 Q 290 310, 420 280" fill="none" stroke="#0369a1" strokeWidth="5" strokeDasharray="6 4" />
                <path d="M 420 280 Q 490 370, 560 460" fill="none" stroke="#0284c7" strokeWidth="7" strokeDasharray="8 4" />
                <path d="M 560 460 Q 650 425, 740 390" fill="none" stroke="#0284c7" strokeWidth="8" strokeDasharray="10 4" />
                <path d="M 740 390 L 960 390" fill="none" stroke="#0ea5e9" strokeWidth="10" strokeDasharray="12 4" />
                <path d="M 860 220 L 960 220" fill="none" stroke="#0ea5e9" strokeWidth="8" strokeDasharray="10 4" />

                <path d="M 940 150 Q 980 300, 960 450 L 1000 450 L 1000 150 Z" fill="#0c4a6e" opacity="0.4" />
                <text x="968" y="300" fill="#38bdf8" fontSize="11" transform="rotate(90 968 300)" fontFamily="monospace" fontWeight="bold">
                  TIDAL ESTUARY
                </text>

                {/* Stations as Technical SCADA Nodes */}
                {STATIONS.map((st) => {
                  const state = fleetSummary.stations.find(s => s.id === st.id);
                  const isSelected = selectedStationId === st.id;
                  const sev = state?.severity || 'offline';

                  const nodeColor = sev === 'critical' ? '#ef4444' : sev === 'warning' ? '#f59e0b' : sev === 'offline' ? '#64748b' : '#10b981';

                  return (
                    <g
                      key={st.id}
                      role="button"
                      tabIndex={0}
                      aria-label={st.name + ', ' + (sev === 'offline' ? 'no signal' : sev)}
                      aria-pressed={isSelected}
                      className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                      onClick={() => selectStation(st.id)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectStation(st.id);
                        }
                      }}
                    >
                      {/* Industrial crosshair ring */}
                      <circle cx={st.coordinates.x} cy={st.coordinates.y} r={isSelected ? 20 : 16} fill="#0d1424" stroke={isSelected ? '#38bdf8' : '#1e293b'} strokeWidth={isSelected ? 2.5 : 1.5} />
                      <circle cx={st.coordinates.x} cy={st.coordinates.y} r={5} fill={nodeColor} />

                      {/* Code Tag Box */}
                      <rect x={st.coordinates.x - 22} y={st.coordinates.y - 32} width={44} height={16} rx={2} fill="#0b101b" stroke={isSelected ? '#38bdf8' : '#1e293b'} strokeWidth={1} />
                      <text x={st.coordinates.x} y={st.coordinates.y - 20} textAnchor="middle" fill={isSelected ? '#38bdf8' : '#cbd5e1'} fontSize="10" fontWeight="bold" fontFamily="monospace">
                        {st.code}
                      </text>

                      {/* Water Level Tag */}
                      <text x={st.coordinates.x} y={st.coordinates.y + 32} textAnchor="middle" fill="#94a3b8" fontSize="10" fontFamily="monospace">
                        {sev === 'offline' ? '--' : `${state.waterLevel.toFixed(1)}m`}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          {/* Station Roster (List of all 6 stations) */}
          <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm flex-1">
            <div className="mb-2 pb-1.5 border-b border-[#172033] flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-300">Station Roster</h2>
              <select aria-label="Filter stations" className="rounded border border-[#1e293b] bg-[#070b12] px-2 py-0.5 text-xs font-mono text-slate-300"
                value={stationFilter} onChange={event => setStationFilter(event.target.value)}>
                <option value="all">All stations</option>
                <option value="attention">Needs attention</option>
              </select>
            </div>

            <div className="space-y-1">
              {!visibleStations.length && <p className="p-2 text-xs text-slate-400 font-mono">No stations need attention.</p>}
              {visibleStations.map((st) => {
                const state = fleetSummary.stations.find(s => s.id === st.id);
                const isSelected = selectedStationId === st.id;
                const sev = state?.severity || 'offline';

                return (
                  <div
                    key={st.id}
                    onClick={() => selectStation(st.id)}
                    className={`p-2 rounded border cursor-pointer transition flex items-center justify-between ${
                      isSelected
                        ? 'bg-[#131c30] border-sky-500/80'
                        : 'bg-[#070b12] border-[#172033] hover:bg-[#0e1524]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-2 h-2 rounded-sm ${
                          sev === 'critical'
                            ? 'bg-rose-500'
                            : sev === 'warning'
                            ? 'bg-amber-400'
                            : sev === 'offline' ? 'bg-slate-500' : 'bg-emerald-400'
                        }`}
                      />
                      <div>
                        <div className="text-xs font-semibold text-slate-100 flex items-center gap-1.5 font-mono">
                          <span>{st.name}</span>
                          <span className="text-[10px] text-slate-400">[{st.code}]</span>
                        </div>
                        <div className="text-[10px] text-slate-400 flex items-center gap-3 font-mono mt-0.5 tabular-nums">
                          <span>WL: <strong className="text-sky-400 font-normal">{sev === 'offline' ? '--' : `${state.waterLevel.toFixed(2)}m`}</strong></span>
                          <span>Flow: <strong className="text-emerald-400 font-normal">{sev === 'offline' ? '--' : `${state.outflow.toFixed(0)}L/s`}</strong></span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.2 rounded border ${
                          sev === 'critical'
                            ? 'bg-rose-950 text-rose-300 border-rose-800'
                            : sev === 'warning'
                            ? 'bg-amber-950 text-amber-300 border-amber-800'
                            : sev === 'offline' ? 'bg-[#172033] text-slate-300 border-slate-700' : 'bg-emerald-950 text-emerald-300 border-emerald-800'
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

        {/* Right Column: Station Details, 4 Calibrated Gauges, Canvas Plot, Incident Timeline (8 cols) */}
        <div className="min-w-0 lg:col-span-8 flex flex-col gap-3.5">
          {/* Selected Station Control Bar */}
          <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold text-slate-100 font-mono tracking-tight">{currentStation.name}</h1>
                <span className="font-mono text-xs px-1.5 py-0.2 rounded bg-[#131b2e] text-sky-400 border border-[#1e293b]">
                  {currentStation.code}
                </span>
                <span
                  className={`text-xs uppercase font-mono font-bold px-1.5 py-0.2 rounded border ${
                    currentSeverity === 'critical'
                      ? 'bg-rose-950 text-rose-300 border-rose-700 animate-pulse'
                      : currentSeverity === 'warning'
                      ? 'bg-amber-950 text-amber-300 border-amber-700'
                      : currentSeverity === 'offline'
                      ? 'bg-[#172033] text-slate-300 border-slate-700'
                      : 'bg-emerald-950 text-emerald-300 border-emerald-800'
                  }`}
                >
                  {currentSeverity === 'offline' ? 'No signal' : currentSeverity}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                {currentStation.description} • {currentStation.pumpCount} Submersible Units • Rated: {currentStation.ratedCapacity} L/s
              </p>
              {selectedFault && <p className="mt-1.5 text-xs text-amber-300 font-mono">
                FAULT INJECTED: {faultLabels[selectedFault.type]} ({selectedFault.remainingSec}s remaining)
              </p>}
            </div>

            {/* Operator Fault Injection Actions */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-slate-400 font-mono uppercase mr-1 hidden sm:inline">Fault Sim:</span>
              <button
                onClick={() => handleTriggerFault('storm-surge')}
                disabled={!canOperate}
                className="px-2 py-1 text-xs font-mono font-medium rounded bg-[#2a0e16] hover:bg-[#3d1320] text-rose-200 border border-rose-800/80 transition flex items-center gap-1"
                title="Inject Storm Surge: High water level, peak outflow"
              >
                <Flame className="w-3.5 h-3.5 text-rose-400" />
                Storm Surge
              </button>
              <button
                onClick={() => handleTriggerFault('intake-blockage')}
                disabled={!canOperate}
                className="px-2 py-1 text-xs font-mono font-medium rounded bg-[#2a1c07] hover:bg-[#3d290a] text-amber-200 border border-amber-800/80 transition flex items-center gap-1"
                title="Inject Intake Blockage: High water level, collapsed outflow, cavitation"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                Blockage
              </button>
              <button
                onClick={() => handleTriggerFault('motor-overload')}
                disabled={!canOperate}
                className="px-2 py-1 text-xs font-mono font-medium rounded bg-[#1e0f30] hover:bg-[#2b1545] text-purple-200 border border-purple-800/80 transition flex items-center gap-1"
                title="Inject Motor Overload: Severe vibration, electrical overcurrent"
              >
                <Zap className="w-3.5 h-3.5 text-purple-400" />
                Overload
              </button>
              <button
                onClick={() => handleClearFault()}
                disabled={!canOperate}
                className="px-2.5 py-1 text-xs font-mono font-medium rounded bg-[#172033] hover:bg-[#202d47] text-slate-200 border border-slate-700 transition"
                title="Clear all active faults on this station"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Fault Notice Notification */}
          {historyError && (
            <div role="alert" className="flex items-center justify-between gap-2 rounded border border-amber-800 bg-[#271b05] p-2 text-xs font-mono text-amber-200">
              <span>{historyError}</span>
              <button className="underline" onClick={() => seriesState.isHistoricalLocked ? shiftHistoricalWindow(0) : returnToLive()}>Retry</button>
            </div>
          )}
          {faultActionNotice && (
            <div role="status" className="bg-[#0b192e] border border-sky-700/80 text-sky-200 px-3 py-1 rounded text-xs font-mono flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-400" />
              <span>{faultActionNotice}</span>
            </div>
          )}

          {/* 4 Calibrated SCADA Metric Cards with ISA Threshold Indicators */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {/* Card 1: Water Level */}
            <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1 font-mono">
                  <span className="flex items-center gap-1">
                    <Droplets className="w-3.5 h-3.5 text-sky-400" />
                    Water Level
                  </span>
                  <span className="text-[10px] text-slate-400">Warn &gt;3.0m</span>
                </div>
                <div className="text-xl sm:text-2xl font-bold font-mono text-sky-400 tabular-nums">
                  {metricsSummary.waterLevel?.current?.toFixed(2) ?? '--'} <span className="text-xs font-normal text-slate-400">m</span>
                </div>
              </div>
              <div className="mt-2">
                {/* Engineering Calibrated Level Bar */}
                <div className="w-full bg-[#070b12] h-2 rounded border border-[#172033] overflow-hidden flex">
                  <div
                    className="h-full bg-sky-500 transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(3, ((metricsSummary.waterLevel?.current || 0) / 4.5) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1 tabular-nums">
                  <span>Min {metricsSummary.waterLevel?.min?.toFixed(2)}m</span>
                  <span>Max {metricsSummary.waterLevel?.max?.toFixed(2)}m</span>
                </div>
              </div>
            </div>

            {/* Card 2: Outflow */}
            <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1 font-mono">
                  <span className="flex items-center gap-1">
                    <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                    Discharge Flow
                  </span>
                  <span className="text-[10px] text-slate-400">Cap {currentStation.ratedCapacity}</span>
                </div>
                <div className="text-xl sm:text-2xl font-bold font-mono text-emerald-400 tabular-nums">
                  {metricsSummary.outflow?.current?.toFixed(0) ?? '--'} <span className="text-xs font-normal text-slate-400">L/s</span>
                </div>
              </div>
              <div className="mt-2">
                {/* Engineering Calibrated Flow Bar */}
                <div className="w-full bg-[#070b12] h-2 rounded border border-[#172033] overflow-hidden flex">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(3, ((metricsSummary.outflow?.current || 0) / currentStation.ratedCapacity) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1 tabular-nums">
                  <span>Min {metricsSummary.outflow?.min?.toFixed(0)}L/s</span>
                  <span>Max {metricsSummary.outflow?.max?.toFixed(0)}L/s</span>
                </div>
              </div>
            </div>

            {/* Card 3: Vibration (ISO 10816 Standard) */}
            <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1 font-mono">
                  <span className="flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                    Vibration (RMS)
                  </span>
                  <span className="text-[10px] text-slate-400">Crit &gt;7.1</span>
                </div>
                <div className="text-xl sm:text-2xl font-bold font-mono text-amber-400 tabular-nums">
                  {metricsSummary.vibration?.current?.toFixed(2) ?? '--'} <span className="text-xs font-normal text-slate-400">mm/s</span>
                </div>
              </div>
              <div className="mt-2">
                {/* ISO 10816 3-Zone Segment Gauge */}
                <div className="w-full bg-[#070b12] h-2 rounded border border-[#172033] overflow-hidden flex">
                  <div className="w-[38%] bg-emerald-600/40 border-r border-[#1e293b]" title="Zone A/B: Normal" />
                  <div className="w-[28%] bg-amber-600/40 border-r border-[#1e293b]" title="Zone C: Warning" />
                  <div className="w-[34%] bg-rose-600/40" title="Zone D: Critical" />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1 tabular-nums">
                  <span>Min {metricsSummary.vibration?.min?.toFixed(1)}</span>
                  <span>Max {metricsSummary.vibration?.max?.toFixed(1)}</span>
                </div>
              </div>
            </div>

            {/* Card 4: Motor Current */}
            <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1 font-mono">
                  <span className="flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5 text-purple-400" />
                    Motor Current
                  </span>
                  <span className="text-[10px] text-slate-400">Crit &gt;105A</span>
                </div>
                <div className="text-xl sm:text-2xl font-bold font-mono text-purple-400 tabular-nums">
                  {metricsSummary.current?.current?.toFixed(1) ?? '--'} <span className="text-xs font-normal text-slate-400">A</span>
                </div>
              </div>
              <div className="mt-2">
                {/* Motor Amperage Capacity Bar */}
                <div className="w-full bg-[#070b12] h-2 rounded border border-[#172033] overflow-hidden flex">
                  <div
                    className="h-full bg-purple-500 transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(3, ((metricsSummary.current?.current || 0) / 125) * 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-400 mt-1 tabular-nums">
                  <span>Min {metricsSummary.current?.min?.toFixed(0)}A</span>
                  <span>Max {metricsSummary.current?.max?.toFixed(0)}A</span>
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
          <div className="bg-[#0b101b] border border-[#1e293b] rounded p-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2 pb-1.5 border-b border-[#172033]">
              <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                Incident Timeline & Alarm History
              </h2>
              <select aria-label="Filter incidents by station" className="rounded border border-[#1e293b] bg-[#070b12] px-2 py-0.5 text-xs font-mono text-slate-300"
                value={incidentFilter} onChange={event => setIncidentFilter(event.target.value)}>
                <option value="all">All stations</option>
                <option value="station">Selected station</option>
              </select>
            </div>

            {visibleIncidents.length === 0 ? (
              <div className="text-xs text-slate-400 font-mono py-2.5 text-center">
                No incidents in this view.
              </div>
            ) : (
              <div className="space-y-1.5">
                {visibleIncidents.map((inc) => {
                  const durationSec = Math.round(((inc.endTime || Date.now()) - inc.startTime) / 1000);
                  const isCrit = inc.severity === 'critical';

                  return (
                    <div
                      key={inc.incidentId}
                      className={`p-2 rounded border transition flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                        isCrit
                          ? 'bg-[#21090f] border-rose-900/60 hover:bg-[#2e0d15]'
                          : 'bg-[#201405] border-amber-900/60 hover:bg-[#2d1c07]'
                      }`}
                    >
                      <div className="cursor-pointer" onClick={() => openIncidentReplay(inc)}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.2 rounded border ${
                              isCrit ? 'bg-rose-900 text-rose-200 border-rose-700' : 'bg-amber-900 text-amber-200 border-amber-700'
                            }`}
                          >
                            {inc.severity}
                          </span>
                          <span className="text-xs font-mono font-semibold text-slate-100 capitalize">
                            {inc.stationId.replace('-', ' ')}
                          </span>
                          <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                            {new Date(inc.startTime).toLocaleTimeString()}
                          </span>
                          <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                            ({durationSec}s duration)
                          </span>
                          <span className={`text-[10px] px-1.5 rounded border font-mono ${inc.resolved
                            ? 'text-emerald-400 bg-emerald-950/60 border-emerald-800'
                            : 'text-amber-300 bg-amber-950/60 border-amber-800'}`}>
                            {inc.resolved ? 'Resolved' : 'Active'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-300 font-mono mt-0.5">
                          {inc.reasons?.[0] || 'Anomalous telemetry conditions detected'}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 self-end sm:self-center">
                        <a
                          href={`/api/incidents/${encodeURIComponent(inc.incidentId)}/export`}
                          download
                          className="px-2 py-1 bg-[#172033] hover:bg-[#222f4b] text-slate-300 rounded text-xs font-mono border border-slate-700 transition flex items-center gap-1"
                          title="Export incident telemetry as CSV"
                        >
                          <Download className="w-3 h-3 text-sky-400" />
                          <span>CSV</span>
                        </a>
                        <button
                          onClick={() => openIncidentReplay(inc)}
                          className="px-2.5 py-1 bg-[#0284c7] hover:bg-[#0369a1] text-white rounded text-xs font-mono font-medium transition flex items-center gap-1"
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
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-[#0b101b] border border-[#1e293b] rounded max-w-lg w-full p-4 shadow-xl relative">
            <button
              onClick={() => setShowDiagnostics(false)}
              aria-label="Close diagnostics"
              className="absolute top-3.5 right-3.5 text-slate-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>

            <h3 className="text-sm font-mono font-bold text-slate-100 flex items-center gap-2 mb-3 pb-2 border-b border-[#1e293b]">
              <Activity className="w-4 h-4 text-sky-400" />
              Stream Diagnostics & Handshake Protocol
            </h3>

            <div className="space-y-2 text-xs font-mono bg-[#070b12] p-3 rounded border border-[#172033] text-slate-300 tabular-nums">
              <div className="flex justify-between">
                <span className="text-slate-400">Connection State:</span>
                <span className="font-bold text-emerald-400 uppercase">{connectionStatus}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Socket ID:</span>
                <span>{socketId || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Subscribed Room:</span>
                <span className="text-sky-400 font-bold">station:{selectedStationId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Latest Cursor Seq:</span>
                <span className="text-purple-400 font-bold">#{seriesState.cursorSeq}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Buffered Sync Packets:</span>
                <span>{seriesState.bufferedCount} pkts</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Active Viewport Points:</span>
                <span>{seriesState.points.length} samples</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Ingest Queue Backpressure:</span>
                <span className="text-emerald-400 font-bold">{fleetSummary.metrics?.queueLength || 0} / 16,000</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Client Repaint Rate:</span>
                <span className="text-sky-400 font-bold">4 Hz (250ms throttled)</span>
              </div>
            </div>

            {/* Test Reconnect Action */}
            <div className="mt-3.5 pt-2.5 border-t border-[#1e293b] flex items-center justify-between">
              <p className="text-[11px] text-slate-400 font-mono">
                Simulates transport drop and tests monotonic sequence recovery.
              </p>
              <button
                onClick={testReconnect}
                className="px-3 py-1 bg-[#0284c7] hover:bg-[#0369a1] text-white rounded text-xs font-mono font-bold transition flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Test Reconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="bg-[#070b12] border-t border-[#1e293b] px-4 py-2 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2 font-mono break-words overflow-hidden">
        <div className="break-words">
          FLOODLINE SCADA Telemetry Console • High-Throughput Streams & Catchment Management
        </div>
        <div className="break-words">
          MongoDB Community 8.0 • 6 Distributed Pump Stations • Monotonic Cursor Handshake
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
  return <main className="min-h-screen grid place-items-center px-4 bg-[#070b12] text-slate-200">
    <form className="w-full max-w-sm rounded border border-[#1e293b] bg-[#0b101b] p-6 space-y-4 font-mono shadow-md" onSubmit={submit}>
      <div className="flex items-center gap-2 border-b border-[#1e293b] pb-3">
        <div className="w-6 h-6 rounded bg-[#131b2e] border border-sky-500/40 text-sky-400 text-xs flex items-center justify-center font-bold">
          FL
        </div>
        <h1 className="text-base font-bold text-slate-100">Sign in to Floodline SCADA</h1>
      </div>
      <label className="block text-xs text-slate-300">Username
        <input className="block w-full mt-1 rounded bg-[#070b12] border border-[#1e293b] p-2 text-sm text-slate-100" name="username" autoComplete="username" required />
      </label>
      <label className="block text-xs text-slate-300">Password
        <input className="block w-full mt-1 rounded bg-[#070b12] border border-[#1e293b] p-2 text-sm text-slate-100" name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p role="alert" className="text-rose-400 text-xs">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded bg-[#0284c7] hover:bg-[#0369a1] px-4 py-2 text-xs font-bold text-white transition disabled:opacity-50">
        {busy ? 'Authenticating…' : 'Authenticate Session'}
      </button>
    </form>
  </main>;
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<FloodlineApp />);
}
