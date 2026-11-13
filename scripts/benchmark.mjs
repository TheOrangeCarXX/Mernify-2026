/**
 * Floodline - High-Throughput Telemetry Benchmark & Stress Test Harness
 * Evaluates persistence throughput, Socket.IO broadcast fanout, and tail latency (p50, p95, p99)
 *
 * Usage:
 *   node scripts/benchmark.mjs --rate=3000 --seconds=30 --clients=48
 *   node scripts/benchmark.mjs --rate=6000 --seconds=30 --clients=96
 */

import { io as ClientIO } from 'socket.io-client';
import { STATIONS, unpackReading } from '../shared/telemetry.mjs';
import { AGENT_BEARER_KEY } from '../server/security.mjs';
import { createServer } from '../server/index.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    rate: 3000,
    seconds: 10,
    clients: 48,
    port: 3000
  };

  for (const arg of args) {
    if (arg.startsWith('--rate=')) params.rate = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--seconds=')) params.seconds = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--clients=')) params.clients = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--port=')) params.port = parseInt(arg.split('=')[1], 10);
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

  // Check if server is already running on port, or start an internal benchmark server
  let serverInstance = null;
  let baseUrl = `http://localhost:${port}`;

  try {
    const healthCheck = await fetch(`${baseUrl}/api/health`);
    if (healthCheck.ok) {
      console.log(`[Bench] Connected to active server at ${baseUrl}`);
    }
  } catch {
    console.log(`[Bench] No running server detected. Initializing benchmark server on port ${port}...`);
    serverInstance = await createServer({
      enableSimulator: false, // We will drive ingestion directly at targetRate
      simulatorRate: 0,
      seedInitialHistory: false
    });
    await new Promise((res) => serverInstance.server.listen(port, res));
    console.log(`[Bench] Benchmark server active on port ${port}`);
  }

  // Connect Socket.IO clients distributed across stations
  console.log(`[Bench] Connecting ${clients} Socket.IO subscribers...`);
  const clientSockets = [];
  const latencies = [];
  let totalDeliveriesReceived = 0;

  for (let i = 0; i < clients; i++) {
    const st = STATIONS[i % STATIONS.length];
    const sock = ClientIO(baseUrl, {
      transports: ['websocket'],
      forceNew: true
    });

    sock.on('telemetry:batch', (batch) => {
      const now = Date.now();
      for (const row of batch) {
        const item = unpackReading(row);
        const lat = now - item.timestamp;
        if (lat >= 0 && lat < 60000) {
          latencies.push(lat);
        }
        totalDeliveriesReceived++;
      }
    });

    clientSockets.push({ sock, stationId: st.id });
  }

  // Wait for all clients to connect and subscribe
  await Promise.all(
    clientSockets.map(({ sock, stationId }) => {
      return new Promise((resolve) => {
        sock.on('connect', () => {
          sock.emit('subscribe:station', { stationId }, resolve);
        });
      });
    })
  );

  console.log(`[Bench] All ${clients} clients connected and subscribed to station rooms.`);
  console.log(`[Bench] Beginning high-throughput ingestion run (${seconds}s)...`);

  const startTime = Date.now();
  const endTime = startTime + seconds * 1000;
  let totalPersisted = 0;
  let totalDuplicates = 0;
  let batchSeq = 0;

  const batchSize = Math.min(250, Math.max(50, Math.floor(rate / 20))); // ~20 batches per second
  const batchIntervalMs = Math.floor(1000 / (rate / batchSize));

  const ingestPromise = new Promise((resolveIngest) => {
    const ingestTimer = setInterval(async () => {
      if (Date.now() >= endTime) {
        clearInterval(ingestTimer);
        resolveIngest();
        return;
      }

      batchSeq++;
      const now = Date.now();
      const events = [];

      for (let i = 0; i < batchSize; i++) {
        const st = STATIONS[i % STATIONS.length];
        events.push({
          stationId: st.id,
          eventId: `bench_${batchSeq}_${i}_${now}`,
          timestamp: now,
          metrics: {
            waterLevel: 2.1 + (Math.random() - 0.5) * 0.4,
            outflow: 650 + (Math.random() - 0.5) * 100,
            vibration: 1.8 + (Math.random() - 0.5) * 0.3,
            current: 48 + (Math.random() - 0.5) * 5
          }
        });
      }

      try {
        const res = await fetch(`${baseUrl}/api/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AGENT_BEARER_KEY}`
          },
          body: JSON.stringify(events)
        });

        if (res.ok) {
          const data = await res.json();
          totalPersisted += (data.stored || 0);
          totalDuplicates += (data.duplicates || 0);
        }
      } catch (err) {
        // network error during benchmark
      }
    }, batchIntervalMs);
  });

  await ingestPromise;

  // Allow tail broadcasts to settle
  console.log(`[Bench] Ingestion complete. Draining pending Socket.IO broadcast deliveries (1.5s)...`);
  await new Promise((r) => setTimeout(r, 1500));

  const actualDurationSec = (Date.now() - startTime) / 1000;
  const measuredThroughput = Math.round(totalPersisted / actualDurationSec);

  latencies.sort((a, b) => a - b);
  const p50 = calculatePercentile(latencies, 50);
  const p90 = calculatePercentile(latencies, 90);
  const p95 = calculatePercentile(latencies, 95);
  const p99 = calculatePercentile(latencies, 99);

  // Disconnect clients
  for (const { sock } of clientSockets) {
    sock.disconnect();
  }

  if (serverInstance) {
    await serverInstance.shutdown();
  }

  // Print results
  console.log(`\n===============================================================`);
  console.log(`📊 BENCHMARK RESULTS SUMMARY`);
  console.log(`===============================================================`);
  console.log(`Target Ingest Rate      : ${rate} readings/s`);
  console.log(`Actual Test Duration    : ${actualDurationSec.toFixed(2)} s`);
  console.log(`Total Events Persisted  : ${totalPersisted.toLocaleString()} readings`);
  console.log(`Duplicates Handled      : ${totalDuplicates.toLocaleString()}`);
  console.log(`Total Client Deliveries : ${totalDeliveriesReceived.toLocaleString()} received`);
  console.log(`Measured Throughput     : ${measuredThroughput.toLocaleString()} readings/s`);
  console.log(`---------------------------------------------------------------`);
  console.log(`Socket.IO Latency Profile (Loopback):`);
  console.log(`  p50 (Median)          : ${p50} ms`);
  console.log(`  p90                   : ${p90} ms`);
  console.log(`  p95                   : ${p95} ms`);
  console.log(`  p99                   : ${p99} ms`);
  console.log(`===============================================================\n`);
}

runBenchmark().catch((err) => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
