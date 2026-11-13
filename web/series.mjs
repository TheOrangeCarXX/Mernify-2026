/**
 * Floodline - Series Manager: Time-Bucket Merging, Cursor Synchronization, and Window Pruning
 */

import { unpackReading } from '../shared/telemetry.mjs';
const SEVERITY_RANK = { normal: 0, warning: 1, critical: 2 };

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
    this.historyCursorSeq = 0;
    this.isLoadingHistory = false;
    this.bufferedPackets = [];
    this.seenEventIds = new Set();
    this.seenSeqs = new Set();

    // Data points currently in window: sorted by timestamp
    this.points = [];
    this.liveBucketMs = 0;
    this.bucketOrigin = 0;
    this.liveBuckets = new Map();

    // Window configuration
    this.windowPreset = '5m';
    this.windowDurationMs = WINDOW_PRESETS['5m'];
    this.isHistoricalLocked = false;
    this.historicalRange = null; // { from, to }
    this.latestReading = null;

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
    this.historyCursorSeq = this.cursorSeq;
    this.isLoadingHistory = true;
    this.bufferedPackets = [];
    this.seenEventIds.clear();
    this.seenSeqs.clear();
    this.points = [];
    this.liveBuckets.clear();
    this.liveBucketMs = 0;
    this.latestReading = null;
    this._triggerUpdate();
  }

  setLiveResolution(bucketMs, origin) {
    this.liveBucketMs = bucketMs;
    this.bucketOrigin = origin;
  }

  applyHistory(historyReadings) {
    this.isLoadingHistory = false;
    this.points = [];
    this.seenEventIds.clear();
    this.seenSeqs.clear();

    for (const item of historyReadings) {
      const reading = unpackReading(item);
      this._updateLatest(reading.last ?? reading);
      if (reading.eventId) this.seenEventIds.add(reading.eventId);
      if (reading.seq != null) this.seenSeqs.add(reading.seq);
      if (this.liveBucketMs && reading.isBucket) {
        this.liveBuckets.set(reading.timestamp, {
          ...reading,
          metrics: { ...reading.metrics },
          min: { ...reading.min ?? reading.metrics },
          max: { ...reading.max ?? reading.metrics }
        });
      } else {
        this.points.push(reading);
      }
    }

    // Sort points by timestamp ascending
    this.points.sort((a, b) => a.timestamp - b.timestamp);

    // Apply any buffered live packets that arrived during history fetch
    if (this.bufferedPackets.length > 0) {
      for (const pkt of this.bufferedPackets) {
        this._insertLiveReading(pkt);
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
    if (this.isHistoricalLocked || (Array.isArray(batchOrRow) && batchOrRow.length === 0)) return true;
    const rows = Array.isArray(batchOrRow[0]) ? batchOrRow : [batchOrRow];

    for (const row of rows) {
      const reading = unpackReading(row);

      // Verify packet belongs to currently active station
      if (reading.stationId !== this.stationId) continue;

      if (this.isLoadingHistory) {
        if (reading.seq <= this.historyCursorSeq) continue;
        if (this.bufferedPackets.length >= this.maxBufferSize) return false;
        this.bufferedPackets.push(reading);
      } else {
        this._insertLiveReading(reading);
      }
    }

    this._requestRender();
    return true;
  }

  _insertLiveReading(reading) {
    // Deduplication check: ignore if eventId or seq already committed
    if (reading.eventId && this.seenEventIds.has(reading.eventId)) return;
    if (reading.seq && this.seenSeqs.has(reading.seq)) return;

    // Check if packet sequence is newer than the cursor sequence
    if (reading.seq <= this.historyCursorSeq) {
      return;
    }

    if (this.liveBucketMs && !this.isHistoricalLocked) {
      this._aggregateLiveReading(reading);
      return;
    }

    if (reading.eventId) this.seenEventIds.add(reading.eventId);
    if (reading.seq) {
      this.seenSeqs.add(reading.seq);
      if (reading.seq > this.cursorSeq) this.cursorSeq = reading.seq;
    }

    if (!this.points.length || this.points.at(-1).timestamp <= reading.timestamp) {
      this.points.push(reading);
    } else {
      let start = 0;
      let end = this.points.length;
      while (start < end) {
        const middle = (start + end) >>> 1;
        if (this.points[middle].timestamp <= reading.timestamp) start = middle + 1;
        else end = middle;
      }
      this.points.splice(start, 0, reading);
    }

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

  _aggregateLiveReading(reading) {
    if (reading.seq <= this.cursorSeq) return;
    this.cursorSeq = reading.seq;
    this._updateLatest(reading);
    const timestamp = this.bucketOrigin +
      Math.floor((reading.timestamp - this.bucketOrigin) / this.liveBucketMs) * this.liveBucketMs;
    const bucket = this.liveBuckets.get(timestamp);
    if (!bucket) {
      const point = {
        ...reading, timestamp, count: 1,
        metrics: { ...reading.metrics }, min: { ...reading.metrics }, max: { ...reading.metrics }
      };
      this.liveBuckets.set(timestamp, point);
      return;
    }
    bucket.count++;
    for (const key of Object.keys(bucket.metrics)) {
      const value = reading.metrics[key];
      bucket.metrics[key] += (value - bucket.metrics[key]) / bucket.count;
      bucket.min[key] = Math.min(bucket.min[key], value);
      bucket.max[key] = Math.max(bucket.max[key], value);
    }
    if (SEVERITY_RANK[reading.severity] >= SEVERITY_RANK[bucket.severity]) {
      bucket.severity = reading.severity;
      bucket.anomalyReason = reading.anomalyReason;
    }
    bucket.seq = reading.seq;
  }

  _updateLatest(reading) {
    if (!this.latestReading || reading.timestamp > this.latestReading.timestamp ||
        (reading.timestamp === this.latestReading.timestamp && reading.seq > this.latestReading.seq)) {
      this.latestReading = reading;
    }
  }

  _viewportPoints() {
    if (!this.liveBucketMs) return this.points.slice();
    return [...this.points, ...[...this.liveBuckets.values()].map(point => ({
      ...point, metrics: { ...point.metrics }, min: { ...point.min }, max: { ...point.max }
    }))]
      .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  }

  _pruneWindow() {
    if (this.isHistoricalLocked) return; // Do not prune in fixed historical replay mode

    const cutoff = Date.now() - this.windowDurationMs;
    for (const timestamp of this.liveBuckets.keys()) {
      if (timestamp + this.liveBucketMs < cutoff) this.liveBuckets.delete(timestamp);
    }
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
        points: this._viewportPoints(),
        windowPreset: this.windowPreset,
        isHistoricalLocked: this.isHistoricalLocked,
        historicalRange: this.historicalRange ? { ...this.historicalRange } : null,
        cursorSeq: this.cursorSeq,
        bufferedCount: this.bufferedPackets.length,
        isLoadingHistory: this.isLoadingHistory
      });
    }
  }

  getMetricsSummary() {
    const useBuckets = this.liveBucketMs && !this.isHistoricalLocked;
    const points = useBuckets ? this.liveBuckets.values() : this.points;
    const latestPoint = useBuckets ? this.latestReading : this.points.at(-1);
    if (!latestPoint) {
      return {
        waterLevel: { current: 0, min: 0, max: 0 },
        outflow: { current: 0, min: 0, max: 0 },
        vibration: { current: 0, min: 0, max: 0 },
        current: { current: 0, min: 0, max: 0 }
      };
    }

    const latest = latestPoint.metrics;
    let minW = latest.waterLevel, maxW = latest.waterLevel;
    let minO = latest.outflow, maxO = latest.outflow;
    let minV = latest.vibration, maxV = latest.vibration;
    let minC = latest.current, maxC = latest.current;

    for (const p of points) {
      const min = p.min ?? p.metrics;
      const max = p.max ?? p.metrics;
      minW = Math.min(minW, min.waterLevel);
      maxW = Math.max(maxW, max.waterLevel);
      minO = Math.min(minO, min.outflow);
      maxO = Math.max(maxO, max.outflow);
      minV = Math.min(minV, min.vibration);
      maxV = Math.max(maxV, max.vibration);
      minC = Math.min(minC, min.current);
      maxC = Math.max(maxC, max.current);
    }

    return {
      waterLevel: { current: latest.waterLevel, min: minW, max: maxW },
      outflow: { current: latest.outflow, min: minO, max: maxO },
      vibration: { current: latest.vibration, min: minV, max: maxV },
      current: { current: latest.current, min: minC, max: maxC }
    };
  }
}
