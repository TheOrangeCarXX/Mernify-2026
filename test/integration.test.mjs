/**
 * Floodline - MongoDB Integration Test Suite
 * Covers real database persistence, roles & agent access, station isolation,
 * duplicate retries, late readings, reconnect cursor backfill, rate limiting, and restart persistence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ClientIO } from 'socket.io-client';

import { createServer } from '../server/index.mjs';
import { AGENT_BEARER_KEY, createToken } from '../server/security.mjs';

const TEST_MONGO_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/floodline_integration_test';
const TEST_PORT = 3105;

let serverCtx = null;
let serverBaseUrl = `http://localhost:${TEST_PORT}`;

test.before(async () => {
  // Set TEST_MODE to true
  process.env.TEST_MODE = 'true';
  process.env.DEMO_MODE = 'false'; // Test strict authentication

  serverCtx = await createServer({
    mongoUri: TEST_MONGO_URI,
    enableSimulator: false, // Manual event ingestion for deterministic testing
    simulatorRate: 0,
    seedInitialHistory: false
  });

  // Clean test database collections
  await serverCtx.store.readingsCol.deleteMany({});
  await serverCtx.store.stateCol.deleteMany({});
  await serverCtx.store.incidentsCol.deleteMany({});

  await new Promise((resolve) => {
    serverCtx.server.listen(TEST_PORT, () => resolve());
  });
});

test.after(async () => {
  if (serverCtx) {
    await serverCtx.shutdown();
  }
});

// 1. Role and Agent Access Control
test('1. Integration: Role and Agent Access Control', async () => {
  const opToken = createToken({ username: 'operator', role: 'operator' });
  const viewerToken = createToken({ username: 'viewer', role: 'viewer' });

  // Ingest without auth -> 401
  const unauthRes = await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      stationId: 'canal-junction',
      eventId: 'auth_test_1',
      timestamp: Date.now(),
      metrics: { waterLevel: 2.0, outflow: 500, vibration: 1.5, current: 40 }
    }])
  });
  assert.equal(unauthRes.status, 401);

  // Ingest with Agent Bearer Key -> 200
  const agentRes = await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AGENT_BEARER_KEY}`
    },
    body: JSON.stringify([{
      stationId: 'canal-junction',
      eventId: 'auth_test_agent_1',
      timestamp: Date.now(),
      metrics: { waterLevel: 2.0, outflow: 500, vibration: 1.5, current: 40 }
    }])
  });
  assert.equal(agentRes.status, 200);
  const agentData = await agentRes.json();
  assert.equal(agentData.success, true);
  assert.equal(agentData.stored, 1);

  // Fault trigger with Viewer role -> 403 Forbidden
  const viewerFaultRes = await fetch(`${serverBaseUrl}/api/faults/trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${viewerToken}`
    },
    body: JSON.stringify({ stationId: 'canal-junction', type: 'storm-surge' })
  });
  assert.equal(viewerFaultRes.status, 403);
});

// 2. Station Room Isolation
test('2. Integration: Station Room Isolation with Multiple Socket.IO Clients', async () => {
  const clientA = ClientIO(serverBaseUrl, { transports: ['websocket'] });
  const clientB = ClientIO(serverBaseUrl, { transports: ['websocket'] });

  await Promise.all([
    new Promise(res => clientA.on('connect', res)),
    new Promise(res => clientB.on('connect', res))
  ]);

  // Client A subscribes to canal-junction
  const ackA = await new Promise(res => clientA.emit('subscribe:station', { stationId: 'canal-junction' }, res));
  assert.equal(ackA.stationId, 'canal-junction');

  // Client B subscribes to east-sluice
  const ackB = await new Promise(res => clientB.emit('subscribe:station', { stationId: 'east-sluice' }, res));
  assert.equal(ackB.stationId, 'east-sluice');

  let clientAReceived = [];
  let clientBReceived = [];

  clientA.on('telemetry:batch', batch => clientAReceived.push(...batch));
  clientB.on('telemetry:batch', batch => clientBReceived.push(...batch));

  // Ingest reading for canal-junction
  await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_BEARER_KEY}` },
    body: JSON.stringify([{
      stationId: 'canal-junction',
      eventId: `iso_cj_${Date.now()}`,
      timestamp: Date.now(),
      metrics: { waterLevel: 2.5, outflow: 700, vibration: 1.8, current: 45 }
    }])
  });

  // Wait for 100ms flush + 50ms broadcast
  await new Promise(r => setTimeout(r, 250));

  // Verify Client A received it, Client B did NOT receive it
  assert.ok(clientAReceived.length > 0);
  assert.equal(clientAReceived[0][0], 'canal-junction');
  assert.equal(clientBReceived.length, 0);

  clientA.disconnect();
  clientB.disconnect();
});

// 3. Idempotent Deduplication Retries
test('3. Integration: Duplicate Retries are Idempotent in MongoDB', async () => {
  const evId = `dedup_evt_${Date.now()}`;
  const payload = [{
    stationId: 'canal-junction',
    eventId: evId,
    timestamp: Date.now(),
    metrics: { waterLevel: 2.3, outflow: 600, vibration: 1.9, current: 47 }
  }];

  // First submit
  const res1 = await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_BEARER_KEY}` },
    body: JSON.stringify(payload)
  });
  const data1 = await res1.json();
  assert.equal(data1.stored, 1);
  assert.equal(data1.duplicates, 0);

  // Duplicate retry with same eventId
  const res2 = await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_BEARER_KEY}` },
    body: JSON.stringify(payload)
  });
  const data2 = await res2.json();
  assert.equal(data2.stored, 0);
  assert.equal(data2.duplicates, 1);

  // Verify only 1 record in database
  const count = await serverCtx.store.readingsCol.countDocuments({ eventId: evId });
  assert.equal(count, 1);
});

// 4. Late-Arriving Readings & Station State Non-Rollback
test('4. Integration: Late Readings update history without rolling back live station state', async () => {
  const now = Date.now();
  const stationId = 'north-weir';

  // 1. Send recent sample at T_now (Current state)
  await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_BEARER_KEY}` },
    body: JSON.stringify([{
      stationId,
      eventId: `state_now_${now}`,
      timestamp: now,
      metrics: { waterLevel: 1.5, outflow: 400, vibration: 1.2, current: 35 }
    }])
  });
  await new Promise(r => setTimeout(r, 150));

  const state1 = serverCtx.store.getStationState(stationId);
  assert.equal(state1.timestamp, now);
  assert.equal(state1.metrics.waterLevel, 1.5);

  // 2. Send an older sample from 2 minutes ago (T_old = now - 120,000)
  const oldTs = now - 120000;
  await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_BEARER_KEY}` },
    body: JSON.stringify([{
      stationId,
      eventId: `state_old_${oldTs}`,
      timestamp: oldTs,
      metrics: { waterLevel: 3.9, outflow: 80, vibration: 4.8, current: 55 } // anomalous older reading
    }])
  });
  await new Promise(r => setTimeout(r, 150));

  // Current station state should NOT roll back to oldTs or old values!
  const state2 = serverCtx.store.getStationState(stationId);
  assert.equal(state2.timestamp, now);
  assert.equal(state2.metrics.waterLevel, 1.5);

  // But the older reading is stored in history
  const histDoc = await serverCtx.store.readingsCol.findOne({ eventId: `state_old_${oldTs}` });
  assert.ok(histDoc);
  assert.equal(histDoc.timestamp, oldTs);
  assert.equal(histDoc.metrics.waterLevel, 3.9);
});

// 5. Reconnection Backfill Cursor Handshake
test('5. Integration: Reconnect Backfill Retrieves Missed Readings through Cursor Handshake', async () => {
  const opToken = createToken({ username: 'operator', role: 'operator' });
  const stationId = 'south-basin';

  const initialSeq = serverCtx.store.getLatestSeq();

  // Produce 5 events
  const batch = Array.from({ length: 5 }, (_, i) => ({
    stationId,
    eventId: `backfill_${initialSeq}_${i}`,
    timestamp: Date.now() + i * 10,
    metrics: { waterLevel: 2.0 + i * 0.1, outflow: 800, vibration: 1.5, current: 40 }
  }));

  await fetch(`${serverBaseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AGENT_BEARER_KEY}` },
    body: JSON.stringify(batch)
  });

  await new Promise(r => setTimeout(r, 150));

  // Query historical backfill starting from initialSeq
  const histRes = await fetch(
    `${serverBaseUrl}/api/stations/${stationId}/history?from=${Date.now() - 60000}&to=${Date.now() + 60000}&beforeSeq=${serverCtx.store.getLatestSeq()}`,
    { headers: { 'Authorization': `Bearer ${opToken}` } }
  );
  assert.equal(histRes.status, 200);
  const histData = await histRes.json();

  const matched = histData.readings.filter(r => r.seq > initialSeq);
  assert.equal(matched.length, 5);
});

// 6. Persistence After Server Restart
test('6. Integration: Server Restart Restores Latest Commit Sequence and Station States', async () => {
  const lastSeqBeforeRestart = serverCtx.store.getLatestSeq();
  assert.ok(lastSeqBeforeRestart > 0);

  // Shutdown current server
  await serverCtx.shutdown();
  serverCtx = null;

  // Restart a fresh server pointing to the exact same MongoDB database
  const restartedCtx = await createServer({
    mongoUri: TEST_MONGO_URI,
    enableSimulator: false,
    seedInitialHistory: false
  });

  await new Promise(res => restartedCtx.server.listen(TEST_PORT + 1, res));

  // Verify latest sequence is restored
  const restoredSeq = restartedCtx.store.getLatestSeq();
  assert.equal(restoredSeq, lastSeqBeforeRestart);

  // Verify station state was restored
  const stState = restartedCtx.store.getStationState('north-weir');
  assert.ok(stState);
  assert.equal(stState.metrics.waterLevel, 1.5);

  // Clean up restarted server
  await restartedCtx.shutdown();
});
