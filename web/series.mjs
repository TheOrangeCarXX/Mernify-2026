/**
 * Floodline - Series Manager: Time-Bucket Merging, Cursor Synchronization, and Window Pruning
 */

import { unpackReading } from '../shared/telemetry.mjs';

export const WINDOW_PRESETS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000
};

export class TelemetrySeriesManager {
  constructor({ maxBufferSize = 5000, onUpdate = null } = {}) {
    this.maxBufferSize = maxBufferSize;
    this.onUpdate = onUpdate;

    // Active state
    this.stationId = null;
    this.cursorSeq = 0;
    this.isLoadingHistory = false;
    this.bufferedPackets = [];
    this.seenEventIds = new Set();
    this.seenSeqs = new Set();

    // Data points currently in window: sorted by timestamp
    this.points = [];

    // Window configuration
    this.windowPreset = '5m';
    this.windowDurationMs = WINDOW_PRESETS['5m'];
    this.isHistoricalLocked = false;
    this.historicalRange = null; // { from, to }

    // Throttle rendering updates to at most 4 Hz (250 ms)
    this.renderThrottled = false;
    this.pendingRender = false;
    this.throttleMs = 250;
  }

  setWindowPreset(preset) {
    if (WINDOW_PRESETS[preset]) {
      this.windowPreset = preset;
      this.windowDurationMs = WINDOW_PRESETS[preset];
      this.isHistoricalLocked = false;
      this.historicalRange = null;
      this._pruneWindow();
      this._triggerUpdate();
    }
  }

  setHistoricalWindow(from, to) {
    this.isHistoricalLocked = true;
    this.historicalRange = { from, to };
    this._triggerUpdate();
  }

  returnToLive() {
    this.isHistoricalLocked = false;
    this.historicalRange = null;
    this._pruneWindow();
    this._triggerUpdate();
  }

  moveHistoricalWindow(offsetMs) {
    if (this.historicalRange) {
      this.historicalRange.from += offsetMs;
      this.historicalRange.to += offsetMs;
      this._triggerUpdate();
    }
  }

  startStationSubscription(stationId, latestSeq) {
    this.stationId = stationId;
    this.cursorSeq = latestSeq || 0;
    this.isLoadingHistory = true;
    this.bufferedPackets = [];
    this.seenEventIds.clear();
    this.seenSeqs.clear();
    this.points = [];
    this._triggerUpdate();
  }

  applyHistory(historyReadings) {
    this.isLoadingHistory = false;
    this.points = [];
    this.seenEventIds.clear();
    this.seenSeqs.clear();

    for (const item of historyReadings) {
      const reading = unpackReading(item);
      if (reading.eventId) this.seenEventIds.add(reading.eventId);
      if (reading.seq != null) this.seenSeqs.add(reading.seq);
      this.points.push(reading);
    }

    // Sort points by timestamp ascending
    this.points.sort((a, b) => a.timestamp - b.timestamp);

    // Apply any buffered live packets that arrived during history fetch
    if (this.bufferedPackets.length > 0) {
      for (const pkt of this.bufferedPackets) {
        this._insertLiveReading(pkt, true);
      }
      this.bufferedPackets = [];
    }

    this._pruneWindow();
    this._triggerUpdate();
  }

  /**
   * Ingest incoming live packet or batch from Socket.IO
   */
  ingestLive(batchOrRow) {
    const rows = Array.isArray(batchOrRow[0]) ? batchOrRow : [batchOrRow];

    for (const row of rows) {
      const reading = unpackReading(row);

      // Verify packet belongs to currently active station
      if (reading.stationId !== this.stationId) continue;

      if (this.isLoadingHistory) {
        // While waiting for history API to resolve, buffer incoming packets
        if (this.bufferedPackets.length < this.maxBufferSize) {
          this.bufferedPackets.push(reading);
        }
      } else {
        this._insertLiveReading(reading, false);
      }
    }

    this._requestRender();
  }

