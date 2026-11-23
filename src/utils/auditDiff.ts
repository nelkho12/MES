export interface AuditFieldChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  // Batch Identity & Header
  batchNumber: 'Batch No.',
  lotNumber: 'Lot No.',
  formulaVersion: 'Recipe Version',
  sku: 'SKU',
  productName: 'Product',
  packSize: 'Pack Size',
  sourceType: 'Order Source',
  sourceRef: 'Source Ref',
  plannedQty: 'Planned Qty',
  outputUnit: 'Output Unit',
  plannedDate: 'Planned Date',
  lineName: 'Production Line',
  equipmentName: 'Equipment / Vessel',
  assignedTeam: 'Assigned Team',
  shift: 'Shift',
  plannedStartAt: 'Planned Start',
  plannedEndAt: 'Planned End',
  actualStartAt: 'Actual Start',
  actualEndAt: 'Actual End',
  operators: 'Operators',
  status: 'Batch Status',
  availabilityChecked: 'BOM Availability Checked',
  shortageCount: 'Material Shortages',

  // Materials (Allocation & Issue)
  materialCode: 'Material Code',
  materialName: 'Material Name',
  lotId: 'Raw Lot ID',
  allocatedQty: 'Allocated Qty',
  allocatedBy: 'Allocated By',
  allocatedAt: 'Allocated At',
  lotPoolAllocated: 'Lot Allocated Pool',
  requiredQty: 'Required Qty',
  actualQty: 'Actual Used Qty',
  unit: 'Unit',
  variancePct: 'Variance %',
  withinTolerance: 'Within Tolerance',
  cost: 'Issued Lot Cost',
  materialCost: 'Batch Material Cost',
  unitCost: 'Unit Cost',
  operator: 'Operator',
  issuedAt: 'Issued At',

  // Step 5 Process Readings
  readingSlot: 'Reading Slot',
  readingTime: 'Reading Time',
  stepNumber: 'Step #',
  stepName: 'Step Name',
  recordedTempC: 'Temp (°C)',
  recordedBrix: 'Brix (%)',
  recordedPh: 'pH',
  recordedAw: 'Water Activity (Aw)',
  recordedWeightKg: 'Weight (kg)',
  recordedWeightG: 'Weight (g)',
  recordedViscosityCp: 'Viscosity (cP)',
  recordedSpeedRpm: 'Speed (RPM)',
  recordedPressureBar: 'Pressure (bar)',
  durationMin: 'Duration (min)',
  source: 'Source',
  sensorCode: 'Sensor Code',
  withinSpec: 'Within Spec',
  outOfSpecParams: 'Out-of-Spec Params',
  deviationRecord: 'Deviation / CAPA',
  notes: 'Notes',
  recordedAt: 'Recorded At',
  batchCheckReadings: 'Category Params',
  processChecksCount: 'Readings Count',
  insertedCount: 'Inserted Readings',
  skippedManualCount: 'Preserved Manual Slots',
  skippedDuplicateCount: 'Skipped Duplicates',
  mode: 'Capture Mode',
  remainingCount: 'Remaining Readings',

  // Step 6 Output & Losses
  goodQty: 'Good Output Qty',
  outputMassQty: 'Output Mass',
  outputMassUnit: 'Mass Unit',
  rejectedQty: 'Rejected Qty',
  sampleQty: 'QC Samples',
  reworkQty: 'Rework Qty',
  byProductQty: 'By-Product Qty',
  wasteKg: 'Waste (kg)',
  lossReasonCodes: 'Loss Reason Codes',
  yieldPct: 'Yield %',

  // Steps 7–8 QC Review & Inventory
  qcStatus: 'QC Status',
  qcInspector: 'QC Inspector',
  qcNotes: 'QC Notes',
  retainedSampleQty: 'Retained Sample Qty',
  retainedSampleCode: 'Retained Sample Code',
  retainedSampleLocation: 'Retained Sample Location',
  qcInProcessSummary: 'In-Process QC Summary',
  qcFinalResults: 'Final QC Results',
  postedToInventory: 'Posted to Inventory',
  finishedGoodId: 'Finished Good ID',
  warehouseZone: 'FG Warehouse Zone',

  // Linked Batch Check Specs & Records
  batchId: 'Batch ID',
  productCategory: 'Category',
  phMin: 'pH Min',
  phMax: 'pH Max',
  awMin: 'Aw Min',
  awMax: 'Aw Max',
  brixMin: 'Brix Min',
  brixMax: 'Brix Max',
  additionalParams: 'Category Parameters',
  requirementNotes: 'Requirement Notes',
  specId: 'Batch Check Spec',
  samplingStage: 'Sampling Stage',
  measuredPh: 'Measured pH Avg',
  measuredAw: 'Measured Aw Avg',
  measuredBrix: 'Measured Brix Avg',
  phReadings: 'pH Triplicate',
  awReadings: 'Aw Triplicate',
  brixReadings: 'Brix Triplicate',
  additionalReadings: 'Category Readings',
  conditionStatus: 'Condition Status',
  inspectorName: 'Inspector',
};

