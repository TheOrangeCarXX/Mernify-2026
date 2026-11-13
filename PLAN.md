# Floodline implementation and submission plan

Floodline is a real-time monitoring console for six simulated stormwater pump stations. The operator's job is to identify which station is in trouble, distinguish rising water from a pump fault, and review how the incident developed. The core demo proves all three actions while two clients follow different stations.

This plan covers the MERNIFY High-Throughput Streams & Telemetry brief. Implementation status refers to the local Floodline build. The private GitHub repository currently carries the plan. The application source, demo video, and supporting documentation are prepared locally for publication.

## 1. What the judges should see

| Criterion | Weight | Demonstration |
| --- | ---: | --- |
| Functionality | 30% | Show live station readings, inject a storm surge, observe a critical alert, and open the same incident from MongoDB history. |
| User experience and interface | 20% | Select stations on the basin schematic, change metrics and time ranges, and inspect the incident timeline. Show the 390px layout and the connection status if asked. |
| Technical implementation | 20% | Explain the validated ingest queue, MongoDB bulk upserts, Socket.IO station rooms, and the cursor that joins history to live delivery. Show measured throughput and tail latency. |
| Originality and creativity | 20% | Show how water level, outflow, vibration, and motor current help distinguish flooding risk from pump overload. Use fault injection to demonstrate cause and effect. |
| Presentation and documentation | 10% | Provide a runnable repository, a 3:24 video, architecture and data model, reproducible benchmarks, and a short walkthrough the team can explain live. |

## 2. Build sequence and acceptance criteria

### A. Generate and ingest telemetry

- Model six distinct stations. Each reports water level in metres, outflow in litres per second, vibration in millimetres per second, and current in amperes. The simulator defaults to 288 readings per second across the network. It seeds recent history and a past Canal Junction incident on a fresh database.
- Accept external agents through `POST /api/ingest` with a separate bearer key. Validate the station, stable event ID, epoch-millisecond timestamp, and four finite values. Reject malformed batches and enforce a maximum of 500 events per request.
- Rate-limit requests and event volume. Bound the write queue at 16,000 events. A rate-limited request returns `429`, and an unavailable or overloaded queue returns a retryable `503`. Agents retry with their original event IDs.
- **Accept when:** The simulator updates all six stations. An authenticated agent can submit a valid batch and receive stored and duplicate counts. Invalid data, missing credentials, and a burst above the rate limit return their expected statuses.

### B. Persist readings and classify conditions

- Flush the ingest queue on a 100 ms cadence in bulk writes of up to 2,000 readings. MongoDB identifies each reading by station plus event ID. An upsert writes only the first version of an event. A producer receives a successful ingest response after persistence.
- Assign a commit sequence and retain the original event timestamp. For station health, compare timestamp first and sequence second. A late reading updates an earlier historical bucket without rolling back the current station state.
- Store the metric tuple, severity, anomaly reason, and expiry with each reading. Index station and event time for history, use a unique sequence index, and use a seven-day TTL for retention.
- Evaluate flood risk using water level and low outflow. Evaluate pump overload using vibration and motor current. Group adjacent warning and critical buckets on the timeline. Support simulated storm surge, intake blockage, and motor overload.
- **Accept when:** Repeating an event ID produces one stored reading and one live delivery. An older anomalous event appears in the correct bucket while a newer healthy sample stays current. A restart restores the latest readings from MongoDB.

### C. Join MongoDB history to Socket.IO updates

1. The client joins the selected station room. The subscription acknowledgment includes server time and the latest committed sequence.
2. The client requests indexed MongoDB buckets through that sequence and buffers packets arriving during the request.
3. It installs the history response and applies buffered rows with a sequence above the cursor. Both paths use the same event-time bucket boundaries. Duplicate packets are ignored.
4. On a station switch or reconnect, the client starts a fresh subscription and history request. On reconnect, committed readings that arrived while the client was away are included in the rebuilt window.
5. Send compact rows to the selected room. A separate once-per-second fleet summary carries station health, allowing another client to see a basin alert while its chart continues following a different station.
- **Accept when:** Two clients can follow different stations simultaneously. Switching one client changes its detailed feed. The history-to-live transition and a reconnect both preserve counts without duplicate readings.

### D. Make the operator workflow clear

- Show fleet health, the selected station, four metric cards, a trend chart, the basin schematic, a filterable roster, and an incident timeline. Use explicit Normal, Warning, Critical, and No signal labels alongside color.
- Give operators 1-minute, 5-minute, 15-minute, and 1-hour trend windows. Clicking an incident opens a fixed historical window. Earlier and later controls move the window, and Return to live resumes the rolling view.
- Keep the chart responsive by bucketing readings, pruning expired buckets, and publishing telemetry changes to the chart at most four times per second. Rebuild from history if the client accumulates too many buffered packets during synchronization.
- Allow viewers to read and subscribe. Operators can also run and clear faults. Local demo mode grants operator access. A shared deployment uses authenticated mode with separate operator, viewer, and agent credentials.
- **Accept when:** The operator can find an affected station, compare it to a healthy station, inspect an incident, and return to live without leaving the console. The same controls remain usable at 390px.

