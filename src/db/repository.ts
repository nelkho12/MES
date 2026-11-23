import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db } from './index.ts';
import {
  DEFAULT_SENSOR_CONFIG,
  DEFAULT_WMS_CONFIG,
  auditLogs,
  batchCheckRecords,
  batchCheckSpecs,
  batches,
  finishedGoods,
  formulas,
  productionLines,
  rawMaterials,
  sensorMaintenanceLogs,
  sensors,
  users,
} from './schema.ts';
import {
  buildDefaultCategoryParameterPresets,
  buildDefaultRecipeProcessParameters,
  buildSeedBatchChecks,
  buildSeedMaintenanceLogs,
  buildSeedProductionLines,
  buildSeedWorkspace,
} from '../data/seedData.ts';
import {
  DEFAULT_ROLE_PERMISSIONS,
  hasFeaturePermission,
  sanitizeRolePermissionMatrix,
} from '../services/permissions.ts';
import { computeFieldDiff } from '../utils/auditDiff.ts';
import type {
  AllocatedMaterialRecord,
  AuditLogEntry,
  BackwardGenealogyMaterialItem,
  BackwardGenealogyResponse,
  BatchCheckAdditionalParam,
  BatchCheckAdditionalReading,
  BatchCheckConditionStatus,
  BatchCheckProductCategory,
  BatchCheckRecord,
  BatchCheckSpec,
  BatchCategoryCompletionItem,
  BatchCategoryCompletionResponse,
  BatchLossRecord,
  BatchSourceType,
  BatchStatus,
  BatchYieldTrendPoint,
  BatchYieldTrendsResponse,
  BomIngredient,
  CalibrationResult,
  CategoryParameterPresetMap,
  EbrParameterReading,
  FinishedGoodLot,
  FinishedGoodShipment,
  FormulaBOM,
  IssuedMaterialRecord,
  LineOperationalStatus,
  MachineCategory,
  MachineParameterSetting,
  MaintenanceType,
  MaterialCategory,
  MesFeatureKey,
  NormalizedSensorReading,
  ProcessCheckRecord,
  ProductionBatch,
  ProductionLineMachine,
  QcStatus,
  RawMaterialLot,
  ReadingSource,
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
} from '../types.ts';
import {
  calculateBomAvailability,
  calculateExpiryDate,
  convertQuantity,
  deriveRawLotStatus,
  evaluateSensorStatus,
  generateBatchAndLotNumbers,
} from '../utils/units.ts';

export interface ActorContext {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  rolePermissions?: RolePermissionMatrix;
}

export interface ClosedOverrideOptions {
  authorizedOverride?: boolean;
  overrideReason?: string;
}

export class ForbiddenError extends Error {
  statusCode = 403;
}

export class ValidationError extends Error {
  statusCode = 400;
}

const VALID_ROLES: UserRole[] = ['operator', 'supervisor', 'qc', 'manager', 'admin'];

function normalizeRole(role: unknown): UserRole {
  if (typeof role === 'string' && VALID_ROLES.includes(role as UserRole)) {
    return role as UserRole;
  }
  return 'manager';
}

function defaultActor(ownerId: string, name = 'Plant User'): ActorContext {
  return {
    uid: ownerId,
    email: 'operator@kettler.local',
    name,
    role: 'manager',
    rolePermissions: DEFAULT_ROLE_PERMISSIONS,
  };
}

function assertActorPermission(
  actor: ActorContext,
  feature: MesFeatureKey,
  actionDescription: string
): void {
  if (!hasFeaturePermission(actor.rolePermissions, actor.role, feature)) {
    throw new ForbiddenError(
      `Role "${actor.role}" does not have "${feature}" permission to ${actionDescription}.`
    );
  }
}

export async function getActorContextDb(
  uid: string,
  email?: string,
  name?: string
): Promise<ActorContext> {
  const [userRow] = await db.select().from(users).where(eq(users.uid, uid));
  return {
    uid,
    email: userRow?.email || email || 'operator@kettler.local',
    name: userRow?.displayName || name || email || 'Plant User',
    role: normalizeRole(userRow?.role),
    rolePermissions: sanitizeRolePermissionMatrix(userRow?.rolePermissions),
  };
}

type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

async function writeAuditLog(
  executor: DbOrTx,
  entry: {
    ownerId: string;
    actor: ActorContext;
    action: string;
    entityType: string;
    entityId: string;
    batchId?: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
  }
): Promise<void> {
  await executor.insert(auditLogs).values({
    id: makeSafeId('aud'),
    ownerId: entry.ownerId,
    actorUid: entry.actor.uid,
    actorEmail: (entry.actor.email || 'operator@kettler.local').slice(0, 120),
    actorName: (entry.actor.name || 'Plant User').slice(0, 100),
    actorRole: entry.actor.role,
    action: entry.action.slice(0, 80),
    entityType: entry.entityType.slice(0, 40),
    entityId: entry.entityId.slice(0, 120),
    batchId: (entry.batchId || '').slice(0, 120),
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    reason: (entry.reason || '').trim().slice(0, 500),
  });
}

function assertClosedBatchEditable(
  batch: { status: string; batchNumber: string },
  actor: ActorContext,
  override?: ClosedOverrideOptions
): { isClosedOverride: boolean; overrideReason: string } {
  if (batch.status !== 'Closed') {
    return { isClosedOverride: false, overrideReason: '' };
  }
  if (!hasFeaturePermission(actor.rolePermissions, actor.role, 'overrideClosedBatch')) {
    throw new ForbiddenError(
      `Batch ${batch.batchNumber} is Closed and locked. Role "${actor.role}" does not have Override Closed Batch permission.`
    );
  }
  const reason = (override?.overrideReason || '').trim();
  if (!override?.authorizedOverride || !reason) {
    throw new ForbiddenError(
      `Batch ${batch.batchNumber} is Closed and locked. Enable Authorized Override and provide a non-empty override reason to modify.`
    );
  }
  return { isClosedOverride: true, overrideReason: reason };
}

function makeSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName: string
): Promise<UserProfile> {
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email: email || 'operator@kettler.local',
        displayName: (displayName || email || 'Plant Operator').slice(0, 100),
        role: 'manager',
        plantName: 'Kettler Processing Facility · Plant 01',
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: email || 'operator@kettler.local',
          displayName: (displayName || email || 'Plant Operator').slice(0, 100),
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0] as UserProfile;
  } catch (error) {
    console.error('Failed to synchronize user profile:', error);
    throw new Error('Unable to synchronize user account. Please try again.', { cause: error });
  }
}

export async function updateUserRoleDb(uid: string, role: UserRole): Promise<UserProfile> {
  try {
    const validRole = normalizeRole(role);
    const [existing] = await db.select().from(users).where(eq(users.uid, uid));
    const [updated] = await db
      .update(users)
      .set({ role: validRole, updatedAt: new Date() })
      .where(eq(users.uid, uid))
      .returning();
    if (existing && updated && existing.role !== validRole) {
      await writeAuditLog(db, {
        ownerId: uid,
        actor: {
          uid,
          email: updated.email,
          name: updated.displayName,
          role: validRole,
        },
        action: 'UPDATE_USER_ROLE',
        entityType: 'user',
        entityId: uid,
        oldValue: { role: existing.role },
        newValue: { role: validRole },
        reason: 'Active role switched',
      });
    }
    return updated as UserProfile;
  } catch (error) {
    console.error('Failed to update user role:', error);
    throw new Error('Unable to update user role.', { cause: error });
  }
}

function sanitizeStringList(raw: unknown, fallback: string[], maxLen = 40): string[] {
  if (!Array.isArray(raw)) return fallback;
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of raw) {
    const val = String(item ?? '').trim().slice(0, maxLen);
    if (!val) continue;
    const key = val.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(val);
    if (cleaned.length >= 24) break;
  }
  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeCategoryParameterPresets(
  raw: unknown,
  categories: string[] = ['Sauce', 'Syrup', 'Powder']
): CategoryParameterPresetMap {
  const defaults = buildDefaultCategoryParameterPresets(categories);
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result: CategoryParameterPresetMap = { ...defaults };

  for (const [catKey, params] of Object.entries(src)) {
    const cleanKey = catKey.trim().slice(0, 40);
    if (!cleanKey || !Array.isArray(params)) continue;
    result[cleanKey] = sanitizeProcessParameters(params, cleanKey);
  }
  return result;
}

export async function updateRolePermissionsDb(
  uid: string,
  matrixInput: unknown,
  actor?: ActorContext
): Promise<UserProfile> {
  const effectiveActor = actor || defaultActor(uid);
  try {
    assertActorPermission(effectiveActor, 'manageRolesAccess', 'update role permission controls');
    const [existing] = await db.select().from(users).where(eq(users.uid, uid));
    if (!existing) throw new ValidationError('User profile not found.');

    const prevMatrix = sanitizeRolePermissionMatrix(existing.rolePermissions);
    const nextMatrix = sanitizeRolePermissionMatrix(matrixInput);

    const [updated] = await db
      .update(users)
      .set({
        rolePermissions: nextMatrix,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid))
      .returning();

    await writeAuditLog(db, {
      ownerId: uid,
      actor: effectiveActor,
      action: 'UPDATE_ROLE_PERMISSIONS',
      entityType: 'user',
      entityId: uid,
      oldValue: prevMatrix,
      newValue: nextMatrix,
      reason: 'Active role feature permission matrix updated',
    });

    return updated as UserProfile;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update role permissions:', error);
    throw new Error('Unable to save role permission matrix.', { cause: error });
  }
}

export async function updateCategoryParameterPresetsDb(
  uid: string,
  presetsInput: unknown,
  actor?: ActorContext
): Promise<UserProfile> {
  const effectiveActor = actor || defaultActor(uid);
  try {
    assertActorPermission(effectiveActor, 'manageFormulasBom', 'update category parameter templates');
    const [existing] = await db.select().from(users).where(eq(users.uid, uid));
    if (!existing) throw new ValidationError('User profile not found.');

    const cats =
      Array.isArray(existing.productCategories) && existing.productCategories.length > 0
        ? existing.productCategories
        : ['Sauce', 'Syrup', 'Powder'];
    const prevPresets = sanitizeCategoryParameterPresets(existing.categoryParameterPresets, cats);
    const nextPresets = sanitizeCategoryParameterPresets(presetsInput, cats);

    const [updated] = await db
      .update(users)
      .set({
        categoryParameterPresets: nextPresets,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid))
      .returning();

    await writeAuditLog(db, {
      ownerId: uid,
      actor: effectiveActor,
      action: 'UPDATE_CATEGORY_PARAMETER_PRESETS',
      entityType: 'formula',
      entityId: uid,
      oldValue: prevPresets,
      newValue: nextPresets,
      reason: 'Preset category process parameter templates updated',
    });

    return updated as UserProfile;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update category parameter presets:', error);
    throw new Error('Unable to save category parameter presets.', { cause: error });
  }
}

export async function updatePlantOptionsDb(
  uid: string,
  input: {
    productCategories?: string[];
    operationalStatuses?: string[];
  }
): Promise<UserProfile> {
  try {
    const [existing] = await db.select().from(users).where(eq(users.uid, uid));
    if (!existing) throw new Error('User profile not found.');

    const nextCategories = input.productCategories
      ? sanitizeStringList(input.productCategories, ['Sauce', 'Syrup', 'Powder'], 40)
      : existing.productCategories;
    const nextStatuses = input.operationalStatuses
      ? sanitizeStringList(
          input.operationalStatuses,
          ['Active', 'Standby', 'CIP Cleaning', 'Maintenance'],
          40
        )
      : existing.operationalStatuses;
    const nextCategoryPresets = sanitizeCategoryParameterPresets(
      existing.categoryParameterPresets,
      nextCategories
    );

    const [updated] = await db
      .update(users)
      .set({
        productCategories: nextCategories,
        operationalStatuses: nextStatuses,
        categoryParameterPresets: nextCategoryPresets,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid))
      .returning();

    return updated as UserProfile;
  } catch (error) {
    console.error('Failed to update plant options:', error);
    throw new Error('Unable to save custom product categories or operational statuses.', {
      cause: error,
    });
  }
}

export function sanitizeSensorAdapterConfig(raw: unknown): SensorAdapterConfig {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const modeRaw = String(src.adapterMode || 'simulator');
  const adapterMode =
    modeRaw === 'rest' || modeRaw === 'mqtt' || modeRaw === 'file' ? modeRaw : 'simulator';
  const rawPerLine =
    src.perLineEnabled && typeof src.perLineEnabled === 'object'
      ? (src.perLineEnabled as Record<string, unknown>)
      : {};
  const perLineEnabled: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rawPerLine)) {
    const key = String(k).trim().slice(0, 80);
    if (key) perLineEnabled[key] = Boolean(v);
  }
  const pollingIntervalSec = Math.min(
    300,
    Math.max(2, Math.round(Number(src.pollingIntervalSec) || DEFAULT_SENSOR_CONFIG.pollingIntervalSec))
  );
  const saveIntervalSec = Math.min(
    3600,
    Math.max(10, Math.round(Number(src.saveIntervalSec) || DEFAULT_SENSOR_CONFIG.saveIntervalSec))
  );
  const offlineAlarmThresholdSec = Math.min(
    3600,
    Math.max(
      10,
      Math.round(
        Number(src.offlineAlarmThresholdSec) || DEFAULT_SENSOR_CONFIG.offlineAlarmThresholdSec
      )
    )
  );
  return {
    masterEnabled: Boolean(src.masterEnabled), // default false unless explicitly enabled
    adapterMode,
    perLineEnabled,
    pollingIntervalSec,
    saveIntervalSec,
    gatewayUrl: String(src.gatewayUrl ?? DEFAULT_SENSOR_CONFIG.gatewayUrl).trim().slice(0, 300),
    backfillUrl: String(src.backfillUrl ?? '').trim().slice(0, 300),
    mqttWsUrl: String(src.mqttWsUrl ?? DEFAULT_SENSOR_CONFIG.mqttWsUrl).trim().slice(0, 300),
    mqttTopic: String(src.mqttTopic ?? DEFAULT_SENSOR_CONFIG.mqttTopic).trim().slice(0, 160),
    offlineAlarmThresholdSec,
    autoBackfillOnOpen:
      src.autoBackfillOnOpen === undefined ? true : Boolean(src.autoBackfillOnOpen),
  };
}

export async function updateSensorConfigDb(
  uid: string,
  input: Partial<SensorAdapterConfig>,
  actor?: ActorContext
): Promise<UserProfile> {
  const effectiveActor = actor || defaultActor(uid);
  try {
    assertActorPermission(effectiveActor, 'configureSensors', 'update sensor adapter settings');
    const [existing] = await db.select().from(users).where(eq(users.uid, uid));
    if (!existing) throw new ValidationError('User profile not found.');

    const prevConfig = sanitizeSensorAdapterConfig(existing.sensorConfig || DEFAULT_SENSOR_CONFIG);
    const nextConfig = sanitizeSensorAdapterConfig({
      ...prevConfig,
      ...(input && typeof input === 'object' ? input : {}),
      perLineEnabled: {
        ...prevConfig.perLineEnabled,
        ...(input?.perLineEnabled || {}),
      },
    });

    const [updated] = await db
      .update(users)
      .set({
        sensorConfig: nextConfig,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid))
      .returning();

    await writeAuditLog(db, {
      ownerId: uid,
      actor: effectiveActor,
      action: 'UPDATE_SENSOR_CONFIG',
      entityType: 'sensor',
      entityId: uid,
      oldValue: prevConfig,
      newValue: nextConfig,
      reason: `Sensor Master Switch ${nextConfig.masterEnabled ? 'ON' : 'OFF'} · Mode: ${nextConfig.adapterMode}`,
    });

    return updated as UserProfile;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update sensor adapter configuration:', error);
    throw new Error('Unable to save sensor adapter settings.', { cause: error });
  }
}

export function sanitizeWmsConnectorConfig(raw: unknown): WmsConnectorConfig {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const timeoutMs = Math.min(
    60000,
    Math.max(1000, Math.round(Number(src.timeoutMs) || DEFAULT_WMS_CONFIG.timeoutMs))
  );
  return {
    enabled: Boolean(src.enabled), // default OFF
    baseUrl: String(src.baseUrl ?? DEFAULT_WMS_CONFIG.baseUrl).trim().slice(0, 300),
    rawMaterialsPath:
      String(src.rawMaterialsPath ?? DEFAULT_WMS_CONFIG.rawMaterialsPath).trim().slice(0, 120) ||
      '/raw-materials',
    finishedGoodsPath:
      String(src.finishedGoodsPath ?? DEFAULT_WMS_CONFIG.finishedGoodsPath).trim().slice(0, 120) ||
      '/finished-goods',
    timeoutMs,
    autoPushFgOnQcPass: Boolean(src.autoPushFgOnQcPass),
    lastSyncAt: String(src.lastSyncAt ?? '').trim().slice(0, 40),
  };
}

export async function updateWmsConfigDb(
  uid: string,
  input: Partial<WmsConnectorConfig>,
  actor?: ActorContext
): Promise<UserProfile> {
  const effectiveActor = actor || defaultActor(uid);
  try {
    assertActorPermission(effectiveActor, 'manageInventoryWms', 'update WMS connector settings');
    const [existing] = await db.select().from(users).where(eq(users.uid, uid));
    if (!existing) throw new ValidationError('User profile not found.');

    const prevConfig = sanitizeWmsConnectorConfig(existing.wmsConfig || DEFAULT_WMS_CONFIG);
    const nextConfig = sanitizeWmsConnectorConfig({
      ...prevConfig,
      ...(input && typeof input === 'object' ? input : {}),
    });

    const [updated] = await db
      .update(users)
      .set({
        wmsConfig: nextConfig,
        updatedAt: new Date(),
      })
      .where(eq(users.uid, uid))
      .returning();

    await writeAuditLog(db, {
      ownerId: uid,
      actor: effectiveActor,
      action: 'UPDATE_WMS_CONFIG',
      entityType: 'user',
      entityId: uid,
      oldValue: prevConfig,
      newValue: nextConfig,
      reason: `WMS REST Connector ${nextConfig.enabled ? 'ENABLED' : 'DISABLED'} (${nextConfig.baseUrl})`,
    });

    return updated as UserProfile;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update WMS connector configuration:', error);
    throw new Error('Unable to save WMS connector settings.', { cause: error });
  }
}

async function seedWorkspaceDb(ownerId: string): Promise<void> {
  const seed = buildSeedWorkspace(ownerId);
  await db.transaction(async (tx) => {
    for (const f of seed.formulas) {
      await tx.insert(formulas).values(f).onConflictDoNothing();
    }
    for (const rm of seed.rawMaterials) {
      await tx.insert(rawMaterials).values(rm).onConflictDoNothing();
    }
    for (const s of seed.sensors) {
      await tx.insert(sensors).values(s).onConflictDoNothing();
    }
    for (const b of seed.batches) {
      await tx.insert(batches).values(b).onConflictDoNothing();
    }
    for (const fg of seed.finishedGoods) {
      await tx.insert(finishedGoods).values(fg).onConflictDoNothing();
    }
  });
}

