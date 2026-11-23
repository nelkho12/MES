import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type {
  AllocatedMaterialRecord,
  BatchCheckAdditionalParam,
  BatchCheckAdditionalReading,
  BatchCheckProductCategory,
  BatchLossRecord,
  BomIngredient,
  CategoryParameterPresetMap,
  FinishedGoodShipment,
  IssuedMaterialRecord,
  MachineParameterSetting,
  ProcessCheckRecord,
  RecipeProcessParameter,
  RolePermissionMatrix,
  RoutingStep,
  SensorAdapterConfig,
  WmsConnectorConfig,
} from '../types.ts';
import { DEFAULT_ROLE_PERMISSIONS } from '../services/permissions.ts';

export const DEFAULT_SENSOR_CONFIG: SensorAdapterConfig = {
  masterEnabled: false,
  adapterMode: 'simulator',
  perLineEnabled: {},
  pollingIntervalSec: 5,
  saveIntervalSec: 60,
  gatewayUrl: 'http://localhost:4100/api/readings',
  backfillUrl: '',
  mqttWsUrl: 'ws://localhost:9001/mqtt',
  mqttTopic: 'mayralab/mes/+/readings',
  offlineAlarmThresholdSec: 30,
  autoBackfillOnOpen: true,
};

export const DEFAULT_WMS_CONFIG: WmsConnectorConfig = {
  enabled: false,
  baseUrl: 'http://localhost:4200/api/wms',
  rawMaterialsPath: '/raw-materials',
  finishedGoodsPath: '/finished-goods',
  timeoutMs: 8000,
  autoPushFgOnQcPass: false,
  lastSyncAt: '',
};

