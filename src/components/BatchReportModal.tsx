import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Lock,
  Printer,
  X,
} from 'lucide-react';
import type {
  AuditLogEntry,
  BatchCheckSpec,
  FinishedGoodLot,
  FormulaBOM,
  ProductionBatch,
  RawMaterialLot,
  RolePermissionMatrix,
  TelemetryHistoryPoint,
  ThermalSensor,
  UserRole,
} from '../types';
import { formatCurrency } from '../utils/units';
import { hasFeaturePermission } from '../services/permissions';
import {
  evaluateBatchHaccpCompliance,
  generateBatchCompliancePdf,
  type BatchReportOptions,
} from '../utils/batchReportPdf';
import { extractAuditFieldChanges, formatAuditValue } from '../utils/auditDiff';

interface BatchReportModalProps {
  batch: ProductionBatch;
  allBatches: ProductionBatch[];
  onSwitchBatch: (batchId: string) => void;
  formulas: FormulaBOM[];
  rawMaterials: RawMaterialLot[];
  finishedGoods: FinishedGoodLot[];
  sensors: ThermalSensor[];
  batchCheckSpecs?: BatchCheckSpec[];
  auditLogs?: AuditLogEntry[];
  telemetryHistory: TelemetryHistoryPoint[];
  preparedBy: string;
  userRole: UserRole;
  rolePermissions?: RolePermissionMatrix;
  onClose: () => void;
  onDownloaded: (filename: string) => void;
}