export async function getWorkspaceSnapshot(
  uid: string,
  email: string,
  displayName: string
): Promise<WorkspaceSnapshot> {
  try {
    const profile = await getOrCreateUser(uid, email, displayName);

    let formulaRows = await db
      .select()
      .from(formulas)
      .where(eq(formulas.ownerId, uid))
      .orderBy(asc(formulas.sku), desc(formulas.version));

    if (formulaRows.length === 0) {
      await seedWorkspaceDb(uid);
      formulaRows = await db
        .select()
        .from(formulas)
        .where(eq(formulas.ownerId, uid))
        .orderBy(asc(formulas.sku), desc(formulas.version));
    }

    const [
      rawRows,
      batchRows,
      fgRows,
      sensorRows,
      initialMaintenanceRows,
      initialSpecRows,
      initialCheckRows,
      initialLineRows,
      auditRows,
    ] = await Promise.all([
      db
        .select()
        .from(rawMaterials)
        .where(eq(rawMaterials.ownerId, uid))
        .orderBy(asc(rawMaterials.materialCode)),
      db
        .select()
        .from(batches)
        .where(eq(batches.ownerId, uid))
        .orderBy(desc(batches.batchNumber)),
      db
        .select()
        .from(finishedGoods)
        .where(eq(finishedGoods.ownerId, uid))
        .orderBy(desc(finishedGoods.productionDate)),
      db
        .select()
        .from(sensors)
        .where(eq(sensors.ownerId, uid))
        .orderBy(asc(sensors.sensorCode)),
      db
        .select()
        .from(sensorMaintenanceLogs)
        .where(eq(sensorMaintenanceLogs.ownerId, uid))
        .orderBy(
          desc(sensorMaintenanceLogs.calibrationDate),
          desc(sensorMaintenanceLogs.createdAt)
        ),
      db
        .select()
        .from(batchCheckSpecs)
        .where(eq(batchCheckSpecs.ownerId, uid))
        .orderBy(desc(batchCheckSpecs.batchNumber)),
      db
        .select()
        .from(batchCheckRecords)
        .where(eq(batchCheckRecords.ownerId, uid))
        .orderBy(
          desc(batchCheckRecords.recordedAt),
          desc(batchCheckRecords.createdAt)
        ),
      db
        .select()
        .from(productionLines)
        .where(eq(productionLines.ownerId, uid))
        .orderBy(asc(productionLines.lineCode)),
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.ownerId, uid))
        .orderBy(desc(auditLogs.createdAt))
        .limit(500),
    ]);

    let maintenanceRows = initialMaintenanceRows;
    if (sensorRows.length > 0 && maintenanceRows.length === 0) {
      const seedLogs = buildSeedMaintenanceLogs(
        uid,
        sensorRows as unknown as ThermalSensor[]
      );
      if (seedLogs.length > 0) {
        await db.transaction(async (tx) => {
          for (const log of seedLogs) {
            await tx.insert(sensorMaintenanceLogs).values(log).onConflictDoNothing();
          }
        });
        maintenanceRows = await db
          .select()
          .from(sensorMaintenanceLogs)
          .where(eq(sensorMaintenanceLogs.ownerId, uid))
          .orderBy(
            desc(sensorMaintenanceLogs.calibrationDate),
            desc(sensorMaintenanceLogs.createdAt)
          );
      }
    }

    let specRows = initialSpecRows;
    let checkRows = initialCheckRows;
    if (specRows.length === 0) {
      const seedChecks = buildSeedBatchChecks(
        uid,
        batchRows as unknown as ProductionBatch[]
      );
      await db.transaction(async (tx) => {
        for (const spec of seedChecks.specs) {
          await tx.insert(batchCheckSpecs).values(spec).onConflictDoNothing();
        }
        for (const rec of seedChecks.records) {
          await tx.insert(batchCheckRecords).values(rec).onConflictDoNothing();
        }
      });
      [specRows, checkRows] = await Promise.all([
        db
          .select()
          .from(batchCheckSpecs)
          .where(eq(batchCheckSpecs.ownerId, uid))
          .orderBy(desc(batchCheckSpecs.batchNumber)),
        db
          .select()
          .from(batchCheckRecords)
          .where(eq(batchCheckRecords.ownerId, uid))
          .orderBy(
            desc(batchCheckRecords.recordedAt),
            desc(batchCheckRecords.createdAt)
          ),
      ]);
    }

    let lineRows = initialLineRows;
    if (lineRows.length === 0) {
      const seedLines = buildSeedProductionLines(uid);
      await db.transaction(async (tx) => {
        for (const line of seedLines) {
          await tx.insert(productionLines).values(line).onConflictDoNothing();
        }
      });
      lineRows = await db
        .select()
        .from(productionLines)
        .where(eq(productionLines.ownerId, uid))
        .orderBy(asc(productionLines.lineCode));
    }

    const hydratedFormulas = (formulaRows as unknown as FormulaBOM[]).map((f) => ({
      ...f,
      category: (f.category || '').trim() || 'Sauce',
      processParameters:
        Array.isArray(f.processParameters) && f.processParameters.length > 0
          ? f.processParameters
          : buildDefaultRecipeProcessParameters(`${f.sku} ${f.productName}`, f.category || ''),
    }));

    const hydratedProfile: UserProfile = {
      ...profile,
      rolePermissions: sanitizeRolePermissionMatrix(profile.rolePermissions),
      categoryParameterPresets: sanitizeCategoryParameterPresets(
        profile.categoryParameterPresets,
        profile.productCategories && profile.productCategories.length > 0
          ? profile.productCategories
          : ['Sauce', 'Syrup', 'Powder']
      ),
    };

    return {
      profile: hydratedProfile,
      formulas: hydratedFormulas,
      rawMaterials: rawRows as unknown as RawMaterialLot[],
      batches: batchRows as unknown as ProductionBatch[],
      finishedGoods: fgRows as unknown as FinishedGoodLot[],
      sensors: sensorRows as unknown as ThermalSensor[],
      maintenanceLogs: maintenanceRows as unknown as SensorMaintenanceLog[],
      batchCheckSpecs: specRows as unknown as BatchCheckSpec[],
      batchCheckRecords: checkRows as unknown as BatchCheckRecord[],
      productionLines: lineRows as unknown as ProductionLineMachine[],
      auditLogs: auditRows as unknown as AuditLogEntry[],
    };
  } catch (error) {
    console.error('Failed to load workspace snapshot:', error);
    throw new Error('Unable to load production workspace data. Please try again.', {
      cause: error,
    });
  }
}

function sanitizeProcessParameters(
  raw: unknown,
  fallbackKey = ''
): RecipeProcessParameter[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return buildDefaultRecipeProcessParameters(fallbackKey);
  }
  return raw
    .filter((p) => p && typeof p === 'object')
    .slice(0, 20)
    .map((p: Record<string, unknown>, idx) => ({
      id: String(p.id || `pp-${idx + 1}`).trim().slice(0, 48),
      key: String(p.key || `param_${idx + 1}`).trim().toLowerCase().slice(0, 40),
      name: String(p.name || `Parameter ${idx + 1}`).trim().slice(0, 80),
      unit: String(p.unit || '').trim().slice(0, 24),
      target: toNullableNum(p.target),
      min: toNullableNum(p.min),
      max: toNullableNum(p.max),
    }));
}

export async function createFormulaVersionDb(
  ownerId: string,
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
  archiveFormulaId?: string,
  actor?: ActorContext
): Promise<string> {
  const effectiveActor = actor || defaultActor(ownerId);
  assertActorPermission(effectiveActor, 'manageFormulasBom', 'create BOM formula versions');
  const newId = makeSafeId('frm');
  const category = String(payload.category || 'Sauce').trim().slice(0, 40) || 'Sauce';
  const processParameters = sanitizeProcessParameters(
    payload.processParameters,
    category || `${payload.sku} ${payload.productName}`
  );
  try {
    await db.transaction(async (tx) => {
      await tx.insert(formulas).values({
        id: newId,
        ownerId,
        sku: payload.sku.trim().slice(0, 40),
        productName: payload.productName.trim().slice(0, 120),
        category,
        packSize: payload.packSize.trim().slice(0, 60),
        shelfLifeDays: Math.max(1, Math.min(3650, Number(payload.shelfLifeDays) || 180)),
        standardBatchSize: Math.max(1, Number(payload.standardBatchSize) || 500),
        outputUnit: payload.outputUnit.trim().slice(0, 20) || 'units',
        version: payload.version.trim().slice(0, 24),
        approvalStatus: payload.approvalStatus,
        isConfidentialOem: Boolean(payload.isConfidentialOem),
        oemCustomer: payload.oemCustomer.trim().slice(0, 100),
        laborCostPerBatch: Math.max(0, Number(payload.laborCostPerBatch) || 0),
        overheadCostPerBatch: Math.max(0, Number(payload.overheadCostPerBatch) || 0),
        ingredients: payload.ingredients.slice(0, 30),
        routingSteps: payload.routingSteps.slice(0, 15),
        processParameters,
      });

      if (archiveFormulaId && payload.approvalStatus === 'Approved') {
        await tx
          .update(formulas)
          .set({ approvalStatus: 'Archived', updatedAt: new Date() })
          .where(and(eq(formulas.id, archiveFormulaId), eq(formulas.ownerId, ownerId)));
      }

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'CREATE_FORMULA_VERSION',
        entityType: 'formula',
        entityId: newId,
        newValue: {
          sku: payload.sku,
          category,
          version: payload.version,
          approvalStatus: payload.approvalStatus,
          processParametersCount: processParameters.length,
        },
      });
    });
    return newId;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to create formula version:', error);
    throw new Error('Unable to save new formula version.', { cause: error });
  }
}

export async function updateFormulaProcessParametersDb(
  ownerId: string,
  formulaId: string,
  processParametersInput: RecipeProcessParameter[],
  actor?: ActorContext,
  categoryInput?: string
): Promise<FormulaBOM> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    assertActorPermission(effectiveActor, 'manageFormulasBom', 'edit BOM category and parameters');
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(formulas)
        .where(and(eq(formulas.id, formulaId), eq(formulas.ownerId, ownerId)));
      if (!existing) throw new ValidationError('Formula not found.');

      const nextCategory = categoryInput?.trim()
        ? categoryInput.trim().slice(0, 40)
        : existing.category || 'Sauce';
      const sanitized = sanitizeProcessParameters(
        processParametersInput,
        nextCategory || `${existing.sku} ${existing.productName}`
      );
      const [updated] = await tx
        .update(formulas)
        .set({ category: nextCategory, processParameters: sanitized, updatedAt: new Date() })
        .where(and(eq(formulas.id, formulaId), eq(formulas.ownerId, ownerId)))
        .returning();

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'UPDATE_FORMULA_PARAMETERS',
        entityType: 'formula',
        entityId: formulaId,
        oldValue: { category: existing.category, processParameters: existing.processParameters },
        newValue: { category: nextCategory, processParameters: sanitized },
        reason: `Recipe category (${nextCategory}) & process parameters updated`,
      });

      return updated as unknown as FormulaBOM;
    });
  } catch (error) {
    console.error('Failed to update formula parameters:', error);
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    throw new Error('Unable to save recipe process parameters.', { cause: error });
  }
}

export async function approveFormulaVersionDb(
  ownerId: string,
  formulaId: string,
  previousApprovedId?: string
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(formulas)
        .set({ approvalStatus: 'Approved', updatedAt: new Date() })
        .where(and(eq(formulas.id, formulaId), eq(formulas.ownerId, ownerId)));
      if (previousApprovedId && previousApprovedId !== formulaId) {
        await tx
          .update(formulas)
          .set({ approvalStatus: 'Archived', updatedAt: new Date() })
          .where(and(eq(formulas.id, previousApprovedId), eq(formulas.ownerId, ownerId)));
      }
    });
  } catch (error) {
    console.error('Failed to approve formula version:', error);
    throw new Error('Unable to approve formula version.', { cause: error });
  }
}

export async function receiveRawMaterialLotDb(
  ownerId: string,
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
  const lotId = makeSafeId('rm');
  const qty = Math.max(0, Number(input.quantityInitial));
  const reorder = Math.max(0, Number(input.reorderLevel));
  const status = deriveRawLotStatus(qty, reorder, input.expiryDate);
  try {
    await db.insert(rawMaterials).values({
      id: lotId,
      ownerId,
      lotNumber: input.lotNumber.trim().slice(0, 64),
      materialCode: input.materialCode.trim().toUpperCase().slice(0, 40),
      materialName: input.materialName.trim().slice(0, 120),
      category: input.category,
      unit: input.unit,
      quantityInitial: qty,
      quantityAvailable: qty,
      reorderLevel: reorder,
      unitCost: Math.max(0, Number(input.unitCost)),
      supplier: input.supplier.trim().slice(0, 100),
      expiryDate: input.expiryDate.trim().slice(0, 32),
      storageZone: input.storageZone.trim().slice(0, 80),
      status,
    });
    return lotId;
  } catch (error) {
    console.error('Failed to receive raw material lot:', error);
    throw new Error('Unable to save incoming raw material lot.', { cause: error });
  }
}

export async function replenishRawMaterialLotDb(
  ownerId: string,
  lotId: string,
  addQty: number
): Promise<void> {
  try {
    const [existing] = await db
      .select()
      .from(rawMaterials)
      .where(and(eq(rawMaterials.id, lotId), eq(rawMaterials.ownerId, ownerId)));
    if (!existing) throw new Error('Raw material lot not found.');

    const nextQty = Number(Math.max(0, existing.quantityAvailable + addQty).toFixed(3));
    const status = deriveRawLotStatus(nextQty, existing.reorderLevel, existing.expiryDate);
    await db
      .update(rawMaterials)
      .set({ quantityAvailable: nextQty, status, updatedAt: new Date() })
      .where(and(eq(rawMaterials.id, lotId), eq(rawMaterials.ownerId, ownerId)));
  } catch (error) {
    console.error('Failed to replenish raw material lot:', error);
    throw new Error('Unable to replenish stock lot.', { cause: error });
  }
}

export async function adjustRawMaterialLotDb(
  ownerId: string,
  lotId: string,
  input: {
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
  try {
    const [existing] = await db
      .select()
      .from(rawMaterials)
      .where(and(eq(rawMaterials.id, lotId), eq(rawMaterials.ownerId, ownerId)));
    if (!existing) throw new Error('Raw material lot not found.');

    const qtyInput = Number(input.quantity);
    if (!Number.isFinite(qtyInput) || qtyInput < 0) {
      throw new Error('Quantity must be zero or a positive number.');
    }

    let nextQty = existing.quantityAvailable;
    if (input.mode === 'add') {
      nextQty = Number((existing.quantityAvailable + qtyInput).toFixed(3));
    } else if (input.mode === 'deduct') {
      nextQty = Number(Math.max(0, existing.quantityAvailable - qtyInput).toFixed(3));
    } else {
      nextQty = Number(Math.max(0, qtyInput).toFixed(3));
    }

    const nextLotNumber =
      input.lotNumber !== undefined
        ? input.lotNumber.trim().slice(0, 64) || existing.lotNumber
        : existing.lotNumber;
    const nextReorder =
      input.reorderLevel !== undefined && Number.isFinite(Number(input.reorderLevel))
        ? Math.max(0, Number(input.reorderLevel))
        : existing.reorderLevel;
    const nextUnitCost =
      input.unitCost !== undefined && Number.isFinite(Number(input.unitCost))
        ? Math.max(0, Number(input.unitCost))
        : existing.unitCost;
    const nextSupplier =
      input.supplier !== undefined
        ? input.supplier.trim().slice(0, 100) || existing.supplier
        : existing.supplier;
    const nextExpiry =
      input.expiryDate !== undefined
        ? input.expiryDate.trim().slice(0, 32) || existing.expiryDate
        : existing.expiryDate;
    const nextZone =
      input.storageZone !== undefined
        ? input.storageZone.trim().slice(0, 80) || existing.storageZone
        : existing.storageZone;

    const status = deriveRawLotStatus(nextQty, nextReorder, nextExpiry);
    const [updated] = await db
      .update(rawMaterials)
      .set({
        lotNumber: nextLotNumber,
        quantityAvailable: nextQty,
        reorderLevel: nextReorder,
        unitCost: nextUnitCost,
        supplier: nextSupplier,
        expiryDate: nextExpiry,
        storageZone: nextZone,
        status,
        updatedAt: new Date(),
      })
      .where(and(eq(rawMaterials.id, lotId), eq(rawMaterials.ownerId, ownerId)))
      .returning();

    return updated as unknown as RawMaterialLot;
  } catch (error) {
    console.error('Failed to adjust raw material lot:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('not found') || error.message.includes('Quantity'))
        ? error.message
        : 'Unable to update raw material lot.';
    throw new Error(msg, { cause: error });
  }
}

export async function deleteRawMaterialLotDb(
  ownerId: string,
  lotId: string
): Promise<void> {
  try {
    const [existing] = await db
      .select()
      .from(rawMaterials)
      .where(and(eq(rawMaterials.id, lotId), eq(rawMaterials.ownerId, ownerId)));
    if (!existing) throw new Error('Raw material lot not found.');

    const ownerBatches = await db
      .select({
        batchNumber: batches.batchNumber,
        issuedMaterials: batches.issuedMaterials,
      })
      .from(batches)
      .where(eq(batches.ownerId, ownerId));

    const linkedBatch = ownerBatches.find((b) =>
      (b.issuedMaterials || []).some((m) => m.lotId === lotId)
    );
    if (linkedBatch) {
      throw new Error(
        `Lot ${existing.lotNumber} is already issued to batch ${linkedBatch.batchNumber} and cannot be deleted; adjust its available stock instead.`
      );
    }

    await db
      .delete(rawMaterials)
      .where(and(eq(rawMaterials.id, lotId), eq(rawMaterials.ownerId, ownerId)));
  } catch (error) {
    console.error('Failed to delete raw material lot:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('not found') || error.message.includes('already issued'))
        ? error.message
        : 'Unable to delete raw material lot.';
    throw new Error(msg, { cause: error });
  }
}

export async function createWorkOrderDb(
  ownerId: string,
  input: {
    formulaId: string;
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
    batchCheckSpecId?: string;
  },
  actor?: ActorContext
): Promise<string> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    assertActorPermission(effectiveActor, 'planReleaseJobOrders', 'plan production job orders');
    const [formula] = await db
      .select()
      .from(formulas)
      .where(and(eq(formulas.id, input.formulaId), eq(formulas.ownerId, ownerId)));
    if (!formula) throw new ValidationError('Selected formula not found.');

    const existingBatches = await db
      .select({ id: batches.id })
      .from(batches)
      .where(eq(batches.ownerId, ownerId));

    const batchId = makeSafeId('bat');
    const plannedQty = Math.max(1, Number(input.plannedQty));
    const { batchNumber } = generateBatchAndLotNumbers(
      formula.sku,
      input.lineName,
      existingBatches.length
    );
    const scaleFactor =
      formula.standardBatchSize > 0 ? plannedQty / formula.standardBatchSize : 1;
    const plannedDate = input.plannedDate.slice(0, 32);
    const shift = (input.shift || 'Shift A (06:00–14:00)').trim().slice(0, 60);
    const plannedStartAt =
      (input.plannedStartAt || '').trim().slice(0, 32) || `${plannedDate} 06:30`;
    const plannedEndAt =
      (input.plannedEndAt || '').trim().slice(0, 32) || `${plannedDate} 10:30`;
    const equipmentName =
      (input.equipmentName || '').trim().slice(0, 120) || input.lineName.trim().slice(0, 80);
    const operators = Array.isArray(input.operators) && input.operators.length > 0
      ? input.operators.map((o) => String(o).trim().slice(0, 60)).filter(Boolean)
      : actor?.name
        ? [actor.name]
        : [];

    await db.transaction(async (tx) => {
      await tx.insert(batches).values({
        id: batchId,
        ownerId,
        batchNumber,
        lotNumber: '',
        formulaId: formula.id,
        formulaVersion: formula.version,
        sku: formula.sku,
        productName: formula.productName,
        packSize: formula.packSize,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef.trim().slice(0, 80),
        plannedQty,
        outputUnit: formula.outputUnit,
        plannedDate,
        lineName: input.lineName.trim().slice(0, 80),
        equipmentName,
        assignedTeam: input.assignedTeam.trim().slice(0, 80),
        shift,
        plannedStartAt,
        plannedEndAt,
        actualStartAt: '',
        actualEndAt: '',
        operators,
        status: 'Planned',
        availabilityChecked: false,
        shortageCount: 0,
        allocatedMaterials: [],
        issuedMaterials: [],
        processChecks: [],
        goodQty: 0,
        rejectedQty: 0,
        sampleQty: 0,
        reworkQty: 0,
        byProductQty: 0,
        wasteKg: 0,
        outputMassQty: 0,
        outputMassUnit: 'kg',
        lossReasonCodes: [],
        yieldPct: 0,
        variancePct: 0,
        materialCost: 0,
        laborCost: Number((formula.laborCostPerBatch * scaleFactor).toFixed(2)),
        overheadCost: Number((formula.overheadCostPerBatch * scaleFactor).toFixed(2)),
        unitCost: 0,
        qcStatus: 'Pending',
        qcNotes: '',
        qcInspector: '',
        retainedSampleQty: 0,
        retainedSampleCode: '',
        retainedSampleLocation: '',
        qcInProcessSummary: '',
        qcFinalResults: '',
        postedToInventory: false,
        finishedGoodId: '',
      });

      if (input.batchCheckSpecId) {
        const [sourceSpec] = await tx
          .select()
          .from(batchCheckSpecs)
          .where(
            and(
              eq(batchCheckSpecs.id, input.batchCheckSpecId),
              eq(batchCheckSpecs.ownerId, ownerId)
            )
          );
        if (sourceSpec) {
          await tx.insert(batchCheckSpecs).values({
            id: makeSafeId('bcs'),
            ownerId,
            batchId,
            batchNumber,
            productName: formula.productName,
            productCategory: sourceSpec.productCategory,
            phMin: sourceSpec.phMin,
            phMax: sourceSpec.phMax,
            awMin: sourceSpec.awMin,
            awMax: sourceSpec.awMax,
            brixMin: sourceSpec.brixMin,
            brixMax: sourceSpec.brixMax,
            additionalParams: sourceSpec.additionalParams || [],
            requirementNotes: sourceSpec.requirementNotes || '',
          });
        }
      }

      await writeAuditLog(tx, {
        ownerId,
        actor: actor || defaultActor(ownerId),
        action: 'CREATE_BATCH',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: null,
        newValue: {
          batchNumber,
          sku: formula.sku,
          productName: formula.productName,
          formulaVersion: formula.version,
          packSize: formula.packSize,
          sourceType: input.sourceType,
          sourceRef: input.sourceRef.trim().slice(0, 80),
          plannedQty,
          outputUnit: formula.outputUnit,
          plannedDate,
          lineName: input.lineName.trim().slice(0, 80),
          equipmentName,
          assignedTeam: input.assignedTeam.trim().slice(0, 80),
          shift,
          plannedStartAt,
          plannedEndAt,
          operators,
          status: 'Planned',
        },
        reason: `Job order planned (${input.sourceType})`,
      });
    });

    return batchId;
  } catch (error) {
    console.error('Failed to create job order:', error);
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    throw new Error('Unable to create production job order.', { cause: error });
  }
}

export async function updateBatchHeaderDb(
  ownerId: string,
  batchId: string,
  input: {
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
    plannedQty?: number;
    plannedDate?: string;
    sourceType?: BatchSourceType;
    sourceRef?: string;
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<ProductionBatch> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: input.authorizedOverride,
          overrideReason: input.overrideReason,
        }
      );

      const nextPlannedQty =
        input.plannedQty !== undefined && Number.isFinite(Number(input.plannedQty))
          ? Math.max(1, Number(input.plannedQty))
          : batch.plannedQty;

      const nextYieldPct =
        batch.goodQty > 0 && nextPlannedQty > 0
          ? Number(Math.min(200, (batch.goodQty / nextPlannedQty) * 100).toFixed(1))
          : batch.yieldPct;
      const nextVariancePct =
        batch.goodQty > 0 && nextPlannedQty > 0
          ? Number((((batch.goodQty - nextPlannedQty) / nextPlannedQty) * 100).toFixed(1))
          : batch.variancePct;

      const oldHeader: Record<string, unknown> = {
        lineName: batch.lineName,
        equipmentName: batch.equipmentName,
        assignedTeam: batch.assignedTeam,
        shift: batch.shift,
        plannedDate: batch.plannedDate,
        plannedQty: batch.plannedQty,
        sourceType: batch.sourceType,
        sourceRef: batch.sourceRef,
        plannedStartAt: batch.plannedStartAt,
        plannedEndAt: batch.plannedEndAt,
        actualStartAt: batch.actualStartAt,
        actualEndAt: batch.actualEndAt,
        operators: batch.operators,
        packSize: batch.packSize,
        yieldPct: batch.yieldPct,
        variancePct: batch.variancePct,
      };

      const nextHeader = {
        lineName:
          input.lineName !== undefined
            ? input.lineName.trim().slice(0, 80) || batch.lineName
            : batch.lineName,
        equipmentName:
          input.equipmentName !== undefined
            ? input.equipmentName.trim().slice(0, 120)
            : batch.equipmentName,
        assignedTeam:
          input.assignedTeam !== undefined
            ? input.assignedTeam.trim().slice(0, 80) || batch.assignedTeam
            : batch.assignedTeam,
        shift:
          input.shift !== undefined ? input.shift.trim().slice(0, 60) : batch.shift,
        plannedDate:
          input.plannedDate !== undefined
            ? input.plannedDate.trim().slice(0, 32) || batch.plannedDate
            : batch.plannedDate,
        plannedQty: nextPlannedQty,
        sourceType:
          input.sourceType !== undefined ? input.sourceType : (batch.sourceType as BatchSourceType),
        sourceRef:
          input.sourceRef !== undefined ? input.sourceRef.trim().slice(0, 80) : batch.sourceRef,
        plannedStartAt:
          input.plannedStartAt !== undefined
            ? input.plannedStartAt.trim().slice(0, 32)
            : batch.plannedStartAt,
        plannedEndAt:
          input.plannedEndAt !== undefined
            ? input.plannedEndAt.trim().slice(0, 32)
            : batch.plannedEndAt,
        actualStartAt:
          input.actualStartAt !== undefined
            ? input.actualStartAt.trim().slice(0, 32)
            : batch.actualStartAt,
        actualEndAt:
          input.actualEndAt !== undefined
            ? input.actualEndAt.trim().slice(0, 32)
            : batch.actualEndAt,
        operators:
          input.operators !== undefined
            ? Array.from(
                new Set(
                  input.operators.map((o) => String(o).trim().slice(0, 60)).filter(Boolean)
                )
              )
            : batch.operators,
        packSize:
          input.packSize !== undefined ? input.packSize.trim().slice(0, 60) : batch.packSize,
        yieldPct: nextYieldPct,
        variancePct: nextVariancePct,
      };

      const diff = computeFieldDiff(oldHeader, nextHeader);
      if (diff.changedKeys.length === 0) {
        return batch as unknown as ProductionBatch;
      }

      const [updated] = await tx
        .update(batches)
        .set({ ...nextHeader, updatedAt: new Date() })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)))
        .returning();

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'UPDATE_BATCH_HEADER',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: isClosedOverride
          ? overrideReason
          : `Edited EBR header (${diff.changedLabels.join(', ')})`,
      });

      return updated as unknown as ProductionBatch;
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update batch header:', error);
    throw new Error('Unable to update batch header.', { cause: error });
  }
}