  _insertLiveReading(reading, fromBuffer = false) {
    // Deduplication check: ignore if eventId or seq already committed
    if (reading.eventId && this.seenEventIds.has(reading.eventId)) return;
    if (reading.seq && this.seenSeqs.has(reading.seq)) return;

    // Check if packet sequence is newer than the cursor sequence
    if (fromBuffer && reading.seq <= this.cursorSeq) {
      return;
    }

    if (reading.eventId) this.seenEventIds.add(reading.eventId);
    if (reading.seq) {
      this.seenSeqs.add(reading.seq);
      if (reading.seq > this.cursorSeq) this.cursorSeq = reading.seq;
    }

    // Append to points
    this.points.push(reading);

    // Bound seen sets to avoid memory leaks
    if (this.seenEventIds.size > 20000) {
      this.seenEventIds.clear();
      this.seenSeqs.clear();
      for (const p of this.points) {
        if (p.eventId) this.seenEventIds.add(p.eventId);
        if (p.seq) this.seenSeqs.add(p.seq);
      }
    }
  }

  _pruneWindow() {
    if (this.isHistoricalLocked) return; // Do not prune in fixed historical replay mode

    const cutoff = Date.now() - this.windowDurationMs;
    // Find index of first point within cutoff
    let firstValidIdx = 0;
    while (firstValidIdx < this.points.length && this.points[firstValidIdx].timestamp < cutoff) {
      firstValidIdx++;
    }

    if (firstValidIdx > 0) {
      this.points = this.points.slice(firstValidIdx);
    }
  }

  _requestRender() {
    if (this.renderThrottled) {
      this.pendingRender = true;
      return;
    }

    this._triggerUpdate();
    this.renderThrottled = true;

    setTimeout(() => {
      this.renderThrottled = false;
      if (this.pendingRender) {
        this.pendingRender = false;
        this._triggerUpdate();
      }
    }, this.throttleMs);
  }

  _triggerUpdate() {
    this._pruneWindow();
    if (typeof this.onUpdate === 'function') {
      this.onUpdate({
        stationId: this.stationId,
        points: this.points,
        windowPreset: this.windowPreset,
        isHistoricalLocked: this.isHistoricalLocked,
        historicalRange: this.historicalRange,
        cursorSeq: this.cursorSeq,
        bufferedCount: this.bufferedPackets.length,
        isLoadingHistory: this.isLoadingHistory
      });
    }
  }

  getMetricsSummary() {
    if (this.points.length === 0) {
      return {
        waterLevel: { current: 0, min: 0, max: 0 },
        outflow: { current: 0, min: 0, max: 0 },
        vibration: { current: 0, min: 0, max: 0 },
        current: { current: 0, min: 0, max: 0 }
      };
    }

    const latest = this.points[this.points.length - 1].metrics;
    let minW = latest.waterLevel, maxW = latest.waterLevel;
    let minO = latest.outflow, maxO = latest.outflow;
    let minV = latest.vibration, maxV = latest.vibration;
    let minC = latest.current, maxC = latest.current;

    for (const p of this.points) {
      const m = p.metrics;
      if (m.waterLevel < minW) minW = m.waterLevel;
      if (m.waterLevel > maxW) maxW = m.waterLevel;
      if (m.outflow < minO) minO = m.outflow;
      if (m.outflow > maxO) maxO = m.outflow;
      if (m.vibration < minV) minV = m.vibration;
      if (m.vibration > maxV) maxV = m.vibration;
      if (m.current < minC) minC = m.current;
      if (m.current > maxC) maxC = m.current;
    }

    return {
      waterLevel: { current: latest.waterLevel, min: minW, max: maxW },
      outflow: { current: latest.outflow, min: minO, max: maxO },
      vibration: { current: latest.vibration, min: minV, max: maxV },
      current: { current: latest.current, min: minC, max: maxC }
    };
  }
}
