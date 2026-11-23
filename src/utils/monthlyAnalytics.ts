import type {
  BatchCheckSpec,
  BatchStatus,
  FormulaBOM,
  ProductionBatch,
  ProductionLineMachine,
} from '../types';

export const DEFAULT_KPI_YIELD_TARGET_PCT = 96.5;

export type MonthlyStatusScope =
  | 'ALL'
  | 'COMPLETED_CLOSED'
  | 'CLOSED_ONLY'
  | 'ACTIVE_IN_PROCESS'
  | 'QC_HOLD';

export type MonthlyChartMetricMode =
  | 'output_yield'
  | 'mass_waste'
  | 'quality_plan'
  | 'velocity_bottleneck';

export interface MonthlyReportFilters {
  year: string;
  month: string;
  lineName: string;
  category: string;
  sku: string;
  statusScope: MonthlyStatusScope;
  search: string;
}

export const DEFAULT_MONTHLY_REPORT_FILTERS: MonthlyReportFilters = {
  year: 'ALL',
  month: 'ALL',
  lineName: 'ALL',
  category: 'ALL',
  sku: 'ALL',
  statusScope: 'ALL',
  search: '',
};

export interface MonthlyProductionBucket {
  yearMonth: string;
  label: string;
  totalBatches: number;
  completedBatches: number;
  closedBatches: number;
  qcHoldBatches: number;
  plannedQty: number;
  goodQty: number;
  rejectedQty: number;
  reworkQty: number;
  rejectPlusReworkQty: number;
  sampleQty: number;
  byProductQty: number;
  outputMassKg: number;
  wasteKg: number;
  planAttainmentPct: number;
  scoredBatchCount: number;
  avgYieldPct: number;
  weightedYieldPct: number;
  yieldVarianceAvgPct: number;
  targetYieldPct: number;
  targetAttainmentPct: number;
  qcDecidedCount: number;
  qcPassedCount: number;
  qcPassRatePct: number;
  totalProductionCost: number;
  avgUnitCost: number;
  velocityBatchCount: number;
  totalRunHours: number;
  avgCycleTimeHrs: number;
  avgVelocityUnitsPerHr: number;
  targetVelocityUnitsPerHr: number;
  velocityVariancePct: number;
  isBottleneck: boolean;
}

export interface MonthlyDimensionBreakdown {
  key: string;
  label: string;
  sublabel?: string;
  batchCount: number;
  plannedQty: number;
  goodQty: number;
  rejectedQty: number;
  reworkQty: number;
  outputMassKg: number;
  wasteKg: number;
  avgYieldPct: number;
  planAttainmentPct: number;
  qcPassRatePct: number;
  velocityBatchCount: number;
  avgCycleTimeHrs: number;
  avgVelocityUnitsPerHr: number;
  targetVelocityUnitsPerHr: number;
  velocityVariancePct: number;
  isBottleneck: boolean;
}

export interface MonthlyBatchDetailRow {
  batch: ProductionBatch;
  yearMonth: string;
  monthLabel: string;
  category: string;
  outputMassKg: number;
  planAttainmentPct: number;
  runHours: number | null;
  targetRunHours: number | null;
  velocityUnitsPerHr: number | null;
}

export interface MonthlyReportSummary {
  totalBatches: number;
  completedOrClosedBatches: number;
  activeBatches: number;
  qcHoldBatches: number;
  totalPlannedQty: number;
  totalGoodQty: number;
  totalRejectedQty: number;
  totalReworkQty: number;
  totalSampleQty: number;
  totalOutputMassKg: number;
  totalWasteKg: number;
  avgYieldPct: number;
  weightedYieldPct: number;
  yieldGapToTargetPct: number;
  targetYieldPct: number;
  targetAttainmentPct: number;
  planAttainmentPct: number;
  qcDecidedCount: number;
  qcPassedCount: number;
  qcPassRatePct: number;
  totalProductionCost: number;
  avgUnitCost: number;
  velocityBatchCount: number;
  totalRunHours: number;
  avgCycleTimeHrs: number;
  avgVelocityUnitsPerHr: number;
  targetVelocityUnitsPerHr: number;
  velocityVariancePct: number;
  bottleneckCount: number;
  slowestLineName: string | null;
}

export interface MonthlyProductionReportData {
  summary: MonthlyReportSummary;
  months: MonthlyProductionBucket[];
  byLine: MonthlyDimensionBreakdown[];
  byProduct: MonthlyDimensionBreakdown[];
  rows: MonthlyBatchDetailRow[];
}

export interface MonthlyFilterOptions {
  years: string[];
  months: { value: string; label: string }[];
  lines: string[];
  categories: string[];
  skus: { sku: string; productName: string }[];
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round1(val: number): number {
  return Number.isFinite(val) ? Number(val.toFixed(1)) : 0;
}

function round2(val: number): number {
  return Number.isFinite(val) ? Number(val.toFixed(2)) : 0;
}

export function extractYearMonthFromRaw(raw: string | Date | undefined | null): string | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  const str = String(raw).trim();
  const match = str.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const monthNum = Number(match[2]);
  if (monthNum < 1 || monthNum > 12) return null;
  return `${match[1]}-${match[2]}`;
}

export function resolveBatchYearMonth(batch: ProductionBatch): string {
  return (
    extractYearMonthFromRaw(batch.actualEndAt) ||
    extractYearMonthFromRaw(batch.plannedDate) ||
    extractYearMonthFromRaw(batch.createdAt) ||
    'Unknown'
  );
}

export function formatYearMonthLabel(yearMonth: string): string {
  const match = yearMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return yearMonth;
  const idx = Number(match[2]) - 1;
  const monthName = MONTH_ABBR[idx] || match[2];
  return `${monthName} ${match[1]}`;
}

