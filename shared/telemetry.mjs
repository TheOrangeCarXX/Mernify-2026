/**
 * Floodline - Shared Telemetry Definitions, Station Topologies, and Anomaly Rules
 */

export const STATIONS = [
  {
    id: 'canal-junction',
    name: 'Canal Junction Station',
    code: 'CJ-01',
    description: 'Central storm confluence basin with 4 axial-flow high-volume lift pumps',
    catchment: 'Central Urban Basin (Zone A)',
    pumpCount: 4,
    ratedCapacity: 1200, // L/s
    designHead: 8.5, // m
    coordinates: { x: 420, y: 280 }, // Schematic layout
    upstream: ['north-weir', 'west-intake'],
    downstream: 'south-basin',
    nominalWaterLevel: { min: 1.1, max: 2.5, warning: 3.0, critical: 3.8 },
    nominalOutflow: { min: 250, max: 1100, minAlert: 180 },
    nominalVibration: { warning: 4.5, critical: 7.1 },
    nominalCurrent: { warning: 85, critical: 105 }
  },
  {
    id: 'east-sluice',
    name: 'East Sluice Pump House',
    code: 'ES-02',
    description: 'Tidal barrier discharge station with 3 submersible flood mitigation pumps',
    catchment: 'Eastern Tidal Estuary (Zone B)',
    pumpCount: 3,
    ratedCapacity: 900, // L/s
    designHead: 11.2, // m
    coordinates: { x: 740, y: 390 },
    upstream: ['south-basin'],
    downstream: 'estuary-outfall',
    nominalWaterLevel: { min: 0.9, max: 2.4, warning: 3.0, critical: 3.8 },
    nominalOutflow: { min: 200, max: 880, minAlert: 150 },
    nominalVibration: { warning: 4.5, critical: 7.1 },
    nominalCurrent: { warning: 85, critical: 105 }
  },
  {
    id: 'north-weir',
    name: 'North Weir Retention Facility',
    code: 'NW-03',
    description: 'Highland stormwater attenuation weir with 2 variable-frequency drive pumps',
    catchment: 'Northern Hills Catchment (Zone C)',
    pumpCount: 2,
    ratedCapacity: 650, // L/s
    designHead: 14.0, // m
    coordinates: { x: 260, y: 120 },
    upstream: [],
    downstream: 'canal-junction',
    nominalWaterLevel: { min: 0.7, max: 2.2, warning: 2.9, critical: 3.6 },
    nominalOutflow: { min: 150, max: 620, minAlert: 100 },
    nominalVibration: { warning: 4.5, critical: 7.1 },
    nominalCurrent: { warning: 85, critical: 105 }
  },
  {
    id: 'south-basin',
    name: 'South Basin Lift Station',
    code: 'SB-04',
    description: 'Lowland urban runoff storage basin with 4 Archimedean screw pumps',
    catchment: 'Southern Lowland District (Zone D)',
    pumpCount: 4,
    ratedCapacity: 1400, // L/s
    designHead: 6.8, // m
    coordinates: { x: 560, y: 460 },
    upstream: ['canal-junction'],
    downstream: 'east-sluice',
    nominalWaterLevel: { min: 1.2, max: 2.6, warning: 3.1, critical: 3.9 },
    nominalOutflow: { min: 300, max: 1350, minAlert: 220 },
    nominalVibration: { warning: 4.5, critical: 7.1 },
    nominalCurrent: { warning: 85, critical: 105 }
  },
  {
    id: 'west-intake',
    name: 'West Intake Facility',
    code: 'WI-05',
    description: 'Industrial canal diversion and trash rack screening pump house',
    catchment: 'Western Industrial Corridor (Zone E)',
    pumpCount: 3,
    ratedCapacity: 850, // L/s
    designHead: 9.5, // m
    coordinates: { x: 160, y: 350 },
    upstream: [],
    downstream: 'canal-junction',
    nominalWaterLevel: { min: 0.8, max: 2.3, warning: 2.9, critical: 3.7 },
    nominalOutflow: { min: 180, max: 800, minAlert: 140 },
    nominalVibration: { warning: 4.5, critical: 7.1 },
    nominalCurrent: { warning: 85, critical: 105 }
  },
  {
    id: 'harbor-gate',
    name: 'Harbor Gate Station',
    code: 'HG-06',
    description: 'Deep estuary storm surge barrier station with 5 heavy-duty axial flood pumps',
    catchment: 'Coastal Marine Terminal (Zone F)',
    pumpCount: 5,
    ratedCapacity: 1800, // L/s
    designHead: 7.0, // m
    coordinates: { x: 860, y: 220 },
    upstream: [],
    downstream: 'ocean-bay',
    nominalWaterLevel: { min: 1.0, max: 2.7, warning: 3.2, critical: 4.0 },
    nominalOutflow: { min: 350, max: 1750, minAlert: 260 },
    nominalVibration: { warning: 4.5, critical: 7.1 },
    nominalCurrent: { warning: 85, critical: 105 }
  }
];

