import type {
  NormalizedSensorReading,
  ProductionLineMachine,
  SensorAdapterConfig,
  SensorAdapterMode,
  ThermalSensor,
} from '../types';
import { BrowserMqttWsClient } from './mqttWsClient';

export const DEFAULT_SENSOR_ADAPTER_CONFIG: SensorAdapterConfig = {
  masterEnabled: false, // Switched OFF by default
  adapterMode: 'simulator',
  perLineEnabled: {},
  pollingIntervalSec: 5,
  saveIntervalSec: 60,
  gatewayUrl: 'http://localhost:4100/api/readings',
  backfillUrl: '',
  mqttWsUrl: 'ws://localhost:9001/mqtt',
  mqttTopic: 'mayralab/mes/+/readings',
  offlineAlarmThresholdSec: 30,
  autoBackfillOnOpen: true,
};

export function isLineSensorEnabled(
  config: SensorAdapterConfig,
  lineName?: string
): boolean {
  if (!config.masterEnabled) return false;
  if (!lineName) return true;
  const val = config.perLineEnabled?.[lineName];
  // If line has an explicit setting use it; otherwise default enabled when Master is ON
  return val === undefined ? true : Boolean(val);
}

function toNumOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : null;
}

export function normalizeExternalReading(
  raw: Record<string, unknown>,
  fallbackLineName: string,
  adapter: SensorAdapterMode
): NormalizedSensorReading | null {
  const timestampRaw =
    raw.timestamp || raw.recordedAt || raw.ts || raw.time || new Date().toISOString();
  const parsedDate = new Date(String(timestampRaw));
  const iso = Number.isNaN(parsedDate.getTime())
    ? new Date().toISOString()
    : parsedDate.toISOString();
  const readingTime =
    String(raw.readingTime || '').trim().slice(0, 8) || iso.slice(11, 16);

  const tempC = toNumOrNull(raw.tempC ?? raw.temperature ?? raw.recordedTempC ?? raw.temp);
  const brix = toNumOrNull(raw.brix ?? raw.recordedBrix);
  const ph = toNumOrNull(raw.ph ?? raw.recordedPh);
  const viscosityCp = toNumOrNull(raw.viscosityCp ?? raw.viscosity ?? raw.recordedViscosityCp);
  const weightKg = toNumOrNull(raw.weightKg ?? raw.weight ?? raw.recordedWeightKg);
  const speedRpm = toNumOrNull(raw.speedRpm ?? raw.speed ?? raw.rpm ?? raw.recordedSpeedRpm);
  const pressureBar = toNumOrNull(
    raw.pressureBar ?? raw.pressure ?? raw.bar ?? raw.recordedPressureBar
  );

  if (
    tempC === null &&
    brix === null &&
    ph === null &&
    viscosityCp === null &&
    weightKg === null &&
    speedRpm === null &&
    pressureBar === null
  ) {
    return null;
  }

  return {
    id: String(raw.id || `sen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    timestamp: iso,
    readingTime,
    lineName: String(raw.lineName || raw.line || fallbackLineName).trim() || fallbackLineName,
    sensorCode:
      String(raw.sensorCode || raw.deviceId || raw.probe || 'GW-01').trim() || 'GW-01',
    tempC,
    brix,
    ph,
    viscosityCp,
    weightKg,
    speedRpm,
    pressureBar,
    source: 'Sensor',
    adapter,
  };
}

/**
 * Adapter (a): Built-in deterministic + micro-drift Simulator (no hardware required)
 */
export function generateSimulatedReading(
  lineName: string,
  lines: ProductionLineMachine[],
  sensors: ThermalSensor[],
  tickIndex: number
): NormalizedSensorReading {
  const matchedLine = lines.find((l) => l.lineName === lineName);
  const matchedSensor =
    sensors.find((s) => s.linkedLine === lineName) ||
    sensors.find((s) => s.sensorCode === matchedLine?.linkedSensorCode) ||
    sensors[0];

  const baseTemp = matchedLine?.targetTempC ?? matchedSensor?.targetTempC ?? 85;
  const wave = Math.sin(tickIndex * 0.7) * 0.8;
  const now = new Date();
  const iso = now.toISOString();

  return {
    id: `sim-${Date.now()}-${tickIndex}`,
    timestamp: iso,
    readingTime: now.toTimeString().slice(0, 5),
    lineName: lineName || matchedLine?.lineName || 'Line 1',
    sensorCode: matchedLine?.linkedSensorCode || matchedSensor?.sensorCode || 'SIM-PROBE-01',
    tempC: Number((baseTemp + wave).toFixed(1)),
    brix: Number((41.8 + Math.cos(tickIndex * 0.5) * 0.4).toFixed(1)),
    ph: Number((4.12 + Math.sin(tickIndex * 0.3) * 0.04).toFixed(2)),
    viscosityCp: Math.round(1180 + Math.sin(tickIndex * 0.4) * 35),
    weightKg: 0.26,
    speedRpm: matchedLine?.agitatorRpm ?? Math.round(52 + Math.cos(tickIndex * 0.6) * 2),
    pressureBar: matchedLine?.pressureBar ?? Number((1.4 + Math.sin(tickIndex * 0.5) * 0.05).toFixed(2)),
    source: 'Sensor',
    adapter: 'simulator',
  };
}

/**
 * Adapter (b): REST polling against local factory Gateway PC URL
 */
export async function pollGatewayRest(
  gatewayUrl: string,
  lineName?: string,
  timeoutMs = 5000
): Promise<NormalizedSensorReading[]> {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    throw new Error('Gateway REST URL is empty.');
  }
  const url = new URL(trimmed);
  if (lineName) {
    url.searchParams.set('line', lineName);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Gateway returned HTTP ${res.status}`);
    }
    const json = await res.json();
    const list: Record<string, unknown>[] = Array.isArray(json)
      ? json
      : Array.isArray(json?.readings)
        ? json.readings
        : json && typeof json === 'object'
          ? [json as Record<string, unknown>]
          : [];
    return list
      .map((item) => normalizeExternalReading(item, lineName || 'Line 1', 'rest'))
      .filter((r): r is NormalizedSensorReading => r !== null);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Gateway timed out after ${timeoutMs}ms (${trimmed})`);
    }
    throw new Error(
      err instanceof Error ? err.message : `Unable to reach gateway at ${trimmed}`
    );
  } finally {
    window.clearTimeout(timer);
  }
}

export function resolveBackfillUrl(config: SensorAdapterConfig): string {
  if (config.backfillUrl.trim()) return config.backfillUrl.trim();
  const base = config.gatewayUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/history')) return base;
  return `${base}/history`;
}

export async function fetchGatewayBackfill(
  config: SensorAdapterConfig,
  opts: { lineName?: string; sinceIso?: string; timeoutMs?: number }
): Promise<NormalizedSensorReading[]> {
  const target = resolveBackfillUrl(config);
  if (!target) {
    throw new Error('Gateway Back-Fill URL is not configured.');
  }
  const url = new URL(target);
  if (opts.lineName) url.searchParams.set('line', opts.lineName);
  if (opts.sinceIso) url.searchParams.set('since', opts.sinceIso);

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Back-fill endpoint returned HTTP ${res.status}`);
    }
    const json = await res.json();
    const list: Record<string, unknown>[] = Array.isArray(json)
      ? json
      : Array.isArray(json?.readings)
        ? json.readings
        : [];
    return list
      .map((item) => normalizeExternalReading(item, opts.lineName || 'Line 1', 'rest'))
      .filter((r): r is NormalizedSensorReading => r !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Adapter (c): MQTT over WebSocket stream
 */
export function createMqttSensorStream(
  wsUrl: string,
  topic: string,
  fallbackLineName: string,
  callbacks: {
    onConnected: () => void;
    onReading: (reading: NormalizedSensorReading) => void;
    onError: (msg: string) => void;
    onDisconnected: () => void;
  }
): BrowserMqttWsClient {
  const client = new BrowserMqttWsClient(wsUrl, topic, {
    onConnect: callbacks.onConnected,
    onMessage: (msg) => {
      try {
        const parsed = JSON.parse(msg.payload);
        const rows: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of rows) {
          const normalized = normalizeExternalReading(row, fallbackLineName, 'mqtt');
          if (normalized) callbacks.onReading(normalized);
        }
      } catch {
        callbacks.onError(`Invalid JSON payload received on MQTT topic "${msg.topic}"`);
      }
    },
    onError: callbacks.onError,
    onClose: callbacks.onDisconnected,
  });
  client.connect();
  return client;
}

