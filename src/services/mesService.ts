import { getActiveBearerToken, logoutSqlSession } from './sqlAuthClient';
import type {
  AuditLogEntry,
  BackwardGenealogyResponse,
  BatchCheckAdditionalParam,
  BatchCheckAdditionalReading,
  BatchCheckConditionStatus,
  BatchCheckProductCategory,
  BatchCheckRecord,
  BatchCheckSpec,
  BatchCategoryCompletionResponse,
  BatchLossRecord,
  BatchSourceType,
  BatchYieldTrendsResponse,
  BomIngredient,
  CalibrationResult,
  CategoryParameterPresetMap,
  FinishedGoodLot,
  FinishedGoodShipment,
  FormulaBOM,
  LineOperationalStatus,
  MachineCategory,
  MachineParameterSetting,
  MaintenanceType,
  MaterialCategory,
  NormalizedSensorReading,
  ProcessCheckRecord,
  ProductionBatch,
  ProductionLineMachine,
  RawMaterialLot,
  RecipeProcessParameter,
  RolePermissionMatrix,
  RoutingStep,
  SensorAdapterConfig,
  SensorIngestResult,
  SensorMaintenanceLog,
  ThermalSensor,
  UnitOfMeasure,
  UserProfile,
  UserRole,
  WmsConnectorConfig,
  WmsImportResult,
  WorkspaceSnapshot,
} from '../types';

export interface ClosedBatchOverrideInput {
  authorizedOverride?: boolean;
  overrideReason?: string;
}

export const WORKSPACE_SYNC_EVENT = 'kettler:workspace-sync';

function notifyWorkspaceChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WORKSPACE_SYNC_EVENT));
  }
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getActiveBearerToken();
  if (!token) {
    throw new Error('Authentication required. Please sign in again.');
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...init,
    headers,
  });

  if (res.status === 401) {
    void logoutSqlSession();
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

export async function fetchWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  return apiRequest<WorkspaceSnapshot>('/api/workspace', { method: 'GET' });
}

export async function fetchFormulasFromSql(): Promise<FormulaBOM[]> {
  const res = await apiRequest<{ formulas: FormulaBOM[] }>('/api/formulas', { method: 'GET' });
  return res.formulas;
}

export async function fetchRawMaterialsFromSql(): Promise<RawMaterialLot[]> {
  const res = await apiRequest<{ rawMaterials: RawMaterialLot[] }>('/api/raw-materials', {
    method: 'GET',
  });
  return res.rawMaterials;
}

export async function fetchBatchesFromSql(): Promise<ProductionBatch[]> {
  const res = await apiRequest<{ batches: ProductionBatch[] }>('/api/batches', { method: 'GET' });
  return res.batches;
}

export async function fetchFinishedGoodsFromSql(): Promise<FinishedGoodLot[]> {
  const res = await apiRequest<{ finishedGoods: FinishedGoodLot[] }>('/api/finished-goods', {
    method: 'GET',
  });
  return res.finishedGoods;
}

export async function fetchSensorsFromSql(): Promise<ThermalSensor[]> {
  const res = await apiRequest<{ sensors: ThermalSensor[] }>('/api/sensors', { method: 'GET' });
  return res.sensors;
}

export async function fetchProductionLinesFromSql(): Promise<ProductionLineMachine[]> {
  const res = await apiRequest<{ productionLines: ProductionLineMachine[] }>(
    '/api/production-lines',
    { method: 'GET' }
  );
  return res.productionLines;
}

export async function fetchBatchYieldTrends(
  lineName?: string
): Promise<BatchYieldTrendsResponse> {
  const params =
    lineName && lineName !== 'ALL' ? `?line=${encodeURIComponent(lineName)}` : '';
  return apiRequest<BatchYieldTrendsResponse>(`/api/analytics/yield-trends${params}`, {
    method: 'GET',
  });
}

export async function fetchBatchCategoryCompletion(): Promise<BatchCategoryCompletionResponse> {
  return apiRequest<BatchCategoryCompletionResponse>(
    '/api/analytics/category-completion',
    {
      method: 'GET',
    }
  );
}