export const users = pgTable('users', {
  uid: text('uid').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('manager'),
  plantName: text('plant_name')
    .notNull()
    .default('Kettler Processing Facility · Plant 01'),
  productCategories: jsonb('product_categories')
    .$type<string[]>()
    .notNull()
    .default(['Sauce', 'Syrup', 'Powder']),
  operationalStatuses: jsonb('operational_statuses')
    .$type<string[]>()
    .notNull()
    .default(['Active', 'Standby', 'CIP Cleaning', 'Maintenance']),
  rolePermissions: jsonb('role_permissions')
    .$type<RolePermissionMatrix>()
    .notNull()
    .default(DEFAULT_ROLE_PERMISSIONS),
  categoryParameterPresets: jsonb('category_parameter_presets')
    .$type<CategoryParameterPresetMap>()
    .notNull()
    .default({}),
  sensorConfig: jsonb('sensor_config')
    .$type<SensorAdapterConfig>()
    .notNull()
    .default(DEFAULT_SENSOR_CONFIG),
  wmsConfig: jsonb('wms_config')
    .$type<WmsConnectorConfig>()
    .notNull()
    .default(DEFAULT_WMS_CONFIG),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const formulas = pgTable('formulas', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  sku: text('sku').notNull(),
  productName: text('product_name').notNull(),
  category: text('category').notNull().default('Sauce'),
  packSize: text('pack_size').notNull(),
  shelfLifeDays: integer('shelf_life_days').notNull(),
  standardBatchSize: doublePrecision('standard_batch_size').notNull(),
  outputUnit: text('output_unit').notNull(),
  version: text('version').notNull(),
  approvalStatus: text('approval_status').notNull().default('Draft'),
  isConfidentialOem: boolean('is_confidential_oem').notNull().default(false),
  oemCustomer: text('oem_customer').notNull().default(''),
  laborCostPerBatch: doublePrecision('labor_cost_per_batch').notNull().default(0),
  overheadCostPerBatch: doublePrecision('overhead_cost_per_batch')
    .notNull()
    .default(0),
  ingredients: jsonb('ingredients').$type<BomIngredient[]>().notNull().default([]),
  routingSteps: jsonb('routing_steps').$type<RoutingStep[]>().notNull().default([]),
  processParameters: jsonb('process_parameters')
    .$type<RecipeProcessParameter[]>()
    .notNull()
    .default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const rawMaterials = pgTable('raw_materials', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  lotNumber: text('lot_number').notNull(),
  materialCode: text('material_code').notNull(),
  materialName: text('material_name').notNull(),
  category: text('category').notNull(),
  unit: text('unit').notNull(),
  quantityInitial: doublePrecision('quantity_initial').notNull(),
  quantityAvailable: doublePrecision('quantity_available').notNull(),
  quantityAllocated: doublePrecision('quantity_allocated').notNull().default(0),
  reorderLevel: doublePrecision('reorder_level').notNull(),
  unitCost: doublePrecision('unit_cost').notNull(),
  supplier: text('supplier').notNull(),
  expiryDate: text('expiry_date').notNull(),
  storageZone: text('storage_zone').notNull(),
  status: text('status').notNull().default('Available'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const batches = pgTable('batches', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  batchNumber: text('batch_number').notNull(),
  lotNumber: text('lot_number').notNull().default(''),
  formulaId: text('formula_id')
    .references(() => formulas.id)
    .notNull(),
  formulaVersion: text('formula_version').notNull(),
  sku: text('sku').notNull(),
  productName: text('product_name').notNull(),
  packSize: text('pack_size').notNull().default(''),
  sourceType: text('source_type').notNull(),
  sourceRef: text('source_ref').notNull().default(''),
  plannedQty: doublePrecision('planned_qty').notNull(),
  outputUnit: text('output_unit').notNull(),
  plannedDate: text('planned_date').notNull(),
  lineName: text('line_name').notNull(),
  equipmentName: text('equipment_name').notNull().default(''),
  assignedTeam: text('assigned_team').notNull(),
  shift: text('shift').notNull().default('Shift A (Day)'),
  plannedStartAt: text('planned_start_at').notNull().default(''),
  plannedEndAt: text('planned_end_at').notNull().default(''),
  actualStartAt: text('actual_start_at').notNull().default(''),
  actualEndAt: text('actual_end_at').notNull().default(''),
  operators: jsonb('operators').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('Planned'),
  availabilityChecked: boolean('availability_checked').notNull().default(false),
  shortageCount: integer('shortage_count').notNull().default(0),
  allocatedMaterials: jsonb('allocated_materials')
    .$type<AllocatedMaterialRecord[]>()
    .notNull()
    .default([]),
  issuedMaterials: jsonb('issued_materials')
    .$type<IssuedMaterialRecord[]>()
    .notNull()
    .default([]),
  processChecks: jsonb('process_checks')
    .$type<ProcessCheckRecord[]>()
    .notNull()
    .default([]),
  goodQty: doublePrecision('good_qty').notNull().default(0),
  rejectedQty: doublePrecision('rejected_qty').notNull().default(0),
  sampleQty: doublePrecision('sample_qty').notNull().default(0),
  reworkQty: doublePrecision('rework_qty').notNull().default(0),
  byProductQty: doublePrecision('by_product_qty').notNull().default(0),
  wasteKg: doublePrecision('waste_kg').notNull().default(0),
  outputMassQty: doublePrecision('output_mass_qty').notNull().default(0),
  outputMassUnit: text('output_mass_unit').notNull().default('kg'),
  lossReasonCodes: jsonb('loss_reason_codes')
    .$type<BatchLossRecord[]>()
    .notNull()
    .default([]),
  yieldPct: doublePrecision('yield_pct').notNull().default(0),
  variancePct: doublePrecision('variance_pct').notNull().default(0),
  materialCost: doublePrecision('material_cost').notNull().default(0),
  laborCost: doublePrecision('labor_cost').notNull().default(0),
  overheadCost: doublePrecision('overhead_cost').notNull().default(0),
  unitCost: doublePrecision('unit_cost').notNull().default(0),
  qcStatus: text('qc_status').notNull().default('Pending'),
  qcNotes: text('qc_notes').notNull().default(''),
  qcInspector: text('qc_inspector').notNull().default(''),
  retainedSampleQty: doublePrecision('retained_sample_qty').notNull().default(0),
  retainedSampleCode: text('retained_sample_code').notNull().default(''),
  retainedSampleLocation: text('retained_sample_location').notNull().default(''),
  qcInProcessSummary: text('qc_in_process_summary').notNull().default(''),
  qcFinalResults: text('qc_final_results').notNull().default(''),
  postedToInventory: boolean('posted_to_inventory').notNull().default(false),
  finishedGoodId: text('finished_good_id').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const finishedGoods = pgTable('finished_goods', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  batchId: text('batch_id')
    .references(() => batches.id)
    .notNull(),
  batchNumber: text('batch_number').notNull(),
  lotNumber: text('lot_number').notNull(),
  sku: text('sku').notNull(),
  productName: text('product_name').notNull(),
  quantityProduced: doublePrecision('quantity_produced').notNull(),
  quantityAvailable: doublePrecision('quantity_available').notNull(),
  unit: text('unit').notNull(),
  productionDate: text('production_date').notNull(),
  expiryDate: text('expiry_date').notNull(),
  qcStatus: text('qc_status').notNull().default('Released'),
  warehouseZone: text('warehouse_zone').notNull(),
  unitCost: doublePrecision('unit_cost').notNull().default(0),
  shipments: jsonb('shipments')
    .$type<FinishedGoodShipment[]>()
    .notNull()
    .default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sensors = pgTable('sensors', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  sensorCode: text('sensor_code').notNull(),
  name: text('name').notNull(),
  zone: text('zone').notNull(),
  equipmentType: text('equipment_type').notNull(),
  linkedLine: text('linked_line').notNull().default(''),
  currentTempC: doublePrecision('current_temp_c').notNull(),
  targetTempC: doublePrecision('target_temp_c').notNull(),
  minSafeTempC: doublePrecision('min_safe_temp_c').notNull(),
  maxSafeTempC: doublePrecision('max_safe_temp_c').notNull(),
  humidityPct: integer('humidity_pct').notNull().default(60),
  status: text('status').notNull().default('Nominal'),
  yieldImpactNote: text('yield_impact_note').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sensorMaintenanceLogs = pgTable('sensor_maintenance_logs', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  sensorId: text('sensor_id')
    .references(() => sensors.id, { onDelete: 'cascade' })
    .notNull(),
  sensorCode: text('sensor_code').notNull(),
  maintenanceType: text('maintenance_type').notNull().default('Calibration'),
  calibrationDate: text('calibration_date').notNull(),
  nextCalibrationDue: text('next_calibration_due').notNull(),
  offsetAdjustmentC: doublePrecision('offset_adjustment_c').notNull().default(0),
  asFoundTempC: doublePrecision('as_found_temp_c'),
  asLeftTempC: doublePrecision('as_left_temp_c'),
  verificationResult: text('verification_result').notNull().default('Pass'),
  technicianName: text('technician_name').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const batchCheckSpecs = pgTable('batch_check_specs', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  batchId: text('batch_id').notNull().default(''),
  batchNumber: text('batch_number').notNull(),
  productName: text('product_name').notNull(),
  productCategory: text('product_category').notNull().default('Sauce'),
  phMin: doublePrecision('ph_min'),
  phMax: doublePrecision('ph_max'),
  awMin: doublePrecision('aw_min'),
  awMax: doublePrecision('aw_max'),
  brixMin: doublePrecision('brix_min'),
  brixMax: doublePrecision('brix_max'),
  additionalParams: jsonb('additional_params')
    .$type<BatchCheckAdditionalParam[]>()
    .notNull()
    .default([]),
  requirementNotes: text('requirement_notes').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const batchCheckRecords = pgTable('batch_check_records', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  specId: text('spec_id')
    .references(() => batchCheckSpecs.id, { onDelete: 'cascade' })
    .notNull(),
  batchNumber: text('batch_number').notNull(),
  productCategory: text('product_category').notNull(),
  samplingStage: text('sampling_stage').notNull().default('In-Process'),
  measuredPh: doublePrecision('measured_ph'),
  measuredAw: doublePrecision('measured_aw'),
  measuredBrix: doublePrecision('measured_brix'),
  phReadings: jsonb('ph_readings').$type<number[]>().notNull().default([]),
  awReadings: jsonb('aw_readings').$type<number[]>().notNull().default([]),
  brixReadings: jsonb('brix_readings').$type<number[]>().notNull().default([]),
  additionalReadings: jsonb('additional_readings')
    .$type<BatchCheckAdditionalReading[]>()
    .notNull()
    .default([]),
  conditionStatus: text('condition_status').notNull().default('In Spec'),
  inspectorName: text('inspector_name').notNull(),
  recordedAt: text('recorded_at').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const productionLines = pgTable('production_lines', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  lineCode: text('line_code').notNull(),
  lineName: text('line_name').notNull(),
  machineName: text('machine_name').notNull(),
  machineModel: text('machine_model').notNull().default(''),
  category: text('category').notNull().default('Thermal Kettle'),
  supportedProductTypes: jsonb('supported_product_types')
    .$type<BatchCheckProductCategory[]>()
    .notNull()
    .default([]),
  status: text('status').notNull().default('Active'),
  batchCapacity: doublePrecision('batch_capacity').notNull().default(500),
  capacityUnit: text('capacity_unit').notNull().default('kg'),
  targetTempC: doublePrecision('target_temp_c'),
  agitatorRpm: integer('agitator_rpm'),
  pressureBar: doublePrecision('pressure_bar'),
  fillerSpeedUnitsPerMin: integer('filler_speed_units_per_min'),
  cleaningIntervalHours: integer('cleaning_interval_hours').notNull().default(8),
  defaultCrew: text('default_crew').notNull().default(''),
  linkedSensorCode: text('linked_sensor_code').notNull().default(''),
  customSettings: jsonb('custom_settings')
    .$type<MachineParameterSetting[]>()
    .notNull()
    .default([]),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .references(() => users.uid, { onDelete: 'cascade' })
    .notNull(),
  actorUid: text('actor_uid').notNull(),
  actorEmail: text('actor_email').notNull(),
  actorName: text('actor_name').notNull(),
  actorRole: text('actor_role').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  batchId: text('batch_id').notNull().default(''),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  reason: text('reason').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Drizzle Relations
export const usersRelations = relations(users, ({ many }) => ({
  formulas: many(formulas),
  rawMaterials: many(rawMaterials),
  batches: many(batches),
  finishedGoods: many(finishedGoods),
  sensors: many(sensors),
  sensorMaintenanceLogs: many(sensorMaintenanceLogs),
  batchCheckSpecs: many(batchCheckSpecs),
  batchCheckRecords: many(batchCheckRecords),
  productionLines: many(productionLines),
  auditLogs: many(auditLogs),
}));

export const formulasRelations = relations(formulas, ({ one, many }) => ({
  owner: one(users, { fields: [formulas.ownerId], references: [users.uid] }),
  batches: many(batches),
}));

export const batchesRelations = relations(batches, ({ one, many }) => ({
  owner: one(users, { fields: [batches.ownerId], references: [users.uid] }),
  formula: one(formulas, { fields: [batches.formulaId], references: [formulas.id] }),
  finishedGoods: many(finishedGoods),
}));

export const finishedGoodsRelations = relations(finishedGoods, ({ one }) => ({
  owner: one(users, { fields: [finishedGoods.ownerId], references: [users.uid] }),
  batch: one(batches, { fields: [finishedGoods.batchId], references: [batches.id] }),
}));

export const rawMaterialsRelations = relations(rawMaterials, ({ one }) => ({
  owner: one(users, { fields: [rawMaterials.ownerId], references: [users.uid] }),
}));

export const sensorsRelations = relations(sensors, ({ one, many }) => ({
  owner: one(users, { fields: [sensors.ownerId], references: [users.uid] }),
  maintenanceLogs: many(sensorMaintenanceLogs),
}));

export const sensorMaintenanceLogsRelations = relations(
  sensorMaintenanceLogs,
  ({ one }) => ({
    owner: one(users, {
      fields: [sensorMaintenanceLogs.ownerId],
      references: [users.uid],
    }),
    sensor: one(sensors, {
      fields: [sensorMaintenanceLogs.sensorId],
      references: [sensors.id],
    }),
  })
);

export const batchCheckSpecsRelations = relations(
  batchCheckSpecs,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [batchCheckSpecs.ownerId],
      references: [users.uid],
    }),
    records: many(batchCheckRecords),
  })
);

export const batchCheckRecordsRelations = relations(
  batchCheckRecords,
  ({ one }) => ({
    owner: one(users, {
      fields: [batchCheckRecords.ownerId],
      references: [users.uid],
    }),
    spec: one(batchCheckSpecs, {
      fields: [batchCheckRecords.specId],
      references: [batchCheckSpecs.id],
    }),
  })
);

export const productionLinesRelations = relations(
  productionLines,
  ({ one }) => ({
    owner: one(users, {
      fields: [productionLines.ownerId],
      references: [users.uid],
    }),
  })
);