export async function runAvailabilityCheckDb(
  ownerId: string,
  batchId: string,
  actor?: ActorContext
): Promise<number> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const [formula] = await tx
        .select()
        .from(formulas)
        .where(and(eq(formulas.id, batch.formulaId), eq(formulas.ownerId, ownerId)));
      if (!formula) throw new ValidationError('Formula not found.');

      const lots = await tx
        .select()
        .from(rawMaterials)
        .where(eq(rawMaterials.ownerId, ownerId));

      const lines = calculateBomAvailability(
        formula as unknown as FormulaBOM,
        batch.plannedQty,
        lots as unknown as RawMaterialLot[]
      );
      const shortageCount = lines.filter((l) => l.isShort).length;

      await tx
        .update(batches)
        .set({
          availabilityChecked: true,
          shortageCount,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const diff = computeFieldDiff(
        {
          availabilityChecked: batch.availabilityChecked,
          shortageCount: batch.shortageCount,
        },
        {
          availabilityChecked: true,
          shortageCount,
        }
      );

      if (diff.changedKeys.length > 0) {
        await writeAuditLog(tx, {
          ownerId,
          actor: effectiveActor,
          action: 'CHECK_AVAILABILITY',
          entityType: 'batch',
          entityId: batchId,
          batchId,
          oldValue: diff.oldValue,
          newValue: diff.newValue,
          reason:
            shortageCount === 0
              ? `BOM availability check passed (${lines.length} materials)`
              : `BOM availability check flagged ${shortageCount} shortage(s)`,
        });
      }

      return shortageCount;
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to check BOM availability:', error);
    throw new Error('Unable to run BOM availability check.', { cause: error });
  }
}

export async function releaseWorkOrderDb(
  ownerId: string,
  batchId: string,
  actor?: ActorContext
): Promise<string> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    assertActorPermission(effectiveActor, 'planReleaseJobOrders', 'release job orders to production');
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const existingBatches = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(eq(batches.ownerId, ownerId));

      const { lotNumber } = generateBatchAndLotNumbers(
        batch.sku,
        batch.lineName,
        existingBatches.length
      );
      const assignedLot = batch.lotNumber || lotNumber;

      await tx
        .update(batches)
        .set({
          status: 'Released',
          lotNumber: assignedLot,
          availabilityChecked: true,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const releaseDiff = computeFieldDiff(
        {
          status: batch.status,
          lotNumber: batch.lotNumber,
          availabilityChecked: batch.availabilityChecked,
        },
        {
          status: 'Released',
          lotNumber: assignedLot,
          availabilityChecked: true,
        }
      );

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'RELEASE_BATCH',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: releaseDiff.oldValue,
        newValue: releaseDiff.newValue,
        reason: 'Job order released to floor',
      });

      return assignedLot;
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to release job order:', error);
    throw new Error('Unable to release job order.', { cause: error });
  }
}

export async function allocateMaterialLotDb(
  ownerId: string,
  batchId: string,
  payload: {
    rawLotId: string;
    materialCode: string;
    allocatedQtyInBomUnit: number;
    bomUnit: UnitOfMeasure;
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: payload.authorizedOverride,
          overrideReason: payload.overrideReason,
        }
      );

      const [rawLot] = await tx
        .select()
        .from(rawMaterials)
        .where(and(eq(rawMaterials.id, payload.rawLotId), eq(rawMaterials.ownerId, ownerId)));
      if (!rawLot) throw new ValidationError('Raw material lot not found.');

      const rawAllocQty = Number(payload.allocatedQtyInBomUnit);
      const qtyInLotUnit = convertQuantity(
        Number.isFinite(rawAllocQty) ? Math.max(0, rawAllocQty) : 0,
        payload.bomUnit,
        rawLot.unit as UnitOfMeasure
      );
      if (!Number.isFinite(qtyInLotUnit) || qtyInLotUnit <= 0) {
        throw new ValidationError('Allocated quantity must be greater than zero.');
      }

      const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const newAlloc: AllocatedMaterialRecord = {
        materialCode: rawLot.materialCode,
        materialName: rawLot.materialName,
        lotId: rawLot.id,
        lotNumber: rawLot.lotNumber,
        allocatedQty: Number(payload.allocatedQtyInBomUnit),
        unit: payload.bomUnit,
        allocatedBy: effectiveActor.name,
        allocatedAt: nowIso,
      };

      const prevAllocated = batch.allocatedMaterials || [];
      const prevEntry = prevAllocated.find(
        (a) => a.materialCode === rawLot.materialCode && a.lotId === rawLot.id
      );
      const prevQtyInLotUnit = prevEntry
        ? convertQuantity(
            Math.max(0, Number(prevEntry.allocatedQty) || 0),
            prevEntry.unit as UnitOfMeasure,
            rawLot.unit as UnitOfMeasure
          )
        : 0;
      const prevPool = Number((rawLot.quantityAllocated || 0).toFixed(3));
      const nextPool = Number(
        Math.max(0, prevPool - prevQtyInLotUnit + qtyInLotUnit).toFixed(3)
      );

      const nextAllocated = [
        ...prevAllocated.filter(
          (a) => !(a.materialCode === rawLot.materialCode && a.lotId === rawLot.id)
        ),
        newAlloc,
      ].slice(0, 40);

      await tx
        .update(rawMaterials)
        .set({
          quantityAllocated: nextPool,
          updatedAt: new Date(),
        })
        .where(and(eq(rawMaterials.id, rawLot.id), eq(rawMaterials.ownerId, ownerId)));

      await tx
        .update(batches)
        .set({
          allocatedMaterials: nextAllocated,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      if (prevEntry) {
        const diff = computeFieldDiff(
          {
            materialCode: prevEntry.materialCode,
            lotNumber: prevEntry.lotNumber,
            allocatedQty: prevEntry.allocatedQty,
            unit: prevEntry.unit,
            allocatedBy: prevEntry.allocatedBy,
            allocatedAt: prevEntry.allocatedAt,
            lotPoolAllocated: prevPool,
          },
          {
            materialCode: newAlloc.materialCode,
            lotNumber: newAlloc.lotNumber,
            allocatedQty: newAlloc.allocatedQty,
            unit: newAlloc.unit,
            allocatedBy: newAlloc.allocatedBy,
            allocatedAt: newAlloc.allocatedAt,
            lotPoolAllocated: nextPool,
          }
        );
        if (diff.changedKeys.length > 0) {
          await writeAuditLog(tx, {
            ownerId,
            actor: effectiveActor,
            action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'UPDATE_MATERIAL_ALLOCATION',
            entityType: 'batch',
            entityId: batchId,
            batchId,
            oldValue: diff.oldValue,
            newValue: diff.newValue,
            reason: isClosedOverride
              ? overrideReason
              : `Updated allocation for ${rawLot.materialCode} (${rawLot.lotNumber}): ${diff.changedLabels.join(', ')}`,
          });
        }
      } else {
        await writeAuditLog(tx, {
          ownerId,
          actor: effectiveActor,
          action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'ALLOCATE_MATERIAL',
          entityType: 'batch',
          entityId: batchId,
          batchId,
          oldValue: { allocatedQty: 0, lotPoolAllocated: prevPool },
          newValue: {
            materialCode: newAlloc.materialCode,
            materialName: newAlloc.materialName,
            lotNumber: newAlloc.lotNumber,
            allocatedQty: newAlloc.allocatedQty,
            unit: newAlloc.unit,
            allocatedBy: newAlloc.allocatedBy,
            allocatedAt: newAlloc.allocatedAt,
            lotPoolAllocated: nextPool,
          },
          reason: isClosedOverride
            ? overrideReason
            : `Allocated ${payload.allocatedQtyInBomUnit} ${payload.bomUnit} from lot ${rawLot.lotNumber}`,
        });
      }
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to allocate raw material lot:', error);
    throw new Error('Unable to allocate raw material lot.', { cause: error });
  }
}

export async function issueMaterialLotDb(
  ownerId: string,
  batchId: string,
  payload: {
    rawLotId: string;
    actualQtyInBomUnit: number;
    requiredQtyInBomUnit: number;
    bomUnit: UnitOfMeasure;
    tolerancePct: number;
    operatorName: string;
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId, payload.operatorName || 'Operator');
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: payload.authorizedOverride,
          overrideReason: payload.overrideReason,
        }
      );

      const [rawLot] = await tx
        .select()
        .from(rawMaterials)
        .where(and(eq(rawMaterials.id, payload.rawLotId), eq(rawMaterials.ownerId, ownerId)));
      if (!rawLot) throw new ValidationError('Raw material lot not found.');

      const rawActualQty = Number(payload.actualQtyInBomUnit);
      const deductQtyInLotUnit = convertQuantity(
        Number.isFinite(rawActualQty) ? Math.max(0, rawActualQty) : 0,
        payload.bomUnit,
        rawLot.unit as UnitOfMeasure
      );
      if (!Number.isFinite(deductQtyInLotUnit) || deductQtyInLotUnit <= 0) {
        throw new ValidationError('Issued quantity must be greater than zero.');
      }
      const nextAvailable = Number(
        Math.max(0, rawLot.quantityAvailable - deductQtyInLotUnit).toFixed(3)
      );
      const nextAllocatedPool = Number(
        Math.max(0, (rawLot.quantityAllocated || 0) - deductQtyInLotUnit).toFixed(3)
      );
      const nextLotStatus = deriveRawLotStatus(
        nextAvailable,
        rawLot.reorderLevel,
        rawLot.expiryDate
      );

      const variancePct =
        payload.requiredQtyInBomUnit > 0
          ? Number(
              (
                ((payload.actualQtyInBomUnit - payload.requiredQtyInBomUnit) /
                  payload.requiredQtyInBomUnit) *
                100
              ).toFixed(2)
            )
          : 0;
      const withinTolerance = Math.abs(variancePct) <= payload.tolerancePct;
      const cost = Number((deductQtyInLotUnit * rawLot.unitCost).toFixed(2));
      const nowStamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const actorDisplayName = (payload.operatorName || effectiveActor.name).slice(0, 60);

      const newRecord: IssuedMaterialRecord = {
        materialCode: rawLot.materialCode,
        materialName: rawLot.materialName,
        lotId: rawLot.id,
        lotNumber: rawLot.lotNumber,
        requiredQty: payload.requiredQtyInBomUnit,
        actualQty: payload.actualQtyInBomUnit,
        unit: payload.bomUnit,
        variancePct,
        withinTolerance,
        cost,
        operator: actorDisplayName,
        issuedAt: nowStamp,
      };

      const nextIssued = [...(batch.issuedMaterials || []), newRecord].slice(0, 40);
      const existingAlloc = batch.allocatedMaterials || [];
      const hasAllocForLot = existingAlloc.some(
        (a) => a.materialCode === rawLot.materialCode && a.lotId === rawLot.id
      );
      const nextAllocated: AllocatedMaterialRecord[] = hasAllocForLot
        ? existingAlloc
        : [
            ...existingAlloc,
            {
              materialCode: rawLot.materialCode,
              materialName: rawLot.materialName,
              lotId: rawLot.id,
              lotNumber: rawLot.lotNumber,
              allocatedQty: payload.requiredQtyInBomUnit,
              unit: payload.bomUnit,
              allocatedBy: actorDisplayName,
              allocatedAt: nowStamp,
            },
          ].slice(0, 40);

      const nextMaterialCost = Number(
        nextIssued.reduce((sum, item) => sum + item.cost, 0).toFixed(2)
      );
      const totalCost = nextMaterialCost + batch.laborCost + batch.overheadCost;
      const denominator = batch.goodQty > 0 ? batch.goodQty : batch.plannedQty;
      const nextUnitCost = denominator > 0 ? Number((totalCost / denominator).toFixed(2)) : 0;

      const nextOperators = Array.from(
        new Set([...(batch.operators || []), actorDisplayName].filter(Boolean))
      );
      const nextStatus = batch.status === 'Released' ? 'In Progress' : batch.status;
      const nextActualStartAt = batch.actualStartAt || nowStamp;

      await tx
        .update(rawMaterials)
        .set({
          quantityAvailable: nextAvailable,
          quantityAllocated: nextAllocatedPool,
          status: nextLotStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(rawMaterials.id, rawLot.id), eq(rawMaterials.ownerId, ownerId)));

      await tx
        .update(batches)
        .set({
          allocatedMaterials: nextAllocated,
          issuedMaterials: nextIssued,
          materialCost: nextMaterialCost,
          unitCost: nextUnitCost,
          actualStartAt: nextActualStartAt,
          operators: nextOperators,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const diff = computeFieldDiff(
        {
          materialCode: rawLot.materialCode,
          lotNumber: null,
          actualQty: 0,
          cost: 0,
          materialCost: batch.materialCost,
          unitCost: batch.unitCost,
          actualStartAt: batch.actualStartAt,
          operators: batch.operators,
          status: batch.status,
        },
        {
          materialCode: newRecord.materialCode,
          materialName: newRecord.materialName,
          lotNumber: newRecord.lotNumber,
          requiredQty: newRecord.requiredQty,
          actualQty: newRecord.actualQty,
          unit: newRecord.unit,
          variancePct: newRecord.variancePct,
          withinTolerance: newRecord.withinTolerance,
          cost: newRecord.cost,
          operator: newRecord.operator,
          issuedAt: newRecord.issuedAt,
          materialCost: nextMaterialCost,
          unitCost: nextUnitCost,
          actualStartAt: nextActualStartAt,
          operators: nextOperators,
          status: nextStatus,
        }
      );

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'ISSUE_MATERIAL',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: isClosedOverride
          ? overrideReason
          : `Issued ${payload.actualQtyInBomUnit} ${payload.bomUnit} from lot ${rawLot.lotNumber} (${rawLot.materialCode})`,
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to issue raw material lot:', error);
    throw new Error('Unable to issue raw material lot to batch.', { cause: error });
  }
}

export async function updateIssuedMaterialLotDb(
  ownerId: string,
  batchId: string,
  materialCode: string,
  payload: {
    rawLotId: string;
    actualQtyInBomUnit: number;
    requiredQtyInBomUnit: number;
    bomUnit: UnitOfMeasure;
    tolerancePct: number;
    operatorName: string;
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId, payload.operatorName || 'Operator');
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: payload.authorizedOverride,
          overrideReason: payload.overrideReason,
        }
      );

      const issuedList = [...(batch.issuedMaterials || [])];
      const targetIdx = issuedList.findIndex((m) => m.materialCode === materialCode);
      if (targetIdx === -1) {
        throw new ValidationError(`Issued material record for ${materialCode} not found.`);
      }
      const prevRecord = issuedList[targetIdx];

      const rawActualQty = Number(payload.actualQtyInBomUnit);
      if (!Number.isFinite(rawActualQty) || rawActualQty <= 0) {
        throw new ValidationError('Issued quantity must be greater than zero.');
      }

      // Restore previous stock deduction on old lot
      const [prevRawLot] = await tx
        .select()
        .from(rawMaterials)
        .where(and(eq(rawMaterials.id, prevRecord.lotId), eq(rawMaterials.ownerId, ownerId)));

      if (prevRawLot) {
        const prevDeductInLotUnit = convertQuantity(
          Math.max(0, Number(prevRecord.actualQty) || 0),
          prevRecord.unit as UnitOfMeasure,
          prevRawLot.unit as UnitOfMeasure
        );
        const restoredAvail = Number((prevRawLot.quantityAvailable + prevDeductInLotUnit).toFixed(3));
        await tx
          .update(rawMaterials)
          .set({
            quantityAvailable: restoredAvail,
            status: deriveRawLotStatus(restoredAvail, prevRawLot.reorderLevel, prevRawLot.expiryDate),
            updatedAt: new Date(),
          })
          .where(and(eq(rawMaterials.id, prevRawLot.id), eq(rawMaterials.ownerId, ownerId)));
      }

      // Fetch target lot AFTER restoration (handles same-lot & cross-lot edits cleanly)
      const [nextRawLot] = await tx
        .select()
        .from(rawMaterials)
        .where(and(eq(rawMaterials.id, payload.rawLotId), eq(rawMaterials.ownerId, ownerId)));
      if (!nextRawLot) throw new ValidationError('Target raw material lot not found.');

      const nextDeductInLotUnit = convertQuantity(
        rawActualQty,
        payload.bomUnit,
        nextRawLot.unit as UnitOfMeasure
      );
      if (!Number.isFinite(nextDeductInLotUnit) || nextDeductInLotUnit <= 0) {
        throw new ValidationError('Issued quantity must be greater than zero.');
      }
      const nextAvailable = Number(
        Math.max(0, nextRawLot.quantityAvailable - nextDeductInLotUnit).toFixed(3)
      );
      const nextLotStatus = deriveRawLotStatus(
        nextAvailable,
        nextRawLot.reorderLevel,
        nextRawLot.expiryDate
      );

      await tx
        .update(rawMaterials)
        .set({
          quantityAvailable: nextAvailable,
          status: nextLotStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(rawMaterials.id, nextRawLot.id), eq(rawMaterials.ownerId, ownerId)));

      const variancePct =
        payload.requiredQtyInBomUnit > 0
          ? Number(
              (
                ((rawActualQty - payload.requiredQtyInBomUnit) / payload.requiredQtyInBomUnit) *
                100
              ).toFixed(2)
            )
          : 0;
      const withinTolerance = Math.abs(variancePct) <= payload.tolerancePct;
      const cost = Number((nextDeductInLotUnit * nextRawLot.unitCost).toFixed(2));
      const nowStamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const actorDisplayName = (payload.operatorName || effectiveActor.name).slice(0, 60);

      const updatedRecord: IssuedMaterialRecord = {
        materialCode: nextRawLot.materialCode,
        materialName: nextRawLot.materialName,
        lotId: nextRawLot.id,
        lotNumber: nextRawLot.lotNumber,
        requiredQty: payload.requiredQtyInBomUnit,
        actualQty: rawActualQty,
        unit: payload.bomUnit,
        variancePct,
        withinTolerance,
        cost,
        operator: actorDisplayName,
        issuedAt: nowStamp,
      };
      issuedList[targetIdx] = updatedRecord;

      const nextMaterialCost = Number(
        issuedList.reduce((sum, item) => sum + item.cost, 0).toFixed(2)
      );
      const totalCost = nextMaterialCost + batch.laborCost + batch.overheadCost;
      const denominator = batch.goodQty > 0 ? batch.goodQty : batch.plannedQty;
      const nextUnitCost = denominator > 0 ? Number((totalCost / denominator).toFixed(2)) : 0;

      const diff = computeFieldDiff(
        {
          lotId: prevRecord.lotId,
          lotNumber: prevRecord.lotNumber,
          actualQty: prevRecord.actualQty,
          unit: prevRecord.unit,
          variancePct: prevRecord.variancePct,
          withinTolerance: prevRecord.withinTolerance,
          cost: prevRecord.cost,
          operator: prevRecord.operator,
          issuedAt: prevRecord.issuedAt,
          materialCost: batch.materialCost,
          unitCost: batch.unitCost,
        },
        {
          lotId: updatedRecord.lotId,
          lotNumber: updatedRecord.lotNumber,
          actualQty: updatedRecord.actualQty,
          unit: updatedRecord.unit,
          variancePct: updatedRecord.variancePct,
          withinTolerance: updatedRecord.withinTolerance,
          cost: updatedRecord.cost,
          operator: updatedRecord.operator,
          issuedAt: updatedRecord.issuedAt,
          materialCost: nextMaterialCost,
          unitCost: nextUnitCost,
        }
      );

      if (diff.changedKeys.length === 0) return;

      await tx
        .update(batches)
        .set({
          issuedMaterials: issuedList,
          materialCost: nextMaterialCost,
          unitCost: nextUnitCost,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'UPDATE_ISSUED_MATERIAL',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: isClosedOverride
          ? overrideReason
          : `Edited issued material ${materialCode} (${diff.changedLabels.join(', ')})`,
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update issued material lot:', error);
    throw new Error('Unable to update issued material lot.', { cause: error });
  }
}