export function resolveBatchCategory(
  batch: ProductionBatch,
  formulaById: Map<string, FormulaBOM>,
  specByBatchId?: Map<string, BatchCheckSpec>
): string {
  const formula = formulaById.get(batch.formulaId);
  if (formula?.category && formula.category.trim()) {
    return formula.category.trim();
  }
  const spec = specByBatchId?.get(batch.id);
  if (spec?.productCategory && spec.productCategory.trim()) {
    return spec.productCategory.trim();
  }
  const combined = `${batch.productName} ${batch.sku}`.toLowerCase();
  if (
    combined.includes('powder') ||
    combined.includes('matcha') ||
    combined.includes('mix') ||
    combined.includes('dry') ||
    combined.includes('pwd')
  ) {
    return 'Powder';
  }
  if (
    combined.includes('syrup') ||
    combined.includes('sweetener') ||
    combined.includes('caramel') ||
    combined.includes('vanilla') ||
    combined.includes('honey') ||
    combined.includes('syr')
  ) {
    return 'Syrup';
  }
  return 'Sauce';
}

export function resolveBatchOutputMassKg(
  batch: ProductionBatch,
  formula?: FormulaBOM
): number {
  if (batch.outputMassQty != null && Number.isFinite(batch.outputMassQty) && batch.outputMassQty > 0) {
    const unit = (batch.outputMassUnit || 'kg').trim().toLowerCase();
    if (unit === 'g' || unit === 'ml') {
      return round2(batch.outputMassQty / 1000);
    }
    return round2(batch.outputMassQty);
  }
  if (batch.goodQty > 0) {
    const unitRaw = (batch.outputUnit || '').trim().toLowerCase();
    if (unitRaw === 'kg' || unitRaw === 'l') {
      return round2(batch.goodQty);
    }
    if (unitRaw === 'g' || unitRaw === 'ml') {
      return round2(batch.goodQty / 1000);
    }
    const packStr = (batch.packSize || formula?.packSize || '').toLowerCase();
    const match = packStr.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/);
    if (match) {
      const amt = Number(match[1]);
      const u = match[2];
      if (Number.isFinite(amt) && amt > 0) {
        const unitKg = u === 'kg' || u === 'l' ? amt : amt / 1000;
        return round2(batch.goodQty * unitKg);
      }
    }
  }
  return 0;
}

function parseTimestampMs(raw?: string | null): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Normalize "YYYY-MM-DD HH:mm(:ss)?" to ISO-like format for consistent cross-runtime parsing
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)
    ? trimmed.replace(/\s+/, 'T')
    : trimmed;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveBatchVelocityMetrics(
  batch: ProductionBatch,
  formula?: FormulaBOM
): {
  runHours: number | null;
  targetRunHours: number | null;
  velocityUnitsPerHr: number | null;
} {
  const actualStartMs = parseTimestampMs(batch.actualStartAt);
  const actualEndMs = parseTimestampMs(batch.actualEndAt);
  const actualWindowHours =
    actualStartMs !== null && actualEndMs !== null && actualEndMs > actualStartMs
      ? (actualEndMs - actualStartMs) / 3_600_000
      : null;

  const plannedStartMs = parseTimestampMs(batch.plannedStartAt);
  const plannedEndMs = parseTimestampMs(batch.plannedEndAt);
  const plannedWindowHours =
    plannedStartMs !== null && plannedEndMs !== null && plannedEndMs > plannedStartMs
      ? (plannedEndMs - plannedStartMs) / 3_600_000
      : null;

  const processCheckMin = (batch.processChecks || []).reduce(
    (acc, c) => acc + (Number.isFinite(c.durationMin) && c.durationMin > 0 ? c.durationMin : 0),
    0
  );
  const formulaRoutingMin = (formula?.routingSteps || []).reduce(
    (acc, s) =>
      acc + (Number.isFinite(s.targetDurationMin) && s.targetDurationMin > 0 ? s.targetDurationMin : 0),
    0
  );

  const targetRunHours =
    plannedWindowHours && plannedWindowHours > 0 && plannedWindowHours <= 720
      ? plannedWindowHours
      : formulaRoutingMin > 0
        ? formulaRoutingMin / 60
        : null;

  let runHours: number | null = null;
  if (actualWindowHours && actualWindowHours > 0 && actualWindowHours <= 720) {
    runHours = actualWindowHours;
  } else if (processCheckMin > 0 || formulaRoutingMin > 0) {
    runHours = Math.max(processCheckMin, formulaRoutingMin) / 60;
  } else if (plannedWindowHours && plannedWindowHours > 0 && plannedWindowHours <= 720) {
    runHours = plannedWindowHours;
  }

  const velocityUnitsPerHr =
    batch.goodQty > 0 && runHours !== null && runHours > 0
      ? round1(batch.goodQty / runHours)
      : null;

  return {
    runHours: runHours !== null ? round2(runHours) : null,
    targetRunHours: targetRunHours !== null ? round2(targetRunHours) : null,
    velocityUnitsPerHr,
  };
}

export function matchesStatusScope(status: BatchStatus, scope: MonthlyStatusScope): boolean {
  switch (scope) {
    case 'ALL':
      return true;
    case 'COMPLETED_CLOSED':
      return status === 'Completed' || status === 'Closed';
    case 'CLOSED_ONLY':
      return status === 'Closed';
    case 'ACTIVE_IN_PROCESS':
      return status === 'Planned' || status === 'Released' || status === 'In Progress' || status === 'QC Review';
    case 'QC_HOLD':
      return status === 'QC Hold';
    default:
      return true;
  }
}

export function extractMonthlyFilterOptions(
  batches: ProductionBatch[],
  formulas: FormulaBOM[],
  productCategories: string[] = [],
  productionLines: ProductionLineMachine[] = [],
  batchCheckSpecs: BatchCheckSpec[] = []
): MonthlyFilterOptions {
  const formulaById = new Map(formulas.map((f) => [f.id, f]));
  const specByBatchId = new Map<string, BatchCheckSpec>();
  for (const spec of batchCheckSpecs) {
    if (spec.batchId) specByBatchId.set(spec.batchId, spec);
  }

  const yearSet = new Set<string>();
  const monthSet = new Set<string>();
  const lineSet = new Set<string>(productionLines.map((l) => l.lineName).filter(Boolean));
  const categorySet = new Set<string>(productCategories.filter(Boolean));
  const skuMap = new Map<string, string>();

  for (const f of formulas) {
    if (f.category) categorySet.add(f.category);
    if (f.sku && !skuMap.has(f.sku)) {
      skuMap.set(f.sku, f.productName);
    }
  }

  for (const b of batches) {
    const ym = resolveBatchYearMonth(b);
    if (ym !== 'Unknown') {
      monthSet.add(ym);
      yearSet.add(ym.slice(0, 4));
    }
    if (b.lineName) lineSet.add(b.lineName);
    categorySet.add(resolveBatchCategory(b, formulaById, specByBatchId));
    if (b.sku) skuMap.set(b.sku, b.productName);
  }

  const years = Array.from(yearSet).sort((a, b) => b.localeCompare(a));
  const months = Array.from(monthSet)
    .sort((a, b) => a.localeCompare(b))
    .map((m) => ({ value: m, label: formatYearMonthLabel(m) }));
  const lines = Array.from(lineSet).sort((a, b) => a.localeCompare(b));
  const categories = Array.from(categorySet).sort((a, b) => a.localeCompare(b));
  const skus = Array.from(skuMap.entries())
    .map(([sku, productName]) => ({ sku, productName }))
    .sort((a, b) => a.sku.localeCompare(b.sku));

  return { years, months, lines, categories, skus };
}

