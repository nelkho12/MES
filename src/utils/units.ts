import type {
  AllocatedMaterialRecord,
  FormulaBOM,
  IssuedMaterialRecord,
  ProductionBatch,
  RawMaterialLot,
  SensorStatus,
  ThermalSensor,
  UnitOfMeasure,
  YieldOptimizationRecommendation,
} from '../types';

/**
 * Centralized Unit-of-Measure conversion engine.
 * Normalizes kg/g -> g, L/ml -> ml, pcs -> pcs so mixed units never cause production errors.
 */
const UNIT_GROUP: Record<UnitOfMeasure, 'mass' | 'volume' | 'count'> = {
  kg: 'mass',
  g: 'mass',
  L: 'volume',
  ml: 'volume',
  pcs: 'count',
};

const TO_BASE_FACTOR: Record<UnitOfMeasure, number> = {
  kg: 1000,
  g: 1,
  L: 1000,
  ml: 1,
  pcs: 1,
};

export function areUnitsCompatible(from: UnitOfMeasure, to: UnitOfMeasure): boolean {
  return UNIT_GROUP[from] === UNIT_GROUP[to];
}

export function convertQuantity(
  qty: number,
  from: UnitOfMeasure,
  to: UnitOfMeasure
): number {
  if (from === to) return qty;
  if (!areUnitsCompatible(from, to)) return qty;
  const baseQty = qty * TO_BASE_FACTOR[from];
  return Number((baseQty / TO_BASE_FACTOR[to]).toFixed(4));
}

/**
 * Like convertQuantity but throws when units are not convertible (e.g. kg -> pcs),
 * instead of silently returning the unconverted number.
 */
export function convertQuantityStrict(
  qty: number,
  from: UnitOfMeasure,
  to: UnitOfMeasure
): number {
  if (!areUnitsCompatible(from, to)) {
    throw new Error(`Incompatible units: cannot convert ${from} to ${to}.`);
  }
  return convertQuantity(qty, from, to);
}

/** True when the lot is flagged Expired OR its expiry date has passed (stored status can be stale). */
export function isLotExpired(lot: { status?: string; expiryDate: string }): boolean {
  if (lot.status === 'Expired') return true;
  const todayIso = new Date().toISOString().slice(0, 10);
  return Boolean(lot.expiryDate) && lot.expiryDate < todayIso;
}

/** Quantity (in the lot's unit) that a batch has already issued from a given lot. */
export function issuedFromLotInLotUnit(
  issued: IssuedMaterialRecord[] | undefined,
  lotId: string,
  lotUnit: UnitOfMeasure
): number {
  return (issued || [])
    .filter((m) => m.lotId === lotId && areUnitsCompatible(m.unit as UnitOfMeasure, lotUnit))
    .reduce(
      (sum, m) =>
        sum + convertQuantity(Math.max(0, Number(m.actualQty) || 0), m.unit as UnitOfMeasure, lotUnit),
      0
    );
}

/**
 * Remaining reservation (lot unit) that this batch still holds on a lot:
 * what it allocated minus what it has already issued.
 */
export function ownRemainingReservation(
  allocations: AllocatedMaterialRecord[] | undefined,
  issued: IssuedMaterialRecord[] | undefined,
  lotId: string,
  lotUnit: UnitOfMeasure
): number {
  const alloc = (allocations || []).find((a) => a.lotId === lotId);
  if (!alloc || !areUnitsCompatible(alloc.unit as UnitOfMeasure, lotUnit)) return 0;
  const allocInLot = convertQuantity(
    Math.max(0, Number(alloc.allocatedQty) || 0),
    alloc.unit as UnitOfMeasure,
    lotUnit
  );
  return Math.max(0, allocInLot - issuedFromLotInLotUnit(issued, lotId, lotUnit));
}

/**
 * Next sequence number for identifiers shaped `<prefix><NNN>` (e.g. B-261123-007),
 * based on the highest existing sequence instead of a row count, so deletions or
 * other days' records never produce a repeat.
 */