function evaluateRecipeAndSpecReading(params: {
  raw: ProcessCheckRecord;
  formulaParams: RecipeProcessParameter[];
  linkedSpec: typeof batchCheckSpecs.$inferSelect | null;
  actorName: string;
  recordedAt: string;
  readingTime: string;
  slotNumber: number;
  existingId?: string;
}): ProcessCheckRecord & { id: string } {
  const {
    raw,
    formulaParams,
    linkedSpec,
    actorName,
    recordedAt,
    readingTime,
    slotNumber,
    existingId,
  } = params;

  const recordedTempC = toNullableNum(raw.recordedTempC);
  const recordedBrix = toNullableNum(raw.recordedBrix);
  const recordedPh = toNullableNum(raw.recordedPh);
  const recordedAw = toNullableNum(raw.recordedAw);
  const recordedWeightKg = toNullableNum(raw.recordedWeightKg);
  const recordedWeightG =
    toNullableNum(raw.recordedWeightG) ??
    (recordedWeightKg !== null ? Number((recordedWeightKg * 1000).toFixed(1)) : null);
  const recordedViscosityCp = toNullableNum(raw.recordedViscosityCp);
  const recordedSpeedRpm = toNullableNum(raw.recordedSpeedRpm);
  const recordedPressureBar = toNullableNum(raw.recordedPressureBar);
  const durationMin = Math.max(0, Number(raw.durationMin) || 0);

  const source: ReadingSource = raw.source === 'Sensor' ? 'Sensor' : 'Manual';
  const rawAdditional = Array.isArray(raw.batchCheckReadings)
    ? raw.batchCheckReadings
    : [];

  const hasAnyValue =
    recordedTempC !== null ||
    recordedBrix !== null ||
    recordedPh !== null ||
    recordedAw !== null ||
    recordedWeightKg !== null ||
    recordedWeightG !== null ||
    recordedViscosityCp !== null ||
    recordedSpeedRpm !== null ||
    recordedPressureBar !== null ||
    rawAdditional.some((r) => String(r.value ?? '').trim().length > 0);

  if (!readingTime) {
    throw new ValidationError(`Reading #${slotNumber} requires a recorded time.`);
  }
  if (!hasAnyValue) {
    throw new ValidationError(
      `Reading #${slotNumber} (${readingTime}) requires at least one measurement.`
    );
  }

  let evaluatedWithinSpec = true;
  const outOfSpecParams: string[] = [];

  // Evaluate against formula recipe process parameters (target/min/max)
  const keyValues: Record<string, number | null> = {
    temperature: recordedTempC,
    ph: recordedPh,
    brix: recordedBrix,
    aw: recordedAw,
    viscosity: recordedViscosityCp,
    weight: recordedWeightKg,
    time: durationMin > 0 ? durationMin : null,
    speed: recordedSpeedRpm,
    pressure: recordedPressureBar,
  };

  const parameterReadings: EbrParameterReading[] = [];
  for (const fp of formulaParams) {
    const val = keyValues[fp.key] ?? null;
    if (val === null) continue;
    const ok = isWithinBounds(val, fp.min, fp.max);
    if (!ok) {
      evaluatedWithinSpec = false;
      outOfSpecParams.push(
        `${fp.name} (${val} ${fp.unit}; spec ${fp.min ?? '—'}–${fp.max ?? '—'})`
      );
    }
    parameterReadings.push({
      paramId: fp.id,
      key: fp.key,
      name: fp.name,
      value: val,
      unit: fp.unit,
      target: fp.target,
      min: fp.min,
      max: fp.max,
      withinSpec: ok,
      timestamp: recordedAt,
      user: actorName,
      source,
    });
  }

  let sanitizedReadings: BatchCheckAdditionalReading[] = rawAdditional
    .filter((r) => String(r.value ?? '').trim().length > 0)
    .map((r) => ({
      paramId: (r.paramId || '').trim().slice(0, 48),
      name: (r.name || '').trim().slice(0, 80),
      unit: (r.unit || '').trim().slice(0, 24),
      value: String(r.value ?? '').trim().slice(0, 64),
      numericValue: toNullableNum(r.numericValue ?? r.value),
      withinSpec: r.withinSpec !== false,
    }));

  if (linkedSpec) {
    if ((linkedSpec.phMin !== null || linkedSpec.phMax !== null) && recordedPh === null) {
      throw new ValidationError(
        `Linked Batch Check spec (${linkedSpec.productCategory}) requires pH to be read in Step 5.`
      );
    }
    if ((linkedSpec.awMin !== null || linkedSpec.awMax !== null) && recordedAw === null) {
      throw new ValidationError(
        `Linked Batch Check spec (${linkedSpec.productCategory}) requires Water Activity (Aw) to be read in Step 5.`
      );
    }
    if (
      (linkedSpec.brixMin !== null || linkedSpec.brixMax !== null) &&
      recordedBrix === null
    ) {
      throw new ValidationError(
        `Linked Batch Check spec (${linkedSpec.productCategory}) requires Brix (%) to be read in Step 5.`
      );
    }

    const specParams = linkedSpec.additionalParams || [];
    const byId = new Map<string, BatchCheckAdditionalReading>(
      sanitizedReadings.map((r) => [r.paramId, r])
    );
    const validatedSpecReadings: BatchCheckAdditionalReading[] = [];
    for (const param of specParams) {
      const match = byId.get(param.id);
      if (!match || !match.value.trim()) {
        throw new ValidationError(
          `Linked Batch Check parameter "${param.name}" must be read in Step 5.`
        );
      }
      const num = toNullableNum(match.numericValue ?? match.value);
      let paramOk = true;
      if (param.minTarget !== null || param.maxTarget !== null) {
        if (num === null) {
          paramOk = false;
        } else {
          if (param.minTarget !== null && num < param.minTarget) paramOk = false;
          if (param.maxTarget !== null && num > param.maxTarget) paramOk = false;
        }
      }
      if (!paramOk) {
        evaluatedWithinSpec = false;
        outOfSpecParams.push(`${param.name} (${match.value})`);
      }
      validatedSpecReadings.push({
        paramId: param.id,
        name: param.name,
        unit: param.unit,
        value: match.value,
        numericValue: num,
        withinSpec: paramOk,
      });
    }
    if (validatedSpecReadings.length > 0) {
      sanitizedReadings = validatedSpecReadings;
    }

    if (recordedPh !== null && !isWithinBounds(recordedPh, linkedSpec.phMin, linkedSpec.phMax)) {
      evaluatedWithinSpec = false;
      if (!outOfSpecParams.some((s) => s.startsWith('pH'))) {
        outOfSpecParams.push(`pH (${recordedPh})`);
      }
    }
    if (recordedAw !== null && !isWithinBounds(recordedAw, linkedSpec.awMin, linkedSpec.awMax)) {
      evaluatedWithinSpec = false;
      outOfSpecParams.push(`Aw (${recordedAw})`);
    }
    if (
      recordedBrix !== null &&
      !isWithinBounds(recordedBrix, linkedSpec.brixMin, linkedSpec.brixMax)
    ) {
      evaluatedWithinSpec = false;
      if (!outOfSpecParams.some((s) => s.startsWith('Brix'))) {
        outOfSpecParams.push(`Brix (${recordedBrix}%)`);
      }
    }
  }

  const notes = (raw.notes || '').trim().slice(0, 400);
  const deviationRecord = (raw.deviationRecord || '').trim().slice(0, 400);

  // Enforce Phase 2 requirement: Out-of-spec readings cannot be saved without a note or deviation record
  if (!evaluatedWithinSpec) {
    const isGenericNote =
      !notes || notes.toLowerCase() === 'within target spec' || notes.toLowerCase() === 'out of target spec';
    if (isGenericNote && !deviationRecord) {
      throw new ValidationError(
        `Out-of-spec reading (${outOfSpecParams.join(', ') || 'spec limit exceeded'}) requires an operator note or deviation record before saving.`
      );
    }
  }

  return {
    id: existingId || (raw.id || '').trim() || makeSafeId('chk'),
    readingTime,
    readingSlot: typeof raw.readingSlot === 'number' ? raw.readingSlot : slotNumber,
    stepNumber: Number(raw.stepNumber) || slotNumber,
    stepName: (raw.stepName || `Time Reading #${slotNumber}`).trim().slice(0, 120),
    recordedTempC,
    recordedBrix,
    recordedPh,
    recordedAw,
    recordedWeightG,
    recordedWeightKg,
    recordedViscosityCp,
    recordedSpeedRpm,
    recordedPressureBar,
    source,
    parameterReadings,
    outOfSpecParams,
    deviationRecord,
    batchCheckSpecId: linkedSpec?.id || raw.batchCheckSpecId,
    batchCheckReadings: sanitizedReadings,
    durationMin,
    sensorCode:
      source === 'Sensor'
        ? (raw.sensorCode || 'SENSOR').trim().slice(0, 48)
        : (raw.sensorCode || 'MANUAL').trim().slice(0, 48),
    withinSpec: evaluatedWithinSpec,
    operator: (raw.operator || actorName).trim().slice(0, 100),
    notes,
    recordedAt,
  };
}

export async function recordProcessCheckDb(
  ownerId: string,
  batchId: string,
  payload:
    | (ProcessCheckRecord & ClosedOverrideOptions)
    | ({ checks: ProcessCheckRecord[] } & ClosedOverrideOptions),
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const overrideOpts: ClosedOverrideOptions = {
        authorizedOverride: (payload as ClosedOverrideOptions).authorizedOverride,
        overrideReason: (payload as ClosedOverrideOptions).overrideReason,
      };
      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        overrideOpts
      );

      const rawList =
        payload && typeof payload === 'object' && 'checks' in payload && Array.isArray(payload.checks)
          ? payload.checks
          : [payload as ProcessCheckRecord];

      if (rawList.length === 0) {
        throw new ValidationError('At least one time reading record is required.');
      }

      const [formula] = await tx
        .select()
        .from(formulas)
        .where(and(eq(formulas.id, batch.formulaId), eq(formulas.ownerId, ownerId)));
      const formulaParams =
        formula?.processParameters && formula.processParameters.length > 0
          ? formula.processParameters
          : buildDefaultRecipeProcessParameters(`${batch.sku} ${batch.productName}`);

      const existing = (batch.processChecks || []).map((c, idx) => ({
        ...c,
        id: c.id || `chk-legacy-${c.stepNumber}-${idx}`,
      }));

      const ownerSpecs = await tx
        .select()
        .from(batchCheckSpecs)
        .where(eq(batchCheckSpecs.ownerId, ownerId));
      const linkedSpec =
        ownerSpecs.find((s) => s.batchId === batchId) ||
        ownerSpecs.find((s) => s.batchNumber === batch.batchNumber) ||
        null;

      const today = new Date().toISOString().slice(0, 10);
      const sanitizedIncoming: ProcessCheckRecord[] = rawList.map((raw, idx) => {
        const readingTime = (raw.readingTime || '').trim().slice(0, 16);
        const recordedAt =
          (raw.recordedAt || '').trim().slice(0, 32) || `${today} ${readingTime}`;
        return evaluateRecipeAndSpecReading({
          raw,
          formulaParams,
          linkedSpec,
          actorName: (raw.operator || effectiveActor.name).trim().slice(0, 100),
          recordedAt,
          readingTime,
          slotNumber:
            typeof raw.readingSlot === 'number'
              ? raw.readingSlot
              : existing.length + idx + 1,
        });
      });

      const existingManualKeys = new Set(
        existing
          .filter((c) => (c.source || 'Manual') === 'Manual' && Boolean(c.id))
          .map((c) => c.id as string)
      );
      for (const inc of sanitizedIncoming) {
        if (inc.id && existingManualKeys.has(inc.id) && inc.source === 'Sensor') {
          throw new ValidationError(
            'Manual reading records cannot be overwritten by sensor data.'
          );
        }
      }

      const incomingIds = new Set(sanitizedIncoming.map((c) => c.id));
      const merged = [
        ...existing.filter((c) => !incomingIds.has(c.id)),
        ...sanitizedIncoming,
      ];

      const nextChecks = merged
        .sort((a, b) => {
          const slotA = a.readingSlot ?? Number.MAX_SAFE_INTEGER;
          const slotB = b.readingSlot ?? Number.MAX_SAFE_INTEGER;
          if (slotA !== slotB) return slotA - slotB;
          return (a.recordedAt || '').localeCompare(b.recordedAt || '');
        })
        .slice(0, 60)
        .map((c, idx) => ({
          ...c,
          readingSlot: idx + 1,
        }));

      const nowStamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const nextOperators = Array.from(
        new Set(
          [
            ...(batch.operators || []),
            ...sanitizedIncoming.map((c) => c.operator),
          ].filter(Boolean)
        )
      );

      const nextStatus = batch.status === 'Released' ? 'In Progress' : batch.status;
      const nextActualStartAt = batch.actualStartAt || nowStamp;

      await tx
        .update(batches)
        .set({
          processChecks: nextChecks,
          actualStartAt: nextActualStartAt,
          operators: nextOperators,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const firstNew = sanitizedIncoming[0];
      const beforeRecordState: Record<string, unknown> = {
        processChecksCount: existing.length,
        status: batch.status,
        actualStartAt: batch.actualStartAt,
        operators: batch.operators,
      };
      const afterRecordState: Record<string, unknown> = {
        processChecksCount: nextChecks.length,
        status: nextStatus,
        actualStartAt: nextActualStartAt,
        operators: nextOperators,
      };
      if (firstNew) {
        const initialFields: Record<string, unknown> = {
          readingSlot: firstNew.readingSlot,
          readingTime: firstNew.readingTime,
          recordedTempC: firstNew.recordedTempC,
          recordedBrix: firstNew.recordedBrix,
          recordedPh: firstNew.recordedPh,
          recordedAw: firstNew.recordedAw,
          recordedWeightKg: firstNew.recordedWeightKg,
          recordedViscosityCp: firstNew.recordedViscosityCp,
          recordedSpeedRpm: firstNew.recordedSpeedRpm,
          recordedPressureBar: firstNew.recordedPressureBar,
          durationMin: firstNew.durationMin,
          source: firstNew.source,
          withinSpec: firstNew.withinSpec,
          deviationRecord: firstNew.deviationRecord,
          notes: firstNew.notes,
        };
        for (const [k, v] of Object.entries(initialFields)) {
          if (v !== null && v !== undefined && v !== '') {
            afterRecordState[k] = v;
          }
        }
        if ((firstNew.batchCheckReadings || []).length > 0) {
          afterRecordState.batchCheckReadings = firstNew.batchCheckReadings;
        }
      }

      const diff = computeFieldDiff(beforeRecordState, afterRecordState);

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'RECORD_PROCESS_READING',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: isClosedOverride
          ? overrideReason
          : sanitizedIncoming.some((c) => !c.withinSpec)
            ? `Out-of-spec reading logged (#${firstNew?.readingSlot ?? 1} · ${firstNew?.readingTime}) with deviation/note`
            : `Recorded process reading (#${firstNew?.readingSlot ?? 1} · ${firstNew?.readingTime})`,
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to record process check:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('requires') ||
        error.message.includes('must be read') ||
        error.message.includes('not found') ||
        error.message.includes('Closed'))
        ? error.message
        : 'Unable to record in-process quality check.';
    throw new Error(msg, { cause: error });
  }
}

export async function updateProcessCheckDb(
  ownerId: string,
  batchId: string,
  checkId: string,
  raw: ProcessCheckRecord & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: raw.authorizedOverride,
          overrideReason: raw.overrideReason,
        }
      );

      const existing = (batch.processChecks || []).map((c, idx) => ({
        ...c,
        id: c.id || `chk-legacy-${c.stepNumber}-${idx}`,
      }));

      const targetIndex = existing.findIndex((c) => c.id === checkId);
      if (targetIndex === -1) {
        throw new ValidationError('Process reading record not found.');
      }

      const [formula] = await tx
        .select()
        .from(formulas)
        .where(and(eq(formulas.id, batch.formulaId), eq(formulas.ownerId, ownerId)));
      const formulaParams =
        formula?.processParameters && formula.processParameters.length > 0
          ? formula.processParameters
          : buildDefaultRecipeProcessParameters(`${batch.sku} ${batch.productName}`);

      const ownerSpecs = await tx
        .select()
        .from(batchCheckSpecs)
        .where(eq(batchCheckSpecs.ownerId, ownerId));
      const linkedSpec =
        ownerSpecs.find((s) => s.batchId === batchId) ||
        ownerSpecs.find((s) => s.batchNumber === batch.batchNumber) ||
        null;

      const current = existing[targetIndex];
      if ((current.source || 'Manual') === 'Manual' && raw.source === 'Sensor') {
        throw new ValidationError(
          'Manual reading records cannot be overwritten by sensor data.'
        );
      }
      const readingTime = (raw.readingTime || '').trim().slice(0, 16);
      const today = new Date().toISOString().slice(0, 10);
      const recordedAt =
        (raw.recordedAt || '').trim().slice(0, 32) ||
        `${(current.recordedAt || today).slice(0, 10)} ${readingTime}`;

      const updatedRecord = evaluateRecipeAndSpecReading({
        raw,
        formulaParams,
        linkedSpec,
        actorName: (raw.operator || current.operator || effectiveActor.name).trim().slice(0, 100),
        recordedAt,
        readingTime,
        slotNumber: current.readingSlot ?? targetIndex + 1,
        existingId: current.id,
      });

      const oldRecord = current;

      const buildComparableCheckFields = (rec: ProcessCheckRecord): Record<string, unknown> => {
        const obj: Record<string, unknown> = {
          readingTime: rec.readingTime ?? '',
          stepName: rec.stepName ?? '',
          recordedTempC: rec.recordedTempC ?? null,
          recordedBrix: rec.recordedBrix ?? null,
          recordedPh: rec.recordedPh ?? null,
          recordedAw: rec.recordedAw ?? null,
          recordedWeightKg: rec.recordedWeightKg ?? null,
          recordedWeightG: rec.recordedWeightG ?? null,
          recordedViscosityCp: rec.recordedViscosityCp ?? null,
          recordedSpeedRpm: rec.recordedSpeedRpm ?? null,
          recordedPressureBar: rec.recordedPressureBar ?? null,
          durationMin: rec.durationMin ?? 0,
          source: rec.source ?? 'Manual',
          sensorCode: rec.sensorCode ?? '',
          withinSpec: rec.withinSpec,
          outOfSpecParams: rec.outOfSpecParams ?? [],
          deviationRecord: rec.deviationRecord ?? '',
          notes: rec.notes ?? '',
          operator: rec.operator ?? '',
          recordedAt: rec.recordedAt ?? '',
        };
        for (const r of rec.batchCheckReadings || []) {
          obj[`param:${r.name}`] = `${r.value}${r.unit ? ` ${r.unit}` : ''}`;
        }
        return obj;
      };

      const diff = computeFieldDiff(
        buildComparableCheckFields(oldRecord),
        buildComparableCheckFields(updatedRecord)
      );
      if (diff.changedKeys.length === 0) {
        return;
      }

      existing[targetIndex] = updatedRecord;

      await tx
        .update(batches)
        .set({
          processChecks: existing,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'UPDATE_PROCESS_READING',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: isClosedOverride
          ? overrideReason
          : `Edited Time Reading #${targetIndex + 1} (${updatedRecord.readingTime || readingTime}): ${diff.changedLabels.join(', ')}`,
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to update process check:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') ||
        error.message.includes('requires') ||
        error.message.includes('must be read') ||
        error.message.includes('not found') ||
        error.message.includes('Closed'))
        ? error.message
        : 'Unable to update process reading record.';
    throw new Error(msg, { cause: error });
  }
}

export async function deleteProcessCheckDb(
  ownerId: string,
  batchId: string,
  checkId: string,
  override?: ClosedOverrideOptions,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        override
      );

      const existing = (batch.processChecks || []).map((c, idx) => ({
        ...c,
        id: c.id || `chk-legacy-${c.stepNumber}-${idx}`,
      }));

      const removed = existing.find((c) => c.id === checkId);
      const remaining = existing
        .filter((c) => c.id !== checkId)
        .map((c, idx) => ({ ...c, readingSlot: idx + 1 }));

      await tx
        .update(batches)
        .set({
          processChecks: remaining,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const removedFields: Record<string, unknown> = removed
        ? {
            processChecksCount: existing.length,
            readingSlot: removed.readingSlot ?? null,
            readingTime: removed.readingTime ?? '',
            recordedTempC: removed.recordedTempC ?? null,
            recordedBrix: removed.recordedBrix ?? null,
            recordedPh: removed.recordedPh ?? null,
            recordedAw: removed.recordedAw ?? null,
            recordedWeightKg: removed.recordedWeightKg ?? null,
            recordedViscosityCp: removed.recordedViscosityCp ?? null,
            recordedSpeedRpm: removed.recordedSpeedRpm ?? null,
            recordedPressureBar: removed.recordedPressureBar ?? null,
            source: removed.source ?? 'Manual',
            withinSpec: removed.withinSpec,
            deviationRecord: removed.deviationRecord ?? '',
            notes: removed.notes ?? '',
            operator: removed.operator ?? '',
          }
        : { processChecksCount: existing.length, readingSlot: checkId };

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride ? 'CLOSED_BATCH_OVERRIDE' : 'DELETE_PROCESS_READING',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: removedFields,
        newValue: { processChecksCount: remaining.length },
        reason: isClosedOverride
          ? overrideReason
          : `Deleted Time Reading #${removed?.readingSlot ?? '?'} (${removed?.readingTime || checkId})`,
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to delete process check:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('not found') || error.message.includes('Closed'))
        ? error.message
        : 'Unable to delete process reading record.';
    throw new Error(msg, { cause: error });
  }
}

