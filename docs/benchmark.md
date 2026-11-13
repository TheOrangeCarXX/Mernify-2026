# Floodline benchmark results

These runs used the updated bulk insert pipeline on one Windows host with MongoDB Community 8.0.17 and Node.js 22.17.1. The HTTP driver, server, and WebSocket subscribers ran in one Node process over loopback. MongoDB ran separately.

| 30-second offered load | Readings attempted / persisted | Client deliveries received / expected | Measured rate | Socket p50 / p95 / p99 |
| --- | ---: | ---: | ---: | ---: |
| 3,000 readings/s, 48 clients | 90,000 / 90,000 | 720,000 / 720,000 | 2,986 readings/s | 116 / 184 / 216 ms |
| 5,000 readings/s, 96 clients | 150,000 / 150,000 | 2,400,000 / 2,400,000 | 4,983 readings/s | 151 / 236 / 276 ms |

Both runs recorded zero rejected events, duplicates, misrouted deliveries, or out-of-order sequences. A repeat of the 96-client run delivered all 2,400,000 updates again at 4,981 readings/s and 254 ms p95. Throughput includes the time to the last HTTP acknowledgment. Socket latency runs from event creation to subscriber receipt. A delivery means one reading received by one client. A Socket.IO packet can carry many readings. Browser rendering and WAN latency are outside this measurement.

Before the bulk insert change, the 3,000 reading/s run attempted 90,000 readings, persisted 78,600, rejected 11,400, and measured 7,501 ms p95. MongoDB's uniqueness index continues to enforce one reading per station and event ID. The integration test checks that retries report duplicates.

With MongoDB running, use a database account that can create and drop the harness's temporary databases.

```sh
npm run bench -- --rate=3000 --seconds=30 --clients=48
npm run bench -- --rate=5000 --seconds=30 --clients=96
```

The harness starts a separate server and database, confirms subscriptions before sending traffic, compares acknowledged and persisted counts, and checks each client's expected deliveries. A mismatch produces a nonzero exit code.
