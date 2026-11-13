/**
 * Floodline - Express & Socket.IO Telemetry Monitoring Server
 */

import 'dotenv/config';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { Server as SocketIOServer } from 'socket.io';

import { STATIONS, STATION_MAP, packReading } from '../shared/telemetry.mjs';
import { validateIngestBatch } from './validation.mjs';
import {
  authenticate,
  authenticateIngest,
  requireRole,
  createToken,
  verifyToken,
  validateHostedCredentials,
  USERS,
  TokenBucketRateLimiter
} from './security.mjs';
import { TelemetryStore } from './store.mjs';
import { TelemetrySimulator } from './simulator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/floodline';
const STALE_AFTER_MS = 15_000;

function originMatchesHost(origin, host) {
  try { return new URL(origin).host === host; }
  catch { return false; }
}

export async function createServer({
  mongoUri = MONGO_URI,
  enableSimulator = true,
  simulatorRate = 288,
  seedInitialHistory = true
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (!Number.isInteger(simulatorRate) || (enableSimulator && (simulatorRate < 6 || simulatorRate > 10_000))) {
    throw new Error('SIMULATOR_RATE must be an integer from 6 to 10,000 readings/s.');
  }
  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    allowRequest: (req, done) => {
      const { origin, host } = req.headers;
      done(null, !origin || origin === process.env.APP_ORIGIN || originMatchesHost(origin, host));
    },
    cors: {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout: 5000
  });

  // Database Store
  const store = new TelemetryStore(mongoUri);
  try {
    await store.connect();
    if (seedInitialHistory) await store.seedInitialHistoryIfNeeded();
  } catch (error) {
    await store.close();
    throw error;
  }

  // Telemetry Simulator
  let simulator = null;
  if (enableSimulator) {
    simulator = new TelemetrySimulator(store, { targetRate: simulatorRate });
    simulator.start();
  }

  // Rate Limiter for Ingestion
  const ingestRateLimiter = new TokenBucketRateLimiter({
    capacity: 200, // Max burst requests
    refillRate: 50, // 50 req/sec
    eventCapacity: 10000, // Max burst events
    eventRefillRate: 5000 // 5000 events/sec
  });
  const loginRateLimiter = new TokenBucketRateLimiter({
    capacity: 12, refillRate: 0.2, eventCapacity: 12, eventRefillRate: 0.2
  });
  const historyRateLimiter = new TokenBucketRateLimiter({
    capacity: 24, refillRate: 8, eventCapacity: 24, eventRefillRate: 8
  });

  // System Performance Tracking
  const stats = {
    ingestEventsPerSec: 0,
    persistedPerSec: 0,
    broadcastPerSec: 0,
    simulatorPerSec: 0,
    connectedClients: 0,
    _ingestCount: 0,
    _persistedCount: 0,
    _broadcastCount: 0
  };

  const intervals = [];
  let lastGenerated = 0;

  const statsInterval = setInterval(() => {
    const generated = simulator?.generatedEvents ?? 0;
    stats.simulatorPerSec = generated - lastGenerated;
    lastGenerated = generated;
    stats.ingestEventsPerSec = stats._ingestCount;
    stats.persistedPerSec = stats._persistedCount;
    stats.broadcastPerSec = stats._broadcastCount;
    stats._ingestCount = 0;
    stats._persistedCount = 0;
    stats._broadcastCount = 0;
  }, 1000);
  intervals.push(statsInterval);

  // Buffer committed readings for efficient batched Socket.IO broadcasts
  const broadcastBuffers = new Map(); // stationId -> array of packed readings
  for (const st of STATIONS) {
    broadcastBuffers.set(st.id, []);
  }

  store.onCommitted = (newlyCommittedDocs) => {
    stats._persistedCount += newlyCommittedDocs.length;
    for (const doc of newlyCommittedDocs) {
      const buf = broadcastBuffers.get(doc.stationId);
      if (buf) {
        buf.push(packReading(doc));
      }
    }
  };

  // Broadcast ticker: every 50ms, flush buffered packed readings to station rooms
  const broadcastInterval = setInterval(() => {
    for (const [stId, buf] of broadcastBuffers.entries()) {
      if (buf.length > 0) {
        const batch = buf.splice(0, buf.length);
        stats._broadcastCount += batch.length;
        const room = `station:${stId}`;
        for (const id of io.sockets.adapter.rooms.get(room) ?? []) {
          const socket = io.sockets.sockets.get(id);
          if (socket?.conn.writeBuffer.length > 48) socket.conn.close(true);
        }
        io.to(room).emit('telemetry:batch', batch);
      }
    }
  }, 50);
  intervals.push(broadcastInterval);

  // Fleet summary broadcast ticker: every 1000ms, broadcast overall health to all clients
  const fleetInterval = setInterval(() => {
    const serverTime = Date.now();
    const stationSummaries = STATIONS.map(st => {
      const state = store.getStationState(st.id);
      return {
        id: st.id,
        name: st.name,
        code: st.code,
        severity: state?.timestamp && serverTime - state.timestamp <= STALE_AFTER_MS ? state.severity : 'offline',
        waterLevel: state ? state.metrics.waterLevel : 0,
        outflow: state ? state.metrics.outflow : 0,
        vibration: state ? state.metrics.vibration : 0,
        current: state ? state.metrics.current : 0,
        anomalyReason: state ? state.anomalyReason : 'Nominal operating conditions',
        timestamp: state?.timestamp || null,
        seq: state ? state.seq : 0
      };
    });

    const activeFaults = simulator ? simulator.getActiveFaults() : [];

    const payload = {
      serverTime,
      latestSeq: store.getLatestSeq(),
      stations: stationSummaries,
      activeFaults,
      metrics: {
        storageReady: !store.lastWriteFailed,
        simulatorRate: simulator?.targetRate ?? 0,
        simulatorDroppedEvents: simulator?.droppedEvents ?? 0,
        throughputEventsSec: stats.ingestEventsPerSec + stats.simulatorPerSec,
        persistedSec: stats.persistedPerSec,
        broadcastSec: stats.broadcastPerSec,
        queueLength: store.getQueueLength(),
        connectedClients: stats.connectedClients
      }
    };

    io.volatile.emit('fleet:summary', payload);
  }, 1000);
  intervals.push(fleetInterval);

  // Express Middlewares
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== process.env.APP_ORIGIN && !originMatchesHost(origin, req.get('host'))) {
      return res.status(403).json({ error: 'This origin cannot access Floodline.' });
    }
    next();
  });
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));

  // --- API Routes ---

  // Health
  app.get('/api/health', (req, res) => {
    res.status(store.lastWriteFailed ? 503 : 200).json({
      status: store.lastWriteFailed ? 'degraded' : 'healthy',
      uptime: process.uptime(),
      latestSeq: store.getLatestSeq(),
      queueLength: store.getQueueLength(),
      connectedClients: stats.connectedClients
    });
  });

  // Auth: Login
  app.post('/api/auth/login', (req, res) => {
    const rate = loginRateLimiter.tryConsume(req.ip);
    if (!rate.allowed) return res.set('Retry-After', String(rate.retryAfterSec)).status(429)
      .json({ error: 'Too many login attempts. Try again shortly.' });
    const { username, password } = req.body || {};
    const user = USERS.find(u => u.username === username && u.password === password);

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createToken({
      username: user.username,
      role: user.role,
      displayName: user.displayName
    });

    res.cookie('floodline_token', token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000
    });

    res.json({
      token,
      user: {
        username: user.username,
        role: user.role,
        displayName: user.displayName
      }
    });
  });

  // Auth: Me
  app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ user: req.user });
  });

  // Auth: Logout
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('floodline_token', {
      httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax'
    });
    res.json({ message: 'Logged out successfully' });
  });

  // Telemetry Ingestion: POST /api/ingest
  app.post('/api/ingest', authenticateIngest, async (req, res) => {
    const clientId = req.user ? req.user.username : (req.ip || 'anonymous-agent');

    // Validate payload structure & values
    const validation = validateIngestBatch(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const events = validation.events;

    // Rate Limiting Check
    const rateCheck = ingestRateLimiter.tryConsume(clientId, events.length);
    if (!rateCheck.allowed) {
      res.set('Retry-After', String(rateCheck.retryAfterSec || 1));
      return res.status(429).json({
        error: `Rate limit exceeded: ${rateCheck.reason}. Retry after ${rateCheck.retryAfterSec}s.`,
        retryAfter: rateCheck.retryAfterSec
      });
    }

    // Submit batch into bounded persistence write queue
    try {
      const write = store.enqueueBatch(events);
      stats._ingestCount += events.length;
      const result = await write;
      return res.status(200).json({
        success: true,
        stored: result.stored,
        duplicates: result.duplicates,
        latestSeq: result.latestSeq
      });
    } catch (err) {
      if (err.code === 'QUEUE_OVERLOAD') {
        res.set('Retry-After', '1');
        return res.status(503).json({
          error: 'Service Unavailable: Ingest queue overloaded. Apply backpressure and retry.',
          retryAfter: 1
        });
      }
      console.error('[Ingest Error]', err);
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'Ingestion temporarily unavailable. Retry with the same event IDs.' });
    }
  });

  // Stations Roster & State: GET /api/stations
  app.get('/api/stations', authenticate, (req, res) => {
    const list = STATIONS.map(st => {
      const liveState = store.getStationState(st.id);
      return {
        ...st,
        state: liveState || null
      };
    });
    res.json({ stations: list, latestSeq: store.getLatestSeq() });
  });

  // Station History: GET /api/stations/:stationId/history
  app.get('/api/stations/:stationId/history', authenticate, async (req, res) => {
    const rate = historyRateLimiter.tryConsume(req.ip);
    if (!rate.allowed) return res.set('Retry-After', String(rate.retryAfterSec)).status(429)
      .json({ error: 'Too many history requests. Try again shortly.' });
    const { stationId } = req.params;
    if (!STATION_MAP.has(stationId)) {
      return res.status(404).json({ error: `Station '${stationId}' not found` });
    }

    const to = req.query.to ? Number(req.query.to) : Date.now();
    const from = req.query.from ? Number(req.query.from) : to - 5 * 60 * 1000;
    const beforeSeq = req.query.beforeSeq != null ? Number(req.query.beforeSeq) : null;
    const maxPoints = req.query.maxPoints ? Number(req.query.maxPoints) : 500;
    const bucketMs = req.query.bucketMs ? Number(req.query.bucketMs) : null;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to ||
        from < 0 || to - from > 7 * 24 * 60 * 60 * 1000 ||
        (beforeSeq !== null && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) ||
        !Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 2000 ||
        (bucketMs !== null && (!Number.isSafeInteger(bucketMs) || bucketMs < 1))) {
      return res.status(400).json({ error: 'Invalid history time range, sequence, or point limit.' });
    }

    try {
      const readings = await store.getStationHistory(stationId, {
        from,
        to,
        beforeSeq,
        maxPoints,
        bucketMs
      });
      res.json({
        stationId,
        from,
        to,
        beforeSeq,
        count: readings.length,
        readings
      });
    } catch (err) {
      console.error('[History API Error]', err);
      res.status(500).json({ error: 'Failed to retrieve historical telemetry' });
    }
  });

  // Incidents: GET /api/incidents
  app.get('/api/incidents', authenticate, async (req, res) => {
    const stationId = req.query.stationId || null;
    try {
      const incidents = await store.getIncidents(stationId, 25);
      res.json({ incidents });
    } catch (err) {
      res.status(500).json({ error: 'Failed to retrieve incidents' });
    }
  });

  // Export Incident Telemetry: GET /api/incidents/:incidentId/export
  app.get('/api/incidents/:incidentId/export', authenticate, async (req, res) => {
    const { incidentId } = req.params;
    try {
      const incident = await store.getIncident(incidentId);
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      const padMs = 60 * 1000;
      const from = incident.startTime - padMs;
      const to = (incident.endTime || Date.now()) + padMs;

      const readings = store.readingsCol.find({
        stationId: incident.stationId,
        timestamp: { $gte: from, $lte: to }
      }).sort({ timestamp: 1, seq: 1 }).batchSize(500);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${incidentId}.csv"`);
      res.setHeader('Cache-Control', 'no-store');

      async function* csvRows() {
        try {
          yield 'timestamp,iso_time,station_id,sequence,water_level_m,outflow_lps,vibration_mms,current_amps,severity,anomaly_reason\n';
          for await (const r of readings) {
            const iso = new Date(r.timestamp).toISOString();
            yield `${r.timestamp},"${iso}","${r.stationId}",${r.seq},${r.metrics.waterLevel},${r.metrics.outflow},${r.metrics.vibration},${r.metrics.current},"${r.severity}","${r.anomalyReason.replace(/"/g, '""')}"\n`;
          }
        } finally {
          await readings.close();
        }
      }
      await pipeline(Readable.from(csvRows()), res);
    } catch (err) {
      if (req.aborted || err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      console.error('[Export Error]', err);
      if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'Failed to export incident data' });
    }
  });

  // Simulator Rate Control: POST /api/simulator/rate
  app.post('/api/simulator/rate', authenticate, requireRole('operator'), (req, res) => {
    if (!simulator) {
      return res.status(400).json({ error: 'Simulator is not active on this server' });
    }
    const { rate } = req.body || {};
    const targetRate = Number(rate);
    if (!Number.isInteger(targetRate) || targetRate < 6 || targetRate > 10000) {
      return res.status(400).json({ error: 'Simulator rate must be a number between 6 and 10000 readings/s' });
    }

    simulator.setRate(targetRate);
    res.json({
      success: true,
      rate: simulator.targetRate,
      message: `Simulator rate updated to ${simulator.targetRate} readings/second`
    });
  });

  // Fault Injections: POST /api/faults/trigger
  app.post('/api/faults/trigger', authenticate, requireRole('operator'), (req, res) => {
    if (!simulator) {
      return res.status(400).json({ error: 'Simulator is not enabled on this server' });
    }
    const { stationId, type, durationSeconds = 60 } = req.body || {};
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
      return res.status(400).json({ error: 'Fault duration must be from 1 to 300 seconds.' });
    }
    if (!STATION_MAP.has(stationId)) {
      return res.status(400).json({ error: `Invalid stationId '${stationId}'` });
    }

    try {
      simulator.triggerFault(stationId, type, durationSeconds);
      res.json({
        success: true,
        message: `Fault '${type}' triggered on station '${stationId}' for ${durationSeconds} seconds`,
        activeFaults: simulator.getActiveFaults()
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Fault Clear: POST /api/faults/clear
  app.post('/api/faults/clear', authenticate, requireRole('operator'), (req, res) => {
    if (!simulator) {
      return res.status(400).json({ error: 'Simulator is not enabled' });
    }
    const { stationId } = req.body || {};
    if (!STATION_MAP.has(stationId)) return res.status(400).json({ error: 'Choose a valid station.' });
    simulator.clearFault(stationId);
    res.json({
      success: true,
      message: `Cleared fault on station '${stationId}'`,
      activeFaults: simulator.getActiveFaults()
    });
  });

  // Active Faults: GET /api/faults
  app.get('/api/faults', authenticate, (req, res) => {
    const active = simulator ? simulator.getActiveFaults() : [];
    res.json({ activeFaults: active });
  });

  // System Metrics: GET /api/system/metrics
  app.get('/api/system/metrics', authenticate, (req, res) => {
    res.json({
      timestamp: Date.now(),
      latestSeq: store.getLatestSeq(),
      queueLength: store.getQueueLength(),
      throughputEventsSec: stats.ingestEventsPerSec + stats.simulatorPerSec,
      persistedSec: stats.persistedPerSec,
      broadcastSec: stats.broadcastPerSec,
      connectedClients: stats.connectedClients,
      simulatorRate: simulator ? simulator.targetRate : 0,
      simulatorDroppedEvents: simulator?.droppedEvents ?? 0
    });
  });

  // Socket.IO Subscription Management
  io.use((socket, next) => {
    const cookie = socket.request.headers.cookie?.split(';')
      .map(part => part.trim()).find(part => part.startsWith('floodline_token='));
    const token = socket.handshake.auth?.token || cookie?.slice('floodline_token='.length);
    if (!token && process.env.DEMO_MODE !== 'false') return next();
    const user = token && verifyToken(token);
    if (!user || !['viewer', 'operator'].includes(user.role)) {
      return next(new Error('A viewer or operator session is required.'));
    }
    socket.data.sessionExpiresAt = user.exp * 1000;
    next();
  });

  io.on('connection', (socket) => {
    stats.connectedClients++;
    let subscribedStation = null;
    const subscriptions = new TokenBucketRateLimiter({
      capacity: 16, refillRate: 6, eventCapacity: 16, eventRefillRate: 6
    });
    const expiryTimer = socket.data.sessionExpiresAt
      ? setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.sessionExpiresAt - Date.now()))
      : null;

    // Handshake & Station Subscription
    socket.on('subscribe:station', (data, callback) => {
      if (!subscriptions.tryConsume('socket').allowed) {
        if (typeof callback === 'function') callback({ error: 'Too many station changes. Try again shortly.' });
        return;
      }
      const stationId = typeof data === 'string' ? data : data?.stationId;
      if (!STATION_MAP.has(stationId)) {
        if (typeof callback === 'function') callback({ error: `Unknown stationId '${stationId}'` });
        return;
      }

      // Leave previous station room if any
      if (subscribedStation && subscribedStation !== stationId) {
        socket.leave(`station:${subscribedStation}`);
      }

      subscribedStation = stationId;
      socket.join(`station:${stationId}`);

      const ackPayload = {
        stationId,
        serverTime: Date.now(),
        latestSeq: store.getLatestSeq(),
        state: store.getStationState(stationId)
      };

      if (typeof callback === 'function') {
        callback(ackPayload);
      } else {
        socket.emit('subscription:ack', ackPayload);
      }
    });

    socket.on('unsubscribe:station', () => {
      if (subscribedStation) {
        socket.leave(`station:${subscribedStation}`);
        subscribedStation = null;
      }
    });

    socket.on('disconnect', () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      stats.connectedClients = Math.max(0, stats.connectedClients - 1);
    });
  });

  // Serve Built Frontend Assets
  const distPath = path.join(projectRoot, 'dist');
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  let shuttingDown;
  function shutdown() {
    shuttingDown ??= closeResources();
    return shuttingDown;
  }

  async function closeResources() {
    for (const inv of intervals) {
      clearInterval(inv);
    }
    if (simulator) {
      simulator.stop();
    }
    const closed = new Promise(resolve => io.close(resolve));
    await store.close();
    await closed;
  }

  return { app, server, io, store, simulator, stats, shutdown };
}

// Start Server when invoked directly
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('server\\index.mjs') ||
  process.argv[1].endsWith('server/index.mjs') ||
  process.argv[1].endsWith('index.mjs')
);

if (isDirectRun && process.env.NODE_ENV !== 'test' && (!process.env.TEST_MODE || process.env.TEST_MODE === 'false')) {
  Promise.resolve().then(() => {
    validateHostedCredentials(HOST);
    return createServer({
      mongoUri: MONGO_URI,
      enableSimulator: true,
      simulatorRate: process.env.SIMULATOR_RATE ? Number(process.env.SIMULATOR_RATE) : 288
    });
  }).then(({ server, shutdown }) => {
    server.listen(PORT, HOST, () => {
      console.log(`=======================================================`);
      console.log(`🌊 FLOODLINE SCADA Telemetry Server Running on Port ${PORT}`);
      console.log(`   Demo Mode: ${process.env.DEMO_MODE !== 'false' ? 'ACTIVE (Instant Operator Access)' : 'SECURE'}`);
      console.log(`   Web Console: http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  }).catch(err => {
    console.error('Fatal Server Startup Error:', err);
    process.exit(1);
  });
}