export async function reportBatchOutputDb(
  ownerId: string,
  batchId: string,
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
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: output.authorizedOverride,
          overrideReason: output.overrideReason,
        }
      );

      if ((batch.processChecks || []).length < 3) {
        throw new ValidationError(
          `Complete at least 3 time reading records in Step 5 before reporting batch output (currently ${(batch.processChecks || []).length}/3).`
        );
      }

      const goodQty = Math.max(0, Number(output.goodQty));
      const rejectedQty = Math.max(0, Number(output.rejectedQty) || 0);
      const sampleQty = Math.max(0, Number(output.sampleQty) || 0);
      const reworkQty = Math.max(0, Number(output.reworkQty) || 0);
      const byProductQty = Math.max(0, Number(output.byProductQty) || 0);
      const wasteKg = Math.max(0, Number(output.wasteKg) || 0);
      const outputMassQty = Math.max(
        0,
        Number(output.outputMassQty ?? goodQty * 0.5) || 0
      );
      const outputMassUnit =
        output.outputMassUnit === 'L' ? 'L' : 'kg';
      const packSize =
        (output.packSize || batch.packSize || '').trim().slice(0, 60);

      const incomingLosses: BatchLossRecord[] = Array.isArray(output.lossReasonCodes)
        ? output.lossReasonCodes
            .filter((l) => l && l.reasonCode && String(l.reasonCode).trim().length > 0)
            .map((l) => ({
              lossType: l.lossType,
              quantity: Math.max(0, Number(l.quantity) || 0),
              unit: String(l.unit || 'units').slice(0, 20),
              reasonCode: String(l.reasonCode).trim().slice(0, 48),
              notes: String(l.notes || '').trim().slice(0, 240),
            }))
        : [];

      const findReason = (t: BatchLossRecord['lossType']) =>
        incomingLosses.find((l) => l.lossType === t && l.reasonCode.trim().length > 0);

      if (rejectedQty > 0 && !findReason('Reject')) {
        throw new ValidationError('Every Reject loss quantity > 0 requires a loss reason code.');
      }
      if (reworkQty > 0 && !findReason('Rework')) {
        throw new ValidationError('Every Rework quantity > 0 requires a loss reason code.');
      }
      if (byProductQty > 0 && !findReason('By-Product')) {
        throw new ValidationError('Every By-Product quantity > 0 requires a loss reason code.');
      }
      if (wasteKg > 0 && !findReason('Waste')) {
        throw new ValidationError('Every Waste quantity > 0 requires a loss reason code.');
      }

      const yieldPct =
        batch.plannedQty > 0
          ? Number(Math.min(200, (goodQty / batch.plannedQty) * 100).toFixed(1))
          : 0;
      const variancePct =
        batch.plannedQty > 0
          ? Number((((goodQty - batch.plannedQty) / batch.plannedQty) * 100).toFixed(1))
          : 0;

      const totalCost = batch.materialCost + batch.laborCost + batch.overheadCost;
      const unitCost = goodQty > 0 ? Number((totalCost / goodQty).toFixed(2)) : 0;
      const nowStamp = new Date().toISOString().replace('T', ' ').slice(0, 16);

      const wasAlreadyReported =
        batch.goodQty > 0 || batch.status === 'Completed' || batch.status === 'QC Review' || batch.status === 'QC Hold' || batch.status === 'Closed';

      const oldOutput: Record<string, unknown> = {
        status: batch.status,
        goodQty: batch.goodQty,
        outputMassQty: batch.outputMassQty,
        outputMassUnit: batch.outputMassUnit,
        packSize: batch.packSize,
        rejectedQty: batch.rejectedQty,
        sampleQty: batch.sampleQty,
        reworkQty: batch.reworkQty,
        byProductQty: batch.byProductQty,
        wasteKg: batch.wasteKg,
        lossReasonCodes: batch.lossReasonCodes || [],
        yieldPct: batch.yieldPct,
        variancePct: batch.variancePct,
        unitCost: batch.unitCost,
        actualEndAt: batch.actualEndAt,
      };
      const newOutput = {
        status:
          batch.status === 'Closed' || batch.status === 'QC Review' || batch.status === 'QC Hold'
            ? batch.status
            : 'Completed',
        goodQty,
        outputMassQty,
        outputMassUnit,
        packSize,
        rejectedQty,
        sampleQty,
        reworkQty,
        byProductQty,
        wasteKg,
        lossReasonCodes: incomingLosses,
        yieldPct,
        variancePct,
        unitCost,
        actualEndAt: (output.actualEndAt || '').trim().slice(0, 32) || batch.actualEndAt || nowStamp,
      };

      const diff = computeFieldDiff(oldOutput, newOutput);
      if (diff.changedKeys.length === 0) {
        return;
      }

      await tx
        .update(batches)
        .set({
          ...newOutput,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: isClosedOverride
          ? 'CLOSED_BATCH_OVERRIDE'
          : wasAlreadyReported
            ? 'UPDATE_BATCH_OUTPUT'
            : 'REPORT_BATCH_OUTPUT',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: isClosedOverride
          ? overrideReason
          : wasAlreadyReported
            ? `Edited batch output (${diff.changedLabels.join(', ')})`
            : 'Reported finished output and loss reason codes',
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to report batch output:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('Step 5') ||
        error.message.includes('not found') ||
        error.message.includes('reason code') ||
        error.message.includes('Closed'))
        ? error.message
        : 'Unable to record batch output.';
    throw new Error(msg, { cause: error });
  }
}

export async function startQcReviewDb(
  ownerId: string,
  batchId: string,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');
      if (batch.status === 'Closed') {
        throw new ForbiddenError('Batch is Closed and locked.');
      }

      await tx
        .update(batches)
        .set({
          status: 'QC Review',
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'START_QC_REVIEW',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: { status: batch.status },
        newValue: { status: 'QC Review' },
        reason: 'Batch moved from Completed into QC Review',
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to start QC review:', error);
    throw new Error('Unable to start QC review.', { cause: error });
  }
}

export async function executeQcDecisionDb(
  ownerId: string,
  batchId: string,
  payload: {
    decision: 'Passed' | 'Hold' | 'Failed';
    inspector: string;
    notes: string;
    warehouseZone: string;
    retainedSampleQty?: number;
    retainedSampleCode?: string;
    retainedSampleLocation?: string;
    qcInProcessSummary?: string;
    qcFinalResults?: string;
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<string | null> {
  const effectiveActor = actor || defaultActor(ownerId, payload.inspector || 'QC Inspector');
  try {
    assertActorPermission(effectiveActor, 'qcSignOff', 'record QC Pass / Hold / Reject sign-off');
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: payload.authorizedOverride,
          overrideReason: payload.overrideReason,
        }
      );

      const retainedSampleQty = Math.max(0, Number(payload.retainedSampleQty ?? batch.retainedSampleQty ?? 0) || 0);
      const retainedSampleCode = (
        payload.retainedSampleCode ??
        batch.retainedSampleCode ??
        (retainedSampleQty > 0 ? `RET-${batch.batchNumber}` : '')
      )
        .trim()
        .slice(0, 64);
      const retainedSampleLocation = (
        payload.retainedSampleLocation ??
        batch.retainedSampleLocation ??
        (retainedSampleQty > 0 ? 'QC Retain Vault · Shelf A1' : '')
      )
        .trim()
        .slice(0, 80);
      const qcInProcessSummary = (
        payload.qcInProcessSummary ??
        batch.qcInProcessSummary ??
        `${(batch.processChecks || []).filter((c) => c.withinSpec).length}/${(batch.processChecks || []).length} in-process checks passed`
      )
        .trim()
        .slice(0, 500);
      const qcFinalResults = (payload.qcFinalResults ?? batch.qcFinalResults ?? payload.notes ?? '')
        .trim()
        .slice(0, 500);
      const inspectorName =
        (payload.inspector || effectiveActor.name).trim().slice(0, 100) || 'QC Inspector';
      const qcNotes = (payload.notes || '').trim().slice(0, 500);
      const targetZone = payload.warehouseZone.trim().slice(0, 80) || 'FG Ambient Aisle 1';

      let prevFgZone = '';
      if (batch.finishedGoodId) {
        const [prevFg] = await tx
          .select({ warehouseZone: finishedGoods.warehouseZone })
          .from(finishedGoods)
          .where(and(eq(finishedGoods.id, batch.finishedGoodId), eq(finishedGoods.ownerId, ownerId)));
        prevFgZone = prevFg?.warehouseZone || '';
      }

      const beforeQcSnapshot: Record<string, unknown> = {
        qcStatus: batch.qcStatus,
        status: batch.status,
        qcInspector: batch.qcInspector,
        qcNotes: batch.qcNotes,
        retainedSampleQty: batch.retainedSampleQty,
        retainedSampleCode: batch.retainedSampleCode,
        retainedSampleLocation: batch.retainedSampleLocation,
        qcInProcessSummary: batch.qcInProcessSummary,
        qcFinalResults: batch.qcFinalResults,
        postedToInventory: batch.postedToInventory,
        finishedGoodId: batch.finishedGoodId,
        lotNumber: batch.lotNumber,
        warehouseZone: prevFgZone,
      };
      const wasPriorDecision = batch.qcStatus !== 'Pending';

      if (payload.decision === 'Failed' || payload.decision === 'Hold') {
        const nextQcStatus: QcStatus = payload.decision === 'Hold' ? 'Hold' : 'Failed';
        const nextStatus = batch.status === 'Closed' ? 'Closed' : 'QC Review';
        await tx
          .update(batches)
          .set({
            qcStatus: nextQcStatus,
            qcInspector: inspectorName,
            qcNotes,
            retainedSampleQty,
            retainedSampleCode,
            retainedSampleLocation,
            qcInProcessSummary,
            qcFinalResults,
            status: nextStatus,
            updatedAt: new Date(),
          })
          .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

        const afterQcSnapshot: Record<string, unknown> = {
          qcStatus: nextQcStatus,
          status: nextStatus,
          qcInspector: inspectorName,
          qcNotes,
          retainedSampleQty,
          retainedSampleCode,
          retainedSampleLocation,
          qcInProcessSummary,
          qcFinalResults,
          postedToInventory: batch.postedToInventory,
          finishedGoodId: batch.finishedGoodId,
          lotNumber: batch.lotNumber,
          warehouseZone: prevFgZone,
        };
        const diff = computeFieldDiff(beforeQcSnapshot, afterQcSnapshot);

        if (diff.changedKeys.length > 0) {
          await writeAuditLog(tx, {
            ownerId,
            actor: effectiveActor,
            action: isClosedOverride
              ? 'CLOSED_BATCH_OVERRIDE'
              : wasPriorDecision
                ? 'UPDATE_QC_DECISION'
                : 'QC_DECISION',
            entityType: 'batch',
            entityId: batchId,
            batchId,
            oldValue: diff.oldValue,
            newValue: diff.newValue,
            reason: isClosedOverride
              ? overrideReason
              : wasPriorDecision
                ? `Updated QC fields (${diff.changedLabels.join(', ')})`
                : `QC Decision: ${nextQcStatus}`,
          });
        }
        return null;
      }

      const [formula] = await tx
        .select()
        .from(formulas)
        .where(and(eq(formulas.id, batch.formulaId), eq(formulas.ownerId, ownerId)));

      const todayIso = new Date().toISOString().slice(0, 10);
      const shelfLifeDays = formula?.shelfLifeDays ?? 180;
      const expiryDate = calculateExpiryDate(todayIso, shelfLifeDays);
      const fgId = batch.finishedGoodId || makeSafeId('fg');
      const lotNumber = batch.lotNumber || `LOT-${batch.batchNumber}`;

      await tx
        .insert(finishedGoods)
        .values({
          id: fgId,
          ownerId,
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          lotNumber,
          sku: batch.sku,
          productName: batch.productName,
          quantityProduced: batch.goodQty,
          quantityAvailable: batch.goodQty,
          unit: batch.outputUnit,
          productionDate: todayIso,
          expiryDate,
          qcStatus: 'Released',
          warehouseZone: targetZone,
          unitCost: batch.unitCost,
          shipments: [],
        })
        .onConflictDoUpdate({
          target: finishedGoods.id,
          set: {
            quantityProduced: batch.goodQty,
            quantityAvailable: batch.goodQty,
            warehouseZone: targetZone,
            unitCost: batch.unitCost,
            updatedAt: new Date(),
          },
        });

      const nextStatus = batch.status === 'Closed' ? 'Closed' : 'QC Review';

      await tx
        .update(batches)
        .set({
          lotNumber,
          qcStatus: 'Passed',
          qcInspector: inspectorName,
          qcNotes,
          retainedSampleQty,
          retainedSampleCode,
          retainedSampleLocation,
          qcInProcessSummary,
          qcFinalResults,
          postedToInventory: true,
          finishedGoodId: fgId,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const afterQcSnapshot: Record<string, unknown> = {
        qcStatus: 'Passed',
        status: nextStatus,
        qcInspector: inspectorName,
        qcNotes,
        retainedSampleQty,
        retainedSampleCode,
        retainedSampleLocation,
        qcInProcessSummary,
        qcFinalResults,
        postedToInventory: true,
        finishedGoodId: fgId,
        lotNumber,
        warehouseZone: targetZone,
      };
      const diff = computeFieldDiff(beforeQcSnapshot, afterQcSnapshot);

      if (diff.changedKeys.length > 0) {
        await writeAuditLog(tx, {
          ownerId,
          actor: effectiveActor,
          action: isClosedOverride
            ? 'CLOSED_BATCH_OVERRIDE'
            : wasPriorDecision
              ? 'UPDATE_QC_DECISION'
              : 'QC_DECISION',
          entityType: 'batch',
          entityId: batchId,
          batchId,
          oldValue: diff.oldValue,
          newValue: diff.newValue,
          reason: isClosedOverride
            ? overrideReason
            : wasPriorDecision
              ? `Updated QC / FG release (${diff.changedLabels.join(', ')})`
              : 'QC Passed and Finished Goods Lot Posted',
        });
      }

      return fgId;
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to process QC decision:', error);
    throw new Error('Unable to record QC decision and post finished goods.', { cause: error });
  }
}

export async function closeProductionBatchDb(
  ownerId: string,
  batchId: string,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');
      if (batch.status === 'Closed') {
        throw new ForbiddenError('Batch is already Closed and locked.');
      }
      if (batch.qcStatus !== 'Passed') {
        throw new ValidationError('Batch must pass QC Review before it can be closed and locked.');
      }

      const nowStamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const nextActualEndAt = batch.actualEndAt || nowStamp;
      await tx
        .update(batches)
        .set({
          status: 'Closed',
          actualEndAt: nextActualEndAt,
          updatedAt: new Date(),
        })
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

      const closeDiff = computeFieldDiff(
        { status: batch.status, actualEndAt: batch.actualEndAt },
        { status: 'Closed', actualEndAt: nextActualEndAt }
      );

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'CLOSE_BATCH',
        entityType: 'batch',
        entityId: batchId,
        batchId,
        oldValue: closeDiff.oldValue,
        newValue: closeDiff.newValue,
        reason: 'Electronic Batch Record finalized, closed, and locked',
      });
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to close batch:', error);
    throw new Error('Unable to close production batch.', { cause: error });
  }
}

export async function getBatchAuditLogsDb(
  ownerId: string,
  batchId: string
): Promise<AuditLogEntry[]> {
  try {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.ownerId, ownerId), eq(auditLogs.batchId, batchId)))
      .orderBy(desc(auditLogs.createdAt));
    return rows as unknown as AuditLogEntry[];
  } catch (error) {
    console.error('Failed to query batch audit logs:', error);
    throw new Error('Unable to load batch audit trail.', { cause: error });
  }
}

export async function getFinishedGoodGenealogyDb(
  ownerId: string,
  fgIdOrLotNumber: string
): Promise<BackwardGenealogyResponse> {
  try {
    const allFg = await db
      .select()
      .from(finishedGoods)
      .where(eq(finishedGoods.ownerId, ownerId));
    const fg = allFg.find(
      (f) => f.id === fgIdOrLotNumber || f.lotNumber === fgIdOrLotNumber
    );
    if (!fg) {
      throw new ValidationError('Finished goods lot not found.');
    }

    const [batch] = await db
      .select()
      .from(batches)
      .where(and(eq(batches.id, fg.batchId), eq(batches.ownerId, ownerId)));
    if (!batch) {
      throw new ValidationError('Source production batch not found for finished lot.');
    }

    const rmRows = await db
      .select()
      .from(rawMaterials)
      .where(eq(rawMaterials.ownerId, ownerId));
    const rmById = new Map(rmRows.map((r) => [r.id, r]));
    const rmByLot = new Map(rmRows.map((r) => [r.lotNumber, r]));
    const allocatedByLot = new Map(
      (batch.allocatedMaterials || []).map((a) => [`${a.materialCode}::${a.lotId}`, a])
    );

    const rawMaterialLots: BackwardGenealogyMaterialItem[] = (
      batch.issuedMaterials || []
    ).map((m) => {
      const rm = rmById.get(m.lotId) || rmByLot.get(m.lotNumber);
      const alloc = allocatedByLot.get(`${m.materialCode}::${m.lotId}`);
      return {
        materialCode: m.materialCode,
        materialName: m.materialName,
        lotId: m.lotId,
        lotNumber: m.lotNumber,
        supplier: rm?.supplier || 'Unknown Supplier',
        expiryDate: rm?.expiryDate || '',
        storageZone: rm?.storageZone || '',
        allocatedQty: alloc ? alloc.allocatedQty : null,
        actualUsedQty: m.actualQty,
        unit: m.unit,
        variancePct: m.variancePct,
        withinTolerance: m.withinTolerance,
        addedBy: m.operator,
        addedAt: m.issuedAt,
      };
    });

    return {
      finishedGood: fg as unknown as FinishedGoodLot,
      batch: batch as unknown as ProductionBatch,
      rawMaterialLots,
      shipments: (fg.shipments || []) as FinishedGoodShipment[],
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('Failed to query backward genealogy:', error);
    throw new Error('Unable to trace finished lot backward genealogy.', { cause: error });
  }
}

export async function recordCustomerShipmentDb(
  ownerId: string,
  fgId: string,
  shipment: FinishedGoodShipment
): Promise<void> {
  try {
    const [fg] = await db
      .select()
      .from(finishedGoods)
      .where(and(eq(finishedGoods.id, fgId), eq(finishedGoods.ownerId, ownerId)));
    if (!fg) throw new Error('Finished goods lot not found.');

    const qty = Math.min(fg.quantityAvailable, Math.max(1, Number(shipment.quantityShipped)));
    const nextAvailable = Number(Math.max(0, fg.quantityAvailable - qty).toFixed(3));
    const nextShipments = [
      ...(fg.shipments || []),
      { ...shipment, quantityShipped: qty },
    ].slice(0, 25);

    await db
      .update(finishedGoods)
      .set({
        shipments: nextShipments,
        quantityAvailable: nextAvailable,
        updatedAt: new Date(),
      })
      .where(and(eq(finishedGoods.id, fgId), eq(finishedGoods.ownerId, ownerId)));
  } catch (error) {
    console.error('Failed to record customer shipment:', error);
    throw new Error('Unable to record customer shipment.', { cause: error });
  }
}

export async function updateThermalSensorDb(
  ownerId: string,
  sensorId: string,
  updates: {
    currentTempC?: number;
    targetTempC?: number;
    minSafeTempC?: number;
    maxSafeTempC?: number;
    humidityPct?: number;
    yieldImpactNote?: string;
  }
): Promise<void> {
  try {
    const [sensor] = await db
      .select()
      .from(sensors)
      .where(and(eq(sensors.id, sensorId), eq(sensors.ownerId, ownerId)));
    if (!sensor) throw new Error('Sensor not found.');

    const currentTempC = updates.currentTempC ?? sensor.currentTempC;
    const targetTempC = updates.targetTempC ?? sensor.targetTempC;
    const minSafeTempC = updates.minSafeTempC ?? sensor.minSafeTempC;
    const maxSafeTempC = updates.maxSafeTempC ?? sensor.maxSafeTempC;
    const humidityPct = updates.humidityPct ?? sensor.humidityPct;
    const status = evaluateSensorStatus(currentTempC, minSafeTempC, maxSafeTempC);
    const delta = Number((currentTempC - targetTempC).toFixed(1));
    const yieldImpactNote =
      updates.yieldImpactNote ??
      (status === 'Nominal'
        ? `Stabilized at ${currentTempC.toFixed(1)}°C (Δ${delta >= 0 ? '+' : ''}${delta}°C vs target). Optimal yield band.`
        : status === 'Warning'
          ? `Approaching HACCP limit (${currentTempC.toFixed(1)}°C). Trim PID setpoint to prevent yield variance.`
          : `HACCP thermal excursion (${currentTempC.toFixed(1)}°C vs ${minSafeTempC}–${maxSafeTempC}°C safe band). Immediate corrective action required.`);

    await db
      .update(sensors)
      .set({
        currentTempC: Number(currentTempC.toFixed(1)),
        targetTempC: Number(targetTempC.toFixed(1)),
        minSafeTempC: Number(minSafeTempC.toFixed(1)),
        maxSafeTempC: Number(maxSafeTempC.toFixed(1)),
        humidityPct: Math.max(0, Math.min(100, Math.round(humidityPct))),
        status,
        yieldImpactNote: yieldImpactNote.slice(0, 240),
        updatedAt: new Date(),
      })
      .where(and(eq(sensors.id, sensorId), eq(sensors.ownerId, ownerId)));
  } catch (error) {
    console.error('Failed to update thermal sensor:', error);
    throw new Error('Unable to update thermal sensor configuration.', { cause: error });
  }
}

export async function upsertThermalSensorDb(
  ownerId: string,
  input: {
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
  }
): Promise<ThermalSensor> {
  try {
    const sensorCode = (input.sensorCode || '').trim().toUpperCase().slice(0, 40);
    const name = (input.name || '').trim().slice(0, 100);
    if (!sensorCode || !name) {
      throw new Error('Thermal probe code and probe name are required.');
    }

    const targetTempC = Number((Number(input.targetTempC) || 85).toFixed(1));
    const currentTempC = Number(
      (Number.isFinite(Number(input.currentTempC))
        ? Number(input.currentTempC)
        : targetTempC
      ).toFixed(1)
    );
    const minSafeTempC = Number(
      (Number.isFinite(Number(input.minSafeTempC))
        ? Number(input.minSafeTempC)
        : targetTempC - 3
      ).toFixed(1)
    );
    const maxSafeTempC = Number(
      (Number.isFinite(Number(input.maxSafeTempC))
        ? Number(input.maxSafeTempC)
        : targetTempC + 3
      ).toFixed(1)
    );
    const humidityPct = Math.max(
      0,
      Math.min(100, Math.round(Number(input.humidityPct) || 60))
    );
    const status = evaluateSensorStatus(currentTempC, minSafeTempC, maxSafeTempC);
    const payload = {
      sensorCode,
      name,
      zone: (input.zone || 'Hot Processing Floor').trim().slice(0, 80),
      equipmentType: (input.equipmentType || 'Pt100 RTD Probe').trim().slice(0, 80),
      linkedLine: (input.linkedLine || '').trim().slice(0, 80),
      currentTempC,
      targetTempC,
      minSafeTempC,
      maxSafeTempC,
      humidityPct,
      status,
      yieldImpactNote: (
        input.yieldImpactNote ||
        `Target ${targetTempC.toFixed(1)}°C (safe band ${minSafeTempC.toFixed(1)}–${maxSafeTempC.toFixed(1)}°C).`
      )
        .trim()
        .slice(0, 240),
    };

    if (input.id) {
      const [updated] = await db
        .update(sensors)
        .set({ ...payload, updatedAt: new Date() })
        .where(and(eq(sensors.id, input.id), eq(sensors.ownerId, ownerId)))
        .returning();
      if (!updated) throw new Error('Thermal probe not found.');
      return updated as unknown as ThermalSensor;
    }

    const newId = makeSafeId('sen');
    const [created] = await db
      .insert(sensors)
      .values({
        id: newId,
        ownerId,
        ...payload,
      })
      .returning();
    return created as unknown as ThermalSensor;
  } catch (error) {
    console.error('Failed to save thermal probe:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') || error.message.includes('not found'))
        ? error.message
        : 'Unable to save thermal probe configuration.';
    throw new Error(msg, { cause: error });
  }
}

