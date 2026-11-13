# Floodline implementation plan

| Phase | Acceptance criteria |
| --- | --- |
| Telemetry | Simulate multiple stormwater pump stations. Validate signed-in agent batches, cap incoming work, persist readings in MongoDB, and tolerate retries and out-of-order samples. |
| Live and history | Join source-specific Socket.IO rooms before reading history. Combine indexed MongoDB buckets with committed live deltas at an explicit cursor. Reconcile automatically on reconnect and bound browser memory. |
| Operator workflow | Surface station health, selectable metrics and time ranges, fault simulation, historical review, and separate viewer and operator access. |
| Verification | Exercise independent clients, overlapping history, duplicates, delayed events, reconnects, auth, backpressure, and a repeatable load test against a real MongoDB instance. |
| Submission | Include setup and operation instructions, an architecture and data model, a measured load report, and a 3–5 minute recording. |
