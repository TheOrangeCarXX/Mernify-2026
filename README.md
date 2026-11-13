# Floodline: Real-Time SCADA Stormwater Telemetry Platform

> **MERNIFY Hackathon 2026** — *High-Throughput Streams & Telemetry Track*  
> Built with **MongoDB, Express.js, React.js, Node.js, and Socket.IO**.

Floodline is a production-grade, real-time telemetry monitoring console and supervisory control system engineered for six distributed stormwater pump stations. When severe weather hits, operators must immediately identify which pump station is in distress, distinguish rising retention basin levels (flooding risk) from pump mechanical faults (vibration/motor current overload), and review historical incident progression without interrupting live surveillance.

---

## Key Features

1. **High-Throughput Ingestion & 16,000-Event Backpressure**:
   - Continuous simulation streaming **288 readings/second** across six stations (48 Hz per station), tested up to **6,000 readings/second**.
   - Authenticated external ingestion (`POST /api/ingest`) secured by an Agent Bearer key or Operator session.
   - Bounded in-memory FIFO write queue (16,000 capacity). Overloaded queues return retryable `HTTP 503 Service Unavailable`.
   - Token-bucket rate limiting (requests/s and event volume/s) returning `HTTP 429 Too Many Requests`.

2. **MongoDB Bulk Upserts & Fault Classification**:
   - 100 ms flush cadence executing bulk upserts (`$setOnInsert`) with compound unique index `{ stationId: 1, eventId: 1 }`. Retried event IDs are completely idempotent.
   - Monotonic commit sequence (`seq`) and 7-day TTL retention index.
   - **Timestamp first, sequence second** evaluation: late-arriving samples update historical records without rolling back the latest station health.
   - Distinguishes **Storm Surge** (high water level), **Intake Blockage** (high water + collapsed outflow), and **Pump Motor Overload** (high vibration / overcurrent).

3. **History-to-Live Cursor Handshake Protocol**:
   - Clients join selective Socket.IO rooms (`station:${stationId}`).
   - Subscription acknowledgment returns `{ serverTime, latestSeq }`.
   - Client requests historical MongoDB buckets through `latestSeq` while buffering incoming live packets.
   - Series manager merges history with buffered packets (`seq > latestSeq`) without duplicate points or visual gaps.
   - Reconnecting clients backfill missed readings automatically.

4. **Operator SCADA Console & Visualizations**:
   - **Interactive Basin Schematic**: SVG diagram showing catchment topology, water flow paths, live water level indicators, and clickable station nodes.
   - **High-Performance Canvas Telemetry Plot**: Multi-channel rendering (Water Level, Outflow, Vibration, Current) with threshold guide lines, anomaly highlight bands, and interactive crosshair scrubbing.
   - **Incident Timeline**: Historical alert episodes with one-click replay locking the chart to the incident period.
   - **Client Throttling (4 Hz)**: Chart repaints are throttled to 250 ms, keeping browser CPU usage below 3%.
   - **Mobile SCADA Viewport**: Fully responsive on **390px** mobile viewports for on-call field operators.

---

## System Architecture

```mermaid
flowchart LR
    A["Telemetry Ingestion<br/>(Simulator & Agents)"] -->|Auth & Rate Limit| Q["16k Bounded Queue"]
    Q -->|100ms Flush Cadence| P["Condition Classifier<br/>& Bulk Upsert"]
    P --> DB[("MongoDB<br/>readings / state")]
    P -->|Wire Compactor| IO["Socket.IO Server<br/>(station:id & fleet)"]
    IO --> C1["Client 1: Canal Junction"]
    IO --> C2["Client 2: East Sluice"]
```

---

## Tech Stack

- **Backend**: Node.js (v25 ESM), Express.js 4.x
- **Real-Time Transport**: Socket.IO 4.x (WebSockets & polling fallback)
- **Database**: MongoDB 8.0 (Native `mongodb` driver 6.x)
- **Frontend**: React 18, Vite 6, TailwindCSS, Lucide Icons, HTML5 Canvas
- **Security**: JSON Web Tokens (`jsonwebtoken`), Cookie-parser, Token Bucket rate limiting
- **Testing & Verification**: Node.js Test Runner (`node --test`), `puppeteer-core` (Edge / Chrome)

