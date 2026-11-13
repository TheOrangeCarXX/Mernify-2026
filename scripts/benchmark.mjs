/**
 * Floodline - High-Throughput Telemetry Benchmark & Stress Test Harness
 * Evaluates persistence throughput, Socket.IO broadcast fanout, and tail latency (p50, p95, p99)
 *
 * Usage:
 *   node scripts/benchmark.mjs --rate=3000 --seconds=30 --clients=48
 *   node scripts/benchmark.mjs --rate=5000 --seconds=30 --clients=96
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { io as ClientIO } from 'socket.io-client';
import { STATIONS, unpackReading } from '../shared/telemetry.mjs';
import { AGENT_BEARER_KEY, createToken } from '../server/security.mjs';
import { createServer } from '../server/index.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    rate: 3000,
    seconds: 10,
    clients: 48,
    port: 0
  };

  for (const arg of args) {
    if (arg.startsWith('--rate=')) params.rate = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--seconds=')) params.seconds = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--clients=')) params.clients = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--port=')) params.port = parseInt(arg.split('=')[1], 10);
  }

  if (!Number.isInteger(params.rate) || params.rate < 1 || params.rate > 5000 ||
      !Number.isInteger(params.seconds) || params.seconds < 1 || params.seconds > 180 ||
      !Number.isInteger(params.clients) || params.clients < 1 || params.clients > 120 ||
      !Number.isInteger(params.port) || params.port < 0 || params.port > 65535) {
    throw new Error('Use 1–5,000 readings/s, 1–180 seconds, and 1–120 clients. The rate matches the agent’s sustained ingest limit.');
  }
  return params;
}

function calculatePercentile(sortedArray, percentile) {
  if (sortedArray.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
}

async function runBenchmark() {
  const { rate, seconds, clients, port } = parseArgs();

  console.log(`\n===============================================================`);
  console.log(`⚡ FLOODLINE TELEMETRY BENCHMARK HARNESS`);
  console.log(`   Target Ingest Rate : ${rate.toLocaleString()} readings/s`);
  console.log(`   Test Duration      : ${seconds} seconds`);
  console.log(`   Connected Clients  : ${clients} Socket.IO subscribers`);
  console.log(`   Target Volume      : ${(rate * seconds).toLocaleString()} total events`);
  console.log(`===============================================================\n`);

  const databaseName = 'floodline_bench_' + randomUUID().replaceAll('-', '');
  const uri = new URL(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/floodline');
  uri.pathname = '/' + databaseName;
  const serverInstance = await createServer({ mongoUri: uri.toString(), enableSimulator: false, seedInitialHistory: false });
  const mongo = new MongoClient(uri.toString());

  // Connect Socket.IO clients distributed across stations
  console.log(`[Bench] Connecting ${clients} Socket.IO subscribers...`);
  const clientSockets = [];
  try {
    await new Promise((resolve, reject) => {
      serverInstance.server.once('error', reject);
      serverInstance.server.listen(port, '127.0.0.1', resolve);
    });
    const baseUrl = 'http://127.0.0.1:' + serverInstance.server.address().port;
    const stationCounts = new Map(STATIONS.map(station => [station.id, 0]));
    let attempted = 0;
    let failed = 0;
    let misrouted = 0;
    let unordered = 0;
    const latencies = [];
    let totalDeliveriesReceived = 0;

    for (let i = 0; i < clients; i++) {
      const st = STATIONS[i % STATIONS.length];
      const sock = ClientIO(baseUrl, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        autoConnect: false,
        auth: { token: createToken({ username: 'benchmark', role: 'viewer' }) }
      });
      const client = { sock, stationId: st.id, received: 0, seq: 0 };

      sock.on('telemetry:batch', (batch) => {
        const now = Date.now();
        for (const row of batch) {
          const item = unpackReading(row);
          if (item.stationId !== client.stationId) misrouted++;
          if (item.seq <= client.seq) unordered++;
          client.seq = item.seq;
          client.received++;
          const lat = now - item.timestamp;
          if (lat >= 0 && lat < 60000) {
            latencies.push(lat);
          }
          totalDeliveriesReceived++;
        }
      });

      clientSockets.push(client);
    }

    // Wait for all clients to connect and subscribe
    await Promise.all(
      clientSockets.map(async ({ sock, stationId }) => {
        await new Promise((resolve, reject) => {
          sock.once('connect', resolve);
          sock.once('connect_error', reject);
          sock.connect();
        });
        const ack = await sock.timeout(3000).emitWithAck('subscribe:station', { stationId });
        if (ack.stationId !== stationId) throw new Error('Station subscription failed.');
      })
    );

    console.log(`[Bench] All ${clients} clients connected and subscribed to station rooms.`);
    console.log(`[Bench] Beginning high-throughput ingestion run (${seconds}s)...`);

    const startTime = performance.now();
    let totalPersisted = 0;
    let totalDuplicates = 0;
    const writes = [];
    for (let tick = 1; tick <= seconds * 10; tick++) {
      await sleep(Math.max(0, startTime + tick * 100 - performance.now()));
      const batchSize = Math.floor(tick * rate / 10) - attempted;
      if (!batchSize) continue;
      const now = Date.now();
      const events = [];

      for (let i = 0; i < batchSize; i++) {
        const st = STATIONS[attempted % STATIONS.length];
        stationCounts.set(st.id, stationCounts.get(st.id) + 1);
        events.push({
          stationId: st.id,
          eventId: 'bench-' + attempted++,
          timestamp: now,
          metrics: {
            waterLevel: 2.1 + (Math.random() - 0.5) * 0.4,
            outflow: 650 + (Math.random() - 0.5) * 100,
            vibration: 1.8 + (Math.random() - 0.5) * 0.3,
            current: 48 + (Math.random() - 0.5) * 5
          }
        });
      }

      const send = async () => {
        try {
          const res = await fetch(`${baseUrl}/api/ingest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${AGENT_BEARER_KEY}`
            },
            body: JSON.stringify(events),
            signal: AbortSignal.timeout(10000)
          });

          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          totalPersisted += (data.stored || 0);
          totalDuplicates += (data.duplicates || 0);
        } catch (error) {
          if (!failed) console.error('First failed batch:', error.message);
          failed += events.length;
        }
      };
      writes.push(send());
    }
    await Promise.all(writes);
    const actualDurationSec = (performance.now() - startTime) / 1000;

    // Allow tail broadcasts to settle
    console.log(`[Bench] Ingestion complete. Checking remaining Socket.IO deliveries...`);
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline &&
        clientSockets.some(client => client.received < stationCounts.get(client.stationId))) await sleep(25);
    const persistedCount = await mongo.db(databaseName).collection('readings').countDocuments();
    const expectedDeliveries = clientSockets.reduce((total, client) => total + stationCounts.get(client.stationId), 0);
    const measuredThroughput = Math.round(totalPersisted / actualDurationSec);

    latencies.sort((a, b) => a - b);
    const p50 = calculatePercentile(latencies, 50);
    const p90 = calculatePercentile(latencies, 90);
    const p95 = calculatePercentile(latencies, 95);
    const p99 = calculatePercentile(latencies, 99);

    // Print results
    console.log(`\n===============================================================`);
    console.log(`📊 BENCHMARK RESULTS SUMMARY`);
    console.log(`===============================================================`);
    console.log(`Target Ingest Rate      : ${rate} readings/s`);
    console.log(`Actual Test Duration    : ${actualDurationSec.toFixed(2)} s`);
    console.log(`Total Events Persisted  : ${totalPersisted.toLocaleString()} readings`);
    console.log(`Attempted / DB / Failed : ${attempted} / ${persistedCount} / ${failed}`);
    console.log(`Duplicates Handled      : ${totalDuplicates.toLocaleString()}`);
    console.log(`Total Client Deliveries : ${totalDeliveriesReceived} / ${expectedDeliveries}`);
    console.log(`Misrouted / Unordered   : ${misrouted} / ${unordered}`);
    console.log(`Measured Throughput     : ${measuredThroughput.toLocaleString()} readings/s`);
    console.log(`---------------------------------------------------------------`);
    console.log(`Socket.IO Latency Profile (Loopback):`);
    console.log(`  p50 (Median)          : ${p50} ms`);
    console.log(`  p90                   : ${p90} ms`);
    console.log(`  p95                   : ${p95} ms`);
    console.log(`  p99                   : ${p99} ms`);
    console.log(`===============================================================\n`);
    if (persistedCount !== attempted || totalPersisted !== persistedCount || failed || totalDuplicates ||
        totalDeliveriesReceived !== expectedDeliveries || misrouted || unordered ||
        clientSockets.some(client => client.received !== stationCounts.get(client.stationId))) process.exitCode = 1;
  } finally {
    for (const { sock } of clientSockets) sock.disconnect();
    await serverInstance.shutdown();
    try { await mongo.db(databaseName).dropDatabase(); }
    finally { await mongo.close(); }
  }
}

runBenchmark().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
