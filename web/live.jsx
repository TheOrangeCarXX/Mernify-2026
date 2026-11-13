/**
 * Floodline - Real-Time Socket.IO Hook & Stream Lifecycle Manager
 * Handles station room subscriptions, cursor handshakes, MongoDB history integration,
 * packet deduplication, fleet health broadcasts, and reconnect backfill.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { MAX_FUTURE_SKEW_MS } from '../shared/telemetry.mjs';
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
  const [historyError, setHistoryError] = useState(null);

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
  const [sessionChecked, setSessionChecked] = useState(false);

  const socketRef = useRef(null);
  const selectedStationRef = useRef(defaultStationId);
  const historyRequest = useRef(null);
  const subscriptionVersion = useRef(0);
  const historyRetry = useRef(null);
  const reconnectTimer = useRef(null);
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
      } else setCurrentUser(null);
    } catch {
      setCurrentUser(null);
    } finally {
      setSessionChecked(true);
    }
  }, []);

  const signIn = useCallback(async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not sign in.');
    setCurrentUser(data.user);
  }, []);

  const signOut = useCallback(async () => {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (!res.ok) throw new Error('Could not sign out.');
    await refreshUser();
  }, [refreshUser]);

  // Fetch incidents list
  const getLatestIncidents = useCallback(async (signal) => {
    const response = await fetch('/api/incidents', { signal });
    if (!response.ok) throw new Error('Could not read the incident archive.');
    return (await response.json()).incidents || [];
  }, []);

  const refreshIncidents = useCallback(async (signal) => {
    try {
      const latest = await getLatestIncidents(signal);
      if (!signal?.aborted) setIncidents(latest);
    } catch (e) {
      if (!signal?.aborted) console.warn('Failed to fetch incidents', e);
    }
  }, [getLatestIncidents]);

  // Fetch Historical Telemetry and merge with live cursor
  const fetchAndMergeHistory = useCallback(async (stationId, { from, to }, cursorSeq) => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryError(null);
    const maxPoints = 600;
    const bucketMs = Math.max(1, Math.ceil((to - from) / (maxPoints - 1)));
    if (cursorSeq !== undefined) seriesManager.setLiveResolution(bucketMs, from);
    try {
      const params = new URLSearchParams({ from, to, maxPoints, bucketMs });
      if (cursorSeq !== undefined) params.set('beforeSeq', cursorSeq);
      const res = await fetch(`/api/stations/${stationId}/history?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!controller.signal.aborted) {
        seriesManager.applyHistory(data.readings || []);
        if (cursorSeq !== undefined) setConnectionStatus('connected');
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[Live Stream] Failed to load history:', err);
      seriesManager.applyHistory([]);
      setHistoryError('Could not load the selected history window.');
      if (cursorSeq !== undefined) setConnectionStatus('history unavailable');
    }
  }, [seriesManager]);

  // Subscribe to station room
  const subscribeToStation = useCallback((stationId) => {
    historyRequest.current?.abort();
    clearTimeout(historyRetry.current);
    historyRetry.current = null;
    const version = ++subscriptionVersion.current;
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;

    setConnectionStatus('syncing');
    socket.timeout(5000).emit('subscribe:station', { stationId }, (error, ack) => {
      if (version !== subscriptionVersion.current || !socket.connected) return;
      if (error || ack?.error) {
        setConnectionStatus('history unavailable');
        setHistoryError(ack?.error || 'Station subscription timed out.');
      } else if (ack) {
        seriesManager.startStationSubscription(stationId, ack.latestSeq);
        const from = ack.serverTime - WINDOW_PRESETS[seriesManager.windowPreset];
        const to = ack.serverTime + MAX_FUTURE_SKEW_MS;
        fetchAndMergeHistory(stationId, { from, to }, ack.latestSeq);
      }
    });
  }, [seriesManager, fetchAndMergeHistory]);

  // Setup Socket.IO connection
  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    if (!currentUser) return;
    const dashboardRequests = new AbortController();
    void refreshIncidents(dashboardRequests.signal);

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
      if (!seriesManager.isHistoricalLocked) subscribeToStation(selectedStationRef.current);
    });

    socket.on('disconnect', reason => {
      subscriptionVersion.current++;
      if (!seriesManager.isHistoricalLocked) historyRequest.current?.abort();
      setConnectionStatus('disconnected');
      if (reason === 'io server disconnect') void refreshUser();
    });

    socket.on('connect_error', () => setConnectionStatus('disconnected'));

    // Ingest compacted batch packets
    socket.on('telemetry:batch', (batch) => {
      if (!seriesManager.ingestLive(batch) && !historyRetry.current) {
        historyRequest.current?.abort();
        historyRetry.current = setTimeout(() => {
          historyRetry.current = null;
          if (!seriesManager.isHistoricalLocked) subscribeToStation(selectedStationRef.current);
        }, 250);
      }
    });

    // Fleet Summary updates
    socket.on('fleet:summary', (data) => {
      if (data) {
        setFleetSummary(data);
      }
    });

    const incidentTimer = setInterval(() => void refreshIncidents(dashboardRequests.signal), 3000);
    return () => {
      dashboardRequests.abort();
      clearInterval(incidentTimer);
      clearTimeout(reconnectTimer.current);
      clearTimeout(historyRetry.current);
      historyRetry.current = null;
      historyRequest.current?.abort();
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnectionStatus('disconnected');
    };
  }, [currentUser, refreshIncidents, refreshUser, seriesManager, subscribeToStation]);

  // Handle station change
  const selectStation = useCallback((newStationId) => {
    if (newStationId === selectedStationRef.current) return;
    selectedStationRef.current = newStationId;
    setSelectedStationId(newStationId);
    seriesManager.returnToLive();
    subscribeToStation(newStationId);
  }, [seriesManager, subscribeToStation]);

  // Change window preset (1m, 5m, 15m, 1h)
  const setWindowPreset = useCallback((preset) => {
    seriesManager.setWindowPreset(preset);
    // Reload history to match new duration
    subscribeToStation(selectedStationRef.current);
  }, [seriesManager, subscribeToStation]);

  // Historical Incident Replay
  const openIncidentReplay = useCallback((incident) => {
    selectedStationRef.current = incident.stationId;
    setSelectedStationId(incident.stationId);
    subscriptionVersion.current++;
    if (socketRef.current?.connected) socketRef.current.emit('unsubscribe:station');

    const padMs = 60 * 1000;
    const from = incident.startTime - padMs;
    const to = (incident.endTime || Date.now()) + padMs;

    seriesManager.setHistoricalWindow(from, to);
    seriesManager.startStationSubscription(incident.stationId, 0);
    return fetchAndMergeHistory(incident.stationId, { from, to });
  }, [seriesManager, fetchAndMergeHistory]);

  const returnToLive = useCallback((stationId = selectedStationRef.current) => {
    selectedStationRef.current = stationId;
    setSelectedStationId(stationId);
    seriesManager.returnToLive();
    subscribeToStation(stationId);
  }, [seriesManager, subscribeToStation]);

  const shiftHistoricalWindow = useCallback((offsetMs) => {
    seriesManager.moveHistoricalWindow(offsetMs);
    if (seriesManager.historicalRange) {
      const { from, to } = seriesManager.historicalRange;
      seriesManager.startStationSubscription(selectedStationRef.current, 0);
      fetchAndMergeHistory(selectedStationRef.current, { from, to });
    }
  }, [seriesManager, fetchAndMergeHistory]);

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

  // Adjust simulator throughput rate
  const changeSimulatorRate = useCallback(async (rate) => {
    try {
      const res = await fetch('/api/simulator/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate })
      });
      return await res.json();
    } catch (e) {
      console.error('Failed to change simulator rate', e);
    }
  }, []);

  // Diagnostic Test: Disconnect & Reconnect
  const testReconnect = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      clearTimeout(reconnectTimer.current);
      socket.disconnect();
      setConnectionStatus('disconnected');
      reconnectTimer.current = setTimeout(() => {
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
    sessionChecked,
    signIn,
    signOut,
    seriesState,
    historyError,
    fleetSummary,
    incidents,
    metricsSummary: seriesManager.getMetricsSummary(),
    setWindowPreset,
    openIncidentReplay,
    returnToLive,
    shiftHistoricalWindow,
    triggerFault,
    clearFault,
    changeSimulatorRate,
    testReconnect,
    getLatestIncidents
  };
}
