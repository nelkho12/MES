import { useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  History,
  Settings,
  Upload,
  WifiOff,
} from 'lucide-react';
import type { ProductionBatch } from '../types';
import type { UseSensorAdapterReturn } from '../hooks/useSensorAdapter';

interface SensorAdapterBannerProps {
  batch: ProductionBatch;
  adapter: UseSensorAdapterReturn;
  isLocked: boolean;
  onOpenSettings: () => void;
  onNotify: (msg: string) => void;
}

export function SensorAdapterBanner({
  batch,
  adapter,
  isLocked,
  onOpenSettings,
  onNotify,
}: SensorAdapterBannerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  const live = adapter.latestForActiveLine;
  const masterOn = adapter.config.masterEnabled;

  async function handleFileSelected(file: File | undefined) {
    if (!file) return;
    setImporting(true);
    try {
      const content = await file.text();
      const res = await adapter.importSensorFile(batch, content, file.name);
      onNotify(
        `Sensor file "${file.name}": imported ${res.insertedCount} reading(s) as source=Sensor` +
          (res.skippedManualCount > 0
            ? `, preserved ${res.skippedManualCount} manual slot(s)`
            : '') +
          (res.skippedDuplicateCount > 0
            ? `, skipped ${res.skippedDuplicateCount} duplicate(s)`
            : '') +
          (res.parseErrors.length > 0 ? ` (${res.parseErrors.length} parse warnings)` : '.')
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to import sensor CSV/JSON file.');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-[#F7F8FA] p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Cpu className="w-4 h-4 text-teal-700 shrink-0" />
          <span className="font-semibold text-slate-900">
            Optional Sensor Bridge
          </span>
          <span
            className={`px-2 py-0.5 rounded font-mono text-[11px] font-semibold ${
              !masterOn
                ? 'bg-slate-200 text-slate-700'
                : adapter.connectionState === 'offline' ||
                    adapter.connectionState === 'error'
                  ? 'bg-red-100 text-red-800'
                  : adapter.connectionState === 'line-disabled'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
            }`}
          >
            {!masterOn
              ? 'OFF · 100% Manual Mode'
              : adapter.connectionState === 'line-disabled'
                ? `${batch.lineName} Sensor OFF`
                : adapter.connectionState === 'offline'
                  ? 'OFFLINE ALARM'
                  : adapter.connectionState === 'error'
                    ? 'GATEWAY ERROR'
                    : `${adapter.config.adapterMode.toUpperCase()} LIVE`}
          </span>
          {masterOn && adapter.lastReceivedAt && (
            <span className="text-[11px] font-mono text-slate-500">
              Last read {adapter.lastReceivedAt}
            </span>
          )}
          {adapter.bufferedCount > 0 && (
            <span className="text-[11px] font-mono text-teal-700">
              · {adapter.bufferedCount} buffered (auto-save every{' '}
              {adapter.config.saveIntervalSec}s)
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isLocked && (
            <>
              {masterOn && (
                <button
                  type="button"
                  onClick={() => void adapter.captureSnapshotNow(batch)}
                  className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  <Activity className="w-3.5 h-3.5" />
                  Capture Sensor Now
                </button>
              )}

              <button
                type="button"
                disabled={adapter.busyBackfill}
                onClick={() => void adapter.triggerBackfill(batch)}
                title="Pull missed timestamped readings from local Gateway history without overwriting Manual entries"
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-teal-600 rounded-md"
              >
                <History
                  className={`w-3.5 h-3.5 ${adapter.busyBackfill ? 'animate-spin' : ''}`}
                />
                {adapter.busyBackfill ? 'Back-Filling...' : 'Back-Fill Missed Readings'}
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json,application/json,text/csv"
                className="hidden"
                onChange={(e) => void handleFileSelected(e.target.files?.[0])}
              />
              <button
                type="button"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-teal-600 rounded-md"
              >
                <Upload className="w-3.5 h-3.5" />
                {importing ? 'Importing...' : 'Import CSV / JSON'}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onOpenSettings}
            className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-teal-600 rounded-md"
          >
            <Settings className="w-3.5 h-3.5" />
            Sensor Settings
          </button>
        </div>
      </div>

      {/* Live Snapshot Strip */}
      {masterOn && live && (
        <div className="bg-white border border-slate-200 rounded-md px-3 py-2 flex flex-wrap items-center gap-4 text-[11px] font-mono tabular-nums">
          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {live.sensorCode}
          </span>
          {live.tempC !== null && <span>Temp: {live.tempC}°C</span>}
          {live.brix !== null && <span>Brix: {live.brix}%</span>}
          {live.ph !== null && <span>pH: {live.ph}</span>}
          {live.viscosityCp !== null && <span>Visc: {live.viscosityCp} cP</span>}
          {live.speedRpm !== null && <span>Speed: {live.speedRpm} RPM</span>}
          {live.pressureBar !== null && <span>Press: {live.pressureBar} bar</span>}
        </div>
      )}

      {/* Offline Alarm + Manual Fallback Assurance */}
      {adapter.offlineAlarm && (
        <div className="border border-red-300 bg-red-50 text-red-900 rounded-md px-3 py-2 flex items-start gap-2 text-xs">
          <WifiOff className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">{adapter.offlineAlarm}</div>
            <div className="text-[11px] text-red-800 mt-0.5">
              Browser only polls while this tab is open. Reconnect your gateway and click{' '}
              <strong>Back-Fill Missed Readings</strong>, or continue entering readings manually below.
            </div>
          </div>
        </div>
      )}

      {!masterOn && (
        <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span>
            Sensors are switched OFF. Step 5 works 100% manually below. Sensor captures &amp; CSV/JSON imports never overwrite Manual operator records.
          </span>
        </div>
      )}
    </div>
  );
}