export function nextSequenceFor(existingNumbers: string[], prefix: string): number {
  let max = 0;
  for (const n of existingNumbers) {
    if (!n.startsWith(prefix)) continue;
    const m = n.slice(prefix.length).match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function batchNumberPrefix(date = new Date()): string {
  const { yy, mm, dd } = plantDateParts(date);
  return `B-${yy}${mm}${dd}-`;
}

export function lotNumberPrefix(date = new Date()): string {
  const { yy, mm, dd } = plantDateParts(date);
  return `LOT-${yy}${mm}${dd}-`;
}

function plantDateParts(date: Date): { yy: string; mm: string; dd: string } {
  const tz =
    (typeof process !== 'undefined' && process.env?.PLANT_TIMEZONE) || 'Asia/Kuala_Lumpur';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return { yy: get('year').slice(-2), mm: get('month'), dd: get('day') };
}

export interface AvailabilityLine {
  materialCode: string;
  materialName: string;
  anonymizedCode: string;
  category: 'Ingredient' | 'Packaging';
  requiredQty: number;
  unit: UnitOfMeasure;
  availableQtyInBomUnit: number;
  shortageQty: number;
  matchingLots: RawMaterialLot[];
  isShort: boolean;
}

/**
 * Stock on a lot that is free for this batch: on-hand minus what OTHER batches
 * have reserved (this batch's own remaining reservation stays usable).
 */
export function freeQtyOnLot(
  lot: RawMaterialLot,
  ownAllocations: AllocatedMaterialRecord[] = [],
  ownIssued: IssuedMaterialRecord[] = []
): number {
  const pool = Math.max(0, Number(lot.quantityAllocated) || 0);
  const own = ownRemainingReservation(ownAllocations, ownIssued, lot.id, lot.unit);
  const reservedElsewhere = Math.max(0, pool - own);
  return Math.max(0, Number((lot.quantityAvailable - reservedElsewhere).toFixed(4)));
}

export function calculateBomAvailability(
  formula: FormulaBOM,
  plannedQty: number,
  rawMaterials: RawMaterialLot[],
  ownAllocations: AllocatedMaterialRecord[] = [],
  ownIssued: IssuedMaterialRecord[] = []
): AvailabilityLine[] {
  const scaleFactor =
    formula.standardBatchSize > 0 ? plannedQty / formula.standardBatchSize : 1;

  return formula.ingredients.map((ing) => {
    const requiredQty = Number((ing.quantityPerBatch * scaleFactor).toFixed(3));
    const matchingLots = rawMaterials
      .filter(
        (lot) =>
          lot.materialCode === ing.materialCode &&
          !isLotExpired(lot) &&
          lot.status !== 'Depleted' &&
          freeQtyOnLot(lot, ownAllocations, ownIssued) > 0 &&
          areUnitsCompatible(lot.unit, ing.unit)
      )
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)); // FEFO: First Expired, First Out

    const availableQtyInBomUnit = Number(
      matchingLots
        .reduce(
          (sum, lot) =>
            sum + convertQuantity(freeQtyOnLot(lot, ownAllocations, ownIssued), lot.unit, ing.unit),
          0
        )
        .toFixed(3)
    );

    const shortageQty = Number(
      Math.max(0, requiredQty - availableQtyInBomUnit).toFixed(3)
    );

    return {
      materialCode: ing.materialCode,
      materialName: ing.materialName,
      anonymizedCode: ing.anonymizedCode,
      category: ing.category,
      requiredQty,
      unit: ing.unit,
      availableQtyInBomUnit,
      shortageQty,
      matchingLots,
      isShort: shortageQty > 0.001,
    };
  });
}

