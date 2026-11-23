import { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileJson,
  FileSpreadsheet,
  Power,
  RefreshCw,
  ServerOff,
  Settings,
  ShieldCheck,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  FinishedGoodLot,
  RawMaterialLot,
  RolePermissionMatrix,
  UserRole,
  WmsConnectorConfig,
} from '../types';
import {
  DEFAULT_WMS_CONNECTOR_CONFIG,
  WMS_SCHEMA_VERSION,
  buildWmsFinishedGoodsCsv,
  buildWmsFinishedGoodsJson,
  buildWmsRawMaterialsCsv,
  buildWmsRawMaterialsJson,
  parseWmsImportContent,
  pullFinishedGoodsFromWmsRest,
  pullRawMaterialsFromWmsRest,
  pushFinishedGoodsToWmsRest,
  testWmsRestConnection,
  triggerBrowserDownload,
} from '../services/wmsConnector';
import {
  importWmsFinishedGoods,
  importWmsRawMaterials,
  updateWmsConnectorConfig,
} from '../services/mesService';
import { hasFeaturePermission } from '../services/permissions';
import { RolePermissionsPanel } from './RolePermissionsPanel';

interface AdminSettingsModalProps {
  userRole: UserRole;
  rolePermissions?: RolePermissionMatrix;
  initialTab?: 'roles' | 'rest' | 'files' | 'spec';
  wmsConfig?: WmsConnectorConfig;
  rawMaterials: RawMaterialLot[];
  finishedGoods: FinishedGoodLot[];
  workspaceBackup?: Record<string, unknown>;
  onOpenSensorSettings: () => void;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

export function AdminSettingsModal({
  userRole,
  rolePermissions,
  initialTab = 'roles',
  wmsConfig,
  rawMaterials,
  finishedGoods,
  workspaceBackup,
  onOpenSensorSettings,
  onClose,
  onNotify,
}: AdminSettingsModalProps) {
  const initial = wmsConfig || DEFAULT_WMS_CONNECTOR_CONFIG;
  const [tab, setTab] = useState<'roles' | 'rest' | 'files' | 'spec'>(initialTab);
  const [draft, setDraft] = useState<WmsConnectorConfig>({
    ...DEFAULT_WMS_CONNECTOR_CONFIG,
    ...initial,
  });
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const rmFileRef = useRef<HTMLInputElement | null>(null);
  const fgFileRef = useRef<HTMLInputElement | null>(null);

  const canConfigure = hasFeaturePermission(
    rolePermissions,
    userRole,
    'manageInventoryWms'
  );

  async function handleSaveConfig() {
    if (!canConfigure) {
      onNotify('Switch to Admin or Manager role to change WMS connector settings.');
      return;
    }
    setBusy(true);
    try {
      await updateWmsConnectorConfig(draft);
      onNotify(
        draft.enabled
          ? `WMS REST Connector ENABLED (${draft.baseUrl}).`
          : 'WMS REST Connector saved (Switched OFF — file export/import mode active).'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to save WMS settings.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTestWms() {
    setSyncBusy(true);
    setTestResult(null);
    const res = await testWmsRestConnection(draft);
    setTestResult({ ok: res.ok, msg: res.message });
    setSyncBusy(false);
  }

  async function handlePullRawStockRest() {
    setSyncBusy(true);
    try {
      const items = await pullRawMaterialsFromWmsRest(draft);
      const res = await importWmsRawMaterials(items);
      await updateWmsConnectorConfig({
        ...draft,
        lastSyncAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      });
      onNotify(
        `WMS REST Pull Raw Stock: ${res.createdCount} created, ${res.updatedCount} updated, ${res.skippedCount} skipped.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to pull raw stock from WMS.');
    } finally {
      setSyncBusy(false);
    }
  }

  async function handlePushFinishedGoodsRest() {
    setSyncBusy(true);
    try {
      const pushRes = await pushFinishedGoodsToWmsRest(draft, finishedGoods);
      await updateWmsConnectorConfig({
        ...draft,
        lastSyncAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
      });
      onNotify(
        `Pushed ${pushRes.count} finished-goods lot(s) to WMS REST endpoint (${pushRes.status}).`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to push finished goods to WMS.');
    } finally {
      setSyncBusy(false);
    }
  }

  async function handlePullFinishedGoodsRest() {
    setSyncBusy(true);
    try {
      const items = await pullFinishedGoodsFromWmsRest(draft);
      const res = await importWmsFinishedGoods(items);
      onNotify(
        `WMS REST Pull FG Lots: ${res.createdCount} created, ${res.updatedCount} updated, ${res.skippedCount} skipped.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to pull finished goods from WMS.');
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleImportFile(type: 'raw' | 'fg', file: File | undefined) {
    if (!file) return;
    setSyncBusy(true);
    try {
      const content = await file.text();
      const parsed = parseWmsImportContent(content, file.name);
      if (parsed.items.length === 0) {
        onNotify(parsed.errors[0] || 'No valid rows found in import file.');
        return;
      }
      const res =
        type === 'raw'
          ? await importWmsRawMaterials(parsed.items)
          : await importWmsFinishedGoods(parsed.items);
      onNotify(
        `${type === 'raw' ? 'Raw Material' : 'Finished Goods'} import ("${file.name}"): ${res.createdCount} created, ${res.updatedCount} updated, ${res.skippedCount} skipped.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'WMS file import failed.');
    } finally {
      setSyncBusy(false);
      if (rmFileRef.current) rmFileRef.current.value = '';
      if (fgFileRef.current) fgFileRef.current.value = '';
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Settings className="w-5 h-5 text-teal-700" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Admin Settings — Roles, WMS Hooks &amp; Integration Formats
              </h2>
              <p className="text-xs text-slate-500">
                Configure role feature tick permissions, standardized WMS JSON/CSV files (no server needed), and optional REST connector (OFF by default).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-800 rounded-md"
            aria-label="Close Admin Settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sub-Navigation */}
        <div className="px-6 pt-3 border-b border-slate-200 bg-[#F7F8FA] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 overflow-x-auto">
            {(
              [
                ['roles', 'Role Permissions (Tick Control)'],
                ['rest', 'Optional WMS REST Connector'],
                ['files', 'JSON / CSV File Sync (No Server)'],
                ['spec', 'File & API Format Docs'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-3.5 py-2 text-xs font-semibold rounded-t-md border-b-2 whitespace-nowrap transition-colors ${
                  tab === id
                    ? 'border-teal-700 text-teal-800 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenSensorSettings();
            }}
            className="mb-1 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 whitespace-nowrap"
          >
            Open Sensor Adapter Settings →
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs">
          {tab === 'roles' && (
            <RolePermissionsPanel
              activeRole={userRole}
              rolePermissions={rolePermissions}
              onNotify={onNotify}
            />
          )}

          {tab === 'rest' && (
            <>
              {!canConfigure && (
                <div className="border border-amber-300 bg-amber-50 rounded-lg p-3 flex items-center gap-2 text-amber-900">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>
                    Active role is <strong className="uppercase">{userRole}</strong>. Switch to{' '}
                    <strong>Admin</strong> or <strong>Manager</strong> to modify WMS REST settings.
                  </span>
                </div>
              )}

              {/* Switch OFF by default */}
              <div className="border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 bg-[#F7F8FA]">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      draft.enabled
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {draft.enabled ? (
                      <Power className="w-5 h-5" />
                    ) : (
                      <ServerOff className="w-5 h-5" />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      External WMS REST Connector
                    </div>
                    <div className="text-xs text-slate-500">
                      {draft.enabled
                        ? 'ON — Browser client calls your configured WMS REST URL directly.'
                        : 'OFF (Default) — No external WMS calls. Use JSON/CSV export & import anytime.'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!canConfigure}
                  onClick={() => setDraft((p) => ({ ...p, enabled: !p.enabled }))}
                  className={`min-h-[44px] px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                    draft.enabled
                      ? 'bg-emerald-700 hover:bg-emerald-800 text-white'
                      : 'bg-slate-800 hover:bg-slate-900 text-white'
                  } disabled:opacity-50`}
                >
                  {draft.enabled ? 'Connector: ON' : 'Connector: OFF'}
                </button>
              </div>

              {/* URL Inputs */}
              <div className="border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                  <Wifi className="w-4 h-4 text-teal-700" />
                  External WMS REST Endpoint Configuration
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      WMS Base URL
                    </label>
                    <input
                      type="url"
                      disabled={!canConfigure}
                      value={draft.baseUrl}
                      onChange={(e) => setDraft((p) => ({ ...p, baseUrl: e.target.value }))}
                      placeholder="https://wms.mayralab.local/api/wms"
                      className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Raw Materials Stock Path (GET)
                    </label>
                    <input
                      type="text"
                      disabled={!canConfigure}
                      value={draft.rawMaterialsPath}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, rawMaterialsPath: e.target.value }))
                      }
                      className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Finished Goods Lots Path (GET / POST)
                    </label>
                    <input
                      type="text"
                      disabled={!canConfigure}
                      value={draft.finishedGoodsPath}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, finishedGoodsPath: e.target.value }))
                      }
                      className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Request Timeout (ms)
                    </label>
                    <input
                      type="number"
                      min={1000}
                      max={60000}
                      disabled={!canConfigure}
                      value={draft.timeoutMs}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          timeoutMs: Math.max(1000, Number(e.target.value) || 8000),
                        }))
                      }
                      className="w-full min-h-[40px] border border-slate-200 rounded-md px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-end pb-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={!canConfigure}
                        checked={draft.autoPushFgOnQcPass}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, autoPushFgOnQcPass: e.target.checked }))
                        }
                        className="rounded border-slate-300"
                      />
                      <span>Auto-push Finished Good lot when QC Pass posts inventory</span>
                    </label>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <button
                    type="button"
                    disabled={syncBusy}
                    onClick={() => void handleTestWms()}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncBusy ? 'animate-spin' : ''}`} />
                    Test WMS URL
                  </button>
                  {draft.enabled && (
                    <>
                      <button
                        type="button"
                        disabled={syncBusy}
                        onClick={() => void handlePullRawStockRest()}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-md"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Pull Raw Stock from WMS
                      </button>
                      <button
                        type="button"
                        disabled={syncBusy}
                        onClick={() => void handlePushFinishedGoodsRest()}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Push Finished Lots to WMS
                      </button>
                      <button
                        type="button"
                        disabled={syncBusy}
                        onClick={() => void handlePullFinishedGoodsRest()}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-teal-600 rounded-md"
                      >
                        Pull FG Zone/Stock Updates
                      </button>
                    </>
                  )}
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

                {draft.lastSyncAt && (
                  <div className="text-[11px] text-slate-500 font-mono">
                    Last WMS REST Sync: {draft.lastSyncAt}
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy || !canConfigure}
                  onClick={() => void handleSaveConfig()}
                  className="min-h-[42px] px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Save Admin WMS Settings'}
                </button>
              </div>
            </>
          )}

          {tab === 'files' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Raw Material Stock Exchange */}
              <div className="border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                    <Database className="w-4 h-4 text-teal-700" />
                    Raw Material Stock ({rawMaterials.length} lots)
                  </div>
                  <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 rounded text-slate-600">
                    {WMS_SCHEMA_VERSION}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Export MES raw stock or import WMS receiving updates directly as JSON or CSV—no WMS server needed.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const json = buildWmsRawMaterialsJson(rawMaterials);
                      triggerBrowserDownload(
                        JSON.stringify(json, null, 2),
                        `wms-raw-materials-${stamp}.json`,
                        'application/json'
                      );
                      onNotify(`Exported ${rawMaterials.length} raw material lots (JSON).`);
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-slate-200 hover:border-teal-600 rounded-md"
                  >
                    <FileJson className="w-3.5 h-3.5 text-teal-700" />
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const csv = buildWmsRawMaterialsCsv(rawMaterials);
                      triggerBrowserDownload(
                        csv,
                        `wms-raw-materials-${stamp}.csv`,
                        'text/csv;charset=utf-8'
                      );
                      onNotify(`Exported ${rawMaterials.length} raw material lots (CSV).`);
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-slate-200 hover:border-teal-600 rounded-md"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                    Export CSV
                  </button>
                </div>
                <div className="pt-2 border-t border-slate-100">
                  <input
                    ref={rmFileRef}
                    type="file"
                    accept=".json,.csv,application/json,text/csv"
                    className="hidden"
                    onChange={(e) => void handleImportFile('raw', e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    disabled={syncBusy}
                    onClick={() => rmFileRef.current?.click()}
                    className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                  >
                    <Upload className="w-4 h-4" />
                    Import Raw Material Stock (JSON / CSV)
                  </button>
                </div>
              </div>

              {/* Finished Goods Lots Exchange */}
              <div className="border border-slate-200 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                    <Database className="w-4 h-4 text-teal-700" />
                    Finished Goods Lots ({finishedGoods.length} lots)
                  </div>
                  <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 rounded text-slate-600">
                    {WMS_SCHEMA_VERSION}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Export released FG lots for WMS putaway/dispatch, or import WMS bin/stock updates back into MES.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const json = buildWmsFinishedGoodsJson(finishedGoods);
                      triggerBrowserDownload(
                        JSON.stringify(json, null, 2),
                        `wms-finished-goods-${stamp}.json`,
                        'application/json'
                      );
                      onNotify(`Exported ${finishedGoods.length} finished goods lots (JSON).`);
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-slate-200 hover:border-teal-600 rounded-md"
                  >
                    <FileJson className="w-3.5 h-3.5 text-teal-700" />
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const csv = buildWmsFinishedGoodsCsv(finishedGoods);
                      triggerBrowserDownload(
                        csv,
                        `wms-finished-goods-${stamp}.csv`,
                        'text/csv;charset=utf-8'
                      );
                      onNotify(`Exported ${finishedGoods.length} finished goods lots (CSV).`);
                    }}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-slate-200 hover:border-teal-600 rounded-md"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                    Export CSV
                  </button>
                </div>
                <div className="pt-2 border-t border-slate-100">
                  <input
                    ref={fgFileRef}
                    type="file"
                    accept=".json,.csv,application/json,text/csv"
                    className="hidden"
                    onChange={(e) => void handleImportFile('fg', e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    disabled={syncBusy}
                    onClick={() => fgFileRef.current?.click()}
                    className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-md"
                  >
                    <Upload className="w-4 h-4" />
                    Import Finished Goods Lots (JSON / CSV)
                  </button>
                </div>
              </div>

              {workspaceBackup && (
                <div className="md:col-span-2 border border-slate-200 bg-[#F7F8FA] rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                      <Download className="w-4 h-4 text-teal-700" />
                      Full MES Workspace JSON Backup
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Download a complete point-in-time snapshot (Formulas, Raw Materials, Job Orders/Batches, Finished Goods, QC Batch Checks, Lines, Sensors, Role Matrix &amp; Audit Logs).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      triggerBrowserDownload(
                        JSON.stringify(workspaceBackup, null, 2),
                        `kettler-mes-backup-${stamp}.json`,
                        'application/json'
                      );
                      onNotify('Downloaded full MES workspace JSON backup.');
                    }}
                    className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-teal-800 bg-white border border-teal-300 hover:bg-teal-50 rounded-md whitespace-nowrap"
                  >
                    <FileJson className="w-4 h-4" />
                    Download Workspace Backup (JSON)
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'spec' && (
            <div className="space-y-4 text-xs">
              <div className="border border-slate-200 rounded-lg p-4 space-y-2 bg-[#F7F8FA]">
                <div className="font-semibold text-slate-900 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-teal-700" />
                  Agreed File &amp; REST API Formats ({WMS_SCHEMA_VERSION})
                </div>
                <p className="text-slate-600">
                  Full specification is also documented in{' '}
                  <code className="font-mono bg-white px-1.5 py-0.5 rounded border">
                    docs/WMS_INTEGRATION_FORMAT.md
                  </code>
                  . All imports match existing lots by <code className="font-mono">lotNumber</code> (case-insensitive) and create an audit trail entry.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-slate-200 rounded-lg p-3.5 space-y-2">
                  <div className="font-semibold text-slate-900">
                    Raw Material Stock JSON / CSV Fields
                  </div>
                  <pre className="bg-slate-900 text-slate-100 p-3 rounded font-mono text-[11px] overflow-x-auto">{`{
  "schemaVersion": "mayralab-wms-v1",
  "recordType": "raw_material_stock",
  "items": [{
    "lotNumber": "RM-SOY-261120-A",
    "materialCode": "ING-SOY-05",
    "materialName": "Organic Tamari Soy Base",
    "category": "Ingredient",
    "unit": "L",
    "quantityInitial": 1000,
    "quantityAvailable": 850,
    "reorderLevel": 200,
    "unitCost": 3.45,
    "supplier": "Kyoto Ferments",
    "expiryDate": "2027-08-31",
    "storageZone": "Ambient Rack A2"
  }]
}`}</pre>
                </div>

                <div className="border border-slate-200 rounded-lg p-3.5 space-y-2">
                  <div className="font-semibold text-slate-900">
                    Finished Goods Lots JSON / CSV Fields
                  </div>
                  <pre className="bg-slate-900 text-slate-100 p-3 rounded font-mono text-[11px] overflow-x-auto">{`{
  "schemaVersion": "mayralab-wms-v1",
  "recordType": "finished_goods_lots",
  "items": [{
    "lotNumber": "LOT-261120-L1-TERI-001",
    "batchNumber": "B-261120-001",
    "sku": "SKU-TERI-250",
    "productName": "Artisan Teriyaki Glaze",
    "quantityProduced": 1200,
    "quantityAvailable": 1150,
    "unit": "bottles",
    "productionDate": "2026-11-20",
    "expiryDate": "2027-05-19",
    "qcStatus": "Released",
    "warehouseZone": "FG Ambient Aisle 1",
    "unitCost": 1.84
  }]
}`}</pre>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5 space-y-1.5">
                <div className="font-semibold text-slate-900">
                  Optional WMS REST API Contract (External WMS Server)
                </div>
                <ul className="list-disc pl-5 space-y-1 text-slate-700 font-mono text-[11px]">
                  <li>GET {'{baseUrl}'}/raw-materials → returns {'{ schemaVersion, items: RawMaterialStock[] }'} or array</li>
                  <li>GET {'{baseUrl}'}/finished-goods → returns {'{ schemaVersion, items: FinishedGoodsLot[] }'} or array</li>
                  <li>POST {'{baseUrl}'}/finished-goods → receives {'{ schemaVersion, exportedAt, recordType, items }'} JSON</li>
                  <li>External WMS must enable CORS (<code className="font-sans">Access-Control-Allow-Origin</code>) for direct browser applet calls.</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-[#F7F8FA] flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