export async function deleteThermalSensorDb(
  ownerId: string,
  sensorId: string
): Promise<void> {
  try {
    await db
      .delete(sensors)
      .where(and(eq(sensors.id, sensorId), eq(sensors.ownerId, ownerId)));
  } catch (error) {
    console.error('Failed to delete thermal probe:', error);
    throw new Error('Unable to delete thermal probe.', { cause: error });
  }
}

export async function getBatchYieldTrendsDb(
  ownerId: string,
  lineName?: string
): Promise<BatchYieldTrendsResponse> {
  try {
    const allScoredRows = await db
      .select({
        id: batches.id,
        batchNumber: batches.batchNumber,
        lotNumber: batches.lotNumber,
        sku: batches.sku,
        productName: batches.productName,
        lineName: batches.lineName,
        plannedDate: batches.plannedDate,
        plannedQty: batches.plannedQty,
        goodQty: batches.goodQty,
        rejectedQty: batches.rejectedQty,
        wasteKg: batches.wasteKg,
        outputUnit: batches.outputUnit,
        yieldPct: batches.yieldPct,
        variancePct: batches.variancePct,
        unitCost: batches.unitCost,
        status: batches.status,
        qcStatus: batches.qcStatus,
      })
      .from(batches)
      .where(and(eq(batches.ownerId, ownerId), gt(batches.yieldPct, 0)))
      .orderBy(asc(batches.plannedDate), asc(batches.batchNumber));

    const availableLines = Array.from(
      new Set(allScoredRows.map((row) => row.lineName).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    const normalizedFilter = lineName?.trim();
    const filteredRows =
      normalizedFilter && normalizedFilter !== 'ALL'
        ? allScoredRows.filter((row) => row.lineName === normalizedFilter)
        : allScoredRows;

    const points: BatchYieldTrendPoint[] = filteredRows.map((row) => ({
      id: row.id,
      batchNumber: row.batchNumber,
      lotNumber: row.lotNumber,
      sku: row.sku,
      productName: row.productName,
      lineName: row.lineName,
      plannedDate: row.plannedDate,
      plannedQty: Number(row.plannedQty),
      goodQty: Number(row.goodQty),
      rejectedQty: Number(row.rejectedQty),
      wasteKg: Number(row.wasteKg),
      outputUnit: row.outputUnit,
      yieldPct: Number(row.yieldPct),
      variancePct: Number(row.variancePct),
      unitCost: Number(row.unitCost),
      status: row.status as BatchStatus,
      qcStatus: row.qcStatus as QcStatus,
    }));

    const avgYieldPct =
      points.length > 0
        ? Number(
            (points.reduce((sum, p) => sum + p.yieldPct, 0) / points.length).toFixed(1)
          )
        : 0;
    const totalWasteKg = Number(
      points.reduce((sum, p) => sum + p.wasteKg, 0).toFixed(1)
    );
    const bestPoint =
      points.length > 0
        ? points.reduce((best, cur) => (cur.yieldPct > best.yieldPct ? cur : best), points[0])
        : null;

    return {
      points,
      availableLines,
      avgYieldPct,
      targetYieldPct: 96.5,
      totalWasteKg,
      bestBatchNumber: bestPoint ? bestPoint.batchNumber : null,
      bestYieldPct: bestPoint ? bestPoint.yieldPct : null,
    };
  } catch (error) {
    console.error('Failed to query batch yield trends:', error);
    throw new Error('Unable to load batch yield performance trends.', { cause: error });
  }
}

function inferCategoryFromText(
  text: string,
  candidates: string[]
): string | null {
  const lower = text.toLowerCase();
  // Exact category word match first
  for (const cat of candidates) {
    if (cat && lower.includes(cat.toLowerCase())) {
      return cat;
    }
  }
  const hasPowder =
    /\b(powder|seasoning|spice|dry|premix|blend|flour|granule|mix)\b/i.test(lower);
  if (hasPowder) {
    const match = candidates.find((c) => c.toLowerCase() === 'powder');
    if (match) return match;
  }
  const hasSyrup =
    /\b(syrup|glaze|nectar|beverage|juice|drink|concentrate|honey|caramel)\b/i.test(lower);
  if (hasSyrup) {
    const match = candidates.find((c) => c.toLowerCase() === 'syrup');
    if (match) return match;
  }
  const hasSauce =
    /\b(sauce|marinara|salsa|ketchup|paste|puree|chutney|gravy|dressing|pesto)\b/i.test(lower);
  if (hasSauce) {
    const match = candidates.find((c) => c.toLowerCase() === 'sauce');
    if (match) return match;
  }
  return null;
}

export async function getBatchCategoryCompletionDb(
  ownerId: string
): Promise<BatchCategoryCompletionResponse> {
  try {
    const [userRows, batchRows, specRows, lineRows] = await Promise.all([
      db.select({ productCategories: users.productCategories }).from(users).where(eq(users.uid, ownerId)),
      db
        .select({
          id: batches.id,
          batchNumber: batches.batchNumber,
          productName: batches.productName,
          lineName: batches.lineName,
          status: batches.status,
          plannedQty: batches.plannedQty,
          goodQty: batches.goodQty,
          yieldPct: batches.yieldPct,
          plannedDate: batches.plannedDate,
        })
        .from(batches)
        .where(eq(batches.ownerId, ownerId))
        .orderBy(desc(batches.plannedDate), desc(batches.batchNumber)),
      db
        .select({
          batchId: batchCheckSpecs.batchId,
          batchNumber: batchCheckSpecs.batchNumber,
          productName: batchCheckSpecs.productName,
          productCategory: batchCheckSpecs.productCategory,
        })
        .from(batchCheckSpecs)
        .where(eq(batchCheckSpecs.ownerId, ownerId)),
      db
        .select({
          lineName: productionLines.lineName,
          supportedProductTypes: productionLines.supportedProductTypes,
        })
        .from(productionLines)
        .where(eq(productionLines.ownerId, ownerId)),
    ]);

    const configuredCategories =
      userRows[0]?.productCategories && userRows[0].productCategories.length > 0
        ? userRows[0].productCategories
        : ['Sauce', 'Syrup', 'Powder'];

    const specByBatchId = new Map<string, string>();
    const specByBatchNumber = new Map<string, string>();
    const specByProductName = new Map<string, string>();

    for (const spec of specRows) {
      if (spec.batchId) specByBatchId.set(spec.batchId, spec.productCategory);
      if (spec.batchNumber) specByBatchNumber.set(spec.batchNumber, spec.productCategory);
      if (spec.productName) {
        specByProductName.set(spec.productName.toLowerCase(), spec.productCategory);
      }
    }

    const lineByName = new Map<string, string[]>();
    for (const line of lineRows) {
      if (line.lineName) {
        lineByName.set(line.lineName, line.supportedProductTypes || []);
      }
    }

    // Build ordered category list starting with configured categories plus any spec categories
    const orderedCategories: string[] = [];
    const seenCat = new Set<string>();
    const pushCategory = (cat: string) => {
      const trimmed = (cat || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seenCat.has(key)) return;
      seenCat.add(key);
      orderedCategories.push(trimmed);
    };

    for (const c of configuredCategories) pushCategory(c);
    for (const s of specRows) pushCategory(s.productCategory);

    const resolveBatchCategory = (b: (typeof batchRows)[number]): string => {
      const byId = specByBatchId.get(b.id);
      if (byId) return byId;

      const byNum = specByBatchNumber.get(b.batchNumber);
      if (byNum) return byNum;

      const byProduct = specByProductName.get(b.productName.toLowerCase());
      if (byProduct) return byProduct;

      const lineTypes = lineByName.get(b.lineName) || [];
      if (lineTypes.length === 1) {
        return lineTypes[0];
      }
      if (lineTypes.length > 1) {
        const inferredAmongLine = inferCategoryFromText(b.productName, lineTypes);
        if (inferredAmongLine) return inferredAmongLine;
        return lineTypes[0];
      }

      const inferred = inferCategoryFromText(
        `${b.productName} ${b.lineName}`,
        orderedCategories
      );
      if (inferred) return inferred;

      return orderedCategories[0] || 'Sauce';
    };

    type Acc = {
      category: string;
      totalBatches: number;
      completedBatches: number;
      inProgressBatches: number;
      qcHoldBatches: number;
      plannedBatches: number;
      plannedQtyTotal: number;
      goodQtyTotal: number;
      yieldSum: number;
      yieldCount: number;
      latestBatchId: string | null;
      latestBatchNumber: string | null;
    };

    const accMap = new Map<string, Acc>();
    const ensureAcc = (cat: string): Acc => {
      const existing = Array.from(accMap.values()).find(
        (a) => a.category.toLowerCase() === cat.toLowerCase()
      );
      if (existing) return existing;
      const created: Acc = {
        category: cat,
        totalBatches: 0,
        completedBatches: 0,
        inProgressBatches: 0,
        qcHoldBatches: 0,
        plannedBatches: 0,
        plannedQtyTotal: 0,
        goodQtyTotal: 0,
        yieldSum: 0,
        yieldCount: 0,
        latestBatchId: null,
        latestBatchNumber: null,
      };
      accMap.set(cat, created);
      return created;
    };

    for (const c of orderedCategories) {
      ensureAcc(c);
    }

    for (const b of batchRows) {
      const cat = resolveBatchCategory(b);
      const bucket = ensureAcc(cat);
      bucket.totalBatches += 1;
      if (!bucket.latestBatchId) {
        bucket.latestBatchId = b.id;
        bucket.latestBatchNumber = b.batchNumber;
      }

      if (b.status === 'Completed' || b.status === 'Closed') {
        bucket.completedBatches += 1;
      } else if (b.status === 'QC Hold' || b.status === 'QC Review') {
        bucket.qcHoldBatches += 1;
      } else if (b.status === 'In Progress' || b.status === 'Released') {
        bucket.inProgressBatches += 1;
      } else {
        bucket.plannedBatches += 1;
      }

      bucket.plannedQtyTotal += Number(b.plannedQty) || 0;
      bucket.goodQtyTotal += Number(b.goodQty) || 0;
      if (Number(b.yieldPct) > 0) {
        bucket.yieldSum += Number(b.yieldPct);
        bucket.yieldCount += 1;
      }
    }

    const categories: BatchCategoryCompletionItem[] = Array.from(accMap.values()).map(
      (a) => {
        const completionRatePct =
          a.totalBatches > 0
            ? Number(((a.completedBatches / a.totalBatches) * 100).toFixed(1))
            : 0;
        const inFlightRatePct =
          a.totalBatches > 0
            ? Number(
                (
                  ((a.inProgressBatches + a.qcHoldBatches) / a.totalBatches) *
                  100
                ).toFixed(1)
              )
            : 0;
        const volumeCompletionPct =
          a.plannedQtyTotal > 0
            ? Number(
                Math.min(100, (a.goodQtyTotal / a.plannedQtyTotal) * 100).toFixed(1)
              )
            : 0;
        const avgYieldPct =
          a.yieldCount > 0 ? Number((a.yieldSum / a.yieldCount).toFixed(1)) : 0;

        return {
          category: a.category,
          totalBatches: a.totalBatches,
          completedBatches: a.completedBatches,
          inProgressBatches: a.inProgressBatches,
          qcHoldBatches: a.qcHoldBatches,
          plannedBatches: a.plannedBatches,
          completionRatePct,
          inFlightRatePct,
          plannedQtyTotal: Math.round(a.plannedQtyTotal),
          goodQtyTotal: Math.round(a.goodQtyTotal),
          volumeCompletionPct,
          avgYieldPct,
          latestBatchId: a.latestBatchId,
          latestBatchNumber: a.latestBatchNumber,
        };
      }
    );

    const totalBatches = categories.reduce((sum, c) => sum + c.totalBatches, 0);
    const completedBatches = categories.reduce((sum, c) => sum + c.completedBatches, 0);
    const inFlightCount = categories.reduce(
      (sum, c) => sum + c.inProgressBatches + c.qcHoldBatches,
      0
    );
    const overallCompletionRatePct =
      totalBatches > 0
        ? Number(((completedBatches / totalBatches) * 100).toFixed(1))
        : 0;

    const activeCategories = categories.filter((c) => c.totalBatches > 0);
    const leading =
      activeCategories.length > 0
        ? activeCategories.reduce((best, cur) => {
            if (cur.completionRatePct !== best.completionRatePct) {
              return cur.completionRatePct > best.completionRatePct ? cur : best;
            }
            return cur.completedBatches > best.completedBatches ? cur : best;
          }, activeCategories[0])
        : null;

    return {
      categories,
      totalBatches,
      completedBatches,
      overallCompletionRatePct,
      leadingCategory: leading ? leading.category : null,
      leadingCompletionRatePct: leading ? leading.completionRatePct : null,
      inFlightCount,
    };
  } catch (error) {
    console.error('Failed to query batch category completion analytics:', error);
    throw new Error('Unable to load batch completion rates by category.', {
      cause: error,
    });
  }
}

export async function getSensorMaintenanceLogsDb(
  ownerId: string,
  sensorId?: string
): Promise<SensorMaintenanceLog[]> {
  try {
    const condition = sensorId
      ? and(
          eq(sensorMaintenanceLogs.ownerId, ownerId),
          eq(sensorMaintenanceLogs.sensorId, sensorId)
        )
      : eq(sensorMaintenanceLogs.ownerId, ownerId);

    const rows = await db
      .select()
      .from(sensorMaintenanceLogs)
      .where(condition)
      .orderBy(
        desc(sensorMaintenanceLogs.calibrationDate),
        desc(sensorMaintenanceLogs.createdAt)
      );

    return rows as unknown as SensorMaintenanceLog[];
  } catch (error) {
    console.error('Failed to query sensor maintenance logs:', error);
    throw new Error('Unable to load sensor calibration and maintenance logs.', {
      cause: error,
    });
  }
}

export async function createSensorMaintenanceLogDb(
  ownerId: string,
  sensorId: string,
  input: {
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
  const newId = makeSafeId('sml');
  try {
    return await db.transaction(async (tx) => {
      const [sensor] = await tx
        .select()
        .from(sensors)
        .where(and(eq(sensors.id, sensorId), eq(sensors.ownerId, ownerId)));
      if (!sensor) {
        throw new Error('Thermal sensor not found.');
      }

      const validTypes: MaintenanceType[] = [
        'Calibration',
        'Inspection',
        'Probe Replacement',
        'Corrective Action',
      ];
      const maintenanceType: MaintenanceType = validTypes.includes(input.maintenanceType)
        ? input.maintenanceType
        : 'Calibration';

      const validResults: CalibrationResult[] = [
        'Pass',
        'Adjusted & Passed',
        'Requires Service',
      ];
      const verificationResult: CalibrationResult = validResults.includes(
        input.verificationResult
      )
        ? input.verificationResult
        : 'Pass';

      const calibrationDate = (input.calibrationDate || '').trim().slice(0, 32);
      const nextCalibrationDue = (input.nextCalibrationDue || '').trim().slice(0, 32);
      const technicianName = (input.technicianName || '').trim().slice(0, 100);
      if (!calibrationDate || !nextCalibrationDue || !technicianName) {
        throw new Error(
          'Calibration date, next due date, and technician name are required.'
        );
      }

      const offsetAdjustmentC = Number(
        (Number(input.offsetAdjustmentC) || 0).toFixed(2)
      );
      const asFoundTempC =
        input.asFoundTempC !== null &&
        input.asFoundTempC !== undefined &&
        Number.isFinite(Number(input.asFoundTempC))
          ? Number(Number(input.asFoundTempC).toFixed(1))
          : null;
      const asLeftTempC =
        input.asLeftTempC !== null &&
        input.asLeftTempC !== undefined &&
        Number.isFinite(Number(input.asLeftTempC))
          ? Number(Number(input.asLeftTempC).toFixed(1))
          : null;

      const [created] = await tx
        .insert(sensorMaintenanceLogs)
        .values({
          id: newId,
          ownerId,
          sensorId: sensor.id,
          sensorCode: sensor.sensorCode,
          maintenanceType,
          calibrationDate,
          nextCalibrationDue,
          offsetAdjustmentC,
          asFoundTempC,
          asLeftTempC,
          verificationResult,
          technicianName,
          notes: (input.notes || '').trim().slice(0, 600),
        })
        .returning();

      if (input.syncProbeReading && asLeftTempC !== null) {
        const nextStatus = evaluateSensorStatus(
          asLeftTempC,
          sensor.minSafeTempC,
          sensor.maxSafeTempC
        );
        await tx
          .update(sensors)
          .set({
            currentTempC: asLeftTempC,
            status: nextStatus,
            yieldImpactNote: `Calibrated on ${calibrationDate} by ${technicianName} (${verificationResult}).`,
            updatedAt: new Date(),
          })
          .where(and(eq(sensors.id, sensor.id), eq(sensors.ownerId, ownerId)));
      }

      return created as unknown as SensorMaintenanceLog;
    });
  } catch (error) {
    console.error('Failed to record sensor maintenance log:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') || error.message.includes('not found'))
        ? error.message
        : 'Unable to save sensor maintenance log.';
    throw new Error(msg, { cause: error });
  }
}

export async function deleteSensorMaintenanceLogDb(
  ownerId: string,
  logId: string
): Promise<void> {
  try {
    await db
      .delete(sensorMaintenanceLogs)
      .where(
        and(
          eq(sensorMaintenanceLogs.id, logId),
          eq(sensorMaintenanceLogs.ownerId, ownerId)
        )
      );
  } catch (error) {
    console.error('Failed to delete sensor maintenance log:', error);
    throw new Error('Unable to remove sensor maintenance log.', { cause: error });
  }
}

function toNullableNum(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export async function upsertBatchCheckSpecDb(
  ownerId: string,
  input: {
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
  },
  actor?: ActorContext
): Promise<BatchCheckSpec> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    const productCategory: BatchCheckProductCategory =
      (input.productCategory || '').trim().slice(0, 48) || 'Sauce';

    const batchNumber = (input.batchNumber || '').trim().slice(0, 64);
    const productName = (input.productName || '').trim().slice(0, 120);
    if (!batchNumber || !productName) {
      throw new Error('Batch number and product name are required.');
    }

    const sanitizedParams: BatchCheckAdditionalParam[] = (input.additionalParams || [])
      .filter((p) => (p.name || '').trim().length > 0)
      .slice(0, 15)
      .map((p, idx) => ({
        id: (p.id || `prm-${idx + 1}`).trim().slice(0, 48),
        name: p.name.trim().slice(0, 80),
        unit: (p.unit || '').trim().slice(0, 24),
        minTarget: toNullableNum(p.minTarget),
        maxTarget: toNullableNum(p.maxTarget),
        targetNote: (p.targetNote || '').trim().slice(0, 140),
      }));

    const payload = {
      batchId: (input.batchId || '').trim().slice(0, 128),
      batchNumber,
      productName,
      productCategory,
      phMin: toNullableNum(input.phMin),
      phMax: toNullableNum(input.phMax),
      awMin: toNullableNum(input.awMin),
      awMax: toNullableNum(input.awMax),
      brixMin: toNullableNum(input.brixMin),
      brixMax: toNullableNum(input.brixMax),
      additionalParams: sanitizedParams,
      requirementNotes: (input.requirementNotes || '').trim().slice(0, 500),
    };

    const resolveLinkedBatchId = async (tx: DbOrTx, bId: string, bNum: string): Promise<string> => {
      if (bId) return bId;
      const [match] = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(and(eq(batches.ownerId, ownerId), eq(batches.batchNumber, bNum)));
      return match?.id || '';
    };

    if (input.id) {
      return await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(batchCheckSpecs)
          .where(and(eq(batchCheckSpecs.id, input.id!), eq(batchCheckSpecs.ownerId, ownerId)));
        if (!existing) throw new Error('Batch requirement specification not found.');

        const [updated] = await tx
          .update(batchCheckSpecs)
          .set({ ...payload, updatedAt: new Date() })
          .where(
            and(
              eq(batchCheckSpecs.id, input.id!),
              eq(batchCheckSpecs.ownerId, ownerId)
            )
          )
          .returning();

        const diff = computeFieldDiff(
          {
            batchId: existing.batchId,
            batchNumber: existing.batchNumber,
            productName: existing.productName,
            productCategory: existing.productCategory,
            phMin: existing.phMin,
            phMax: existing.phMax,
            awMin: existing.awMin,
            awMax: existing.awMax,
            brixMin: existing.brixMin,
            brixMax: existing.brixMax,
            additionalParams: existing.additionalParams,
            requirementNotes: existing.requirementNotes,
          },
          payload
        );

        if (diff.changedKeys.length > 0) {
          const linkedBatchId = await resolveLinkedBatchId(tx, payload.batchId || existing.batchId, payload.batchNumber);
          await writeAuditLog(tx, {
            ownerId,
            actor: effectiveActor,
            action: 'UPDATE_BATCH_CHECK_SPEC',
            entityType: 'batch_check_spec',
            entityId: updated.id,
            batchId: linkedBatchId,
            oldValue: diff.oldValue,
            newValue: diff.newValue,
            reason: `Edited Batch Check spec (${diff.changedLabels.join(', ')})`,
          });
        }

        return updated as unknown as BatchCheckSpec;
      });
    }

    return await db.transaction(async (tx) => {
      const newId = makeSafeId('bcs');
      const [created] = await tx
        .insert(batchCheckSpecs)
        .values({
          id: newId,
          ownerId,
          ...payload,
        })
        .returning();

      const linkedBatchId = await resolveLinkedBatchId(tx, payload.batchId, payload.batchNumber);
      if (linkedBatchId) {
        await writeAuditLog(tx, {
          ownerId,
          actor: effectiveActor,
          action: 'LINK_BATCH_CHECK_SPEC',
          entityType: 'batch_check_spec',
          entityId: created.id,
          batchId: linkedBatchId,
          oldValue: null,
          newValue: payload,
          reason: `Linked ${productCategory} Batch Check parameter set (${batchNumber})`,
        });
      }

      return created as unknown as BatchCheckSpec;
    });
  } catch (error) {
    console.error('Failed to save batch check spec:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') || error.message.includes('not found'))
        ? error.message
        : 'Unable to save batch check requirement.';
    throw new Error(msg, { cause: error });
  }
}

