/**
 * Floodline - Real-Time Socket.IO Hook & Stream Lifecycle Manager
 * Handles station room subscriptions, cursor handshakes, MongoDB history integration,
 * packet deduplication, fleet health broadcasts, and reconnect backfill.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { TelemetrySeriesManager, WINDOW_PRESETS } from './series.mjs';

export function useTelemetryStream({ defaultStationId = 'canal-junction' } = {}) {
  const [selectedStationId, setSelectedStationId] = useState(defaultStationId);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connecting, connected, disconnected
  const [socketId, setSocketId] = useState(null);
  const [seriesState, setSeriesState] = useState({
    points: [],
    windowPreset: '5m',
    isHistoricalLocked: false,
    historicalRange: null,
    cursorSeq: 0,
    bufferedCount: 0,
    isLoadingHistory: false
  });

  const [fleetSummary, setFleetSummary] = useState({
    stations: [],
    activeFaults: [],
    metrics: {
      throughputEventsSec: 0,
      persistedSec: 0,
      broadcastSec: 0,
      queueLength: 0,
      connectedClients: 1
    }
  });

  const [incidents, setIncidents] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);

  const socketRef = useRef(null);
  const seriesManagerRef = useRef(null);

  // Initialize Series Manager
  if (!seriesManagerRef.current) {
    seriesManagerRef.current = new TelemetrySeriesManager({
      onUpdate: (state) => {
        setSeriesState({ ...state });
      }
    });
  }

  const seriesManager = seriesManagerRef.current;

  // Refresh user session
  const refreshUser = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        setCurrentUser(data.user);
      } else {
        setCurrentUser({ username: 'guest-operator', role: 'operator', displayName: 'Operator (Demo)' });
      }
    } catch {
      setCurrentUser({ username: 'local-operator', role: 'operator', displayName: 'Local Operator' });
    }
  }, []);

  // Fetch incidents list
  const refreshIncidents = useCallback(async () => {
    try {
      const res = await fetch('/api/incidents');
      if (res.ok) {
        const data = await res.json();
        setIncidents(data.incidents || []);
      }
    } catch (e) {
      console.warn('Failed to fetch incidents', e);
    }
  }, []);

  // Fetch Historical Telemetry and merge with live cursor
  const fetchAndMergeHistory = useCallback(async (stationId, cursorSeq, preset = '5m') => {
    const durationMs = WINDOW_PRESETS[preset] || (5 * 60 * 1000);
    const to = Date.now();
    const from = to - durationMs;

    try {
      const url = `/api/stations/${stationId}/history?from=${from}&to=${to}&beforeSeq=${cursorSeq}&maxPoints=600`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      seriesManager.applyHistory(data.readings || []);
    } catch (err) {
      console.error('[Live Stream] Failed to load history:', err);
      seriesManager.applyHistory([]); // Fallback to live stream only
    }
  }, [seriesManager]);

  // Subscribe to station room
  const subscribeToStation = useCallback((stationId) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;

    socket.emit('subscribe:station', { stationId }, (ack) => {
      if (ack && !ack.error) {
        seriesManager.startStationSubscription(stationId, ack.latestSeq);
        fetchAndMergeHistory(stationId, ack.latestSeq, seriesManager.windowPreset);
      }
    });
  }, [seriesManager, fetchAndMergeHistory]);

  // Setup Socket.IO connection
  useEffect(() => {
    refreshUser();
    refreshIncidents();

    const socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnectionStatus('connected');
      setSocketId(socket.id);
      subscribeToStation(selectedStationId);
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    // Ingest compacted batch packets
    socket.on('telemetry:batch', (batch) => {
      seriesManager.ingestLive(batch);
    });

    // Fleet Summary updates
    socket.on('fleet:summary', (data) => {
      if (data) {
        setFleetSummary(data);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Handle station change
  const selectStation = useCallback((newStationId) => {
    if (newStationId === selectedStationId) return;
    setSelectedStationId(newStationId);
    subscribeToStation(newStationId);
  }, [selectedStationId, subscribeToStation]);

  // Change window preset (1m, 5m, 15m, 1h)
  const setWindowPreset = useCallback((preset) => {
    seriesManager.setWindowPreset(preset);
    // Reload history to match new duration
    if (socketRef.current?.connected) {
      fetchAndMergeHistory(selectedStationId, seriesManager.cursorSeq, preset);
    }
  }, [seriesManager, selectedStationId, fetchAndMergeHistory]);

  // Historical Incident Replay
  const openIncidentReplay = useCallback(async (incident) => {
    setSelectedStationId(incident.stationId);
    subscribeToStation(incident.stationId);

    const padMs = 60 * 1000;
    const from = incident.startTime - padMs;
    const to = (incident.endTime || Date.now()) + padMs;

    seriesManager.setHistoricalWindow(from, to);

    try {
      const url = `/api/stations/${incident.stationId}/history?from=${from}&to=${to}&maxPoints=800`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        seriesManager.applyHistory(data.readings || []);
      }
    } catch (e) {
      console.error('Failed to load incident history', e);
    }
  }, [seriesManager, subscribeToStation]);

  const returnToLive = useCallback(() => {
    seriesManager.returnToLive();
    subscribeToStation(selectedStationId);
  }, [seriesManager, selectedStationId, subscribeToStation]);

  const shiftHistoricalWindow = useCallback((offsetMs) => {
    seriesManager.moveHistoricalWindow(offsetMs);
    if (seriesManager.historicalRange) {
      const { from, to } = seriesManager.historicalRange;
      fetch(`/api/stations/${selectedStationId}/history?from=${from}&to=${to}&maxPoints=800`)
        .then(r => r.json())
        .then(data => seriesManager.applyHistory(data.readings || []))
        .catch(console.error);
    }
  }, [seriesManager, selectedStationId]);

  // Trigger Fault
  const triggerFault = useCallback(async (stationId, type, durationSeconds = 60) => {
    try {
      const res = await fetch('/api/faults/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId, type, durationSeconds })
      });
      const data = await res.json();
      refreshIncidents();
      return data;
    } catch (err) {
      console.error('Trigger fault error', err);
    }
  }, [refreshIncidents]);

  // Clear Fault
  const clearFault = useCallback(async (stationId) => {
    try {
      const res = await fetch('/api/faults/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId })
      });
      const data = await res.json();
      refreshIncidents();
      return data;
    } catch (err) {
      console.error('Clear fault error', err);
    }
  }, [refreshIncidents]);

  // Diagnostic Test: Disconnect & Reconnect
  const testReconnect = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      socket.disconnect();
      setConnectionStatus('disconnected');
      setTimeout(() => {
        socket.connect();
      }, 1500);
    }
  }, []);

  return {
    selectedStationId,
    selectStation,
    connectionStatus,
    socketId,
    currentUser,
    seriesState,
    fleetSummary,
    incidents,
    metricsSummary: seriesManager.getMetricsSummary(),
    setWindowPreset,
    openIncidentReplay,
    returnToLive,
    shiftHistoricalWindow,
    triggerFault,
    clearFault,
    testReconnect,
    refreshIncidents
  };
}
