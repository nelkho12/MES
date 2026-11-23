import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowDownRight,
  ArrowUpRight,
  Download,
  FileText,
  Filter,
  GitCompare,
  Minus,
  Printer,
  RotateCcw,
  Search,
} from 'lucide-react';
import type {
  BatchCheckSpec,
  FormulaBOM,
  ProductionBatch,
  ProductionLineMachine,
  UserRole,
} from '../types';
import {
  buildMonthlyMomComparison,
  buildMonthlyProductionReport,
  buildMonthlyReportCsv,
  DEFAULT_KPI_YIELD_TARGET_PCT,
  DEFAULT_MONTHLY_REPORT_FILTERS,
  extractMonthlyFilterOptions,
  formatYearMonthLabel,
  shiftYearMonth,
  type MonthlyChartMetricMode,
  type MonthlyReportFilters,
  type MonthlyStatusScope,
} from '../utils/monthlyAnalytics';
import { generateMonthlyManagementPdf } from '../utils/monthlyReportPdf';
import { formatCurrency } from '../utils/units';

interface MonthlyProductionReportProps {
  batches: ProductionBatch[];
  formulas: FormulaBOM[];
  productCategories: string[];
  productionLines: ProductionLineMachine[];
  batchCheckSpecs: BatchCheckSpec[];
  preparedBy?: string;
  userRole?: UserRole;
  onOpenBatch: (batchId: string) => void;
  onOpenBatchReport: (batchId: string) => void;
  onNotify: (msg: string) => void;
}

type DimensionViewMode = 'line' | 'product';
type ReportViewMode = 'summary' | 'comparative';
type MomChartSubMode = 'yield_output_overlay' | 'yield_delta_pts';

function renderSignedDeltaText(
  value: number | null,
  unitSuffix: string,
  invertGoodDirection: boolean = false
) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-slate-400">—</span>;
  }
  const isZero = Math.abs(value) < 0.05;
  const isPositiveImprovement = invertGoodDirection ? value < 0 : value > 0;
  const colorClass = isZero
    ? 'text-slate-600'
    : isPositiveImprovement
      ? 'text-emerald-700'
      : 'text-amber-700';

  const Icon = isZero ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono font-medium tabular-nums ${colorClass}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {sign}
      {value.toFixed(1)}
      {unitSuffix}
    </span>
  );
}

