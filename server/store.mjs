/**
 * Floodline - Persistence, Bulk Upserts, Monotonic Sequence, Queue Backpressure, and History
 */

import { MongoClient } from 'mongodb';
import { RETENTION_MS, STATIONS, classifyTelemetry } from '../shared/telemetry.mjs';

export const MAX_QUEUE_SIZE = 16000;
export const FLUSH_INTERVAL_MS = 100;
export const MAX_FLUSH_BATCH = 2000;
export const TTL_SECONDS = RETENTION_MS / 1000;

export class TelemetryStore {
  constructor(mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/floodline') {
    this.mongoUri = mongoUri;
    this.client = null;
    this.db = null;
    this.readingsCol = null;
    this.stateCol = null;
    this.incidentsCol = null;

    // In-memory queue for backpressure and bulk writes
    this.queue = [];
    this.pendingEvents = 0;
    this.activeFlush = null;
    this.closing = false;
    this.lastWriteFailed = false;
    this.flushTimer = null;

    // Monotonic commit sequence
    this.currentSeq = 0;
    this.nextSeq = 0;

    // Station latest states: stationId -> { timestamp, seq, metrics, severity, anomalyReason }
    this.stationStates = new Map();

    // Active incidents: stationId -> incident object
    this.activeIncidents = new Map();
    this.dirtyIncidents = new Map();

    // Callback when items are committed (for Socket.IO broadcasting)
    this.onCommitted = null;
  }

  async connect() {
    this.client = new MongoClient(this.mongoUri, {
      maxPoolSize: 50,
      minPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 5000
    });
    await this.client.connect();
    this.db = this.client.db();

    this.readingsCol = this.db.collection('readings');
    this.stateCol = this.db.collection('station_state');
    this.incidentsCol = this.db.collection('incidents');

    await this._ensureIndexes();
    await this._initializeSequenceAndState();

    // Start background flush loop
    this.flushTimer = setInterval(() => this._flushQueue(), FLUSH_INTERVAL_MS);
  }

  async close() {
    this.closing = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.activeFlush;
    while (this.queue.length) await this._flushQueue();
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async _ensureIndexes() {
    // Unique compound index on stationId + eventId for deduplication
    await this.readingsCol.createIndex({ stationId: 1, eventId: 1 }, { unique: true });

    // Compound index for historical queries
    await this.readingsCol.createIndex({ stationId: 1, timestamp: 1, seq: 1 });

    // Unique index on monotonic sequence
    await this.readingsCol.createIndex({ seq: 1 }, { unique: true });

    // 7-day TTL expiration
    await this.readingsCol.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });

    // Station state unique index
    await this.stateCol.createIndex({ stationId: 1 }, { unique: true });