export function calculateExpiryDate(productionDateIso: string, shelfLifeDays: number): string {
  const base = new Date(`${productionDateIso}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() + shelfLifeDays);
    return fallback.toISOString().slice(0, 10);
  }
  base.setUTCDate(base.getUTCDate() + shelfLifeDays);
  return base.toISOString().slice(0, 10);
}

export function generateBatchAndLotNumbers(
  sku: string,
  lineName: string,
  existingCount: number
): { batchNumber: string; lotNumber: string } {
  const { yy, mm, dd } = plantDateParts(new Date());
  const seq = String(existingCount + 1).padStart(3, '0');
  const lineCode = lineName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'L1';
  const skuCode = sku.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  return {
    batchNumber: `B-${yy}${mm}${dd}-${seq}`,
    lotNumber: `LOT-${yy}${mm}${dd}-${lineCode}-${skuCode}-${seq}`,
  };
}

export function evaluateSensorStatus(
  currentTempC: number,
  minSafeTempC: number,
  maxSafeTempC: number
): SensorStatus {
  if (currentTempC < minSafeTempC || currentTempC > maxSafeTempC) {
    return 'Excursion';
  }
  const span = Math.max(1, maxSafeTempC - minSafeTempC);
  const warningMargin = Math.min(1.5, span * 0.14);
  if (
    currentTempC <= minSafeTempC + warningMargin ||
    currentTempC >= maxSafeTempC - warningMargin
  ) {
    return 'Warning';
  }
  return 'Nominal';
}

export function deriveRawLotStatus(
  quantityAvailable: number,
  reorderLevel: number,
  expiryDate: string
): 'Available' | 'Low' | 'Depleted' | 'Expired' {
  const todayIso = new Date().toISOString().slice(0, 10);
  if (expiryDate < todayIso) return 'Expired';
  if (quantityAvailable <= 0) return 'Depleted';
  if (quantityAvailable <= reorderLevel) return 'Low';
  return 'Available';
}

export function computeYieldOptimizations(
  sensors: ThermalSensor[],
  batches: ProductionBatch[],
  rawMaterials: RawMaterialLot[]
): YieldOptimizationRecommendation[] {
  const recs: YieldOptimizationRecommendation[] = [];

  // 1. Analyze thermal drift & over-cooking moisture loss / cold-chain risk
  for (const sensor of sensors) {
    const delta = Number((sensor.currentTempC - sensor.targetTempC).toFixed(1));
    if (sensor.status === 'Excursion' || Math.abs(delta) >= 1.8) {
      const isHotProcess = sensor.targetTempC >= 50;
      const absDelta = Math.abs(delta);
      const gainPct = Number(Math.min(4.2, absDelta * (isHotProcess ? 0.65 : 0.45)).toFixed(1));
      const estSavings = Math.round(gainPct * 245);

      recs.push({
        id: `opt-sensor-${sensor.id}`,
        severity: sensor.status === 'Excursion' ? 'High' : 'Medium',
        category: 'Thermal Drift',
        title:
          isHotProcess && delta > 0
            ? `${sensor.name}: +${delta}°C overshoot driving moisture loss`
            : `${sensor.name}: ${delta > 0 ? `+${delta}` : delta}°C deviation from HACCP target`,
        detail: isHotProcess
          ? `Running at ${sensor.currentTempC.toFixed(1)}°C vs ${sensor.targetTempC.toFixed(1)}°C target on ${sensor.linkedLine || sensor.zone}. Re-centering PID setpoint recovers evaporation yield and stabilizes Brix.`
          : `Zone reading ${sensor.currentTempC.toFixed(1)}°C outside optimal band (${sensor.minSafeTempC}–${sensor.maxSafeTempC}°C). Stabilizing prevents cold-chain spoilage and QC quarantine holds.`,
        estimatedYieldGainPct: gainPct,
        estimatedSavingsPerBatch: estSavings,
        sensorId: sensor.id,
        recommendedTargetTempC: sensor.targetTempC,
      });
    }
  }

  // 2. Analyze batch ingredient weigh over-dosing & reject rates
  for (const batch of batches) {
    if (batch.status === 'Closed' || batch.status === 'Completed') {
      if (batch.yieldPct > 0 && batch.yieldPct < 94.5) {
        const rejectRate =
          batch.plannedQty > 0
            ? Number(((batch.rejectedQty / batch.plannedQty) * 100).toFixed(1))
            : 0;
        recs.push({
          id: `opt-batch-yield-${batch.id}`,
          severity: batch.yieldPct < 91 ? 'High' : 'Medium',
          category: 'Reject Rate',
          title: `${batch.batchNumber} (${batch.productName}) closed at ${batch.yieldPct.toFixed(1)}% yield`,
          detail: `Rejects (${batch.rejectedQty} ${batch.outputUnit}, ${rejectRate}%) and ${batch.wasteKg} kg process waste pushed unit cost to $${batch.unitCost.toFixed(2)}. Check filler nozzle calibration on ${batch.lineName}.`,
          estimatedYieldGainPct: Number((96.5 - batch.yieldPct).toFixed(1)),
          estimatedSavingsPerBatch: Math.round((96.5 - batch.yieldPct) * 180),
          batchId: batch.id,
        });
      }
    } else if (batch.issuedMaterials.some((m) => !m.withinTolerance)) {
      const outOfTol = batch.issuedMaterials.filter((m) => !m.withinTolerance);
      recs.push({
        id: `opt-batch-tol-${batch.id}`,
        severity: 'Medium',
        category: 'Weigh Tolerance',
        title: `${batch.batchNumber}: ${outOfTol.length} material issue(s) outside BOM tolerance`,
        detail: `${outOfTol.map((m) => `${m.materialCode} (${m.variancePct > 0 ? '+' : ''}${m.variancePct.toFixed(1)}%)`).join(', ')} exceeded tolerance. Re-zero hopper load cells before next weigh.`,
        estimatedYieldGainPct: 1.2,
        estimatedSavingsPerBatch: 210,
        batchId: batch.id,
      });
    }
  }

  // 3. Analyze expiring or low-stock raw materials impacting upcoming yield/schedule
  const lowOrExpiring = rawMaterials.filter(
    (m) => m.status === 'Low' || m.status === 'Depleted'
  );
  if (lowOrExpiring.length > 0) {
    recs.push({
      id: 'opt-inv-low',
      severity: 'Low',
      category: 'Inventory Risk',
      title: `${lowOrExpiring.length} raw material lot(s) at or below reorder threshold`,
      detail: `Lots ${lowOrExpiring.slice(0, 3).map((l) => l.lotNumber).join(', ')} risk mid-run changeovers and line flush losses. Replenish before releasing next planned run.`,
      estimatedYieldGainPct: 0.9,
      estimatedSavingsPerBatch: 165,
    });
  }

  return recs.sort((a, b) => {
    const rank = { High: 0, Medium: 1, Low: 2 };
    return rank[a.severity] - rank[b.severity];
  });
}

export function formatCurrency(val: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

export function daysUntil(dateIso: string): number {
  const target = new Date(`${dateIso}T00:00:00Z`).getTime();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}
