import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  FileCode2,
  Info,
  Power,
  RefreshCw,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  ProductionLineMachine,
  RolePermissionMatrix,
  SensorAdapterConfig,
  SensorAdapterMode,
  UserRole,
} from '../types';
import { hasFeaturePermission } from '../services/permissions';
import {
  DEFAULT_SENSOR_ADAPTER_CONFIG,
  pollGatewayRest,
  resolveBackfillUrl,
} from '../services/sensorAdapter';
import { updateSensorAdapterConfig } from '../services/mesService';

interface SensorSettingsModalProps {
  config?: SensorAdapterConfig;
  lines: ProductionLineMachine[];
  userRole?: UserRole;
  rolePermissions?: RolePermissionMatrix;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

const GATEWAY_SCRIPT_SNIPPET = `// Save on a Factory LAN PC as gateway-example.mjs (Node 18+)
// Run: node gateway-example.mjs
// Browser connects to http://<GATEWAY-LAN-IP>:4100/api/readings
// See /gateway-bridge/gateway-example.mjs for full Modbus/OPC-UA/Serial & ring-buffer code.`;

export function SensorSettingsModal({
  config,
  lines,
  userRole,
  rolePermissions,
  onClose,
  onNotify,
}: SensorSettingsModalProps) {
  const canConfigureSensors = userRole
    ? hasFeaturePermission(rolePermissions, userRole, 'configureSensors')
    : true;
  const initial = config || DEFAULT_SENSOR_ADAPTER_CONFIG;
  const [draft, setDraft] = useState<SensorAdapterConfig>({
    ...DEFAULT_SENSOR_ADAPTER_CONFIG,
    ...initial,
    perLineEnabled: { ...(initial.perLineEnabled || {}) },
  });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showGatewayGuide, setShowGatewayGuide] = useState(false);

  const uniqueLineNames = Array.from(
    new Set([
      ...lines.map((l) => l.lineName),
      ...Object.keys(draft.perLineEnabled || {}),
    ])
  ).filter(Boolean);

  function toggleLine(lineName: string) {
    const current = draft.perLineEnabled[lineName] ?? true;
    setDraft((prev) => ({
      ...prev,
      perLineEnabled: {
        ...prev.perLineEnabled,
        [lineName]: !current,
      },
    }));
  }