export async function deleteBatchCheckSpecDb(
  ownerId: string,
  specId: string
): Promise<void> {
  try {
    await db
      .delete(batchCheckSpecs)
      .where(
        and(eq(batchCheckSpecs.id, specId), eq(batchCheckSpecs.ownerId, ownerId))
      );
  } catch (error) {
    console.error('Failed to delete batch check spec:', error);
    throw new Error('Unable to delete batch requirement.', { cause: error });
  }
}

function isWithinBounds(
  val: number | null,
  min: number | null,
  max: number | null
): boolean {
  if (val === null) return true;
  if (min !== null && val < min) return false;
  if (max !== null && val > max) return false;
  return true;
}

function sanitizeTriplicateReadings(
  raw: unknown,
  decimals: number
): number[] {
  if (!Array.isArray(raw)) return [];
  const list: number[] = [];
  for (const item of raw) {
    if (item === null || item === undefined || item === '') continue;
    const n = Number(item);
    if (!Number.isFinite(n)) continue;
    list.push(Number(n.toFixed(decimals)));
    if (list.length >= 3) break;
  }
  return list;
}

export async function createBatchCheckRecordDb(
  ownerId: string,
  specId: string,
  input: {
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
  },
  actor?: ActorContext
): Promise<BatchCheckRecord> {
  const effectiveActor = actor || defaultActor(ownerId, input.inspectorName || 'QC Inspector');
  const newId = makeSafeId('bcr');
  try {
    const [spec] = await db
      .select()
      .from(batchCheckSpecs)
      .where(
        and(eq(batchCheckSpecs.id, specId), eq(batchCheckSpecs.ownerId, ownerId))
      );
    if (!spec) {
      throw new Error('Batch check specification not found.');
    }

    const phReadings = sanitizeTriplicateReadings(input.phReadings, 2);
    const awReadings = sanitizeTriplicateReadings(input.awReadings, 3);
    const brixReadings = sanitizeTriplicateReadings(input.brixReadings, 1);

    const requiresPh = spec.phMin !== null || spec.phMax !== null;
    const requiresAw = spec.awMin !== null || spec.awMax !== null;
    const requiresBrix = spec.brixMin !== null || spec.brixMax !== null;

    if ((requiresPh || phReadings.length > 0) && phReadings.length !== 3) {
      throw new Error('Measured pH requires all 3 readings (R1, R2, R3).');
    }
    if ((requiresAw || awReadings.length > 0) && awReadings.length !== 3) {
      throw new Error('Measured Aw requires all 3 readings (R1, R2, R3).');
    }
    if ((requiresBrix || brixReadings.length > 0) && brixReadings.length !== 3) {
      throw new Error('Measured Brix requires all 3 readings (R1, R2, R3).');
    }

    const avgOf = (vals: number[], decimals: number): number | null => {
      if (vals.length === 0) return null;
      const sum = vals.reduce((acc, v) => acc + v, 0);
      return Number((sum / vals.length).toFixed(decimals));
    };

    const measuredPh =
      phReadings.length === 3 ? avgOf(phReadings, 2) : toNullableNum(input.measuredPh);
    const measuredAw =
      awReadings.length === 3 ? avgOf(awReadings, 3) : toNullableNum(input.measuredAw);
    const measuredBrix =
      brixReadings.length === 3
        ? avgOf(brixReadings, 1)
        : toNullableNum(input.measuredBrix);

    const inspectorName = (input.inspectorName || '').trim().slice(0, 100);
    if (!inspectorName) {
      throw new Error('Inspector name is required.');
    }

    const paramMap = new Map(
      (spec.additionalParams || []).map((p) => [p.id, p])
    );

    const sanitizedReadings: BatchCheckAdditionalReading[] = (
      input.additionalReadings || []
    )
      .filter((r) => (r.name || '').trim().length > 0 && String(r.value ?? '').trim().length > 0)
      .slice(0, 20)
      .map((r) => {
        const def = paramMap.get(r.paramId);
        const num = toNullableNum(r.value);
        const within = def
          ? isWithinBounds(num, def.minTarget, def.maxTarget)
          : r.withinSpec !== false;
        return {
          paramId: (r.paramId || 'extra').trim().slice(0, 48),
          name: r.name.trim().slice(0, 80),
          unit: (r.unit || def?.unit || '').trim().slice(0, 24),
          value: String(r.value).trim().slice(0, 80),
          numericValue: num,
          withinSpec: within,
        };
      });

    if (
      phReadings.length === 0 &&
      awReadings.length === 0 &&
      brixReadings.length === 0 &&
      sanitizedReadings.length === 0
    ) {
      throw new Error('Record at least one configured category parameter reading.');
    }

    const phOk =
      phReadings.length > 0
        ? phReadings.every((v) => isWithinBounds(v, spec.phMin, spec.phMax))
        : isWithinBounds(measuredPh, spec.phMin, spec.phMax);
    const awOk =
      awReadings.length > 0
        ? awReadings.every((v) => isWithinBounds(v, spec.awMin, spec.awMax))
        : isWithinBounds(measuredAw, spec.awMin, spec.awMax);
    const brixOk =
      brixReadings.length > 0
        ? brixReadings.every((v) => isWithinBounds(v, spec.brixMin, spec.brixMax))
        : isWithinBounds(measuredBrix, spec.brixMin, spec.brixMax);
    const addOk = sanitizedReadings.every((r) => r.withinSpec);

    const autoStatus: BatchCheckConditionStatus =
      phOk && awOk && brixOk && addOk ? 'In Spec' : 'Out of Spec';

    const conditionStatus: BatchCheckConditionStatus =
      input.conditionStatus === 'In Spec' ||
      input.conditionStatus === 'Marginal' ||
      input.conditionStatus === 'Out of Spec'
        ? input.conditionStatus
        : autoStatus;

    const recordedAt =
      (input.recordedAt || '').trim().slice(0, 32) ||
      new Date().toISOString().replace('T', ' ').slice(0, 16);

    const [created] = await db
      .insert(batchCheckRecords)
      .values({
        id: newId,
        ownerId,
        specId: spec.id,
        batchNumber: spec.batchNumber,
        productCategory: spec.productCategory,
        samplingStage: (input.samplingStage || 'In-Process').trim().slice(0, 48),
        measuredPh,
        measuredAw,
        measuredBrix,
        phReadings,
        awReadings,
        brixReadings,
        additionalReadings: sanitizedReadings,
        conditionStatus,
        inspectorName,
        recordedAt,
        notes: (input.notes || '').trim().slice(0, 600),
      })
      .returning();

    let linkedBatchId = spec.batchId || '';
    if (!linkedBatchId) {
      const [match] = await db
        .select({ id: batches.id })
        .from(batches)
        .where(and(eq(batches.ownerId, ownerId), eq(batches.batchNumber, spec.batchNumber)));
      linkedBatchId = match?.id || '';
    }

    await writeAuditLog(db, {
      ownerId,
      actor: effectiveActor,
      action: 'CREATE_BATCH_CHECK_RECORD',
      entityType: 'batch_check_record',
      entityId: created.id,
      batchId: linkedBatchId,
      oldValue: null,
      newValue: {
        samplingStage: created.samplingStage,
        measuredPh: created.measuredPh,
        measuredAw: created.measuredAw,
        measuredBrix: created.measuredBrix,
        additionalReadings: created.additionalReadings,
        conditionStatus: created.conditionStatus,
        inspectorName: created.inspectorName,
        notes: created.notes,
      },
      reason: `Recorded ${spec.productCategory} Batch Check (${created.samplingStage})`,
    });

    return created as unknown as BatchCheckRecord;
  } catch (error) {
    console.error('Failed to record batch check:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') ||
        error.message.includes('requires') ||
        error.message.includes('Record at least') ||
        error.message.includes('not found'))
        ? error.message
        : 'Unable to save batch condition record.';
    throw new Error(msg, { cause: error });
  }
}

export async function updateBatchCheckRecordDb(
  ownerId: string,
  recordId: string,
  input: {
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
  },
  actor?: ActorContext
): Promise<BatchCheckRecord> {
  const effectiveActor = actor || defaultActor(ownerId, input.inspectorName || 'QC Inspector');
  try {
    const [existing] = await db
      .select()
      .from(batchCheckRecords)
      .where(
        and(
          eq(batchCheckRecords.id, recordId),
          eq(batchCheckRecords.ownerId, ownerId)
        )
      );
    if (!existing) {
      throw new Error('Batch condition record not found.');
    }

    const targetSpecId = (input.specId || existing.specId).trim();
    const [spec] = await db
      .select()
      .from(batchCheckSpecs)
      .where(
        and(
          eq(batchCheckSpecs.id, targetSpecId),
          eq(batchCheckSpecs.ownerId, ownerId)
        )
      );
    if (!spec) {
      throw new Error('Batch check specification not found.');
    }

    const phReadings = sanitizeTriplicateReadings(input.phReadings, 2);
    const awReadings = sanitizeTriplicateReadings(input.awReadings, 3);
    const brixReadings = sanitizeTriplicateReadings(input.brixReadings, 1);

    const requiresPh = spec.phMin !== null || spec.phMax !== null;
    const requiresAw = spec.awMin !== null || spec.awMax !== null;
    const requiresBrix = spec.brixMin !== null || spec.brixMax !== null;

    if ((requiresPh || phReadings.length > 0) && phReadings.length !== 3) {
      throw new Error('Measured pH requires all 3 readings (R1, R2, R3).');
    }
    if ((requiresAw || awReadings.length > 0) && awReadings.length !== 3) {
      throw new Error('Measured Aw requires all 3 readings (R1, R2, R3).');
    }
    if ((requiresBrix || brixReadings.length > 0) && brixReadings.length !== 3) {
      throw new Error('Measured Brix requires all 3 readings (R1, R2, R3).');
    }

    const avgOf = (vals: number[], decimals: number): number | null => {
      if (vals.length === 0) return null;
      const sum = vals.reduce((acc, v) => acc + v, 0);
      return Number((sum / vals.length).toFixed(decimals));
    };

    const measuredPh =
      phReadings.length === 3 ? avgOf(phReadings, 2) : toNullableNum(input.measuredPh);
    const measuredAw =
      awReadings.length === 3 ? avgOf(awReadings, 3) : toNullableNum(input.measuredAw);
    const measuredBrix =
      brixReadings.length === 3
        ? avgOf(brixReadings, 1)
        : toNullableNum(input.measuredBrix);

    const inspectorName = (input.inspectorName || '').trim().slice(0, 100);
    if (!inspectorName) {
      throw new Error('Inspector name is required.');
    }

    const paramMap = new Map(
      (spec.additionalParams || []).map((p) => [p.id, p])
    );

    const sanitizedReadings: BatchCheckAdditionalReading[] = (
      input.additionalReadings || []
    )
      .filter((r) => (r.name || '').trim().length > 0 && String(r.value ?? '').trim().length > 0)
      .slice(0, 20)
      .map((r) => {
        const def = paramMap.get(r.paramId);
        const num = toNullableNum(r.value);
        const within = def
          ? isWithinBounds(num, def.minTarget, def.maxTarget)
          : r.withinSpec !== false;
        return {
          paramId: (r.paramId || 'extra').trim().slice(0, 48),
          name: r.name.trim().slice(0, 80),
          unit: (r.unit || def?.unit || '').trim().slice(0, 24),
          value: String(r.value).trim().slice(0, 80),
          numericValue: num,
          withinSpec: within,
        };
      });

    if (
      phReadings.length === 0 &&
      awReadings.length === 0 &&
      brixReadings.length === 0 &&
      sanitizedReadings.length === 0
    ) {
      throw new Error('Record at least one configured category parameter reading.');
    }

    const phOk =
      phReadings.length > 0
        ? phReadings.every((v) => isWithinBounds(v, spec.phMin, spec.phMax))
        : isWithinBounds(measuredPh, spec.phMin, spec.phMax);
    const awOk =
      awReadings.length > 0
        ? awReadings.every((v) => isWithinBounds(v, spec.awMin, spec.awMax))
        : isWithinBounds(measuredAw, spec.awMin, spec.awMax);
    const brixOk =
      brixReadings.length > 0
        ? brixReadings.every((v) => isWithinBounds(v, spec.brixMin, spec.brixMax))
        : isWithinBounds(measuredBrix, spec.brixMin, spec.brixMax);
    const addOk = sanitizedReadings.every((r) => r.withinSpec);

    const autoStatus: BatchCheckConditionStatus =
      phOk && awOk && brixOk && addOk ? 'In Spec' : 'Out of Spec';

    const conditionStatus: BatchCheckConditionStatus =
      input.conditionStatus === 'In Spec' ||
      input.conditionStatus === 'Marginal' ||
      input.conditionStatus === 'Out of Spec'
        ? input.conditionStatus
        : autoStatus;

    const nextPayload = {
      specId: spec.id,
      batchNumber: spec.batchNumber,
      productCategory: spec.productCategory,
      samplingStage: (input.samplingStage || 'In-Process').trim().slice(0, 48),
      measuredPh,
      measuredAw,
      measuredBrix,
      phReadings,
      awReadings,
      brixReadings,
      additionalReadings: sanitizedReadings,
      conditionStatus,
      inspectorName,
      notes: (input.notes || '').trim().slice(0, 600),
    };

    const [updated] = await db
      .update(batchCheckRecords)
      .set({
        ...nextPayload,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(batchCheckRecords.id, recordId),
          eq(batchCheckRecords.ownerId, ownerId)
        )
      )
      .returning();

    const buildRecordDiffMap = (rec: {
      specId: string;
      batchNumber: string;
      productCategory: string;
      samplingStage: string;
      measuredPh: number | null;
      measuredAw: number | null;
      measuredBrix: number | null;
      phReadings: number[];
      awReadings: number[];
      brixReadings: number[];
      additionalReadings: BatchCheckAdditionalReading[];
      conditionStatus: string;
      inspectorName: string;
      notes: string;
    }) => {
      const flat: Record<string, unknown> = {
        specId: rec.specId,
        batchNumber: rec.batchNumber,
        productCategory: rec.productCategory,
        samplingStage: rec.samplingStage,
        measuredPh: rec.measuredPh,
        measuredAw: rec.measuredAw,
        measuredBrix: rec.measuredBrix,
        phReadings: rec.phReadings,
        awReadings: rec.awReadings,
        brixReadings: rec.brixReadings,
        conditionStatus: rec.conditionStatus,
        inspectorName: rec.inspectorName,
        notes: rec.notes,
      };
      for (const r of rec.additionalReadings || []) {
        if (r.name) {
          flat[`param:${r.name}`] = `${r.value}${r.unit ? ` ${r.unit}` : ''}`;
        }
      }
      return flat;
    };

    const diff = computeFieldDiff(
      buildRecordDiffMap({
        specId: existing.specId,
        batchNumber: existing.batchNumber,
        productCategory: existing.productCategory,
        samplingStage: existing.samplingStage,
        measuredPh: existing.measuredPh,
        measuredAw: existing.measuredAw,
        measuredBrix: existing.measuredBrix,
        phReadings: existing.phReadings || [],
        awReadings: existing.awReadings || [],
        brixReadings: existing.brixReadings || [],
        additionalReadings: existing.additionalReadings || [],
        conditionStatus: existing.conditionStatus,
        inspectorName: existing.inspectorName,
        notes: existing.notes,
      }),
      buildRecordDiffMap(nextPayload)
    );

    if (diff.changedKeys.length > 0) {
      let linkedBatchId = spec.batchId || '';
      if (!linkedBatchId) {
        const [match] = await db
          .select({ id: batches.id })
          .from(batches)
          .where(and(eq(batches.ownerId, ownerId), eq(batches.batchNumber, spec.batchNumber)));
        linkedBatchId = match?.id || '';
      }
      await writeAuditLog(db, {
        ownerId,
        actor: effectiveActor,
        action: 'UPDATE_BATCH_CHECK_RECORD',
        entityType: 'batch_check_record',
        entityId: updated.id,
        batchId: linkedBatchId,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
        reason: `Edited Batch Check record (${diff.changedLabels.join(', ')})`,
      });
    }

    return updated as unknown as BatchCheckRecord;
  } catch (error) {
    console.error('Failed to update batch check record:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') ||
        error.message.includes('requires') ||
        error.message.includes('Record at least') ||
        error.message.includes('not found'))
        ? error.message
        : 'Unable to update batch condition record.';
    throw new Error(msg, { cause: error });
  }
}

export async function deleteBatchCheckRecordDb(
  ownerId: string,
  recordId: string,
  actor?: ActorContext
): Promise<void> {
  const effectiveActor = actor || defaultActor(ownerId);
  try {
    const [existing] = await db
      .select()
      .from(batchCheckRecords)
      .where(
        and(
          eq(batchCheckRecords.id, recordId),
          eq(batchCheckRecords.ownerId, ownerId)
        )
      );
    await db
      .delete(batchCheckRecords)
      .where(
        and(
          eq(batchCheckRecords.id, recordId),
          eq(batchCheckRecords.ownerId, ownerId)
        )
      );
    if (existing) {
      const [spec] = await db
        .select()
        .from(batchCheckSpecs)
        .where(eq(batchCheckSpecs.id, existing.specId));
      let linkedBatchId = spec?.batchId || '';
      if (!linkedBatchId && existing.batchNumber) {
        const [match] = await db
          .select({ id: batches.id })
          .from(batches)
          .where(and(eq(batches.ownerId, ownerId), eq(batches.batchNumber, existing.batchNumber)));
        linkedBatchId = match?.id || '';
      }
      await writeAuditLog(db, {
        ownerId,
        actor: effectiveActor,
        action: 'DELETE_BATCH_CHECK_RECORD',
        entityType: 'batch_check_record',
        entityId: recordId,
        batchId: linkedBatchId,
        oldValue: {
          samplingStage: existing.samplingStage,
          measuredPh: existing.measuredPh,
          measuredAw: existing.measuredAw,
          measuredBrix: existing.measuredBrix,
          additionalReadings: existing.additionalReadings,
          conditionStatus: existing.conditionStatus,
          inspectorName: existing.inspectorName,
          notes: existing.notes,
        },
        newValue: null,
        reason: `Deleted Batch Check record (${existing.samplingStage} · ${existing.recordedAt})`,
      });
    }
  } catch (error) {
    console.error('Failed to delete batch check record:', error);
    throw new Error('Unable to remove batch condition record.', { cause: error });
  }
}

export async function upsertProductionLineDb(
  ownerId: string,
  input: {
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
  }
): Promise<ProductionLineMachine> {
  try {
    const lineCode = (input.lineCode || '').trim().toUpperCase().slice(0, 32);
    const lineName = (input.lineName || '').trim().slice(0, 80);
    const machineName = (input.machineName || '').trim().slice(0, 120);
    if (!lineCode || !lineName || !machineName) {
      throw new Error('Line code, line name, and machine name are required.');
    }

    const validCategories: MachineCategory[] = [
      'Thermal Kettle',
      'Pasteurizer / Beverage',
      'Filling & Sealing',
      'Dry Blending / Powder',
      'Cooling / Retort',
    ];
    const category: MachineCategory = validCategories.includes(input.category)
      ? input.category
      : 'Thermal Kettle';

    const status: LineOperationalStatus =
      (input.status || '').trim().slice(0, 40) || 'Active';

    const supportedProductTypes = Array.from(
      new Set(
        (input.supportedProductTypes || [])
          .map((t) => String(t || '').trim().slice(0, 40))
          .filter(Boolean)
      )
    );

    const sanitizedSettings: MachineParameterSetting[] = (
      input.customSettings || []
    )
      .filter((s) => (s.parameterName || '').trim().length > 0)
      .slice(0, 20)
      .map((s, idx) => ({
        id: (s.id || `mset-${idx + 1}`).trim().slice(0, 48),
        parameterName: s.parameterName.trim().slice(0, 80),
        setpoint: (s.setpoint || '').trim().slice(0, 48),
        minLimit: toNullableNum(s.minLimit),
        maxLimit: toNullableNum(s.maxLimit),
        unit: (s.unit || '').trim().slice(0, 24),
        notes: (s.notes || '').trim().slice(0, 160),
      }));

    const agitatorRaw = toNullableNum(input.agitatorRpm);
    const speedRaw = toNullableNum(input.fillerSpeedUnitsPerMin);

    const payload = {
      lineCode,
      lineName,
      machineName,
      machineModel: (input.machineModel || '').trim().slice(0, 64),
      category,
      supportedProductTypes,
      status,
      batchCapacity: Math.max(1, Number(input.batchCapacity) || 500),
      capacityUnit: (input.capacityUnit || 'kg').trim().slice(0, 24),
      targetTempC: toNullableNum(input.targetTempC),
      agitatorRpm: agitatorRaw !== null ? Math.round(agitatorRaw) : null,
      pressureBar: toNullableNum(input.pressureBar),
      fillerSpeedUnitsPerMin:
        speedRaw !== null ? Math.max(0, Math.round(speedRaw)) : null,
      cleaningIntervalHours: Math.max(
        1,
        Math.round(Number(input.cleaningIntervalHours) || 8)
      ),
      defaultCrew: (input.defaultCrew || '').trim().slice(0, 80),
      linkedSensorCode: (input.linkedSensorCode || '').trim().slice(0, 40),
      customSettings: sanitizedSettings,
      notes: (input.notes || '').trim().slice(0, 600),
    };

    if (input.id) {
      const [updated] = await db
        .update(productionLines)
        .set({ ...payload, updatedAt: new Date() })
        .where(
          and(
            eq(productionLines.id, input.id),
            eq(productionLines.ownerId, ownerId)
          )
        )
        .returning();
      if (!updated) throw new Error('Production line / machine not found.');
      return updated as unknown as ProductionLineMachine;
    }

    const newId = makeSafeId('line');
    const [created] = await db
      .insert(productionLines)
      .values({
        id: newId,
        ownerId,
        ...payload,
      })
      .returning();
    return created as unknown as ProductionLineMachine;
  } catch (error) {
    console.error('Failed to save production line / machine:', error);
    const msg =
      error instanceof Error &&
      (error.message.includes('required') || error.message.includes('not found'))
        ? error.message
        : 'Unable to save production line and machine settings.';
    throw new Error(msg, { cause: error });
  }
}

