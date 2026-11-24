import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Pause,
  Play,
  Sliders,
} from 'lucide-react';
import type {
  ActiveTab,
  FinishedGoodLot,
  ProductionBatch,
  RawMaterialLot,
  TelemetryHistoryPoint,
  ThermalSensor,
  YieldOptimizationRecommendation,
} from '../types';
import { formatCurrency } from '../utils/units';
import { BatchYieldTrendChart } from './BatchYieldTrendChart';
import { BatchCategoryCompletionChart } from './BatchCategoryCompletionChart';

interface OverviewViewProps {
  batches: ProductionBatch[];
  rawMaterials: RawMaterialLot[];
  finishedGoods: FinishedGoodLot[];
  sensors: ThermalSensor[];
  telemetryHistory: TelemetryHistoryPoint[];
  isStreaming: boolean;
  sensorMasterEnabled?: boolean;
  onToggleStreaming: () => void;
  onOpenSensorSettings?: () => void;
  recommendations: YieldOptimizationRecommendation[];
  onApplySensorOptimization: (sensorId: string, targetTempC: number) => Promise<void>;
  onOpenBatch: (batchId: string) => void;
  onOpenBatchReport: (batchId: string) => void;
  onNavigate: (tab: ActiveTab) => void;
}

const LINE_COLORS = ['#0F766E', '#2563EB', '#D97706', '#DC2626'];