export async function updateUserRole(_uid: string, role: UserRole): Promise<void> {
  await apiRequest('/api/profile/role', {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
  notifyWorkspaceChanged();
}

export async function updatePlantOptions(payload: {
  productCategories?: string[];
  operationalStatuses?: string[];
}): Promise<UserProfile> {
  const res = await apiRequest<{ profile: UserProfile }>('/api/profile/plant-options', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
  return res.profile;
}

export async function updateRolePermissions(
  rolePermissions: RolePermissionMatrix
): Promise<UserProfile> {
  const res = await apiRequest<{ profile: UserProfile }>('/api/profile/role-permissions', {
    method: 'PATCH',
    body: JSON.stringify({ rolePermissions }),
  });
  notifyWorkspaceChanged();
  return res.profile;
}

export async function updateCategoryParameterPresets(
  categoryParameterPresets: CategoryParameterPresetMap
): Promise<UserProfile> {
  const res = await apiRequest<{ profile: UserProfile }>(
    '/api/profile/category-parameter-presets',
    {
      method: 'PATCH',
      body: JSON.stringify({ categoryParameterPresets }),
    }
  );
  notifyWorkspaceChanged();
  return res.profile;
}

export async function createFormulaVersion(
  _ownerId: string,
  payload: {
    sku: string;
    productName: string;
    category?: string;
    packSize: string;
    shelfLifeDays: number;
    standardBatchSize: number;
    outputUnit: string;
    version: string;
    approvalStatus: 'Draft' | 'Approved';
    isConfidentialOem: boolean;
    oemCustomer: string;
    laborCostPerBatch: number;
    overheadCostPerBatch: number;
    ingredients: BomIngredient[];
    routingSteps: RoutingStep[];
    processParameters?: RecipeProcessParameter[];
  },
  archiveFormulaId?: string
): Promise<string> {
  const res = await apiRequest<{ id: string }>('/api/formulas', {
    method: 'POST',
    body: JSON.stringify({ ...payload, archiveFormulaId }),
  });
  notifyWorkspaceChanged();
  return res.id;
}

export async function updateFormulaProcessParameters(
  formulaId: string,
  processParameters: RecipeProcessParameter[],
  category?: string
): Promise<FormulaBOM> {
  const res = await apiRequest<{ formula: FormulaBOM }>(
    `/api/formulas/${encodeURIComponent(formulaId)}/process-parameters`,
    {
      method: 'PATCH',
      body: JSON.stringify({ processParameters, category }),
    }
  );
  notifyWorkspaceChanged();
  return res.formula;
}

export async function approveFormulaVersion(
  formulaId: string,
  previousApprovedId?: string
): Promise<void> {
  await apiRequest(`/api/formulas/${encodeURIComponent(formulaId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ previousApprovedId }),
  });
  notifyWorkspaceChanged();
}

export async function receiveRawMaterialLot(
  _ownerId: string,
  input: {
    lotNumber: string;
    materialCode: string;
    materialName: string;
    category: MaterialCategory;
    unit: UnitOfMeasure;
    quantityInitial: number;
    reorderLevel: number;
    unitCost: number;
    supplier: string;
    expiryDate: string;
    storageZone: string;
  }
): Promise<string> {
  const res = await apiRequest<{ id: string }>('/api/raw-materials', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  notifyWorkspaceChanged();
  return res.id;
}

export async function replenishRawMaterialLot(
  lot: RawMaterialLot,
  addQty: number
): Promise<void> {
  await apiRequest(`/api/raw-materials/${encodeURIComponent(lot.id)}/replenish`, {
    method: 'POST',
    body: JSON.stringify({ addQty }),
  });
  notifyWorkspaceChanged();
}

export async function adjustRawMaterialLot(
  lotId: string,
  payload: {
    mode: 'add' | 'deduct' | 'set';
    quantity: number;
    lotNumber?: string;
    reorderLevel?: number;
    unitCost?: number;
    supplier?: string;
    expiryDate?: string;
    storageZone?: string;
  }
): Promise<RawMaterialLot> {
  const res = await apiRequest<{ lot: RawMaterialLot }>(
    `/api/raw-materials/${encodeURIComponent(lotId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
  return res.lot;
}

export async function deleteRawMaterialLot(lotId: string): Promise<void> {
  await apiRequest(`/api/raw-materials/${encodeURIComponent(lotId)}`, {
    method: 'DELETE',
  });
  notifyWorkspaceChanged();
}

export async function createWorkOrder(
  _ownerId: string,
  input: {
    formula: FormulaBOM;
    plannedQty: number;
    plannedDate: string;
    lineName: string;
    equipmentName?: string;
    assignedTeam: string;
    shift?: string;
    plannedStartAt?: string;
    plannedEndAt?: string;
    operators?: string[];
    sourceType: BatchSourceType;
    sourceRef: string;
    existingBatchCount: number;
    batchCheckSpecId?: string;
  }
): Promise<string> {
  const res = await apiRequest<{ id: string }>('/api/batches', {
    method: 'POST',
    body: JSON.stringify({
      formulaId: input.formula.id,
      plannedQty: input.plannedQty,
      plannedDate: input.plannedDate,
      lineName: input.lineName,
      equipmentName: input.equipmentName,
      assignedTeam: input.assignedTeam,
      shift: input.shift,
      plannedStartAt: input.plannedStartAt,
      plannedEndAt: input.plannedEndAt,
      operators: input.operators,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      batchCheckSpecId: input.batchCheckSpecId || undefined,
    }),
  });
  notifyWorkspaceChanged();
  return res.id;
}

export async function updateBatchHeader(
  batchId: string,
  input: {
    plannedQty?: number;
    plannedDate?: string;
    sourceType?: BatchSourceType;
    sourceRef?: string;
    lineName?: string;
    equipmentName?: string;
    assignedTeam?: string;
    shift?: string;
    plannedStartAt?: string;
    plannedEndAt?: string;
    actualStartAt?: string;
    actualEndAt?: string;
    operators?: string[];
    packSize?: string;
  } & ClosedBatchOverrideInput
): Promise<ProductionBatch> {
  const res = await apiRequest<{ batch: ProductionBatch }>(
    `/api/batches/${encodeURIComponent(batchId)}/header`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    }
  );
  notifyWorkspaceChanged();
  return res.batch;
}

export async function runAvailabilityCheck(
  batch: ProductionBatch,
  _formula: FormulaBOM,
  _rawMaterials: RawMaterialLot[]
): Promise<number> {
  const res = await apiRequest<{ shortageCount: number }>(
    `/api/batches/${encodeURIComponent(batch.id)}/check-availability`,
    { method: 'POST' }
  );
  notifyWorkspaceChanged();
  return res.shortageCount;
}

export async function releaseWorkOrder(
  batch: ProductionBatch,
  _existingBatchCount: number
): Promise<string> {
  const res = await apiRequest<{ lotNumber: string }>(
    `/api/batches/${encodeURIComponent(batch.id)}/release`,
    { method: 'POST' }
  );
  notifyWorkspaceChanged();
  return res.lotNumber;
}

export async function allocateMaterialLotToBatch(
  batchId: string,
  payload: {
    rawLotId: string;
    materialCode: string;
    allocatedQtyInBomUnit: number;
    bomUnit: UnitOfMeasure;
  } & ClosedBatchOverrideInput
): Promise<void> {
  await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/allocate-material`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
}

export async function issueMaterialLotToBatch(
  batch: ProductionBatch,
  rawLot: RawMaterialLot,
  actualQtyInBomUnit: number,
  requiredQtyInBomUnit: number,
  bomUnit: UnitOfMeasure,
  tolerancePct: number,
  operatorName: string,
  override?: ClosedBatchOverrideInput
): Promise<void> {
  await apiRequest(`/api/batches/${encodeURIComponent(batch.id)}/issue-material`, {
    method: 'POST',
    body: JSON.stringify({
      rawLotId: rawLot.id,
      actualQtyInBomUnit,
      requiredQtyInBomUnit,
      bomUnit,
      tolerancePct,
      operatorName,
      ...(override || {}),
    }),
  });
  notifyWorkspaceChanged();
}

export async function updateIssuedMaterialLotInBatch(
  batchId: string,
  materialCode: string,
  payload: {
    rawLotId: string;
    actualQtyInBomUnit: number;
    requiredQtyInBomUnit: number;
    bomUnit: UnitOfMeasure;
    tolerancePct: number;
    operatorName: string;
  } & ClosedBatchOverrideInput
): Promise<void> {
  await apiRequest(
    `/api/batches/${encodeURIComponent(batchId)}/issued-materials/${encodeURIComponent(materialCode)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
}

export async function recordBatchProcessCheck(
  batch: ProductionBatch,
  checkOrList: ProcessCheckRecord | ProcessCheckRecord[],
  override?: ClosedBatchOverrideInput
): Promise<void> {
  const payload = Array.isArray(checkOrList)
    ? { checks: checkOrList, ...(override || {}) }
    : { ...checkOrList, ...(override || {}) };
  await apiRequest(`/api/batches/${encodeURIComponent(batch.id)}/process-checks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
}

export async function updateBatchProcessCheck(
  batchId: string,
  checkId: string,
  check: ProcessCheckRecord,
  override?: ClosedBatchOverrideInput
): Promise<void> {
  await apiRequest(
    `/api/batches/${encodeURIComponent(batchId)}/process-checks/${encodeURIComponent(checkId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ ...check, ...(override || {}) }),
    }
  );
  notifyWorkspaceChanged();
}

export async function deleteBatchProcessCheck(
  batchId: string,
  checkId: string,
  override?: ClosedBatchOverrideInput
): Promise<void> {
  await apiRequest(
    `/api/batches/${encodeURIComponent(batchId)}/process-checks/${encodeURIComponent(checkId)}`,
    {
      method: 'DELETE',
      body: override ? JSON.stringify(override) : undefined,
    }
  );
  notifyWorkspaceChanged();
}

export async function reportBatchOutput(
  batch: ProductionBatch,
  output: {
    goodQty: number;
    outputMassQty?: number;
    outputMassUnit?: string;
    packSize?: string;
    rejectedQty: number;
    sampleQty: number;
    reworkQty: number;
    byProductQty?: number;
    wasteKg: number;
    lossReasonCodes?: BatchLossRecord[];
    actualEndAt?: string;
  } & ClosedBatchOverrideInput
): Promise<void> {
  await apiRequest(`/api/batches/${encodeURIComponent(batch.id)}/report-output`, {
    method: 'POST',
    body: JSON.stringify(output),
  });
  notifyWorkspaceChanged();
}

export async function startBatchQcReview(batchId: string): Promise<void> {
  await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/qc-review`, {
    method: 'POST',
  });
  notifyWorkspaceChanged();
}

export async function executeQcDecisionAndPostInventory(
  _ownerId: string,
  batch: ProductionBatch,
  _formula: FormulaBOM | undefined,
  decision: 'Passed' | 'Hold' | 'Failed',
  inspector: string,
  notes: string,
  warehouseZone: string,
  ebrQc?: {
    retainedSampleQty?: number;
    retainedSampleCode?: string;
    retainedSampleLocation?: string;
    qcInProcessSummary?: string;
    qcFinalResults?: string;
  } & ClosedBatchOverrideInput
): Promise<string | null> {
  const res = await apiRequest<{ finishedGoodId: string | null }>(
    `/api/batches/${encodeURIComponent(batch.id)}/qc-decision`,
    {
      method: 'POST',
      body: JSON.stringify({
        decision,
        inspector,
        notes,
        warehouseZone,
        ...(ebrQc || {}),
      }),
    }
  );
  notifyWorkspaceChanged();
  return res.finishedGoodId;
}

export async function closeProductionBatch(batchId: string): Promise<void> {
  await apiRequest(`/api/batches/${encodeURIComponent(batchId)}/close`, {
    method: 'POST',
  });
  notifyWorkspaceChanged();
}

export async function fetchBatchAuditLogs(batchId: string): Promise<AuditLogEntry[]> {
  const res = await apiRequest<{ logs: AuditLogEntry[] }>(
    `/api/batches/${encodeURIComponent(batchId)}/audit-logs`,
    { method: 'GET' }
  );
  return res.logs;
}

export async function fetchFinishedGoodGenealogy(
  fgIdOrLotNumber: string
): Promise<BackwardGenealogyResponse> {
  return apiRequest<BackwardGenealogyResponse>(
    `/api/finished-goods/${encodeURIComponent(fgIdOrLotNumber)}/genealogy`,
    { method: 'GET' }
  );
}

export async function recordCustomerShipment(
  fgLot: FinishedGoodLot,
  shipment: FinishedGoodShipment
): Promise<void> {
  await apiRequest(`/api/finished-goods/${encodeURIComponent(fgLot.id)}/shipments`, {
    method: 'POST',
    body: JSON.stringify(shipment),
  });
  notifyWorkspaceChanged();
}

export async function updateThermalSensor(
  sensor: ThermalSensor,
  updates: {
    currentTempC?: number;
    targetTempC?: number;
    minSafeTempC?: number;
    maxSafeTempC?: number;
    humidityPct?: number;
    yieldImpactNote?: string;
  }
): Promise<void> {
  await apiRequest(`/api/sensors/${encodeURIComponent(sensor.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  notifyWorkspaceChanged();
}

export async function saveThermalSensor(payload: {
  id?: string;
  sensorCode: string;
  name: string;
  zone: string;
  equipmentType: string;
  linkedLine: string;
  currentTempC: number;
  targetTempC: number;
  minSafeTempC: number;
  maxSafeTempC: number;
  humidityPct?: number;
  yieldImpactNote?: string;
}): Promise<ThermalSensor> {
  const res = await apiRequest<{ sensor: ThermalSensor }>('/api/sensors', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
  return res.sensor;
}

export async function deleteThermalSensor(sensorId: string): Promise<void> {
  await apiRequest(`/api/sensors/${encodeURIComponent(sensorId)}`, {
    method: 'DELETE',
  });
  notifyWorkspaceChanged();
}

export async function createSensorMaintenanceLog(
  sensorId: string,
  payload: {
    maintenanceType: MaintenanceType;
    calibrationDate: string;
    nextCalibrationDue: string;
    offsetAdjustmentC: number;
    asFoundTempC: number | null;
    asLeftTempC: number | null;
    verificationResult: CalibrationResult;
    technicianName: string;
    notes: string;
    syncProbeReading?: boolean;
  }
): Promise<SensorMaintenanceLog> {
  const res = await apiRequest<{ log: SensorMaintenanceLog }>(
    `/api/sensors/${encodeURIComponent(sensorId)}/maintenance-logs`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
  return res.log;
}

export async function deleteSensorMaintenanceLog(logId: string): Promise<void> {
  await apiRequest(`/api/sensors/maintenance-logs/${encodeURIComponent(logId)}`, {
    method: 'DELETE',
  });
  notifyWorkspaceChanged();
}

export async function saveBatchCheckSpec(payload: {
  id?: string;
  batchId?: string;
  batchNumber: string;
  productName: string;
  productCategory: BatchCheckProductCategory;
  phMin: number | null;
  phMax: number | null;
  awMin: number | null;
  awMax: number | null;
  brixMin: number | null;
  brixMax: number | null;
  additionalParams: BatchCheckAdditionalParam[];
  requirementNotes: string;
}): Promise<BatchCheckSpec> {
  const res = await apiRequest<{ spec: BatchCheckSpec }>('/api/batch-checks/specs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
  return res.spec;
}

export async function deleteBatchCheckSpec(specId: string): Promise<void> {
  await apiRequest(`/api/batch-checks/specs/${encodeURIComponent(specId)}`, {
    method: 'DELETE',
  });
  notifyWorkspaceChanged();
}

export async function createBatchCheckRecord(
  specId: string,
  payload: {
    samplingStage: string;
    measuredPh: number | null;
    measuredAw: number | null;
    measuredBrix: number | null;
    phReadings?: number[];
    awReadings?: number[];
    brixReadings?: number[];
    additionalReadings: BatchCheckAdditionalReading[];
    conditionStatus?: BatchCheckConditionStatus | 'Auto';
    inspectorName: string;
    recordedAt?: string;
    notes: string;
  }
): Promise<BatchCheckRecord> {
  const res = await apiRequest<{ record: BatchCheckRecord }>(
    `/api/batch-checks/specs/${encodeURIComponent(specId)}/records`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
  return res.record;
}

export async function updateBatchCheckRecord(
  recordId: string,
  payload: {
    specId?: string;
    samplingStage: string;
    measuredPh: number | null;
    measuredAw: number | null;
    measuredBrix: number | null;
    phReadings?: number[];
    awReadings?: number[];
    brixReadings?: number[];
    additionalReadings: BatchCheckAdditionalReading[];
    conditionStatus?: BatchCheckConditionStatus | 'Auto';
    inspectorName: string;
    notes: string;
  }
): Promise<BatchCheckRecord> {
  const res = await apiRequest<{ record: BatchCheckRecord }>(
    `/api/batch-checks/records/${encodeURIComponent(recordId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
  return res.record;
}

export async function deleteBatchCheckRecord(recordId: string): Promise<void> {
  await apiRequest(`/api/batch-checks/records/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
  });
  notifyWorkspaceChanged();
}

export async function saveProductionLine(payload: {
  id?: string;
  lineCode: string;
  lineName: string;
  machineName: string;
  machineModel: string;
  category: MachineCategory;
  supportedProductTypes: BatchCheckProductCategory[];
  status: LineOperationalStatus;
  batchCapacity: number;
  capacityUnit: string;
  targetTempC: number | null;
  agitatorRpm: number | null;
  pressureBar: number | null;
  fillerSpeedUnitsPerMin: number | null;
  cleaningIntervalHours: number;
  defaultCrew: string;
  linkedSensorCode: string;
  customSettings: MachineParameterSetting[];
  notes: string;
}): Promise<ProductionLineMachine> {
  const res = await apiRequest<{ line: ProductionLineMachine }>(
    '/api/production-lines',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
  return res.line;
}

export async function updateProductionLineStatus(
  lineId: string,
  status: LineOperationalStatus
): Promise<ProductionLineMachine> {
  const res = await apiRequest<{ line: ProductionLineMachine }>(
    `/api/production-lines/${encodeURIComponent(lineId)}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }
  );
  notifyWorkspaceChanged();
  return res.line;
}

export async function deleteProductionLine(lineId: string): Promise<void> {
  await apiRequest(`/api/production-lines/${encodeURIComponent(lineId)}`, {
    method: 'DELETE',
  });
  notifyWorkspaceChanged();
}

export async function updateSensorAdapterConfig(
  payload: Partial<SensorAdapterConfig>
): Promise<UserProfile> {
  const res = await apiRequest<{ profile: UserProfile }>('/api/sensors/config', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
  return res.profile;
}

export async function ingestBatchSensorReadings(
  batchId: string,
  payload: {
    readings: NormalizedSensorReading[];
    mode?: 'auto-save' | 'backfill' | 'file-import' | 'snapshot';
    authorizedOverride?: boolean;
    overrideReason?: string;
  }
): Promise<SensorIngestResult> {
  const res = await apiRequest<SensorIngestResult>(
    `/api/batches/${encodeURIComponent(batchId)}/sensor-readings`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  notifyWorkspaceChanged();
  return res;
}

export async function updateWmsConnectorConfig(
  payload: Partial<WmsConnectorConfig>
): Promise<UserProfile> {
  const res = await apiRequest<{ profile: UserProfile }>('/api/profile/wms-config', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  notifyWorkspaceChanged();
  return res.profile;
}

export async function importWmsRawMaterials(
  items: Array<Record<string, unknown>>,
  mode: 'set' | 'add' = 'set'
): Promise<WmsImportResult> {
  const res = await apiRequest<WmsImportResult>('/api/wms/import-raw-materials', {
    method: 'POST',
    body: JSON.stringify({ items, mode }),
  });
  notifyWorkspaceChanged();
  return res;
}

export async function importWmsFinishedGoods(
  items: Array<Record<string, unknown>>
): Promise<WmsImportResult> {
  const res = await apiRequest<WmsImportResult>('/api/wms/import-finished-goods', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  notifyWorkspaceChanged();
  return res;
}
