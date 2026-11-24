export type UserRole = 'operator' | 'supervisor' | 'qc' | 'manager' | 'admin';

export type MesFeatureKey =
  | 'viewConfidentialOem'
  | 'manageFormulasBom'
  | 'planReleaseJobOrders'
  | 'executeBatchSteps'
  | 'qcSignOff'
  | 'overrideClosedBatch'
  | 'manageInventoryWms'
  | 'configureSensors'
  | 'manageRolesAccess';

export type RolePermissionMatrix = Record<UserRole, Record<MesFeatureKey, boolean>>;

export type CategoryParameterPresetMap = Record<string, RecipeProcessParameter[]>;

export type UnitOfMeasure = 'kg' | 'g' | 'L' | 'ml' | 'pcs';

export type FormulaApprovalStatus = 'Draft' | 'Approved' | 'Archived';

export type MaterialCategory = 'Ingredient' | 'Packaging';

export type RawLotStatus = 'Available' | 'Low' | 'Depleted' | 'Expired';

export type BatchStatus =
  | 'Planned'
  | 'Released'
  | 'In Progress'
  | 'Completed'
  | 'QC Review'
  | 'QC Hold'
  | 'Closed';

export type BatchSourceType = 'Sales Demand' | 'Low Stock Alert' | 'OEM Request';

export type QcStatus = 'Pending' | 'Passed' | 'Hold' | 'Failed';

export type ReadingSource = 'Manual' | 'Sensor';

export type SensorStatus = 'Nominal' | 'Warning' | 'Excursion';

export type ActiveTab =
  | 'overview'
  | 'batches'
  | 'inventory'
  | 'batch-check'
  | 'lines-machines'
  | 'formulas'
  | 'traceability'
  | 'reports';

export type SensorAdapterMode = 'simulator' | 'rest' | 'mqtt' | 'file';

export interface SensorAdapterConfig {
  masterEnabled: boolean;
  adapterMode: SensorAdapterMode;
  perLineEnabled: Record<string, boolean>;
  pollingIntervalSec: number;
  saveIntervalSec: number;
  gatewayUrl: string;
  backfillUrl: string;
  mqttWsUrl: string;
  mqttTopic: string;
  offlineAlarmThresholdSec: number;
  autoBackfillOnOpen: boolean;
}

export interface NormalizedSensorReading {
  id: string;
  timestamp: string; // ISO string from gateway or adapter
  readingTime: string; // HH:mm or HH:mm:ss
  lineName: string;
  sensorCode: string;
  tempC: number | null;
  brix: number | null;
  ph: number | null;
  viscosityCp: number | null;
  weightKg: number | null;
  speedRpm: number | null;
  pressureBar: number | null;
  source: 'Sensor';
  adapter: SensorAdapterMode;
}

export interface SensorIngestResult {
  insertedCount: number;
  skippedDuplicateCount: number;
  skippedManualCount: number;
  totalEvaluated: number;
}

export interface WmsConnectorConfig {
  enabled: boolean; // Switched OFF by default
  baseUrl: string;
  rawMaterialsPath: string;
  finishedGoodsPath: string;
  timeoutMs: number;
  autoPushFgOnQcPass: boolean;
  lastSyncAt?: string;
}