    // Incidents indexes
    await this.incidentsCol.createIndex({ incidentId: 1 }, { unique: true });
    await this.incidentsCol.createIndex({ stationId: 1, startTime: 1 });
    await this.incidentsCol.createIndex({ resolved: 1, startTime: 1 });
  }

  async _initializeSequenceAndState() {
    // Recover latest sequence number
    const maxSeqDoc = await this.readingsCol.find().sort({ seq: -1 }).limit(1).toArray();
    this.currentSeq = maxSeqDoc.length > 0 ? (maxSeqDoc[0].seq || 0) : 0;

    // Restore station states
    const states = await this.stateCol.find().toArray();
    for (const state of states) {
      this.stationStates.set(state.stationId, {
        stationId: state.stationId,
        timestamp: state.timestamp,
        seq: state.seq,
        metrics: state.metrics,
        severity: state.severity,
        anomalyReason: state.anomalyReason
      });
    }

    // Readings are authoritative if the process stopped before state was written.
    const latest = await Promise.all(STATIONS.map(station =>
      this.readingsCol.findOne({ stationId: station.id }, { sort: { timestamp: -1, seq: -1 } })
    ));
    for (const reading of latest) if (reading) this._updateStationState(reading);
    for (const state of this.stationStates.values()) {
      this.currentSeq = Math.max(this.currentSeq, state.seq);
    }
    this.nextSeq = this.currentSeq;
    const active = await this.incidentsCol.find({ resolved: false }).sort({ startTime: 1 }).toArray();
    for (const incident of active) this.activeIncidents.set(incident.stationId, incident);

    // Initialize default states for stations not yet in database
    for (const station of STATIONS) {
      if (!this.stationStates.has(station.id)) {
        const defaultState = {
          stationId: station.id,
          timestamp: 0,
          seq: this.currentSeq,
          metrics: {
            waterLevel: (station.nominalWaterLevel.min + station.nominalWaterLevel.max) / 2,
            outflow: (station.nominalOutflow.min + station.nominalOutflow.max) / 2,
            vibration: 1.8,
            current: 48.0
          },
          severity: 'normal',
          anomalyReason: 'Nominal operating conditions'
        };
        this.stationStates.set(station.id, defaultState);
      }
    }
  }

  getLatestSeq() {
    return this.currentSeq;
  }

  getQueueLength() {
    return this.pendingEvents;
  }

  getStationState(stationId) {
    return this.stationStates.get(stationId) || null;
  }

  getAllStationStates() {
    return Array.from(this.stationStates.values());
  }

  /**
   * Enqueue events for ingestion.
   * Enforces 16,000 bounded queue backpressure.
   * Returns a promise that resolves once the batch is flushed and persisted.
   */
  enqueueBatch(events) {
    if (!events.length) return Promise.resolve({ stored: 0, duplicates: 0, latestSeq: this.currentSeq });
    if (this.closing || events.length > MAX_FLUSH_BATCH || this.pendingEvents + events.length > MAX_QUEUE_SIZE) {
      const err = new Error('Ingest write queue saturated (backpressure limit 16,000 exceeded). Retry shortly.');
      err.code = 'QUEUE_OVERLOAD';
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      this.pendingEvents += events.length;
      this.queue.push({
        events,
        resolve,
        reject,
        enqueuedAt: Date.now()
      });
    });
  }

  _flushQueue() {
    if (this.activeFlush || !this.queue.length) return this.activeFlush;
    this.activeFlush = this._persistQueuedBatches().finally(() => { this.activeFlush = null; });
    return this.activeFlush;
  }

  async _persistQueuedBatches() {
    const accumulatedEvents = [];
    const pendingBatches = [];

    try {
      // Drain up to MAX_FLUSH_BATCH events from waiting items
      while (this.queue.length &&
          accumulatedEvents.length + this.queue[0].events.length <= MAX_FLUSH_BATCH) {
        const item = this.queue.shift();
        pendingBatches.push(item);
        accumulatedEvents.push(...item.events);
      }

      const preparedDocs = [];
      const batchIdentities = new Set();

      for (const ev of accumulatedEvents) {
        const identity = ev.stationId + ':' + ev.eventId;
        if (batchIdentities.has(identity)) {
          preparedDocs.push(null);
          continue;
        }
        batchIdentities.add(identity);
        const classification = classifyTelemetry(ev.metrics, ev.stationId);
        const expireAt = new Date(ev.timestamp + TTL_SECONDS * 1000);

        preparedDocs.push({
          stationId: ev.stationId,
          eventId: ev.eventId,
          timestamp: ev.timestamp,
          seq: ++this.nextSeq,
          metrics: ev.metrics,
          severity: classification.severity,
          anomalyReason: classification.anomalyReason,
          expireAt
        });
      }

      // The unique event index makes unordered inserts idempotent.
      const writes = preparedDocs.flatMap((doc, index) => doc ? [{ doc, index }] : []);
      let insertedIndices;
      try {
        const result = await this.readingsCol.insertMany(writes.map(({ doc }) => doc), { ordered: false });
        insertedIndices = new Set(Object.keys(result.insertedIds).map(index => writes[Number(index)].index));
      } catch (error) {
        // A write can fail after MongoDB has committed a subset of the batch.
        const persisted = await this.readingsCol.find({ seq: { $in: writes.map(({ doc }) => doc.seq) } },
          { projection: { seq: 1 } }).toArray().catch(() => []);
        const recovered = new Set(persisted.map(doc => doc.seq));
        insertedIndices = new Set(writes.filter(({ doc }) => recovered.has(doc.seq)).map(({ index }) => index));
        const duplicateRetries = Array.isArray(error.writeErrors) && error.writeErrors.length > 0 &&
          error.writeErrors.every(entry => entry.code === 11000 && /stationId_1_eventId_1/.test(entry.errmsg)) &&
          !error.result?.getWriteConcernError();
        if (!duplicateRetries || insertedIndices.size + error.writeErrors.length !== writes.length) {
          this._publishReadings(preparedDocs.filter((_, index) => insertedIndices.has(index)));
          await this._persistIncidents();
          throw error;
        }
      }

      // Identify newly inserted docs vs duplicates
      const newlyCommittedDocs = preparedDocs.filter((_, index) => insertedIndices.has(index));
      this._publishReadings(newlyCommittedDocs);
      this.lastWriteFailed = false;

      // Persist updated station states to DB
      const stateBulk = [];
      for (const [stId, st] of this.stationStates.entries()) {
        stateBulk.push({
          updateOne: {
            filter: { stationId: stId },
            update: { $set: st },
            upsert: true
          }
        });
      }
      if (newlyCommittedDocs.length) {
        await this.stateCol.bulkWrite(stateBulk, { ordered: false }).catch(error => {
          console.error('[Station State Write Error]', error);
        });
      }
      await this._persistIncidents();

      // Resolve all pending caller promises
      let offset = 0;
      for (const item of pendingBatches) {
        const end = offset + item.events.length;
        let stored = 0;
        for (; offset < end; offset++) stored += Number(insertedIndices.has(offset));
        item.resolve({
          stored,
          duplicates: item.events.length - stored,
          latestSeq: this.currentSeq
        });
      }
    } catch (err) {
      this.lastWriteFailed = true;
      console.error('[Store Flush Error]', err);
      for (const item of pendingBatches) item.reject(err);
    } finally {
      this.pendingEvents -= accumulatedEvents.length;
    }
  }

  _publishReadings(readings) {
    if (!readings.length) return;
    this.currentSeq = Math.max(this.currentSeq, readings.at(-1).seq);
    for (const doc of readings) {
      if (this._updateStationState(doc)) this._processIncidentTracking(doc);
    }
    this.onCommitted?.(readings);
  }

  /**
   * Updates in-memory station state.
   * If a late-arriving event comes with an older timestamp, it does NOT roll back
   * the current station state, as required by the specification.
   */
  _updateStationState(doc) {
    const current = this.stationStates.get(doc.stationId);
    if (!current) {
      this.stationStates.set(doc.stationId, {
        stationId: doc.stationId,
        timestamp: doc.timestamp,
        seq: doc.seq,
        metrics: doc.metrics,
        severity: doc.severity,
        anomalyReason: doc.anomalyReason
      });
      return true;
    }

    // Compare timestamp first, sequence second
    if (doc.timestamp > current.timestamp || (doc.timestamp === current.timestamp && doc.seq > current.seq)) {
      this.stationStates.set(doc.stationId, {
        stationId: doc.stationId,
        timestamp: doc.timestamp,
        seq: doc.seq,
        metrics: doc.metrics,
        severity: doc.severity,
        anomalyReason: doc.anomalyReason
      });
      return true;
    }
    return false;
  }

  _processIncidentTracking(doc) {
    const isAnomalous = doc.severity === 'warning' || doc.severity === 'critical';
    const active = this.activeIncidents.get(doc.stationId);

    if (isAnomalous) {
      if (!active) {
        // Start new incident
        const incident = {
          incidentId: `inc_${doc.stationId}_${doc.timestamp}`,
          stationId: doc.stationId,
          severity: doc.severity,
          startTime: doc.timestamp,
          endTime: doc.timestamp,
          peakMetrics: { ...doc.metrics },
          reasons: [doc.anomalyReason],
          resolved: false
        };
        this.activeIncidents.set(doc.stationId, incident);
        this.dirtyIncidents.set(incident.incidentId, incident);
      } else {
        // Update active incident
        active.endTime = Math.max(active.endTime, doc.timestamp);
        if (doc.severity === 'critical') active.severity = 'critical';
        if (active.reasons.length < 8 && !active.reasons.includes(doc.anomalyReason)) {
          active.reasons.push(doc.anomalyReason);
        }
        if (doc.metrics.waterLevel > active.peakMetrics.waterLevel) active.peakMetrics.waterLevel = doc.metrics.waterLevel;
        if (doc.metrics.outflow > active.peakMetrics.outflow) active.peakMetrics.outflow = doc.metrics.outflow;
        if (doc.metrics.vibration > active.peakMetrics.vibration) active.peakMetrics.vibration = doc.metrics.vibration;
        if (doc.metrics.current > active.peakMetrics.current) active.peakMetrics.current = doc.metrics.current;

        this.dirtyIncidents.set(active.incidentId, active);
      }
    } else if (active) {
      // Station returned to normal; close incident after 30 seconds of stability
      if (doc.timestamp - active.endTime > 30000) {
        active.resolved = true;
        this.dirtyIncidents.set(active.incidentId, active);
        this.activeIncidents.delete(doc.stationId);
      }
    }
  }

  async _persistIncidents() {
    if (!this.dirtyIncidents.size) return;
    const updates = [...this.dirtyIncidents.values()].map(({ _id, ...incident }) => ({
      updateOne: {
        filter: { incidentId: incident.incidentId },
        update: { $set: incident },
        upsert: true
      }
    }));
    try {
      await this.incidentsCol.bulkWrite(updates, { ordered: false });
      this.dirtyIncidents.clear();
    } catch (error) {
      console.error('[Incident Write Error]', error);
    }
  }

  /**
   * Retrieves historical telemetry for a station.
   * Can bucket data into uniform intervals for clean visualization.
   */
  async getStationHistory(stationId, { from, to, beforeSeq = null, maxPoints = 500, bucketMs = null }) {
    const query = { stationId };

    if (from != null || to != null) {
      query.timestamp = {};
      if (from != null) query.timestamp.$gte = Number(from);
      if (to != null) query.timestamp.$lte = Number(to);
    }

    if (beforeSeq != null) {
      query.seq = { $lte: Number(beforeSeq) };
    }

    if (!bucketMs) {
      const readings = await this.readingsCol
        .find(query)
        .sort({ timestamp: 1, seq: 1 })
        .limit(maxPoints * 2)
        .toArray();

      return readings.map(r => ({
        stationId: r.stationId,
        eventId: r.eventId,
        timestamp: r.timestamp,
        seq: r.seq,
        metrics: r.metrics,
        severity: r.severity,
        anomalyReason: r.anomalyReason
      }));
    }

    // Time-bucket aggregation
    const bMs = Math.max(bucketMs, Math.ceil((to - from + 1) / maxPoints));

    const pipeline = [
      { $match: query },
      { $set: { severityRank: { $indexOfArray: [['normal', 'warning', 'critical'], '$severity'] } } },
      {
        $group: {
          _id: {
            $subtract: ['$timestamp', { $mod: [{ $subtract: ['$timestamp', from] }, bMs] }]
          },
          avgWaterLevel: { $avg: '$metrics.waterLevel' },
          avgOutflow: { $avg: '$metrics.outflow' },
          avgVibration: { $avg: '$metrics.vibration' },
          avgCurrent: { $avg: '$metrics.current' },
          minWaterLevel: { $min: '$metrics.waterLevel' },
          maxWaterLevel: { $max: '$metrics.waterLevel' },
          minOutflow: { $min: '$metrics.outflow' },
          maxOutflow: { $max: '$metrics.outflow' },
          minVibration: { $min: '$metrics.vibration' },
          maxVibration: { $max: '$metrics.vibration' },
          minCurrent: { $min: '$metrics.current' },
          maxCurrent: { $max: '$metrics.current' },
          maxSeq: { $max: '$seq' },
          count: { $sum: 1 },
          last: { $top: {
            sortBy: { timestamp: -1, seq: -1 },
            output: { timestamp: '$timestamp', seq: '$seq', metrics: '$metrics' }
          } },
          peak: { $top: {
            sortBy: { severityRank: -1, timestamp: -1, seq: -1 },
            output: { severity: '$severity', reason: '$anomalyReason' }
          } }
        }
      },
      { $sort: { _id: 1 } }
    ];

    const aggregated = await this.readingsCol.aggregate(pipeline, { maxTimeMS: 4000 }).toArray();

    return aggregated.map(b => {
      return {
        stationId,
        timestamp: b._id,
        seq: b.maxSeq,
        count: b.count,
        last: b.last,
        min: { waterLevel: b.minWaterLevel, outflow: b.minOutflow, vibration: b.minVibration, current: b.minCurrent },
        max: { waterLevel: b.maxWaterLevel, outflow: b.maxOutflow, vibration: b.maxVibration, current: b.maxCurrent },
        metrics: {
          waterLevel: Number(b.avgWaterLevel.toFixed(3)),
          outflow: Number(b.avgOutflow.toFixed(1)),
          vibration: Number(b.avgVibration.toFixed(2)),
          current: Number(b.avgCurrent.toFixed(1))
        },
        severity: b.peak.severity,
        anomalyReason: b.peak.reason,
        isBucket: true
      };
    });
  }

  async getIncidents(stationId = null, limit = 20) {
    const query = stationId ? { stationId } : {};
    return await this.incidentsCol
      .find(query)
      .sort({ startTime: -1 })
      .limit(limit)
      .toArray();
  }

  async getIncident(incidentId) {
    return this.incidentsCol.findOne({ incidentId });
  }

  /**
   * Seed recent baseline history and the Canal Junction storm surge incident if database is fresh.
   */
  async seedInitialHistoryIfNeeded() {
    const count = await this.readingsCol.countDocuments();
    if (count > 0) return; // Already seeded if not empty

    console.log('[Store] Fresh database detected. Seeding baseline history and Canal Junction storm incident...');

    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const seededEvents = [];

    // Seed 1 reading every 5 seconds for 2 hours across all 6 stations
    const stepMs = 5000;
    for (let t = twoHoursAgo; t < now; t += stepMs) {
      for (const st of STATIONS) {
        let wl = (st.nominalWaterLevel.min + st.nominalWaterLevel.max) / 2 + Math.sin(t / 600000) * 0.3;
        let of = (st.nominalOutflow.min + st.nominalOutflow.max) / 2 + Math.cos(t / 600000) * 80;
        let vib = 1.6 + Math.sin(t / 30000) * 0.4;
        let cur = 45 + Math.cos(t / 50000) * 8;

        // In the interval from 45 min ago to 30 min ago, inject the Canal Junction Storm Surge incident!
        const incidentStart = now - 45 * 60 * 1000;
        const incidentEnd = now - 30 * 60 * 1000;

        if (st.id === 'canal-junction' && t >= incidentStart && t <= incidentEnd) {
          const progress = (t - incidentStart) / (incidentEnd - incidentStart);
          const surgeFactor = Math.sin(progress * Math.PI); // 0 -> 1 -> 0 peak in middle
          wl = 2.0 + surgeFactor * 2.1; // Reaches 4.1m (Critical!)
          of = 650 + surgeFactor * 450; // Pumps working at max capacity 1100 L/s
          vib = 2.2 + surgeFactor * 1.8;
          cur = 50 + surgeFactor * 32;
        }

        seededEvents.push({
          stationId: st.id,
          eventId: `seed_${st.id}_${t}`,
          timestamp: t,
          metrics: {
            waterLevel: wl,
            outflow: of,
            vibration: vib,
            current: cur
          }
        });
      }
    }

    // Insert seeded events in chunks
    for (let i = 0; i < seededEvents.length; i += 2000) {
      const slice = seededEvents.slice(i, i + 2000);
      const bulkOps = slice.map(ev => {
        this.nextSeq += 1;
        const cls = classifyTelemetry(ev.metrics, ev.stationId);
        return {
          updateOne: {
            filter: { stationId: ev.stationId, eventId: ev.eventId },
            update: {
              $setOnInsert: {
                stationId: ev.stationId,
                eventId: ev.eventId,
                timestamp: ev.timestamp,
              seq: this.nextSeq,
                metrics: ev.metrics,
                severity: cls.severity,
                anomalyReason: cls.anomalyReason,
                expireAt: new Date(ev.timestamp + TTL_SECONDS * 1000)
              }
            },
            upsert: true
          }
        };
      });
      await this.readingsCol.bulkWrite(bulkOps, { ordered: false });
      this.currentSeq = this.nextSeq;
    }

    // Seed the archived Canal Junction Incident record
    const incStart = now - 45 * 60 * 1000;
    const incEnd = now - 30 * 60 * 1000;
    await this.incidentsCol.updateOne(
      { incidentId: 'inc_canal-junction_archived_surge' },
      {
        $set: {
          incidentId: 'inc_canal-junction_archived_surge',
          stationId: 'canal-junction',
          severity: 'critical',
          startTime: incStart,
          endTime: incEnd,
          peakMetrics: {
            waterLevel: 4.12,
            outflow: 1148,
            vibration: 3.95,
            current: 82.4
          },
          reasons: [
            'Storm Surge: Water level (4.12 m) exceeds critical basin retention capacity',
            'High Water Advisory: Basin level approaching warning threshold'
          ],
          resolved: true
        }
      },
      { upsert: true }
    );

    console.log(`[Store] Seeding complete. Inserted ${seededEvents.length} baseline readings.`);
  }
}