export function BatchReportModal({
  batch,
  allBatches,
  onSwitchBatch,
  formulas,
  rawMaterials,
  finishedGoods,
  sensors,
  batchCheckSpecs = [],
  auditLogs = [],
  telemetryHistory,
  preparedBy,
  userRole,
  rolePermissions,
  onClose,
  onDownloaded,
}: BatchReportModalProps) {
  const [options, setOptions] = useState<BatchReportOptions>({
    includeColdChainSensors: true,
    includeTelemetryLog: true,
    includeCostingLedger: true,
  });
  const [generating, setGenerating] = useState(false);

  const formula = useMemo(
    () => formulas.find((f) => f.id === batch.formulaId),
    [formulas, batch.formulaId]
  );

  const finishedGood = useMemo(
    () =>
      finishedGoods.find(
        (fg) => fg.id === batch.finishedGoodId || fg.batchId === batch.id
      ),
    [finishedGoods, batch.finishedGoodId, batch.id]
  );

  const isOemMasked = Boolean(
    !hasFeaturePermission(rolePermissions, userRole, 'viewConfidentialOem') &&
      formula?.isConfidentialOem
  );

  const compliance = useMemo(
    () =>
      evaluateBatchHaccpCompliance(batch, sensors, options.includeColdChainSensors),
    [batch, sensors, options.includeColdChainSensors]
  );

  const primarySensor = compliance.linkedSensors[0] || sensors[0];
  const totalCost = batch.materialCost + batch.laborCost + batch.overheadCost;
  const generatedStamp = useMemo(
    () => new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    []
  );

  function handleDownloadPdf() {
    setGenerating(true);
    try {
      const filename = generateBatchCompliancePdf({
        batch,
        formula,
        finishedGood,
        rawMaterials,
        sensors,
        telemetryHistory,
        auditLogs,
        preparedBy,
        userRole,
        rolePermissions,
        options,
      });
      onDownloaded(filename);
    } finally {
      setGenerating(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 print:static print:inset-auto print:bg-white print:p-0 print:block"
      role="dialog"
      aria-modal="true"
      aria-label="Batch Production & HACCP Compliance Report"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-5xl w-full max-h-[92vh] flex flex-col overflow-hidden print:max-w-none print:max-h-none print:border-0 print:rounded-none print:overflow-visible">
        {/* Interactive Modal Toolbar (hidden during print) */}
        <div
          data-print-hide="true"
          className="px-5 py-3.5 border-b border-slate-200 bg-[#F7F8FA] flex flex-wrap items-center justify-between gap-4 shrink-0"
        >
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 text-slate-900">
              <FileText className="w-4 h-4 text-teal-700 shrink-0" />
              <span className="text-sm font-semibold whitespace-nowrap">
                Batch Compliance Report
              </span>
            </div>
            <select
              value={batch.id}
              onChange={(e) => onSwitchBatch(e.target.value)}
              className="border border-slate-200 bg-white rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-800 max-w-[260px]"
            >
              {allBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batchNumber} · {b.sku} ({b.status})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Report
            </button>
            <button
              type="button"
              disabled={generating}
              onClick={handleDownloadPdf}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {generating ? 'Generating PDF...' : 'Download PDF'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close report preview"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Report Section Options Bar (hidden during print) */}
        <div
          data-print-hide="true"
          className="px-5 py-2.5 border-b border-slate-200 bg-white flex flex-wrap items-center gap-5 text-xs text-slate-700 shrink-0"
        >
          <span className="font-medium text-slate-500">Included sections:</span>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={options.includeColdChainSensors}
              onChange={(e) =>
                setOptions((o) => ({ ...o, includeColdChainSensors: e.target.checked }))
              }
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            Cold-chain storage probes
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={options.includeTelemetryLog}
              onChange={(e) =>
                setOptions((o) => ({ ...o, includeTelemetryLog: e.target.checked }))
              }
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            Timestamped telemetry trend &amp; log
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={options.includeCostingLedger}
              onChange={(e) =>
                setOptions((o) => ({ ...o, includeCostingLedger: e.target.checked }))
              }
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            Batch unit costing ledger
          </label>
        </div>

        {/* Printable Document Canvas */}
        <div
          id="printable-batch-report"
          className="flex-1 overflow-y-auto bg-[#F1F3F6] p-6 print:bg-white print:p-0 print:overflow-visible"
        >
          <article className="bg-white border border-slate-200 rounded-md max-w-[820px] mx-auto p-8 space-y-7 print:border-0 print:max-w-none print:p-0">
            {/* Document Header */}
            <header className="pb-5 border-b-2 border-slate-900 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs font-mono text-slate-500">
                  KETTLER PROCESSING FACILITY · PLANT 01 · CONTROLLED BATCH RECORD
                </div>
                <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-900">
                  Batch Manufacturing, Telemetry &amp; HACCP Compliance Report
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className="font-mono font-semibold text-slate-900">
                    Doc ID: BMR-{batch.batchNumber}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{generatedStamp}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Prepared by {preparedBy} ({userRole})
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="text-[11px] font-medium text-slate-500">
                  HACCP Compliance Status
                </div>
                <div
                  className={`mt-1 inline-flex items-center gap-1.5 text-sm font-bold ${
                    compliance.verdict === 'COMPLIANT'
                      ? 'text-emerald-700'
                      : compliance.verdict === 'PENDING QC'
                        ? 'text-amber-700'
                        : 'text-red-700'
                  }`}
                >
                  {compliance.verdict === 'COMPLIANT' && <CheckCircle2 className="w-4 h-4" />}
                  {compliance.verdict === 'PENDING QC' && <Clock className="w-4 h-4" />}
                  {compliance.verdict === 'ACTION REQUIRED' && (
                    <AlertTriangle className="w-4 h-4" />
                  )}
                  <span>{compliance.verdict}</span>
                </div>
                <div className="mt-0.5 text-[11px] font-mono text-slate-500 tabular-nums">
                  {compliance.passedProcessChecks}/{compliance.totalProcessChecks} CCP checks ·{' '}
                  {compliance.excursionSensors} excursions
                </div>
              </div>
            </header>

            {isOemMasked && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                <span>
                  OEM Confidentiality Active ({formula?.oemCustomer}): Proprietary ingredient
                  descriptions are redacted in this operator copy.
                </span>
              </div>
            )}

            {/* 1. Batch Identification Grid */}
            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold text-slate-900">
                01. Batch Identification &amp; Manufacturing Metadata
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 border-y border-slate-200 py-3.5 text-xs">
                <div>
                  <div className="text-slate-500">Batch Number</div>
                  <div className="mt-0.5 font-mono font-semibold text-slate-900">
                    {batch.batchNumber}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Traceable Lot #</div>
                  <div className="mt-0.5 font-mono font-semibold text-slate-900">
                    {batch.lotNumber || 'Pending Release'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Product &amp; SKU</div>
                  <div className="mt-0.5 font-medium text-slate-900">{batch.productName}</div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {batch.sku} · {batch.formulaVersion}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Lifecycle Status</div>
                  <div className="mt-0.5 font-semibold text-slate-900">{batch.status}</div>
                  <div className="text-[11px] text-slate-500">
                    {batch.plannedDate} · {batch.sourceType}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Line / Equipment</div>
                  <div className="mt-0.5 font-medium text-slate-900">
                    {batch.equipmentName || batch.lineName}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Shift &amp; Crew</div>
                  <div className="mt-0.5 font-medium text-slate-900">
                    {batch.shift || 'Shift A'} · {batch.assignedTeam}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Planned Start → End</div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-900">
                    {batch.plannedStartAt || batch.plannedDate} → {batch.plannedEndAt || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Actual Start → End</div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-900">
                    {batch.actualStartAt || 'Not started'} → {batch.actualEndAt || 'Pending'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Operators</div>
                  <div className="mt-0.5 text-slate-900">
                    {batch.operators && batch.operators.length > 0
                      ? batch.operators.join(', ')
                      : batch.assignedTeam}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Pack Size / Shelf Life</div>
                  <div className="mt-0.5 font-mono text-slate-900 tabular-nums">
                    {batch.packSize || formula?.packSize || batch.outputUnit} ·{' '}
                    {formula ? `${formula.shelfLifeDays} days` : '—'}
                  </div>
                </div>
              </div>
            </section>

            {/* 2. Output, Yield & Costing */}
            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold text-slate-900">
                02. Production Output, Mass, Losses &amp; Costing
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 bg-[#F7F8FA] border border-slate-200 rounded p-3.5 text-xs">
                <div>
                  <div className="text-slate-500">Planned Qty</div>
                  <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                    {batch.plannedQty.toLocaleString()} {batch.outputUnit}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Good Output &amp; Mass</div>
                  <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                    {batch.goodQty > 0
                      ? `${batch.goodQty.toLocaleString()} ${batch.outputUnit}${batch.outputMassQty ? ` (${batch.outputMassQty} ${batch.outputMassUnit || 'kg'})` : ''}`
                      : 'Pending'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Reject / Rework / By-Prod / Waste</div>
                  <div className="mt-0.5 font-mono text-slate-900 tabular-nums">
                    {batch.rejectedQty} / {batch.reworkQty} / {batch.byProductQty || 0} /{' '}
                    {batch.wasteKg}kg
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Yield % (Target 96.5%)</div>
                  <div
                    className={`mt-0.5 font-mono font-semibold tabular-nums ${
                      batch.yieldPct >= 95
                        ? 'text-emerald-700'
                        : batch.yieldPct > 0
                          ? 'text-amber-700'
                          : 'text-slate-400'
                    }`}
                  >
                    {batch.yieldPct > 0 ? `${batch.yieldPct.toFixed(1)}%` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Variance</div>
                  <div className="mt-0.5 font-mono text-slate-900 tabular-nums">
                    {batch.yieldPct > 0
                      ? `${batch.variancePct >= 0 ? '+' : ''}${batch.variancePct.toFixed(1)}%`
                      : '—'}
                  </div>
                </div>
              </div>
              {batch.lossReasonCodes && batch.lossReasonCodes.length > 0 && (
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {batch.lossReasonCodes.map((lr, idx) => (
                    <span
                      key={`${lr.lossType}-${idx}`}
                      className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-slate-800"
                    >
                      {lr.lossType}: {lr.quantity} {lr.unit} [{lr.reasonCode}]
                    </span>
                  ))}
                </div>
              )}

              {options.includeCostingLedger && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 border border-slate-200 rounded p-3 text-xs">
                  <div>
                    <div className="text-slate-500">Materials</div>
                    <div className="mt-0.5 font-mono text-slate-900 tabular-nums">
                      {formatCurrency(batch.materialCost)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Direct Labor</div>
                    <div className="mt-0.5 font-mono text-slate-900 tabular-nums">
                      {formatCurrency(batch.laborCost)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Plant Overhead</div>
                    <div className="mt-0.5 font-mono text-slate-900 tabular-nums">
                      {formatCurrency(batch.overheadCost)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Total Batch Cost</div>
                    <div className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                      {formatCurrency(totalCost)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Cost / Good Unit</div>
                    <div className="mt-0.5 font-mono font-semibold text-teal-800 tabular-nums">
                      {batch.unitCost > 0 ? formatCurrency(batch.unitCost) : '—'}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* 3. Issued Raw Material Lots */}
            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold text-slate-900">
                03. Issued Material Lots &amp; Weigh Tolerance Ledger
              </h2>
              {batch.issuedMaterials.length === 0 ? (
                <p className="text-xs text-slate-500 italic">
                  No raw materials have been issued to this batch yet.
                </p>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2 px-3">Material</th>
                        <th className="py-2 px-3">Supplier Lot</th>
                        <th className="py-2 px-3 text-right">Required</th>
                        <th className="py-2 px-3 text-right">Weighed</th>
                        <th className="py-2 px-3 text-right">Variance</th>
                        <th className="py-2 px-3">Tolerance</th>
                        <th className="py-2 px-3">Operator</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {batch.issuedMaterials.map((m, idx) => {
                        const bomLine = formula?.ingredients.find(
                          (i) => i.materialCode === m.materialCode
                        );
                        const displayCode = isOemMasked
                          ? bomLine?.anonymizedCode || 'OEM-SPEC'
                          : m.materialCode;
                        return (
                          <tr key={`${m.lotNumber}-${idx}`}>
                            <td className="py-2 px-3">
                              <div className="font-medium text-slate-900">
                                {isOemMasked
                                  ? `Confidential Component (${displayCode})`
                                  : m.materialName}
                              </div>
                              <div className="font-mono text-[11px] text-slate-500">
                                {displayCode}
                              </div>
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-800">{m.lotNumber}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">
                              {m.requiredQty} {m.unit}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums font-medium">
                              {m.actualQty} {m.unit}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums">
                              {m.variancePct >= 0 ? '+' : ''}
                              {m.variancePct.toFixed(2)}%
                            </td>
                            <td className="py-2 px-3 font-semibold">
                              <span
                                className={
                                  m.withinTolerance ? 'text-emerald-700' : 'text-red-700'
                                }
                              >
                                {m.withinTolerance ? 'PASS' : 'OUT OF TOL'}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-slate-600">
                              <div>{m.operator}</div>
                              <div className="font-mono text-[10px] text-slate-400">
                                {m.issuedAt}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 4. In-Process Quality & CCP Checks */}
            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold text-slate-900">
                04. In-Process Quality &amp; CCP Verification Log
              </h2>
              {(() => {
                const linkedSpec =
                  batchCheckSpecs.find((s) => s.batchId === batch.id) ||
                  batchCheckSpecs.find((s) => s.batchNumber === batch.batchNumber) ||
                  null;
                if (!linkedSpec) return null;
                return (
                  <div className="text-[11px] bg-teal-50/40 border border-teal-200 rounded px-3 py-2 text-slate-700 flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="font-semibold text-teal-900">
                      Linked Batch Check Spec ({linkedSpec.productCategory}):
                    </span>
                    {linkedSpec.phMin !== null || linkedSpec.phMax !== null ? (
                      <span className="font-mono">
                        pH {linkedSpec.phMin ?? '—'}–{linkedSpec.phMax ?? '—'}
                      </span>
                    ) : null}
                    {linkedSpec.awMin !== null || linkedSpec.awMax !== null ? (
                      <span className="font-mono">
                        Aw {linkedSpec.awMin ?? '—'}–{linkedSpec.awMax ?? '—'}
                      </span>
                    ) : null}
                    {linkedSpec.brixMin !== null || linkedSpec.brixMax !== null ? (
                      <span className="font-mono">
                        Brix {linkedSpec.brixMin ?? '—'}–{linkedSpec.brixMax ?? '—'}%
                      </span>
                    ) : null}
                    {(linkedSpec.additionalParams || []).map((p) => (
                      <span key={p.id} className="font-mono">
                        {p.name}: {p.minTarget ?? '—'}–{p.maxTarget ?? '—'}
                        {p.unit ? ` ${p.unit}` : ''}
                      </span>
                    ))}
                  </div>
                );
              })()}
              {batch.processChecks.length === 0 ? (
                <p className="text-xs text-slate-500 italic">
                  No in-process quality or thermal checks recorded yet.
                </p>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2 px-3">Time Reading</th>
                        <th className="py-2 px-3 text-right">Temp °C</th>
                        <th className="py-2 px-3 text-right">Brix (%) / pH / Aw</th>
                        <th className="py-2 px-3 text-right">Wt / Visc / RPM / Bar</th>
                        <th className="py-2 px-3">Source</th>
                        <th className="py-2 px-3">CCP Spec</th>
                        <th className="py-2 px-3">Logged By &amp; Deviations</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {batch.processChecks.map((chk, idx) => {
                        const weightKg =
                          chk.recordedWeightKg ??
                          (chk.recordedWeightG !== null && chk.recordedWeightG !== undefined
                            ? Number((chk.recordedWeightG / 1000).toFixed(3))
                            : null);
                        return (
                        <tr key={chk.id || `${chk.stepNumber}-${chk.recordedAt}-${idx}`}>
                          <td className="py-2 px-3 font-medium text-slate-900 whitespace-nowrap">
                            <div className="font-mono">
                              T{idx + 1} · {chk.readingTime || chk.recordedAt.slice(11, 16) || chk.recordedAt}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {chk.recordedTempC !== null ? `${chk.recordedTempC.toFixed(1)}°C` : '—'}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">
                            {chk.recordedBrix !== null ? `${chk.recordedBrix}%` : '—'} /{' '}
                            {chk.recordedPh !== null ? chk.recordedPh : '—'}
                            {chk.recordedAw !== null && chk.recordedAw !== undefined
                              ? ` / ${chk.recordedAw.toFixed(3)}`
                              : ''}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-[11px]">
                            <div>{weightKg !== null ? `${weightKg}kg` : '—'}</div>
                            <div className="text-slate-500">
                              {chk.recordedViscosityCp ?? '—'}cP · {chk.recordedSpeedRpm ?? '—'}rpm ·{' '}
                              {chk.recordedPressureBar ?? '—'}bar
                            </div>
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-700 text-[11px]">
                            <div>{chk.source || 'Manual'}</div>
                            <div className="text-slate-400">{chk.sensorCode}</div>
                          </td>
                          <td className="py-2 px-3 font-semibold">
                            <span
                              className={chk.withinSpec ? 'text-emerald-700' : 'text-red-700'}
                            >
                              {chk.withinSpec ? 'IN SPEC' : 'DEVIATION'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-slate-600">
                            <div>
                              {chk.operator} ·{' '}
                              <span className="font-mono text-[11px]">{chk.recordedAt}</span>
                            </div>
                            {chk.batchCheckReadings && chk.batchCheckReadings.length > 0 && (
                              <div className="font-mono text-[11px] text-slate-700 mt-0.5">
                                {chk.batchCheckReadings
                                  .map(
                                    (r) =>
                                      `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ''}`
                                  )
                                  .join(' · ')}
                              </div>
                            )}
                            {chk.deviationRecord && (
                              <div className="text-[11px] font-semibold text-red-700">
                                Deviation: {chk.deviationRecord}
                              </div>
                            )}
                            <div className="text-[11px] text-slate-500">{chk.notes}</div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 5. HACCP Sensor Telemetry & Critical Limit Log */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-slate-900">
                05. HACCP Temperature Telemetry &amp; Critical Limit Compliance
              </h2>
              <div className="overflow-x-auto border border-slate-200 rounded">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                      <th className="py-2 px-3">Probe</th>
                      <th className="py-2 px-3">Equipment / Zone</th>
                      <th className="py-2 px-3 text-right">Safe Band</th>
                      <th className="py-2 px-3 text-right">Current</th>
                      <th className="py-2 px-3 text-right">RH %</th>
                      <th className="py-2 px-3">HACCP Status</th>
                      <th className="py-2 px-3">Assessment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {compliance.linkedSensors.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                          {s.sensorCode}
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-medium text-slate-900">{s.name}</div>
                          <div className="text-[11px] text-slate-500">{s.zone}</div>
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                          {s.minSafeTempC}–{s.maxSafeTempC}°C
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                          {s.currentTempC.toFixed(1)}°C
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                          {s.humidityPct}%
                        </td>
                        <td className="py-2 px-3 font-semibold">
                          <span
                            className={
                              s.status === 'Nominal'
                                ? 'text-emerald-700'
                                : s.status === 'Warning'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                            }
                          >
                            {s.status}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-[11px] text-slate-600 max-w-[200px]">
                          {s.yieldImpactNote}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {options.includeTelemetryLog && primarySensor && telemetryHistory.length > 0 && (
                <div className="space-y-3 pt-1">
                  <div className="border border-slate-200 rounded p-3.5">
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="font-semibold text-slate-800">
                        Primary Probe Telemetry Trend — {primarySensor.sensorCode} (
                        {primarySensor.name})
                      </span>
                      <span className="font-mono text-slate-500">
                        HACCP Limits: {primarySensor.minSafeTempC}°C – {primarySensor.maxSafeTempC}
                        °C
                      </span>
                    </div>
                    <div className="h-44 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={telemetryHistory.slice(-12)}
                          margin={{ top: 6, right: 14, left: -12, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                          <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#64748B' }} />
                          <YAxis
                            tick={{ fontSize: 10, fill: '#64748B' }}
                            domain={[
                              Math.floor(primarySensor.minSafeTempC - 2),
                              Math.ceil(primarySensor.maxSafeTempC + 2),
                            ]}
                          />
                          <Tooltip />
                          <ReferenceLine
                            y={primarySensor.maxSafeTempC}
                            stroke="#DC2626"
                            strokeDasharray="3 3"
                          />
                          <ReferenceLine
                            y={primarySensor.minSafeTempC}
                            stroke="#2563EB"
                            strokeDasharray="3 3"
                          />
                          <Line
                            type="monotone"
                            dataKey={primarySensor.sensorCode}
                            stroke="#0F766E"
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Timestamped Telemetry Table */}
                  <div className="overflow-x-auto border border-slate-200 rounded">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                          <th className="py-1.5 px-3">Timestamp</th>
                          {compliance.linkedSensors.slice(0, 4).map((s) => (
                            <th key={s.id} className="py-1.5 px-3 text-right font-mono">
                              {s.sensorCode}
                            </th>
                          ))}
                          <th className="py-1.5 px-3 text-right">Interval Check</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                        {telemetryHistory.slice(-8).map((pt, idx) => {
                          const subset = compliance.linkedSensors.slice(0, 4);
                          const allSafe = subset.every((s) => {
                            const val = Number(pt[s.sensorCode]);
                            return (
                              !Number.isFinite(val) ||
                              (val >= s.minSafeTempC && val <= s.maxSafeTempC)
                            );
                          });
                          return (
                            <tr key={`${pt.time}-${idx}`}>
                              <td className="py-1.5 px-3 text-slate-600">{pt.time}</td>
                              {subset.map((s) => {
                                const val = Number(pt[s.sensorCode]);
                                const out =
                                  Number.isFinite(val) &&
                                  (val < s.minSafeTempC || val > s.maxSafeTempC);
                                return (
                                  <td
                                    key={s.id}
                                    className={`py-1.5 px-3 text-right ${
                                      out ? 'text-red-700 font-semibold' : 'text-slate-800'
                                    }`}
                                  >
                                    {Number.isFinite(val) ? `${val.toFixed(1)}°C` : '—'}
                                  </td>
                                );
                              })}
                              <td
                                className={`py-1.5 px-3 text-right font-sans font-semibold ${
                                  allSafe ? 'text-emerald-700' : 'text-red-700'
                                }`}
                              >
                                {allSafe ? 'PASS' : 'EXCURSION'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* 6. QC Disposition, Finished Goods & Formal Sign-Off */}
            <section className="space-y-3 pt-2 border-t border-slate-200">
              <h2 className="text-sm font-semibold text-slate-900">
                06. QC Disposition, Finished Goods Posting &amp; QA Sign-Off
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs bg-[#F7F8FA] border border-slate-200 rounded p-3.5">
                <div>
                  <div className="text-slate-500">QC Status &amp; Inspector</div>
                  <div className="mt-0.5 font-semibold text-slate-900">
                    {batch.qcStatus} · {batch.qcInspector || 'Pending Sign-Off'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Finished Goods Posting</div>
                  <div className="mt-0.5 font-mono text-slate-900">
                    {finishedGood
                      ? `${finishedGood.lotNumber} (Exp ${finishedGood.expiryDate})`
                      : 'Not posted yet'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Warehouse &amp; Dispatch</div>
                  <div className="mt-0.5 text-slate-900">
                    {finishedGood
                      ? `${finishedGood.warehouseZone} · ${finishedGood.shipments.length} shipment(s)`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">In-Process QC</div>
                  <div className="mt-0.5 text-slate-900">
                    {batch.qcInProcessSummary || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Final QC Results</div>
                  <div className="mt-0.5 text-slate-900">
                    {batch.qcFinalResults || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">Retained Sample</div>
                  <div className="mt-0.5 font-mono text-slate-900">
                    {batch.retainedSampleQty || 0} units · {batch.retainedSampleCode || '—'}
                    {batch.retainedSampleLocation ? ` (${batch.retainedSampleLocation})` : ''}
                  </div>
                </div>
                <div className="sm:col-span-3 pt-2 border-t border-slate-200">
                  <span className="text-slate-500">QC Inspection Remarks: </span>
                  <span className="text-slate-900">
                    {batch.qcNotes || 'No inspection remarks logged.'}
                  </span>
                </div>
              </div>

              {(() => {
                const batchAudit = auditLogs.filter(
                  (l) => l.batchId === batch.id || l.entityId === batch.id
                );
                if (batchAudit.length === 0) return null;
                return (
                  <div className="space-y-2 pt-2">
                    <h3 className="text-xs font-semibold text-slate-800">
                      07. Electronic Audit Trail ({batchAudit.length} events)
                    </h3>
                    <div className="overflow-x-auto border border-slate-200 rounded">
                      <table className="w-full text-left border-collapse text-[11px]">
                        <thead>
                          <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                            <th className="py-1.5 px-2.5">When</th>
                            <th className="py-1.5 px-2.5">User (Role)</th>
                            <th className="py-1.5 px-2.5">Action</th>
                            <th className="py-1.5 px-2.5">Old → New</th>
                            <th className="py-1.5 px-2.5">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {batchAudit.map((l) => {
                            const whenStr =
                              typeof l.createdAt === 'string'
                                ? l.createdAt
                                : l.createdAt instanceof Date
                                  ? l.createdAt.toISOString().replace('T', ' ').slice(0, 19)
                                  : String(l.createdAt ?? '');
                            const changes = extractAuditFieldChanges(l.oldValue, l.newValue);
                            return (
                              <tr key={l.id} className="align-top">
                                <td className="py-1.5 px-2.5 font-mono text-slate-500 whitespace-nowrap">
                                  {whenStr}
                                </td>
                                <td className="py-1.5 px-2.5 text-slate-900 whitespace-nowrap">
                                  {l.actorName} ({l.actorRole})
                                </td>
                                <td className="py-1.5 px-2.5 font-mono text-slate-800 whitespace-nowrap">
                                  {l.action} · {l.entityType}
                                </td>
                                <td className="py-1.5 px-2.5 text-slate-700">
                                  {changes.length === 0 ? (
                                    <span className="text-slate-400">—</span>
                                  ) : (
                                    <div className="space-y-1">
                                      {changes.map((c) => (
                                        <div key={c.field} className="leading-snug">
                                          <span className="font-semibold text-slate-800">
                                            {c.label}:
                                          </span>{' '}
                                          {c.before !== null && (
                                            <>
                                              <span className="font-mono text-red-700 bg-red-50 px-1 rounded">
                                                {formatAuditValue(c.before)}
                                              </span>{' '}
                                              <span className="text-slate-400">→</span>{' '}
                                            </>
                                          )}
                                          <span className="font-mono text-emerald-800 bg-emerald-50 px-1 rounded">
                                            {formatAuditValue(c.after)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </td>
                                <td className="py-1.5 px-2.5 text-slate-600">
                                  {l.reason || '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              <div className="grid grid-cols-3 gap-6 pt-8 text-xs text-slate-500">
                <div>
                  <div className="border-t border-slate-400 pt-1.5 font-medium text-slate-800">
                    Production Supervisor
                  </div>
                  <div>Signature &amp; Date</div>
                </div>
                <div>
                  <div className="border-t border-slate-400 pt-1.5 font-medium text-slate-800">
                    HACCP / QC Compliance Officer
                  </div>
                  <div>Signature &amp; Date</div>
                </div>
                <div>
                  <div className="border-t border-slate-400 pt-1.5 font-medium text-slate-800">
                    Plant QA Release
                  </div>
                  <div>Signature &amp; Date</div>
                </div>
              </div>
            </section>
          </article>
        </div>
      </div>
    </div>
  );
}