/**
 * Adapter (d): CSV / JSON file import parser (supports historical back-fill files)
 */
export function parseSensorImportFile(
  content: string,
  fileName: string,
  fallbackLineName: string
): { readings: NormalizedSensorReading[]; errors: string[] } {
  const trimmed = content.trim();
  const errors: string[] = [];
  if (!trimmed) {
    return { readings: [], errors: ['Uploaded sensor file is empty.'] };
  }

  const isJson =
    fileName.toLowerCase().endsWith('.json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (isJson) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr: Record<string, unknown>[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.readings)
          ? parsed.readings
          : [parsed];
      const readings: NormalizedSensorReading[] = [];
      arr.forEach((row, idx) => {
        const norm = normalizeExternalReading(row, fallbackLineName, 'file');
        if (norm) readings.push(norm);
        else errors.push(`JSON item #${idx + 1} had no valid sensor numeric values.`);
      });
      return {
        readings: readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
        errors,
      };
    } catch (err) {
      return {
        readings: [],
        errors: [err instanceof Error ? err.message : 'Invalid JSON sensor file.'],
      };
    }
  }

  // CSV parsing
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return {
      readings: [],
      errors: ['CSV file must contain a header row and at least one data row.'],
    };
  }
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const readings: NormalizedSensorReading[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const record: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      record[h] = cells[idx] ?? '';
    });
    const norm = normalizeExternalReading(record, fallbackLineName, 'file');
    if (norm) readings.push(norm);
    else errors.push(`CSV line ${i + 1}: no valid sensor measurements found.`);
  }

  return {
    readings: readings.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    errors,
  };
}
