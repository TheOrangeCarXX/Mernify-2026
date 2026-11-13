# Floodline SCADA System Architecture & Design Document

Floodline is a high-throughput real-time telemetry monitoring and supervisory control platform engineered for stormwater pump stations. It models continuous multi-channel sensor feeds, validates and persists incoming high-frequency streams into MongoDB via bounded bulk upserts, and distributes low-latency selective updates to operators using Socket.IO.

---

## 1. System Architecture Overview

```mermaid
flowchart TD
    subgraph Ingestion["Ingestion Layer"]
        A1["Virtual Telemetry Simulator<br/>(288 - 6,000 readings/s)"] -->|Internal Stream| Q["Bounded Ingest Queue<br/>(Capacity: 16,000 events)"]
        A2["External Ingest Agents<br/>(POST /api/ingest)"] -->|Bearer Auth & Rate Limit| Q
    end

    subgraph Processing["Processing & Storage Engine"]
        Q -->|100ms Batch Drain<br/>(Up to 2,000 ev)| P["Condition Classifier<br/>& Anomaly Engine"]
        P -->|Atomic Sequence Assignment| S["Monotonic Sequence Counter<br/>(latestSeq)"]
        P -->|Bulk Upsert<br/>$setOnInsert| DB[("MongoDB Community<br/>readings / station_state / incidents")]
    end

    subgraph Distribution["Real-Time Distribution Engine"]
        P -->|Committed Docs| B["Wire Compactor<br/>(Array Encoding)"]
        B -->|50ms Room Broadcast| R["Socket.IO Station Rooms<br/>(station:id)"]
        S -->|1,000ms Broadcast| F["Socket.IO Fleet Room<br/>(fleet:summary)"]
    end

    subgraph Clients["Operator Console Clients"]
        R -->|Station Stream| C1["Client 1: Canal Junction<br/>(Handshake + Buffer Merge)"]
        R -->|Station Stream| C2["Client 2: East Sluice<br/>(Handshake + Buffer Merge)"]
        F -->|Basin Alert Updates| C1
        F -->|Basin Alert Updates| C2
        C1 -->|Canvas Render @ 4Hz| UI1["SCADA Dashboard & Plots"]
        C2 -->|Canvas Render @ 4Hz| UI2["SCADA Dashboard & Plots"]
    end
```

---

## 2. Ingestion & Storage Pipeline

### A. High-Throughput Ingestion Queue & Backpressure
1. **Bounded Queue**: Ingest requests are placed into an in-memory FIFO queue bounded at **16,000 events**.
2. **Backpressure (503 Service Unavailable)**: When the queue reaches 16,000 events, incoming HTTP requests receive an immediate `HTTP 503 Service Unavailable` with `Retry-After: 1`. Producers retry with their stable event IDs.
3. **Rate Limiting (429 Too Many Requests)**: Protected by a Token Bucket algorithm limiting both request frequency (50 req/s burst up to 200) and event volume (5,000 events/s burst up to 10,000).
4. **Cadence Flush**: Every **100 ms**, the engine drains up to **2,000 events** from the queue and executes an asynchronous MongoDB `bulkWrite`.

### B. MongoDB Bulk Upserts & Deduplication
To guarantee idempotency and avoid duplicate entries during retries or network replays:
- Each event carries a stable `stationId` and `eventId`.
- MongoDB executes:
```javascript
readingsCollection.bulkWrite([
  {
    updateOne: {
      filter: { stationId: ev.stationId, eventId: ev.eventId },
      update: {
        $setOnInsert: {
          stationId: ev.stationId,
          eventId: ev.eventId,
          timestamp: ev.timestamp,
          seq: nextSeq(),
          metrics: ev.metrics,
          severity: classification.severity,
          anomalyReason: classification.anomalyReason,
          expireAt: new Date(ev.timestamp + 7 * 24 * 3600 * 1000)
        }
      },
      upsert: true
    }
  }
], { ordered: false });
```
- Only newly upserted readings increment the stored counter and trigger real-time live Socket.IO delivery. Duplicate submissions return `duplicates: 1` and do not generate duplicate client broadcasts.

---

## 3. Data Model & Database Schema