export function OverviewView({
  batches,
  rawMaterials,
  finishedGoods,
  sensors,
  telemetryHistory,
  isStreaming,
  sensorMasterEnabled = false,
  onToggleStreaming,
  onOpenSensorSettings,
  recommendations,
  onApplySensorOptimization,
  onOpenBatch,
  onOpenBatchReport,
  onNavigate,
}: OverviewViewProps) {
  const activeBatches = useMemo(
    () => batches.filter((b) => b.status !== 'Closed'),
    [batches]
  );

  const qcHoldCount = useMemo(
    () => batches.filter((b) => b.status === 'QC Hold').length,
    [batches]
  );

  const avgYield = useMemo(() => {
    const scored = batches.filter((b) => b.yieldPct > 0);
    if (scored.length === 0) return 0;
    return Number(
      (scored.reduce((acc, b) => acc + b.yieldPct, 0) / scored.length).toFixed(1)
    );
  }, [batches]);

  const excursionSensors = useMemo(
    () => sensors.filter((s) => s.status !== 'Nominal'),
    [sensors]
  );

  const lowStockLots = useMemo(
    () => rawMaterials.filter((m) => m.status === 'Low' || m.status === 'Depleted'),
    [rawMaterials]
  );

  const totalFgUnits = useMemo(
    () => finishedGoods.reduce((acc, fg) => acc + fg.quantityAvailable, 0),
    [finishedGoods]
  );

  const hotSensors = useMemo(
    () => sensors.filter((s) => s.targetTempC >= 50).slice(0, 4),
    [sensors]
  );

  const coldSensors = useMemo(
    () => sensors.filter((s) => s.targetTempC < 50),
    [sensors]
  );

  return (
    <div className="space-y-6">
      {/* 4-Column High-Density KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">Active Job Orders</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {activeBatches.length}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {qcHoldCount} in QC Hold
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>{batches.length} total plant batches</span>
            <button
              type="button"
              onClick={() => onNavigate('batches')}
              className="font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
            >
              Open queue
            </button>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">Real-Time Avg Yield</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {avgYield > 0 ? `${avgYield.toFixed(1)}%` : '—'}
            </span>
            <span
              className={`text-xs font-medium tabular-nums ${
                avgYield >= 95 ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              Target 96.5%
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>{recommendations.length} live optimization levers</span>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
            >
              Monthly report
            </button>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">HACCP Thermal Sensors</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {sensors.length - excursionSensors.length}/{sensors.length}
            </span>
            <span
              className={`text-xs font-medium ${
                excursionSensors.length === 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {excursionSensors.length === 0
                ? 'All in spec'
                : `${excursionSensors.length} drift alert`}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>Continuous probe polling</span>
            <button
              type="button"
              onClick={() => onNavigate('batch-check')}
              className="font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
            >
              Batch check
            </button>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">Inventory &amp; FG Stock</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {totalFgUnits.toLocaleString()}
            </span>
            <span
              className={`text-xs font-medium ${
                lowStockLots.length === 0 ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {lowStockLots.length} low RM lot{lowStockLots.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>{rawMaterials.length} raw lots · {finishedGoods.length} FG lots</span>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
            >
              View stock
            </button>
          </div>
        </div>
      </section>

      {/* Main Split: Live Thermal Telemetry + Real-Time Yield Optimization Feed */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Hot-Line Thermal Telemetry (°C)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Live probe feed for kettles, pasteurizers, and retort vessels
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onOpenSensorSettings && (
                <button
                  type="button"
                  onClick={onOpenSensorSettings}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md text-slate-700 hover:border-teal-600 whitespace-nowrap"
                >
                  <Cpu className="w-3.5 h-3.5 text-teal-700" />
                  <span>Master: {sensorMasterEnabled ? 'ON' : 'OFF'}</span>
                </button>
              )}
              <button
                type="button"
                disabled={!sensorMasterEnabled}
                onClick={onToggleStreaming}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-md text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {isStreaming && sensorMasterEnabled ? (
                  <Pause className="w-3.5 h-3.5" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                <span>
                  {!sensorMasterEnabled
                    ? 'Manual Mode (Sensors OFF)'
                    : isStreaming
                      ? 'Pause Live Feed'
                      : 'Resume Live Feed'}
                </span>
              </button>
            </div>
          </div>

          <div className="h-64 mt-4 w-full">
            {telemetryHistory.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-md">
                No thermal telemetry points recorded in PostgreSQL yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={telemetryHistory}
                  margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 11, fill: '#64748B' }}
                    axisLine={{ stroke: '#CBD5E1' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#64748B' }}
                    axisLine={false}
                    tickLine={false}
                    domain={['auto', 'auto']}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderColor: '#CBD5E1',
                      borderRadius: '6px',
                      fontSize: '12px',
                    }}
                  />
                  {hotSensors.map((sensor, idx) => (
                    <Line
                      key={sensor.sensorCode}
                      type="monotone"
                      dataKey={sensor.sensorCode}
                      name={`${sensor.sensorCode} (${sensor.name})`}
                      stroke={LINE_COLORS[idx % LINE_COLORS.length]}
                      strokeWidth={2}
                      dot={telemetryHistory.length <= 3 ? { r: 3 } : false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Cold Chain Summary Strip */}
          <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {coldSensors.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between py-2 px-3 bg-[#F7F8FA] rounded-md"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-900 truncate">{s.name}</div>
                  <div className="text-[11px] font-mono text-slate-500">
                    Safe {s.minSafeTempC}–{s.maxSafeTempC}°C
                  </div>
                </div>
                <div className="text-right shrink-0 ml-2">
                  <div
                    className={`font-mono text-sm font-semibold tabular-nums ${
                      s.status === 'Excursion'
                        ? 'text-red-700'
                        : s.status === 'Warning'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                    }`}
                  >
                    {s.currentTempC.toFixed(1)}°C
                  </div>
                  <div className="text-[11px] text-slate-500">{s.status}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Real-Time Yield Optimizer
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Live thermal drift, weigh variance, and reject-loss interventions
              </p>
            </div>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {recommendations.length} active
            </span>
          </div>

          <div className="divide-y divide-slate-100 flex-1 mt-1">
            {recommendations.length === 0 ? (
              <div className="py-12 text-center">
                <CheckCircle2 className="w-6 h-6 text-emerald-700 mx-auto" />
                <p className="mt-2 text-sm font-medium text-slate-900">
                  All lines operating inside optimal yield tolerances
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  No thermal excursions, weigh deviations, or low-stock risks detected.
                </p>
              </div>
            ) : (
              recommendations.slice(0, 4).map((rec) => (
                <div key={rec.id} className="py-3.5 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span
                          className={`font-semibold ${
                            rec.severity === 'High'
                              ? 'text-red-700'
                              : rec.severity === 'Medium'
                                ? 'text-amber-700'
                                : 'text-slate-600'
                          }`}
                        >
                          {rec.severity} priority
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{rec.category}</span>
                      </div>
                      <h3 className="mt-0.5 text-sm font-semibold text-slate-900">
                        {rec.title}
                      </h3>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-xs font-semibold text-emerald-700 tabular-nums">
                        +{rec.estimatedYieldGainPct.toFixed(1)}% yield
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {formatCurrency(rec.estimatedSavingsPerBatch)}/batch
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">{rec.detail}</p>
                  <div className="flex items-center gap-3 pt-0.5">
                    {rec.sensorId && rec.recommendedTargetTempC !== undefined && (
                      <button
                        type="button"
                        onClick={() =>
                          void onApplySensorOptimization(
                            rec.sensorId!,
                            rec.recommendedTargetTempC!
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded transition-colors whitespace-nowrap"
                      >
                        <Sliders className="w-3.5 h-3.5" />
                        Re-center PID to {rec.recommendedTargetTempC.toFixed(1)}°C
                      </button>
                    )}
                    {rec.batchId && (
                      <button
                        type="button"
                        onClick={() => onOpenBatch(rec.batchId!)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                      >
                        Inspect batch
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Historical Batch Yield Trends + Category Completion Breakdown (D3.js + PostgreSQL) */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-7">
          <BatchYieldTrendChart onOpenBatch={onOpenBatch} />
        </div>
        <div className="xl:col-span-5">
          <BatchCategoryCompletionChart
            onOpenBatch={onOpenBatch}
            onNavigate={onNavigate}
          />
        </div>
      </section>

      {/* Active Batch Execution Table */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Floor Production Queue
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Select any job order to execute BOM checks, lot issue, thermal logging, or QC release
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('batches')}
            className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
          >
            View all batches
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                <th className="py-2.5 px-5">Batch / Lot</th>
                <th className="py-2.5 px-4">Product &amp; Formula</th>
                <th className="py-2.5 px-4">Line &amp; Trigger</th>
                <th className="py-2.5 px-4 text-right">Planned</th>
                <th className="py-2.5 px-4 text-right">Yield %</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {batches.slice(0, 6).map((batch) => (
                <tr key={batch.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-3 px-5">
                    <div className="font-mono text-xs font-semibold text-slate-900">
                      {batch.batchNumber}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {batch.lotNumber || 'Lot pending release'}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">{batch.productName}</div>
                    <div className="text-xs text-slate-500">
                      {batch.sku} · {batch.formulaVersion}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-slate-800">{batch.lineName}</div>
                    <div className="text-xs text-slate-500">
                      {batch.sourceType}
                      {batch.sourceRef ? ` · ${batch.sourceRef}` : ''}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                    {batch.plannedQty.toLocaleString()} {batch.outputUnit}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums">
                    {batch.yieldPct > 0 ? (
                      <span
                        className={
                          batch.yieldPct >= 95
                            ? 'text-emerald-700 font-medium'
                            : 'text-amber-700 font-medium'
                        }
                      >
                        {batch.yieldPct.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                        batch.status === 'Closed' || batch.status === 'Completed'
                          ? 'text-emerald-700'
                          : batch.status === 'QC Hold'
                            ? 'text-amber-700'
                            : batch.status === 'In Progress'
                              ? 'text-teal-700'
                              : 'text-slate-600'
                      }`}
                    >
                      {batch.status === 'QC Hold' && <AlertTriangle className="w-3.5 h-3.5" />}
                      {batch.status}
                    </span>
                  </td>
                  <td className="py-3 px-5 text-right">
                    <div className="inline-flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => onOpenBatchReport(batch.id)}
                        className="text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                      >
                        PDF Report
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenBatch(batch.id)}
                        className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                      >
                        {batch.status === 'Closed' ? 'View record' : 'Execute step'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