export const STATION_MAP = new Map(STATIONS.map(s => [s.id, s]));

/**
 * Classifies a telemetry reading according to hydraulic and mechanical anomaly rules.
 * Distinguishes flood risk (rising water / blocked outflow) from pump faults (vibration / current).
 *
 * @param {Object} metrics - { waterLevel, outflow, vibration, current }
 * @param {string} stationId
 * @returns {{ severity: 'normal' | 'warning' | 'critical', anomalyReason: string, faultCategory: 'none' | 'flooding' | 'mechanical' }}
 */
export function classifyTelemetry(metrics, stationId) {
  const station = STATION_MAP.get(stationId) || STATIONS[0];
  const { waterLevel, outflow, vibration, current } = metrics;

  // Rule 1: Pump Overload / Mechanical Failure (ISO 10816 vibration severity and motor overcurrent)
  if (vibration >= station.nominalVibration.critical || current >= station.nominalCurrent.critical) {
    return {
      severity: 'critical',
      anomalyReason: `Pump Overload: Severe mechanical vibration (${vibration.toFixed(1)} mm/s) or electrical overcurrent (${current.toFixed(1)} A)`,
      faultCategory: 'mechanical'
    };
  }

  // Rule 2: Storm Surge / Inundation Overtopping Risk (High water level)
  if (waterLevel >= station.nominalWaterLevel.critical) {
    return {
      severity: 'critical',
      anomalyReason: `Storm Surge: Water level (${waterLevel.toFixed(2)} m) exceeds critical basin retention capacity`,
      faultCategory: 'flooding'
    };
  }

  // Rule 3: Intake Blockage (High water level with inadequate or collapsing outflow)
  if (waterLevel >= station.nominalWaterLevel.warning && outflow < station.nominalOutflow.minAlert) {
    const isCrit = waterLevel >= station.nominalWaterLevel.critical - 0.2 || outflow < (station.nominalOutflow.minAlert * 0.5);
    return {
      severity: isCrit ? 'critical' : 'warning',
      anomalyReason: `Intake Blockage: High water level (${waterLevel.toFixed(2)} m) with restricted discharge outflow (${outflow.toFixed(0)} L/s)`,
      faultCategory: 'flooding'
    };
  }

  // Rule 4: Mechanical Warning (Elevated vibration or high electrical current)
  if (vibration >= station.nominalVibration.warning || current >= station.nominalCurrent.warning) {
    return {
      severity: 'warning',
      anomalyReason: `Pump Warning: Elevated vibration (${vibration.toFixed(1)} mm/s) or elevated motor load (${current.toFixed(1)} A)`,
      faultCategory: 'mechanical'
    };
  }

  // Rule 5: Water Level Warning (Surging water approaching buffer limits)
  if (waterLevel >= station.nominalWaterLevel.warning) {
    return {
      severity: 'warning',
      anomalyReason: `High Water Advisory: Basin level (${waterLevel.toFixed(2)} m) approaching warning threshold`,
      faultCategory: 'flooding'
    };
  }

  return {
    severity: 'normal',
    anomalyReason: 'Nominal operating conditions',
    faultCategory: 'none'
  };
}

/**
 * Compact array layout for wire transmission:
 * [stationId, eventId, timestamp, seq, waterLevel, outflow, vibration, current, severity, anomalyReason]
 */
export function packReading(reading) {
  return [
    reading.stationId,
    reading.eventId,
    reading.timestamp,
    reading.seq ?? 0,
    Number(reading.metrics.waterLevel.toFixed(3)),
    Number(reading.metrics.outflow.toFixed(1)),
    Number(reading.metrics.vibration.toFixed(2)),
    Number(reading.metrics.current.toFixed(1)),
    reading.severity,
    reading.anomalyReason
  ];
}

export function unpackReading(row) {
  if (!Array.isArray(row)) return row;
  return {
    stationId: row[0],
    eventId: row[1],
    timestamp: row[2],
    seq: row[3],
    metrics: {
      waterLevel: row[4],
      outflow: row[5],
      vibration: row[6],
      current: row[7]
    },
    severity: row[8],
    anomalyReason: row[9]
  };
}