export interface WmsImportResult {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errors: string[];
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  plantName: string;
  productCategories?: string[];
  operationalStatuses?: string[];
  rolePermissions?: RolePermissionMatrix;
  categoryParameterPresets?: CategoryParameterPresetMap;
  sensorConfig?: SensorAdapterConfig;
  wmsConfig?: WmsConnectorConfig;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface BomIngredient {
  materialCode: string;
  materialName: string;
  anonymizedCode: string;
  category: MaterialCategory;
  quantityPerBatch: number;
  unit: UnitOfMeasure;
  tolerancePct: number;
}

export interface RoutingStep {
  stepNumber: number;
  name: string;
  targetDurationMin: number;
  targetTempC: number | null;
  minTempC: number | null;
  maxTempC: number | null;
  targetBrix: number | null;
  targetPh: number | null;
  targetWeightG: number | null;
  equipment: string;
}

export interface RecipeProcessParameter {
  id: string;
  key: string;
  name: string;
  unit: string;
  target: number | null;
  min: number | null;
  max: number | null;
}

export interface FormulaBOM {
  id: string;
  ownerId: string;
  sku: string;
  productName: string;
  category?: string;
  packSize: string;
  shelfLifeDays: number;
  standardBatchSize: number;
  outputUnit: string;
  version: string;
  approvalStatus: FormulaApprovalStatus;
  isConfidentialOem: boolean;
  oemCustomer: string;
  laborCostPerBatch: number;
  overheadCostPerBatch: number;
  ingredients: BomIngredient[];
  routingSteps: RoutingStep[];
  processParameters?: RecipeProcessParameter[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface RawMaterialLot {
  id: string;
  ownerId: string;
  lotNumber: string;
  materialCode: string;
  materialName: string;
  category: MaterialCategory;
  unit: UnitOfMeasure;
  quantityInitial: number;
  quantityAvailable: number;
  quantityAllocated?: number;
  reorderLevel: number;
  unitCost: number;
  supplier: string;
  expiryDate: string;
  storageZone: string;
  status: RawLotStatus;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface IssuedMaterialRecord {
  materialCode: string;
  materialName: string;
  lotId: string;
  lotNumber: string;
  requiredQty: number;
  actualQty: number;
  unit: UnitOfMeasure;
  variancePct: number;
  withinTolerance: boolean;
  cost: number;
  operator: string;
  issuedAt: string;
}

export interface AllocatedMaterialRecord {
  materialCode: string;
  materialName: string;
  lotId: string;
  lotNumber: string;
  allocatedQty: number;
  unit: UnitOfMeasure;
  allocatedBy: string;
  allocatedAt: string;
}

export interface EbrParameterReading {
  paramId: string;
  key: string;
  name: string;
  value: number | null;
  unit: string;
  target: number | null;
  min: number | null;
  max: number | null;
  withinSpec: boolean;
  timestamp: string;
  user: string;
  source: ReadingSource;
}

export interface BatchLossRecord {
  lossType: 'Reject' | 'Rework' | 'By-Product' | 'Waste';
  quantity: number;
  unit: string;
  reasonCode: string;
  notes: string;
}

export interface ProcessCheckRecord {
  id?: string;
  readingTime?: string;
  readingSlot?: number;
  stepNumber: number;
  stepName: string;
  recordedTempC: number | null;
  recordedBrix: number | null;
  recordedPh: number | null;
  recordedWeightG: number | null;
  recordedWeightKg?: number | null;
  recordedAw?: number | null;
  recordedViscosityCp?: number | null;
  recordedSpeedRpm?: number | null;
  recordedPressureBar?: number | null;
  source?: ReadingSource;
  parameterReadings?: EbrParameterReading[];
  outOfSpecParams?: string[];
  deviationRecord?: string;
  batchCheckSpecId?: string;
  batchCheckReadings?: BatchCheckAdditionalReading[];
  durationMin: number;
  sensorCode: string;
  withinSpec: boolean;
  operator: string;
  notes: string;
  recordedAt: string;
}

export interface ProductionBatch {
  id: string;
  ownerId: string;
  batchNumber: string;
  lotNumber: string;
  formulaId: string;
  formulaVersion: string;
  sku: string;
  productName: string;
  packSize?: string;
  sourceType: BatchSourceType;
  sourceRef: string;
  plannedQty: number;
  outputUnit: string;
  plannedDate: string;
  lineName: string;
  equipmentName?: string;
  assignedTeam: string;
  shift?: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  actualStartAt?: string;
  actualEndAt?: string;
  operators?: string[];
  status: BatchStatus;
  availabilityChecked: boolean;
  shortageCount: number;
  allocatedMaterials?: AllocatedMaterialRecord[];
  issuedMaterials: IssuedMaterialRecord[];
  processChecks: ProcessCheckRecord[];
  goodQty: number;
  rejectedQty: number;
  sampleQty: number;
  reworkQty: number;
  byProductQty?: number;
  wasteKg: number;
  outputMassQty?: number;
  outputMassUnit?: string;
  lossReasonCodes?: BatchLossRecord[];
  yieldPct: number;
  variancePct: number;
  materialCost: number;
  laborCost: number;
  overheadCost: number;
  unitCost: number;
  qcStatus: QcStatus;
  qcNotes: string;
  qcInspector: string;
  retainedSampleQty?: number;
  retainedSampleCode?: string;
  retainedSampleLocation?: string;
  qcInProcessSummary?: string;
  qcFinalResults?: string;
  postedToInventory: boolean;
  finishedGoodId: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface FinishedGoodShipment {
  shipmentRef: string;
  customerName: string;
  quantityShipped: number;
  shippedDate: string;
  destination: string;
}

export interface FinishedGoodLot {
  id: string;
  ownerId: string;
  batchId: string;
  batchNumber: string;
  lotNumber: string;
  sku: string;
  productName: string;
  quantityProduced: number;
  quantityAvailable: number;
  unit: string;
  productionDate: string;
  expiryDate: string;
  qcStatus: 'Released' | 'Quarantined';
  warehouseZone: string;
  unitCost: number;
  shipments: FinishedGoodShipment[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface ThermalSensor {
  id: string;
  ownerId: string;
  sensorCode: string;
  name: string;
  zone: string;
  equipmentType: string;
  linkedLine: string;
  currentTempC: number;
  targetTempC: number;
  minSafeTempC: number;
  maxSafeTempC: number;
  humidityPct: number;
  status: SensorStatus;
  yieldImpactNote: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface TelemetryHistoryPoint {
  time: string;
  [sensorCode: string]: string | number;
}

export interface YieldOptimizationRecommendation {
  id: string;
  severity: 'High' | 'Medium' | 'Low';
  category: 'Thermal Drift' | 'Weigh Tolerance' | 'Reject Rate' | 'Inventory Risk';
  title: string;
  detail: string;
  estimatedYieldGainPct: number;
  estimatedSavingsPerBatch: number;
  sensorId?: string;
  recommendedTargetTempC?: number;
  batchId?: string;
}

export type MaintenanceType =
  | 'Calibration'
  | 'Inspection'
  | 'Probe Replacement'
  | 'Corrective Action';

export type CalibrationResult = 'Pass' | 'Adjusted & Passed' | 'Requires Service';

export interface SensorMaintenanceLog {
  id: string;
  ownerId: string;
  sensorId: string;
  sensorCode: string;
  maintenanceType: MaintenanceType;
  calibrationDate: string;
  nextCalibrationDue: string;
  offsetAdjustmentC: number;
  asFoundTempC: number | null;
  asLeftTempC: number | null;
  verificationResult: CalibrationResult;
  technicianName: string;
  notes: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export type BatchCheckProductCategory = string;

export type BatchCheckConditionStatus = 'In Spec' | 'Marginal' | 'Out of Spec';

export interface BatchCheckAdditionalParam {
  id: string;
  name: string;
  unit: string;
  minTarget: number | null;
  maxTarget: number | null;
  targetNote: string;
}

export interface BatchCheckAdditionalReading {
  paramId: string;
  name: string;
  unit: string;
  value: string;
  numericValue: number | null;
  withinSpec: boolean;
}

export interface BatchCheckSpec {
  id: string;
  ownerId: string;
  batchId: string;
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
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface BatchCheckRecord {
  id: string;
  ownerId: string;
  specId: string;
  batchNumber: string;
  productCategory: BatchCheckProductCategory;
  samplingStage: string;
  measuredPh: number | null;
  measuredAw: number | null;
  measuredBrix: number | null;
  phReadings?: number[];
  awReadings?: number[];
  brixReadings?: number[];
  additionalReadings: BatchCheckAdditionalReading[];
  conditionStatus: BatchCheckConditionStatus;
  inspectorName: string;
  recordedAt: string;
  notes: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export type LineOperationalStatus = string;

export type MachineCategory =
  | 'Thermal Kettle'
  | 'Pasteurizer / Beverage'
  | 'Filling & Sealing'
  | 'Dry Blending / Powder'
  | 'Cooling / Retort';

export interface MachineParameterSetting {
  id: string;
  parameterName: string;
  setpoint: string;
  minLimit: number | null;
  maxLimit: number | null;
  unit: string;
  notes: string;
}

export interface ProductionLineMachine {
  id: string;
  ownerId: string;
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
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface AuditLogEntry {
  id: string;
  ownerId: string;
  actorUid: string;
  actorEmail: string;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  batchId: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  createdAt: string | Date;
}

export interface BackwardGenealogyMaterialItem {
  materialCode: string;
  materialName: string;
  lotId: string;
  lotNumber: string;
  supplier: string;
  expiryDate: string;
  storageZone: string;
  allocatedQty: number | null;
  actualUsedQty: number;
  unit: UnitOfMeasure;
  variancePct: number;
  withinTolerance: boolean;
  addedBy: string;
  addedAt: string;
}

export interface BackwardGenealogyResponse {
  finishedGood: FinishedGoodLot;
  batch: ProductionBatch;
  rawMaterialLots: BackwardGenealogyMaterialItem[];
  shipments: FinishedGoodShipment[];
}

export interface WorkspaceSnapshot {
  profile: UserProfile;
  formulas: FormulaBOM[];
  rawMaterials: RawMaterialLot[];
  batches: ProductionBatch[];
  finishedGoods: FinishedGoodLot[];
  sensors: ThermalSensor[];
  maintenanceLogs: SensorMaintenanceLog[];
  batchCheckSpecs: BatchCheckSpec[];
  batchCheckRecords: BatchCheckRecord[];
  productionLines: ProductionLineMachine[];
  auditLogs?: AuditLogEntry[];
}

export interface BatchYieldTrendPoint {
  id: string;
  batchNumber: string;
  lotNumber: string;
  sku: string;
  productName: string;
  lineName: string;
  plannedDate: string;
  plannedQty: number;
  goodQty: number;
  rejectedQty: number;
  wasteKg: number;
  outputUnit: string;
  yieldPct: number;
  variancePct: number;
  unitCost: number;
  status: BatchStatus;
  qcStatus: QcStatus;
}

export interface BatchYieldTrendsResponse {
  points: BatchYieldTrendPoint[];
  availableLines: string[];
  avgYieldPct: number;
  targetYieldPct: number;
  totalWasteKg: number;
  bestBatchNumber: string | null;
  bestYieldPct: number | null;
}

export interface BatchCategoryCompletionItem {
  category: string;
  totalBatches: number;
  completedBatches: number;
  inProgressBatches: number;
  qcHoldBatches: number;
  plannedBatches: number;
  completionRatePct: number;
  inFlightRatePct: number;
  plannedQtyTotal: number;
  goodQtyTotal: number;
  volumeCompletionPct: number;
  avgYieldPct: number;
  latestBatchId: string | null;
  latestBatchNumber: string | null;
}

export interface BatchCategoryCompletionResponse {
  categories: BatchCategoryCompletionItem[];
  totalBatches: number;
  completedBatches: number;
  overallCompletionRatePct: number;
  leadingCategory: string | null;
  leadingCompletionRatePct: number | null;
  inFlightCount: number;
}

export interface SqlAuthUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  hasPassword?: boolean;
}

export type DbConnectionMode = 'env' | 'remote_ip';

export interface DbConnectionConfigInput {
  mode: DbConnectionMode;
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: boolean;
  initializeSchema?: boolean;
}

export interface DbConnectionConfigPublic {
  mode: DbConnectionMode;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasPassword: boolean;
  configuredViaOverride: boolean;
  activeHostLabel: string;
  configPathLabel: string;
}

export interface DbConnectionTestResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  database?: string;
  serverIp?: string | null;
  serverPort?: number | null;
  tableCount?: number;
  latencyMs?: number;
}

export interface AuthStatusResponse {
  authMode: 'sql';
  sqlUsersCount: number;
  hasPasswordedUsers: boolean;
  legacySsoAvailable: boolean;
  dbConfig: DbConnectionConfigPublic;
}


