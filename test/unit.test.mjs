/**
 * Floodline - Unit Test Suite (6 Core Specifications)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTelemetry, STATIONS, packReading, unpackReading } from '../shared/telemetry.mjs';
import { validateEvent, validateIngestBatch, MAX_BATCH_SIZE } from '../server/validation.mjs';
import { TokenBucketRateLimiter, createToken, verifyToken, AGENT_BEARER_KEY } from '../server/security.mjs';
import { TelemetrySeriesManager } from '../web/series.mjs';

// Test 1: Ingest Validation and Bounds
test('1. Ingestion Validation: enforces schema, bounds, and max batch size of 500', () => {
  // Valid event
  const validEv = {
    stationId: 'canal-junction',
    eventId: 'evt_101',
    timestamp: Date.now(),
    metrics: {
      waterLevel: 2.15,
      outflow: 650.0,
      vibration: 1.85,
      current: 48.2
    }
  };
  const res1 = validateEvent(validEv);
  assert.equal(res1.valid, true);
  assert.equal(res1.sanitized.stationId, 'canal-junction');

  // Invalid station
  const invalidStation = { ...validEv, stationId: 'unknown-station' };
  const res2 = validateEvent(invalidStation);
  assert.equal(res2.valid, false);
  assert.match(res2.error, /Invalid or unknown stationId/);

  // Non-finite metric
  const nonFinite = {
    ...validEv,
    metrics: { ...validEv.metrics, waterLevel: NaN }
  };
  const res3 = validateEvent(nonFinite);
  assert.equal(res3.valid, false);
  assert.match(res3.error, /waterLevel must be a finite number/);

  // Batch size > 500
  const largeBatch = Array.from({ length: 501 }, (_, i) => ({
    ...validEv,
    eventId: `evt_${i}`
  }));
  const batchRes = validateIngestBatch(largeBatch);
  assert.equal(batchRes.valid, false);
  assert.match(batchRes.error, /exceeds maximum allowable limit of 500/);
});

// Test 2: Token Bucket Rate Limiter
test('2. Rate Limiting: correctly bounds bursts and returns retry-after', () => {
  const limiter = new TokenBucketRateLimiter({
    capacity: 5,
    refillRate: 1,
    eventCapacity: 100,
    eventRefillRate: 10
  });

  const clientKey = 'agent_test_client';

  // Consume 5 allowed requests
  for (let i = 0; i < 5; i++) {
    const res = limiter.tryConsume(clientKey, 10);
    assert.equal(res.allowed, true);
  }

  // 6th request exhausts capacity -> rate limited
  const burstExhausted = limiter.tryConsume(clientKey, 10);
  assert.equal(burstExhausted.allowed, false);
  assert.ok(burstExhausted.retryAfterSec >= 1);
  assert.match(burstExhausted.reason, /Request rate limit exceeded/);
});

// Test 3: Telemetry Anomaly Classification
test('3. Anomaly Rules: distinguishes flood risk from pump motor mechanical faults', () => {
  // Nominal
  const nom = classifyTelemetry({ waterLevel: 1.8, outflow: 600, vibration: 1.5, current: 45 }, 'canal-junction');
  assert.equal(nom.severity, 'normal');

  // Storm Surge (Water Level > 3.8m)
  const stormSurge = classifyTelemetry({ waterLevel: 4.1, outflow: 1100, vibration: 3.2, current: 65 }, 'canal-junction');
  assert.equal(stormSurge.severity, 'critical');
  assert.equal(stormSurge.faultCategory, 'flooding');
  assert.match(stormSurge.anomalyReason, /Storm Surge/);

  // Intake Blockage (High water level + Collapsed outflow < 180 L/s)
  const blockage = classifyTelemetry({ waterLevel: 3.4, outflow: 75, vibration: 4.8, current: 40 }, 'canal-junction');
  assert.equal(blockage.severity, 'critical');
  assert.equal(blockage.faultCategory, 'flooding');
  assert.match(blockage.anomalyReason, /Intake Blockage/);

  // Motor Overload (Vibration >= 7.1 mm/s or Current >= 105 A)
  const motorFault = classifyTelemetry({ waterLevel: 1.8, outflow: 500, vibration: 8.5, current: 118 }, 'canal-junction');
  assert.equal(motorFault.severity, 'critical');
  assert.equal(motorFault.faultCategory, 'mechanical');
  assert.match(motorFault.anomalyReason, /Pump Overload/);
});

// Test 4: Wire Serialization and Deserialization
test('4. Wire Serialization: compact packing preserves all values and types', () => {
  const reading = {
    stationId: 'east-sluice',
    eventId: 'evt_packed_1',
    timestamp: 1731500000000,
    seq: 4281,
    metrics: {
      waterLevel: 2.345,
      outflow: 512.3,
      vibration: 2.15,
      current: 48.7
    },
    severity: 'normal',
    anomalyReason: 'Nominal operating conditions'
  };

  const packed = packReading(reading);
  assert.ok(Array.isArray(packed));
  assert.equal(packed[0], 'east-sluice');
  assert.equal(packed[3], 4281);

  const unpacked = unpackReading(packed);
  assert.equal(unpacked.stationId, reading.stationId);
  assert.equal(unpacked.eventId, reading.eventId);
  assert.equal(unpacked.seq, reading.seq);
  assert.equal(unpacked.metrics.waterLevel, 2.345);
  assert.equal(unpacked.metrics.outflow, 512.3);
  assert.equal(unpacked.severity, 'normal');
});

// Test 5: Series Manager History-to-Live Merge and Deduplication
test('5. Series Manager: merges MongoDB history and Socket.IO live stream without duplicates', () => {
  let latestState = null;
  const series = new TelemetrySeriesManager({
    onUpdate: (st) => { latestState = st; }
  });

  const now = Date.now();
  const stationId = 'canal-junction';
  const cursorSeq = 100;
  series.startStationSubscription(stationId, cursorSeq);

  // Simulate live packet arriving while history request is in flight
  const inFlightPacket = {
    stationId,
    eventId: 'evt_live_101',
    timestamp: now,
    seq: 101,
    metrics: { waterLevel: 2.2, outflow: 600, vibration: 1.8, current: 46 },
    severity: 'normal',
    anomalyReason: 'Nominal operating conditions'
  };
  series.ingestLive(inFlightPacket);

  // History response arrives with readings up to cursorSeq (100)
  const historyReadings = [
    {
      stationId,
      eventId: 'evt_hist_99',
      timestamp: now - 2000,
      seq: 99,
      metrics: { waterLevel: 2.0, outflow: 590, vibration: 1.7, current: 45 },
      severity: 'normal',
      anomalyReason: 'Nominal operating conditions'
    },
    {
      stationId,
      eventId: 'evt_hist_100',
      timestamp: now - 1000,
      seq: 100,
      metrics: { waterLevel: 2.1, outflow: 595, vibration: 1.8, current: 45.5 },
      severity: 'normal',
      anomalyReason: 'Nominal operating conditions'
    }
  ];

  series.applyHistory(historyReadings);

  // Verify history + buffered live packet are merged seamlessly
  assert.equal(latestState.points.length, 3);
  assert.equal(latestState.points[0].seq, 99);
  assert.equal(latestState.points[1].seq, 100);
  assert.equal(latestState.points[2].seq, 101);

  // Re-ingest duplicate packet -> should be ignored without duplicate points
  series.ingestLive(inFlightPacket);
  assert.equal(latestState.points.length, 3);
});

test('Live buckets merge late updates into history and preserve the latest reading', () => {
  const now = Date.now();
  const origin = now - 1000;
  const stationId = 'canal-junction';
  const make = (seq, timestamp, waterLevel) => ({
    seq, stationId, timestamp, eventId: 'bucket-' + seq,
    metrics: { waterLevel, outflow: 600, vibration: 2, current: 45 },
    severity: waterLevel > 3 ? 'critical' : 'normal'
  });
  const series = new TelemetrySeriesManager();
  series.startStationSubscription(stationId, 10);
  series.setLiveResolution(1000, origin);
  series.applyHistory([{
    ...make(10, origin, 2), isBucket: true, count: 2,
    last: make(10, now - 50, 2.5)
  }]);
  series.ingestLive(make(11, now - 100, 4));
  series.ingestLive(make(11, now - 100, 4));
  const bucket = series.liveBuckets.get(origin);
  assert.equal(bucket.count, 3);
  assert.equal(bucket.severity, 'critical');
  assert.equal(series.getMetricsSummary().waterLevel.current, 2.5);
  assert.equal(series.getMetricsSummary().waterLevel.max, 4);
  assert.equal(series.liveBuckets.size, 1);
});

// Test 6: Signed Sessions and Role-Based Access Control
test('6. Security: validates JWT sessions, roles, and agent bearer tokens', () => {
  // Generate and verify operator token
  const opToken = createToken({ username: 'operator', role: 'operator' });
  const verifiedOp = verifyToken(opToken);
  assert.ok(verifiedOp);
  assert.equal(verifiedOp.username, 'operator');
  assert.equal(verifiedOp.role, 'operator');

  // Viewer token
  const viewerToken = createToken({ username: 'viewer', role: 'viewer' });
  const verifiedViewer = verifyToken(viewerToken);
  assert.ok(verifiedViewer);
  assert.equal(verifiedViewer.role, 'viewer');

  // Invalid token
  const invalid = verifyToken('tampered-token-xyz');
  assert.equal(invalid, null);

  // Agent Bearer Key
  assert.equal(AGENT_BEARER_KEY, 'floodline-agent-key-2026');
});