## 3. Where the implementation lives

| Area | Local project paths |
| --- | --- |
| Ingestion, HTTP routes, room subscriptions | `server/index.mjs`, `server/validation.mjs` |
| Persistence, bulk writes, backpressure, history | `server/store.mjs` |
| Simulator, metric definitions, alert rules | `server/simulator.mjs`, `shared/telemetry.mjs` |
| Session and agent authentication | `server/security.mjs`, `server/index.mjs` |
| Dashboard, charts, subscription and history merge | `web/main.jsx`, `web/plot.jsx`, `web/live.jsx`, `web/series.mjs` |
| Repeatable verification | `test/`, `scripts/browser-check.mjs`, `scripts/benchmark.mjs` |
| Setup, architecture, benchmark report, demo | `README.md`, `docs/architecture.md`, `docs/benchmark.md`, `docs/floodline-demo.mp4` |

## 4. Verification and performance evidence

| Check | Evidence from the local build |
| --- | --- |
| Validation, rate limiting, anomaly rules, signed sessions, bucket merge | Six unit tests passed with `npm test`. |
| Real database and live delivery | The MongoDB integration suite passed for role and agent access, station isolation, duplicate retries, late readings, reconnect backfill, rate limiting, and persistence after restarting the server. |
| Operator walkthrough | Edge browser checks passed for two clients, metric and range changes, fault and recovery, historical replay, disconnect and reconnect, and a 390px viewport. |
| Build and startup | Vite production build and development startup were checked. The app served its health and history endpoints against MongoDB. |
| Video | The 3:24 MP4 was recorded from the running app. It shows the fault on two clients, the MongoDB incident window, reconnect, and the benchmark. |

| Local loopback run | Persisted | Expected deliveries received | Measured throughput | Socket latency p95 |
| --- | ---: | ---: | ---: | ---: |
| 30 seconds, 48 clients, 3,000 readings/s target | 90,000 / 90,000 | 720,000 / 720,000 | 3,000 readings/s | 183 ms |
| 30 seconds, 96 clients, 6,000 readings/s target | 180,000 / 180,000 | 2,880,000 / 2,880,000 | 5,801 readings/s | 1,434 ms |

Neither run observed missed, duplicate, or misrouted deliveries. Use the first run for the headline result and show the second as a stress case where latency grew. Both ran on one Windows host against MongoDB Community 8.0.17. The numbers measure loopback Socket.IO receipt, excluding browser rendering and internet latency.

```sh
docker compose up -d --wait mongo
npm ci
npm run build
npm test
npm run test:integration
npm run bench -- --rate=3000 --seconds=30 --clients=48
npm run bench -- --rate=6000 --seconds=30 --clients=96
npm start
```

With the app running and Edge installed, run `node scripts/browser-check.mjs` from a second terminal. Set `MONGO_URI` for an existing database if Compose is unavailable.

## 5. Demo run of show

| Time | Action | What to point out |
| --- | --- | --- |
| 0:00–0:32 | Open the network overview. Select a station and change metrics. | Six stations generate four signals continuously. The first chart already contains historical data. |
| 0:32–1:10 | Open Canal Junction and East Sluice side by side. Run Storm surge at Canal Junction, then switch the second client to it. | One station turns critical. The second chart follows East Sluice until its subscription changes. |
| 1:10–1:44 | Click the Canal Junction incident and move through replay windows. | The archived window comes from MongoDB and stays fixed while the simulator continues running. |
| 1:44–2:18 | Disconnect and reconnect in Stream diagnostics. | Room join, committed cursor, history fetch, and buffered live merge fill the gap. |
| 2:18–2:53 | Show the benchmark and explain the batching and rendering choices. | Use the 48-client result with its measurement conditions. |
| 2:53–3:24 | Show the roster or diagnostics and explain access roles and reproduction. | The team can run the demo locally and explain how a retried or late event is handled. |

If the live fault does not fire during rehearsal, open the seeded Canal Junction incident or play the recorded demo. Before judging, confirm both windows show Live connection and select the same time ranges used in the walkthrough.

## 6. Submission checklist and known limits

- [x] Implement and verify the working MERN and Socket.IO application locally, including simulated sources, live dashboards, history, authentication, and validation.
- [x] Prepare the README with setup, features, stack, simulator and ingest instructions, Socket.IO explanation, tests, and attribution.
- [x] Record and verify the 3–5 minute demo. Prepare the optional architecture document with diagrams and data model, plus the benchmark report.
- [x] Publish this plan to the private GitHub repository.
- [ ] Publish the application source, README, and supporting deliverables to the submission repository. Confirm the intended reviewer can access the private repository and video, then verify a clean checkout using the README.
- [ ] Confirm the organizer's submission deadline and upload mechanism. Submit the repository and video through that mechanism.
- [ ] Optional hosting bonus. If hosting is available, deploy one Node process with a persistent MongoDB database and HTTPS/WebSocket support, then repeat the two-client walkthrough from a different device.

The server currently assumes one writer process per database. Horizontal scaling would require shared sequence coordination and a Socket.IO adapter. The team should be ready to explain the cursor handshake, durable event identity, and why tail latency increased under the heavier local run.
