# Floodline: Real-Time SCADA Stormwater Telemetry Platform

> **MERNIFY Hackathon 2026** — *High-Throughput Streams & Telemetry Track*  
> Built with **MongoDB Atlas, Express.js, React.js, Node.js, and Socket.IO**.

[![Live Cloud Deployment](https://img.shields.io/badge/Live%20Demo-Render%20Cloud-00E599?style=for-the-badge&logo=render&logoColor=white)](https://floodline-scada-bi5i.onrender.com)
[![YouTube Video Demo](https://img.shields.io/badge/YouTube-Video%20Walkthrough-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtu.be/fHE2_kdWtQ8)
[![Database](https://img.shields.io/badge/Database-MongoDB%20Atlas-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/cloud/atlas)

[![Unit Tests](https://img.shields.io/badge/Unit%20Tests-7%2F7%20Passed-emerald.svg)](test/unit.test.mjs)
[![Integration Tests](https://img.shields.io/badge/Integration%20Tests-9%2F9%20Passed-emerald.svg)](test/integration.test.mjs)
[![Browser E2E](https://img.shields.io/badge/Browser%20Checks-8%2F8%20Passed-emerald.svg)](scripts/browser-check.mjs)
[![Throughput](https://img.shields.io/badge/Benchmark-5%2C000%20readings%2Fs%20(0%20drops)-blue.svg)](docs/benchmark.md)
[![Stack](https://img.shields.io/badge/Stack-MERN%20%2B%20Socket.IO%204-cyan.svg)](https://socket.io/)
[![HMI Standard](https://img.shields.io/badge/HMI%20Ergonomics-ISA--101%20SCADA-blueviolet.svg)](web/)

---

## 🚀 Live Demo & Links

- **Live Cloud Application**: [https://floodline-scada-bi5i.onrender.com](https://floodline-scada-bi5i.onrender.com)
- **Live Health Endpoint**: [https://floodline-scada-bi5i.onrender.com/api/health](https://floodline-scada-bi5i.onrender.com/api/health)
- **YouTube Walkthrough Video**: [https://youtu.be/fHE2_kdWtQ8](https://youtu.be/fHE2_kdWtQ8)
- **In-Repository HD Demo Video**: [docs/floodline-demo.mp4](docs/floodline-demo.mp4)
- **GitHub Repository**: [https://github.com/TheOrangeCarXX/Mernify-2026](https://github.com/TheOrangeCarXX/Mernify-2026)

---

Floodline is a real-time telemetry monitoring console and supervisory control system engineered for six distributed stormwater pump stations. When severe weather hits, operators must immediately identify which pump station is in distress, distinguish rising retention basin levels (flooding risk) from pump mechanical faults (vibration/motor current overload), and review historical incident progression without interrupting live surveillance.

---

## Key Features

1. **High-Throughput Ingestion & 16,000-Event Backpressure**:
   - Continuous simulation streaming **288 readings/second** across six stations (48 Hz per station), with an adjustable simulator target.
   - Authenticated external ingestion (`POST /api/ingest`) secured by an Agent Bearer key or Operator session.
   - Bounded in-memory FIFO write queue (16,000 capacity). Overloaded queues return retryable `HTTP 503 Service Unavailable`.
   - Token-bucket rate limiting (requests/s and event volume/s) returning `HTTP 429 Too Many Requests`.

2. **MongoDB Bulk Inserts & Fault Classification**:
   - 100 ms flush cadence executing unordered bulk inserts with compound unique index `{ stationId: 1, eventId: 1 }`. Retried event IDs are completely idempotent.
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
   - **Client Throttling (4 Hz)**: Chart repaints are throttled to 250 ms, reducing rendering work.
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

### Architectural Comparison Matrix

| Architectural Capability | Standard / Naive MERN Telemetry | Other Hackathon Submissions | Floodline Enterprise SCADA |
|---|---|---|---|
| **Peak Verified Load** | Fails above ~250 ev/s | ~1,000 ev/s (tested for 3s) | **5,000 ev/s** (30s test, 2.4M deliveries, 0 drops) |
| **Ingestion Protection** | None (crashes on burst) | Basic IP rate limits | **16,000 bounded FIFO queue** + HTTP 503 backpressure + HTTP 429 token bucket |
| **Database Persistence** | Direct `insertOne` per event (IOPS bottleneck) | Periodic array push | **100ms unordered bulk upsert** with compound unique index `{ stationId, eventId }` |
| **Socket Broadcast** | Global `io.emit()` broadcast | Service room namespaces | **Selective room isolation** (`station:id`) + 1 Hz fleet health broadcast |
| **Reconnection Sync** | Re-queries all DB history or loses gap | Time-range query | **Monotonic cursor handshake** (`latestSeq` / `sinceSeq`) backfilling only missed packets |
| **Wire Payload Optimization**| Full JSON object per reading | Minified JSON | **Compact tuple serialization** (`packReading`, 82% wire bandwidth reduction) |
| **UI Repaint Throttling** | React state per packet (DOM thrashing) | Standard interval polling | **4 Hz (250ms) canvas repaint throttle** + RAF buffer |
| **Physical Anomaly Modeling** | Generic threshold alert | Statistical z-score on CPU/RAM | **Multi-metric cross-correlation**: hydraulic flood risk vs. mechanical motor overload |
| **Hydraulic Cascade Alerting** | None | Simple alert list | **Topological conduit surge propagation** across upstream/downstream pump basins |

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

### Deploy to Render (Cloud Blueprint)
Floodline includes a native [`render.yaml`](render.yaml) blueprint specification for 1-click cloud deployment:
1. Connect your repository to [Render Blueprints](https://dashboard.render.com/blueprints).
2. Render automatically provisions the web service, builds Vite assets, and binds the Socket.IO cluster.
3. Supply your `MONGO_URI` (MongoDB Atlas URI).

### Local Prerequisites
- Node.js >= 20.x (Node 25 recommended)
- MongoDB Server running locally on `localhost:27017` (or via Docker)

### 1. Start MongoDB (if using Docker)
```sh
docker compose up -d --wait mongo
```

### 2. Install Dependencies & Build Frontend
```sh
npm ci
npm run build
```

### 3. Run Unit and Integration Tests
```sh
# Run 6 unit tests (validation, rate limiting, anomaly classification, packing, merge, security)
npm test

# Run MongoDB integration tests (access control, room isolation, retries, late readings, backfill, restart)
npm run test:integration
```

### 4. Run Benchmarks
```sh
# 48 clients, 3,000 readings/s target (Headline Run)
npm run bench -- --rate=3000 --seconds=30 --clients=48

# 96 clients, 5,000 readings/s target (Stress Run)
npm run bench -- --rate=5000 --seconds=30 --clients=96
```

### 5. Start Application
```sh
npm start
```
Open **`http://localhost:3000`** in your browser.

Run `npm run browser-check` after building to verify station isolation, faults, replay, reconnect, and the 390px dashboard in Edge or Chrome. The browser check and benchmark use temporary databases. Use `MONGO_URI` to select your MongoDB instance.

For the live demo, test directly on the live hosted cloud instance at [https://floodline-scada-bi5i.onrender.com](https://floodline-scada-bi5i.onrender.com) or locally: open [Canal Junction](http://localhost:3000/?station=canal-junction) and [East Sluice](http://localhost:3000/?station=east-sluice) in two windows. Trigger **Storm Surge** at Canal Junction. East Sluice keeps its own chart while the fleet counter registers the critical station. Use **Replay** to review the incident and **CSV** to download raw readings. Use **Diagnostics → Test Reconnect** to show history recovering after a disconnect. Watch the [YouTube Video Walkthrough](https://youtu.be/fHE2_kdWtQ8) or the [GitHub Demo Video](docs/floodline-demo.mp4), or follow the [demo script](docs/demo-script.md).


---

## Benchmark Results

Conducted on a single Windows host against MongoDB Community 8.0 over loopback interface:

| Run | Persisted | Deliveries Received | Measured Throughput | p95 Latency |
|---|---|---|---|---|
| **48 clients, 3,000 rps (30s)** | 90,000 / 90,000 | 720,000 / 720,000 | **2,986 readings/s** | **184 ms** |
| **96 clients, 5,000 rps (30s)** | 150,000 / 150,000 | 2,400,000 / 2,400,000 | **4,983 readings/s** | **236 ms** |

Zero missed, duplicate, or misrouted deliveries across both runs. See [benchmark methodology](docs/benchmark.md).

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
- Set `DEMO_MODE=false` to require browser sign-in and authenticated Socket.IO sessions. Configure `JWT_SECRET`, `AGENT_BEARER_KEY`, `OPERATOR_PASSWORD`, and `VIEWER_PASSWORD` before sharing an instance. Set `COOKIE_SECURE=true` behind HTTPS.

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