### 1. `readings` Collection
Stores historical and live telemetry samples.
```typescript
interface ReadingDocument {
  _id: ObjectId;
  stationId: string;       // e.g. 'canal-junction'
  eventId: string;         // Unique client/sensor event ID
  timestamp: number;       // Epoch milliseconds
  seq: number;             // Monotonically increasing commit sequence
  metrics: {
    waterLevel: number;    // metres (m)
    outflow: number;       // litres per second (L/s)
    vibration: number;     // mm/s RMS (ISO 10816)
    current: number;       // amperes (A)
  };
  severity: 'normal' | 'warning' | 'critical';
  anomalyReason: string;
  expireAt: Date;          // 7-day TTL expiration
}
```

**Indexes:**
- `{ stationId: 1, eventId: 1 }` (unique, deduplication)
- `{ stationId: 1, timestamp: 1 }` (fast historical range retrieval)
- `{ seq: 1 }` (unique, cursor handshake backfill)
- `{ expireAt: 1 }` with `{ expireAfterSeconds: 0 }` (automated TTL retention)

### 2. `station_state` Collection
Stores the latest known state for each pump station to ensure zero state loss across server restarts.
```typescript
interface StationStateDocument {
  _id: ObjectId;
  stationId: string;
  timestamp: number;
  seq: number;
  metrics: { waterLevel: number; outflow: number; vibration: number; current: number };
  severity: 'normal' | 'warning' | 'critical';
  anomalyReason: string;
  updatedAt: Date;
}
```

**Timestamp First, Sequence Second Evaluation:**
When an incoming reading is committed, station state is updated only if:
```javascript
if (doc.timestamp > current.timestamp || (doc.timestamp === current.timestamp && doc.seq > current.seq)) {
  stationStates.set(doc.stationId, doc);
}
```
A late-arriving reading with an older timestamp correctly updates the historical bucket in `readings` without rolling back the latest station health.

### 3. `incidents` Collection
Tracks contiguous alert episodes (grouped warnings and critical alarms) for instant operator triage.
```typescript
interface IncidentDocument {
  incidentId: string;
  stationId: string;
  severity: 'warning' | 'critical';
  startTime: number;
  endTime: number;
  peakMetrics: { waterLevel: number; outflow: number; vibration: number; current: number };
  reasons: string[];
  resolved: boolean;
}
```

---

## 4. History-to-Live Cursor Handshake Protocol

A major challenge in high-throughput real-time dashboards is joining historical database records with incoming live WebSocket packets without duplicate entries or visual gaps.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Operator Browser (Client)
    participant Server as Node.js / Socket.IO Server
    participant DB as MongoDB Community

    Client->>Server: emit("subscribe:station", { stationId: "canal-junction" })
    Server->>Client: ack({ stationId, serverTime: T0, latestSeq: S_cursor })
    Client->>Client: Start in-memory sync buffer; buffer packets where seq > S_cursor

    par Live Stream Broadcast
        Server->>Client: emit("telemetry:batch", [packedRows with seq >= S_cursor])
        Client->>Client: Buffer incoming packets
    and History Retrieval
        Client->>Server: GET /api/stations/canal-junction/history?from=T_start&to=T0&beforeSeq=S_cursor
        Server->>DB: find({ stationId, timestamp in [T_start, T0], seq <= S_cursor })
        DB-->>Server: return historical readings
        Server-->>Client: 200 OK (Historical Readings Array)
    end

    Client->>Client: Install historical readings in Series Manager
    Client->>Client: Apply buffered packets where seq > S_cursor
    Client->>Client: Discard duplicate eventIds / seqs
    Client->>Client: Transition to Live Stream rendering
```

---

## 5. Wire Optimization & Selective Room Broadcasting

1. **Station Room Isolation**: Clients subscribe only to the station they are actively monitoring (`station:${stationId}`). Live 48-1000 Hz telemetry for Station A is never transmitted over WebSocket to clients monitoring Station B.
2. **Compact Array Encoding**: High-frequency telemetry packets are serialized into compact numeric arrays instead of repetitive JSON keys:
   `[stationId, eventId, timestamp, seq, waterLevel, outflow, vibration, current, severity, anomalyReason]`
   This reduces payload size by ~62% and cuts JSON serialization/deserialization CPU overhead.
3. **Fleet Summary Broadcast**: A decoupled 1 Hz summary packet is broadcast globally to all connected clients, carrying network-wide health and active alerts. An operator monitoring Canal Junction immediately sees an alert beacon on East Sluice.
4. **Client-Side Rendering Throttling**: The browser UI throttles canvas rendering to a maximum of **4 Hz (250 ms)** using an internal dirty flag, keeping browser CPU below 3% even when receiving 288+ updates per second.
