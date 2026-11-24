import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  Cpu,
  FileSpreadsheet,
  GitBranch,
  LayoutDashboard,
  LogOut,
  RotateCcw,
  Server,
  Settings,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type {
  ActiveTab,
  AuditLogEntry,
  BatchCheckRecord,
  BatchCheckSpec,
  CategoryParameterPresetMap,
  DbConnectionConfigPublic,
  FinishedGoodLot,
  FormulaBOM,
  ProductionBatch,
  ProductionLineMachine,
  RawMaterialLot,
  RolePermissionMatrix,
  SensorAdapterConfig,
  SqlAuthUser,
  TelemetryHistoryPoint,
  ThermalSensor,
  UserRole,
  WmsConnectorConfig,
} from './types';
import { computeYieldOptimizations } from './utils/units';
import {
  countEnabledFeatures,
  DEFAULT_ROLE_PERMISSIONS,
  hasFeaturePermission,
  MES_FEATURE_DEFINITIONS,
} from './services/permissions';
import { DEFAULT_SENSOR_ADAPTER_CONFIG } from './services/sensorAdapter';
import { DEFAULT_WMS_CONNECTOR_CONFIG } from './services/wmsConnector';
import {
  fetchSensorsFromSql,
  fetchWorkspaceSnapshot,
  updateThermalSensor,
  updateUserRole,
  WORKSPACE_SYNC_EVENT,
} from './services/mesService';
import {
  fetchDbConnectionConfig,
  logoutSqlSession,
  restoreSqlSession,
  subscribeSqlAuth,
} from './services/sqlAuthClient';
import { SensorSettingsModal } from './components/SensorSettingsModal';
import { AdminSettingsModal } from './components/AdminSettingsModal';
import { DesktopSqlModal } from './components/DesktopSqlModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthGate } from './components/AuthGate';
import { OverviewView } from './components/OverviewView';
import { BatchesView } from './components/BatchesView';
import { InventoryView } from './components/InventoryView';
import { FormulasView } from './components/FormulasView';
import { BatchCheckView } from './components/BatchCheckView';
import { LinesMachinesView } from './components/LinesMachinesView';
import { TraceabilityView } from './components/TraceabilityView';
import { MonthlyProductionReport } from './components/MonthlyProductionReport';
import { BatchReportModal } from './components/BatchReportModal';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';

const NAV_ITEMS: { id: ActiveTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Plant Overview', icon: LayoutDashboard },
  { id: 'batches', label: 'Batch Execution', icon: ClipboardList },
  { id: 'inventory', label: 'Lot Inventory', icon: Boxes },
  { id: 'batch-check', label: 'Batch Check', icon: ClipboardCheck },
  { id: 'lines-machines', label: 'Line & Machine', icon: Settings2 },
  { id: 'formulas', label: 'Formulas & BOM', icon: FileSpreadsheet },
  { id: 'traceability', label: 'Traceability', icon: GitBranch },
  { id: 'reports', label: 'Monthly Reports', icon: BarChart3 },
];

const TAB_TITLES: Record<ActiveTab, string> = {
  overview: 'Plant Floor Overview',
  batches: 'Batch Manufacturing & 9-Step Execution',
  inventory: 'Raw Materials & Finished Goods Inventory',
  'batch-check': 'Batch Check — Sauce, Syrup & Powder Condition Records',
  'lines-machines': 'Production Line & Machine Settings',
  formulas: 'Product Master & Versioned Formulas',
  traceability: 'Forward & Backward Lot Traceability',
  reports: 'Monthly KPI Yield & Production Output Report',
};

function formatTelemetryTime(isoOrDate?: string | Date): string {
  if (!isoOrDate) return new Date().toTimeString().slice(0, 8);
  const dt = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (!Number.isNaN(dt.getTime())) {
    return dt.toTimeString().slice(0, 8);
  }
  return String(isoOrDate).slice(0, 8);
}