function accumulateDimensionMetrics(
  items: MonthlyBatchDetailRow[],
  getKey: (row: MonthlyBatchDetailRow) => { key: string; label: string; sublabel?: string },
  baselineAvgVelocity: number = 0
): MonthlyDimensionBreakdown[] {
  const map = new Map<
    string,
    {
      label: string;
      sublabel?: string;
      rows: MonthlyBatchDetailRow[];
    }
  >();

  for (const row of items) {
    const desc = getKey(row);
    const existing = map.get(desc.key);
    if (existing) {
      existing.rows.push(row);
    } else {
      map.set(desc.key, {
        label: desc.label,
        sublabel: desc.sublabel,
        rows: [row],
      });
    }
  }

  const breakdowns: MonthlyDimensionBreakdown[] = [];
  for (const [key, group] of map.entries()) {
    let plannedQty = 0;
    let goodQty = 0;
    let rejectedQty = 0;
    let reworkQty = 0;
    let outputMassKg = 0;
    let wasteKg = 0;
    let yieldSum = 0;
    let scoredCount = 0;
    let qcDecided = 0;
    let qcPassed = 0;
    let velGoodQty = 0;
    let velRunHours = 0;
    let velBatchCount = 0;
    let velPlannedQty = 0;
    let velTargetHours = 0;

    for (const r of group.rows) {
      const b = r.batch;
      plannedQty += b.plannedQty || 0;
      goodQty += b.goodQty || 0;
      rejectedQty += b.rejectedQty || 0;
      reworkQty += b.reworkQty || 0;
      outputMassKg += r.outputMassKg;
      wasteKg += b.wasteKg || 0;
      if (b.yieldPct > 0) {
        yieldSum += b.yieldPct;
        scoredCount += 1;
      }
      if (b.qcStatus === 'Passed' || b.qcStatus === 'Failed' || b.qcStatus === 'Hold') {
        qcDecided += 1;
        if (b.qcStatus === 'Passed') qcPassed += 1;
      }
      if (b.goodQty > 0 && r.runHours !== null && r.runHours > 0) {
        velBatchCount += 1;
        velGoodQty += b.goodQty;
        velRunHours += r.runHours;
        if (b.plannedQty > 0 && r.targetRunHours !== null && r.targetRunHours > 0) {
          velPlannedQty += b.plannedQty;
          velTargetHours += r.targetRunHours;
        }
      }
    }

    const avgVelocityUnitsPerHr = velRunHours > 0 ? round1(velGoodQty / velRunHours) : 0;
    const targetVelocityUnitsPerHr =
      velTargetHours > 0 ? round1(velPlannedQty / velTargetHours) : 0;
    const velocityVariancePct =
      targetVelocityUnitsPerHr > 0 && avgVelocityUnitsPerHr > 0
        ? round1(
            ((avgVelocityUnitsPerHr - targetVelocityUnitsPerHr) / targetVelocityUnitsPerHr) * 100
          )
        : 0;
    const isBottleneck =
      avgVelocityUnitsPerHr > 0 &&
      ((targetVelocityUnitsPerHr > 0 && velocityVariancePct <= -10) ||
        (baselineAvgVelocity > 0 && avgVelocityUnitsPerHr < baselineAvgVelocity * 0.9));

    breakdowns.push({
      key,
      label: group.label,
      sublabel: group.sublabel,
      batchCount: group.rows.length,
      plannedQty: round1(plannedQty),
      goodQty: round1(goodQty),
      rejectedQty: round1(rejectedQty),
      reworkQty: round1(reworkQty),
      outputMassKg: round1(outputMassKg),
      wasteKg: round1(wasteKg),
      avgYieldPct: scoredCount > 0 ? round1(yieldSum / scoredCount) : 0,
      planAttainmentPct: plannedQty > 0 ? round1((goodQty / plannedQty) * 100) : 0,
      qcPassRatePct: qcDecided > 0 ? round1((qcPassed / qcDecided) * 100) : 0,
      velocityBatchCount: velBatchCount,
      avgCycleTimeHrs: velBatchCount > 0 ? round2(velRunHours / velBatchCount) : 0,
      avgVelocityUnitsPerHr,
      targetVelocityUnitsPerHr,
      velocityVariancePct,
      isBottleneck,
    });
  }

  return breakdowns.sort((a, b) => b.goodQty - a.goodQty || a.label.localeCompare(b.label));
}