  async function handleTestGateway() {
    setTesting(true);
    setTestResult(null);
    try {
      const readings = await pollGatewayRest(draft.gatewayUrl, uniqueLineNames[0]);
      setTestResult({
        ok: true,
        msg: `Connected cleanly to ${draft.gatewayUrl}. Received ${readings.length} reading(s). Back-fill endpoint: ${resolveBackfillUrl(draft)}`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to reach Gateway URL.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    try {
      await updateSensorAdapterConfig(draft);
      onNotify(
        draft.masterEnabled
          ? `Sensor Adapter saved (ON · ${draft.adapterMode.toUpperCase()} · poll ${draft.pollingIntervalSec}s / save ${draft.saveIntervalSec}s).`
          : 'Sensor Adapter saved (Master Switch OFF — 100% manual mode).'
      );
      onClose();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to save sensor settings.');
    } finally {
      setBusy(false);
    }
  }

  function handleDownloadGatewayScript() {
    const scriptLink = '/gateway-bridge/gateway-example.mjs';
    onNotify(
      `Local gateway script and README are available in ${scriptLink} in the project repository.`
    );
    setShowGatewayGuide(true);
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-teal-700" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Sensor Adapter &amp; Local Gateway Settings
              </h2>
              <p className="text-xs text-slate-500">
                100% optional hardware bridge. Master switch defaults to OFF for full manual operation.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-800 rounded-md"
            aria-label="Close sensor settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs">
          {/* Browser Limit Warning */}
          <div className="border border-amber-200 bg-amber-50/70 rounded-lg p-3.5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-1 text-amber-950 leading-relaxed">
              <div className="font-semibold">
                Important Browser Hardware &amp; Capture Limits
              </div>
              <p>
                A browser applet cannot connect directly to PLCs, RS-485 serial ports, Modbus RTU/TCP, or OPC-UA servers. Use the standalone{' '}
                <code className="font-mono bg-amber-100 px-1 rounded">
                  gateway-bridge/gateway-example.mjs
                </code>{' '}
                script on a factory LAN PC to poll your devices and expose JSON over REST or MQTT-over-WebSocket.
              </p>
              <p>
                <strong>Tab-Open Limit:</strong> Live browser polling only runs while the Batch Execution screen is open. Your local gateway stores timestamped readings so opening a batch or clicking{' '}
                <strong>Back-Fill Missed Readings</strong> catches up automatically without overwriting any Manual entries.
              </p>
            </div>
          </div>

          {/* Master Switch */}
          <div className="border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 bg-[#F7F8FA]">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  draft.masterEnabled
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                <Power className="w-5 h-5" />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  Master Sensor Monitoring Switch
                </div>
                <div className="text-xs text-slate-500">
                  {draft.masterEnabled
                    ? 'ON — Active lines poll/subscribe and auto-tag readings source = Sensor.'
                    : 'OFF (Default) — No background polling or sockets. Manual entry & file import remain available.'}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setDraft((p) => ({ ...p, masterEnabled: !p.masterEnabled }))
              }
              className={`min-h-[44px] px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                draft.masterEnabled
                  ? 'bg-emerald-700 hover:bg-emerald-800 text-white'
                  : 'bg-slate-800 hover:bg-slate-900 text-white'
              }`}
            >
              {draft.masterEnabled ? 'Master: ON' : 'Master: OFF'}
            </button>
          </div>

          {/* Adapter Mode */}
          <div className="space-y-2">
            <label className="block font-semibold text-slate-800">
              1. Sensor Adapter Input Mode
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              {(
                [
                  ['simulator', 'Built-in Simulator', 'Virtual thermal/Brix/pH waveform'],
                  ['rest', 'Gateway REST Poll', 'Polls LAN gateway JSON + back-fill'],
                  ['mqtt', 'MQTT over WebSocket', 'Subscribes to ws:// / wss:// topic'],
                  ['file', 'CSV / JSON Import', 'Manual batch upload & back-fill'],
                ] as [SensorAdapterMode, string, string][]
              ).map(([mode, title, desc]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDraft((p) => ({ ...p, adapterMode: mode }))}
                  className={`min-h-[60px] text-left p-3 rounded-lg border transition-colors ${
                    draft.adapterMode === mode
                      ? 'border-teal-600 bg-teal-50/70 text-teal-950'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <div className="font-semibold text-xs">{title}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Connection Settings for REST / MQTT */}
          {draft.adapterMode === 'rest' && (
            <div className="border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                <Wifi className="w-4 h-4 text-teal-700" />
                REST Gateway &amp; Back-Fill Endpoints
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Live Readings URL (GET)
                  </label>
                  <input
                    type="url"
                    value={draft.gatewayUrl}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, gatewayUrl: e.target.value }))
                    }
                    placeholder="http://localhost:4100/api/readings"
                    className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Back-Fill History URL (optional; defaults to /history)
                  </label>
                  <input
                    type="url"
                    value={draft.backfillUrl}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, backfillUrl: e.target.value }))
                    }
                    placeholder={resolveBackfillUrl(draft) || 'http://localhost:4100/api/readings/history'}
                    className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.autoBackfillOnOpen}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, autoBackfillOnOpen: e.target.checked }))
                    }
                    className="rounded border-slate-300"
                  />
                  <span>Auto back-fill missed readings when opening an active batch</span>
                </label>
                <button
                  type="button"
                  disabled={testing}
                  onClick={() => void handleTestGateway()}
                  className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
                  {testing ? 'Testing...' : 'Test Gateway URL'}
                </button>
              </div>
              {testResult && (
                <div
                  className={`p-2.5 rounded-md flex items-center gap-2 text-xs ${
                    testResult.ok
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                      : 'bg-red-50 text-red-800 border border-red-200'
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <WifiOff className="w-4 h-4 shrink-0" />
                  )}
                  <span>{testResult.msg}</span>
                </div>
              )}
            </div>
          )}

          {draft.adapterMode === 'mqtt' && (
            <div className="border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                <Activity className="w-4 h-4 text-teal-700" />
                MQTT over WebSocket Broker
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Broker WebSocket URL (ws:// or wss://)
                  </label>
                  <input
                    type="text"
                    value={draft.mqttWsUrl}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, mqttWsUrl: e.target.value }))
                    }
                    placeholder="ws://localhost:9001/mqtt"
                    className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Topic Filter
                  </label>
                  <input
                    type="text"
                    value={draft.mqttTopic}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, mqttTopic: e.target.value }))
                    }
                    placeholder="mayralab/mes/+/readings"
                    className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Expects UTF-8 JSON payloads containing <code className="font-mono">tempC</code>,{' '}
                <code className="font-mono">brix</code>, <code className="font-mono">ph</code>,{' '}
                <code className="font-mono">lineName</code>, and ISO{' '}
                <code className="font-mono">timestamp</code>.
              </p>
            </div>
          )}

          {/* Timing & Alarm Intervals */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="border border-slate-200 rounded-lg p-3">
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Polling Interval (sec)
              </label>
              <input
                type="number"
                min={2}
                max={300}
                value={draft.pollingIntervalSec}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    pollingIntervalSec: Math.max(2, Number(e.target.value) || 5),
                  }))
                }
                className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-1.5 font-mono text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1">How often live UI updates (2–300s)</p>
            </div>
            <div className="border border-slate-200 rounded-lg p-3">
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Batch Auto-Save Interval (sec)
              </label>
              <input
                type="number"
                min={10}
                max={3600}
                value={draft.saveIntervalSec}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    saveIntervalSec: Math.max(10, Number(e.target.value) || 60),
                  }))
                }
                className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-1.5 font-mono text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Writes buffered sensor points to Step 5
              </p>
            </div>
            <div className="border border-slate-200 rounded-lg p-3">
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Offline Alarm Threshold (sec)
              </label>
              <input
                type="number"
                min={10}
                max={3600}
                value={draft.offlineAlarmThresholdSec}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    offlineAlarmThresholdSec: Math.max(10, Number(e.target.value) || 30),
                  }))
                }
                className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-1.5 font-mono text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Flags offline alarm if stream stalls
              </p>
            </div>
          </div>

          {/* Per-Line Switches */}
          <div className="border border-slate-200 rounded-lg p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-slate-800">
                2. Per-Line Sensor Capture Switches
              </div>
              <span className="text-[11px] text-slate-500">
                Only captures when both Master Switch &amp; Line Switch are ON
              </span>
            </div>
            {uniqueLineNames.length === 0 ? (
              <p className="text-slate-500 text-xs">
                No production lines registered yet. Add lines in Line &amp; Machine.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {uniqueLineNames.map((lineName) => {
                  const enabled = draft.perLineEnabled[lineName] ?? true;
                  return (
                    <button
                      key={lineName}
                      type="button"
                      onClick={() => toggleLine(lineName)}
                      className={`min-h-[44px] px-3.5 py-2 rounded-md border flex items-center justify-between text-left transition-colors ${
                        enabled
                          ? 'border-teal-300 bg-teal-50/50 text-slate-900'
                          : 'border-slate-200 bg-slate-50 text-slate-500'
                      }`}
                    >
                      <span className="font-medium truncate pr-2">{lineName}</span>
                      <span
                        className={`font-mono text-[11px] font-semibold px-2 py-0.5 rounded ${
                          enabled
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {enabled ? 'LINE ON' : 'LINE OFF'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Local Gateway Guide Toggle */}
          <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-slate-800">
                <FileCode2 className="w-4 h-4 text-teal-700" />
                <span>Local Factory PC Gateway Script &amp; Setup Guide</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowGatewayGuide((v) => !v)}
                  className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 rounded-md hover:border-teal-600"
                >
                  {showGatewayGuide ? 'Hide Guide' : 'View Setup Guide'}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadGatewayScript}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md"
                >
                  <Download className="w-3.5 h-3.5" />
                  Script Info
                </button>
              </div>
            </div>
            {showGatewayGuide && (
              <div className="pt-2 border-t border-slate-200 space-y-2 text-[11px] text-slate-700">
                <p className="flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 text-teal-700 shrink-0 mt-0.5" />
                  <span>
                    Run <code className="font-mono bg-white px-1 border rounded">gateway-bridge/gateway-example.mjs</code> on a PC inside your plant LAN that can reach your Modbus TCP/RTU, OPC-UA, or RS-232/485 scales/kettles. It buffers timestamped JSON readings into <code className="font-mono bg-white px-1 border rounded">readings-buffer.jsonl</code> so the applet can back-fill gaps whenever a tablet sleeps or closes.
                  </span>
                </p>
                <pre className="bg-slate-900 text-slate-100 p-3 rounded-md font-mono text-[11px] overflow-x-auto">
                  {GATEWAY_SCRIPT_SNIPPET}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 bg-[#F7F8FA] flex flex-wrap items-center justify-between gap-3">
          <span className="text-[11px] text-slate-500">
            {canConfigureSensors ? (
              <>
                Sensor entries are always tagged <code className="font-mono">source = Sensor</code> and never overwrite Manual entries.
              </>
            ) : (
              <>
                Read-only view: active role ({userRole}) lacks &ldquo;Configure Sensor Adapter&rdquo; tick permission.
              </>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[42px] px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !canConfigureSensors}
              onClick={() => void handleSave()}
              className="min-h-[42px] px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-45 disabled:cursor-not-allowed rounded-md"
            >
              {busy ? 'Saving...' : 'Save Sensor Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