export async function updateProductionLineStatusDb(
  ownerId: string,
  lineId: string,
  status: LineOperationalStatus
): Promise<ProductionLineMachine> {
  try {
    const safeStatus: LineOperationalStatus =
      (status || '').trim().slice(0, 40) || 'Active';
    const [updated] = await db
      .update(productionLines)
      .set({ status: safeStatus, updatedAt: new Date() })
      .where(
        and(eq(productionLines.id, lineId), eq(productionLines.ownerId, ownerId))
      )
      .returning();
    if (!updated) throw new Error('Production line / machine not found.');
    return updated as unknown as ProductionLineMachine;
  } catch (error) {
    console.error('Failed to update production line status:', error);
    throw new Error('Unable to update production line status.', { cause: error });
  }
}

export async function deleteProductionLineDb(
  ownerId: string,
  lineId: string
): Promise<void> {
  try {
    await db
      .delete(productionLines)
      .where(
        and(eq(productionLines.id, lineId), eq(productionLines.ownerId, ownerId))
      );
  } catch (error) {
    console.error('Failed to delete production line:', error);
    throw new Error('Unable to remove production line setting.', { cause: error });
  }
}

export async function ingestSensorReadingsDb(
  ownerId: string,
  batchId: string,
  payload: {
    readings: NormalizedSensorReading[];
    mode?: 'auto-save' | 'backfill' | 'file-import' | 'snapshot';
  } & ClosedOverrideOptions,
  actor?: ActorContext
): Promise<SensorIngestResult> {
  const effectiveActor = actor || defaultActor(ownerId, 'Sensor Adapter');
  const readings = Array.isArray(payload.readings) ? payload.readings : [];
  const mode = payload.mode || 'auto-save';

  if (readings.length === 0) {
    return {
      insertedCount: 0,
      skippedDuplicateCount: 0,
      skippedManualCount: 0,
      totalEvaluated: 0,
    };
  }

  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));
      if (!batch) throw new ValidationError('Batch not found.');

      const { isClosedOverride, overrideReason } = assertClosedBatchEditable(
        batch,
        effectiveActor,
        {
          authorizedOverride: payload.authorizedOverride,
          overrideReason: payload.overrideReason,
        }
      );

      const [formula] = await tx
        .select()
        .from(formulas)
        .where(and(eq(formulas.id, batch.formulaId), eq(formulas.ownerId, ownerId)));
      const formulaParams =
        formula?.processParameters && formula.processParameters.length > 0
          ? formula.processParameters
          : buildDefaultRecipeProcessParameters(`${batch.sku} ${batch.productName}`);

      const existing: ProcessCheckRecord[] = (batch.processChecks || []).map((c, idx) => ({
        ...c,
        id: c.id || `chk-legacy-${c.stepNumber}-${idx}`,
      }));

      // Protect Manual entries: never overwrite or collide on Manual timestamps or slots
      const manualTimeKeys = new Set<string>();
      for (const rec of existing) {
        if ((rec.source || 'Manual') === 'Manual') {
          if (rec.recordedAt) manualTimeKeys.add(rec.recordedAt.slice(0, 16));
          if (rec.readingTime) manualTimeKeys.add(rec.readingTime.slice(0, 5));
        }
      }

      // Deduplicate already-ingested Sensor readings by timestamp + sensorCode
      const existingSensorKeys = new Set<string>();
      for (const rec of existing) {
        if (rec.source === 'Sensor') {
          existingSensorKeys.add(`${rec.recordedAt}::${rec.sensorCode}`);
        }
      }

      let skippedManualCount = 0;
      let skippedDuplicateCount = 0;
      const toInsert: ProcessCheckRecord[] = [];
      let nextSlot = existing.length + 1;

      const sortedIncoming = [...readings].sort((a, b) =>
        String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
      );

      for (const raw of sortedIncoming) {
        const tempC = toNullableNum(raw.tempC);
        const brix = toNullableNum(raw.brix);
        const ph = toNullableNum(raw.ph);
        const viscosityCp = toNullableNum(raw.viscosityCp);
        const weightKg = toNullableNum(raw.weightKg);
        const speedRpm = toNullableNum(raw.speedRpm);
        const pressureBar = toNullableNum(raw.pressureBar);

        if (
          tempC === null &&
          brix === null &&
          ph === null &&
          viscosityCp === null &&
          weightKg === null &&
          speedRpm === null &&
          pressureBar === null
        ) {
          continue;
        }

        const iso = String(raw.timestamp || new Date().toISOString());
        const normalizedStamp = iso.includes('T')
          ? iso.replace('T', ' ').slice(0, 19)
          : iso.slice(0, 19);
        const minuteStamp = normalizedStamp.slice(0, 16);
        const hhmm =
          String(raw.readingTime || '').trim().slice(0, 8) || normalizedStamp.slice(11, 16);
        const hhmmShort = hhmm.slice(0, 5);
        const sensorCode = String(raw.sensorCode || 'GW-SENSOR').trim().slice(0, 48) || 'GW-SENSOR';

        // Never overwrite an operator Manual reading at the same timestamp/minute
        if (manualTimeKeys.has(minuteStamp) || manualTimeKeys.has(hhmmShort)) {
          skippedManualCount += 1;
          continue;
        }

        const dedupKey = `${normalizedStamp}::${sensorCode}`;
        if (existingSensorKeys.has(dedupKey)) {
          skippedDuplicateCount += 1;
          continue;
        }
        existingSensorKeys.add(dedupKey);

        const keyValues: Record<string, number | null> = {
          temperature: tempC,
          ph,
          brix,
          viscosity: viscosityCp,
          weight: weightKg,
          time: null,
          speed: speedRpm,
          pressure: pressureBar,
        };

        let withinSpec = true;
        const outOfSpecParams: string[] = [];
        const parameterReadings: EbrParameterReading[] = [];

        for (const fp of formulaParams) {
          const val = keyValues[fp.key] ?? null;
          if (val === null) continue;
          const ok = isWithinBounds(val, fp.min, fp.max);
          if (!ok) {
            withinSpec = false;
            outOfSpecParams.push(
              `${fp.name} (${val} ${fp.unit}; spec ${fp.min ?? '—'}–${fp.max ?? '—'})`
            );
          }
          parameterReadings.push({
            paramId: fp.id,
            key: fp.key,
            name: fp.name,
            value: val,
            unit: fp.unit,
            target: fp.target,
            min: fp.min,
            max: fp.max,
            withinSpec: ok,
            timestamp: normalizedStamp,
            user: `${effectiveActor.name} (${raw.adapter || mode})`,
            source: 'Sensor',
          });
        }

        const slotNum = nextSlot++;
        toInsert.push({
          id: makeSafeId('chk-sen'),
          readingTime: hhmm,
          readingSlot: slotNum,
          stepNumber: slotNum,
          stepName: `Sensor Reading #${slotNum} (${mode})`,
          recordedTempC: tempC,
          recordedBrix: brix,
          recordedPh: ph,
          recordedAw: null,
          recordedWeightKg: weightKg,
          recordedWeightG: weightKg !== null ? Number((weightKg * 1000).toFixed(1)) : null,
          recordedViscosityCp: viscosityCp,
          recordedSpeedRpm: speedRpm,
          recordedPressureBar: pressureBar,
          source: 'Sensor',
          parameterReadings,
          outOfSpecParams,
          deviationRecord: withinSpec ? '' : 'SENSOR-OOS-PENDING',
          durationMin: 0,
          sensorCode,
          withinSpec,
          operator: effectiveActor.name,
          notes: withinSpec
            ? `Captured via ${raw.adapter || 'sensor'} adapter (${mode})`
            : `Out-of-spec sensor reading (${outOfSpecParams.join(', ')}) — operator verification required.`,
          recordedAt: normalizedStamp,
        });
      }

      if (toInsert.length > 0) {
        const merged = [...existing, ...toInsert]
          .sort((a, b) => (a.recordedAt || '').localeCompare(b.recordedAt || ''))
          .slice(-60)
          .map((c, idx) => ({
            ...c,
            readingSlot: idx + 1,
          }));

        const nowStamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
        const nextStatus = batch.status === 'Released' ? 'In Progress' : batch.status;
        const nextActualStartAt = batch.actualStartAt || nowStamp;
        await tx
          .update(batches)
          .set({
            processChecks: merged,
            actualStartAt: nextActualStartAt,
            status: nextStatus,
            updatedAt: new Date(),
          })
          .where(and(eq(batches.id, batchId), eq(batches.ownerId, ownerId)));

        // Sync latest thermal reading back to matching ThermalSensor probe row if present
        const latestWithTemp = [...toInsert].reverse().find((r) => r.recordedTempC !== null);
        if (latestWithTemp && latestWithTemp.recordedTempC !== null) {
          const [matchedSensor] = await tx
            .select()
            .from(sensors)
            .where(
              and(
                eq(sensors.ownerId, ownerId),
                eq(sensors.sensorCode, latestWithTemp.sensorCode)
              )
            );
          if (matchedSensor) {
            await tx
              .update(sensors)
              .set({
                currentTempC: latestWithTemp.recordedTempC,
                status: evaluateSensorStatus(
                  latestWithTemp.recordedTempC,
                  matchedSensor.minSafeTempC,
                  matchedSensor.maxSafeTempC
                ),
                updatedAt: new Date(),
              })
              .where(eq(sensors.id, matchedSensor.id));
          }
        }

        const sensorDiff = computeFieldDiff(
          {
            processChecksCount: existing.length,
            status: batch.status,
            actualStartAt: batch.actualStartAt,
          },
          {
            processChecksCount: merged.length,
            status: nextStatus,
            actualStartAt: nextActualStartAt,
            insertedCount: toInsert.length,
            skippedManualCount,
            skippedDuplicateCount,
            mode,
          }
        );

        await writeAuditLog(tx, {
          ownerId,
          actor: effectiveActor,
          action: isClosedOverride
            ? 'CLOSED_BATCH_OVERRIDE'
            : mode === 'backfill'
              ? 'SENSOR_BACKFILL'
              : mode === 'file-import'
                ? 'SENSOR_FILE_IMPORT'
                : 'SENSOR_AUTO_SAVE',
          entityType: 'batch',
          entityId: batchId,
          batchId,
          oldValue: sensorDiff.oldValue,
          newValue: sensorDiff.newValue,
          reason: isClosedOverride
            ? overrideReason
            : `Ingested ${toInsert.length} sensor reading(s) (${mode}); preserved ${skippedManualCount} manual slot(s)`,
        });
      }

      return {
        insertedCount: toInsert.length,
        skippedDuplicateCount,
        skippedManualCount,
        totalEvaluated: readings.length,
      };
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ValidationError) throw error;
    console.error('Failed to ingest sensor readings:', error);
    throw new Error('Unable to save sensor readings to batch record.', { cause: error });
  }
}

export async function importWmsRawMaterialsDb(
  ownerId: string,
  items: Array<{
    lotNumber: string;
    materialCode: string;
    materialName: string;
    category?: string;
    unit?: string;
    quantityInitial?: number;
    quantityAvailable: number;
    reorderLevel?: number;
    unitCost?: number;
    supplier?: string;
    expiryDate?: string;
    storageZone?: string;
  }>,
  actor?: ActorContext,
  mode: 'set' | 'add' = 'set'
): Promise<WmsImportResult> {
  const effectiveActor = actor || defaultActor(ownerId);
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    throw new ValidationError('No raw material rows supplied for WMS/CSV import.');
  }

  try {
    return await db.transaction(async (tx) => {
      const existingLots = await tx
        .select()
        .from(rawMaterials)
        .where(eq(rawMaterials.ownerId, ownerId));
      const byLotNumber = new Map(existingLots.map((l) => [l.lotNumber.toUpperCase(), l]));

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const item = rows[i];
        const lotNumber = String(item.lotNumber || '').trim().slice(0, 64);
        const materialCode = String(item.materialCode || '').trim().slice(0, 48);
        const materialName = String(item.materialName || '').trim().slice(0, 120);
        const qtyAvail = Number(item.quantityAvailable);

        if (!lotNumber || !materialCode || !materialName || !Number.isFinite(qtyAvail) || qtyAvail < 0) {
          skippedCount += 1;
          errors.push(`Row ${i + 1}: missing lotNumber, materialCode, materialName, or valid quantityAvailable.`);
          continue;
        }

        const unitRaw = String(item.unit || '').trim().toLowerCase();
        const safeUnit: UnitOfMeasure =
          unitRaw === 'g'
            ? 'g'
            : unitRaw === 'l' || unitRaw === 'ltr' || unitRaw === 'liter'
              ? 'L'
              : unitRaw === 'ml'
                ? 'ml'
                : unitRaw === 'pcs' || unitRaw === 'pc' || unitRaw === 'ea' || unitRaw === 'each'
                  ? 'pcs'
                  : 'kg';
        const safeCategory: MaterialCategory =
          String(item.category || '').trim().toLowerCase().includes('pack')
            ? 'Packaging'
            : 'Ingredient';
        const existing = byLotNumber.get(lotNumber.toUpperCase());
        const reorderLevel = Math.max(
          0,
          Number(item.reorderLevel ?? existing?.reorderLevel ?? 50) || 0
        );
        const expiryDate =
          String(item.expiryDate || existing?.expiryDate || '2027-12-31').trim().slice(0, 20);

        if (existing) {
          const nextAvail =
            mode === 'add'
              ? Number((existing.quantityAvailable + qtyAvail).toFixed(3))
              : Number(qtyAvail.toFixed(3));
          const nextInitial =
            mode === 'add'
              ? Number((existing.quantityInitial + qtyAvail).toFixed(3))
              : Math.max(
                  nextAvail,
                  Number(item.quantityInitial ?? existing.quantityInitial) || nextAvail
                );
          const nextStatus = deriveRawLotStatus(nextAvail, reorderLevel, expiryDate);
          await tx
            .update(rawMaterials)
            .set({
              materialCode,
              materialName,
              category: safeCategory,
              unit: safeUnit,
              quantityInitial: nextInitial,
              quantityAvailable: nextAvail,
              reorderLevel,
              unitCost: Math.max(0, Number(item.unitCost ?? existing.unitCost) || 0),
              supplier: String(item.supplier || existing.supplier || 'CSV / WMS Import').trim().slice(0, 120),
              expiryDate,
              storageZone: String(item.storageZone || existing.storageZone || 'Raw Receiving Dock').trim().slice(0, 80),
              status: nextStatus,
              updatedAt: new Date(),
            })
            .where(and(eq(rawMaterials.id, existing.id), eq(rawMaterials.ownerId, ownerId)));
          byLotNumber.set(lotNumber.toUpperCase(), {
            ...existing,
            materialCode,
            materialName,
            category: safeCategory,
            unit: safeUnit,
            quantityInitial: nextInitial,
            quantityAvailable: nextAvail,
            reorderLevel,
            expiryDate,
            status: nextStatus,
          });
          updatedCount += 1;
        } else {
          const nextStatus = deriveRawLotStatus(qtyAvail, reorderLevel, expiryDate);
          const id = makeSafeId('rm');
          const insertedLot = {
            id,
            ownerId,
            lotNumber,
            materialCode,
            materialName,
            category: safeCategory,
            unit: safeUnit,
            quantityInitial: Math.max(qtyAvail, Number(item.quantityInitial ?? qtyAvail) || qtyAvail),
            quantityAvailable: qtyAvail,
            quantityAllocated: 0,
            reorderLevel,
            unitCost: Math.max(0, Number(item.unitCost ?? 0) || 0),
            supplier: String(item.supplier || 'CSV / WMS Import').trim().slice(0, 120),
            expiryDate,
            storageZone: String(item.storageZone || 'Raw Receiving Dock').trim().slice(0, 80),
            status: nextStatus,
          };
          await tx.insert(rawMaterials).values(insertedLot);
          byLotNumber.set(lotNumber.toUpperCase(), insertedLot as typeof existingLots[number]);
          createdCount += 1;
        }
      }

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'WMS_IMPORT_RAW_MATERIALS',
        entityType: 'raw_material',
        entityId: ownerId,
        oldValue: { existingCount: existingLots.length, importMode: mode },
        newValue: { createdCount, updatedCount, skippedCount, importMode: mode },
        reason: `Raw material CSV/WMS import [${mode}] (${createdCount} created, ${updatedCount} updated, ${skippedCount} skipped)`,
      });

      return { createdCount, updatedCount, skippedCount, errors };
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('Failed to import raw materials:', error);
    throw new Error('Unable to import raw material stock.', { cause: error });
  }
}

export async function importWmsFinishedGoodsDb(
  ownerId: string,
  items: Array<{
    lotNumber: string;
    batchNumber?: string;
    sku?: string;
    productName?: string;
    quantityAvailable: number;
    quantityProduced?: number;
    unit?: string;
    warehouseZone?: string;
    qcStatus?: string;
    expiryDate?: string;
  }>,
  actor?: ActorContext
): Promise<WmsImportResult> {
  const effectiveActor = actor || defaultActor(ownerId);
  const rows = Array.isArray(items) ? items : [];
  if (rows.length === 0) {
    throw new ValidationError('No finished-goods lot rows supplied for WMS import.');
  }

  try {
    return await db.transaction(async (tx) => {
      const existingFgs = await tx
        .select()
        .from(finishedGoods)
        .where(eq(finishedGoods.ownerId, ownerId));
      const allBatches = await tx
        .select()
        .from(batches)
        .where(eq(batches.ownerId, ownerId));

      const byLotNumber = new Map(existingFgs.map((f) => [f.lotNumber.toUpperCase(), f]));
      const batchByNumber = new Map(allBatches.map((b) => [b.batchNumber.toUpperCase(), b]));

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        const item = rows[i];
        const lotNumber = String(item.lotNumber || '').trim().slice(0, 64);
        const qtyAvail = Number(item.quantityAvailable);

        if (!lotNumber || !Number.isFinite(qtyAvail) || qtyAvail < 0) {
          skippedCount += 1;
          errors.push(`Row ${i + 1}: missing lotNumber or valid quantityAvailable.`);
          continue;
        }

        const existing = byLotNumber.get(lotNumber.toUpperCase());
        const safeQc = item.qcStatus === 'Quarantined' ? 'Quarantined' : 'Released';

        if (existing) {
          await tx
            .update(finishedGoods)
            .set({
              quantityAvailable: qtyAvail,
              warehouseZone:
                String(item.warehouseZone || existing.warehouseZone || 'FG Ambient Aisle 1')
                  .trim()
                  .slice(0, 80),
              qcStatus: safeQc,
              expiryDate: String(item.expiryDate || existing.expiryDate).trim().slice(0, 20),
              updatedAt: new Date(),
            })
            .where(and(eq(finishedGoods.id, existing.id), eq(finishedGoods.ownerId, ownerId)));
          updatedCount += 1;
        } else {
          const matchedBatch = item.batchNumber
            ? batchByNumber.get(String(item.batchNumber).trim().toUpperCase())
            : allBatches[0];
          if (!matchedBatch) {
            skippedCount += 1;
            errors.push(
              `Row ${i + 1} (${lotNumber}): no matching production batch exists in MES to link this new FG lot.`
            );
            continue;
          }
          const id = makeSafeId('fg');
          await tx.insert(finishedGoods).values({
            id,
            ownerId,
            batchId: matchedBatch.id,
            batchNumber: String(item.batchNumber || matchedBatch.batchNumber).trim().slice(0, 64),
            lotNumber,
            sku: String(item.sku || matchedBatch.sku).trim().slice(0, 48),
            productName: String(item.productName || matchedBatch.productName).trim().slice(0, 120),
            quantityProduced: Math.max(qtyAvail, Number(item.quantityProduced ?? qtyAvail) || qtyAvail),
            quantityAvailable: qtyAvail,
            unit: String(item.unit || matchedBatch.outputUnit || 'units').trim().slice(0, 24),
            productionDate: new Date().toISOString().slice(0, 10),
            expiryDate: String(item.expiryDate || '2027-12-31').trim().slice(0, 20),
            qcStatus: safeQc,
            warehouseZone: String(item.warehouseZone || 'WMS Dispatch Bay').trim().slice(0, 80),
            unitCost: matchedBatch.unitCost || 0,
            shipments: [],
          });
          createdCount += 1;
        }
      }

      await writeAuditLog(tx, {
        ownerId,
        actor: effectiveActor,
        action: 'WMS_IMPORT_FINISHED_GOODS',
        entityType: 'finished_good',
        entityId: ownerId,
        oldValue: { existingCount: existingFgs.length },
        newValue: { createdCount, updatedCount, skippedCount },
        reason: `WMS finished goods sync/import (${createdCount} created, ${updatedCount} updated)`,
      });

      return { createdCount, updatedCount, skippedCount, errors };
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('Failed to import WMS finished goods:', error);
    throw new Error('Unable to import finished goods lots.', { cause: error });
  }
}
