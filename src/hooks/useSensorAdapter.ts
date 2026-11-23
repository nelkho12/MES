import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NormalizedSensorReading,
  ProductionBatch,
  ProductionLineMachine,
  SensorAdapterConfig,
  SensorIngestResult,
  ThermalSensor,
} from '../types';
import {
  DEFAULT_SENSOR_ADAPTER_CONFIG,
  createMqttSensorStream,
  fetchGatewayBackfill,
  generateSimulatedReading,
  isLineSensorEnabled,
  parseSensorImportFile,
  pollGatewayRest,
} from '../services/sensorAdapter';
import { ingestBatchSensorReadings } from '../services/mesService';
import type { BrowserMqttWsClient } from '../services/mqttWsClient';

export type SensorConnectionState =
  | 'disabled'
  | 'line-disabled'
  | 'standby'
  | 'connected'
  | 'offline'
  | 'error';

export interface UseSensorAdapterReturn {
  config: SensorAdapterConfig;
  connectionState: SensorConnectionState;
  latestByLine: Record<string, NormalizedSensorReading>;
  latestForActiveLine: NormalizedSensorReading | null;
  bufferedCount: number;
  lastReceivedAt: string | null;
  lastSavedAt: string | null;
  offlineAlarm: string | null;
  lastAdapterError: string | null;
  busyBackfill: boolean;
  triggerBackfill: (batch: ProductionBatch) => Promise<SensorIngestResult | null>;
  captureSnapshotNow: (batch: ProductionBatch) => Promise<SensorIngestResult | null>;
  importSensorFile: (
    batch: ProductionBatch,
    content: string,
    fileName: string
  ) => Promise<SensorIngestResult & { parseErrors: string[] }>;
  flushBufferNow: (batch: ProductionBatch) => Promise<SensorIngestResult | null>;
}

