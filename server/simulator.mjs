/**
 * Floodline - Multi-Station Real-Time Telemetry Simulator
 * Generates continuous high-frequency telemetry across 6 pump stations with realistic physics
 * and fault injection capabilities (Storm Surge, Intake Blockage, Motor Overload).
 */

import { randomUUID } from 'node:crypto';
import { STATIONS } from '../shared/telemetry.mjs';

const TICK_MS = 50;

export class TelemetrySimulator {
  constructor(store, { targetRate = 288 } = {}) {
    this.store = store;
    this.targetRate = targetRate; // Default: 288 events/sec network-wide (48 Hz per station)
    this.isRunning = false;
    this.timer = null;
    this.runId = randomUUID();
    this.sequence = 0;
    this.stationIndex = 0;
    this.sampleCredit = 0;
    this.droppedEvents = 0;
    this.generatedEvents = 0;

    // Station dynamic simulation state
    this.stationStates = new Map();

    // Active faults: stationId -> { type, startedAt, durationMs, intensity }
    this.activeFaults = new Map();

    this._initStationDynamics();
  }

  _initStationDynamics() {
    for (const st of STATIONS) {
      this.stationStates.set(st.id, {
        waterLevel: (st.nominalWaterLevel.min + st.nominalWaterLevel.max) / 2,
        outflow: (st.nominalOutflow.min + st.nominalOutflow.max) / 2,
        vibration: 1.8,
        current: 45.0,
        phase: Math.random() * Math.PI * 2,
        flowPhase: Math.random() * Math.PI * 2
      });
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.lastTick = performance.now();
    this.sampleCredit = 0;
    this.timer = setInterval(() => this._tick(), TICK_MS);
    console.log(`[Simulator] Started telemetry simulation at ${this.targetRate} readings/sec target`);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[Simulator] Telemetry simulation stopped');
  }

  setRate(rate) {
    this.targetRate = Math.max(6, rate);
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  triggerFault(stationId, type, durationSeconds = 60) {
    const validTypes = ['storm-surge', 'intake-blockage', 'motor-overload'];
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid fault type '${type}'. Valid types: ${validTypes.join(', ')}`);
    }

    this.activeFaults.set(stationId, {
      type,
      startedAt: Date.now(),
      durationMs: durationSeconds * 1000,
      intensity: 1.0
    });

    console.log(`[Simulator] Injected fault '${type}' on station '${stationId}' for ${durationSeconds}s`);
  }

  clearFault(stationId) {
    if (this.activeFaults.has(stationId)) {
      this.activeFaults.delete(stationId);
      console.log(`[Simulator] Cleared active fault on station '${stationId}'`);
    }
  }

  getActiveFaults() {
    const now = Date.now();
    const result = [];
    for (const [stationId, fault] of this.activeFaults.entries()) {
      const remainingSec = Math.max(0, Math.round((fault.startedAt + fault.durationMs - now) / 1000));
      result.push({
        stationId,
        type: fault.type,
        remainingSec,
        startedAt: fault.startedAt
      });
    }
    return result;
  }

  _tick() {
    const now = Date.now();
    const tick = performance.now();
    const elapsed = Math.min(100, tick - this.lastTick);
    this.lastTick = tick;
    this.sampleCredit += elapsed * this.targetRate / 1000;
    const count = Math.floor(this.sampleCredit);
    this.sampleCredit -= count;
    if (!count) return;
    const readings = new Map();

    // Clean expired faults
    for (const [stId, fault] of this.activeFaults.entries()) {
      if (now - fault.startedAt > fault.durationMs) {
        this.activeFaults.delete(stId);
        console.log(`[Simulator] Fault '${fault.type}' expired on station '${stId}'`);
      }
    }

    for (const st of STATIONS) {
      const state = this.stationStates.get(st.id);
      const fault = this.activeFaults.get(st.id);

      // Baseline sinusoidal + noise oscillation
      state.phase += 0.04;
      state.flowPhase += 0.05;

      const baseLevel = (st.nominalWaterLevel.min + st.nominalWaterLevel.max) / 2;
      const baseOutflow = (st.nominalOutflow.min + st.nominalOutflow.max) / 2;

      let targetLevel = baseLevel + Math.sin(state.phase) * 0.25 + (Math.random() - 0.5) * 0.04;
      let targetOutflow = baseOutflow + Math.cos(state.flowPhase) * 45 + (Math.random() - 0.5) * 15;
      let targetVib = 1.6 + Math.sin(state.phase * 1.5) * 0.4 + (Math.random() - 0.5) * 0.15;
      let targetCur = 44 + Math.cos(state.flowPhase) * 6 + (Math.random() - 0.5) * 1.5;

      // Apply Fault Dynamics
      if (fault) {
        if (fault.type === 'storm-surge') {
          // Rapid rising water level, pump running at maximum outflow, high current
          targetLevel = 4.15 + (Math.random() - 0.5) * 0.1; // Critical overtopping
          targetOutflow = st.ratedCapacity * 0.96 + (Math.random() - 0.5) * 20; // Full blast
          targetVib = 3.6 + (Math.random() - 0.5) * 0.3;
          targetCur = 78 + (Math.random() - 0.5) * 4;
        } else if (fault.type === 'intake-blockage') {
          // Water accumulates behind blocked screen, outflow collapses, cavitation vibration
          targetLevel = 3.65 + (Math.random() - 0.5) * 0.08;
          targetOutflow = 65 + (Math.random() - 0.5) * 15; // Low outflow!
          targetVib = 5.6 + (Math.random() - 0.5) * 0.4; // Cavitation vibration warning
          targetCur = 38 + (Math.random() - 0.5) * 2;
        } else if (fault.type === 'motor-overload') {
          // Locked / damaged impeller: severe vibration, electrical overcurrent surge
          targetLevel = baseLevel + 0.5;
          targetOutflow = baseOutflow * 0.4;
          targetVib = 8.8 + (Math.random() - 0.5) * 0.6; // Critical mechanical vibration!
          targetCur = 118 + (Math.random() - 0.5) * 5; // Critical electrical current!
        }
      }

      // Smooth transition toward targets
      state.waterLevel += (targetLevel - state.waterLevel) * 0.15;
      state.outflow += (targetOutflow - state.outflow) * 0.15;
      state.vibration += (targetVib - state.vibration) * 0.2;
      state.current += (targetCur - state.current) * 0.2;

      readings.set(st.id, {
          waterLevel: Number(state.waterLevel.toFixed(3)),
          outflow: Number(state.outflow.toFixed(1)),
          vibration: Number(state.vibration.toFixed(2)),
          current: Number(state.current.toFixed(1))
      });
    }

    const events = Array.from({ length: count }, (_, index) => {
      const stationId = STATIONS[this.stationIndex].id;
      this.stationIndex = (this.stationIndex + 1) % STATIONS.length;
      return {
        stationId,
        eventId: `sim_${this.runId}_${++this.sequence}`,
        timestamp: now - Math.floor((count - index - 1) * elapsed / count),
        metrics: readings.get(stationId)
      };
    });
    this.generatedEvents += events.length;
    this.store.enqueueBatch(events).catch(() => {
      this.droppedEvents += events.length;
    });
  }
}
