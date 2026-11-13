/**
 * Floodline - Express & Socket.IO Telemetry Monitoring Server
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
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
  USERS,
  TokenBucketRateLimiter
} from './security.mjs';
import { TelemetryStore } from './store.mjs';
import { TelemetrySimulator } from './simulator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/floodline';

export async function createServer({
  mongoUri = MONGO_URI,
  enableSimulator = true,
  simulatorRate = 288,
  seedInitialHistory = true
} = {}) {
  const app = express();
  const server = http.createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,
    pingTimeout: 5000
  });

  // Database Store
  const store = new TelemetryStore(mongoUri);
  await store.connect();
  if (seedInitialHistory) {
    await store.seedInitialHistoryIfNeeded();
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

  // System Performance Tracking
  const stats = {
    ingestEventsPerSec: 0,
    persistedPerSec: 0,
    broadcastPerSec: 0,
    connectedClients: 0,
    _ingestCount: 0,
    _persistedCount: 0,
    _broadcastCount: 0
  };

  const intervals = [];

  const statsInterval = setInterval(() => {
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
        io.to(`station:${stId}`).emit('telemetry:batch', batch);
      }
    }
  }, 50);
  intervals.push(broadcastInterval);

  // Fleet summary broadcast ticker: every 1000ms, broadcast overall health to all clients
  const fleetInterval = setInterval(() => {
    const stationSummaries = STATIONS.map(st => {
      const state = store.getStationState(st.id);
      return {
        id: st.id,
        name: st.name,
        code: st.code,
        severity: state ? state.severity : 'normal',
        waterLevel: state ? state.metrics.waterLevel : 0,
        outflow: state ? state.metrics.outflow : 0,
        vibration: state ? state.metrics.vibration : 0,
        current: state ? state.metrics.current : 0,
        anomalyReason: state ? state.anomalyReason : 'Nominal operating conditions',
        timestamp: state ? state.timestamp : Date.now(),
        seq: state ? state.seq : 0
      };
    });

    const activeFaults = simulator ? simulator.getActiveFaults() : [];

    const payload = {
      serverTime: Date.now(),
      latestSeq: store.getLatestSeq(),
      stations: stationSummaries,
      activeFaults,
      metrics: {
        throughputEventsSec: stats.ingestEventsPerSec || stats.persistedPerSec,
        persistedSec: stats.persistedPerSec,
        broadcastSec: stats.broadcastPerSec,
        queueLength: store.getQueueLength(),
        connectedClients: stats.connectedClients
      }
    };

    io.emit('fleet:summary', payload);
  }, 1000);
  intervals.push(fleetInterval);

  // Express Middlewares
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));

  // --- API Routes ---

  // Health
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      latestSeq: store.getLatestSeq(),
      queueLength: store.getQueueLength(),
      connectedClients: stats.connectedClients
    });
  });

  // Auth: Login
  app.post('/api/auth/login', (req, res) => {
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
      secure: false, // Local dev/demo friendly
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
    res.clearCookie('floodline_token');
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
    stats._ingestCount += events.length;

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
      const result = await store.enqueueBatch(events);
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
      return res.status(500).json({ error: 'Internal ingestion error' });
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
    const { stationId } = req.params;
    if (!STATION_MAP.has(stationId)) {
      return res.status(404).json({ error: `Station '${stationId}' not found` });
    }

    const from = req.query.from ? Number(req.query.from) : Date.now() - 5 * 60 * 1000;
    const to = req.query.to ? Number(req.query.to) : Date.now();
    const beforeSeq = req.query.beforeSeq != null ? Number(req.query.beforeSeq) : null;
    const maxPoints = req.query.maxPoints ? Number(req.query.maxPoints) : 500;
    const bucketMs = req.query.bucketMs ? Number(req.query.bucketMs) : null;

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
      const incident = await store.incidentsCol.findOne({ incidentId });
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      const padMs = 60 * 1000;
      const from = incident.startTime - padMs;
      const to = (incident.endTime || Date.now()) + padMs;

      const readings = await store.getStationHistory(incident.stationId, {
        from,
        to,
        maxPoints: 2000
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${incidentId}.csv"`);

      let csv = 'timestamp,iso_time,station_id,sequence,water_level_m,outflow_lps,vibration_mms,current_amps,severity,anomaly_reason\n';
      for (const r of readings) {
        const iso = new Date(r.timestamp).toISOString();
        csv += `${r.timestamp},"${iso}","${r.stationId}",${r.seq},${r.metrics.waterLevel},${r.metrics.outflow},${r.metrics.vibration},${r.metrics.current},"${r.severity}","${r.anomalyReason.replace(/"/g, '""')}"\n`;
      }

      res.send(csv);
    } catch (err) {
      console.error('[Export Error]', err);
      res.status(500).json({ error: 'Failed to export incident data' });
    }
  });

  // Simulator Rate Control: POST /api/simulator/rate
  app.post('/api/simulator/rate', authenticate, requireRole('operator'), (req, res) => {
    if (!simulator) {
      return res.status(400).json({ error: 'Simulator is not active on this server' });
    }
    const { rate } = req.body || {};
    const targetRate = Number(rate);
    if (!Number.isFinite(targetRate) || targetRate < 6 || targetRate > 10000) {
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
    if (!STATION_MAP.has(stationId)) {
      return res.status(400).json({ error: `Invalid stationId '${stationId}'` });
    }

    try {
      simulator.triggerFault(stationId, type, Number(durationSeconds));
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
  app.get('/api/system/metrics', (req, res) => {
    res.json({
      timestamp: Date.now(),
      latestSeq: store.getLatestSeq(),
      queueLength: store.getQueueLength(),
      throughputEventsSec: stats.ingestEventsPerSec,
      persistedSec: stats.persistedPerSec,
      broadcastSec: stats.broadcastPerSec,
      connectedClients: stats.connectedClients,
      simulatorRate: simulator ? simulator.targetRate : 0
    });
  });

  // Socket.IO Subscription Management
  io.on('connection', (socket) => {
    stats.connectedClients++;
    let subscribedStation = null;

    // Handshake & Station Subscription
    socket.on('subscribe:station', (data, callback) => {
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

  async function shutdown() {
    for (const inv of intervals) {
      clearInterval(inv);
    }
    if (simulator) {
      simulator.stop();
    }
    io.close();
    await store.close();
    await new Promise((resolve) => server.close(resolve));
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
  createServer({
    mongoUri: MONGO_URI,
    enableSimulator: true,
    simulatorRate: process.env.SIMULATOR_RATE ? Number(process.env.SIMULATOR_RATE) : 288
  }).then(({ server }) => {
    server.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`🌊 FLOODLINE SCADA Telemetry Server Running on Port ${PORT}`);
      console.log(`   Database: ${MONGO_URI}`);
      console.log(`   Demo Mode: ${process.env.DEMO_MODE !== 'false' ? 'ACTIVE (Instant Operator Access)' : 'SECURE'}`);
      console.log(`   Web Console: http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
  }).catch(err => {
    console.error('Fatal Server Startup Error:', err);
    process.exit(1);
  });
}
