import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Edit3,
  FileText,
  GitBranch,
  History,
  Lock,
  Plus,
  Search,
  ShieldAlert,
  Thermometer,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ActiveTab,
  AuditLogEntry,
  BatchCheckAdditionalReading,
  BatchCheckSpec,
  BatchLossRecord,
  BatchSourceType,
  BatchStatus,
  CategoryParameterPresetMap,
  FinishedGoodLot,
  FormulaBOM,
  ProcessCheckRecord,
  ProductionBatch,
  ProductionLineMachine,
  RawMaterialLot,
  ReadingSource,
  RecipeProcessParameter,
  RolePermissionMatrix,
  SensorAdapterConfig,
  ThermalSensor,
  UserRole,
} from '../types';
import { buildDefaultRecipeProcessParameters } from '../data/seedData';
import { hasFeaturePermission } from '../services/permissions';
import {
  calculateBomAvailability,
  formatCurrency,
} from '../utils/units';
import { useSensorAdapter } from '../hooks/useSensorAdapter';
import { SensorAdapterBanner } from './SensorAdapterBanner';
import { extractAuditFieldChanges, formatAuditValue } from '../utils/auditDiff';
import {
  allocateMaterialLotToBatch,
  closeProductionBatch,
  createWorkOrder,
  deleteBatchProcessCheck,
  executeQcDecisionAndPostInventory,
  issueMaterialLotToBatch,
  recordBatchProcessCheck,
  releaseWorkOrder,
  reportBatchOutput,
  runAvailabilityCheck,
  saveBatchCheckSpec,
  startBatchQcReview,
  updateBatchHeader,
  updateBatchProcessCheck,
  updateIssuedMaterialLotInBatch,
  type ClosedBatchOverrideInput,
} from '../services/mesService';

interface BatchesViewProps {
  ownerId: string;
  operatorName: string;
  userRole: UserRole;
  rolePermissions?: RolePermissionMatrix;
  batches: ProductionBatch[];
  formulas: FormulaBOM[];
  rawMaterials: RawMaterialLot[];
  finishedGoods?: FinishedGoodLot[];
  sensors: ThermalSensor[];
  productionLines?: ProductionLineMachine[];
  batchCheckSpecs?: BatchCheckSpec[];
  categoryParameterPresets?: CategoryParameterPresetMap;
  auditLogs?: AuditLogEntry[];
  sensorConfig?: SensorAdapterConfig;
  onOpenSensorSettings?: () => void;
  selectedBatchId: string | null;
  onSelectBatch: (id: string | null) => void;
  onOpenBatchReport: (batchId: string) => void;
  onNavigate?: (tab: ActiveTab) => void;
  openCreateSignal: number;
  onNotify: (msg: string) => void;
}

const STATUS_FILTERS: ('All' | BatchStatus)[] = [
  'All',
  'Planned',
  'Released',
  'In Progress',
  'Completed',
  'QC Review',
  'QC Hold',
  'Closed',
];

const LIFECYCLE_STEPS = [
  { num: 1, label: 'Plan' },
  { num: 2, label: 'Availability' },
  { num: 3, label: 'Release' },
  { num: 4, label: 'Issue Lots' },
  { num: 5, label: 'Produce' },
  { num: 6, label: 'Output' },
  { num: 7, label: 'QC Review' },
  { num: 8, label: 'Post FG' },
  { num: 9, label: 'Close' },
];

function getLifecycleStepNumber(batch: ProductionBatch): number {
  if (batch.status === 'Closed') return 9;
  if (batch.status === 'QC Review' || batch.status === 'QC Hold') {
    return batch.postedToInventory ? 8 : 7;
  }
  if (batch.status === 'Completed') {
    return batch.postedToInventory ? 8 : 6;
  }
  if (batch.status === 'In Progress') {
    if (batch.processChecks.length > 0) return 5;
    return 4;
  }
  if (batch.status === 'Released') return 3;
  if (batch.availabilityChecked) return 2;
  return 1;
}

function getNowStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function getProcessCheckWeightKg(chk: ProcessCheckRecord): number | null {
  if (chk.recordedWeightKg !== null && chk.recordedWeightKg !== undefined) {
    return chk.recordedWeightKg;
  }
  if (chk.recordedWeightG !== null && chk.recordedWeightG !== undefined) {
    return Number((chk.recordedWeightG / 1000).toFixed(3));
  }
  return null;
}

function formatCheckRange(
  min: number | null,
  max: number | null,
  decimals = 2,
  unit = ''
): string {
  if (min === null && max === null) return 'N/A';
  const fmt = (v: number) => v.toFixed(decimals);
  if (min !== null && max !== null) return `${fmt(min)}–${fmt(max)}${unit}`;
  if (min !== null) return `>= ${fmt(min)}${unit}`;
  return `<= ${fmt(max!)}${unit}`;
}

function evalRangeStatus(
  raw: string,
  min: number | null,
  max: number | null
): 'empty' | 'ok' | 'out' {
  const trimmed = raw.trim();
  if (!trimmed) return 'empty';
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return 'out';
  if (min !== null && num < min) return 'out';
  if (max !== null && num > max) return 'out';
  return 'ok';
}

const LOSS_REASON_OPTIONS = [
  'LINE-PURGE',
  'SEAL-DEFECT',
  'UNDERWEIGHT',
  'OVERCOOK-SCORCH',
  'PUMP-RESIDUAL',
  'TRIM-BYPRODUCT',
  'REWORK-BLENDING',
  'QC-DESTRUCTIVE',
];

const DEFAULT_QC_PASS_NOTE =
  'pH, Brix, thermal lethality, and vacuum seal verified within HACCP specs.';

const QUICK_QC_DEVIATION_NOTES = [
  'Equipment delay',
  'Material variance',
  'Operator error',
  'Temperature excursion',
  'Packaging / seal defect',
  'pH / Brix out of spec',
  'Hold pending lab re-test',
  'Calibration / sensor drift',
];

interface TimeReadingDraft {
  slotNumber: number;
  readingTime: string;
  stepNumber: number;
  tempC: string;
  brix: string;
  ph: string;
  aw: string;
  weightKg: string;
  viscosityCp: string;
  speedRpm: string;
  pressureBar: string;
  source: ReadingSource;
  specParamValues: Record<string, string>;
  durationMin: string;
  sensorCode: string;
  notes: string;
  deviationRecord: string;
}

function makeNextTimeDraft(slotNumber: number): TimeReadingDraft {
  return {
    slotNumber,
    readingTime: '',
    stepNumber: slotNumber,
    tempC: '',
    brix: '',
    ph: '',
    aw: '',
    weightKg: '',
    viscosityCp: '',
    speedRpm: '',
    pressureBar: '',
    source: 'Manual',
    specParamValues: {},
    durationMin: '25',
    sensorCode: 'MANUAL',
    notes: '',
    deviationRecord: '',
  };
}