export function buildMonthlyProductionReport(
  batches: ProductionBatch[],
  formulas: FormulaBOM[],
  filters: MonthlyReportFilters = DEFAULT_MONTHLY_REPORT_FILTERS,
  batchCheckSpecs: BatchCheckSpec[] = [],
  targetYieldPct: number = DEFAULT_KPI_YIELD_TARGET_PCT
): MonthlyProductionReportData {
  const formulaById = new Map(formulas.map((f) => [f.id, f]));
  const specByBatchId = new Map<string, BatchCheckSpec>();
  for (const spec of batchCheckSpecs) {
    if (spec.batchId) specByBatchId.set(spec.batchId, spec);
  }

  const normalizedSearch = filters.search.trim().toLowerCase();

  const filteredRows: MonthlyBatchDetailRow[] = [];
  for (const batch of batches) {
    const yearMonth = resolveBatchYearMonth(batch);
    const category = resolveBatchCategory(batch, formulaById, specByBatchId);

    if (filters.year !== 'ALL' && !yearMonth.startsWith(`${filters.year}-`)) {
      continue;
    }
    if (filters.month !== 'ALL' && yearMonth !== filters.month) {
      continue;
    }
    if (filters.lineName !== 'ALL' && batch.lineName !== filters.lineName) {
      continue;
    }
    if (
      filters.category !== 'ALL' &&
      category.toLowerCase() !== filters.category.toLowerCase()
    ) {
      continue;
    }
    if (filters.sku !== 'ALL' && batch.sku !== filters.sku) {
      continue;
    }
    if (!matchesStatusScope(batch.status, filters.statusScope)) {
      continue;
    }
    if (normalizedSearch) {
      const hay = [
        batch.batchNumber,
        batch.lotNumber,
        batch.sku,
        batch.productName,
        batch.lineName,
        category,
        batch.qcInspector,
        batch.sourceRef,
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(normalizedSearch)) continue;
    }

    const formula = formulaById.get(batch.formulaId);
    const outputMassKg = resolveBatchOutputMassKg(batch, formula);
    const planAttainmentPct =
      batch.plannedQty > 0 ? round1((batch.goodQty / batch.plannedQty) * 100) : 0;
    const velocity = resolveBatchVelocityMetrics(batch, formula);

    filteredRows.push({
      batch,
      yearMonth,
      monthLabel: formatYearMonthLabel(yearMonth),
      category,
      outputMassKg,
      planAttainmentPct,
      runHours: velocity.runHours,
      targetRunHours: velocity.targetRunHours,
      velocityUnitsPerHr: velocity.velocityUnitsPerHr,
    });
  }

  filteredRows.sort((a, b) => {
    const dateCmp = b.yearMonth.localeCompare(a.yearMonth);
    if (dateCmp !== 0) return dateCmp;
    return b.batch.plannedDate.localeCompare(a.batch.plannedDate) ||
      b.batch.batchNumber.localeCompare(a.batch.batchNumber);
  });

  const monthGroups = new Map<string, MonthlyBatchDetailRow[]>();
  for (const row of filteredRows) {
    const list = monthGroups.get(row.yearMonth);
    if (list) list.push(row);
    else monthGroups.set(row.yearMonth, [row]);
  }

  const sortedMonthKeys = Array.from(monthGroups.keys()).sort((a, b) => {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return a.localeCompare(b);
  });

  const months: MonthlyProductionBucket[] = [];

  for (const ym of sortedMonthKeys) {
    const groupRows = monthGroups.get(ym) || [];
    let completedBatches = 0;
    let closedBatches = 0;
    let qcHoldBatches = 0;
    let plannedQty = 0;
    let goodQty = 0;
    let rejectedQty = 0;
    let reworkQty = 0;
    let sampleQty = 0;
    let byProductQty = 0;
    let outputMassKg = 0;
    let wasteKg = 0;

    let scoredBatchCount = 0;
    let yieldSum = 0;
    let yieldVarianceSum = 0;
    let scoredPlannedQty = 0;
    let scoredGoodQty = 0;
    let targetMetCount = 0;

    let qcDecidedCount = 0;
    let qcPassedCount = 0;

    let totalProductionCost = 0;
    let unitCostCount = 0;
    let unitCostSum = 0;

    let velocityBatchCount = 0;
    let velGoodQty = 0;
    let velRunHours = 0;
    let velPlannedQty = 0;
    let velTargetHours = 0;

    for (const r of groupRows) {
      const b = r.batch;
      if (b.status === 'Completed') completedBatches += 1;
      if (b.status === 'Closed') closedBatches += 1;
      if (b.status === 'QC Hold') qcHoldBatches += 1;

      plannedQty += b.plannedQty || 0;
      goodQty += b.goodQty || 0;
      rejectedQty += b.rejectedQty || 0;
      reworkQty += b.reworkQty || 0;
      sampleQty += b.sampleQty || 0;
      byProductQty += b.byProductQty || 0;
      outputMassKg += r.outputMassKg;
      wasteKg += b.wasteKg || 0;

      if (b.yieldPct > 0) {
        scoredBatchCount += 1;
        yieldSum += b.yieldPct;
        yieldVarianceSum += b.variancePct || 0;
        scoredPlannedQty += b.plannedQty || 0;
        scoredGoodQty += b.goodQty || 0;
        if (b.yieldPct >= targetYieldPct) {
          targetMetCount += 1;
        }
      }

      if (b.qcStatus === 'Passed' || b.qcStatus === 'Failed' || b.qcStatus === 'Hold') {
        qcDecidedCount += 1;
        if (b.qcStatus === 'Passed') qcPassedCount += 1;
      }

      const batchCost = (b.materialCost || 0) + (b.laborCost || 0) + (b.overheadCost || 0);
      totalProductionCost += batchCost;
      if (b.unitCost > 0) {
        unitCostCount += 1;
        unitCostSum += b.unitCost;
      }

      if (b.goodQty > 0 && r.runHours !== null && r.runHours > 0) {
        velocityBatchCount += 1;
        velGoodQty += b.goodQty;
        velRunHours += r.runHours;
        if (b.plannedQty > 0 && r.targetRunHours !== null && r.targetRunHours > 0) {
          velPlannedQty += b.plannedQty;
          velTargetHours += r.targetRunHours;
        }
      }
    }

    const avgYieldPct = scoredBatchCount > 0 ? round1(yieldSum / scoredBatchCount) : 0;
    const weightedYieldPct =
      scoredPlannedQty > 0 ? round1((scoredGoodQty / scoredPlannedQty) * 100) : avgYieldPct;
    const yieldVarianceAvgPct =
      scoredBatchCount > 0 ? round1(yieldVarianceSum / scoredBatchCount) : 0;
    const targetAttainmentPct =
      scoredBatchCount > 0 ? round1((targetMetCount / scoredBatchCount) * 100) : 0;
    const planAttainmentPct = plannedQty > 0 ? round1((goodQty / plannedQty) * 100) : 0;
    const qcPassRatePct =
      qcDecidedCount > 0 ? round1((qcPassedCount / qcDecidedCount) * 100) : 0;
    const avgUnitCost = unitCostCount > 0 ? round2(unitCostSum / unitCostCount) : 0;
    const avgVelocityUnitsPerHr = velRunHours > 0 ? round1(velGoodQty / velRunHours) : 0;
    const targetVelocityUnitsPerHr =
      velTargetHours > 0 ? round1(velPlannedQty / velTargetHours) : 0;
    const velocityVariancePct =
      targetVelocityUnitsPerHr > 0 && avgVelocityUnitsPerHr > 0
        ? round1(
            ((avgVelocityUnitsPerHr - targetVelocityUnitsPerHr) / targetVelocityUnitsPerHr) * 100
          )
        : 0;

    months.push({
      yearMonth: ym,
      label: formatYearMonthLabel(ym),
      totalBatches: groupRows.length,
      completedBatches,
      closedBatches,
      qcHoldBatches,
      plannedQty: round1(plannedQty),
      goodQty: round1(goodQty),
      rejectedQty: round1(rejectedQty),
      reworkQty: round1(reworkQty),
      rejectPlusReworkQty: round1(rejectedQty + reworkQty),
      sampleQty: round1(sampleQty),
      byProductQty: round1(byProductQty),
      outputMassKg: round1(outputMassKg),
      wasteKg: round1(wasteKg),
      planAttainmentPct,
      scoredBatchCount,
      avgYieldPct,
      weightedYieldPct,
      yieldVarianceAvgPct,
      targetYieldPct,
      targetAttainmentPct,
      qcDecidedCount,
      qcPassedCount,
      qcPassRatePct,
      totalProductionCost: round2(totalProductionCost),
      avgUnitCost,
      velocityBatchCount,
      totalRunHours: round2(velRunHours),
      avgCycleTimeHrs: velocityBatchCount > 0 ? round2(velRunHours / velocityBatchCount) : 0,
      avgVelocityUnitsPerHr,
      targetVelocityUnitsPerHr,
      velocityVariancePct,
      isBottleneck: false,
    });
  }

  let totalCompletedOrClosed = 0;
  let totalActive = 0;
  let totalQcHold = 0;
  let totalPlannedQty = 0;
  let totalGoodQty = 0;
  let totalRejectedQty = 0;
  let totalReworkQty = 0;
  let totalSampleQty = 0;
  let totalOutputMassKg = 0;
  let totalWasteKg = 0;
  let sumYield = 0;
  let totalScoredCount = 0;
  let sumScoredPlanned = 0;
  let sumScoredGood = 0;
  let sumTargetMet = 0;
  let sumQcDecided = 0;
  let sumQcPassed = 0;
  let sumCost = 0;
  let sumUnitCost = 0;
  let unitCostRows = 0;

  let totalVelBatchCount = 0;
  let totalVelGoodQty = 0;
  let totalVelRunHours = 0;
  let totalVelPlannedQty = 0;
  let totalVelTargetHours = 0;

  for (const r of filteredRows) {
    const b = r.batch;
    if (b.status === 'Completed' || b.status === 'Closed') totalCompletedOrClosed += 1;
    else totalActive += 1;
    if (b.status === 'QC Hold') totalQcHold += 1;

    totalPlannedQty += b.plannedQty || 0;
    totalGoodQty += b.goodQty || 0;
    totalRejectedQty += b.rejectedQty || 0;
    totalReworkQty += b.reworkQty || 0;
    totalSampleQty += b.sampleQty || 0;
    totalOutputMassKg += r.outputMassKg;
    totalWasteKg += b.wasteKg || 0;

    if (b.yieldPct > 0) {
      totalScoredCount += 1;
      sumYield += b.yieldPct;
      sumScoredPlanned += b.plannedQty || 0;
      sumScoredGood += b.goodQty || 0;
      if (b.yieldPct >= targetYieldPct) sumTargetMet += 1;
    }

    if (b.qcStatus === 'Passed' || b.qcStatus === 'Failed' || b.qcStatus === 'Hold') {
      sumQcDecided += 1;
      if (b.qcStatus === 'Passed') sumQcPassed += 1;
    }

    sumCost += (b.materialCost || 0) + (b.laborCost || 0) + (b.overheadCost || 0);
    if (b.unitCost > 0) {
      unitCostRows += 1;
      sumUnitCost += b.unitCost;
    }

    if (b.goodQty > 0 && r.runHours !== null && r.runHours > 0) {
      totalVelBatchCount += 1;
      totalVelGoodQty += b.goodQty;
      totalVelRunHours += r.runHours;
      if (b.plannedQty > 0 && r.targetRunHours !== null && r.targetRunHours > 0) {
        totalVelPlannedQty += b.plannedQty;
        totalVelTargetHours += r.targetRunHours;
      }
    }
  }

  const avgYieldPct = totalScoredCount > 0 ? round1(sumYield / totalScoredCount) : 0;
  const weightedYieldPct =
    sumScoredPlanned > 0 ? round1((sumScoredGood / sumScoredPlanned) * 100) : avgYieldPct;
  const yieldGapToTargetPct =
    totalScoredCount > 0 ? round1(avgYieldPct - targetYieldPct) : 0;
  const targetAttainmentPct =
    totalScoredCount > 0 ? round1((sumTargetMet / totalScoredCount) * 100) : 0;
  const planAttainmentPct =
    totalPlannedQty > 0 ? round1((totalGoodQty / totalPlannedQty) * 100) : 0;
  const qcPassRatePct =
    sumQcDecided > 0 ? round1((sumQcPassed / sumQcDecided) * 100) : 0;

  const avgVelocityUnitsPerHr =
    totalVelRunHours > 0 ? round1(totalVelGoodQty / totalVelRunHours) : 0;
  const targetVelocityUnitsPerHr =
    totalVelTargetHours > 0 ? round1(totalVelPlannedQty / totalVelTargetHours) : 0;
  const velocityVariancePct =
    targetVelocityUnitsPerHr > 0 && avgVelocityUnitsPerHr > 0
      ? round1(
          ((avgVelocityUnitsPerHr - targetVelocityUnitsPerHr) / targetVelocityUnitsPerHr) * 100
        )
      : 0;

  for (const m of months) {
    m.isBottleneck =
      m.avgVelocityUnitsPerHr > 0 &&
      ((m.targetVelocityUnitsPerHr > 0 && m.velocityVariancePct <= -10) ||
        (avgVelocityUnitsPerHr > 0 && m.avgVelocityUnitsPerHr < avgVelocityUnitsPerHr * 0.9));
  }

  const byLine = accumulateDimensionMetrics(
    filteredRows,
    (r) => ({
      key: r.batch.lineName || 'Unassigned Line',
      label: r.batch.lineName || 'Unassigned Line',
    }),
    avgVelocityUnitsPerHr
  );

  const byProduct = accumulateDimensionMetrics(
    filteredRows,
    (r) => ({
      key: r.batch.sku || r.batch.productName,
      label: r.batch.sku || r.batch.productName,
      sublabel: r.batch.productName,
    }),
    avgVelocityUnitsPerHr
  );

  const bottleneckLines = byLine.filter((l) => l.isBottleneck);
  const scoredLines = byLine
    .filter((l) => l.avgVelocityUnitsPerHr > 0)
    .sort((a, b) => a.avgVelocityUnitsPerHr - b.avgVelocityUnitsPerHr);

  const summary: MonthlyReportSummary = {
    totalBatches: filteredRows.length,
    completedOrClosedBatches: totalCompletedOrClosed,
    activeBatches: totalActive,
    qcHoldBatches: totalQcHold,
    totalPlannedQty: round1(totalPlannedQty),
    totalGoodQty: round1(totalGoodQty),
    totalRejectedQty: round1(totalRejectedQty),
    totalReworkQty: round1(totalReworkQty),
    totalSampleQty: round1(totalSampleQty),
    totalOutputMassKg: round1(totalOutputMassKg),
    totalWasteKg: round1(totalWasteKg),
    avgYieldPct,
    weightedYieldPct,
    yieldGapToTargetPct,
    targetYieldPct,
    targetAttainmentPct,
    planAttainmentPct,
    qcDecidedCount: sumQcDecided,
    qcPassedCount: sumQcPassed,
    qcPassRatePct,
    totalProductionCost: round2(sumCost),
    avgUnitCost: unitCostRows > 0 ? round2(sumUnitCost / unitCostRows) : 0,
    velocityBatchCount: totalVelBatchCount,
    totalRunHours: round2(totalVelRunHours),
    avgCycleTimeHrs:
      totalVelBatchCount > 0 ? round2(totalVelRunHours / totalVelBatchCount) : 0,
    avgVelocityUnitsPerHr,
    targetVelocityUnitsPerHr,
    velocityVariancePct,
    bottleneckCount: bottleneckLines.length,
    slowestLineName:
      scoredLines.length > 0 && (scoredLines[0].isBottleneck || scoredLines.length > 1)
        ? scoredLines[0].label
        : null,
  };

  return {
    summary,
    months,
    byLine,
    byProduct,
    rows: filteredRows,
  };
}

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  const str = value == null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildMonthlyReportCsv(
  report: MonthlyProductionReportData,
  filters: MonthlyReportFilters
): string {
  const lines: string[] = [];
  lines.push(
    [
      'Month',
      'Month Label',
      'Total Job Orders',
      'Completed',
      'Closed',
      'QC Hold',
      'Planned Qty',
      'Good Output Qty',
      'Rejected Qty',
      'Rework Qty',
      'Sample Qty',
      'By-Product Qty',
      'Output Mass (kg)',
      'Process Waste (kg)',
      'Plan Attainment (%)',
      'Avg KPI Yield (%)',
      'Weighted KPI Yield (%)',
      'KPI Target (%)',
      'Target Attainment (%)',
      'QC Pass Rate (%)',
      'Avg Velocity (units/hr)',
      'Target Velocity (units/hr)',
      'Avg Cycle Time (hrs)',
      'Total Production Cost ($)',
      'Avg Unit Cost ($)',
    ]
      .map(escapeCsvCell)
      .join(',')
  );

  for (const m of report.months) {
    lines.push(
      [
        m.yearMonth,
        m.label,
        m.totalBatches,
        m.completedBatches,
        m.closedBatches,
        m.qcHoldBatches,
        m.plannedQty,
        m.goodQty,
        m.rejectedQty,
        m.reworkQty,
        m.sampleQty,
        m.byProductQty,
        m.outputMassKg,
        m.wasteKg,
        m.planAttainmentPct,
        m.avgYieldPct,
        m.weightedYieldPct,
        m.targetYieldPct,
        m.targetAttainmentPct,
        m.qcPassRatePct,
        m.avgVelocityUnitsPerHr,
        m.targetVelocityUnitsPerHr,
        m.avgCycleTimeHrs,
        m.totalProductionCost,
        m.avgUnitCost,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  lines.push(
    [
      'TOTAL',
      `Filter: Year=${filters.year}; Month=${filters.month}; Line=${filters.lineName}; Category=${filters.category}; SKU=${filters.sku}; Scope=${filters.statusScope}`,
      report.summary.totalBatches,
      '',
      report.summary.completedOrClosedBatches,
      report.summary.qcHoldBatches,
      report.summary.totalPlannedQty,
      report.summary.totalGoodQty,
      report.summary.totalRejectedQty,
      report.summary.totalReworkQty,
      report.summary.totalSampleQty,
      '',
      report.summary.totalOutputMassKg,
      report.summary.totalWasteKg,
      report.summary.planAttainmentPct,
      report.summary.avgYieldPct,
      report.summary.weightedYieldPct,
      report.summary.targetYieldPct,
      report.summary.targetAttainmentPct,
      report.summary.qcPassRatePct,
      report.summary.avgVelocityUnitsPerHr,
      report.summary.targetVelocityUnitsPerHr,
      report.summary.avgCycleTimeHrs,
      report.summary.totalProductionCost,
      report.summary.avgUnitCost,
    ]
      .map(escapeCsvCell)
      .join(',')
  );

  return lines.join('\r\n');
}

export interface MonthlyMomOverlayPoint {
  yearMonth: string;
  label: string;
  prevYearMonth: string | null;
  prevLabel: string | null;
  hasPrevData: boolean;
  avgYieldPct: number;
  weightedYieldPct: number;
  goodQty: number;
  rejectPlusReworkQty: number;
  outputMassKg: number;
  planAttainmentPct: number;
  qcPassRatePct: number;
  wasteKg: number;
  totalBatches: number;
  avgVelocityUnitsPerHr: number;
  targetVelocityUnitsPerHr: number;
  avgCycleTimeHrs: number;
  isBottleneck: boolean;
  prevAvgYieldPct: number | null;
  prevWeightedYieldPct: number | null;
  prevGoodQty: number | null;
  prevOutputMassKg: number | null;
  prevPlanAttainmentPct: number | null;
  prevQcPassRatePct: number | null;
  prevWasteKg: number | null;
  prevTotalBatches: number | null;
  prevAvgVelocityUnitsPerHr: number | null;
  yieldDeltaPts: number | null;
  weightedYieldDeltaPts: number | null;
  goodQtyDelta: number | null;
  goodQtyDeltaPct: number | null;
  massDeltaKg: number | null;
  qcPassDeltaPts: number | null;
  wasteDeltaKg: number | null;
  velocityDeltaUnitsPerHr: number | null;
}

export interface MonthlyDimensionMomRow {
  key: string;
  label: string;
  sublabel?: string;
  currentBatches: number;
  prevBatches: number;
  currentGoodQty: number;
  prevGoodQty: number;
  goodQtyDelta: number;
  goodQtyDeltaPct: number | null;
  currentYieldPct: number;
  prevYieldPct: number | null;
  yieldDeltaPts: number | null;
  currentMassKg: number;
  prevMassKg: number;
  currentQcPassRatePct: number;
  prevQcPassRatePct: number | null;
}

export interface MonthlyMomComparisonData {
  overlaySeries: MonthlyMomOverlayPoint[];
  availableMonthsInScope: { value: string; label: string }[];
  focusMonth: string | null;
  baselineMonth: string | null;
  focusBucket: MonthlyProductionBucket | null;
  baselineBucket: MonthlyProductionBucket | null;
  focusComparison: MonthlyMomOverlayPoint | null;
  byLineMom: MonthlyDimensionMomRow[];
  byProductMom: MonthlyDimensionMomRow[];
}

export function shiftYearMonth(yearMonth: string, deltaMonths: number): string | null {
  const match = yearMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  if (!Number.isInteger(year) || monthIdx < 0 || monthIdx > 11) return null;
  const shiftedTotal = year * 12 + monthIdx + deltaMonths;
  if (shiftedTotal < 0) return null;
  const nextYear = Math.floor(shiftedTotal / 12);
  const nextMonth = (shiftedTotal % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

function buildMomPointForPair(
  current: MonthlyProductionBucket,
  previous: MonthlyProductionBucket | null,
  expectedPrevYm: string | null
): MonthlyMomOverlayPoint {
  const hasPrevData = Boolean(previous);
  const prevYm = previous?.yearMonth ?? expectedPrevYm;
  const prevLabel = prevYm ? formatYearMonthLabel(prevYm) : null;

  const hasCurrentYield = current.scoredBatchCount > 0 && current.avgYieldPct > 0;
  const hasPrevYield = Boolean(previous && previous.scoredBatchCount > 0 && previous.avgYieldPct > 0);

  const hasCurrentWeighted = current.scoredBatchCount > 0 && current.weightedYieldPct > 0;
  const hasPrevWeighted = Boolean(
    previous && previous.scoredBatchCount > 0 && previous.weightedYieldPct > 0
  );

  const hasCurrentQc = current.qcDecidedCount > 0;
  const hasPrevQc = Boolean(previous && previous.qcDecidedCount > 0);

  const goodQtyDelta = previous ? round1(current.goodQty - previous.goodQty) : null;
  const goodQtyDeltaPct =
    previous && previous.goodQty > 0
      ? round1(((current.goodQty - previous.goodQty) / previous.goodQty) * 100)
      : null;

  return {
    yearMonth: current.yearMonth,
    label: current.label,
    prevYearMonth: prevYm,
    prevLabel,
    hasPrevData,
    avgYieldPct: current.avgYieldPct,
    weightedYieldPct: current.weightedYieldPct,
    goodQty: current.goodQty,
    rejectPlusReworkQty: current.rejectPlusReworkQty,
    outputMassKg: current.outputMassKg,
    planAttainmentPct: current.planAttainmentPct,
    qcPassRatePct: current.qcPassRatePct,
    wasteKg: current.wasteKg,
    totalBatches: current.totalBatches,
    avgVelocityUnitsPerHr: current.avgVelocityUnitsPerHr,
    targetVelocityUnitsPerHr: current.targetVelocityUnitsPerHr,
    avgCycleTimeHrs: current.avgCycleTimeHrs,
    isBottleneck: current.isBottleneck,
    prevAvgYieldPct: hasPrevYield && previous ? previous.avgYieldPct : null,
    prevWeightedYieldPct: hasPrevWeighted && previous ? previous.weightedYieldPct : null,
    prevGoodQty: previous ? previous.goodQty : null,
    prevOutputMassKg: previous ? previous.outputMassKg : null,
    prevPlanAttainmentPct: previous ? previous.planAttainmentPct : null,
    prevQcPassRatePct: hasPrevQc && previous ? previous.qcPassRatePct : null,
    prevWasteKg: previous ? previous.wasteKg : null,
    prevTotalBatches: previous ? previous.totalBatches : null,
    prevAvgVelocityUnitsPerHr:
      previous && previous.avgVelocityUnitsPerHr > 0 ? previous.avgVelocityUnitsPerHr : null,
    yieldDeltaPts:
      hasCurrentYield && hasPrevYield && previous
        ? round1(current.avgYieldPct - previous.avgYieldPct)
        : null,
    weightedYieldDeltaPts:
      hasCurrentWeighted && hasPrevWeighted && previous
        ? round1(current.weightedYieldPct - previous.weightedYieldPct)
        : null,
    goodQtyDelta,
    goodQtyDeltaPct,
    massDeltaKg: previous ? round1(current.outputMassKg - previous.outputMassKg) : null,
    qcPassDeltaPts:
      hasCurrentQc && hasPrevQc && previous
        ? round1(current.qcPassRatePct - previous.qcPassRatePct)
        : null,
    wasteDeltaKg: previous ? round1(current.wasteKg - previous.wasteKg) : null,
    velocityDeltaUnitsPerHr:
      current.avgVelocityUnitsPerHr > 0 && previous && previous.avgVelocityUnitsPerHr > 0
        ? round1(current.avgVelocityUnitsPerHr - previous.avgVelocityUnitsPerHr)
        : null,
  };
}

function mergeDimensionMom(
  currentList: MonthlyDimensionBreakdown[],
  prevList: MonthlyDimensionBreakdown[]
): MonthlyDimensionMomRow[] {
  const prevByKey = new Map(prevList.map((p) => [p.key, p]));
  const currByKey = new Map(currentList.map((c) => [c.key, c]));
  const keys = Array.from(new Set([...currByKey.keys(), ...prevByKey.keys()]));

  const rows: MonthlyDimensionMomRow[] = keys.map((key) => {
    const curr = currByKey.get(key);
    const prev = prevByKey.get(key);

    const currentGoodQty = curr?.goodQty ?? 0;
    const prevGoodQty = prev?.goodQty ?? 0;
    const goodQtyDelta = round1(currentGoodQty - prevGoodQty);
    const goodQtyDeltaPct =
      prev && prev.goodQty > 0
        ? round1(((currentGoodQty - prevGoodQty) / prev.goodQty) * 100)
        : null;

    const currentYieldPct = curr?.avgYieldPct ?? 0;
    const prevYieldPct = prev && prev.avgYieldPct > 0 ? prev.avgYieldPct : null;
    const yieldDeltaPts =
      curr && curr.avgYieldPct > 0 && prevYieldPct !== null
        ? round1(curr.avgYieldPct - prevYieldPct)
        : null;

    return {
      key,
      label: curr?.label || prev?.label || key,
      sublabel: curr?.sublabel || prev?.sublabel,
      currentBatches: curr?.batchCount ?? 0,
      prevBatches: prev?.batchCount ?? 0,
      currentGoodQty,
      prevGoodQty,
      goodQtyDelta,
      goodQtyDeltaPct,
      currentYieldPct,
      prevYieldPct,
      yieldDeltaPts,
      currentMassKg: curr?.outputMassKg ?? 0,
      prevMassKg: prev?.outputMassKg ?? 0,
      currentQcPassRatePct: curr?.qcPassRatePct ?? 0,
      prevQcPassRatePct: prev && prev.qcPassRatePct > 0 ? prev.qcPassRatePct : null,
    };
  });

  return rows.sort(
    (a, b) =>
      b.currentGoodQty - a.currentGoodQty ||
      b.prevGoodQty - a.prevGoodQty ||
      a.label.localeCompare(b.label)
  );
}

export function buildMonthlyMomComparison(
  batches: ProductionBatch[],
  formulas: FormulaBOM[],
  filters: MonthlyReportFilters = DEFAULT_MONTHLY_REPORT_FILTERS,
  batchCheckSpecs: BatchCheckSpec[] = [],
  targetYieldPct: number = DEFAULT_KPI_YIELD_TARGET_PCT,
  focusMonthOverride?: string,
  baselineMonthOverride?: string
): MonthlyMomComparisonData {
  // Build full multi-month baseline report keeping non-date filters (line, category, sku, status, search)
  const nonDateFilters: MonthlyReportFilters = {
    ...filters,
    year: 'ALL',
    month: 'ALL',
  };
  const scopeReport = buildMonthlyProductionReport(
    batches,
    formulas,
    nonDateFilters,
    batchCheckSpecs,
    targetYieldPct
  );
  const filteredReport = buildMonthlyProductionReport(
    batches,
    formulas,
    filters,
    batchCheckSpecs,
    targetYieldPct
  );

  const scopeBucketByYm = new Map<string, MonthlyProductionBucket>(
    scopeReport.months.map((m) => [m.yearMonth, m])
  );

  // Overlay each visible month with its immediate calendar previous month
  const overlaySeries: MonthlyMomOverlayPoint[] = filteredReport.months.map((current) => {
    const prevYm = shiftYearMonth(current.yearMonth, -1);
    const previous = prevYm ? scopeBucketByYm.get(prevYm) ?? null : null;
    return buildMomPointForPair(current, previous, prevYm);
  });

  const availableMonthsInScope = scopeReport.months
    .filter((m) => m.yearMonth !== 'Unknown')
    .map((m) => ({ value: m.yearMonth, label: m.label }));

  const validFilteredMonths = filteredReport.months.filter((m) => m.yearMonth !== 'Unknown');
  const defaultFocusYm =
    filters.month !== 'ALL'
      ? filters.month
      : validFilteredMonths.length > 0
        ? validFilteredMonths[validFilteredMonths.length - 1].yearMonth
        : availableMonthsInScope.length > 0
          ? availableMonthsInScope[availableMonthsInScope.length - 1].value
          : null;

  const focusMonth =
    focusMonthOverride && scopeBucketByYm.has(focusMonthOverride)
      ? focusMonthOverride
      : defaultFocusYm;

  const defaultBaselineYm = focusMonth ? shiftYearMonth(focusMonth, -1) : null;
  const baselineMonth =
    baselineMonthOverride && baselineMonthOverride !== 'AUTO'
      ? baselineMonthOverride
      : defaultBaselineYm;

  const focusBucket = focusMonth ? scopeBucketByYm.get(focusMonth) ?? null : null;
  const baselineBucket = baselineMonth ? scopeBucketByYm.get(baselineMonth) ?? null : null;
  const focusComparison = focusBucket
    ? buildMomPointForPair(focusBucket, baselineBucket, baselineMonth)
    : null;

  const focusDimReport = focusMonth
    ? buildMonthlyProductionReport(
        batches,
        formulas,
        { ...nonDateFilters, month: focusMonth },
        batchCheckSpecs,
        targetYieldPct
      )
    : null;
  const baselineDimReport =
    baselineMonth && baselineBucket
      ? buildMonthlyProductionReport(
          batches,
          formulas,
          { ...nonDateFilters, month: baselineMonth },
          batchCheckSpecs,
          targetYieldPct
        )
      : null;

  const byLineMom = mergeDimensionMom(
    focusDimReport?.byLine ?? [],
    baselineDimReport?.byLine ?? []
  );
  const byProductMom = mergeDimensionMom(
    focusDimReport?.byProduct ?? [],
    baselineDimReport?.byProduct ?? []
  );

  return {
    overlaySeries,
    availableMonthsInScope,
    focusMonth,
    baselineMonth,
    focusBucket,
    baselineBucket,
    focusComparison,
    byLineMom,
    byProductMom,
  };
}