export function useSensorAdapter(params: {
  config?: SensorAdapterConfig;
  activeBatch: ProductionBatch | null;
  lines: ProductionLineMachine[];
  sensors: ThermalSensor[];
  onNotify?: (msg: string) => void;
}): UseSensorAdapterReturn {
  const config = params.config || DEFAULT_SENSOR_ADAPTER_CONFIG;
  const activeBatch = params.activeBatch;
  const activeLineName = activeBatch?.lineName || params.lines[0]?.lineName || 'Line 1';
  const lineEnabled = isLineSensorEnabled(config, activeLineName);

  const [latestByLine, setLatestByLine] = useState<Record<string, NormalizedSensorReading>>({});
  const [bufferedReadings, setBufferedReadings] = useState<NormalizedSensorReading[]>([]);
  const [lastReceivedAtMs, setLastReceivedAtMs] = useState<number | null>(null);
  const [lastReceivedAt, setLastReceivedAt] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastAdapterError, setLastAdapterError] = useState<string | null>(null);
  const [offlineAlarm, setOfflineAlarm] = useState<string | null>(null);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [busyBackfill, setBusyBackfill] = useState(false);

  const tickRef = useRef(0);
  const enabledSinceMsRef = useRef<number>(Date.now());
  const bufferRef = useRef<NormalizedSensorReading[]>([]);
  const autoBackfilledBatchIdsRef = useRef<Set<string>>(new Set());
  const mqttClientRef = useRef<BrowserMqttWsClient | null>(null);

  useEffect(() => {
    bufferRef.current = bufferedReadings;
  }, [bufferedReadings]);

  const recordIncomingReadings = useCallback(
    (incoming: NormalizedSensorReading[]) => {
      if (incoming.length === 0) return;
      const now = Date.now();
      setLastReceivedAtMs(now);
      setLastReceivedAt(new Date(now).toTimeString().slice(0, 8));
      setLastAdapterError(null);
      setOfflineAlarm(null);

      setLatestByLine((prev) => {
        const next = { ...prev };
        for (const r of incoming) {
          next[r.lineName] = r;
        }
        return next;
      });

      const activeEligible =
        activeBatch &&
        (activeBatch.status === 'Released' || activeBatch.status === 'In Progress') &&
        isLineSensorEnabled(config, activeBatch.lineName);

      if (activeEligible && activeBatch) {
        const matching = incoming.filter(
          (r) =>
            !r.lineName ||
            r.lineName.toLowerCase() === activeBatch.lineName.toLowerCase() ||
            activeBatch.lineName.toLowerCase().includes(r.lineName.toLowerCase()) ||
            r.lineName.toLowerCase().includes(activeBatch.lineName.toLowerCase())
        );
        if (matching.length > 0) {
          setBufferedReadings((prev) => [...prev, ...matching].slice(-120));
        }
      }
    },
    [activeBatch, config]
  );

  // Reset grace timer when master or line switch turns on
  useEffect(() => {
    if (config.masterEnabled && lineEnabled) {
      enabledSinceMsRef.current = Date.now();
      setOfflineAlarm(null);
      setLastAdapterError(null);
    } else {
      setOfflineAlarm(null);
      setLastAdapterError(null);
      setMqttConnected(false);
    }
  }, [config.masterEnabled, lineEnabled, config.adapterMode, activeLineName]);

  // Polling loop for Simulator & REST Gateway
  useEffect(() => {
    if (!config.masterEnabled || !lineEnabled) return;
    if (config.adapterMode !== 'simulator' && config.adapterMode !== 'rest') return;

    let cancelled = false;
    const pollOnce = async () => {
      try {
        if (config.adapterMode === 'simulator') {
          tickRef.current += 1;
          const simReading = generateSimulatedReading(
            activeLineName,
            params.lines,
            params.sensors,
            tickRef.current
          );
          if (!cancelled) recordIncomingReadings([simReading]);
        } else if (config.adapterMode === 'rest') {
          const rows = await pollGatewayRest(config.gatewayUrl, activeLineName);
          if (!cancelled) {
            if (rows.length > 0) {
              recordIncomingReadings(rows);
            } else {
              setLastAdapterError(
                `Gateway reachable at ${config.gatewayUrl}, awaiting new readings for ${activeLineName}.`
              );
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Sensor gateway polling error.';
          setLastAdapterError(msg);
        }
      }
    };

    void pollOnce();
    const intervalMs = Math.max(2000, (config.pollingIntervalSec || 5) * 1000);
    const id = window.setInterval(() => {
      void pollOnce();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    config.masterEnabled,
    lineEnabled,
    config.adapterMode,
    config.gatewayUrl,
    config.pollingIntervalSec,
    activeLineName,
    params.lines,
    params.sensors,
    recordIncomingReadings,
  ]);

  // MQTT over WebSocket connection lifecycle
  useEffect(() => {
    if (mqttClientRef.current) {
      mqttClientRef.current.disconnect();
      mqttClientRef.current = null;
    }
    if (!config.masterEnabled || !lineEnabled || config.adapterMode !== 'mqtt') {
      setMqttConnected(false);
      return;
    }

    const client = createMqttSensorStream(
      config.mqttWsUrl,
      config.mqttTopic,
      activeLineName,
      {
        onConnected: () => {
          setMqttConnected(true);
          setLastAdapterError(null);
        },
        onReading: (reading) => {
          if (isLineSensorEnabled(config, reading.lineName)) {
            recordIncomingReadings([reading]);
          }
        },
        onError: (msg) => {
          setMqttConnected(false);
          setLastAdapterError(msg);
        },
        onDisconnected: () => {
          setMqttConnected(false);
          setLastAdapterError(`MQTT WebSocket disconnected (${config.mqttWsUrl})`);
        },
      }
    );
    mqttClientRef.current = client;

    return () => {
      client.disconnect();
      mqttClientRef.current = null;
    };
  }, [
    config,
    lineEnabled,
    activeLineName,
    recordIncomingReadings,
  ]);

  // Periodic Save Interval flush for open eligible batch
  const flushBufferNow = useCallback(
    async (batch: ProductionBatch): Promise<SensorIngestResult | null> => {
      const toFlush = bufferRef.current;
      if (toFlush.length === 0) return null;
      // Keep latest reading per minute slot to stay concise
      const byMinute = new Map<string, NormalizedSensorReading>();
      for (const r of toFlush) {
        byMinute.set(`${r.timestamp.slice(0, 16)}::${r.sensorCode}`, r);
      }
      const compact = Array.from(byMinute.values());
      setBufferedReadings([]);
      const res = await ingestBatchSensorReadings(batch.id, {
        readings: compact,
        mode: 'auto-save',
      });
      setLastSavedAt(new Date().toTimeString().slice(0, 8));
      return res;
    },
    []
  );

  useEffect(() => {
    if (!config.masterEnabled || !activeBatch) return;
    if (activeBatch.status !== 'Released' && activeBatch.status !== 'In Progress') return;
    if (!isLineSensorEnabled(config, activeBatch.lineName)) return;

    const saveMs = Math.max(10000, (config.saveIntervalSec || 60) * 1000);
    const id = window.setInterval(() => {
      if (bufferRef.current.length > 0) {
        void flushBufferNow(activeBatch).catch((err) => {
          setLastAdapterError(
            err instanceof Error ? err.message : 'Auto-save sensor flush failed.'
          );
        });
      }
    }, saveMs);

    return () => window.clearInterval(id);
  }, [config, activeBatch, flushBufferNow]);

  // Offline Alarm Watcher
  useEffect(() => {
    if (!config.masterEnabled || !lineEnabled || config.adapterMode === 'file') {
      setOfflineAlarm(null);
      return;
    }

    const thresholdMs = Math.max(10000, (config.offlineAlarmThresholdSec || 30) * 1000);
    const id = window.setInterval(() => {
      const now = Date.now();
      const refTime = lastReceivedAtMs ?? enabledSinceMsRef.current;
      if (now - refTime > thresholdMs || lastAdapterError) {
        const reason = lastAdapterError
          ? lastAdapterError
          : `No sensor reading received on ${activeLineName} for > ${config.offlineAlarmThresholdSec}s.`;
        setOfflineAlarm(`OFFLINE ALARM: ${reason} Manual Step 5 entry fallback remains active.`);
      } else {
        setOfflineAlarm(null);
      }
    }, 3000);

    return () => window.clearInterval(id);
  }, [
    config.masterEnabled,
    config.adapterMode,
    config.offlineAlarmThresholdSec,
    lineEnabled,
    lastReceivedAtMs,
    lastAdapterError,
    activeLineName,
  ]);

  // Timestamped Back-Fill from Gateway History
  const triggerBackfill = useCallback(
    async (batch: ProductionBatch): Promise<SensorIngestResult | null> => {
      setBusyBackfill(true);
      try {
        const sensorChecks = (batch.processChecks || []).filter((c) => c.source === 'Sensor');
        const latestSensorStamp =
          sensorChecks.length > 0
            ? sensorChecks[sensorChecks.length - 1].recordedAt
            : batch.actualStartAt || batch.plannedStartAt || '';
        const sinceIso = latestSensorStamp
          ? new Date(latestSensorStamp.replace(' ', 'T')).toISOString()
          : new Date(Date.now() - 4 * 3600 * 1000).toISOString();

        const historyRows = await fetchGatewayBackfill(config, {
          lineName: batch.lineName,
          sinceIso,
        });
        if (historyRows.length === 0) {
          params.onNotify?.(
            `No missed gateway readings found for ${batch.lineName} since ${sinceIso.slice(11, 19)}.`
          );
          return {
            insertedCount: 0,
            skippedDuplicateCount: 0,
            skippedManualCount: 0,
            totalEvaluated: 0,
          };
        }
        const res = await ingestBatchSensorReadings(batch.id, {
          readings: historyRows,
          mode: 'backfill',
        });
        setLastSavedAt(new Date().toTimeString().slice(0, 8));
        params.onNotify?.(
          `Back-filled ${res.insertedCount} gateway reading(s) (${res.skippedManualCount} manual slot(s) preserved, ${res.skippedDuplicateCount} duplicate(s) skipped).`
        );
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Back-fill request failed.';
        setLastAdapterError(msg);
        params.onNotify?.(`Back-fill failed: ${msg}`);
        return null;
      } finally {
        setBusyBackfill(false);
      }
    },
    [config, params]
  );

  // Automatic back-fill when opening an active batch in REST mode
  useEffect(() => {
    if (!activeBatch) return;
    if (!config.masterEnabled || !config.autoBackfillOnOpen) return;
    if (config.adapterMode !== 'rest') return;
    if (activeBatch.status !== 'Released' && activeBatch.status !== 'In Progress') return;
    if (!isLineSensorEnabled(config, activeBatch.lineName)) return;
    if (autoBackfilledBatchIdsRef.current.has(activeBatch.id)) return;

    autoBackfilledBatchIdsRef.current.add(activeBatch.id);
    void triggerBackfill(activeBatch);
  }, [activeBatch, config, triggerBackfill]);

  const captureSnapshotNow = useCallback(
    async (batch: ProductionBatch): Promise<SensorIngestResult | null> => {
      const live = latestByLine[batch.lineName];
      const reading =
        live ||
        (config.adapterMode === 'simulator'
          ? generateSimulatedReading(batch.lineName, params.lines, params.sensors, ++tickRef.current)
          : null);
      if (!reading) {
        params.onNotify?.(
          `No live reading available on ${batch.lineName}. Enter reading manually or import a CSV/JSON file.`
        );
        return null;
      }
      const res = await ingestBatchSensorReadings(batch.id, {
        readings: [reading],
        mode: 'snapshot',
      });
      setLastSavedAt(new Date().toTimeString().slice(0, 8));
      if (res.skippedManualCount > 0 && res.insertedCount === 0) {
        params.onNotify?.(
          'Skipped sensor snapshot because a Manual operator reading already exists at this time.'
        );
      } else {
        params.onNotify?.(`Captured sensor reading (${reading.sensorCode}) as source = Sensor.`);
      }
      return res;
    },
    [latestByLine, config.adapterMode, params]
  );

  const importSensorFile = useCallback(
    async (
      batch: ProductionBatch,
      content: string,
      fileName: string
    ): Promise<SensorIngestResult & { parseErrors: string[] }> => {
      const parsed = parseSensorImportFile(content, fileName, batch.lineName);
      if (parsed.readings.length === 0) {
        return {
          insertedCount: 0,
          skippedDuplicateCount: 0,
          skippedManualCount: 0,
          totalEvaluated: 0,
          parseErrors: parsed.errors,
        };
      }
      const res = await ingestBatchSensorReadings(batch.id, {
        readings: parsed.readings,
        mode: 'file-import',
      });
      setLastSavedAt(new Date().toTimeString().slice(0, 8));
      return { ...res, parseErrors: parsed.errors };
    },
    []
  );

  let connectionState: SensorConnectionState = 'disabled';
  if (config.masterEnabled) {
    if (!lineEnabled) {
      connectionState = 'line-disabled';
    } else if (offlineAlarm) {
      connectionState = 'offline';
    } else if (lastAdapterError) {
      connectionState = 'error';
    } else if (config.adapterMode === 'file') {
      connectionState = 'standby';
    } else if (config.adapterMode === 'mqtt') {
      connectionState = mqttConnected ? 'connected' : 'standby';
    } else {
      connectionState = lastReceivedAtMs ? 'connected' : 'standby';
    }
  }

  return {
    config,
    connectionState,
    latestByLine,
    latestForActiveLine: latestByLine[activeLineName] || null,
    bufferedCount: bufferedReadings.length,
    lastReceivedAt,
    lastSavedAt,
    offlineAlarm,
    lastAdapterError,
    busyBackfill,
    triggerBackfill,
    captureSnapshotNow,
    importSensorFile,
    flushBufferNow,
  };
}