---

## Quick Start & Setup

### Prerequisites
- Node.js >= 20.x (Node 25 recommended)
- MongoDB Server running locally on `localhost:27017` (or via Docker)

### 1. Start MongoDB (if using Docker)
```sh
docker compose up -d --wait mongo
```

### 2. Install Dependencies & Build Frontend
```sh
npm install
npm run build
```

### 3. Run Unit and Integration Tests
```sh
# Run 6 unit tests (validation, rate limiting, anomaly classification, packing, merge, security)
npm test

# Run 6 MongoDB integration tests (access control, room isolation, retries, late readings, backfill, restart)
npm run test:integration
```

### 4. Run Benchmarks
```sh
# 48 clients, 3,000 readings/s target (Headline Run)
npm run bench -- --rate=3000 --seconds=30 --clients=48

# 96 clients, 6,000 readings/s target (Stress Run)
npm run bench -- --rate=6000 --seconds=30 --clients=96
```

### 5. Start Application
```sh
npm start
```
Open **`http://localhost:3000`** in your browser.

---

## Benchmark Results

Conducted on a single Windows host against MongoDB Community 8.0 over loopback interface:

| Run | Persisted | Deliveries Received | Measured Throughput | p95 Latency |
|---|---|---|---|---|
| **48 clients, 3,000 rps (30s)** | 90,000 / 90,000 | 720,000 / 720,000 | **3,000 readings/s** | **183 ms** |
| **96 clients, 6,000 rps (30s)** | 180,000 / 180,000 | 2,880,000 / 2,880,000 | **5,801 readings/s** | **1,434 ms** |

*Zero missed, duplicate, or misrouted deliveries across both runs.*

---

## API & Protocol Reference

### REST Endpoints
- `POST /api/ingest`: Ingest telemetry batch (up to 500 events). Requires `Authorization: Bearer floodline-agent-key-2026`.
- `GET /api/stations`: Retrieve all 6 stations with their metadata and current state.
- `GET /api/stations/:stationId/history`: Retrieve historical telemetry within `[from, to]` with optional `beforeSeq` and `bucketMs`.
- `GET /api/incidents`: Retrieve active and archived incident episodes.
- `POST /api/faults/trigger`: Operator fault injection (`storm-surge`, `intake-blockage`, `motor-overload`).
- `POST /api/faults/clear`: Clear active faults on station.
- `GET /api/system/metrics`: Real-time ingestion and broadcast performance statistics.
- `GET /api/health`: Health status, server uptime, and latest committed sequence.

### Socket.IO Protocol
- `subscribe:station` `{ stationId }` ➔ Returns `{ stationId, serverTime, latestSeq, state }`.
- `telemetry:batch` ➔ Compact rows `[stationId, eventId, timestamp, seq, waterLevel, outflow, vibration, current, severity, anomalyReason]`.
- `fleet:summary` ➔ Decoupled 1 Hz global broadcast containing network health, active alerts, and station summaries.

---

## Demo Credentials & Access Roles

- **Operator**: `operator` / `operator123` (Full control, fault injection, diagnostics)
- **Viewer**: `viewer` / `viewer123` (Read-only observation and history review)
- **Agent Bearer Key**: `floodline-agent-key-2026`
- *Note: In demo mode (`DEMO_MODE=true`, default), visiting the web console automatically assigns an Operator session for seamless judging.*

---

## Attribution & External Libraries

- **MongoDB Node Driver**: MongoDB Inc. (Apache-2.0)
- **Socket.IO**: Guillermo Rauch & Socket.IO contributors (MIT)
- **Express.js**: StrongLoop / OpenJS Foundation (MIT)
- **React**: Meta Platforms, Inc. (MIT)
- **Vite**: Evan You & Vite contributors (MIT)
- **Lucide Icons**: Lucide contributors (ISC)
- **TailwindCSS**: Tailwind Labs, Inc. (MIT)
- **Puppeteer-Core**: Google LLC (Apache-2.0)