function buildRealTelemetryHistory(
  sensors: ThermalSensor[],
  batches: ProductionBatch[]
): TelemetryHistoryPoint[] {
  const bucketMap = new Map<string, TelemetryHistoryPoint>();

  const recordedChecks = batches
    .flatMap((batch) => batch.processChecks || [])
    .filter((chk) => typeof chk.recordedTempC === 'number' && Number.isFinite(chk.recordedTempC))
    .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime())
    .slice(-24);

  for (const chk of recordedChecks) {
    const label = formatTelemetryTime(chk.recordedAt);
    const point = bucketMap.get(label) || { time: label };
    const code = chk.sensorCode || sensors.find((s) => s.name === chk.stepName)?.sensorCode;
    if (code && chk.recordedTempC !== null) {
      point[code] = Number(chk.recordedTempC.toFixed(1));
      bucketMap.set(label, point);
    }
  }

  if (sensors.length > 0) {
    const latestTs = sensors
      .map((s) => (s.updatedAt ? new Date(s.updatedAt).getTime() : 0))
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => a - b)
      .pop();
    const currentLabel = formatTelemetryTime(latestTs ? new Date(latestTs) : undefined);
    const currentPoint = bucketMap.get(currentLabel) || { time: currentLabel };
    for (const s of sensors) {
      currentPoint[s.sensorCode] = Number(s.currentTempC.toFixed(1));
    }
    bucketMap.set(currentLabel, currentPoint);
  }

  return Array.from(bucketMap.values()).slice(-16);
}

