/**
 * Floodline - Ingest Payload Validation & Sanitation
 */

import { MAX_FUTURE_SKEW_MS, RETENTION_MS, STATION_MAP } from '../shared/telemetry.mjs';

export const MAX_BATCH_SIZE = 500;

/**
 * Validates a single telemetry event.
 * @param {any} item
 * @param {number} [index]
 * @returns {{ valid: boolean, error?: string, sanitized?: any }}
 */
export function validateEvent(item, index = 0) {
  if (!item || typeof item !== 'object') {
    return { valid: false, error: `Item at index ${index} must be an object` };
  }

  const { stationId, eventId, timestamp, metrics } = item;

  if (typeof stationId !== 'string' || !STATION_MAP.has(stationId)) {
    return {
      valid: false,
      error: `Item [${index}]: Invalid or unknown stationId '${stationId}'. Expected one of: ${[...STATION_MAP.keys()].join(', ')}`
    };
  }

  if (typeof eventId !== 'string' || eventId.trim() === '' || eventId.length > 128) {
    return { valid: false, error: `Item [${index}]: eventId must be a non-empty string up to 128 characters` };
  }

  const ts = timestamp;
  if (!Number.isSafeInteger(ts) || ts <= 0) {
    return { valid: false, error: `Item [${index}]: timestamp must be a positive integer epoch millisecond` };
  }

  const now = Date.now();
  if (ts > now + MAX_FUTURE_SKEW_MS) {
    return { valid: false, error: `Item [${index}]: timestamp is more than 5 seconds in the future` };
  }
  if (ts < now - RETENTION_MS) {
    return { valid: false, error: `Item [${index}]: timestamp is older than the 7-day retention window` };
  }

  if (!metrics || typeof metrics !== 'object') {
    return { valid: false, error: `Item [${index}]: metrics object is required` };
  }

  const { waterLevel, outflow, vibration, current } = metrics;

  const wl = waterLevel;
  const of = outflow;
  const vb = vibration;
  const cur = current;

  if (!Number.isFinite(wl) || wl < 0 || wl > 50) {
    return { valid: false, error: `Item [${index}]: metrics.waterLevel must be a finite number between 0 and 50m` };
  }

  if (!Number.isFinite(of) || of < 0 || of > 10000) {
    return { valid: false, error: `Item [${index}]: metrics.outflow must be a finite number between 0 and 10000 L/s` };
  }

  if (!Number.isFinite(vb) || vb < 0 || vb > 200) {
    return { valid: false, error: `Item [${index}]: metrics.vibration must be a finite number between 0 and 200 mm/s` };
  }

  if (!Number.isFinite(cur) || cur < 0 || cur > 2000) {
    return { valid: false, error: `Item [${index}]: metrics.current must be a finite number between 0 and 2000 A` };
  }

  return {
    valid: true,
    sanitized: {
      stationId,
      eventId: eventId.trim(),
      timestamp: ts,
      metrics: {
        waterLevel: wl,
        outflow: of,
        vibration: vb,
        current: cur
      }
    }
  };
}

/**
 * Validates an entire batch of incoming telemetry events.
 * @param {any} body
 * @returns {{ valid: boolean, error?: string, events?: any[] }}
 */
export function validateIngestBatch(body) {
  if (!body) {
    return { valid: false, error: 'Request body cannot be empty' };
  }

  let items = [];
  if (Array.isArray(body)) {
    items = body;
  } else if (typeof body === 'object' && Array.isArray(body.events)) {
    items = body.events;
  } else if (typeof body === 'object') {
    items = [body];
  } else {
    return { valid: false, error: 'Payload must be a telemetry event object or an array of events' };
  }

  if (items.length === 0) {
    return { valid: false, error: 'Telemetry batch cannot be empty' };
  }

  if (items.length > MAX_BATCH_SIZE) {
    return {
      valid: false,
      error: `Batch size (${items.length}) exceeds maximum allowable limit of ${MAX_BATCH_SIZE} events per request`
    };
  }

  const sanitized = [];
  for (let i = 0; i < items.length; i++) {
    const res = validateEvent(items[i], i);
    if (!res.valid) {
      return { valid: false, error: res.error };
    }
    sanitized.push(res.sanitized);
  }

  return { valid: true, events: sanitized };
}