export function BatchesView({
  ownerId,
  operatorName,
  userRole,
  rolePermissions,
  batches,
  formulas,
  rawMaterials,
  finishedGoods = [],
  sensors,
  productionLines = [],
  batchCheckSpecs = [],
  categoryParameterPresets,
  auditLogs = [],
  sensorConfig,
  onOpenSensorSettings,
  selectedBatchId,
  onSelectBatch,
  onOpenBatchReport,
  onNavigate,
  openCreateSignal,
  onNotify,
}: BatchesViewProps) {
  const [statusFilter, setStatusFilter] = useState<'All' | BatchStatus>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [lastSignal, setLastSignal] = useState(openCreateSignal);
  const [busy, setBusy] = useState(false);

  if (openCreateSignal !== lastSignal) {
    setLastSignal(openCreateSignal);
    setShowCreateModal(true);
  }

  const approvedFormulas = useMemo(
    () => formulas.filter((f) => f.approvalStatus === 'Approved'),
    [formulas]
  );

  // Create job order state
  const [newFormulaId, setNewFormulaId] = useState(approvedFormulas[0]?.id || '');
  const [newPlannedQty, setNewPlannedQty] = useState('1000');
  const [newPlannedDate, setNewPlannedDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [newLineName, setNewLineName] = useState('Kettle Line 1');
  const [newEquipmentName, setNewEquipmentName] = useState('Kettle Line 1 · High-Shear Vat');
  const [newTeam, setNewTeam] = useState('Shift A · Thermal Crew');
  const [newShift, setNewShift] = useState('Shift A (06:00–14:00)');
  const [newPlannedStartAt, setNewPlannedStartAt] = useState(
    `${new Date().toISOString().slice(0, 10)} 06:30`
  );
  const [newPlannedEndAt, setNewPlannedEndAt] = useState(
    `${new Date().toISOString().slice(0, 10)} 10:30`
  );
  const [newOperatorsInput, setNewOperatorsInput] = useState(operatorName);
  const [newSourceType, setNewSourceType] = useState<BatchSourceType>('Sales Demand');
  const [newSourceRef, setNewSourceRef] = useState('SO-88620');
  const [newBatchCheckSpecId, setNewBatchCheckSpecId] = useState('');

  // Closed batch authorized override state
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  // Header edit state
  const [editingHeader, setEditingHeader] = useState(false);
  const [hdrLineName, setHdrLineName] = useState('');
  const [hdrEquipment, setHdrEquipment] = useState('');
  const [hdrPackSize, setHdrPackSize] = useState('');
  const [hdrPlannedQty, setHdrPlannedQty] = useState('');
  const [hdrPlannedDate, setHdrPlannedDate] = useState('');
  const [hdrSourceType, setHdrSourceType] = useState<BatchSourceType>('Sales Demand');
  const [hdrSourceRef, setHdrSourceRef] = useState('');
  const [hdrShift, setHdrShift] = useState('');
  const [hdrTeam, setHdrTeam] = useState('');
  const [hdrPlannedStart, setHdrPlannedStart] = useState('');
  const [hdrPlannedEnd, setHdrPlannedEnd] = useState('');
  const [hdrActualStart, setHdrActualStart] = useState('');
  const [hdrActualEnd, setHdrActualEnd] = useState('');
  const [hdrOperators, setHdrOperators] = useState('');

  // Step 4: Issue/Allocate material inline state
  const [selectedLotsByCode, setSelectedLotsByCode] = useState<Record<string, string>>({});
  const [actualQtyByCode, setActualQtyByCode] = useState<Record<string, string>>({});
  const [editingIssuedMaterialCode, setEditingIssuedMaterialCode] = useState<string | null>(null);
  const [editIssuedLotId, setEditIssuedLotId] = useState('');
  const [editIssuedQty, setEditIssuedQty] = useState('');

  // Step 5: 1-by-1 Time Reading Process Check form state
  const [readingDraft, setReadingDraft] = useState<TimeReadingDraft>(() =>
    makeNextTimeDraft(1)
  );
  const [showExtraReadingForm, setShowExtraReadingForm] = useState(false);
  const [editingCheckKey, setEditingCheckKey] = useState<string | null>(null);
  const [editCheckDraft, setEditCheckDraft] = useState<TimeReadingDraft | null>(null);
  const [confirmDeleteCheckKey, setConfirmDeleteCheckKey] = useState<string | null>(null);
  const [step5Error, setStep5Error] = useState<string | null>(null);
  const [specToLinkId, setSpecToLinkId] = useState<string>('');
  const [showSpecSwitcher, setShowSpecSwitcher] = useState(false);
  const [showOptionalStep5Metrics, setShowOptionalStep5Metrics] = useState(false);

  // Step 6: Output reporting form state
  const [editingOutput, setEditingOutput] = useState(false);
  const [outGood, setOutGood] = useState('');
  const [outMassQty, setOutMassQty] = useState('');
  const [outMassUnit, setOutMassUnit] = useState<'kg' | 'L'>('kg');
  const [outPackSize, setOutPackSize] = useState('');
  const [outRejected, setOutRejected] = useState('14');
  const [outSample, setOutSample] = useState('6');
  const [outRework, setOutRework] = useState('0');
  const [outByProduct, setOutByProduct] = useState('0');
  const [outWasteKg, setOutWasteKg] = useState('6.5');
  const [outRejectReason, setOutRejectReason] = useState('SEAL-DEFECT');
  const [outReworkReason, setOutReworkReason] = useState('REWORK-BLENDING');
  const [outByProductReason, setOutByProductReason] = useState('TRIM-BYPRODUCT');
  const [outWasteReason, setOutWasteReason] = useState('LINE-PURGE');

  // Step 7-8: QC Review form state
  const [qcNotes, setQcNotes] = useState(DEFAULT_QC_PASS_NOTE);
  const [qcInProcessSummary, setQcInProcessSummary] = useState(
    'All CCP & EBR process parameters verified within recipe limits.'
  );
  const [qcFinalResults, setQcFinalResults] = useState(
    'Microbiology: ND | Organoleptic: Pass | Seal vacuum: -62 kPa'
  );
  const [qcRetainedQty, setQcRetainedQty] = useState('2');
  const [qcRetainedCode, setQcRetainedCode] = useState('');
  const [qcRetainedLocation, setQcRetainedLocation] = useState('QC Retain Vault · Shelf A1');
  const [qcWarehouseZone, setQcWarehouseZone] = useState('FG Ambient Aisle 2');

  // Electronic Batch Audit Trail filter/search state
  const [auditFilterMode, setAuditFilterMode] = useState<'all' | 'edits' | 'overrides'>('all');
  const [auditSearchQuery, setAuditSearchQuery] = useState('');

  const filteredBatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return batches.filter((b) => {
      if (statusFilter !== 'All' && b.status !== statusFilter) return false;
      if (!q) return true;
      return (
        b.batchNumber.toLowerCase().includes(q) ||
        b.lotNumber.toLowerCase().includes(q) ||
        b.productName.toLowerCase().includes(q) ||
        b.sku.toLowerCase().includes(q) ||
        b.lineName.toLowerCase().includes(q)
      );
    });
  }, [batches, statusFilter, searchQuery]);

  const selectedBatch = useMemo(
    () => batches.find((b) => b.id === selectedBatchId) || filteredBatches[0] || null,
    [batches, selectedBatchId, filteredBatches]
  );

  const selectedFormula = useMemo(
    () => formulas.find((f) => f.id === selectedBatch?.formulaId),
    [formulas, selectedBatch]
  );

  const selectedFormulaParams: RecipeProcessParameter[] = useMemo(() => {
    if (!selectedBatch) return [];
    if (selectedFormula?.processParameters && selectedFormula.processParameters.length > 0) {
      return selectedFormula.processParameters;
    }
    const categoryKey = selectedFormula?.category;
    if (categoryKey && categoryParameterPresets?.[categoryKey]?.length) {
      return categoryParameterPresets[categoryKey];
    }
    return buildDefaultRecipeProcessParameters(
      `${selectedBatch.sku} ${selectedBatch.productName}`
    );
  }, [selectedFormula, selectedBatch, categoryParameterPresets]);

  const formulaParamMap = useMemo(() => {
    const map: Record<string, RecipeProcessParameter> = {};
    for (const p of selectedFormulaParams) {
      map[p.key] = p;
    }
    return map;
  }, [selectedFormulaParams]);

  const isClosed = selectedBatch?.status === 'Closed';
  const canAuthorizedOverride = hasFeaturePermission(
    rolePermissions,
    userRole,
    'overrideClosedBatch'
  );
  const canPlanRelease = hasFeaturePermission(
    rolePermissions,
    userRole,
    'planReleaseJobOrders'
  );
  const canExecuteBatchSteps = hasFeaturePermission(
    rolePermissions,
    userRole,
    'executeBatchSteps'
  );
  const closedOverridePayload: ClosedBatchOverrideInput | undefined =
    isClosed && canAuthorizedOverride && overrideEnabled && overrideReason.trim().length > 0
      ? { authorizedOverride: true, overrideReason: overrideReason.trim() }
      : undefined;
  const isLockedForUser = Boolean(isClosed && !closedOverridePayload);

  const selectedBatchAuditLogs = useMemo(() => {
    if (!selectedBatch) return [];
    return auditLogs.filter(
      (l) => l.batchId === selectedBatch.id || l.entityId === selectedBatch.id
    );
  }, [auditLogs, selectedBatch]);

  const linkedFinishedGood = useMemo(() => {
    if (!selectedBatch) return null;
    return (
      finishedGoods.find(
        (fg) => fg.id === selectedBatch.finishedGoodId || fg.batchId === selectedBatch.id
      ) || null
    );
  }, [finishedGoods, selectedBatch]);

  const availabilityLines = useMemo(() => {
    if (!selectedBatch || !selectedFormula) return [];
    return calculateBomAvailability(
      selectedFormula,
      selectedBatch.plannedQty,
      rawMaterials,
      selectedBatch.allocatedMaterials || [],
      selectedBatch.issuedMaterials || []
    );
  }, [selectedBatch, selectedFormula, rawMaterials]);

  const isConfidentialMasked = Boolean(
    !hasFeaturePermission(rolePermissions, userRole, 'viewConfidentialOem') &&
      selectedFormula?.isConfidentialOem
  );

  const lineSensors = useMemo(() => {
    if (!selectedBatch) return sensors;
    const matched = sensors.filter((s) => s.linkedLine === selectedBatch.lineName);
    return matched.length > 0 ? matched : sensors;
  }, [selectedBatch, sensors]);

  const linkedBatchCheckSpec = useMemo(() => {
    if (!selectedBatch) return null;
    return (
      batchCheckSpecs.find((s) => s.batchId === selectedBatch.id) ||
      batchCheckSpecs.find((s) => s.batchNumber === selectedBatch.batchNumber) ||
      null
    );
  }, [batchCheckSpecs, selectedBatch]);

  const sensorAdapter = useSensorAdapter({
    config: sensorConfig,
    activeBatch: selectedBatch,
    lines: productionLines,
    sensors,
    onNotify,
  });

  const selectedBatchIdForReset = selectedBatch?.id || '';
  const selectedBatchCheckCount = selectedBatch?.processChecks.length || 0;

  useEffect(() => {
    setReadingDraft(makeNextTimeDraft(selectedBatchCheckCount + 1));
    setStep5Error(null);
  }, [selectedBatchIdForReset, selectedBatchCheckCount]);

  function syncOutputFormFromBatch(b: ProductionBatch, formula?: FormulaBOM) {
    setOutPackSize(b.packSize || formula?.packSize || '');
    if (b.goodQty > 0) {
      setOutGood(String(b.goodQty));
      setOutMassQty(b.outputMassQty ? String(b.outputMassQty) : '');
      setOutMassUnit(b.outputMassUnit === 'L' ? 'L' : 'kg');
      setOutRejected(String(b.rejectedQty ?? 0));
      setOutSample(String(b.sampleQty ?? 0));
      setOutRework(String(b.reworkQty ?? 0));
      setOutByProduct(String(b.byProductQty ?? 0));
      setOutWasteKg(String(b.wasteKg ?? 0));
      const findReason = (type: BatchLossRecord['lossType'], fallback: string) =>
        b.lossReasonCodes?.find((r) => r.lossType === type)?.reasonCode || fallback;
      setOutRejectReason(findReason('Reject', 'SEAL-DEFECT'));
      setOutReworkReason(findReason('Rework', 'REWORK-BLENDING'));
      setOutByProductReason(findReason('By-Product', 'TRIM-BYPRODUCT'));
      setOutWasteReason(findReason('Waste', 'LINE-PURGE'));
    } else {
      setOutGood('');
      setOutMassQty('');
      setOutMassUnit('kg');
      setOutRejected('14');
      setOutSample('6');
      setOutRework('0');
      setOutByProduct('0');
      setOutWasteKg('6.5');
    }
  }

  useEffect(() => {
    setShowExtraReadingForm(false);
    setEditingCheckKey(null);
    setEditCheckDraft(null);
    setConfirmDeleteCheckKey(null);
    setShowSpecSwitcher(false);
    setShowOptionalStep5Metrics(false);
    setOverrideEnabled(false);
    setOverrideReason('');
    setEditingHeader(false);
    setEditingIssuedMaterialCode(null);
    setEditingOutput(false);
    if (selectedBatch) {
      syncOutputFormFromBatch(selectedBatch, selectedFormula);
      setQcRetainedCode(selectedBatch.retainedSampleCode || `RET-${selectedBatch.batchNumber}`);
      setQcRetainedLocation(
        selectedBatch.retainedSampleLocation || 'QC Retain Vault · Shelf A1'
      );
      if (selectedBatch.retainedSampleQty !== undefined && selectedBatch.retainedSampleQty !== null) {
        setQcRetainedQty(String(selectedBatch.retainedSampleQty));
      }
      if (selectedBatch.qcNotes) {
        setQcNotes(selectedBatch.qcNotes);
      }
      if (selectedBatch.qcInProcessSummary) {
        setQcInProcessSummary(selectedBatch.qcInProcessSummary);
      }
      if (selectedBatch.qcFinalResults) {
        setQcFinalResults(selectedBatch.qcFinalResults);
      }
      if (linkedFinishedGood?.warehouseZone) {
        setQcWarehouseZone(linkedFinishedGood.warehouseZone);
      }
    }
    if (batchCheckSpecs.length > 0 && selectedBatch) {
      const productLower = selectedBatch.productName.toLowerCase();
      const suggested =
        batchCheckSpecs.find((s) => s.productName.toLowerCase() === productLower) ||
        batchCheckSpecs[0];
      setSpecToLinkId(suggested?.id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBatchIdForReset]);

  function openHeaderEditor() {
    if (!selectedBatch) return;
    setHdrLineName(selectedBatch.lineName || 'Kettle Line 1');
    setHdrEquipment(selectedBatch.equipmentName || selectedBatch.lineName);
    setHdrPackSize(selectedBatch.packSize || selectedFormula?.packSize || '');
    setHdrPlannedQty(String(selectedBatch.plannedQty));
    setHdrPlannedDate(selectedBatch.plannedDate || '');
    setHdrSourceType(selectedBatch.sourceType || 'Sales Demand');
    setHdrSourceRef(selectedBatch.sourceRef || '');
    setHdrShift(selectedBatch.shift || 'Shift A (06:00–14:00)');
    setHdrTeam(selectedBatch.assignedTeam);
    setHdrPlannedStart(selectedBatch.plannedStartAt || `${selectedBatch.plannedDate} 06:30`);
    setHdrPlannedEnd(selectedBatch.plannedEndAt || `${selectedBatch.plannedDate} 10:30`);
    setHdrActualStart(selectedBatch.actualStartAt || '');
    setHdrActualEnd(selectedBatch.actualEndAt || '');
    setHdrOperators((selectedBatch.operators || []).join(', '));
    setEditingHeader(true);
  }

  async function handleSaveHeader(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatch) return;
    const parsedPlannedQty = Number(hdrPlannedQty);
    if (!Number.isFinite(parsedPlannedQty) || parsedPlannedQty <= 0) {
      onNotify('Planned quantity must be greater than zero.');
      return;
    }
    setBusy(true);
    try {
      await updateBatchHeader(selectedBatch.id, {
        lineName: hdrLineName.trim() || selectedBatch.lineName,
        equipmentName: hdrEquipment,
        packSize: hdrPackSize,
        plannedQty: parsedPlannedQty,
        plannedDate: hdrPlannedDate.trim() || selectedBatch.plannedDate,
        sourceType: hdrSourceType,
        sourceRef: hdrSourceRef.trim(),
        shift: hdrShift,
        assignedTeam: hdrTeam,
        plannedStartAt: hdrPlannedStart,
        plannedEndAt: hdrPlannedEnd,
        actualStartAt: hdrActualStart,
        actualEndAt: hdrActualEnd,
        operators: hdrOperators
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        ...(closedOverridePayload || {}),
      });
      setEditingHeader(false);
      onNotify(`Updated EBR header for ${selectedBatch.batchNumber}.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to update batch header.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkSpecToBatch(sourceSpecId: string) {
    if (!selectedBatch) return;
    const template = batchCheckSpecs.find((s) => s.id === sourceSpecId);
    if (!template) {
      onNotify('Select a Batch Check parameter set to link.');
      return;
    }
    setBusy(true);
    try {
      const targetExistingId = linkedBatchCheckSpec
        ? linkedBatchCheckSpec.id
        : !template.batchId
          ? template.id
          : undefined;
      await saveBatchCheckSpec({
        id: targetExistingId,
        batchId: selectedBatch.id,
        batchNumber: selectedBatch.batchNumber,
        productName: selectedBatch.productName,
        productCategory: template.productCategory,
        phMin: template.phMin,
        phMax: template.phMax,
        awMin: template.awMin,
        awMax: template.awMax,
        brixMin: template.brixMin,
        brixMax: template.brixMax,
        additionalParams: template.additionalParams || [],
        requirementNotes: template.requirementNotes || '',
      });
      setShowSpecSwitcher(false);
      onNotify(
        `Linked ${template.productCategory} Batch Check parameter set to ${selectedBatch.batchNumber}.`
      );
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to link Batch Check parameter set.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateWorkOrder(e: React.FormEvent) {
    e.preventDefault();
    const formula =
      approvedFormulas.find((f) => f.id === newFormulaId) || approvedFormulas[0];
    if (!formula) return;
    setBusy(true);
    try {
      const id = await createWorkOrder(ownerId, {
        formula,
        plannedQty: Number(newPlannedQty) || formula.standardBatchSize,
        plannedDate: newPlannedDate,
        lineName: newLineName,
        equipmentName: newEquipmentName,
        assignedTeam: newTeam,
        shift: newShift,
        plannedStartAt: newPlannedStartAt,
        plannedEndAt: newPlannedEndAt,
        operators: newOperatorsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        sourceType: newSourceType,
        sourceRef: newSourceRef,
        existingBatchCount: batches.length,
        batchCheckSpecId: newBatchCheckSpecId || undefined,
      });
      setShowCreateModal(false);
      onSelectBatch(id);
      onNotify(`Job order planned for ${formula.productName}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckAvailability() {
    if (!selectedBatch || !selectedFormula) return;
    setBusy(true);
    try {
      const shortages = await runAvailabilityCheck(
        selectedBatch,
        selectedFormula,
        rawMaterials
      );
      onNotify(
        shortages === 0
          ? `Availability check passed: all ${availabilityLines.length} BOM materials in stock.`
          : `Availability check flagged ${shortages} material shortage(s).`
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleReleaseOrder() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      const lot = await releaseWorkOrder(selectedBatch, batches.length);
      onNotify(`Batch ${selectedBatch.batchNumber} released with lot ${lot}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleAllocateMaterial(materialCode: string) {
    if (!selectedBatch || !selectedFormula) return;
    const line = availabilityLines.find((l) => l.materialCode === materialCode);
    if (!line) return;
    const chosenLotId = selectedLotsByCode[materialCode] || line.matchingLots[0]?.id;
    const rawLot = rawMaterials.find((r) => r.id === chosenLotId);
    if (!rawLot) {
      onNotify('No available raw material lot selected for allocation.');
      return;
    }
    const allocQty = Number(actualQtyByCode[materialCode] ?? line.requiredQty);
    if (!Number.isFinite(allocQty) || allocQty <= 0) return;

    setBusy(true);
    try {
      await allocateMaterialLotToBatch(selectedBatch.id, {
        rawLotId: rawLot.id,
        materialCode: line.materialCode,
        allocatedQtyInBomUnit: allocQty,
        bomUnit: line.unit,
        ...(closedOverridePayload || {}),
      });
      onNotify(`Allocated ${allocQty} ${line.unit} from lot ${rawLot.lotNumber}.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to allocate material lot.');
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueMaterial(materialCode: string) {
    if (!selectedBatch || !selectedFormula) return;
    const line = availabilityLines.find((l) => l.materialCode === materialCode);
    const bomIng = selectedFormula.ingredients.find((i) => i.materialCode === materialCode);
    if (!line || !bomIng) return;

    const chosenLotId = selectedLotsByCode[materialCode] || line.matchingLots[0]?.id;
    const rawLot = rawMaterials.find((r) => r.id === chosenLotId);
    if (!rawLot) {
      onNotify('No available raw material lot selected for issue.');
      return;
    }

    const actualQty = Number(actualQtyByCode[materialCode] ?? line.requiredQty);
    if (!Number.isFinite(actualQty) || actualQty <= 0) return;

    setBusy(true);
    try {
      await issueMaterialLotToBatch(
        selectedBatch,
        rawLot,
        actualQty,
        line.requiredQty,
        line.unit,
        bomIng.tolerancePct,
        operatorName,
        closedOverridePayload
      );
      onNotify(
        `Issued ${actualQty} ${line.unit} from lot ${rawLot.lotNumber} and deducted raw stock.`
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to issue material lot.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateIssuedMaterial(materialCode: string) {
    if (!selectedBatch || !selectedFormula) return;
    const line = availabilityLines.find((l) => l.materialCode === materialCode);
    const bomIng = selectedFormula.ingredients.find((i) => i.materialCode === materialCode);
    if (!line || !bomIng || !editIssuedLotId) return;

    const actualQty = Number(editIssuedQty);
    if (!Number.isFinite(actualQty) || actualQty <= 0) {
      onNotify('Issued quantity must be greater than zero.');
      return;
    }

    setBusy(true);
    try {
      await updateIssuedMaterialLotInBatch(selectedBatch.id, materialCode, {
        rawLotId: editIssuedLotId,
        actualQtyInBomUnit: actualQty,
        requiredQtyInBomUnit: line.requiredQty,
        bomUnit: line.unit,
        tolerancePct: bomIng.tolerancePct,
        operatorName,
        ...(closedOverridePayload || {}),
      });
      setEditingIssuedMaterialCode(null);
      onNotify(
        `Updated issued material ${materialCode} (${actualQty} ${line.unit}) with full before/after audit log.`
      );
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to update issued material lot.'
      );
    } finally {
      setBusy(false);
    }
  }

  function updateReadingDraftField(
    field: keyof TimeReadingDraft,
    value: string | number
  ) {
    setStep5Error(null);
    setReadingDraft((prev) => ({ ...prev, [field]: value }));
  }

  function handlePullLiveSensor(sensor: ThermalSensor) {
    if (!selectedBatch) return;
    const savedCount = selectedBatch.processChecks.length;
    const nowTime = getNowStamp();
    setStep5Error(null);

    if (savedCount >= 3) {
      setShowExtraReadingForm(true);
    }

    const adapterReading = sensorAdapter.latestByLine[selectedBatch.lineName];
    setReadingDraft((prev) => ({
      ...prev,
      readingTime: prev.readingTime || nowTime,
      tempC:
        adapterReading?.tempC !== null && adapterReading?.tempC !== undefined
          ? adapterReading.tempC.toFixed(1)
          : sensor.currentTempC.toFixed(1),
      brix:
        adapterReading?.brix !== null && adapterReading?.brix !== undefined
          ? String(adapterReading.brix)
          : prev.brix,
      ph:
        adapterReading?.ph !== null && adapterReading?.ph !== undefined
          ? String(adapterReading.ph)
          : prev.ph,
      viscosityCp:
        adapterReading?.viscosityCp !== null && adapterReading?.viscosityCp !== undefined
          ? String(adapterReading.viscosityCp)
          : prev.viscosityCp,
      speedRpm:
        adapterReading?.speedRpm !== null && adapterReading?.speedRpm !== undefined
          ? String(adapterReading.speedRpm)
          : prev.speedRpm,
      pressureBar:
        adapterReading?.pressureBar !== null && adapterReading?.pressureBar !== undefined
          ? String(adapterReading.pressureBar)
          : prev.pressureBar,
      sensorCode: adapterReading?.sensorCode || sensor.sensorCode,
      source: 'Sensor',
    }));
  }

  function evaluateDraftOutOfSpecReasons(draft: TimeReadingDraft): string[] {
    const oos: string[] = [];
    const checkParam = (valRaw: string, paramKey: string, label: string) => {
      const fp = formulaParamMap[paramKey];
      if (!fp) return;
      if (evalRangeStatus(valRaw, fp.min, fp.max) === 'out') {
        oos.push(`${label} (${valRaw} ${fp.unit}; spec ${fp.min ?? '—'}–${fp.max ?? '—'})`);
      }
    };
    checkParam(draft.tempC, 'temperature', 'Temperature');
    checkParam(draft.brix, 'brix', 'Brix');
    checkParam(draft.ph, 'ph', 'pH');
    checkParam(draft.aw, 'aw', 'Water Activity (Aw)');
    checkParam(draft.viscosityCp, 'viscosity', 'Viscosity');
    checkParam(draft.weightKg, 'weight', 'Weight');
    checkParam(draft.durationMin, 'time', 'Duration');
    checkParam(draft.speedRpm, 'speed', 'Agitator Speed');
    checkParam(draft.pressureBar, 'pressure', 'Pressure');

    if (linkedBatchCheckSpec) {
      if (
        draft.ph.trim() &&
        evalRangeStatus(draft.ph, linkedBatchCheckSpec.phMin, linkedBatchCheckSpec.phMax) === 'out' &&
        !oos.some((s) => s.startsWith('pH'))
      ) {
        oos.push(`pH (${draft.ph})`);
      }
      if (
        draft.aw.trim() &&
        evalRangeStatus(draft.aw, linkedBatchCheckSpec.awMin, linkedBatchCheckSpec.awMax) === 'out' &&
        !oos.some((s) => s.startsWith('Aw') || s.startsWith('Water Activity'))
      ) {
        oos.push(`Aw (${draft.aw})`);
      }
      if (
        draft.brix.trim() &&
        evalRangeStatus(draft.brix, linkedBatchCheckSpec.brixMin, linkedBatchCheckSpec.brixMax) === 'out' &&
        !oos.some((s) => s.startsWith('Brix'))
      ) {
        oos.push(`Brix (${draft.brix}%)`);
      }
      for (const param of linkedBatchCheckSpec.additionalParams || []) {
        const val = (draft.specParamValues[param.id] || '').trim();
        if (val && evalRangeStatus(val, param.minTarget, param.maxTarget) === 'out') {
          oos.push(`${param.name} (${val})`);
        }
      }
    }
    return oos;
  }

  function buildCheckRecordFromDraft(
    draft: TimeReadingDraft,
    slotNumber: number
  ): ProcessCheckRecord | null {
    if (!selectedFormula) return null;

    const tempVal = draft.tempC.trim() !== '' ? Number(draft.tempC) : null;
    const brixVal = draft.brix.trim() !== '' ? Number(draft.brix) : null;
    const phVal = draft.ph.trim() !== '' ? Number(draft.ph) : null;
    const awVal = draft.aw.trim() !== '' ? Number(draft.aw) : null;
    const weightKgVal = draft.weightKg.trim() !== '' ? Number(draft.weightKg) : null;
    const weightGVal = weightKgVal !== null ? Number((weightKgVal * 1000).toFixed(1)) : null;
    const viscosityVal = draft.viscosityCp.trim() !== '' ? Number(draft.viscosityCp) : null;
    const speedVal = draft.speedRpm.trim() !== '' ? Number(draft.speedRpm) : null;
    const pressureVal = draft.pressureBar.trim() !== '' ? Number(draft.pressureBar) : null;

    const oosReasons = evaluateDraftOutOfSpecReasons(draft);
    const withinSpec = oosReasons.length === 0;

    const batchCheckReadings: BatchCheckAdditionalReading[] = [];
    if (linkedBatchCheckSpec) {
      for (const param of linkedBatchCheckSpec.additionalParams || []) {
        const rawVal = (draft.specParamValues[param.id] || '').trim();
        if (!rawVal) continue;
        const num = Number(rawVal);
        const numericValue = Number.isFinite(num) ? num : null;
        let paramOk = true;
        if (param.minTarget !== null || param.maxTarget !== null) {
          if (numericValue === null) {
            paramOk = false;
          } else {
            if (param.minTarget !== null && numericValue < param.minTarget) paramOk = false;
            if (param.maxTarget !== null && numericValue > param.maxTarget) paramOk = false;
          }
        }
        batchCheckReadings.push({
          paramId: param.id,
          name: param.name,
          unit: param.unit,
          value: rawVal,
          numericValue,
          withinSpec: paramOk,
        });
      }
    }

    const readingTime = draft.readingTime.trim();
    const today = new Date().toISOString().slice(0, 10);

    return {
      readingTime,
      readingSlot: slotNumber,
      stepNumber: draft.stepNumber || slotNumber,
      stepName: `Time Reading #${slotNumber}`,
      recordedTempC: tempVal,
      recordedBrix: brixVal,
      recordedPh: phVal,
      recordedAw: awVal,
      recordedWeightG: weightGVal,
      recordedWeightKg: weightKgVal,
      recordedViscosityCp: viscosityVal,
      recordedSpeedRpm: speedVal,
      recordedPressureBar: pressureVal,
      source: draft.source || 'Manual',
      outOfSpecParams: oosReasons,
      deviationRecord: draft.deviationRecord.trim(),
      batchCheckSpecId: linkedBatchCheckSpec?.id,
      batchCheckReadings,
      durationMin: Number(draft.durationMin) || 25,
      sensorCode: draft.source === 'Sensor' ? (draft.sensorCode || 'SENSOR') : 'MANUAL',
      withinSpec,
      operator: operatorName,
      notes: draft.notes.trim(),
      recordedAt: `${today} ${readingTime}`,
    };
  }

  function validateDraftAgainstLinkedSpec(
    draft: TimeReadingDraft,
    label: string
  ): string | null {
    if (!linkedBatchCheckSpec) return null;
    if (
      (linkedBatchCheckSpec.phMin !== null || linkedBatchCheckSpec.phMax !== null) &&
      draft.ph.trim() === ''
    ) {
      return `${label}: Linked Batch Check (${linkedBatchCheckSpec.productCategory}) requires pH to be read.`;
    }
    if (
      (linkedBatchCheckSpec.awMin !== null || linkedBatchCheckSpec.awMax !== null) &&
      draft.aw.trim() === ''
    ) {
      return `${label}: Linked Batch Check (${linkedBatchCheckSpec.productCategory}) requires Water Activity (Aw) to be read.`;
    }
    if (
      (linkedBatchCheckSpec.brixMin !== null || linkedBatchCheckSpec.brixMax !== null) &&
      draft.brix.trim() === ''
    ) {
      return `${label}: Linked Batch Check (${linkedBatchCheckSpec.productCategory}) requires Brix (%) to be read.`;
    }
    for (const param of linkedBatchCheckSpec.additionalParams || []) {
      if (!(draft.specParamValues[param.id] || '').trim()) {
        return `${label}: Required Batch Check parameter "${param.name}" must be read.`;
      }
    }
    return null;
  }

  async function handleLogSingleProcessCheck(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatch || !selectedFormula) return;
    setStep5Error(null);

    const nextSlot = selectedBatch.processChecks.length + 1;
    const hasTime = readingDraft.readingTime.trim().length > 0;
    const hasCustomVal = Object.values(readingDraft.specParamValues).some(
      (v) => v.trim() !== ''
    );
    const hasMeasurement =
      readingDraft.tempC.trim() !== '' ||
      readingDraft.brix.trim() !== '' ||
      readingDraft.ph.trim() !== '' ||
      readingDraft.aw.trim() !== '' ||
      readingDraft.weightKg.trim() !== '' ||
      readingDraft.viscosityCp.trim() !== '' ||
      readingDraft.speedRpm.trim() !== '' ||
      readingDraft.pressureBar.trim() !== '' ||
      hasCustomVal;

    if (!hasTime) {
      const msg = `Time Reading #${nextSlot} requires tapping Time before saving.`;
      setStep5Error(msg);
      onNotify(msg);
      return;
    }
    if (!hasMeasurement) {
      const msg = `Time Reading #${nextSlot} (${readingDraft.readingTime}) requires at least one measurement.`;
      setStep5Error(msg);
      onNotify(msg);
      return;
    }

    const specValidationMsg = validateDraftAgainstLinkedSpec(
      readingDraft,
      `Time Reading #${nextSlot}`
    );
    if (specValidationMsg) {
      setStep5Error(specValidationMsg);
      onNotify(specValidationMsg);
      return;
    }

    const oosReasons = evaluateDraftOutOfSpecReasons(readingDraft);
    if (
      oosReasons.length > 0 &&
      !readingDraft.notes.trim() &&
      !readingDraft.deviationRecord.trim()
    ) {
      const msg = `Out-of-spec reading (${oosReasons.join(', ')}) requires an operator note or deviation record before saving.`;
      setStep5Error(msg);
      onNotify(msg);
      return;
    }

    const built = buildCheckRecordFromDraft(readingDraft, nextSlot);
    if (!built) return;

    setBusy(true);
    try {
      await recordBatchProcessCheck(selectedBatch, [built], closedOverridePayload);
      setReadingDraft(makeNextTimeDraft(nextSlot + 1));
      if (nextSlot >= 4) {
        setShowExtraReadingForm(false);
      }
      onNotify(
        !built.withinSpec
          ? `Recorded Time Reading #${nextSlot} with deviation flag & note.`
          : nextSlot === 3
            ? `Recorded Time Reading #3 (${built.readingTime}) — Step 5 verified (3/3).`
            : `Recorded Time Reading #${nextSlot} (${built.readingTime}) (${Math.min(nextSlot, 3)}/3).`
      );
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : 'Unable to record time reading.';
      setStep5Error(msg);
      onNotify(msg);
    } finally {
      setBusy(false);
    }
  }

  function startEditProcessCheck(chk: ProcessCheckRecord, idx: number) {
    const key = chk.id || `chk-legacy-${chk.stepNumber}-${idx}`;
    const timePart =
      chk.readingTime ||
      (chk.recordedAt && chk.recordedAt.length >= 16
        ? chk.recordedAt.slice(11, 16)
        : '');
    setEditingCheckKey(key);
    setConfirmDeleteCheckKey(null);
    setStep5Error(null);
    const weightKg = getProcessCheckWeightKg(chk);
    const paramMap: Record<string, string> = {};
    for (const r of chk.batchCheckReadings || []) {
      paramMap[r.paramId] = r.value;
    }
    setEditCheckDraft({
      slotNumber: chk.readingSlot ?? idx + 1,
      readingTime: timePart,
      stepNumber: chk.stepNumber,
      tempC: chk.recordedTempC !== null ? String(chk.recordedTempC) : '',
      brix: chk.recordedBrix !== null ? String(chk.recordedBrix) : '',
      ph: chk.recordedPh !== null ? String(chk.recordedPh) : '',
      aw:
        chk.recordedAw !== null && chk.recordedAw !== undefined
          ? String(chk.recordedAw)
          : '',
      weightKg: weightKg !== null ? String(weightKg) : '',
      viscosityCp:
        chk.recordedViscosityCp !== null && chk.recordedViscosityCp !== undefined
          ? String(chk.recordedViscosityCp)
          : '',
      speedRpm:
        chk.recordedSpeedRpm !== null && chk.recordedSpeedRpm !== undefined
          ? String(chk.recordedSpeedRpm)
          : '',
      pressureBar:
        chk.recordedPressureBar !== null && chk.recordedPressureBar !== undefined
          ? String(chk.recordedPressureBar)
          : '',
      source: chk.source || 'Manual',
      specParamValues: paramMap,
      durationMin: String(chk.durationMin ?? 25),
      sensorCode: chk.sensorCode || 'MANUAL',
      notes: chk.notes || '',
      deviationRecord: chk.deviationRecord || '',
    });
  }

  async function handleSaveEditedProcessCheck(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatch || !selectedFormula || !editingCheckKey || !editCheckDraft) return;
    setStep5Error(null);

    const hasTime = editCheckDraft.readingTime.trim().length > 0;
    const hasCustomVal = Object.values(editCheckDraft.specParamValues).some(
      (v) => v.trim() !== ''
    );
    const hasMeasurement =
      editCheckDraft.tempC.trim() !== '' ||
      editCheckDraft.brix.trim() !== '' ||
      editCheckDraft.ph.trim() !== '' ||
      editCheckDraft.aw.trim() !== '' ||
      editCheckDraft.weightKg.trim() !== '' ||
      editCheckDraft.viscosityCp.trim() !== '' ||
      editCheckDraft.speedRpm.trim() !== '' ||
      editCheckDraft.pressureBar.trim() !== '' ||
      hasCustomVal;

    if (!hasTime || !hasMeasurement) {
      const msg =
        'Edited reading requires both a reading time and at least one measurement.';
      setStep5Error(msg);
      onNotify(msg);
      return;
    }

    const specValidationMsg = validateDraftAgainstLinkedSpec(
      editCheckDraft,
      `Time Reading #${editCheckDraft.slotNumber}`
    );
    if (specValidationMsg) {
      setStep5Error(specValidationMsg);
      onNotify(specValidationMsg);
      return;
    }

    const oosReasons = evaluateDraftOutOfSpecReasons(editCheckDraft);
    if (
      oosReasons.length > 0 &&
      !editCheckDraft.notes.trim() &&
      !editCheckDraft.deviationRecord.trim()
    ) {
      const msg = `Out-of-spec reading (${oosReasons.join(', ')}) requires an operator note or deviation record before saving.`;
      setStep5Error(msg);
      onNotify(msg);
      return;
    }

    const built = buildCheckRecordFromDraft(
      editCheckDraft,
      editCheckDraft.slotNumber
    );
    if (!built) return;

    setBusy(true);
    try {
      await updateBatchProcessCheck(
        selectedBatch.id,
        editingCheckKey,
        built,
        closedOverridePayload
      );
      setEditingCheckKey(null);
      setEditCheckDraft(null);
      onNotify(`Updated time reading (${built.readingTime}).`);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : 'Unable to update time reading.';
      setStep5Error(msg);
      onNotify(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProcessCheck(checkKey: string) {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      await deleteBatchProcessCheck(selectedBatch.id, checkKey, closedOverridePayload);
      if (editingCheckKey === checkKey) {
        setEditingCheckKey(null);
        setEditCheckDraft(null);
      }
      setConfirmDeleteCheckKey(null);
      onNotify('Process reading removed.');
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to delete process reading.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleReportOutput(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatch) return;
    if (selectedBatch.processChecks.length < 3) {
      onNotify(
        `Step 5 requires 3 time reading records before reporting batch output (${selectedBatch.processChecks.length}/3 logged).`
      );
      return;
    }
    const goodQty = Number(outGood || Math.round(selectedBatch.plannedQty * 0.97));
    const rejectedQty = Math.max(0, Number(outRejected) || 0);
    const sampleQty = Math.max(0, Number(outSample) || 0);
    const reworkQty = Math.max(0, Number(outRework) || 0);
    const byProductQty = Math.max(0, Number(outByProduct) || 0);
    const wasteKg = Math.max(0, Number(outWasteKg) || 0);
    const outputMassQty = Number(outMassQty || (goodQty * 0.5).toFixed(1));

    const lossReasonCodes: BatchLossRecord[] = [];
    if (rejectedQty > 0) {
      if (!outRejectReason.trim()) {
        onNotify('Reject loss quantity > 0 requires a reason code.');
        return;
      }
      lossReasonCodes.push({
        lossType: 'Reject',
        quantity: rejectedQty,
        unit: selectedBatch.outputUnit,
        reasonCode: outRejectReason.trim(),
        notes: 'Reported at line output',
      });
    }
    if (reworkQty > 0) {
      if (!outReworkReason.trim()) {
        onNotify('Rework quantity > 0 requires a reason code.');
        return;
      }
      lossReasonCodes.push({
        lossType: 'Rework',
        quantity: reworkQty,
        unit: selectedBatch.outputUnit,
        reasonCode: outReworkReason.trim(),
        notes: 'Flagged for rework',
      });
    }
    if (byProductQty > 0) {
      if (!outByProductReason.trim()) {
        onNotify('By-Product quantity > 0 requires a reason code.');
        return;
      }
      lossReasonCodes.push({
        lossType: 'By-Product',
        quantity: byProductQty,
        unit: outMassUnit,
        reasonCode: outByProductReason.trim(),
        notes: 'Recovered by-product',
      });
    }
    if (wasteKg > 0) {
      if (!outWasteReason.trim()) {
        onNotify('Waste quantity > 0 requires a reason code.');
        return;
      }
      lossReasonCodes.push({
        lossType: 'Waste',
        quantity: wasteKg,
        unit: 'kg',
        reasonCode: outWasteReason.trim(),
        notes: 'Process waste',
      });
    }

    setBusy(true);
    try {
      await reportBatchOutput(selectedBatch, {
        goodQty,
        outputMassQty,
        outputMassUnit: outMassUnit,
        packSize: outPackSize || selectedBatch.packSize || selectedFormula?.packSize || '',
        rejectedQty,
        sampleQty,
        reworkQty,
        byProductQty,
        wasteKg,
        lossReasonCodes,
        ...(closedOverridePayload || {}),
      });
      setEditingOutput(false);
      onNotify(
        `Output reported (${goodQty} ${selectedBatch.outputUnit} / ${outputMassQty} ${outMassUnit}).`
      );
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to report batch output.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleMoveToQcReview() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      await startBatchQcReview(selectedBatch.id);
      onNotify(`Batch ${selectedBatch.batchNumber} moved to QC Review.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to move batch to QC Review.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleQcDecision(decision: 'Passed' | 'Hold' | 'Failed') {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      const fgId = await executeQcDecisionAndPostInventory(
        ownerId,
        selectedBatch,
        selectedFormula,
        decision,
        operatorName,
        qcNotes,
        qcWarehouseZone,
        {
          retainedSampleQty: Number(qcRetainedQty) || 0,
          retainedSampleCode: qcRetainedCode.trim() || `RET-${selectedBatch.batchNumber}`,
          retainedSampleLocation: qcRetainedLocation.trim(),
          qcInProcessSummary: qcInProcessSummary.trim(),
          qcFinalResults: qcFinalResults.trim(),
          ...(closedOverridePayload || {}),
        }
      );
      if (decision === 'Passed' && fgId) {
        onNotify(
          `QC Passed — ${selectedBatch.goodQty} ${selectedBatch.outputUnit} posted to Finished Goods under ${selectedBatch.lotNumber}.`
        );
      } else if (decision === 'Hold') {
        onNotify(`QC Hold placed on batch ${selectedBatch.batchNumber}.`);
      } else {
        onNotify(`QC Rejected — batch ${selectedBatch.batchNumber} quarantined.`);
      }
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to record QC decision.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseBatch() {
    if (!selectedBatch) return;
    setBusy(true);
    try {
      await closeProductionBatch(selectedBatch.id);
      onNotify(`Batch ${selectedBatch.batchNumber} closed and locked.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to close batch.');
    } finally {
      setBusy(false);
    }
  }

  const activeStep = selectedBatch ? getLifecycleStepNumber(selectedBatch) : 1;
  const canExecuteQc = hasFeaturePermission(rolePermissions, userRole, 'qcSignOff');

  return (
    <div className="space-y-5">
      {/* Toolbar: Segmented Filter + Search + Plan Button */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-auto max-w-full">
          {STATUS_FILTERS.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === st
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter batch, lot, SKU..."
              className="pl-9 pr-3 py-1.5 text-sm bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600 w-56"
            />
          </div>
          <button
            type="button"
            disabled={!canPlanRelease}
            title={
              canPlanRelease
                ? 'Plan a new production job order'
                : 'Active role lacks "Plan & Release Job Orders" tick permission'
            }
            onClick={() => {
              if (!canPlanRelease) {
                onNotify('Active role does not have permission to plan job orders.');
                return;
              }
              const firstFormula =
                approvedFormulas.find((f) => f.id === newFormulaId) || approvedFormulas[0];
              if (!newFormulaId && firstFormula) {
                setNewFormulaId(firstFormula.id);
              }
              if (firstFormula && batchCheckSpecs.length > 0) {
                const matchedSpec = batchCheckSpecs.find(
                  (s) =>
                    s.productName.toLowerCase() ===
                    firstFormula.productName.toLowerCase()
                );
                setNewBatchCheckSpecId(matchedSpec?.id || '');
              }
              setShowCreateModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-45 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" />
            Plan Job Order
          </button>
        </div>
      </div>

      {/* Main Split: Batch List (Left) + 9-Step Execution Workbench (Right) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Job Orders ({filteredBatches.length})</span>
            <span>Status</span>
          </div>
          <div className="divide-y divide-slate-100 max-h-[760px] overflow-y-auto">
            {filteredBatches.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm font-medium text-slate-900">No matching batches</p>
                <p className="mt-1 text-xs text-slate-500">
                  Adjust filters or create a new job order.
                </p>
              </div>
            ) : (
              filteredBatches.map((batch) => {
                const isSelected = selectedBatch?.id === batch.id;
                return (
                  <button
                    key={batch.id}
                    type="button"
                    onClick={() => onSelectBatch(batch.id)}
                    className={`w-full text-left px-4 py-3.5 transition-colors flex items-start justify-between gap-3 ${
                      isSelected ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-slate-900">
                          {batch.batchNumber}
                        </span>
                        <span className="text-xs text-slate-400">·</span>
                        <span className="text-xs text-slate-500">{batch.plannedDate}</span>
                      </div>
                      <div className="mt-0.5 text-sm font-medium text-slate-900 truncate">
                        {batch.productName}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 truncate">
                        {batch.lineName} · {batch.plannedQty.toLocaleString()} {batch.outputUnit}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div
                        className={`text-xs font-medium ${
                          batch.status === 'Closed' || batch.status === 'Completed'
                            ? 'text-emerald-700'
                            : batch.status === 'QC Review' || batch.status === 'QC Hold'
                              ? 'text-amber-700'
                              : batch.status === 'In Progress'
                                ? 'text-teal-700'
                                : 'text-slate-600'
                        }`}
                      >
                        {batch.status}
                      </div>
                      {batch.yieldPct > 0 && (
                        <div className="font-mono text-[11px] text-slate-500 tabular-nums mt-0.5">
                          {batch.yieldPct.toFixed(1)}% yield
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right: 9-Step EBR Batch Execution Workbench */}
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
          {!selectedBatch ? (
            <div className="p-12 text-center text-sm text-slate-500">
              Select a job order to manage its electronic batch production record.
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {/* Closed & Locked Banner + Authorized Override Controls */}
              {isClosed && (
                <div
                  className={`px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs ${
                    !isLockedForUser
                      ? 'bg-amber-50 border-b border-amber-200 text-amber-950'
                      : 'bg-slate-900 text-slate-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Lock
                      className={`w-4 h-4 shrink-0 ${
                        !isLockedForUser ? 'text-amber-700' : 'text-amber-400'
                      }`}
                    />
                    <span>
                      {!isLockedForUser ? (
                        <>
                          <strong>Authorized Closed-Batch Override Active</strong> ({userRole}) — every modification is permanently audit logged.
                        </>
                      ) : (
                        <>
                          <strong>Batch Closed &amp; Locked</strong> — all edits are blocked.{' '}
                          {canAuthorizedOverride
                            ? 'Enable Authorized Override with a documented reason to amend.'
                            : 'Requires a role with "Override Closed & Locked Batch" enabled.'}
                        </>
                      )}
                    </span>
                  </div>
                  {canAuthorizedOverride && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1.5 font-medium cursor-pointer">
                        <input
                          type="checkbox"
                          checked={overrideEnabled}
                          onChange={(e) => setOverrideEnabled(e.target.checked)}
                          className="rounded border-slate-300 text-teal-700"
                        />
                        <span>Authorize Override</span>
                      </label>
                      {overrideEnabled && (
                        <input
                          type="text"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Mandatory override reason (QA/CAPA ref)..."
                          className="w-64 px-2.5 py-1 text-xs rounded border border-amber-300 bg-white text-slate-900 placeholder:text-slate-400"
                        />
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 1. Electronic Batch Record Header */}
              <div className="p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-900">
                        {selectedBatch.batchNumber}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        {selectedBatch.lotNumber || 'Lot unassigned'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {selectedBatch.sku} ({selectedBatch.formulaVersion})
                      </span>
                      {selectedFormula?.isConfidentialOem && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 font-medium text-amber-800">
                            <Lock className="w-3 h-3" />
                            OEM Confidential ({selectedFormula.oemCustomer})
                          </span>
                        </>
                      )}
                    </div>
                    <h2 className="mt-1 text-lg font-semibold text-slate-900">
                      {selectedBatch.productName}
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-600">
                      {selectedBatch.lineName} · {selectedBatch.assignedTeam} · Triggered by{' '}
                      {selectedBatch.sourceType}
                      {selectedBatch.sourceRef ? ` (${selectedBatch.sourceRef})` : ''}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <div className="text-right">
                      <div className="text-xs text-slate-500">Planned Output</div>
                      <div className="font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {selectedBatch.plannedQty.toLocaleString()} {selectedBatch.outputUnit}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        Status:{' '}
                        <span className="font-semibold text-slate-900">
                          {selectedBatch.status}
                        </span>{' '}
                        · QC:{' '}
                        <span className="font-semibold text-slate-900">
                          {selectedBatch.qcStatus}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isLockedForUser && (
                        <button
                          type="button"
                          onClick={openHeaderEditor}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          Edit EBR Header
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onOpenBatchReport(selectedBatch.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                      >
                        <FileText className="w-3.5 h-3.5 text-teal-700" />
                        HACCP PDF Report
                      </button>
                    </div>
                  </div>
                </div>

                {/* EBR Header Metadata Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-3 bg-[#F7F8FA] border border-slate-200 rounded-md text-xs">
                  <div>
                    <div className="text-[11px] text-slate-500">Line / Equipment</div>
                    <div className="font-medium text-slate-900 mt-0.5">
                      {selectedBatch.equipmentName || selectedBatch.lineName}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Shift &amp; Crew</div>
                    <div className="font-medium text-slate-900 mt-0.5">
                      {selectedBatch.shift || 'Shift A'}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {selectedBatch.assignedTeam}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Pack Size</div>
                    <div className="font-mono font-medium text-slate-900 mt-0.5">
                      {selectedBatch.packSize || selectedFormula?.packSize || selectedBatch.outputUnit}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Planned Start → End</div>
                    <div className="font-mono text-[11px] text-slate-900 mt-0.5 tabular-nums">
                      {selectedBatch.plannedStartAt || `${selectedBatch.plannedDate} 06:30`}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                      → {selectedBatch.plannedEndAt || `${selectedBatch.plannedDate} 10:30`}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Actual Start → End</div>
                    <div className="font-mono text-[11px] text-slate-900 mt-0.5 tabular-nums">
                      {selectedBatch.actualStartAt || 'Not started'}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                      → {selectedBatch.actualEndAt || 'In progress / pending'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">Operators</div>
                    <div className="text-slate-900 mt-0.5">
                      {(selectedBatch.operators && selectedBatch.operators.length > 0
                        ? selectedBatch.operators
                        : [operatorName]
                      ).join(', ')}
                    </div>
                  </div>
                </div>

                {/* Inline EBR Header Edit Form */}
                {editingHeader && !isLockedForUser && (
                  <form
                    onSubmit={(e) => void handleSaveHeader(e)}
                    className="p-4 border border-teal-300 bg-white rounded-md space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-900">
                        Edit Electronic Batch Record Header
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingHeader(false)}
                        className="p-1 text-slate-400 hover:text-slate-700 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Production Line
                        </label>
                        <select
                          value={hdrLineName}
                          onChange={(e) => setHdrLineName(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                        >
                          {Array.from(
                            new Set([
                              ...productionLines.map((l) => l.lineName),
                              hdrLineName || 'Kettle Line 1',
                            ])
                          ).map((ln) => (
                            <option key={ln} value={ln}>
                              {ln}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Equipment / Vessel
                        </label>
                        <input
                          type="text"
                          value={hdrEquipment}
                          onChange={(e) => setHdrEquipment(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Planned Qty ({selectedBatch.outputUnit})
                        </label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={hdrPlannedQty}
                          onChange={(e) => setHdrPlannedQty(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Planned Date
                        </label>
                        <input
                          type="date"
                          value={hdrPlannedDate}
                          onChange={(e) => setHdrPlannedDate(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Order Source
                        </label>
                        <select
                          value={hdrSourceType}
                          onChange={(e) => setHdrSourceType(e.target.value as BatchSourceType)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                        >
                          <option value="Sales Demand">Sales Demand</option>
                          <option value="Safety Stock">Safety Stock</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Source Ref
                        </label>
                        <input
                          type="text"
                          value={hdrSourceRef}
                          onChange={(e) => setHdrSourceRef(e.target.value)}
                          placeholder="SO-88620"
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Pack Size</label>
                        <input
                          type="text"
                          value={hdrPackSize}
                          onChange={(e) => setHdrPackSize(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Shift</label>
                        <input
                          type="text"
                          value={hdrShift}
                          onChange={(e) => setHdrShift(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Assigned Team</label>
                        <input
                          type="text"
                          value={hdrTeam}
                          onChange={(e) => setHdrTeam(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Planned Start
                        </label>
                        <input
                          type="text"
                          value={hdrPlannedStart}
                          onChange={(e) => setHdrPlannedStart(e.target.value)}
                          placeholder="YYYY-MM-DD HH:mm"
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Planned End</label>
                        <input
                          type="text"
                          value={hdrPlannedEnd}
                          onChange={(e) => setHdrPlannedEnd(e.target.value)}
                          placeholder="YYYY-MM-DD HH:mm"
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Actual Start</label>
                        <input
                          type="text"
                          value={hdrActualStart}
                          onChange={(e) => setHdrActualStart(e.target.value)}
                          placeholder="YYYY-MM-DD HH:mm"
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Actual End</label>
                        <input
                          type="text"
                          value={hdrActualEnd}
                          onChange={(e) => setHdrActualEnd(e.target.value)}
                          placeholder="YYYY-MM-DD HH:mm"
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Operators (comma-separated)
                        </label>
                        <input
                          type="text"
                          value={hdrOperators}
                          onChange={(e) => setHdrOperators(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingHeader(false)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={busy}
                        className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                      >
                        {busy ? 'Saving...' : 'Save EBR Header'}
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* 9-Step Lifecycle Stepper */}
              <div className="px-5 py-3.5 bg-[#F7F8FA] overflow-x-auto">
                <div className="flex items-center justify-between min-w-[640px] gap-2">
                  {LIFECYCLE_STEPS.map((st) => {
                    const completed = activeStep > st.num || selectedBatch.status === 'Closed';
                    const current = activeStep === st.num && selectedBatch.status !== 'Closed';
                    return (
                      <div key={st.num} className="flex items-center gap-1.5">
                        <span
                          className={`w-5 h-5 rounded-full text-[11px] font-mono font-semibold flex items-center justify-center shrink-0 ${
                            completed
                              ? 'bg-emerald-700 text-white'
                              : current
                                ? 'bg-teal-700 text-white'
                                : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          {st.num}
                        </span>
                        <span
                          className={`text-xs whitespace-nowrap ${
                            current
                              ? 'font-semibold text-slate-900'
                              : completed
                                ? 'text-slate-700'
                                : 'text-slate-400'
                          }`}
                        >
                          {st.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Steps 2–4: Material Allocation, Availability Check, Release & Lot Issue */}
              <div className="p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Steps 2–4. Material Allocation, Availability &amp; Lot Issue
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {isConfidentialMasked
                        ? 'OEM Operator Mode active: proprietary ingredient names hidden; weigh strictly by code and target.'
                        : 'Compare allocated vs actual lot quantities with operator & timestamp audit per lot.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedBatch.status === 'Planned' && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleCheckAvailability()}
                          className="px-3 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
                        >
                          Check BOM Availability
                        </button>
                        <button
                          type="button"
                          disabled={busy || !canPlanRelease}
                          title={
                            canPlanRelease
                              ? 'Release job order and generate lot number'
                              : 'Active role lacks "Plan & Release Job Orders" tick permission'
                          }
                          onClick={() => void handleReleaseOrder()}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-45 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap"
                        >
                          Release &amp; Generate Lot
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2 px-3">Material</th>
                        <th className="py-2 px-3 text-right">Required</th>
                        <th className="py-2 px-3">Allocated / Stock</th>
                        <th className="py-2 px-3">Actual Used · Who &amp; When</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {availabilityLines.map((line) => {
                        const alreadyIssued = selectedBatch.issuedMaterials.find(
                          (m) => m.materialCode === line.materialCode
                        );
                        const allocatedRec = (selectedBatch.allocatedMaterials || []).find(
                          (a) => a.materialCode === line.materialCode
                        );
                        const canAllocate =
                          !isLockedForUser &&
                          canExecuteBatchSteps &&
                          !alreadyIssued &&
                          (selectedBatch.status === 'Planned' ||
                            selectedBatch.status === 'Released' ||
                            selectedBatch.status === 'In Progress');
                        const canIssue =
                          !isLockedForUser &&
                          canExecuteBatchSteps &&
                          !alreadyIssued &&
                          (selectedBatch.status === 'Released' ||
                            selectedBatch.status === 'In Progress' ||
                            isClosed);

                        return (
                          <tr key={line.materialCode}>
                            <td className="py-2.5 px-3">
                              <div className="font-medium text-slate-900">
                                {isConfidentialMasked ? line.anonymizedCode : line.materialName}
                              </div>
                              <div className="font-mono text-[11px] text-slate-500">
                                {isConfidentialMasked ? 'Confidential OEM Spec' : line.materialCode}{' '}
                                · {line.category}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900">
                              {line.requiredQty} {line.unit}
                            </td>
                            <td className="py-2.5 px-3">
                              <div className="font-mono tabular-nums">
                                <span
                                  className={
                                    line.isShort
                                      ? 'text-red-700 font-semibold'
                                      : 'text-emerald-700'
                                  }
                                >
                                  {line.availableQtyInBomUnit} {line.unit} avail
                                </span>
                                {line.isShort && (
                                  <span className="ml-1.5 text-[11px] text-red-700">
                                    (Short {line.shortageQty})
                                  </span>
                                )}
                              </div>
                              {allocatedRec && (
                                <div className="mt-0.5 text-[11px] text-slate-600 font-mono">
                                  Alloc: {allocatedRec.allocatedQty} {allocatedRec.unit} ·{' '}
                                  {allocatedRec.lotNumber} ({allocatedRec.allocatedBy})
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-3">
                              {alreadyIssued ? (
                                editingIssuedMaterialCode === line.materialCode &&
                                !isLockedForUser &&
                                canExecuteBatchSteps ? (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <select
                                      value={editIssuedLotId}
                                      onChange={(e) => setEditIssuedLotId(e.target.value)}
                                      className="border border-teal-300 rounded px-2 py-1 text-xs font-mono bg-white text-slate-800 max-w-[165px]"
                                    >
                                      {rawMaterials
                                        .filter((r) => r.materialCode === line.materialCode)
                                        .map((lot) => (
                                          <option key={lot.id} value={lot.id}>
                                            {lot.lotNumber} ({lot.quantityAvailable} {lot.unit})
                                          </option>
                                        ))}
                                    </select>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={editIssuedQty}
                                      onChange={(e) => setEditIssuedQty(e.target.value)}
                                      className="w-20 border border-teal-300 rounded px-2 py-1 text-xs font-mono tabular-nums text-right bg-white"
                                    />
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void handleUpdateIssuedMaterial(line.materialCode)}
                                      className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-40 rounded whitespace-nowrap"
                                    >
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingIssuedMaterialCode(null)}
                                      className="px-2 py-1 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 rounded whitespace-nowrap"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <div className="space-y-0.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <div>
                                        <span className="font-mono font-medium text-slate-900">
                                          {alreadyIssued.lotNumber}
                                        </span>
                                        <span className="text-slate-600 font-mono">
                                          {' '}
                                          · {alreadyIssued.actualQty} {alreadyIssued.unit}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span
                                          className={`font-mono ${
                                            alreadyIssued.withinTolerance
                                              ? 'text-emerald-700'
                                              : 'text-amber-700 font-semibold'
                                          }`}
                                        >
                                          {alreadyIssued.variancePct >= 0 ? '+' : ''}
                                          {alreadyIssued.variancePct}%
                                        </span>
                                        {!isLockedForUser && canExecuteBatchSteps && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setEditingIssuedMaterialCode(line.materialCode);
                                              setEditIssuedLotId(alreadyIssued.lotId);
                                              setEditIssuedQty(String(alreadyIssued.actualQty));
                                            }}
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded"
                                            title="Edit issued lot or quantity (logged with before/after diff)"
                                          >
                                            <Edit3 className="w-3 h-3" />
                                            Edit
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                    <div className="text-[11px] text-slate-500">
                                      Added by <strong className="text-slate-700">{alreadyIssued.operator}</strong> ·{' '}
                                      <span className="font-mono">{alreadyIssued.issuedAt}</span>
                                    </div>
                                  </div>
                                )
                              ) : canAllocate || canIssue ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <select
                                    value={
                                      selectedLotsByCode[line.materialCode] ||
                                      allocatedRec?.lotId ||
                                      line.matchingLots[0]?.id ||
                                      ''
                                    }
                                    onChange={(e) =>
                                      setSelectedLotsByCode((prev) => ({
                                        ...prev,
                                        [line.materialCode]: e.target.value,
                                      }))
                                    }
                                    className="border border-slate-200 rounded px-2 py-1 text-xs font-mono bg-white text-slate-800 max-w-[165px]"
                                  >
                                    {line.matchingLots.length === 0 ? (
                                      <option value="">No stock lot</option>
                                    ) : (
                                      line.matchingLots.map((lot) => (
                                        <option key={lot.id} value={lot.id}>
                                          {lot.lotNumber} ({lot.quantityAvailable} {lot.unit})
                                        </option>
                                      ))
                                    )}
                                  </select>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={
                                      actualQtyByCode[line.materialCode] ??
                                      String(allocatedRec?.allocatedQty ?? line.requiredQty)
                                    }
                                    onChange={(e) =>
                                      setActualQtyByCode((prev) => ({
                                        ...prev,
                                        [line.materialCode]: e.target.value,
                                      }))
                                    }
                                    className="w-18 border border-slate-200 rounded px-2 py-1 text-xs font-mono tabular-nums text-right"
                                  />
                                  {canAllocate && (
                                    <button
                                      type="button"
                                      disabled={busy || line.matchingLots.length === 0}
                                      onClick={() => void handleAllocateMaterial(line.materialCode)}
                                      className="px-2 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 disabled:opacity-40 rounded whitespace-nowrap"
                                    >
                                      Allocate
                                    </button>
                                  )}
                                  {canIssue && (
                                    <button
                                      type="button"
                                      disabled={busy || line.matchingLots.length === 0}
                                      onClick={() => void handleIssueMaterial(line.materialCode)}
                                      className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-40 rounded whitespace-nowrap"
                                    >
                                      Issue Lot
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate-400">
                                  {selectedBatch.status === 'Planned'
                                    ? 'Release job order to issue'
                                    : isLockedForUser
                                      ? 'Batch locked'
                                      : !canExecuteBatchSteps
                                        ? 'Role lacks execution tick'
                                        : 'Not issued'}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Step 5: Process Readings (Manual/Sensor) + Recipe Parameter Specs + Deviation Rules */}
              <div className="p-5 space-y-4">
                {(() => {
                  const savedChecks = selectedBatch.processChecks;
                  const savedCount = savedChecks.length;
                  const hasThreeSaved = savedCount >= 3;
                  const nextSlotNumber = savedCount + 1;
                  const canEditStep5 =
                    !isLockedForUser &&
                    canExecuteBatchSteps &&
                    (selectedBatch.status === 'Released' ||
                      selectedBatch.status === 'In Progress' ||
                      isClosed);

                  const hasDraftTime = readingDraft.readingTime.trim().length > 0;
                  const hasDraftCustomVal = Object.values(
                    readingDraft.specParamValues
                  ).some((v) => v.trim() !== '');
                  const hasDraftVal =
                    readingDraft.tempC.trim() !== '' ||
                    readingDraft.brix.trim() !== '' ||
                    readingDraft.ph.trim() !== '' ||
                    readingDraft.aw.trim() !== '' ||
                    readingDraft.weightKg.trim() !== '' ||
                    readingDraft.viscosityCp.trim() !== '' ||
                    readingDraft.speedRpm.trim() !== '' ||
                    readingDraft.pressureBar.trim() !== '' ||
                    hasDraftCustomVal;
                  const draftReady = !hasThreeSaved && hasDraftTime && hasDraftVal;
                  const visualTotal = Math.min(3, savedCount + (draftReady ? 1 : 0));

                  const specPhRequired = Boolean(
                    linkedBatchCheckSpec &&
                      (linkedBatchCheckSpec.phMin !== null ||
                        linkedBatchCheckSpec.phMax !== null)
                  );
                  const specAwRequired = Boolean(
                    linkedBatchCheckSpec &&
                      (linkedBatchCheckSpec.awMin !== null ||
                        linkedBatchCheckSpec.awMax !== null)
                  );
                  const specBrixRequired = Boolean(
                    linkedBatchCheckSpec &&
                      (linkedBatchCheckSpec.brixMin !== null ||
                        linkedBatchCheckSpec.brixMax !== null)
                  );

                  const draftOosReasons = evaluateDraftOutOfSpecReasons(readingDraft);
                  const editOosReasons = editCheckDraft
                    ? evaluateDraftOutOfSpecReasons(editCheckDraft)
                    : [];

                  const checkFieldOut = (val: string, key: string, specMin?: number | null, specMax?: number | null) => {
                    if (!val.trim()) return false;
                    const fp = formulaParamMap[key];
                    if (fp && evalRangeStatus(val, fp.min, fp.max) === 'out') return true;
                    if ((specMin !== undefined || specMax !== undefined) && evalRangeStatus(val, specMin ?? null, specMax ?? null) === 'out') return true;
                    return false;
                  };

                  const draftTempOut = checkFieldOut(readingDraft.tempC, 'temperature');
                  const draftBrixOut = checkFieldOut(
                    readingDraft.brix,
                    'brix',
                    linkedBatchCheckSpec?.brixMin,
                    linkedBatchCheckSpec?.brixMax
                  );
                  const draftPhOut = checkFieldOut(
                    readingDraft.ph,
                    'ph',
                    linkedBatchCheckSpec?.phMin,
                    linkedBatchCheckSpec?.phMax
                  );
                  const draftAwOut = checkFieldOut(
                    readingDraft.aw,
                    'aw',
                    linkedBatchCheckSpec?.awMin,
                    linkedBatchCheckSpec?.awMax
                  );
                  const draftViscOut = checkFieldOut(readingDraft.viscosityCp, 'viscosity');
                  const draftWeightOut = checkFieldOut(readingDraft.weightKg, 'weight');
                  const draftSpeedOut = checkFieldOut(readingDraft.speedRpm, 'speed');
                  const draftPressureOut = checkFieldOut(readingDraft.pressureBar, 'pressure');

                  const draftCustomMissing = (
                    linkedBatchCheckSpec?.additionalParams || []
                  ).some((p) => !(readingDraft.specParamValues[p.id] || '').trim());

                  const missingLinkedSpecField = Boolean(
                    (specPhRequired && !readingDraft.ph.trim()) ||
                      (specAwRequired && !readingDraft.aw.trim()) ||
                      (specBrixRequired && !readingDraft.brix.trim()) ||
                      draftCustomMissing
                  );
                  const draftAnyOutOfSpec = draftOosReasons.length > 0;
                  const draftNeedsDeviationNote =
                    draftAnyOutOfSpec &&
                    !readingDraft.notes.trim() &&
                    !readingDraft.deviationRecord.trim();

                  const isDraftRowReady =
                    hasDraftTime &&
                    hasDraftVal &&
                    !missingLinkedSpecField &&
                    !draftNeedsDeviationNote;
                  const cardBorder = draftAnyOutOfSpec
                    ? 'border-red-400 bg-red-50/20'
                    : !isDraftRowReady
                      ? 'border-amber-300 bg-white'
                      : 'border-emerald-300 bg-emerald-50/20';
                  const statusTextTone = draftAnyOutOfSpec
                    ? 'text-red-700'
                    : !isDraftRowReady
                      ? 'text-amber-700'
                      : 'text-emerald-700';

                  const phConfigured = Boolean(specPhRequired || formulaParamMap.ph);
                  const brixConfigured = Boolean(specBrixRequired || formulaParamMap.brix);
                  const awConfigured = Boolean(specAwRequired || formulaParamMap.aw);

                  const showPhField = Boolean(
                    phConfigured ||
                      showOptionalStep5Metrics ||
                      readingDraft.ph.trim() !== '' ||
                      Boolean(editCheckDraft?.ph.trim()) ||
                      savedChecks.some(
                        (c) => c.recordedPh !== null && c.recordedPh !== undefined
                      )
                  );
                  const showBrixField = Boolean(
                    brixConfigured ||
                      showOptionalStep5Metrics ||
                      readingDraft.brix.trim() !== '' ||
                      Boolean(editCheckDraft?.brix.trim()) ||
                      savedChecks.some(
                        (c) => c.recordedBrix !== null && c.recordedBrix !== undefined
                      )
                  );
                  const showAwField = Boolean(
                    awConfigured ||
                      showOptionalStep5Metrics ||
                      readingDraft.aw.trim() !== '' ||
                      Boolean(editCheckDraft?.aw.trim()) ||
                      savedChecks.some(
                        (c) => c.recordedAw !== null && c.recordedAw !== undefined
                      )
                  );
                  const hasHiddenCategoryMetrics =
                    !phConfigured || !brixConfigured || !awConfigured;
                  const unconfiguredMetricLabels = [
                    !brixConfigured ? 'Brix' : null,
                    !phConfigured ? 'pH' : null,
                    !awConfigured ? 'Aw' : null,
                  ].filter((x): x is string => Boolean(x));

                  const showBrixCol = Boolean(
                    brixConfigured ||
                      savedChecks.some(
                        (c) => c.recordedBrix !== null && c.recordedBrix !== undefined
                      )
                  );
                  const showPhCol = Boolean(
                    phConfigured ||
                      savedChecks.some(
                        (c) => c.recordedPh !== null && c.recordedPh !== undefined
                      )
                  );
                  const showAwColumn = Boolean(
                    awConfigured ||
                      savedChecks.some(
                        (c) => c.recordedAw !== null && c.recordedAw !== undefined
                      )
                  );
                  const showSpecParamsColumn = Boolean(
                    (linkedBatchCheckSpec?.additionalParams?.length || 0) > 0 ||
                      savedChecks.some((c) => (c.batchCheckReadings?.length || 0) > 0)
                  );

                  return (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-900">
                            Step 5. Process Readings (Manual / Sensor) &amp; Recipe Limits
                          </h3>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Enter readings manually or pull optional sensors. Out-of-spec values are flagged red and require a note or deviation record.
                          </p>
                        </div>

                        <div className="min-w-[210px] space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                            <span className="text-slate-600">Batch Time Readings</span>
                            <span
                              className={`font-semibold ${
                                hasThreeSaved ? 'text-emerald-700' : 'text-amber-700'
                              }`}
                            >
                              {savedCount}/3 logged
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            {[0, 1, 2].map((slotIdx) => {
                              const saved = savedChecks[slotIdx];
                              const barTone = saved
                                ? saved.withinSpec
                                  ? 'bg-emerald-600'
                                  : 'bg-red-600'
                                : slotIdx < visualTotal
                                  ? 'bg-teal-500'
                                  : 'bg-amber-300';
                              return (
                                <div
                                  key={slotIdx}
                                  className={`h-1.5 rounded-xs transition-colors ${barTone}`}
                                />
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <SensorAdapterBanner
                        batch={selectedBatch}
                        adapter={sensorAdapter}
                        isLocked={isLockedForUser}
                        onOpenSettings={() => onOpenSensorSettings?.()}
                        onNotify={onNotify}
                      />

                      {/* Recipe Process Parameter Limits Banner */}
                      {selectedFormulaParams.length > 0 && (
                        <div className="border border-slate-200 bg-[#F7F8FA] rounded-md p-3 space-y-2">
                          <div className="text-[11px] font-semibold text-slate-700">
                            Recipe Target / Min / Max Limits ({selectedBatch.sku} ·{' '}
                            {selectedBatch.formulaVersion})
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-[11px]">
                            {selectedFormulaParams.map((p) => (
                              <div
                                key={p.key}
                                className="bg-white border border-slate-200 rounded px-2 py-1.5"
                              >
                                <div className="text-slate-500 truncate" title={p.name}>
                                  {p.name}
                                </div>
                                <div className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                                  {p.min ?? '—'}–{p.max ?? '—'} {p.unit}
                                </div>
                                <div className="font-mono text-[10px] text-teal-700 tabular-nums">
                                  Target: {p.target ?? '—'} {p.unit}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Linked Batch Check Required Parameter Set Banner */}
                      {linkedBatchCheckSpec ? (
                        <div className="border border-teal-200 bg-teal-50/30 rounded-md p-3.5 space-y-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-semibold text-teal-900">
                                Linked Batch Check Parameter Set:
                              </span>
                              <span className="font-mono font-semibold text-slate-900">
                                {linkedBatchCheckSpec.productCategory}
                              </span>
                              <span className="text-slate-400">·</span>
                              <span className="text-slate-700 font-medium">
                                {linkedBatchCheckSpec.productName}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {!isLockedForUser && batchCheckSpecs.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setShowSpecSwitcher((v) => !v)}
                                  className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-teal-600 rounded"
                                >
                                  {showSpecSwitcher ? 'Cancel' : 'Change Spec'}
                                </button>
                              )}
                              {onNavigate && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate('batch-check')}
                                  className="px-2 py-1 text-[11px] font-medium text-teal-800 bg-white border border-teal-200 hover:bg-teal-50 rounded"
                                >
                                  Open Batch Check
                                </button>
                              )}
                            </div>
                          </div>

                          {showSpecSwitcher && !isLockedForUser && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <select
                                value={specToLinkId}
                                onChange={(e) => setSpecToLinkId(e.target.value)}
                                className="flex-1 min-w-[220px] border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                              >
                                {batchCheckSpecs.map((sp) => (
                                  <option key={sp.id} value={sp.id}>
                                    {sp.productCategory} — {sp.productName} ({sp.batchNumber})
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                disabled={busy || !specToLinkId}
                                onClick={() => void handleLinkSpecToBatch(specToLinkId)}
                                className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                              >
                                Apply Parameter Set
                              </button>
                            </div>
                          )}

                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-[11px]">
                            {(linkedBatchCheckSpec.phMin !== null ||
                              linkedBatchCheckSpec.phMax !== null) && (
                              <div className="bg-white border border-slate-200 rounded px-2.5 py-1.5">
                                <div className="text-slate-500">Required pH</div>
                                <div className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                                  {formatCheckRange(
                                    linkedBatchCheckSpec.phMin,
                                    linkedBatchCheckSpec.phMax,
                                    2
                                  )}
                                </div>
                              </div>
                            )}
                            {(linkedBatchCheckSpec.awMin !== null ||
                              linkedBatchCheckSpec.awMax !== null) && (
                              <div className="bg-white border border-slate-200 rounded px-2.5 py-1.5">
                                <div className="text-slate-500">Required Aw</div>
                                <div className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                                  {formatCheckRange(
                                    linkedBatchCheckSpec.awMin,
                                    linkedBatchCheckSpec.awMax,
                                    3
                                  )}
                                </div>
                              </div>
                            )}
                            {(linkedBatchCheckSpec.brixMin !== null ||
                              linkedBatchCheckSpec.brixMax !== null) && (
                              <div className="bg-white border border-slate-200 rounded px-2.5 py-1.5">
                                <div className="text-slate-500">Required Brix (%)</div>
                                <div className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                                  {formatCheckRange(
                                    linkedBatchCheckSpec.brixMin,
                                    linkedBatchCheckSpec.brixMax,
                                    1,
                                    '%'
                                  )}
                                </div>
                              </div>
                            )}
                            {(linkedBatchCheckSpec.additionalParams || []).map((param) => (
                              <div
                                key={param.id}
                                className="bg-white border border-slate-200 rounded px-2.5 py-1.5"
                              >
                                <div className="text-slate-500 truncate" title={param.name}>
                                  Required {param.name}
                                </div>
                                <div className="font-mono font-semibold text-slate-900 tabular-nums mt-0.5">
                                  {formatCheckRange(
                                    param.minTarget,
                                    param.maxTarget,
                                    param.unit === 'SG' ? 2 : 1,
                                    param.unit ? ` ${param.unit}` : ''
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        !isLockedForUser && (
                          <div className="border border-amber-200 bg-amber-50/40 rounded-md p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                            <div className="text-amber-900">
                              <span className="font-semibold">
                                No Batch Check Parameter Set linked yet.
                              </span>{' '}
                              <span className="text-amber-800">
                                Link a category parameter set (e.g. Sauce, Syrup, Powder) so its required parameters are enforced in Step 5.
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {batchCheckSpecs.length > 0 && (
                                <>
                                  <select
                                    value={specToLinkId}
                                    onChange={(e) => setSpecToLinkId(e.target.value)}
                                    className="border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white max-w-[260px]"
                                  >
                                    {batchCheckSpecs.map((sp) => (
                                      <option key={sp.id} value={sp.id}>
                                        {sp.productCategory} — {sp.productName}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={busy || !specToLinkId}
                                    onClick={() => void handleLinkSpecToBatch(specToLinkId)}
                                    className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded whitespace-nowrap"
                                  >
                                    Link Parameter Set
                                  </button>
                                </>
                              )}
                              {onNavigate && (
                                <button
                                  type="button"
                                  onClick={() => onNavigate('batch-check')}
                                  className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded whitespace-nowrap"
                                >
                                  Configure in Batch Check
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      )}

                      {savedChecks.length > 0 && (
                        <div className="overflow-x-auto border border-slate-200 rounded-md">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                                <th className="py-2 px-3"># / Time</th>
                                <th className="py-2 px-3 text-right">Temp °C</th>
                                {(showBrixCol || showPhCol) && (
                                  <th className="py-2 px-3 text-right">
                                    {showBrixCol && showPhCol
                                      ? 'Brix (%) / pH'
                                      : showBrixCol
                                        ? 'Brix (%)'
                                        : 'pH'}
                                  </th>
                                )}
                                {showAwColumn && <th className="py-2 px-3 text-right">Aw</th>}
                                <th className="py-2 px-3 text-right">Weight (kg)</th>
                                <th className="py-2 px-3 text-right">Visc / RPM / Bar</th>
                                {showSpecParamsColumn && (
                                  <th className="py-2 px-3">Batch Check Params</th>
                                )}
                                <th className="py-2 px-3">Source / User</th>
                                <th className="py-2 px-3">Spec &amp; Deviation</th>
                                {!isLockedForUser && (
                                  <th className="py-2 px-3 text-right">Actions</th>
                                )}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {savedChecks.map((chk, idx) => {
                                const checkKey =
                                  chk.id || `chk-legacy-${chk.stepNumber}-${idx}`;
                                const isEditingThis = editingCheckKey === checkKey;
                                const isConfirmingDelete =
                                  confirmDeleteCheckKey === checkKey;
                                const weightKg = getProcessCheckWeightKg(chk);

                                return (
                                  <tr
                                    key={checkKey}
                                    className={
                                      !chk.withinSpec
                                        ? 'bg-red-50/40'
                                        : isEditingThis
                                          ? 'bg-teal-50/40'
                                          : undefined
                                    }
                                  >
                                    <td className="py-2 px-3 font-mono tabular-nums text-slate-800 whitespace-nowrap">
                                      <span className="font-semibold text-slate-900">
                                        T{idx + 1}
                                      </span>{' '}
                                      ·{' '}
                                      {chk.readingTime ||
                                        chk.recordedAt.slice(11, 16) ||
                                        chk.recordedAt}
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono tabular-nums">
                                      {chk.recordedTempC !== null
                                        ? `${chk.recordedTempC}°C`
                                        : '—'}
                                    </td>
                                    {(showBrixCol || showPhCol) && (
                                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                                        {showBrixCol && showPhCol ? (
                                          <>
                                            {chk.recordedBrix !== null
                                              ? `${chk.recordedBrix}%`
                                              : '—'}{' '}
                                            /{' '}
                                            {chk.recordedPh !== null ? chk.recordedPh : '—'}
                                          </>
                                        ) : showBrixCol ? (
                                          chk.recordedBrix !== null
                                            ? `${chk.recordedBrix}%`
                                            : '—'
                                        ) : chk.recordedPh !== null ? (
                                          chk.recordedPh
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                    )}
                                    {showAwColumn && (
                                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                                        {chk.recordedAw !== null &&
                                        chk.recordedAw !== undefined
                                          ? chk.recordedAw.toFixed(3)
                                          : '—'}
                                      </td>
                                    )}
                                    <td className="py-2 px-3 text-right font-mono tabular-nums">
                                      {weightKg !== null ? `${weightKg}kg` : '—'}
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono tabular-nums text-[11px] text-slate-700 whitespace-nowrap">
                                      {chk.recordedViscosityCp ?? '—'} cP /{' '}
                                      {chk.recordedSpeedRpm ?? '—'} rpm /{' '}
                                      {chk.recordedPressureBar ?? '—'} bar
                                    </td>
                                    {showSpecParamsColumn && (
                                      <td className="py-2 px-3 text-[11px]">
                                        {chk.batchCheckReadings &&
                                        chk.batchCheckReadings.length > 0 ? (
                                          <div className="space-y-0.5">
                                            {chk.batchCheckReadings.map((r) => (
                                              <div
                                                key={r.paramId}
                                                className="font-mono tabular-nums"
                                              >
                                                <span className="text-slate-600">
                                                  {r.name}:
                                                </span>{' '}
                                                <span
                                                  className={
                                                    r.withinSpec
                                                      ? 'text-slate-900 font-medium'
                                                      : 'text-red-700 font-semibold'
                                                  }
                                                >
                                                  {r.value}
                                                  {r.unit ? ` ${r.unit}` : ''}
                                                </span>
                                              </div>
                                            ))}
                                          </div>
                                        ) : (
                                          <span className="text-slate-400">—</span>
                                        )}
                                      </td>
                                    )}
                                    <td className="py-2 px-3 text-slate-600">
                                      <div className="font-mono text-[11px]">
                                        <span className="font-semibold text-slate-800">
                                          {chk.source || 'Manual'}
                                        </span>{' '}
                                        ({chk.sensorCode})
                                      </div>
                                      <div className="text-[11px] text-slate-500">
                                        {chk.operator}
                                      </div>
                                    </td>
                                    <td className="py-2 px-3">
                                      <div
                                        className={`font-semibold ${
                                          chk.withinSpec
                                            ? 'text-emerald-700'
                                            : 'text-red-700'
                                        }`}
                                      >
                                        {chk.withinSpec ? 'In Spec' : 'OUT OF SPEC'}
                                      </div>
                                      {(chk.deviationRecord || chk.notes) && (
                                        <div className="text-[11px] text-slate-600 max-w-[200px]">
                                          {chk.deviationRecord ? `${chk.deviationRecord} · ` : ''}
                                          {chk.notes}
                                        </div>
                                      )}
                                    </td>
                                    {!isLockedForUser && (
                                      <td className="py-2 px-3 text-right whitespace-nowrap">
                                        {isConfirmingDelete ? (
                                          <span className="inline-flex items-center gap-2">
                                            <button
                                              type="button"
                                              disabled={busy}
                                              onClick={() =>
                                                void handleDeleteProcessCheck(checkKey)
                                              }
                                              className="px-2 py-0.5 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 rounded"
                                            >
                                              Confirm Delete
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setConfirmDeleteCheckKey(null)
                                              }
                                              className="px-2 py-0.5 text-[11px] text-slate-600 hover:text-slate-900 border border-slate-200 rounded bg-white"
                                            >
                                              Cancel
                                            </button>
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1.5">
                                            <button
                                              type="button"
                                              onClick={() =>
                                                startEditProcessCheck(chk, idx)
                                              }
                                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:border-teal-600 hover:text-teal-700 rounded transition-colors"
                                            >
                                              <Edit3 className="w-3 h-3" />
                                              Edit
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setEditingCheckKey(null);
                                                setEditCheckDraft(null);
                                                setConfirmDeleteCheckKey(checkKey);
                                              }}
                                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-700 bg-white border border-slate-200 hover:border-red-300 hover:bg-red-50 rounded transition-colors"
                                            >
                                              <Trash2 className="w-3 h-3" />
                                              Delete
                                            </button>
                                          </span>
                                        )}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Inline Edit Process Reading Form */}
                      {editingCheckKey &&
                        editCheckDraft &&
                        selectedFormula &&
                        !isLockedForUser && (
                          <form
                            onSubmit={(e) => void handleSaveEditedProcessCheck(e)}
                            className={`p-4 bg-white border rounded-md space-y-3 ${
                              editOosReasons.length > 0 ? 'border-red-400' : 'border-teal-300'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-slate-900">
                                Edit Time Reading #{editCheckDraft.slotNumber}
                              </span>
                              <div className="flex items-center gap-2">
                                {lineSensors.slice(0, 1).map((s) => (
                                  <button
                                    key={s.id}
                                    type="button"
                                    onClick={() =>
                                      setEditCheckDraft((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              tempC: s.currentTempC.toFixed(1),
                                              sensorCode: s.sensorCode,
                                              source: 'Sensor',
                                              readingTime:
                                                prev.readingTime || getNowStamp(),
                                            }
                                          : null
                                      )
                                    }
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded"
                                  >
                                    <Thermometer className="w-3 h-3" />
                                    Pull {s.sensorCode} ({s.currentTempC.toFixed(1)}°C)
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingCheckKey(null);
                                    setEditCheckDraft(null);
                                    setStep5Error(null);
                                  }}
                                  className="p-1 text-slate-400 hover:text-slate-700 rounded"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            </div>

                            {editOosReasons.length > 0 && (
                              <div className="flex items-center gap-2 border border-red-300 bg-red-50 text-red-800 rounded px-3 py-2 text-xs font-medium">
                                <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
                                <span>
                                  Out-of-spec detected ({editOosReasons.join(', ')}) — operator note or deviation record is required.
                                </span>
                              </div>
                            )}

                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Time *
                                </label>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, readingTime: getNowStamp() } : null
                                    )
                                  }
                                  className={`w-full inline-flex items-center justify-center gap-1.5 border rounded px-2 py-1.5 text-xs font-mono tabular-nums font-semibold transition-colors whitespace-nowrap ${
                                    editCheckDraft.readingTime.trim()
                                      ? 'border-emerald-500 bg-emerald-50/50 text-emerald-800'
                                      : 'border-amber-300 bg-amber-50/50 text-amber-800'
                                  }`}
                                >
                                  <Clock className="w-3.5 h-3.5 shrink-0" />
                                  {editCheckDraft.readingTime.trim() || 'Tap Time'}
                                </button>
                              </div>
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Source
                                </label>
                                <select
                                  value={editCheckDraft.source}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev
                                        ? {
                                            ...prev,
                                            source: e.target.value as ReadingSource,
                                          }
                                        : null
                                    )
                                  }
                                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs bg-white"
                                >
                                  <option value="Manual">Manual</option>
                                  <option value="Sensor">Sensor</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Temp (°C)
                                </label>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={editCheckDraft.tempC}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, tempC: e.target.value } : null
                                    )
                                  }
                                  className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                    checkFieldOut(editCheckDraft.tempC, 'temperature')
                                      ? 'border-red-500 bg-red-50/40 text-red-700'
                                      : 'border-slate-200'
                                  }`}
                                />
                              </div>
                              {showBrixField && (
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Brix (%){specBrixRequired ? ' *' : ''}
                                  </label>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={editCheckDraft.brix}
                                    onChange={(e) =>
                                      setEditCheckDraft((prev) =>
                                        prev ? { ...prev, brix: e.target.value } : null
                                      )
                                    }
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                      checkFieldOut(
                                        editCheckDraft.brix,
                                        'brix',
                                        linkedBatchCheckSpec?.brixMin,
                                        linkedBatchCheckSpec?.brixMax
                                      )
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200'
                                    }`}
                                  />
                                </div>
                              )}
                              {showPhField && (
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    pH{specPhRequired ? ' *' : ''}
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={editCheckDraft.ph}
                                    onChange={(e) =>
                                      setEditCheckDraft((prev) =>
                                        prev ? { ...prev, ph: e.target.value } : null
                                      )
                                    }
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                      checkFieldOut(
                                        editCheckDraft.ph,
                                        'ph',
                                        linkedBatchCheckSpec?.phMin,
                                        linkedBatchCheckSpec?.phMax
                                      )
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200'
                                    }`}
                                  />
                                </div>
                              )}
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Weight (kg)
                                </label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={editCheckDraft.weightKg}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, weightKg: e.target.value } : null
                                    )
                                  }
                                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Viscosity (cP)
                                </label>
                                <input
                                  type="number"
                                  step="1"
                                  value={editCheckDraft.viscosityCp}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, viscosityCp: e.target.value } : null
                                    )
                                  }
                                  className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                    checkFieldOut(editCheckDraft.viscosityCp, 'viscosity')
                                      ? 'border-red-500 bg-red-50/40 text-red-700'
                                      : 'border-slate-200'
                                  }`}
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Speed (RPM)
                                </label>
                                <input
                                  type="number"
                                  step="1"
                                  value={editCheckDraft.speedRpm}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, speedRpm: e.target.value } : null
                                    )
                                  }
                                  className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                    checkFieldOut(editCheckDraft.speedRpm, 'speed')
                                      ? 'border-red-500 bg-red-50/40 text-red-700'
                                      : 'border-slate-200'
                                  }`}
                                />
                              </div>
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Pressure (bar)
                                </label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={editCheckDraft.pressureBar}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, pressureBar: e.target.value } : null
                                    )
                                  }
                                  className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                    checkFieldOut(editCheckDraft.pressureBar, 'pressure')
                                      ? 'border-red-500 bg-red-50/40 text-red-700'
                                      : 'border-slate-200'
                                  }`}
                                />
                              </div>
                              {showAwField && (
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Aw{specAwRequired ? ' *' : ''}
                                  </label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={editCheckDraft.aw}
                                    onChange={(e) =>
                                      setEditCheckDraft((prev) =>
                                        prev ? { ...prev, aw: e.target.value } : null
                                      )
                                    }
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                      checkFieldOut(
                                        editCheckDraft.aw,
                                        'aw',
                                        linkedBatchCheckSpec?.awMin,
                                        linkedBatchCheckSpec?.awMax
                                      )
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200'
                                    }`}
                                  />
                                </div>
                              )}
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-1">
                                  Duration (min)
                                </label>
                                <input
                                  type="number"
                                  value={editCheckDraft.durationMin}
                                  onChange={(e) =>
                                    setEditCheckDraft((prev) =>
                                      prev ? { ...prev, durationMin: e.target.value } : null
                                    )
                                  }
                                  className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                                />
                              </div>
                            </div>

                            {linkedBatchCheckSpec &&
                              (linkedBatchCheckSpec.additionalParams || []).length > 0 && (
                                <div className="pt-2 border-t border-slate-100 space-y-2">
                                  <div className="text-[11px] font-semibold text-slate-700">
                                    Required Batch Check Parameters ({linkedBatchCheckSpec.productCategory})
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                    {linkedBatchCheckSpec.additionalParams.map((param) => {
                                      const val =
                                        editCheckDraft.specParamValues[param.id] || '';
                                      const st = evalRangeStatus(
                                        val,
                                        param.minTarget,
                                        param.maxTarget
                                      );
                                      return (
                                        <div key={param.id}>
                                          <label className="block text-[11px] text-slate-600 mb-1">
                                            {param.name}
                                            {param.unit ? ` (${param.unit})` : ''} *{' '}
                                            <span className="font-mono text-slate-400">
                                              [{formatCheckRange(
                                                param.minTarget,
                                                param.maxTarget,
                                                param.unit === 'SG' ? 2 : 1,
                                                param.unit ? ` ${param.unit}` : ''
                                              )}]
                                            </span>
                                          </label>
                                          <input
                                            type="text"
                                            value={val}
                                            onChange={(e) =>
                                              setEditCheckDraft((prev) =>
                                                prev
                                                  ? {
                                                      ...prev,
                                                      specParamValues: {
                                                        ...prev.specParamValues,
                                                        [param.id]: e.target.value,
                                                      },
                                                    }
                                                  : null
                                              )
                                            }
                                            className={`w-full border rounded px-2.5 py-1.5 text-xs font-mono bg-white ${
                                              st === 'out'
                                                ? 'border-red-500 bg-red-50/40 text-red-700'
                                                : st === 'ok'
                                                  ? 'border-emerald-500 text-slate-900'
                                                  : 'border-amber-300 text-slate-900'
                                            }`}
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}

                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="text"
                                value={editCheckDraft.deviationRecord}
                                onChange={(e) =>
                                  setEditCheckDraft((prev) =>
                                    prev ? { ...prev, deviationRecord: e.target.value } : null
                                  )
                                }
                                placeholder="Deviation ID / Corrective action (req if out-of-spec)"
                                className={`w-64 border rounded px-2.5 py-1.5 text-xs bg-white ${
                                  editOosReasons.length > 0 &&
                                  !editCheckDraft.notes.trim() &&
                                  !editCheckDraft.deviationRecord.trim()
                                    ? 'border-red-500 bg-red-50/40'
                                    : 'border-slate-200'
                                }`}
                              />
                              <input
                                type="text"
                                value={editCheckDraft.notes}
                                onChange={(e) =>
                                  setEditCheckDraft((prev) =>
                                    prev ? { ...prev, notes: e.target.value } : null
                                  )
                                }
                                placeholder="Operator notes..."
                                className="flex-1 min-w-[180px] border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCheckKey(null);
                                  setEditCheckDraft(null);
                                }}
                                className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 hover:text-slate-900 rounded"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                disabled={busy}
                                className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded"
                              >
                                {busy ? 'Updating...' : 'Save Changes'}
                              </button>
                            </div>
                          </form>
                        )}

                      {canEditStep5 && selectedFormula && (
                        <div className="p-4 bg-[#F7F8FA] border border-slate-200 rounded-md space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="text-xs font-semibold text-slate-900">
                                Log Process Step Reading (1-by-1 Record Entry)
                              </span>
                              <div className="text-[11px] font-mono tabular-nums mt-0.5 text-slate-600">
                                {hasThreeSaved
                                  ? `All 3 required time readings logged (${savedCount} total)`
                                  : `${savedCount}/3 time readings saved · Logging Reading #${nextSlotNumber}`}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {hasHiddenCategoryMetrics && (
                                <button
                                  type="button"
                                  onClick={() => setShowOptionalStep5Metrics((v) => !v)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 hover:border-teal-600 text-slate-700 rounded transition-colors whitespace-nowrap"
                                >
                                  {showOptionalStep5Metrics
                                    ? `Hide Optional (${unconfiguredMetricLabels.join(' / ')})`
                                    : `+ Optional (${unconfiguredMetricLabels.join(' / ')})`}
                                </button>
                              )}
                              {lineSensors.slice(0, 2).map((s) => (
                                <button
                                  key={s.id}
                                  type="button"
                                  onClick={() => handlePullLiveSensor(s)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 hover:border-teal-600 text-slate-700 rounded transition-colors whitespace-nowrap"
                                >
                                  <Thermometer className="w-3.5 h-3.5 text-teal-700" />
                                  Pull {s.sensorCode} ({s.currentTempC.toFixed(1)}°C)
                                </button>
                              ))}
                            </div>
                          </div>

                          {hasThreeSaved && (
                            <div className="flex flex-wrap items-center justify-between gap-2 bg-emerald-50/40 border border-emerald-200 rounded px-3 py-2.5 text-xs">
                              <div className="flex items-center gap-2 text-emerald-800 font-medium">
                                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                                <span>
                                  3 time reading requirement satisfied ({savedCount} time readings recorded).
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => setShowExtraReadingForm((v) => !v)}
                                className="text-xs font-medium text-teal-800 hover:text-teal-900 whitespace-nowrap"
                              >
                                {showExtraReadingForm
                                  ? 'Hide Additional Reading'
                                  : '+ Log Additional Time Reading'}
                              </button>
                            </div>
                          )}

                          {(!hasThreeSaved || showExtraReadingForm) && (
                            <form
                              onSubmit={(e) => void handleLogSingleProcessCheck(e)}
                              className={`border rounded p-3 space-y-2.5 transition-colors ${cardBorder}`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="font-mono font-semibold text-slate-900">
                                    Time Reading #{nextSlotNumber}
                                  </span>
                                  <span className="font-mono text-[11px] text-slate-500">
                                    {nextSlotNumber <= 3
                                      ? `(Required ${nextSlotNumber} of 3)`
                                      : '(Additional)'}
                                  </span>
                                </div>
                                <span
                                  className={`font-mono text-[11px] font-semibold ${statusTextTone}`}
                                >
                                  {!hasDraftTime
                                    ? 'Tap Time Req'
                                    : missingLinkedSpecField
                                      ? 'Spec Params Req'
                                      : !hasDraftVal
                                        ? 'Reading Req'
                                        : draftNeedsDeviationNote
                                          ? 'OOS Note Req'
                                          : draftAnyOutOfSpec
                                            ? 'Out of Spec (Documented)'
                                            : 'Ready'}
                                </span>
                              </div>

                              {draftAnyOutOfSpec && (
                                <div className="flex items-center gap-2 border border-red-300 bg-red-50 text-red-800 rounded px-3 py-2 text-xs font-medium">
                                  <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
                                  <span>
                                    Out of Spec: {draftOosReasons.join(', ')} — enter an operator note or deviation record to save.
                                  </span>
                                </div>
                              )}

                              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Time *
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateReadingDraftField(
                                        'readingTime',
                                        getNowStamp()
                                      )
                                    }
                                    aria-label={`Time Reading ${nextSlotNumber} Tap Time`}
                                    className={`w-full inline-flex items-center justify-center gap-1.5 border rounded px-2 py-1.5 text-xs font-mono tabular-nums font-semibold transition-colors whitespace-nowrap ${
                                      hasDraftTime
                                        ? 'border-emerald-500 bg-emerald-50/50 text-emerald-800 hover:bg-emerald-100/60'
                                        : 'border-amber-300 bg-amber-50/50 text-amber-800 hover:bg-amber-100/60'
                                    }`}
                                  >
                                    <Clock className="w-3.5 h-3.5 shrink-0" />
                                    {hasDraftTime ? readingDraft.readingTime : 'Tap Time'}
                                  </button>
                                </div>
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Source
                                  </label>
                                  <select
                                    value={readingDraft.source}
                                    onChange={(e) =>
                                      updateReadingDraftField(
                                        'source',
                                        e.target.value as ReadingSource
                                      )
                                    }
                                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs bg-white"
                                  >
                                    <option value="Manual">Manual</option>
                                    <option value="Sensor">Sensor</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Temp (°C)
                                  </label>
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={readingDraft.tempC}
                                    onChange={(e) =>
                                      updateReadingDraftField('tempC', e.target.value)
                                    }
                                    placeholder={String(formulaParamMap.temperature?.target ?? '92.0')}
                                    aria-label={`Time Reading ${nextSlotNumber} Temp`}
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white focus:outline-none ${
                                      draftTempOut
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : readingDraft.tempC.trim() !== ''
                                          ? 'border-emerald-500 text-slate-900'
                                          : !hasDraftVal
                                            ? 'border-amber-300 text-slate-900'
                                            : 'border-slate-200 text-slate-900'
                                    }`}
                                  />
                                </div>
                                {showBrixField && (
                                  <div>
                                    <label className="block text-[11px] text-slate-500 mb-1">
                                      Brix (%){specBrixRequired ? ' *' : ''}
                                    </label>
                                    <input
                                      type="number"
                                      step="0.1"
                                      value={readingDraft.brix}
                                      onChange={(e) =>
                                        updateReadingDraftField('brix', e.target.value)
                                      }
                                      placeholder={String(formulaParamMap.brix?.target ?? '12.5')}
                                      className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white focus:outline-none ${
                                        draftBrixOut
                                          ? 'border-red-500 bg-red-50/40 text-red-700'
                                          : readingDraft.brix.trim()
                                            ? 'border-emerald-500 text-slate-900'
                                            : specBrixRequired
                                              ? 'border-amber-300 text-slate-900'
                                              : 'border-slate-200 text-slate-900'
                                      }`}
                                    />
                                  </div>
                                )}
                                {showPhField && (
                                  <div>
                                    <label className="block text-[11px] text-slate-500 mb-1">
                                      pH{specPhRequired ? ' *' : ''}
                                    </label>
                                    <input
                                      type="number"
                                      step="0.01"
                                      value={readingDraft.ph}
                                      onChange={(e) =>
                                        updateReadingDraftField('ph', e.target.value)
                                      }
                                      placeholder={String(formulaParamMap.ph?.target ?? '4.15')}
                                      className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white focus:outline-none ${
                                        draftPhOut
                                          ? 'border-red-500 bg-red-50/40 text-red-700'
                                          : readingDraft.ph.trim()
                                            ? 'border-emerald-500 text-slate-900'
                                            : specPhRequired
                                              ? 'border-amber-300 text-slate-900'
                                              : 'border-slate-200 text-slate-900'
                                      }`}
                                    />
                                  </div>
                                )}
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Weight (kg)
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={readingDraft.weightKg}
                                    onChange={(e) =>
                                      updateReadingDraftField('weightKg', e.target.value)
                                    }
                                    placeholder={String(formulaParamMap.weight?.target ?? '0.50')}
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white focus:outline-none ${
                                      draftWeightOut
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200 text-slate-900'
                                    }`}
                                  />
                                </div>
                              </div>

                              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Viscosity (cP)
                                  </label>
                                  <input
                                    type="number"
                                    step="1"
                                    value={readingDraft.viscosityCp}
                                    onChange={(e) =>
                                      updateReadingDraftField('viscosityCp', e.target.value)
                                    }
                                    placeholder={String(formulaParamMap.viscosity?.target ?? '1600')}
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                      draftViscOut
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200'
                                    }`}
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Speed (RPM)
                                  </label>
                                  <input
                                    type="number"
                                    step="1"
                                    value={readingDraft.speedRpm}
                                    onChange={(e) =>
                                      updateReadingDraftField('speedRpm', e.target.value)
                                    }
                                    placeholder={String(formulaParamMap.speed?.target ?? '65')}
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                      draftSpeedOut
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200'
                                    }`}
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Pressure (bar)
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={readingDraft.pressureBar}
                                    onChange={(e) =>
                                      updateReadingDraftField('pressureBar', e.target.value)
                                    }
                                    placeholder={String(formulaParamMap.pressure?.target ?? '1.20')}
                                    className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                      draftPressureOut
                                        ? 'border-red-500 bg-red-50/40 text-red-700'
                                        : 'border-slate-200'
                                    }`}
                                  />
                                </div>
                                {showAwField && (
                                  <div>
                                    <label className="block text-[11px] text-slate-500 mb-1">
                                      Aw{specAwRequired ? ' *' : ''}
                                    </label>
                                    <input
                                      type="number"
                                      step="0.001"
                                      min="0"
                                      max="1"
                                      value={readingDraft.aw}
                                      onChange={(e) =>
                                        updateReadingDraftField('aw', e.target.value)
                                      }
                                      placeholder={String(formulaParamMap.aw?.target ?? '0.920')}
                                      className={`w-full border rounded px-2 py-1.5 text-xs font-mono bg-white ${
                                        draftAwOut
                                          ? 'border-red-500 bg-red-50/40 text-red-700'
                                          : 'border-slate-200'
                                      }`}
                                    />
                                  </div>
                                )}
                                <div>
                                  <label className="block text-[11px] text-slate-500 mb-1">
                                    Duration (min)
                                  </label>
                                  <input
                                    type="number"
                                    value={readingDraft.durationMin}
                                    onChange={(e) =>
                                      updateReadingDraftField('durationMin', e.target.value)
                                    }
                                    placeholder="25"
                                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                                  />
                                </div>
                              </div>

                              {linkedBatchCheckSpec &&
                                (linkedBatchCheckSpec.additionalParams || []).length > 0 && (
                                  <div className="pt-2 border-t border-slate-100 space-y-2">
                                    <div className="flex items-center justify-between gap-2 text-[11px]">
                                      <span className="font-semibold text-slate-800">
                                        Required Batch Check Parameters ({linkedBatchCheckSpec.productCategory})
                                      </span>
                                      <span className="text-slate-500">
                                        Must be read with each Step 5 record
                                      </span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                      {linkedBatchCheckSpec.additionalParams.map((param) => {
                                        const val =
                                          readingDraft.specParamValues[param.id] || '';
                                        const st = evalRangeStatus(
                                          val,
                                          param.minTarget,
                                          param.maxTarget
                                        );
                                        return (
                                          <div key={param.id}>
                                            <label className="block text-[11px] text-slate-600 mb-1">
                                              {param.name}
                                              {param.unit ? ` (${param.unit})` : ''} *{' '}
                                              <span className="font-mono text-slate-400">
                                                [{formatCheckRange(
                                                  param.minTarget,
                                                  param.maxTarget,
                                                  param.unit === 'SG' ? 2 : 1,
                                                  param.unit ? ` ${param.unit}` : ''
                                                )}]
                                              </span>
                                            </label>
                                            <input
                                              type="text"
                                              value={val}
                                              onChange={(e) => {
                                                setStep5Error(null);
                                                const nextVal = e.target.value;
                                                setReadingDraft((prev) => ({
                                                  ...prev,
                                                  specParamValues: {
                                                    ...prev.specParamValues,
                                                    [param.id]: nextVal,
                                                  },
                                                }));
                                              }}
                                              placeholder={
                                                param.targetNote || `Read ${param.name}`
                                              }
                                              className={`w-full border rounded px-2.5 py-1.5 text-xs font-mono bg-white focus:outline-none ${
                                                st === 'out'
                                                  ? 'border-red-500 bg-red-50/40 text-red-700'
                                                  : st === 'ok'
                                                    ? 'border-emerald-500 text-slate-900'
                                                    : 'border-amber-300 text-slate-900'
                                              }`}
                                            />
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}

                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="text"
                                  value={readingDraft.deviationRecord}
                                  onChange={(e) =>
                                    updateReadingDraftField(
                                      'deviationRecord',
                                      e.target.value
                                    )
                                  }
                                  placeholder="Deviation ID / CAPA (req if OOS)"
                                  className={`w-56 border rounded px-2.5 py-1.5 text-xs bg-white ${
                                    draftNeedsDeviationNote
                                      ? 'border-red-500 bg-red-50/40'
                                      : 'border-slate-200'
                                  }`}
                                />
                                <input
                                  type="text"
                                  value={readingDraft.notes}
                                  onChange={(e) =>
                                    updateReadingDraftField('notes', e.target.value)
                                  }
                                  placeholder="Operator check notes (viscosity, seal check, aroma)..."
                                  className={`flex-1 min-w-[180px] border rounded px-2.5 py-1.5 text-xs bg-white ${
                                    draftNeedsDeviationNote
                                      ? 'border-red-500 bg-red-50/40'
                                      : 'border-slate-200'
                                  }`}
                                />
                                <button
                                  type="submit"
                                  disabled={busy}
                                  className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md whitespace-nowrap"
                                >
                                  {busy
                                    ? 'Saving Reading...'
                                    : `Record Time Reading #${nextSlotNumber}`}
                                </button>
                              </div>

                              {step5Error && (
                                <div className="flex items-center gap-2 border border-red-300 bg-red-50/70 text-red-800 rounded px-3 py-2 text-xs font-medium">
                                  <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
                                  <span>{step5Error}</span>
                                </div>
                              )}
                            </form>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Steps 6–9: Output Reporting, Loss Reasons, QC Review (Pass/Hold/Reject), Retained Samples & Closure */}
              <div className="p-5 space-y-4">
                <h3 className="text-sm font-semibold text-slate-900">
                  Steps 6–9. Output, Losses, QC Review &amp; Closure
                </h3>

                {/* Step 6 Output Form */}
                {(selectedBatch.status === 'In Progress' ||
                  (isClosed && !isLockedForUser) ||
                  (editingOutput && !isLockedForUser && canExecuteBatchSteps)) && (
                  <form
                    onSubmit={(e) => void handleReportOutput(e)}
                    className="p-4 bg-[#F7F8FA] rounded-md space-y-3 border border-slate-200"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-800">
                        Step 6: {selectedBatch.goodQty > 0 ? 'Update' : 'Report'} Finished Product Output &amp; Loss Reason Codes
                      </div>
                      {editingOutput && (
                        <button
                          type="button"
                          onClick={() => setEditingOutput(false)}
                          className="px-2 py-1 text-[11px] font-medium text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 rounded"
                        >
                          Cancel Edit
                        </button>
                      )}
                    </div>
                    {selectedBatch.processChecks.length < 3 && (
                      <div className="flex items-center gap-2 border border-amber-300 bg-amber-50/70 text-amber-800 rounded px-3 py-2 text-xs font-medium">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-amber-700" />
                        <span>
                          Complete 3 time reading records in Step 5 before reporting batch output ({selectedBatch.processChecks.length}/3 logged).
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Good ({selectedBatch.outputUnit})
                        </label>
                        <input
                          type="number"
                          required
                          value={outGood}
                          onChange={(e) => setOutGood(e.target.value)}
                          placeholder={String(Math.round(selectedBatch.plannedQty * 0.97))}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Output Mass
                        </label>
                        <div className="flex gap-1">
                          <input
                            type="number"
                            step="0.1"
                            value={outMassQty}
                            onChange={(e) => setOutMassQty(e.target.value)}
                            placeholder="485"
                            className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                          />
                          <select
                            value={outMassUnit}
                            onChange={(e) =>
                              setOutMassUnit(e.target.value as 'kg' | 'L')
                            }
                            className="border border-slate-200 rounded px-1.5 py-1.5 text-xs bg-white"
                          >
                            <option value="kg">kg</option>
                            <option value="L">L</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Pack Size
                        </label>
                        <input
                          type="text"
                          value={outPackSize}
                          onChange={(e) => setOutPackSize(e.target.value)}
                          placeholder="500g jar"
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Rejected
                        </label>
                        <input
                          type="number"
                          value={outRejected}
                          onChange={(e) => setOutRejected(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          QC Samples
                        </label>
                        <input
                          type="number"
                          value={outSample}
                          onChange={(e) => setOutSample(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Rework
                        </label>
                        <input
                          type="number"
                          value={outRework}
                          onChange={(e) => setOutRework(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          By-Product
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={outByProduct}
                          onChange={(e) => setOutByProduct(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Waste (kg)
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          value={outWasteKg}
                          onChange={(e) => setOutWasteKg(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                    </div>

                    {/* Mandatory Reason Codes for Any Loss > 0 */}
                    {(Number(outRejected) > 0 ||
                      Number(outRework) > 0 ||
                      Number(outByProduct) > 0 ||
                      Number(outWasteKg) > 0) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-1">
                        {Number(outRejected) > 0 && (
                          <div>
                            <label className="block text-[11px] text-slate-600 mb-1">
                              Reject Reason Code *
                            </label>
                            <select
                              value={outRejectReason}
                              onChange={(e) => setOutRejectReason(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                            >
                              {LOSS_REASON_OPTIONS.map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {Number(outRework) > 0 && (
                          <div>
                            <label className="block text-[11px] text-slate-600 mb-1">
                              Rework Reason Code *
                            </label>
                            <select
                              value={outReworkReason}
                              onChange={(e) => setOutReworkReason(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                            >
                              {LOSS_REASON_OPTIONS.map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {Number(outByProduct) > 0 && (
                          <div>
                            <label className="block text-[11px] text-slate-600 mb-1">
                              By-Product Reason Code *
                            </label>
                            <select
                              value={outByProductReason}
                              onChange={(e) => setOutByProductReason(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                            >
                              {LOSS_REASON_OPTIONS.map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {Number(outWasteKg) > 0 && (
                          <div>
                            <label className="block text-[11px] text-slate-600 mb-1">
                              Waste Reason Code *
                            </label>
                            <select
                              value={outWasteReason}
                              onChange={(e) => setOutWasteReason(e.target.value)}
                              className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs font-mono bg-white"
                            >
                              {LOSS_REASON_OPTIONS.map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={
                        busy ||
                        !canExecuteBatchSteps ||
                        (selectedBatch.processChecks.length < 3 && !isClosed)
                      }
                      className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md whitespace-nowrap"
                    >
                      Submit Output &amp; Mark Completed
                    </button>
                  </form>
                )}

                {/* Output, Mass & Costing Summary Grid */}
                {selectedBatch.goodQty > 0 && (
                  <div className="space-y-2 py-3 border-y border-slate-100">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                      <div>
                        <div className="text-xs text-slate-500">Good Output / Yield</div>
                        <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                          {selectedBatch.goodQty.toLocaleString()} {selectedBatch.outputUnit} ·{' '}
                          <span
                            className={
                              selectedBatch.yieldPct >= 95
                                ? 'text-emerald-700'
                                : 'text-amber-700'
                            }
                          >
                            {selectedBatch.yieldPct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Output Mass &amp; Pack</div>
                        <div className="mt-1 font-mono text-sm text-slate-900 tabular-nums">
                          {selectedBatch.outputMassQty || 0}{' '}
                          {selectedBatch.outputMassUnit || 'kg'} ·{' '}
                          {selectedBatch.packSize || selectedFormula?.packSize || '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">
                          Reject / Rework / By-Prod / Waste
                        </div>
                        <div className="mt-1 font-mono text-sm text-slate-900 tabular-nums">
                          {selectedBatch.rejectedQty} / {selectedBatch.reworkQty} /{' '}
                          {selectedBatch.byProductQty || 0} / {selectedBatch.wasteKg}kg
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Materials + Labor + OH</div>
                        <div className="mt-1 font-mono text-sm text-slate-900 tabular-nums">
                          {formatCurrency(
                            selectedBatch.materialCost +
                              selectedBatch.laborCost +
                              selectedBatch.overheadCost
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500">Cost per Unit</div>
                        <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                          {formatCurrency(selectedBatch.unitCost)}/
                          {selectedBatch.outputUnit.slice(0, -1) || 'unit'}
                        </div>
                      </div>
                    </div>

                    {((selectedBatch.lossReasonCodes && selectedBatch.lossReasonCodes.length > 0) ||
                      (!isLockedForUser &&
                        canExecuteBatchSteps &&
                        selectedBatch.status !== 'In Progress' &&
                        !isClosed &&
                        !editingOutput)) && (
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px]">
                        <div className="flex flex-wrap items-center gap-2">
                          {selectedBatch.lossReasonCodes &&
                            selectedBatch.lossReasonCodes.length > 0 && (
                              <>
                                <span className="text-slate-500 font-medium">Loss Reasons:</span>
                                {selectedBatch.lossReasonCodes.map((lr, idx) => (
                                  <span
                                    key={`${lr.lossType}-${idx}`}
                                    className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-slate-800"
                                  >
                                    {lr.lossType}: {lr.quantity} {lr.unit} [{lr.reasonCode}]
                                  </span>
                                ))}
                              </>
                            )}
                        </div>
                        {!isLockedForUser &&
                          canExecuteBatchSteps &&
                          selectedBatch.status !== 'In Progress' &&
                          !isClosed &&
                          !editingOutput && (
                            <button
                              type="button"
                              onClick={() => {
                                syncOutputFormFromBatch(selectedBatch, selectedFormula);
                                setEditingOutput(true);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap"
                            >
                              <Edit3 className="w-3 h-3" />
                              Edit Reported Output
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                )}

                {/* Transition Completed -> QC Review (when QC has not passed yet) */}
                {selectedBatch.status === 'Completed' &&
                  selectedBatch.qcStatus !== 'Passed' && (
                    <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-teal-50/50 border border-teal-200 rounded-md">
                      <div>
                        <div className="text-xs font-semibold text-teal-950">
                          Batch Completed — Ready for QC Review
                        </div>
                        <p className="text-xs text-teal-800 mt-0.5">
                          Move batch into QC Review to record in-process/final results, retained samples, and Pass / Hold / Reject disposition.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleMoveToQcReview()}
                        className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
                      >
                        Move to QC Review
                      </button>
                    </div>
                  )}

                {/* Steps 7–8: QC Review, Retained Samples & Disposition (Pass / Hold / Reject) */}
                {(selectedBatch.status === 'QC Review' ||
                  selectedBatch.status === 'QC Hold' ||
                  (isClosed && !isLockedForUser)) && (
                  <div className="p-4 bg-amber-50/60 border border-amber-200 rounded-md space-y-3">
                    <div className="flex items-center gap-2 text-amber-900 text-xs font-semibold">
                      <ShieldAlert className="w-4 h-4 text-amber-700" />
                      Step 7–8: QC Review — In-Process / Final Results, Retained Samples &amp; Disposition
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">
                          In-Process QC Summary
                        </label>
                        <input
                          type="text"
                          value={qcInProcessSummary}
                          onChange={(e) => setQcInProcessSummary(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">
                          Final Lab / QC Results
                        </label>
                        <input
                          type="text"
                          value={qcFinalResults}
                          onChange={(e) => setQcFinalResults(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">
                          Destination FG Warehouse Zone
                        </label>
                        <input
                          type="text"
                          value={qcWarehouseZone}
                          onChange={(e) => setQcWarehouseZone(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">
                          Retained Sample Qty
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={qcRetainedQty}
                          onChange={(e) => setQcRetainedQty(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">
                          Retained Sample Code
                        </label>
                        <input
                          type="text"
                          value={qcRetainedCode}
                          onChange={(e) => setQcRetainedCode(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-1">
                          Retained Sample Location
                        </label>
                        <input
                          type="text"
                          value={qcRetainedLocation}
                          onChange={(e) => setQcRetainedLocation(e.target.value)}
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white"
                        />
                      </div>
                      <div className="sm:col-span-2 lg:col-span-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="block text-[11px] font-medium text-slate-700">
                            QC Inspection Notes (Micro, Sensory, Seal Integrity)
                          </label>
                          <div className="flex items-center gap-2">
                            <select
                              aria-label="Quick Note shortcut menu"
                              value=""
                              onChange={(e) => {
                                const picked = e.target.value;
                                if (!picked) return;
                                const trimmed = qcNotes.trim();
                                if (!trimmed || trimmed === DEFAULT_QC_PASS_NOTE) {
                                  setQcNotes(picked);
                                } else {
                                  const parts = trimmed
                                    .split(';')
                                    .map((p) => p.trim())
                                    .filter(Boolean);
                                  if (!parts.some((p) => p.toLowerCase() === picked.toLowerCase())) {
                                    setQcNotes([...parts, picked].join('; '));
                                  }
                                }
                              }}
                              className="border border-amber-300 bg-white text-slate-800 rounded px-2 py-1 text-[11px] font-medium focus:outline-none focus:border-amber-500"
                            >
                              <option value="">Quick Note...</option>
                              {QUICK_QC_DEVIATION_NOTES.map((reason) => (
                                <option key={reason} value={reason}>
                                  + {reason}
                                </option>
                              ))}
                            </select>
                            {qcNotes.trim().length > 0 && (
                              <button
                                type="button"
                                onClick={() => setQcNotes('')}
                                className="text-[11px] font-medium text-slate-500 hover:text-slate-800 px-1.5 py-0.5 rounded hover:bg-amber-100/60"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-medium text-amber-900 mr-0.5">
                            Quick Note:
                          </span>
                          {QUICK_QC_DEVIATION_NOTES.map((reason) => {
                            const existingParts = qcNotes
                              .split(';')
                              .map((p) => p.trim())
                              .filter(Boolean);
                            const isSelected = existingParts.some(
                              (p) => p.toLowerCase() === reason.toLowerCase()
                            );
                            return (
                              <button
                                key={reason}
                                type="button"
                                onClick={() => {
                                  const trimmed = qcNotes.trim();
                                  if (!trimmed || trimmed === DEFAULT_QC_PASS_NOTE) {
                                    setQcNotes(reason);
                                    return;
                                  }
                                  if (isSelected) {
                                    const remaining = existingParts.filter(
                                      (p) => p.toLowerCase() !== reason.toLowerCase()
                                    );
                                    setQcNotes(remaining.join('; '));
                                  } else {
                                    setQcNotes([...existingParts, reason].join('; '));
                                  }
                                }}
                                className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap ${
                                  isSelected
                                    ? 'bg-amber-200/80 border-amber-500 text-amber-950'
                                    : 'bg-white border-amber-200 text-slate-700 hover:border-amber-400 hover:bg-amber-50'
                                }`}
                              >
                                {isSelected ? `✓ ${reason}` : `+ ${reason}`}
                              </button>
                            );
                          })}
                        </div>
                        <input
                          type="text"
                          value={qcNotes}
                          onChange={(e) => setQcNotes(e.target.value)}
                          placeholder="Select a Quick Note above or type QC inspection / deviation remarks..."
                          className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:border-amber-500"
                        />
                      </div>
                    </div>
                    {!canExecuteQc ? (
                      <p className="text-xs text-amber-800">
                        Active role ({userRole}) does not have &ldquo;QC Inspection &amp; Disposition&rdquo; tick permission. Enable it in Role Permissions or switch roles.
                      </p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleQcDecision('Passed')}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md whitespace-nowrap"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Pass QC &amp; Post Finished Goods
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleQcDecision('Hold')}
                          className="px-3.5 py-2 text-xs font-medium text-amber-900 bg-white border border-amber-300 hover:bg-amber-100/60 rounded-md whitespace-nowrap"
                        >
                          Place on QC Hold
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleQcDecision('Failed')}
                          className="px-3.5 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-md whitespace-nowrap"
                        >
                          Reject QC
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* QC Summary Readout (if retained samples or results recorded) */}
                {(Number(selectedBatch.retainedSampleQty) > 0 ||
                  selectedBatch.qcFinalResults ||
                  selectedBatch.qcInProcessSummary) && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-[#F7F8FA] border border-slate-200 rounded text-xs">
                    <div>
                      <div className="text-[11px] text-slate-500">In-Process QC</div>
                      <div className="text-slate-900 mt-0.5">
                        {selectedBatch.qcInProcessSummary || '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">Final QC Results</div>
                      <div className="text-slate-900 mt-0.5">
                        {selectedBatch.qcFinalResults || '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">Retained Sample</div>
                      <div className="font-mono text-slate-900 mt-0.5">
                        {selectedBatch.retainedSampleQty} units ·{' '}
                        {selectedBatch.retainedSampleCode || '—'}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {selectedBatch.retainedSampleLocation}
                      </div>
                    </div>
                  </div>
                )}

                {/* Step 9: Close & Lock Batch */}
                {selectedBatch.qcStatus === 'Passed' &&
                  selectedBatch.status !== 'Closed' && (
                    <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-emerald-50/50 border border-emerald-200 rounded-md">
                      <div>
                        <div className="text-xs font-semibold text-emerald-900">
                          QC Approved &amp; Finished Goods Posted
                        </div>
                        <p className="text-xs text-emerald-800 mt-0.5">
                          QC passed by {selectedBatch.qcInspector}. Close batch to lock the electronic batch record.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleCloseBatch()}
                        className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap"
                      >
                        Close &amp; Lock Batch
                      </button>
                    </div>
                  )}

                {selectedBatch.status === 'Closed' && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 pt-1">
                    <span>
                      QC Approved by{' '}
                      <strong className="text-slate-900">{selectedBatch.qcInspector}</strong> —{' '}
                      {selectedBatch.qcNotes}
                    </span>
                    <span className="font-mono text-emerald-700 font-medium">
                      Posted to FG · Closed &amp; Locked
                    </span>
                  </div>
                )}
              </div>

              {/* Backward Lot Genealogy Card */}
              <div className="p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-teal-700" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      Backward Lot Genealogy (Finished Lot → Raw Material Lots)
                    </h3>
                  </div>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('traceability')}
                      className="text-xs font-medium text-teal-700 hover:text-teal-800"
                    >
                      Open Full Traceability →
                    </button>
                  )}
                </div>
                <div className="border border-slate-200 rounded-md p-3 bg-[#F7F8FA] text-xs space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-500">Finished Product Lot:</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {linkedFinishedGood
                        ? `${linkedFinishedGood.lotNumber} (${linkedFinishedGood.quantityProduced} ${linkedFinishedGood.unit} · ${linkedFinishedGood.warehouseZone})`
                        : selectedBatch.lotNumber
                          ? `${selectedBatch.lotNumber} (Pending FG release)`
                          : 'Not yet generated'}
                    </span>
                  </div>
                  {selectedBatch.issuedMaterials.length === 0 ? (
                    <div className="text-slate-500 italic">
                      No raw material lots issued yet.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {selectedBatch.issuedMaterials.map((m, idx) => (
                        <div
                          key={`${m.lotNumber}-${idx}`}
                          className="bg-white border border-slate-200 rounded px-3 py-2 flex items-center justify-between gap-2"
                        >
                          <div>
                            <div className="font-mono font-semibold text-slate-900">
                              {m.lotNumber}
                            </div>
                            <div className="text-[11px] text-slate-600">
                              {isConfidentialMasked ? m.materialCode : m.materialName}
                            </div>
                          </div>
                          <div className="text-right font-mono text-[11px]">
                            <div className="font-semibold text-slate-900">
                              {m.actualQty} {m.unit}
                            </div>
                            <div className="text-slate-500">
                              {m.operator} · {m.issuedAt}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Electronic Audit Trail Card */}
              <div className="p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-slate-600" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      Electronic Batch Audit Trail ({selectedBatchAuditLogs.length})
                    </h3>
                  </div>
                  {selectedBatchAuditLogs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded border border-slate-200 text-[11px]">
                        {(
                          [
                            ['all', 'All Events'],
                            ['edits', 'Post-Entry Edits'],
                            ['overrides', 'Closed Overrides'],
                          ] as const
                        ).map(([modeKey, label]) => (
                          <button
                            key={modeKey}
                            type="button"
                            onClick={() => setAuditFilterMode(modeKey)}
                            className={`px-2 py-1 rounded font-medium transition-colors ${
                              auditFilterMode === modeKey
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={auditSearchQuery}
                          onChange={(e) => setAuditSearchQuery(e.target.value)}
                          placeholder="Search field, before/after, user..."
                          className="pl-7 pr-2.5 py-1 text-xs border border-slate-200 rounded bg-white w-52 focus:outline-none focus:border-teal-600"
                        />
                      </div>
                    </div>
                  )}
                </div>
                {(() => {
                  const q = auditSearchQuery.trim().toLowerCase();
                  const filteredAudit = selectedBatchAuditLogs.filter((log) => {
                    if (auditFilterMode === 'overrides' && log.action !== 'CLOSED_BATCH_OVERRIDE') {
                      return false;
                    }
                    if (
                      auditFilterMode === 'edits' &&
                      !(
                        log.action.startsWith('UPDATE_') ||
                        log.action.startsWith('EDIT_') ||
                        log.action.startsWith('DELETE_') ||
                        log.action === 'CLOSED_BATCH_OVERRIDE'
                      )
                    ) {
                      return false;
                    }
                    if (!q) return true;
                    const changes = extractAuditFieldChanges(log.oldValue, log.newValue);
                    const haystack = [
                      log.actorName,
                      log.actorRole,
                      log.action,
                      log.entityType,
                      log.reason || '',
                      ...changes.flatMap((c) => [
                        c.field,
                        c.label,
                        formatAuditValue(c.before),
                        formatAuditValue(c.after),
                      ]),
                    ]
                      .join(' ')
                      .toLowerCase();
                    return haystack.includes(q);
                  });

                  if (selectedBatchAuditLogs.length === 0) {
                    return (
                      <p className="text-xs text-slate-500 italic">
                        No audit entries recorded for this batch yet.
                      </p>
                    );
                  }
                  if (filteredAudit.length === 0) {
                    return (
                      <p className="text-xs text-slate-500 italic">
                        No audit events match the active filter or search term.
                      </p>
                    );
                  }
                  return (
                    <div className="overflow-x-auto border border-slate-200 rounded-md max-h-96 overflow-y-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium sticky top-0 z-10">
                            <th className="py-2 px-3">When</th>
                            <th className="py-2 px-3">Who &amp; Role</th>
                            <th className="py-2 px-3">Action</th>
                            <th className="py-2 px-3">Field Changes (Before → After)</th>
                            <th className="py-2 px-3">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredAudit.map((log) => {
                            const whenStr =
                              typeof log.createdAt === 'string'
                                ? log.createdAt
                                : log.createdAt instanceof Date
                                  ? log.createdAt.toISOString().replace('T', ' ').slice(0, 19)
                                  : String(log.createdAt ?? '');
                            const changes = extractAuditFieldChanges(log.oldValue, log.newValue);
                            return (
                              <tr key={log.id} className="align-top hover:bg-slate-50/70">
                                <td className="py-2 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                                  {whenStr}
                                </td>
                                <td className="py-2 px-3 whitespace-nowrap">
                                  <span className="font-medium text-slate-900">
                                    {log.actorName}
                                  </span>{' '}
                                  <span className="font-mono text-[10px] text-slate-500">
                                    ({log.actorRole})
                                  </span>
                                </td>
                                <td className="py-2 px-3 font-mono text-[11px] text-slate-800 whitespace-nowrap">
                                  <span
                                    className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                                      log.action === 'CLOSED_BATCH_OVERRIDE'
                                        ? 'bg-amber-50 text-amber-900 border-amber-300'
                                        : log.action.startsWith('UPDATE_') ||
                                            log.action.startsWith('DELETE_')
                                          ? 'bg-sky-50 text-sky-900 border-sky-200'
                                          : 'bg-slate-50 text-slate-800 border-slate-200'
                                    }`}
                                  >
                                    {log.action}
                                  </span>
                                  <div className="text-[10px] text-slate-400 mt-0.5">
                                    {log.entityType}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-[11px] text-slate-700 min-w-[260px]">
                                  {changes.length === 0 ? (
                                    <span className="text-slate-400">—</span>
                                  ) : (
                                    <div className="space-y-1">
                                      {changes.map((c) => (
                                        <div key={c.field} className="leading-relaxed">
                                          <span className="font-semibold text-slate-800">
                                            {c.label}:
                                          </span>{' '}
                                          {c.before !== null && (
                                            <>
                                              <span className="font-mono text-red-700 bg-red-50 border border-red-200/80 px-1 py-0.5 rounded">
                                                {formatAuditValue(c.before)}
                                              </span>{' '}
                                              <span className="text-slate-400">→</span>{' '}
                                            </>
                                          )}
                                          <span className="font-mono text-emerald-800 bg-emerald-50 border border-emerald-200/80 px-1 py-0.5 rounded">
                                            {formatAuditValue(c.after)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-[11px] text-slate-600 max-w-[220px]">
                                  {log.reason || '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Job Order Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-lg max-w-xl w-full p-6 space-y-5 my-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Step 1. Plan Production Job Order (EBR Header)
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateWorkOrder(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Approved Product Formula / BOM
                </label>
                <select
                  value={newFormulaId || approvedFormulas[0]?.id || ''}
                  onChange={(e) => {
                    setNewFormulaId(e.target.value);
                    const f = approvedFormulas.find((x) => x.id === e.target.value);
                    if (f) {
                      setNewPlannedQty(String(f.standardBatchSize));
                      const matchedSpec = batchCheckSpecs.find(
                        (s) => s.productName.toLowerCase() === f.productName.toLowerCase()
                      );
                      setNewBatchCheckSpecId(matchedSpec?.id || '');
                    }
                  }}
                  className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                >
                  {approvedFormulas.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.sku} — {f.productName} ({f.version})
                    </option>
                  ))}
                </select>
              </div>

              {batchCheckSpecs.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Linked Batch Check Parameter Set (Read in Step 5)
                  </label>
                  <select
                    value={newBatchCheckSpecId}
                    onChange={(e) => setNewBatchCheckSpecId(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-xs bg-white"
                  >
                    <option value="">None (Link later in Step 5)</option>
                    {batchCheckSpecs.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.productCategory} — {sp.productName} ({sp.batchNumber})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Planned Quantity
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    value={newPlannedQty}
                    onChange={(e) => setNewPlannedQty(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Planned Production Date
                  </label>
                  <input
                    type="date"
                    required
                    value={newPlannedDate}
                    onChange={(e) => {
                      setNewPlannedDate(e.target.value);
                      setNewPlannedStartAt(`${e.target.value} 06:30`);
                      setNewPlannedEndAt(`${e.target.value} 10:30`);
                    }}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Production Line / Machine
                  </label>
                  <select
                    value={newLineName}
                    onChange={(e) => {
                      const nextName = e.target.value;
                      setNewLineName(nextName);
                      const matched = productionLines.find(
                        (l) => l.lineName === nextName
                      );
                      if (matched) {
                        setNewEquipmentName(
                          `${matched.lineName} · ${matched.machineModel || 'Kettle Unit'}`
                        );
                        if (matched.defaultCrew) {
                          setNewTeam(matched.defaultCrew);
                        }
                      }
                    }}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  >
                    {productionLines.length > 0 ? (
                      productionLines.map((line) => (
                        <option key={line.id} value={line.lineName}>
                          {line.lineName} ({line.status})
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="Kettle Line 1">Kettle Line 1</option>
                        <option value="Kettle Line 2">Kettle Line 2</option>
                        <option value="Beverage Line 3">Beverage Line 3</option>
                      </>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Equipment / Vessel
                  </label>
                  <input
                    type="text"
                    value={newEquipmentName}
                    onChange={(e) => setNewEquipmentName(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Shift
                  </label>
                  <input
                    type="text"
                    value={newShift}
                    onChange={(e) => setNewShift(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Assigned Crew
                  </label>
                  <input
                    type="text"
                    required
                    value={newTeam}
                    onChange={(e) => setNewTeam(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Planned Start
                  </label>
                  <input
                    type="text"
                    value={newPlannedStartAt}
                    onChange={(e) => setNewPlannedStartAt(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Planned End
                  </label>
                  <input
                    type="text"
                    value={newPlannedEndAt}
                    onChange={(e) => setNewPlannedEndAt(e.target.value)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Assigned Operators (comma-separated)
                </label>
                <input
                  type="text"
                  value={newOperatorsInput}
                  onChange={(e) => setNewOperatorsInput(e.target.value)}
                  className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Demand Trigger
                  </label>
                  <select
                    value={newSourceType}
                    onChange={(e) => setNewSourceType(e.target.value as BatchSourceType)}
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-white"
                  >
                    <option value="Sales Demand">Sales Demand</option>
                    <option value="Low Stock Alert">Low Stock Alert</option>
                    <option value="OEM Request">OEM Request</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Order / Alert Reference
                  </label>
                  <input
                    type="text"
                    value={newSourceRef}
                    onChange={(e) => setNewSourceRef(e.target.value)}
                    placeholder="SO-88620"
                    className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm font-mono"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !canPlanRelease}
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-md whitespace-nowrap"
                >
                  Create Job Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