function MesWorkspace({ user }: { user: SqlAuthUser }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [userRole, setUserRole] = useState<UserRole>('manager');
  const [formulas, setFormulas] = useState<FormulaBOM[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialLot[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGoodLot[]>([]);
  const [sensors, setSensors] = useState<ThermalSensor[]>([]);
  const [liveSensors, setLiveSensors] = useState<ThermalSensor[]>([]);
  const [batchCheckSpecs, setBatchCheckSpecs] = useState<BatchCheckSpec[]>([]);
  const [batchCheckRecords, setBatchCheckRecords] = useState<BatchCheckRecord[]>([]);
  const [productionLines, setProductionLines] = useState<ProductionLineMachine[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [productCategories, setProductCategories] = useState<string[]>([
    'Sauce',
    'Syrup',
    'Powder',
  ]);
  const [operationalStatuses, setOperationalStatuses] = useState<string[]>([
    'Active',
    'Standby',
    'CIP Cleaning',
    'Maintenance',
  ]);
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryHistoryPoint[]>([]);
  const [sensorConfig, setSensorConfig] = useState<SensorAdapterConfig>(
    DEFAULT_SENSOR_ADAPTER_CONFIG
  );
  const [wmsConfig, setWmsConfig] = useState<WmsConnectorConfig>(
    DEFAULT_WMS_CONNECTOR_CONFIG
  );
  const [rolePermissions, setRolePermissions] = useState<RolePermissionMatrix>(
    DEFAULT_ROLE_PERMISSIONS
  );
  const [categoryParameterPresets, setCategoryParameterPresets] =
    useState<CategoryParameterPresetMap>({});
  const [showSensorSettings, setShowSensorSettings] = useState(false);
  const [showAdminSettings, setShowAdminSettings] = useState(false);
  const [showDesktopSqlModal, setShowDesktopSqlModal] = useState(false);
  const [desktopSqlTab, setDesktopSqlTab] = useState<'sql' | 'desktop' | 'password'>('sql');
  const [dbConfig, setDbConfig] = useState<DbConnectionConfigPublic | null>(null);
  const [adminInitialTab, setAdminInitialTab] = useState<'roles' | 'rest' | 'files' | 'spec'>('roles');
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [reportBatchId, setReportBatchId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
  }

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const loadWorkspace = useCallback(async (isInitial = false) => {
    try {
      if (isInitial) setLoadingWorkspace(true);
      const snapshot = await fetchWorkspaceSnapshot();
      setUserRole(snapshot.profile.role);
      setFormulas(snapshot.formulas);
      setRawMaterials(snapshot.rawMaterials);
      setBatches(snapshot.batches);
      setFinishedGoods(snapshot.finishedGoods);
      setSensors(snapshot.sensors);
      setLiveSensors(snapshot.sensors);
      setBatchCheckSpecs(snapshot.batchCheckSpecs || []);
      setBatchCheckRecords(snapshot.batchCheckRecords || []);
      setProductionLines(snapshot.productionLines || []);
      setAuditLogs(snapshot.auditLogs || []);
      if (snapshot.profile.productCategories?.length) {
        setProductCategories(snapshot.profile.productCategories);
      }
      if (snapshot.profile.operationalStatuses?.length) {
        setOperationalStatuses(snapshot.profile.operationalStatuses);
      }
      if (snapshot.profile.sensorConfig) {
        setSensorConfig({
          ...DEFAULT_SENSOR_ADAPTER_CONFIG,
          ...snapshot.profile.sensorConfig,
        });
        setIsStreaming(Boolean(snapshot.profile.sensorConfig.masterEnabled));
      }
      if (snapshot.profile.wmsConfig) {
        setWmsConfig({
          ...DEFAULT_WMS_CONNECTOR_CONFIG,
          ...snapshot.profile.wmsConfig,
        });
      }
      if (snapshot.profile.rolePermissions) {
        setRolePermissions(snapshot.profile.rolePermissions);
      }
      if (snapshot.profile.categoryParameterPresets) {
        setCategoryParameterPresets(snapshot.profile.categoryParameterPresets);
      }
      setTelemetryHistory(buildRealTelemetryHistory(snapshot.sensors, snapshot.batches));
      setLastSavedAt(new Date().toTimeString().slice(0, 8));
      setWorkspaceError(null);
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Unable to load plant workspace data right now.';
      setWorkspaceError(msg);
    } finally {
      if (isInitial) setLoadingWorkspace(false);
    }
  }, []);

  // Load workspace & active SQL endpoint info on sign-in, and re-sync whenever a mutation completes
  useEffect(() => {
    void loadWorkspace(true);
    void fetchDbConnectionConfig()
      .then(setDbConfig)
      .catch(() => {
        // Non-privileged roles may not inspect DB host config; ignore silently
      });

    const handleSync = () => {
      void loadWorkspace(false);
    };
    window.addEventListener(WORKSPACE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener(WORKSPACE_SYNC_EVENT, handleSync);
    };
  }, [user, loadWorkspace]);

  // Live sensor telemetry polling from PostgreSQL (only active when Master Sensor Switch is ON & streaming)
  useEffect(() => {
    if (!sensorConfig.masterEnabled || !isStreaming) return;

    const intervalMs = Math.max(3000, (sensorConfig.pollingIntervalSec || 5) * 1000);
    let cancelled = false;

    const timer = window.setInterval(() => {
      void fetchSensorsFromSql()
        .then((latestSensors) => {
          if (cancelled) return;
          setSensors(latestSensors);
          setLiveSensors(latestSensors);
          const label = new Date().toTimeString().slice(0, 8);
          setTelemetryHistory((prev) => {
            const point: TelemetryHistoryPoint = { time: label };
            for (const s of latestSensors) {
              point[s.sensorCode] = Number(s.currentTempC.toFixed(1));
            }
            return [...prev.slice(-15), point];
          });
        })
        .catch(() => {
          // Keep last verified PostgreSQL readings if a single poll fails
        });
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sensorConfig.masterEnabled, sensorConfig.pollingIntervalSec, isStreaming]);

  const recommendations = useMemo(
    () => computeYieldOptimizations(liveSensors, batches, rawMaterials),
    [liveSensors, batches, rawMaterials]
  );

  async function handleRoleChange(nextRole: UserRole) {
    const prevRole = userRole;
    setUserRole(nextRole);
    try {
      await updateUserRole(user.uid, nextRole);
      const enabledCount = countEnabledFeatures(rolePermissions, nextRole);
      showToast(
        `Switched active role to ${nextRole.toUpperCase()} (${enabledCount}/${MES_FEATURE_DEFINITIONS.length} features enabled).`
      );
    } catch (error) {
      setUserRole(prevRole);
      showToast(error instanceof Error ? error.message : 'Unable to switch role right now.');
    }
  }

  async function handleOptimizeSensorById(sensorId: string, targetTempC: number) {
    const sensor = sensors.find((s) => s.id === sensorId);
    if (!sensor) return;
    try {
      await updateThermalSensor(sensor, {
        currentTempC: targetTempC,
        targetTempC,
      });
      showToast(`${sensor.name} PID stabilized at ${targetTempC.toFixed(1)}°C.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to update sensor setpoint.');
    }
  }

  function handleOpenBatch(batchId: string) {
    setSelectedBatchId(batchId);
    setActiveTab('batches');
  }

  const outOfSpecBatchCheckCount = batchCheckRecords.filter(
    (r) => r.conditionStatus !== 'In Spec'
  ).length;
  const qcPendingCount = batches.filter(
    (b) => b.status === 'QC Hold' || b.status === 'QC Review'
  ).length;
  const reportBatch = useMemo(
    () => (reportBatchId ? batches.find((b) => b.id === reportBatchId) || null : null),
    [batches, reportBatchId]
  );

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-slate-900 flex">
      {/* Left Sidebar Navigation (248px) */}
      <aside
        data-print-hide="true"
        className="hidden lg:flex w-[248px] shrink-0 bg-white border-r border-slate-200 flex-col justify-between"
      >
        <div>
          <div className="h-16 px-6 border-b border-slate-200 flex items-center">
            <span className="font-display text-sm font-bold tracking-tight text-slate-900 leading-tight">
              Manufacturing Execution System
            </span>
          </div>

          <nav className="p-3 space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 text-sm rounded-md transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-teal-50 text-teal-800 font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 font-medium'
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.id === 'batches' && qcPendingCount > 0 && (
                    <span className="font-mono text-xs text-amber-700 tabular-nums">
                      {qcPendingCount}
                    </span>
                  )}
                  {item.id === 'batch-check' && outOfSpecBatchCheckCount > 0 && (
                    <span className="font-mono text-xs text-red-700 tabular-nums">
                      {outOfSpecBatchCheckCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Active Role View & Tick Feature Control */}
          <div className="mx-3 mt-4 p-3.5 bg-[#F7F8FA] border border-slate-200 rounded-md space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                <ShieldCheck className="w-3.5 h-3.5 text-teal-700" />
                <span>Active Role View</span>
              </div>
              <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-100 text-teal-800">
                {countEnabledFeatures(rolePermissions, userRole)}/
                {MES_FEATURE_DEFINITIONS.length} ticks
              </span>
            </div>
            <select
              value={userRole}
              onChange={(e) => void handleRoleChange(e.target.value as UserRole)}
              className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:outline-none focus:border-teal-600"
            >
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
              <option value="qc">QC Inspector</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
            <div className="flex flex-wrap gap-1 text-[10px] font-mono">
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  hasFeaturePermission(rolePermissions, userRole, 'viewConfidentialOem')
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}
              >
                {hasFeaturePermission(rolePermissions, userRole, 'viewConfidentialOem')
                  ? 'OEM Full'
                  : 'OEM Mask'}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  hasFeaturePermission(rolePermissions, userRole, 'manageFormulasBom')
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}
              >
                BOM
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  hasFeaturePermission(rolePermissions, userRole, 'planReleaseJobOrders')
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}
              >
                Plan
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  hasFeaturePermission(rolePermissions, userRole, 'qcSignOff')
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}
              >
                QC
              </span>
              <span
                className={`px-1.5 py-0.5 rounded border ${
                  hasFeaturePermission(rolePermissions, userRole, 'overrideClosedBatch')
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-500'
                }`}
              >
                Override
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setAdminInitialTab('roles');
                setShowAdminSettings(true);
              }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-medium text-teal-800 bg-white border border-teal-200 hover:bg-teal-50 rounded transition-colors"
            >
              Role Permissions (Tick Control) →
            </button>
          </div>

          <div className="mx-3 mt-3 space-y-1.5">
            <button
              type="button"
              onClick={() => setShowSensorSettings(true)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-md border border-slate-200 bg-white hover:border-teal-600 text-slate-700"
            >
              <span className="flex items-center gap-2">
                <Cpu className="w-3.5 h-3.5 text-teal-700" />
                <span>Sensor Adapter</span>
              </span>
              <span
                className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                  sensorConfig.masterEnabled
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {sensorConfig.masterEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAdminInitialTab('rest');
                setShowAdminSettings(true);
              }}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-md border border-slate-200 bg-white hover:border-teal-600 text-slate-700"
            >
              <span className="flex items-center gap-2">
                <Settings className="w-3.5 h-3.5 text-teal-700" />
                <span>Admin &amp; WMS</span>
              </span>
              <span
                className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                  wmsConfig.enabled
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {wmsConfig.enabled ? 'REST' : 'FILE'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setDesktopSqlTab('sql');
                setShowDesktopSqlModal(true);
              }}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-md border border-slate-200 bg-white hover:border-teal-600 text-slate-700"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Server className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                <span className="truncate">SQL IP &amp; Desktop</span>
              </span>
              <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-50 text-teal-800 shrink-0">
                PG
              </span>
            </button>
          </div>

          <div className="mx-3 mt-3">
            <PWAInstallButton />
          </div>
        </div>

        {/* User Footer */}
        <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900 truncate">
              {user.displayName || 'Plant Operator'}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {dbConfig?.host ? `${user.email} · ${dbConfig.host}` : user.email}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void logoutSqlSession()}
            title="Sign out"
            className="p-2 text-slate-400 hover:text-slate-800 rounded-md transition-colors shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      {/* Right Workspace Column */}
      <div
        data-print-hide={reportBatch ? 'true' : undefined}
        className="flex-1 min-w-0 flex flex-col"
      >
        {/* Top Bar Contract: Breadcrumb on Left, Last Saved Indicator on Right */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 sticky top-0 z-30">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
              Plant 01
            </span>
            <span className="text-slate-300 hidden sm:inline">/</span>
            <h1 className="font-display text-base font-semibold text-slate-900 truncate">
              {TAB_TITLES[activeTab]}
            </h1>
          </div>
          {lastSavedAt && (
            <div className="text-xs font-mono text-slate-500 whitespace-nowrap shrink-0 tabular-nums">
              Last saved: {lastSavedAt}
            </div>
          )}
        </header>

        {/* Mobile Navigation Bar */}
        <div className="lg:hidden bg-white border-b border-slate-200 px-4 py-2 flex items-center gap-1 overflow-x-auto">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-teal-50 text-teal-800'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Main Viewport */}
        <main className="flex-1 max-w-[1440px] w-full mx-auto p-6">
          {workspaceError && (
            <div className="mb-4 bg-white border border-amber-300 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs text-slate-800">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                <span>{workspaceError}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadWorkspace(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry Sync
              </button>
            </div>
          )}
          {loadingWorkspace ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="h-28 bg-white border border-slate-200 rounded-lg animate-pulse"
                  />
                ))}
              </div>
              <div className="h-72 bg-white border border-slate-200 rounded-lg animate-pulse" />
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <OverviewView
                  batches={batches}
                  rawMaterials={rawMaterials}
                  finishedGoods={finishedGoods}
                  sensors={liveSensors}
                  telemetryHistory={telemetryHistory}
                  isStreaming={isStreaming}
                  sensorMasterEnabled={sensorConfig.masterEnabled}
                  onToggleStreaming={() => setIsStreaming((v) => !v)}
                  onOpenSensorSettings={() => setShowSensorSettings(true)}
                  recommendations={recommendations}
                  onApplySensorOptimization={handleOptimizeSensorById}
                  onOpenBatch={handleOpenBatch}
                  onOpenBatchReport={setReportBatchId}
                  onNavigate={setActiveTab}
                />
              )}

              {activeTab === 'batches' && (
                <BatchesView
                  ownerId={user.uid}
                  operatorName={user.displayName || user.email || 'Operator'}
                  userRole={userRole}
                  rolePermissions={rolePermissions}
                  batches={batches}
                  formulas={formulas}
                  rawMaterials={rawMaterials}
                  finishedGoods={finishedGoods}
                  sensors={liveSensors}
                  productionLines={productionLines}
                  batchCheckSpecs={batchCheckSpecs}
                  categoryParameterPresets={categoryParameterPresets}
                  auditLogs={auditLogs}
                  sensorConfig={sensorConfig}
                  onOpenSensorSettings={() => setShowSensorSettings(true)}
                  selectedBatchId={selectedBatchId}
                  onSelectBatch={setSelectedBatchId}
                  onOpenBatchReport={setReportBatchId}
                  onNavigate={setActiveTab}
                  openCreateSignal={0}
                  onNotify={showToast}
                />
              )}

              {activeTab === 'inventory' && (
                <InventoryView
                  ownerId={user.uid}
                  rawMaterials={rawMaterials}
                  finishedGoods={finishedGoods}
                  wmsConfig={wmsConfig}
                  onOpenAdminSettings={() => {
                    setAdminInitialTab('rest');
                    setShowAdminSettings(true);
                  }}
                  onNotify={showToast}
                />
              )}

              {activeTab === 'batch-check' && (
                <BatchCheckView
                  specs={batchCheckSpecs}
                  records={batchCheckRecords}
                  batches={batches}
                  productCategories={productCategories}
                  categoryParameterPresets={categoryParameterPresets}
                  operatorName={user.displayName || user.email || 'Plant Operator'}
                  onNotify={showToast}
                />
              )}

              {activeTab === 'lines-machines' && (
                <LinesMachinesView
                  lines={productionLines}
                  sensors={liveSensors}
                  batches={batches}
                  productCategories={productCategories}
                  operationalStatuses={operationalStatuses}
                  sensorMasterEnabled={sensorConfig.masterEnabled}
                  onOpenSensorSettings={() => setShowSensorSettings(true)}
                  onOpenBatch={handleOpenBatch}
                  onNotify={showToast}
                />
              )}

              {activeTab === 'formulas' && (
                <FormulasView
                  ownerId={user.uid}
                  userRole={userRole}
                  rolePermissions={rolePermissions}
                  formulas={formulas}
                  productCategories={productCategories}
                  categoryParameterPresets={categoryParameterPresets}
                  onNotify={showToast}
                />
              )}

              {activeTab === 'traceability' && (
                <TraceabilityView
                  batches={batches}
                  rawMaterials={rawMaterials}
                  finishedGoods={finishedGoods}
                  onOpenBatch={handleOpenBatch}
                  onOpenBatchReport={setReportBatchId}
                />
              )}

              {activeTab === 'reports' && (
                <MonthlyProductionReport
                  batches={batches}
                  formulas={formulas}
                  productCategories={productCategories}
                  productionLines={productionLines}
                  batchCheckSpecs={batchCheckSpecs}
                  preparedBy={user.displayName || user.email || 'Plant Operations Manager'}
                  userRole={userRole}
                  onOpenBatch={handleOpenBatch}
                  onOpenBatchReport={setReportBatchId}
                  onNotify={showToast}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* Printable & Downloadable Batch Compliance PDF Modal */}
      {reportBatch && (
        <BatchReportModal
          batch={reportBatch}
          allBatches={batches}
          onSwitchBatch={setReportBatchId}
          formulas={formulas}
          rawMaterials={rawMaterials}
          finishedGoods={finishedGoods}
          sensors={liveSensors}
          batchCheckSpecs={batchCheckSpecs}
          auditLogs={auditLogs}
          telemetryHistory={telemetryHistory}
          preparedBy={user.displayName || user.email || 'Plant Operator'}
          userRole={userRole}
          rolePermissions={rolePermissions}
          onClose={() => setReportBatchId(null)}
          onDownloaded={(filename) => showToast(`Downloaded ${filename}`)}
        />
      )}

      {showSensorSettings && (
        <SensorSettingsModal
          config={sensorConfig}
          lines={productionLines}
          userRole={userRole}
          rolePermissions={rolePermissions}
          onClose={() => setShowSensorSettings(false)}
          onNotify={showToast}
        />
      )}

      {showAdminSettings && (
        <AdminSettingsModal
          userRole={userRole}
          rolePermissions={rolePermissions}
          initialTab={adminInitialTab}
          wmsConfig={wmsConfig}
          rawMaterials={rawMaterials}
          finishedGoods={finishedGoods}
          workspaceBackup={{
            schemaVersion: 'mayralab-mes-backup-v1',
            exportedAt: new Date().toISOString(),
            plantOwnerUid: user.uid,
            userRole,
            productCategories,
            operationalStatuses,
            rolePermissions,
            categoryParameterPresets,
            sensorConfig,
            wmsConfig,
            formulas,
            rawMaterials,
            batches,
            finishedGoods,
            batchCheckSpecs,
            batchCheckRecords,
            productionLines,
            sensors,
            auditLogs,
          }}
          onOpenSensorSettings={() => setShowSensorSettings(true)}
          onClose={() => setShowAdminSettings(false)}
          onNotify={showToast}
        />
      )}

      {showDesktopSqlModal && (
        <DesktopSqlModal
          currentUser={user}
          initialTab={desktopSqlTab}
          onClose={() => setShowDesktopSqlModal(false)}
          onDatabaseSwitched={(cfg) => {
            setDbConfig(cfg);
            void loadWorkspace(true);
          }}
          onNotify={showToast}
        />
      )}

      {/* Action Feedback Toast */}
      {toast && (
        <div
          data-print-hide="true"
          role="status"
          className="fixed bottom-5 right-5 z-50 max-w-md bg-slate-900 text-white text-xs font-medium px-4 py-3 rounded-md shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* Offline Status Banner */}
      <OfflineIndicator />
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<SqlAuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const unsub = subscribeSqlAuth((nextUser) => {
      setUser(nextUser);
    });
    void restoreSqlSession().finally(() => {
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center text-sm text-slate-500">
        Connecting to Manufacturing Execution System...
      </div>
    );
  }

  return (
    <ErrorBoundary>
      {user ? <MesWorkspace user={user} /> : <AuthGate />}
    </ErrorBoundary>
  );
}