export function getAuditFieldLabel(field: string): string {
  if (field.startsWith('param:')) {
    return field.slice(6);
  }
  return AUDIT_FIELD_LABELS[field] || field;
}

function normalizeForCompare(val: unknown): unknown {
  if (val === undefined) return null;
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.map(normalizeForCompare);
  }
  const obj = val as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) {
      sorted[key] = normalizeForCompare(obj[key]);
    }
  }
  return sorted;
}

export function areAuditValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

export interface ComputedFieldDiff {
  changedKeys: string[];
  changedLabels: string[];
  oldValue: Record<string, unknown>;
  newValue: Record<string, unknown>;
}

/**
 * Computes exact per-field before/after maps containing ONLY the keys whose values changed.
 */
export function computeFieldDiff(
  beforeObj: Record<string, unknown>,
  afterObj: Record<string, unknown>,
  orderedKeys?: string[]
): ComputedFieldDiff {
  const keys = orderedKeys
    ? orderedKeys
    : Array.from(new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]));

  const changedKeys: string[] = [];
  const changedLabels: string[] = [];
  const oldValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};

  for (const key of keys) {
    const prev = beforeObj[key] === undefined ? null : beforeObj[key];
    const next = afterObj[key] === undefined ? null : afterObj[key];
    if (!areAuditValuesEqual(prev, next)) {
      changedKeys.push(key);
      changedLabels.push(getAuditFieldLabel(key));
      oldValue[key] = prev;
      newValue[key] = next;
    }
  }

  return { changedKeys, changedLabels, oldValue, newValue };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

/**
 * Extracts a structured per-field list of changes from an audit log entry's
 * oldValue and newValue (supporting both new diff-only entries and legacy snapshots).
 */
export function extractAuditFieldChanges(
  oldValue: unknown,
  newValue: unknown
): AuditFieldChange[] {
  if (oldValue == null && newValue == null) return [];

  if (isPlainObject(oldValue) && isPlainObject(newValue)) {
    const keys = Array.from(new Set([...Object.keys(oldValue), ...Object.keys(newValue)]));
    const changes: AuditFieldChange[] = [];
    for (const key of keys) {
      if (key === 'parameterReadings') continue;
      const before = oldValue[key] === undefined ? null : oldValue[key];
      const after = newValue[key] === undefined ? null : newValue[key];
      if (!areAuditValuesEqual(before, after)) {
        changes.push({
          field: key,
          label: getAuditFieldLabel(key),
          before,
          after,
        });
      }
    }
    return changes;
  }

  if (oldValue == null && isPlainObject(newValue)) {
    return Object.keys(newValue)
      .filter((k) => k !== 'parameterReadings' && newValue[k] !== undefined && newValue[k] !== null && newValue[k] !== '')
      .map((key) => ({
        field: key,
        label: getAuditFieldLabel(key),
        before: null,
        after: newValue[key],
      }));
  }

  if (isPlainObject(oldValue) && newValue == null) {
    return Object.keys(oldValue)
      .filter((k) => k !== 'parameterReadings' && oldValue[k] !== undefined && oldValue[k] !== null && oldValue[k] !== '')
      .map((key) => ({
        field: key,
        label: getAuditFieldLabel(key),
        before: oldValue[key],
        after: null,
      }));
  }

  return [
    {
      field: 'value',
      label: 'Value',
      before: oldValue ?? null,
      after: newValue ?? null,
    },
  ];
}

export function formatAuditValue(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (val === '') return '(empty)';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    if (val.length === 0) return '(none)';
    return val
      .map((item) => {
        if (item == null) return '—';
        if (typeof item !== 'object') return String(item);
        const rec = item as Record<string, unknown>;
        if ('lossType' in rec && 'reasonCode' in rec) {
          return `${rec.lossType}: ${rec.quantity} ${rec.unit} [${rec.reasonCode}]`;
        }
        if ('name' in rec && 'value' in rec) {
          return `${rec.name}: ${rec.value}${rec.unit ? ` ${rec.unit}` : ''}`;
        }
        if ('name' in rec && 'minTarget' in rec) {
          return `${rec.name} [${rec.minTarget ?? '—'}–${rec.maxTarget ?? '—'}${rec.unit ? ` ${rec.unit}` : ''}]`;
        }
        if ('lotNumber' in rec && 'materialCode' in rec) {
          const qty = rec.actualQty ?? rec.allocatedQty ?? '';
          return `${rec.materialCode} (${rec.lotNumber}${qty !== '' ? ` · ${qty} ${rec.unit ?? ''}` : ''})`;
        }
        if ('readingTime' in rec || 'readingSlot' in rec) {
          return `#${rec.readingSlot ?? '?'} (${rec.readingTime ?? rec.recordedAt ?? ''})`;
        }
        return JSON.stringify(rec);
      })
      .join('; ');
  }
  if (isPlainObject(val)) {
    const entries = Object.entries(val).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '(empty)';
    return entries.map(([k, v]) => `${getAuditFieldLabel(k)}: ${formatAuditValue(v)}`).join(', ');
  }
  return String(val);
}