export function MonthlyProductionReport({
  batches,
  formulas,
  productCategories,
  productionLines,
  batchCheckSpecs,
  preparedBy = 'Plant Operations Manager',
  userRole = 'manager',
  onOpenBatch,
  onOpenBatchReport,
  onNotify,
}: MonthlyProductionReportProps) {
  const [filters, setFilters] = useState<MonthlyReportFilters>(DEFAULT_MONTHLY_REPORT_FILTERS);
  const [reportViewMode, setReportViewMode] = useState<ReportViewMode>('summary');
  const [chartMetricMode, setChartMetricMode] =
    useState<MonthlyChartMetricMode>('output_yield');
  const [overlayPrevMonth, setOverlayPrevMonth] = useState(false);
  const [momChartSubMode, setMomChartSubMode] =
    useState<MomChartSubMode>('yield_output_overlay');
  const [focusMonthOverride, setFocusMonthOverride] = useState<string>('AUTO');
  const [baselineMonthOverride, setBaselineMonthOverride] = useState<string>('AUTO');
  const [dimensionView, setDimensionView] = useState<DimensionViewMode>('line');
  const [exportingPdf, setExportingPdf] = useState(false);
  const [showReviewNote, setShowReviewNote] = useState(false);
  const [managementNotes, setManagementNotes] = useState('');

  const filterOptions = useMemo(
    () =>
      extractMonthlyFilterOptions(
        batches,
        formulas,
        productCategories,
        productionLines,
        batchCheckSpecs
      ),
    [batches, formulas, productCategories, productionLines, batchCheckSpecs]
  );

  const visibleMonthsForYear = useMemo(() => {
    if (filters.year === 'ALL') return filterOptions.months;
    return filterOptions.months.filter((m) => m.value.startsWith(`${filters.year}-`));
  }, [filterOptions.months, filters.year]);

  const report = useMemo(
    () =>
      buildMonthlyProductionReport(
        batches,
        formulas,
        filters,
        batchCheckSpecs,
        DEFAULT_KPI_YIELD_TARGET_PCT
      ),
    [batches, formulas, filters, batchCheckSpecs]
  );

  const momData = useMemo(
    () =>
      buildMonthlyMomComparison(
        batches,
        formulas,
        filters,
        batchCheckSpecs,
        DEFAULT_KPI_YIELD_TARGET_PCT,
        focusMonthOverride === 'AUTO' ? undefined : focusMonthOverride,
        baselineMonthOverride === 'AUTO' ? undefined : baselineMonthOverride
      ),
    [
      batches,
      formulas,
      filters,
      batchCheckSpecs,
      focusMonthOverride,
      baselineMonthOverride,
    ]
  );

  const isOverlayActive = reportViewMode === 'comparative' || overlayPrevMonth;

  const hasActiveFilters = useMemo(
    () =>
      filters.year !== 'ALL' ||
      filters.month !== 'ALL' ||
      filters.lineName !== 'ALL' ||
      filters.category !== 'ALL' ||
      filters.sku !== 'ALL' ||
      filters.statusScope !== 'ALL' ||
      filters.search.trim().length > 0,
    [filters]
  );

  const activeFilterSummary = useMemo(() => {
    const parts: string[] = [];
    if (filters.year !== 'ALL') parts.push(`Year ${filters.year}`);
    if (filters.month !== 'ALL') parts.push(`Month ${filters.month}`);
    if (filters.lineName !== 'ALL') parts.push(filters.lineName);
    if (filters.category !== 'ALL') parts.push(filters.category);
    if (filters.sku !== 'ALL') parts.push(filters.sku);
    if (filters.statusScope !== 'ALL') parts.push(filters.statusScope.replace(/_/g, ' '));
    if (filters.search.trim()) parts.push(`Query "${filters.search.trim()}"`);
    return parts.length > 0 ? parts.join(' · ') : 'All periods, lines, categories & SKUs';
  }, [filters]);

  const dimensionData = useMemo(() => {
    const source = dimensionView === 'line' ? report.byLine : report.byProduct;
    return source.slice(0, 8);
  }, [dimensionView, report.byLine, report.byProduct]);

  const handleYearChange = (nextYear: string) => {
    setFilters((prev) => ({
      ...prev,
      year: nextYear,
      month:
        prev.month !== 'ALL' && nextYear !== 'ALL' && !prev.month.startsWith(`${nextYear}-`)
          ? 'ALL'
          : prev.month,
    }));
  };

  const handleMonthRowToggle = (yearMonth: string) => {
    if (yearMonth === 'Unknown') return;
    setFilters((prev) => ({
      ...prev,
      month: prev.month === yearMonth ? 'ALL' : yearMonth,
    }));
  };

  const handleResetFilters = () => {
    setFilters(DEFAULT_MONTHLY_REPORT_FILTERS);
    setFocusMonthOverride('AUTO');
    setBaselineMonthOverride('AUTO');
  };

  const handleExportCsv = () => {
    const csv = buildMonthlyReportCsv(report, filters);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    const scopeSlug = filters.month !== 'ALL' ? filters.month : filters.year !== 'ALL' ? filters.year : 'all-months';
    const filename = `monthly-kpi-output-report-${scopeSlug}-${dateStamp}.csv`;
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onNotify(`Exported ${filename}`);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleExportPdf = () => {
    if (report.months.length === 0) return;
    setExportingPdf(true);
    try {
      const filename = generateMonthlyManagementPdf({
        report,
        filters,
        chartMetricMode,
        dimensionView,
        preparedBy,
        userRole,
        managementNotes,
        momData,
        showMomOverlay: isOverlayActive,
      });
      onNotify(`Exported ${filename}`);
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Filter & Export Toolbar */}
      <section className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-teal-700" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Report Filters &amp; Scope
                </h2>
                <p className="text-xs text-slate-500">
                  {activeFilterSummary} · {report.summary.totalBatches} matching job order
                  {report.summary.totalBatches === 1 ? '' : 's'}
                </p>
              </div>
            </div>

            <div
              data-print-hide="true"
              className="inline-flex border border-slate-200 rounded-md overflow-hidden bg-[#F7F8FA]"
            >
              <button
                type="button"
                onClick={() => setReportViewMode('summary')}
                className={`min-h-[36px] px-3 text-xs font-medium transition-colors ${
                  reportViewMode === 'summary'
                    ? 'bg-white text-teal-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Monthly Summary
              </button>
              <button
                type="button"
                onClick={() => setReportViewMode('comparative')}
                className={`min-h-[36px] inline-flex items-center gap-1.5 px-3 text-xs font-medium border-l border-slate-200 transition-colors ${
                  reportViewMode === 'comparative'
                    ? 'bg-white text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                MoM Comparative Analysis
              </button>
            </div>
          </div>

          <div data-print-hide="true" className="flex flex-wrap items-center gap-2">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Filters
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowReviewNote((prev) => !prev)}
              className={`min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border rounded-md transition-colors ${
                showReviewNote || managementNotes.trim()
                  ? 'bg-teal-50 border-teal-200 text-teal-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {managementNotes.trim() ? 'Edit Review Note' : 'Add Review Note'}
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={report.months.length === 0}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Print View
            </button>
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={report.months.length === 0 || exportingPdf}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 transition-colors"
            >
              <FileText className="w-3.5 h-3.5" />
              {exportingPdf ? 'Generating PDF...' : 'Export PDF Report'}
            </button>
          </div>
        </div>

        {(showReviewNote || managementNotes.trim()) && (
          <div data-print-hide="true" className="mt-3 pt-3 border-b border-slate-100 pb-3">
            <label
              htmlFor="monthly-management-review-note"
              className="block text-[11px] font-medium text-slate-600 mb-1"
            >
              Management Review Commentary (stamped onto the exported PDF sign-off section)
            </label>
            <input
              id="monthly-management-review-note"
              type="text"
              value={managementNotes}
              onChange={(e) => setManagementNotes(e.target.value)}
              placeholder="e.g., Kettle Line 2 filler calibration scheduled before December peak run..."
              className="w-full min-h-[40px] px-3 text-xs bg-white border border-slate-200 rounded-md text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            />
          </div>
        )}

        <div
          data-print-hide="true"
          className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3"
        >
          <div>
            <label
              htmlFor="report-filter-year"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Year
            </label>
            <select
              id="report-filter-year"
              value={filters.year}
              onChange={(e) => handleYearChange(e.target.value)}
              className="w-full min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              <option value="ALL">All Years</option>
              {filterOptions.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-filter-month"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Month
            </label>
            <select
              id="report-filter-month"
              value={filters.month}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, month: e.target.value }))
              }
              className="w-full min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              <option value="ALL">All Months</option>
              {visibleMonthsForYear.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} ({m.value})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-filter-line"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Production Line
            </label>
            <select
              id="report-filter-line"
              value={filters.lineName}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, lineName: e.target.value }))
              }
              className="w-full min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              <option value="ALL">All Lines</option>
              {filterOptions.lines.map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-filter-category"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Category
            </label>
            <select
              id="report-filter-category"
              value={filters.category}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, category: e.target.value }))
              }
              className="w-full min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              <option value="ALL">All Categories</option>
              {filterOptions.categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-filter-sku"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Product / SKU
            </label>
            <select
              id="report-filter-sku"
              value={filters.sku}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, sku: e.target.value }))
              }
              className="w-full min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              <option value="ALL">All SKUs</option>
              {filterOptions.skus.map((item) => (
                <option key={item.sku} value={item.sku}>
                  {item.sku} — {item.productName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-filter-status"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Batch Status
            </label>
            <select
              id="report-filter-status"
              value={filters.statusScope}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  statusScope: e.target.value as MonthlyStatusScope,
                }))
              }
              className="w-full min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            >
              <option value="ALL">All Job Orders</option>
              <option value="COMPLETED_CLOSED">Completed &amp; Closed</option>
              <option value="CLOSED_ONLY">Closed Only</option>
              <option value="ACTIVE_IN_PROCESS">Planned / In Progress / QC</option>
              <option value="QC_HOLD">QC Hold Only</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="report-filter-search"
              className="block text-[11px] font-medium text-slate-500 mb-1"
            >
              Search Batch / Lot
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="report-filter-search"
                type="text"
                value={filters.search}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, search: e.target.value }))
                }
                placeholder="Batch, lot, SKU..."
                className="w-full min-h-[40px] pl-8 pr-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
              />
            </div>
          </div>
        </div>
      </section>

      {/* 4-Card KPI Summary Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">Avg Monthly KPI Yield</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {report.summary.avgYieldPct > 0 ? `${report.summary.avgYieldPct.toFixed(1)}%` : '—'}
            </span>
            <span
              className={`font-mono text-xs font-medium tabular-nums ${
                report.summary.avgYieldPct === 0
                  ? 'text-slate-500'
                  : report.summary.yieldGapToTargetPct >= 0
                    ? 'text-emerald-700'
                    : 'text-amber-700'
              }`}
            >
              {report.summary.avgYieldPct > 0
                ? `${report.summary.yieldGapToTargetPct >= 0 ? '+' : ''}${report.summary.yieldGapToTargetPct.toFixed(1)}% vs ${DEFAULT_KPI_YIELD_TARGET_PCT}%`
                : `Target ${DEFAULT_KPI_YIELD_TARGET_PCT}%`}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>Weighted yield</span>
            <span className="font-mono font-medium tabular-nums text-slate-800">
              {report.summary.weightedYieldPct > 0
                ? `${report.summary.weightedYieldPct.toFixed(1)}%`
                : '—'}{' '}
              · {report.summary.targetAttainmentPct.toFixed(0)}% met target
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">Total Production Output</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {report.summary.totalGoodQty.toLocaleString()}
            </span>
            <span className="font-mono text-xs font-medium text-sky-700 tabular-nums">
              {report.summary.avgVelocityUnitsPerHr > 0
                ? `${report.summary.avgVelocityUnitsPerHr.toLocaleString()} u/hr`
                : `${report.summary.planAttainmentPct.toFixed(1)}% of plan`}
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600 gap-2">
            <span>
              {report.summary.planAttainmentPct.toFixed(1)}% plan · {report.summary.totalOutputMassKg.toLocaleString()} kg
            </span>
            <span
              className={`font-mono font-medium tabular-nums truncate ${
                report.summary.bottleneckCount > 0 ? 'text-amber-700' : 'text-slate-700'
              }`}
            >
              {report.summary.bottleneckCount > 0 && report.summary.slowestLineName
                ? `Bottleneck: ${report.summary.slowestLineName}`
                : report.summary.avgCycleTimeHrs > 0
                  ? `${report.summary.avgCycleTimeHrs.toFixed(1)}h avg cycle`
                  : `Planned ${report.summary.totalPlannedQty.toLocaleString()}`}
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">QC Release Pass Rate</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {report.summary.qcDecidedCount > 0
                ? `${report.summary.qcPassRatePct.toFixed(1)}%`
                : '—'}
            </span>
            <span
              className={`text-xs font-medium tabular-nums ${
                report.summary.qcHoldBatches === 0 ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {report.summary.qcHoldBatches} on QC Hold
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>
              {report.summary.qcPassedCount}/{report.summary.qcDecidedCount} QC decided
            </span>
            <span>
              {report.summary.completedOrClosedBatches} completed/closed
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">Rejects, Waste &amp; Cost</div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {(report.summary.totalRejectedQty + report.summary.totalReworkQty).toLocaleString()}
            </span>
            <span className="font-mono text-xs font-medium text-slate-600 tabular-nums">
              {report.summary.totalWasteKg.toFixed(1)} kg waste
            </span>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
            <span>
              {report.summary.totalRejectedQty} rej · {report.summary.totalReworkQty} rework
            </span>
            <span className="font-mono font-medium tabular-nums text-slate-800">
              {formatCurrency(report.summary.totalProductionCost)}
            </span>
          </div>
        </div>
      </section>

      {/* Empty Filter Guard */}
      {report.months.length === 0 ? (
        <section className="bg-white border border-slate-200 rounded-lg p-10 text-center">
          <p className="text-sm font-semibold text-slate-900">
            No job orders match the active report filters
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Try clearing the month, line, category, or search filter to inspect all plant production months.
          </p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="mt-4 min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Filters
            </button>
          )}
        </section>
      ) : reportViewMode === 'comparative' ? (
        <>
          {/* Comparative Analysis Period Control Bar */}
          <section className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Month-over-Month Yield &amp; Output Comparative Analysis
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {momData.focusMonth && momData.baselineMonth ? (
                    momData.baselineBucket ? (
                      <>
                        Comparing{' '}
                        <span className="font-medium text-slate-800">
                          {formatYearMonthLabel(momData.focusMonth)} ({momData.focusMonth})
                        </span>{' '}
                        with previous baseline{' '}
                        <span className="font-medium text-indigo-700">
                          {formatYearMonthLabel(momData.baselineMonth)} ({momData.baselineMonth})
                        </span>
                      </>
                    ) : (
                      <>
                        Focus month{' '}
                        <span className="font-medium text-slate-800">
                          {formatYearMonthLabel(momData.focusMonth)} ({momData.focusMonth})
                        </span>{' '}
                        · No batches recorded in{' '}
                        <span className="font-medium text-slate-700">
                          {formatYearMonthLabel(momData.baselineMonth)} ({momData.baselineMonth})
                        </span>{' '}
                        for this filter scope
                      </>
                    )
                  ) : (
                    'Select a focus month and baseline month to overlay month-over-month yield performance.'
                  )}
                </p>
              </div>

              <div data-print-hide="true" className="flex flex-wrap items-center gap-3">
                <div>
                  <label
                    htmlFor="mom-focus-month"
                    className="block text-[11px] font-medium text-slate-500 mb-1"
                  >
                    Focus Month
                  </label>
                  <select
                    id="mom-focus-month"
                    value={focusMonthOverride}
                    onChange={(e) => setFocusMonthOverride(e.target.value)}
                    className="min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-600/20 focus:border-indigo-600"
                  >
                    <option value="AUTO">
                      Auto ({momData.focusMonth ? formatYearMonthLabel(momData.focusMonth) : 'Latest'})
                    </option>
                    {momData.availableMonthsInScope.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label} ({m.value})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="mom-baseline-month"
                    className="block text-[11px] font-medium text-slate-500 mb-1"
                  >
                    Overlay Baseline Month
                  </label>
                  <select
                    id="mom-baseline-month"
                    value={baselineMonthOverride}
                    onChange={(e) => setBaselineMonthOverride(e.target.value)}
                    className="min-h-[40px] px-2.5 text-xs bg-white border border-slate-200 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-600/20 focus:border-indigo-600"
                  >
                    <option value="AUTO">
                      Previous Calendar Month (
                      {momData.focusMonth
                        ? formatYearMonthLabel(shiftYearMonth(momData.focusMonth, -1) || '')
                        : 'Auto'}
                      )
                    </option>
                    {momData.availableMonthsInScope
                      .filter((m) => m.value !== momData.focusMonth)
                      .map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label} ({m.value})
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            </div>

            {/* 4-Card MoM Delta Strip */}
            {momData.focusComparison && (
              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="border border-slate-200 rounded-md p-3.5 bg-[#F7F8FA]">
                  <div className="text-[11px] font-medium text-slate-500">
                    Avg KPI Yield (MoM)
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {momData.focusComparison.avgYieldPct > 0
                        ? `${momData.focusComparison.avgYieldPct.toFixed(1)}%`
                        : '—'}
                    </span>
                    <span className="text-xs">
                      {renderSignedDeltaText(momData.focusComparison.yieldDeltaPts, ' pts')}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-600 font-mono tabular-nums">
                    Prev ({momData.focusComparison.prevLabel || '—'}):{' '}
                    {momData.focusComparison.prevAvgYieldPct !== null
                      ? `${momData.focusComparison.prevAvgYieldPct.toFixed(1)}%`
                      : 'No data'}
                  </div>
                </div>

                <div className="border border-slate-200 rounded-md p-3.5 bg-[#F7F8FA]">
                  <div className="text-[11px] font-medium text-slate-500">
                    Weighted Yield (MoM)
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {momData.focusComparison.weightedYieldPct > 0
                        ? `${momData.focusComparison.weightedYieldPct.toFixed(1)}%`
                        : '—'}
                    </span>
                    <span className="text-xs">
                      {renderSignedDeltaText(momData.focusComparison.weightedYieldDeltaPts, ' pts')}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-600 font-mono tabular-nums">
                    Prev ({momData.focusComparison.prevLabel || '—'}):{' '}
                    {momData.focusComparison.prevWeightedYieldPct !== null
                      ? `${momData.focusComparison.prevWeightedYieldPct.toFixed(1)}%`
                      : 'No data'}
                  </div>
                </div>

                <div className="border border-slate-200 rounded-md p-3.5 bg-[#F7F8FA]">
                  <div className="text-[11px] font-medium text-slate-500">
                    Good Output Volume (MoM)
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {momData.focusComparison.goodQty.toLocaleString()}
                    </span>
                    <span className="text-xs">
                      {momData.focusComparison.goodQtyDeltaPct !== null
                        ? renderSignedDeltaText(momData.focusComparison.goodQtyDeltaPct, '%')
                        : renderSignedDeltaText(momData.focusComparison.goodQtyDelta, ' units')}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-600 font-mono tabular-nums">
                    Prev ({momData.focusComparison.prevLabel || '—'}):{' '}
                    {momData.focusComparison.prevGoodQty !== null
                      ? `${momData.focusComparison.prevGoodQty.toLocaleString()} units`
                      : 'No data'}
                  </div>
                </div>

                <div className="border border-slate-200 rounded-md p-3.5 bg-[#F7F8FA]">
                  <div className="text-[11px] font-medium text-slate-500">
                    QC Pass &amp; Waste (MoM)
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                      {momData.focusComparison.qcPassRatePct > 0
                        ? `${momData.focusComparison.qcPassRatePct.toFixed(1)}%`
                        : '—'}
                    </span>
                    <span className="text-xs">
                      {renderSignedDeltaText(momData.focusComparison.qcPassDeltaPts, ' pts')}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-600 font-mono tabular-nums">
                    Waste {momData.focusComparison.wasteKg.toFixed(1)} kg ·{' '}
                    {momData.focusComparison.wasteDeltaKg !== null
                      ? `${momData.focusComparison.wasteDeltaKg > 0 ? '+' : ''}${momData.focusComparison.wasteDeltaKg.toFixed(1)} kg vs prev`
                      : 'Prev: No data'}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Comparative Overlay Charts Row */}
          <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
            <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Month-over-Month Yield &amp; Output Overlay
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Overlays each month against its previous calendar month · Target KPI {DEFAULT_KPI_YIELD_TARGET_PCT}%
                  </p>
                </div>

                <div
                  data-print-hide="true"
                  className="inline-flex border border-slate-200 rounded-md overflow-hidden bg-[#F7F8FA]"
                >
                  <button
                    type="button"
                    onClick={() => setMomChartSubMode('yield_output_overlay')}
                    className={`min-h-[36px] px-3 text-xs font-medium transition-colors ${
                      momChartSubMode === 'yield_output_overlay'
                        ? 'bg-white text-indigo-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Output &amp; Yield Overlay
                  </button>
                  <button
                    type="button"
                    onClick={() => setMomChartSubMode('yield_delta_pts')}
                    className={`min-h-[36px] px-3 text-xs font-medium border-l border-slate-200 transition-colors ${
                      momChartSubMode === 'yield_delta_pts'
                        ? 'bg-white text-indigo-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    MoM Delta (pts)
                  </button>
                </div>
              </div>

              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  {momChartSubMode === 'yield_output_overlay' ? (
                    <ComposedChart
                      data={momData.overlaySeries}
                      margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                        tickFormatter={(v) => Number(v).toLocaleString()}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[75, 102]}
                        tick={{ fontSize: 11, fill: '#059669' }}
                        stroke="#CBD5E1"
                        unit="%"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <ReferenceLine
                        yAxisId="right"
                        y={DEFAULT_KPI_YIELD_TARGET_PCT}
                        stroke="#059669"
                        strokeDasharray="4 4"
                        label={{
                          value: `KPI ${DEFAULT_KPI_YIELD_TARGET_PCT}%`,
                          position: 'insideTopRight',
                          fill: '#047857',
                          fontSize: 10,
                        }}
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="goodQty"
                        name="Current Good Output"
                        fill="#0F766E"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={36}
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="prevGoodQty"
                        name="Prev Month Output"
                        fill="#CBD5E1"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={36}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="avgYieldPct"
                        name="Current Avg Yield (%)"
                        stroke="#059669"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: '#059669' }}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="prevAvgYieldPct"
                        name="Prev Month Avg Yield (%)"
                        stroke="#4F46E5"
                        strokeWidth={2.2}
                        strokeDasharray="5 3"
                        dot={{ r: 4, fill: '#4F46E5' }}
                        connectNulls={false}
                      />
                    </ComposedChart>
                  ) : (
                    <ComposedChart
                      data={momData.overlaySeries}
                      margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: '#4F46E5' }}
                        stroke="#CBD5E1"
                        unit=" pts"
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[75, 102]}
                        tick={{ fontSize: 11, fill: '#059669' }}
                        stroke="#CBD5E1"
                        unit="%"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <ReferenceLine yAxisId="left" y={0} stroke="#94A3B8" />
                      <ReferenceLine
                        yAxisId="right"
                        y={DEFAULT_KPI_YIELD_TARGET_PCT}
                        stroke="#059669"
                        strokeDasharray="4 4"
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="yieldDeltaPts"
                        name="MoM Yield Change (pts)"
                        fill="#0F766E"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={36}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="weightedYieldPct"
                        name="Current Weighted Yield (%)"
                        stroke="#059669"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: '#059669' }}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="prevWeightedYieldPct"
                        name="Prev Weighted Yield (%)"
                        stroke="#4F46E5"
                        strokeWidth={2}
                        strokeDasharray="5 3"
                        dot={{ r: 3.5, fill: '#4F46E5' }}
                        connectNulls={false}
                      />
                    </ComposedChart>
                  )}
                </ResponsiveContainer>
              </div>
            </div>

            {/* Focus vs Baseline Month Yield Comparison by Line / SKU */}
            <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    {dimensionView === 'line'
                      ? 'Line Yield Overlay (Focus vs. Prev)'
                      : 'SKU Yield Overlay (Focus vs. Prev)'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {momData.focusMonth ? formatYearMonthLabel(momData.focusMonth) : 'Current'} vs.{' '}
                    {momData.baselineMonth ? formatYearMonthLabel(momData.baselineMonth) : 'Prev Month'}
                  </p>
                </div>

                <div
                  data-print-hide="true"
                  className="inline-flex border border-slate-200 rounded-md overflow-hidden bg-[#F7F8FA]"
                >
                  <button
                    type="button"
                    onClick={() => setDimensionView('line')}
                    className={`min-h-[36px] px-3 text-xs font-medium transition-colors ${
                      dimensionView === 'line'
                        ? 'bg-white text-indigo-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    By Line
                  </button>
                  <button
                    type="button"
                    onClick={() => setDimensionView('product')}
                    className={`min-h-[36px] px-3 text-xs font-medium border-l border-slate-200 transition-colors ${
                      dimensionView === 'product'
                        ? 'bg-white text-indigo-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    By Product / SKU
                  </button>
                </div>
              </div>

              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={(dimensionView === 'line'
                      ? momData.byLineMom
                      : momData.byProductMom
                    ).slice(0, 7)}
                    margin={{ top: 10, right: 12, left: 0, bottom: 18 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: '#64748B' }}
                      stroke="#CBD5E1"
                      interval={0}
                      angle={
                        (dimensionView === 'line'
                          ? momData.byLineMom
                          : momData.byProductMom
                        ).length > 4
                          ? -15
                          : 0
                      }
                      textAnchor={
                        (dimensionView === 'line'
                          ? momData.byLineMom
                          : momData.byProductMom
                        ).length > 4
                          ? 'end'
                          : 'middle'
                      }
                    />
                    <YAxis
                      domain={[75, 102]}
                      tick={{ fontSize: 11, fill: '#64748B' }}
                      stroke="#CBD5E1"
                      unit="%"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#FFFFFF',
                        border: '1px solid #E2E8F0',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <ReferenceLine
                      y={DEFAULT_KPI_YIELD_TARGET_PCT}
                      stroke="#059669"
                      strokeDasharray="4 4"
                    />
                    <Bar
                      dataKey="currentYieldPct"
                      name={`${momData.focusMonth ? formatYearMonthLabel(momData.focusMonth) : 'Current'} Yield (%)`}
                      fill="#0F766E"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={28}
                    />
                    <Bar
                      dataKey="prevYieldPct"
                      name={`${momData.baselineMonth ? formatYearMonthLabel(momData.baselineMonth) : 'Prev Month'} Yield (%)`}
                      fill="#94A3B8"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={28}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          {/* Month-over-Month Trend Table */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Month-over-Month Yield &amp; Output Variance Table
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Click any month row to set it as the focus month · Each row compares against its immediate calendar previous month
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-5">Current Month</th>
                    <th className="py-2.5 px-4">Prev Month</th>
                    <th className="py-2.5 px-4 text-right">Curr Yield %</th>
                    <th className="py-2.5 px-4 text-right">Prev Yield %</th>
                    <th className="py-2.5 px-4 text-right">MoM Yield Δ</th>
                    <th className="py-2.5 px-4 text-right">Wtd Yield Δ</th>
                    <th className="py-2.5 px-4 text-right">Curr Output</th>
                    <th className="py-2.5 px-4 text-right">Prev Output</th>
                    <th className="py-2.5 px-4 text-right">Output Δ</th>
                    <th className="py-2.5 px-5 text-right">QC Pass Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {momData.overlaySeries.map((pt) => {
                    const isFocus = momData.focusMonth === pt.yearMonth;
                    return (
                      <tr
                        key={pt.yearMonth}
                        onClick={() =>
                          pt.yearMonth !== 'Unknown' && setFocusMonthOverride(pt.yearMonth)
                        }
                        className={`cursor-pointer transition-colors ${
                          isFocus ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 px-5">
                          <div className="font-semibold text-slate-900">{pt.label}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {pt.yearMonth} · {pt.totalBatches} job{pt.totalBatches === 1 ? '' : 's'}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-xs font-medium text-slate-700">
                            {pt.prevLabel || '—'}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {pt.hasPrevData
                              ? `${pt.prevTotalBatches} job${pt.prevTotalBatches === 1 ? '' : 's'}`
                              : 'No data'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                          {pt.avgYieldPct > 0 ? (
                            <span
                              className={
                                pt.avgYieldPct >= DEFAULT_KPI_YIELD_TARGET_PCT
                                  ? 'text-emerald-700'
                                  : 'text-amber-700'
                              }
                            >
                              {pt.avgYieldPct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                          {pt.prevAvgYieldPct !== null ? `${pt.prevAvgYieldPct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-3 px-4 text-right text-xs">
                          {renderSignedDeltaText(pt.yieldDeltaPts, ' pts')}
                        </td>
                        <td className="py-3 px-4 text-right text-xs">
                          {renderSignedDeltaText(pt.weightedYieldDeltaPts, ' pts')}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                          {pt.goodQty.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                          {pt.prevGoodQty !== null ? pt.prevGoodQty.toLocaleString() : '—'}
                        </td>
                        <td className="py-3 px-4 text-right text-xs font-mono tabular-nums">
                          {pt.goodQtyDelta !== null ? (
                            <span
                              className={
                                pt.goodQtyDelta >= 0 ? 'text-emerald-700' : 'text-amber-700'
                              }
                            >
                              {pt.goodQtyDelta > 0 ? '+' : ''}
                              {pt.goodQtyDelta.toLocaleString()}
                              {pt.goodQtyDeltaPct !== null
                                ? ` (${pt.goodQtyDeltaPct > 0 ? '+' : ''}${pt.goodQtyDeltaPct.toFixed(1)}%)`
                                : ''}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-5 text-right text-xs">
                          {renderSignedDeltaText(pt.qcPassDeltaPts, ' pts')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Line & SKU MoM Breakdown Table */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {dimensionView === 'line'
                    ? 'Production Line Month-over-Month Yield Comparison'
                    : 'Product / SKU Month-over-Month Yield Comparison'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {momData.focusMonth ? formatYearMonthLabel(momData.focusMonth) : 'Current'} vs.{' '}
                  {momData.baselineMonth ? formatYearMonthLabel(momData.baselineMonth) : 'Previous Month'}
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-5">
                      {dimensionView === 'line' ? 'Production Line' : 'SKU / Product'}
                    </th>
                    <th className="py-2.5 px-4 text-right">Jobs (Curr / Prev)</th>
                    <th className="py-2.5 px-4 text-right">Curr Yield %</th>
                    <th className="py-2.5 px-4 text-right">Prev Yield %</th>
                    <th className="py-2.5 px-4 text-right">MoM Yield Δ</th>
                    <th className="py-2.5 px-4 text-right">Curr Output</th>
                    <th className="py-2.5 px-4 text-right">Prev Output</th>
                    <th className="py-2.5 px-5 text-right">Output Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {(dimensionView === 'line' ? momData.byLineMom : momData.byProductMom).map(
                    (row) => (
                      <tr key={row.key} className="hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-5">
                          <div className="font-semibold text-slate-900">{row.label}</div>
                          {row.sublabel && (
                            <div className="text-xs text-slate-500">{row.sublabel}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {row.currentBatches} / {row.prevBatches}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                          {row.currentYieldPct > 0 ? (
                            <span
                              className={
                                row.currentYieldPct >= DEFAULT_KPI_YIELD_TARGET_PCT
                                  ? 'text-emerald-700'
                                  : 'text-amber-700'
                              }
                            >
                              {row.currentYieldPct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                          {row.prevYieldPct !== null ? `${row.prevYieldPct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-3 px-4 text-right text-xs">
                          {renderSignedDeltaText(row.yieldDeltaPts, ' pts')}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                          {row.currentGoodQty.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                          {row.prevGoodQty.toLocaleString()}
                        </td>
                        <td className="py-3 px-5 text-right font-mono tabular-nums text-xs">
                          <span
                            className={
                              row.goodQtyDelta >= 0 ? 'text-emerald-700' : 'text-amber-700'
                            }
                          >
                            {row.goodQtyDelta > 0 ? '+' : ''}
                            {row.goodQtyDelta.toLocaleString()}
                            {row.goodQtyDeltaPct !== null
                              ? ` (${row.goodQtyDeltaPct > 0 ? '+' : ''}${row.goodQtyDeltaPct.toFixed(1)}%)`
                              : ''}
                          </span>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          {/* Statistics Graphs Row */}
          <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
            {/* Primary Monthly KPI Yield & Production Output Statistics Graph */}
            <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Monthly KPI Yield &amp; Production Output
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Month-by-month output &amp; average production velocity ({report.summary.avgVelocityUnitsPerHr > 0 ? `${report.summary.avgVelocityUnitsPerHr.toLocaleString()} u/hr avg` : 'no runtime logged'}) vs. {DEFAULT_KPI_YIELD_TARGET_PCT}% KPI yield target
                    {overlayPrevMonth ? ' · Previous month overlay active' : ''}
                  </p>
                </div>

                <div data-print-hide="true" className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setOverlayPrevMonth((v) => !v)}
                    className={`min-h-[36px] inline-flex items-center gap-1.5 px-3 text-xs font-medium border rounded-md transition-colors ${
                      overlayPrevMonth
                        ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <GitCompare className="w-3.5 h-3.5" />
                    {overlayPrevMonth ? 'Prev Month Overlaid' : 'Overlay Prev Month'}
                  </button>

                  <div className="inline-flex border border-slate-200 rounded-md overflow-hidden bg-[#F7F8FA]">
                    <button
                      type="button"
                      onClick={() => setChartMetricMode('output_yield')}
                      className={`min-h-[36px] px-2.5 text-xs font-medium transition-colors ${
                        chartMetricMode === 'output_yield'
                          ? 'bg-white text-teal-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Output &amp; Yield %
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartMetricMode('velocity_bottleneck')}
                      className={`min-h-[36px] px-2.5 text-xs font-medium border-l border-slate-200 transition-colors ${
                        chartMetricMode === 'velocity_bottleneck'
                          ? 'bg-white text-sky-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Velocity (u/hr)
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartMetricMode('mass_waste')}
                      className={`min-h-[36px] px-2.5 text-xs font-medium border-l border-slate-200 transition-colors ${
                        chartMetricMode === 'mass_waste'
                          ? 'bg-white text-teal-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Mass &amp; Waste
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartMetricMode('quality_plan')}
                      className={`min-h-[36px] px-2.5 text-xs font-medium border-l border-slate-200 transition-colors ${
                        chartMetricMode === 'quality_plan'
                          ? 'bg-white text-teal-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      QC &amp; Plan %
                    </button>
                  </div>
                </div>
              </div>

              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  {chartMetricMode === 'output_yield' ? (
                    <ComposedChart
                      data={momData.overlaySeries}
                      margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                        tickFormatter={(v) => Number(v).toLocaleString()}
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[75, 102]}
                        tick={{ fontSize: 11, fill: '#059669' }}
                        stroke="#CBD5E1"
                        unit="%"
                      />
                      <YAxis
                        yAxisId="velocity"
                        orientation="right"
                        width={54}
                        domain={[0, 'auto']}
                        tick={{ fontSize: 10, fill: '#0284C7' }}
                        stroke="#CBD5E1"
                        tickFormatter={(v) => `${Math.round(Number(v))}`}
                        unit=" u/h"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <ReferenceLine
                        yAxisId="right"
                        y={DEFAULT_KPI_YIELD_TARGET_PCT}
                        stroke="#059669"
                        strokeDasharray="4 4"
                        label={{
                          value: `KPI ${DEFAULT_KPI_YIELD_TARGET_PCT}%`,
                          position: 'insideTopRight',
                          fill: '#047857',
                          fontSize: 10,
                        }}
                      />
                      {report.summary.avgVelocityUnitsPerHr > 0 && (
                        <ReferenceLine
                          yAxisId="velocity"
                          y={report.summary.avgVelocityUnitsPerHr}
                          stroke="#0284C7"
                          strokeDasharray="3 3"
                          label={{
                            value: `Avg ${report.summary.avgVelocityUnitsPerHr} u/h`,
                            position: 'insideBottomLeft',
                            fill: '#0369A1',
                            fontSize: 10,
                          }}
                        />
                      )}
                      <Bar
                        yAxisId="left"
                        dataKey="goodQty"
                        name="Good Output (units)"
                        fill="#0F766E"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={44}
                      />
                      {overlayPrevMonth ? (
                        <Bar
                          yAxisId="left"
                          dataKey="prevGoodQty"
                          name="Prev Month Output"
                          fill="#CBD5E1"
                          radius={[4, 4, 0, 0]}
                          maxBarSize={36}
                        />
                      ) : (
                        <Bar
                          yAxisId="left"
                          dataKey="rejectPlusReworkQty"
                          name="Reject + Rework (units)"
                          fill="#D97706"
                          radius={[4, 4, 0, 0]}
                          maxBarSize={28}
                        />
                      )}
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="avgYieldPct"
                        name="Avg KPI Yield (%)"
                        stroke="#059669"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: '#059669' }}
                      />
                      {overlayPrevMonth && (
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="prevAvgYieldPct"
                          name="Prev Month Avg Yield (%)"
                          stroke="#4F46E5"
                          strokeWidth={2.2}
                          strokeDasharray="5 3"
                          dot={{ r: 3.5, fill: '#4F46E5' }}
                          connectNulls={false}
                        />
                      )}
                      <Line
                        yAxisId="velocity"
                        type="monotone"
                        dataKey="avgVelocityUnitsPerHr"
                        name="Avg Production Velocity (u/hr)"
                        stroke="#0284C7"
                        strokeWidth={2.4}
                        dot={{ r: 4, fill: '#0284C7' }}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="weightedYieldPct"
                        name="Weighted Yield (%)"
                        stroke="#2563EB"
                        strokeWidth={1.8}
                        strokeDasharray="4 3"
                        dot={{ r: 3, fill: '#2563EB' }}
                      />
                    </ComposedChart>
                  ) : chartMetricMode === 'velocity_bottleneck' ? (
                    <ComposedChart
                      data={momData.overlaySeries}
                      margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: '#0284C7' }}
                        stroke="#CBD5E1"
                        unit=" u/h"
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fontSize: 11, fill: '#D97706' }}
                        stroke="#CBD5E1"
                        unit=" h"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      {report.summary.avgVelocityUnitsPerHr > 0 && (
                        <ReferenceLine
                          yAxisId="left"
                          y={report.summary.avgVelocityUnitsPerHr}
                          stroke="#0284C7"
                          strokeDasharray="4 4"
                          label={{
                            value: `Plant Avg ${report.summary.avgVelocityUnitsPerHr} u/h`,
                            position: 'insideTopRight',
                            fill: '#0369A1',
                            fontSize: 10,
                          }}
                        />
                      )}
                      <Bar
                        yAxisId="left"
                        dataKey="targetVelocityUnitsPerHr"
                        name="Target Routing Velocity (u/hr)"
                        fill="#CBD5E1"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={36}
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="avgVelocityUnitsPerHr"
                        name="Actual Output Velocity (u/hr)"
                        fill="#0F766E"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={36}
                      />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="avgVelocityUnitsPerHr"
                        name="Avg Production Velocity Trend (u/hr)"
                        stroke="#0284C7"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: '#0284C7' }}
                      />
                      {overlayPrevMonth && (
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="prevAvgVelocityUnitsPerHr"
                          name="Prev Month Velocity (u/hr)"
                          stroke="#4F46E5"
                          strokeWidth={2}
                          strokeDasharray="5 3"
                          dot={{ r: 3.5, fill: '#4F46E5' }}
                          connectNulls={false}
                        />
                      )}
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="avgCycleTimeHrs"
                        name="Avg Cycle Time (hrs/batch)"
                        stroke="#D97706"
                        strokeWidth={2}
                        dot={{ r: 3.5, fill: '#D97706' }}
                      />
                    </ComposedChart>
                  ) : chartMetricMode === 'mass_waste' ? (
                    <ComposedChart
                      data={momData.overlaySeries}
                      margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                        unit=" kg"
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        domain={[75, 102]}
                        tick={{ fontSize: 11, fill: '#059669' }}
                        stroke="#CBD5E1"
                        unit="%"
                      />
                      <YAxis yAxisId="velocity" hide domain={[0, 'auto']} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <ReferenceLine
                        yAxisId="right"
                        y={DEFAULT_KPI_YIELD_TARGET_PCT}
                        stroke="#059669"
                        strokeDasharray="4 4"
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="outputMassKg"
                        name="Net Output Mass (kg)"
                        fill="#0F766E"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={44}
                      />
                      {overlayPrevMonth ? (
                        <Bar
                          yAxisId="left"
                          dataKey="prevOutputMassKg"
                          name="Prev Month Mass (kg)"
                          fill="#CBD5E1"
                          radius={[4, 4, 0, 0]}
                          maxBarSize={36}
                        />
                      ) : (
                        <Bar
                          yAxisId="left"
                          dataKey="wasteKg"
                          name="Process Waste (kg)"
                          fill="#DC2626"
                          radius={[4, 4, 0, 0]}
                          maxBarSize={28}
                        />
                      )}
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="avgYieldPct"
                        name="Avg KPI Yield (%)"
                        stroke="#059669"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: '#059669' }}
                      />
                      <Line
                        yAxisId="velocity"
                        type="monotone"
                        dataKey="avgVelocityUnitsPerHr"
                        name="Avg Production Velocity (u/hr)"
                        stroke="#0284C7"
                        strokeWidth={2.2}
                        dot={{ r: 3.5, fill: '#0284C7' }}
                      />
                      {overlayPrevMonth && (
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="prevAvgYieldPct"
                          name="Prev Month Avg Yield (%)"
                          stroke="#4F46E5"
                          strokeWidth={2.2}
                          strokeDasharray="5 3"
                          dot={{ r: 3.5, fill: '#4F46E5' }}
                          connectNulls={false}
                        />
                      )}
                    </ComposedChart>
                  ) : (
                    <ComposedChart
                      data={momData.overlaySeries}
                      margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                      />
                      <YAxis
                        domain={[0, 105]}
                        tick={{ fontSize: 11, fill: '#64748B' }}
                        stroke="#CBD5E1"
                        unit="%"
                      />
                      <YAxis yAxisId="velocity" hide domain={[0, 'auto']} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#FFFFFF',
                          border: '1px solid #E2E8F0',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <ReferenceLine
                        y={DEFAULT_KPI_YIELD_TARGET_PCT}
                        stroke="#059669"
                        strokeDasharray="4 4"
                      />
                      <Bar
                        dataKey="planAttainmentPct"
                        name="Plan Attainment (%)"
                        fill="#0F766E"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={42}
                      />
                      <Line
                        type="monotone"
                        dataKey="avgYieldPct"
                        name="Avg KPI Yield (%)"
                        stroke="#059669"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: '#059669' }}
                      />
                      {overlayPrevMonth && (
                        <Line
                          type="monotone"
                          dataKey="prevAvgYieldPct"
                          name="Prev Month Avg Yield (%)"
                          stroke="#4F46E5"
                          strokeWidth={2.2}
                          strokeDasharray="5 3"
                          dot={{ r: 3.5, fill: '#4F46E5' }}
                          connectNulls={false}
                        />
                      )}
                      <Line
                        type="monotone"
                        dataKey="qcPassRatePct"
                        name="QC Pass Rate (%)"
                        stroke="#2563EB"
                        strokeWidth={2.2}
                        dot={{ r: 4, fill: '#2563EB' }}
                      />
                      <Line
                        yAxisId="velocity"
                        type="monotone"
                        dataKey="avgVelocityUnitsPerHr"
                        name="Avg Production Velocity (u/hr)"
                        stroke="#0284C7"
                        strokeWidth={2.2}
                        dot={{ r: 3.5, fill: '#0284C7' }}
                      />
                    </ComposedChart>
                  )}
                </ResponsiveContainer>
              </div>
            </div>

            {/* Line / Product Comparison Graph */}
            <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    {dimensionView === 'line'
                      ? 'Output & Yield by Line'
                      : 'Output & Yield by SKU'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Filtered period breakdown across top{' '}
                    {dimensionView === 'line' ? 'production lines' : 'SKUs'}
                  </p>
                </div>

                <div
                  data-print-hide="true"
                  className="inline-flex border border-slate-200 rounded-md overflow-hidden bg-[#F7F8FA]"
                >
                  <button
                    type="button"
                    onClick={() => setDimensionView('line')}
                    className={`min-h-[36px] px-3 text-xs font-medium transition-colors ${
                      dimensionView === 'line'
                        ? 'bg-white text-teal-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    By Line
                  </button>
                  <button
                    type="button"
                    onClick={() => setDimensionView('product')}
                    className={`min-h-[36px] px-3 text-xs font-medium border-l border-slate-200 transition-colors ${
                      dimensionView === 'product'
                        ? 'bg-white text-teal-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    By Product / SKU
                  </button>
                </div>
              </div>

              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={dimensionData}
                    margin={{ top: 10, right: 12, left: 0, bottom: 18 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: '#64748B' }}
                      stroke="#CBD5E1"
                      interval={0}
                      angle={dimensionData.length > 4 ? -15 : 0}
                      textAnchor={dimensionData.length > 4 ? 'end' : 'middle'}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 11, fill: '#64748B' }}
                      stroke="#CBD5E1"
                      tickFormatter={(v) => Number(v).toLocaleString()}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      domain={[75, 102]}
                      tick={{ fontSize: 11, fill: '#059669' }}
                      stroke="#CBD5E1"
                      unit="%"
                    />
                    <YAxis yAxisId="velocity" hide domain={[0, 'auto']} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#FFFFFF',
                        border: '1px solid #E2E8F0',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    <ReferenceLine
                      yAxisId="right"
                      y={DEFAULT_KPI_YIELD_TARGET_PCT}
                      stroke="#059669"
                      strokeDasharray="4 4"
                    />
                    <Bar
                      yAxisId="left"
                      dataKey="goodQty"
                      name="Good Output (units)"
                      fill="#0F766E"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={38}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="avgYieldPct"
                      name="Avg KPI Yield (%)"
                      stroke="#059669"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: '#059669' }}
                    />
                    <Line
                      yAxisId="velocity"
                      type="monotone"
                      dataKey="avgVelocityUnitsPerHr"
                      name="Avg Velocity (u/hr)"
                      stroke="#0284C7"
                      strokeWidth={2.2}
                      dot={{ r: 3.5, fill: '#0284C7' }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          {/* Monthly KPI Yield & Output Report Table */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Monthly KPI Yield &amp; Production Output Report
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Click any month row to drill into its job orders · Target KPI yield benchmark {DEFAULT_KPI_YIELD_TARGET_PCT}%
                </p>
              </div>
              {filters.month !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, month: 'ALL' }))}
                  className="text-xs font-medium text-teal-700 hover:text-teal-800"
                >
                  Show all months
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-5">Month</th>
                    <th className="py-2.5 px-4 text-right">Jobs (Comp/Cls)</th>
                    <th className="py-2.5 px-4 text-right">Planned Qty</th>
                    <th className="py-2.5 px-4 text-right">Good Output</th>
                    <th className="py-2.5 px-4 text-right">Plan %</th>
                    <th className="py-2.5 px-4 text-right">Mass (kg)</th>
                    <th className="py-2.5 px-4 text-right">Reject / Rework</th>
                    <th className="py-2.5 px-4 text-right">Waste (kg)</th>
                    <th className="py-2.5 px-4 text-right">Avg Yield %</th>
                    <th className="py-2.5 px-4 text-right">Weighted %</th>
                    <th className="py-2.5 px-4 text-right">Velocity (u/h)</th>
                    <th className="py-2.5 px-4 text-right">QC Pass %</th>
                    <th className="py-2.5 px-5 text-right">Avg Unit Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {report.months.map((m) => {
                    const isSelectedMonth = filters.month === m.yearMonth;
                    const meetsTarget = m.avgYieldPct >= m.targetYieldPct;
                    return (
                      <tr
                        key={m.yearMonth}
                        onClick={() => handleMonthRowToggle(m.yearMonth)}
                        className={`cursor-pointer transition-colors ${
                          isSelectedMonth ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 px-5">
                          <div className="font-semibold text-slate-900">{m.label}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {m.yearMonth}
                            {m.qcHoldBatches > 0 ? ` · ${m.qcHoldBatches} QC Hold` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800">
                          {m.totalBatches}{' '}
                          <span className="text-xs text-slate-500">
                            ({m.completedBatches + m.closedBatches})
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {m.plannedQty.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                          {m.goodQty.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {m.planAttainmentPct.toFixed(1)}%
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {m.outputMassKg.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {m.rejectedQty} / {m.reworkQty}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {m.wasteKg.toFixed(1)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {m.avgYieldPct > 0 ? (
                            <span
                              className={
                                meetsTarget
                                  ? 'text-emerald-700 font-semibold'
                                  : 'text-amber-700 font-semibold'
                              }
                            >
                              {m.avgYieldPct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                          {m.weightedYieldPct > 0 ? `${m.weightedYieldPct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          {m.avgVelocityUnitsPerHr > 0 ? (
                            <div
                              className={
                                m.isBottleneck
                                  ? 'text-amber-700 font-semibold'
                                  : 'text-sky-700 font-medium'
                              }
                            >
                              {m.avgVelocityUnitsPerHr.toLocaleString()}
                              {m.isBottleneck ? ' · Slow' : ''}
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800">
                          {m.qcDecidedCount > 0 ? `${m.qcPassRatePct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-3 px-5 text-right font-mono tabular-nums text-slate-800">
                          {m.avgUnitCost > 0 ? formatCurrency(m.avgUnitCost) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-[#F7F8FA] border-t border-slate-200 text-xs font-semibold text-slate-900">
                    <td className="py-3 px-5">Period Total / Average</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.totalBatches} ({report.summary.completedOrClosedBatches})
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.totalPlannedQty.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.totalGoodQty.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.planAttainmentPct.toFixed(1)}%
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.totalOutputMassKg.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.totalRejectedQty} / {report.summary.totalReworkQty}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.totalWasteKg.toFixed(1)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.avgYieldPct > 0
                        ? `${report.summary.avgYieldPct.toFixed(1)}%`
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.weightedYieldPct > 0
                        ? `${report.summary.weightedYieldPct.toFixed(1)}%`
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-sky-700">
                      {report.summary.avgVelocityUnitsPerHr > 0
                        ? report.summary.avgVelocityUnitsPerHr.toLocaleString()
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {report.summary.qcDecidedCount > 0
                        ? `${report.summary.qcPassRatePct.toFixed(1)}%`
                        : '—'}
                    </td>
                    <td className="py-3 px-5 text-right font-mono tabular-nums">
                      {report.summary.avgUnitCost > 0
                        ? formatCurrency(report.summary.avgUnitCost)
                        : '—'}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* Filtered Job Order Detail Table */}
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Filtered Job Order Production Detail
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {report.rows.length} job order{report.rows.length === 1 ? '' : 's'} contributing to monthly KPI yield &amp; output totals
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-5">Month</th>
                    <th className="py-2.5 px-4">Batch / Lot</th>
                    <th className="py-2.5 px-4">Product &amp; Category</th>
                    <th className="py-2.5 px-4">Line</th>
                    <th className="py-2.5 px-4 text-right">Planned</th>
                    <th className="py-2.5 px-4 text-right">Good Output</th>
                    <th className="py-2.5 px-4 text-right">Mass (kg)</th>
                    <th className="py-2.5 px-4 text-right">KPI Yield %</th>
                    <th className="py-2.5 px-4">Status / QC</th>
                    <th className="py-2.5 px-5 text-right" data-print-hide="true">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {report.rows.map(({ batch, monthLabel, yearMonth, category, outputMassKg }) => (
                    <tr key={batch.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-5">
                        <div className="text-xs font-medium text-slate-900">{monthLabel}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {batch.plannedDate || yearMonth}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-mono text-xs font-semibold text-slate-900">
                          {batch.batchNumber}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {batch.lotNumber || 'Pending lot'}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{batch.productName}</div>
                        <div className="text-xs text-slate-500">
                          {batch.sku} · {category}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">{batch.lineName}</td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {batch.plannedQty.toLocaleString()} {batch.outputUnit}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                        {batch.goodQty.toLocaleString()} {batch.outputUnit}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {outputMassKg > 0 ? outputMassKg.toLocaleString() : '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        {batch.yieldPct > 0 ? (
                          <span
                            className={
                              batch.yieldPct >= DEFAULT_KPI_YIELD_TARGET_PCT
                                ? 'text-emerald-700 font-semibold'
                                : 'text-amber-700 font-semibold'
                            }
                          >
                            {batch.yieldPct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <div
                          className={`font-medium ${
                            batch.status === 'Closed' || batch.status === 'Completed'
                              ? 'text-emerald-700'
                              : batch.status === 'QC Hold'
                                ? 'text-amber-700'
                                : 'text-slate-700'
                          }`}
                        >
                          {batch.status} · QC {batch.qcStatus}
                        </div>
                      </td>
                      <td className="py-3 px-5 text-right" data-print-hide="true">
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
        </>
      )}
    </div>
  );
}
