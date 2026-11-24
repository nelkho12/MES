import crypto from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { createPool, getActiveDb } from '../db/index.ts';
import * as schema from '../db/schema.ts';
import {
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
} from '../db/schema.ts';

export interface SqlConnectionParams {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  max?: number;
  connectionTimeoutMillis?: number;
}

export class SqlServiceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SqlServiceError';
  }
}

export class SqlValidationError extends SqlServiceError {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

export class SqlNotFoundError extends SqlServiceError {
  statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'SqlNotFoundError';
  }
}

function parsePort(raw: string | undefined, fallback = 5432): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function parseSslFlag(raw: string | undefined): boolean {
  const normalized = (raw || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'require';
}

/**
 * Builds a PostgreSQL PoolConfig using the Object Method from .env.example variables
 * (SQL_HOST, SQL_PORT, SQL_DB_NAME, SQL_USER, SQL_PASSWORD, SQL_SSL).
 */
export function buildEnvPgPoolConfig(overrides: SqlConnectionParams = {}): PoolConfig {
  const host = (overrides.host ?? process.env.SQL_HOST ?? '127.0.0.1').trim();
  const database = (overrides.database ?? process.env.SQL_DB_NAME ?? '').trim();
  const user = (overrides.user ?? process.env.SQL_USER ?? '').trim();
  const password = overrides.password ?? process.env.SQL_PASSWORD ?? '';
  const port = overrides.port ?? parsePort(process.env.SQL_PORT, 5432);
  const useSsl = overrides.ssl ?? parseSslFlag(process.env.SQL_SSL);
  const isUnixSocket = host.startsWith('/');

  const config: PoolConfig = {
    host,
    user,
    password,
    database,
    max: overrides.max ?? 10,
    connectionTimeoutMillis: overrides.connectionTimeoutMillis ?? 15000,
  };

  if (!isUnixSocket) {
    config.port = port;
    if (useSsl) {
      config.ssl = { rejectUnauthorized: false };
    }
  }

  return config;
}

declare global {
  var _sqlServicePool: Pool | undefined;
  var _sqlServiceDb: NodePgDatabase<typeof schema> | undefined;
}

/**
 * Lazily creates or returns a standalone pg Pool configured via .env.example SQL_* variables,
 * or delegates to the shared application pool when no explicit overrides are supplied.
 */
export function getSqlPool(overrides?: SqlConnectionParams): Pool {
  if (!overrides) {
    return createPool();
  }
  if (!global._sqlServicePool) {
    const nextPool = new Pool(buildEnvPgPoolConfig(overrides));
    nextPool.on('error', (err) => {
      console.error('Unexpected error on SQL service pool client:', err);
    });
    global._sqlServicePool = nextPool;
    global._sqlServiceDb = drizzle(nextPool, { schema });
  }
  return global._sqlServicePool;
}

export function createIsolatedSqlPool(overrides: SqlConnectionParams = {}): {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
} {
  const pool = new Pool(buildEnvPgPoolConfig(overrides));
  pool.on('error', (err) => {
    console.error('Unexpected error on isolated SQL pool client:', err);
  });
  return {
    pool,
    db: drizzle(pool, { schema }),
  };
}

export async function closeSqlPool(poolToClose?: Pool): Promise<void> {
  const target = poolToClose ?? global._sqlServicePool;
  if (!target) return;
  await target.end();
  if (target === global._sqlServicePool) {
    global._sqlServicePool = undefined;
    global._sqlServiceDb = undefined;
  }
}

/**
 * Executes a callback inside an explicit PostgreSQL BEGIN / COMMIT / ROLLBACK transaction
 * using a pooled client connection and releasing it cleanly in finally.
 */
export async function withPgPoolTransaction<T>(
  fn: (client: PoolClient, txDb: NodePgDatabase<typeof schema>) => Promise<T>,
  pool?: Pool
): Promise<T> {
  const activePool = pool ?? getSqlPool();
  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const txDb = drizzle(client, { schema });
    const result = await fn(client, txDb);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof SqlServiceError) {
      throw error;
    }
    console.error('PostgreSQL transaction failed:', error);
    throw new SqlServiceError('Database transaction failed. Please try again later.', {
      cause: error,
    });
  } finally {
    client.release();
  }
}

async function runQuery<T>(
  label: string,
  operation: (activeDb: NodePgDatabase<typeof schema>) => Promise<T>
): Promise<T> {
  try {
    const activeDb = getActiveDb();
    return await operation(activeDb);
  } catch (error) {
    if (error instanceof SqlServiceError) {
      throw error;
    }
    console.error(`PostgreSQL operation failed (${label}):`, error);
    throw new SqlServiceError('Database operation failed. Please try again later.', {
      cause: error,
    });
  }
}

function assertNonEmptyId(id: string, fieldName = 'id'): string {
  const trimmed = (id || '').trim();
  if (!trimmed) {
    throw new SqlValidationError(`${fieldName} is required.`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Users CRUD
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

export async function getUserByUid(uid: string): Promise<UserRow | null> {
  const cleanUid = assertNonEmptyId(uid, 'uid');
  return runQuery('getUserByUid', async (activeDb) => {
    const rows = await activeDb.select().from(users).where(eq(users.uid, cleanUid));
    return rows[0] ?? null;
  });
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) {
    throw new SqlValidationError('email is required.');
  }
  return runQuery('getUserByEmail', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${cleanEmail}`);
    return rows[0] ?? null;
  });
}

export async function getSqlUserStatsSql(): Promise<{
  sqlUsersCount: number;
  hasPasswordedUsers: boolean;
}> {
  return runQuery('getSqlUserStatsSql', async (activeDb) => {
    const countRows = await activeDb
      .select({
        total: sql<number>`count(*)::int`,
        withPass: sql<number>`count(*) filter (where ${users.passwordHash} is not null)::int`,
      })
      .from(users);
    return {
      sqlUsersCount: countRows[0]?.total ?? 0,
      hasPasswordedUsers: (countRows[0]?.withPass ?? 0) > 0,
    };
  });
}

export async function createUserRecord(input: UserInsert): Promise<UserRow> {
  const cleanUid = assertNonEmptyId(input.uid, 'uid');
  return runQuery('createUserRecord', async (activeDb) => {
    const [row] = await activeDb
      .insert(users)
      .values({ ...input, uid: cleanUid })
      .returning();
    return row;
  });
}

export async function listUsers(): Promise<UserRow[]> {
  return runQuery('listUsers', (activeDb) =>
    activeDb.select().from(users).orderBy(desc(users.createdAt))
  );
}

export async function upsertUser(input: UserInsert): Promise<UserRow> {
  const cleanUid = assertNonEmptyId(input.uid, 'uid');
  return runQuery('upsertUser', async (activeDb) => {
    const [row] = await activeDb
      .insert(users)
      .values({ ...input, uid: cleanUid })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: input.email,
          displayName: input.displayName,
          ...(input.role ? { role: input.role } : {}),
          ...(input.plantName ? { plantName: input.plantName } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  });
}

export async function updateUserByUid(
  uid: string,
  patch: Partial<Omit<UserInsert, 'uid' | 'createdAt'>>
): Promise<UserRow> {
  const cleanUid = assertNonEmptyId(uid, 'uid');
  return runQuery('updateUserByUid', async (activeDb) => {
    const [row] = await activeDb
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.uid, cleanUid))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('User not found.');
    }
    return row;
  });
}

export async function deleteUserByUid(uid: string): Promise<boolean> {
  const cleanUid = assertNonEmptyId(uid, 'uid');
  return runQuery('deleteUserByUid', async (activeDb) => {
    const deleted = await activeDb
      .delete(users)
      .where(eq(users.uid, cleanUid))
      .returning({ uid: users.uid });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Formulas & BOMs CRUD
// ---------------------------------------------------------------------------

export type FormulaRow = typeof formulas.$inferSelect;
export type FormulaInsert = typeof formulas.$inferInsert;

export async function listFormulas(ownerId: string): Promise<FormulaRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listFormulas', (activeDb) =>
    activeDb
      .select()
      .from(formulas)
      .where(eq(formulas.ownerId, cleanOwner))
      .orderBy(desc(formulas.updatedAt))
  );
}

export async function getFormulaById(ownerId: string, id: string): Promise<FormulaRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'formulaId');
  return runQuery('getFormulaById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(formulas)
      .where(and(eq(formulas.ownerId, cleanOwner), eq(formulas.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function createFormula(
  input: Omit<FormulaInsert, 'id'> & { id?: string }
): Promise<FormulaRow> {
  const id = input.id?.trim() || `F-${crypto.randomUUID()}`;
  return runQuery('createFormula', async (activeDb) => {
    const [row] = await activeDb
      .insert(formulas)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateFormula(
  ownerId: string,
  id: string,
  patch: Partial<Omit<FormulaInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<FormulaRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'formulaId');
  return runQuery('updateFormula', async (activeDb) => {
    const [row] = await activeDb
      .update(formulas)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(formulas.ownerId, cleanOwner), eq(formulas.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Formula not found.');
    }
    return row;
  });
}

export async function deleteFormula(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'formulaId');
  return runQuery('deleteFormula', async (activeDb) => {
    const deleted = await activeDb
      .delete(formulas)
      .where(and(eq(formulas.ownerId, cleanOwner), eq(formulas.id, cleanId)))
      .returning({ id: formulas.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Raw Materials CRUD
// ---------------------------------------------------------------------------

export type RawMaterialRow = typeof rawMaterials.$inferSelect;
export type RawMaterialInsert = typeof rawMaterials.$inferInsert;

export async function listRawMaterials(ownerId: string): Promise<RawMaterialRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listRawMaterials', (activeDb) =>
    activeDb
      .select()
      .from(rawMaterials)
      .where(eq(rawMaterials.ownerId, cleanOwner))
      .orderBy(desc(rawMaterials.updatedAt))
  );
}

export async function getRawMaterialById(
  ownerId: string,
  id: string
): Promise<RawMaterialRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'rawMaterialId');
  return runQuery('getRawMaterialById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(rawMaterials)
      .where(and(eq(rawMaterials.ownerId, cleanOwner), eq(rawMaterials.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function createRawMaterial(
  input: Omit<RawMaterialInsert, 'id'> & { id?: string }
): Promise<RawMaterialRow> {
  const id = input.id?.trim() || `RM-${crypto.randomUUID()}`;
  return runQuery('createRawMaterial', async (activeDb) => {
    const [row] = await activeDb
      .insert(rawMaterials)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateRawMaterial(
  ownerId: string,
  id: string,
  patch: Partial<Omit<RawMaterialInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<RawMaterialRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'rawMaterialId');
  return runQuery('updateRawMaterial', async (activeDb) => {
    const [row] = await activeDb
      .update(rawMaterials)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(rawMaterials.ownerId, cleanOwner), eq(rawMaterials.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Raw material lot not found.');
    }
    return row;
  });
}

export async function deleteRawMaterial(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'rawMaterialId');
  return runQuery('deleteRawMaterial', async (activeDb) => {
    const deleted = await activeDb
      .delete(rawMaterials)
      .where(and(eq(rawMaterials.ownerId, cleanOwner), eq(rawMaterials.id, cleanId)))
      .returning({ id: rawMaterials.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Production Batches CRUD
// ---------------------------------------------------------------------------

export type BatchRow = typeof batches.$inferSelect;
export type BatchInsert = typeof batches.$inferInsert;

export async function listBatches(ownerId: string): Promise<BatchRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listBatches', (activeDb) =>
    activeDb
      .select()
      .from(batches)
      .where(eq(batches.ownerId, cleanOwner))
      .orderBy(desc(batches.createdAt))
  );
}

export async function getBatchById(ownerId: string, id: string): Promise<BatchRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'batchId');
  return runQuery('getBatchById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(batches)
      .where(and(eq(batches.ownerId, cleanOwner), eq(batches.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function createBatch(
  input: Omit<BatchInsert, 'id'> & { id?: string }
): Promise<BatchRow> {
  const id = input.id?.trim() || `B-${crypto.randomUUID()}`;
  return runQuery('createBatch', async (activeDb) => {
    const [row] = await activeDb
      .insert(batches)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateBatch(
  ownerId: string,
  id: string,
  patch: Partial<Omit<BatchInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<BatchRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'batchId');
  return runQuery('updateBatch', async (activeDb) => {
    const [row] = await activeDb
      .update(batches)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(batches.ownerId, cleanOwner), eq(batches.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Production batch not found.');
    }
    return row;
  });
}

export async function deleteBatch(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'batchId');
  return runQuery('deleteBatch', async (activeDb) => {
    const deleted = await activeDb
      .delete(batches)
      .where(and(eq(batches.ownerId, cleanOwner), eq(batches.id, cleanId)))
      .returning({ id: batches.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Finished Goods CRUD
// ---------------------------------------------------------------------------

export type FinishedGoodRow = typeof finishedGoods.$inferSelect;
export type FinishedGoodInsert = typeof finishedGoods.$inferInsert;

export async function listFinishedGoods(ownerId: string): Promise<FinishedGoodRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listFinishedGoods', (activeDb) =>
    activeDb
      .select()
      .from(finishedGoods)
      .where(eq(finishedGoods.ownerId, cleanOwner))
      .orderBy(desc(finishedGoods.createdAt))
  );
}

export async function createFinishedGood(
  input: Omit<FinishedGoodInsert, 'id'> & { id?: string }
): Promise<FinishedGoodRow> {
  const id = input.id?.trim() || `FG-${crypto.randomUUID()}`;
  return runQuery('createFinishedGood', async (activeDb) => {
    const [row] = await activeDb
      .insert(finishedGoods)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateFinishedGood(
  ownerId: string,
  id: string,
  patch: Partial<Omit<FinishedGoodInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<FinishedGoodRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'finishedGoodId');
  return runQuery('updateFinishedGood', async (activeDb) => {
    const [row] = await activeDb
      .update(finishedGoods)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(finishedGoods.ownerId, cleanOwner), eq(finishedGoods.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Finished good lot not found.');
    }
    return row;
  });
}

export async function deleteFinishedGood(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'finishedGoodId');
  return runQuery('deleteFinishedGood', async (activeDb) => {
    const deleted = await activeDb
      .delete(finishedGoods)
      .where(and(eq(finishedGoods.ownerId, cleanOwner), eq(finishedGoods.id, cleanId)))
      .returning({ id: finishedGoods.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Sensors & Production Lines CRUD
// ---------------------------------------------------------------------------

export type SensorRow = typeof sensors.$inferSelect;
export type SensorInsert = typeof sensors.$inferInsert;

export async function listSensors(ownerId: string): Promise<SensorRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listSensors', (activeDb) =>
    activeDb.select().from(sensors).where(eq(sensors.ownerId, cleanOwner))
  );
}

export async function createSensor(
  input: Omit<SensorInsert, 'id'> & { id?: string }
): Promise<SensorRow> {
  const id = input.id?.trim() || `SNS-${crypto.randomUUID()}`;
  return runQuery('createSensor', async (activeDb) => {
    const [row] = await activeDb
      .insert(sensors)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateSensor(
  ownerId: string,
  id: string,
  patch: Partial<Omit<SensorInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<SensorRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'sensorId');
  return runQuery('updateSensor', async (activeDb) => {
    const [row] = await activeDb
      .update(sensors)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(sensors.ownerId, cleanOwner), eq(sensors.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Thermal sensor not found.');
    }
    return row;
  });
}

export async function deleteSensor(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'sensorId');
  return runQuery('deleteSensor', async (activeDb) => {
    const deleted = await activeDb
      .delete(sensors)
      .where(and(eq(sensors.ownerId, cleanOwner), eq(sensors.id, cleanId)))
      .returning({ id: sensors.id });
    return deleted.length > 0;
  });
}

export type ProductionLineRow = typeof productionLines.$inferSelect;
export type ProductionLineInsert = typeof productionLines.$inferInsert;

export async function listProductionLines(ownerId: string): Promise<ProductionLineRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listProductionLines', (activeDb) =>
    activeDb
      .select()
      .from(productionLines)
      .where(eq(productionLines.ownerId, cleanOwner))
  );
}

export async function createProductionLine(
  input: Omit<ProductionLineInsert, 'id'> & { id?: string }
): Promise<ProductionLineRow> {
  const id = input.id?.trim() || `LINE-${crypto.randomUUID()}`;
  return runQuery('createProductionLine', async (activeDb) => {
    const [row] = await activeDb
      .insert(productionLines)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateProductionLine(
  ownerId: string,
  id: string,
  patch: Partial<Omit<ProductionLineInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<ProductionLineRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'lineId');
  return runQuery('updateProductionLine', async (activeDb) => {
    const [row] = await activeDb
      .update(productionLines)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(productionLines.ownerId, cleanOwner), eq(productionLines.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Production line not found.');
    }
    return row;
  });
}

export async function deleteProductionLine(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'lineId');
  return runQuery('deleteProductionLine', async (activeDb) => {
    const deleted = await activeDb
      .delete(productionLines)
      .where(and(eq(productionLines.ownerId, cleanOwner), eq(productionLines.id, cleanId)))
      .returning({ id: productionLines.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Batch Check Specs, Records & Audit Logs CRUD
// ---------------------------------------------------------------------------

export type BatchCheckSpecRow = typeof batchCheckSpecs.$inferSelect;
export type BatchCheckSpecInsert = typeof batchCheckSpecs.$inferInsert;

export async function listBatchCheckSpecs(ownerId: string): Promise<BatchCheckSpecRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listBatchCheckSpecs', (activeDb) =>
    activeDb
      .select()
      .from(batchCheckSpecs)
      .where(eq(batchCheckSpecs.ownerId, cleanOwner))
      .orderBy(desc(batchCheckSpecs.updatedAt))
  );
}

export async function createBatchCheckSpec(
  input: Omit<BatchCheckSpecInsert, 'id'> & { id?: string }
): Promise<BatchCheckSpecRow> {
  const id = input.id?.trim() || `BCS-${crypto.randomUUID()}`;
  return runQuery('createBatchCheckSpec', async (activeDb) => {
    const [row] = await activeDb
      .insert(batchCheckSpecs)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateBatchCheckSpec(
  ownerId: string,
  id: string,
  patch: Partial<Omit<BatchCheckSpecInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<BatchCheckSpecRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'specId');
  return runQuery('updateBatchCheckSpec', async (activeDb) => {
    const [row] = await activeDb
      .update(batchCheckSpecs)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(batchCheckSpecs.ownerId, cleanOwner), eq(batchCheckSpecs.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Batch check specification not found.');
    }
    return row;
  });
}

export async function deleteBatchCheckSpec(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'specId');
  return runQuery('deleteBatchCheckSpec', async (activeDb) => {
    const deleted = await activeDb
      .delete(batchCheckSpecs)
      .where(and(eq(batchCheckSpecs.ownerId, cleanOwner), eq(batchCheckSpecs.id, cleanId)))
      .returning({ id: batchCheckSpecs.id });
    return deleted.length > 0;
  });
}

export type BatchCheckRecordRow = typeof batchCheckRecords.$inferSelect;
export type BatchCheckRecordInsert = typeof batchCheckRecords.$inferInsert;

export async function listBatchCheckRecords(ownerId: string): Promise<BatchCheckRecordRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listBatchCheckRecords', (activeDb) =>
    activeDb
      .select()
      .from(batchCheckRecords)
      .where(eq(batchCheckRecords.ownerId, cleanOwner))
      .orderBy(desc(batchCheckRecords.createdAt))
  );
}

export async function createBatchCheckRecord(
  input: Omit<BatchCheckRecordInsert, 'id'> & { id?: string }
): Promise<BatchCheckRecordRow> {
  const id = input.id?.trim() || `BCR-${crypto.randomUUID()}`;
  return runQuery('createBatchCheckRecord', async (activeDb) => {
    const [row] = await activeDb
      .insert(batchCheckRecords)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function updateBatchCheckRecord(
  ownerId: string,
  id: string,
  patch: Partial<Omit<BatchCheckRecordInsert, 'id' | 'ownerId' | 'createdAt'>>
): Promise<BatchCheckRecordRow> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'recordId');
  return runQuery('updateBatchCheckRecord', async (activeDb) => {
    const [row] = await activeDb
      .update(batchCheckRecords)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(batchCheckRecords.ownerId, cleanOwner), eq(batchCheckRecords.id, cleanId)))
      .returning();
    if (!row) {
      throw new SqlNotFoundError('Batch check record not found.');
    }
    return row;
  });
}

export async function deleteBatchCheckRecord(ownerId: string, id: string): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'recordId');
  return runQuery('deleteBatchCheckRecord', async (activeDb) => {
    const deleted = await activeDb
      .delete(batchCheckRecords)
      .where(and(eq(batchCheckRecords.ownerId, cleanOwner), eq(batchCheckRecords.id, cleanId)))
      .returning({ id: batchCheckRecords.id });
    return deleted.length > 0;
  });
}

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AuditLogInsert = typeof auditLogs.$inferInsert;

export async function listAuditLogs(ownerId: string): Promise<AuditLogRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listAuditLogs', (activeDb) =>
    activeDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.ownerId, cleanOwner))
      .orderBy(desc(auditLogs.createdAt))
  );
}

export async function createAuditLog(
  input: Omit<AuditLogInsert, 'id'> & { id?: string }
): Promise<AuditLogRow> {
  const id = input.id?.trim() || `AUD-${crypto.randomUUID()}`;
  return runQuery('createAuditLog', async (activeDb) => {
    const [row] = await activeDb
      .insert(auditLogs)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

// ---------------------------------------------------------------------------
// Sensor Maintenance Logs CRUD
// ---------------------------------------------------------------------------

export type SensorMaintenanceLogRow = typeof sensorMaintenanceLogs.$inferSelect;
export type SensorMaintenanceLogInsert = typeof sensorMaintenanceLogs.$inferInsert;

export async function listSensorMaintenanceLogs(
  ownerId: string,
  sensorId?: string
): Promise<SensorMaintenanceLogRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listSensorMaintenanceLogs', (activeDb) => {
    const condition = sensorId?.trim()
      ? and(
          eq(sensorMaintenanceLogs.ownerId, cleanOwner),
          eq(sensorMaintenanceLogs.sensorId, sensorId.trim())
        )
      : eq(sensorMaintenanceLogs.ownerId, cleanOwner);
    return activeDb
      .select()
      .from(sensorMaintenanceLogs)
      .where(condition)
      .orderBy(
        desc(sensorMaintenanceLogs.calibrationDate),
        desc(sensorMaintenanceLogs.createdAt)
      );
  });
}

export async function createSensorMaintenanceLog(
  input: Omit<SensorMaintenanceLogInsert, 'id'> & { id?: string }
): Promise<SensorMaintenanceLogRow> {
  const id = input.id?.trim() || `SML-${crypto.randomUUID()}`;
  return runQuery('createSensorMaintenanceLog', async (activeDb) => {
    const [row] = await activeDb
      .insert(sensorMaintenanceLogs)
      .values({ ...input, id })
      .returning();
    return row;
  });
}

export async function deleteSensorMaintenanceLog(
  ownerId: string,
  id: string
): Promise<boolean> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'maintenanceLogId');
  return runQuery('deleteSensorMaintenanceLog', async (activeDb) => {
    const deleted = await activeDb
      .delete(sensorMaintenanceLogs)
      .where(
        and(
          eq(sensorMaintenanceLogs.ownerId, cleanOwner),
          eq(sensorMaintenanceLogs.id, cleanId)
        )
      )
      .returning({ id: sensorMaintenanceLogs.id });
    return deleted.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Single-Record Lookups & Ordered Workspace Fetch
// ---------------------------------------------------------------------------

export async function getSensorById(ownerId: string, id: string): Promise<SensorRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'sensorId');
  return runQuery('getSensorById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(sensors)
      .where(and(eq(sensors.ownerId, cleanOwner), eq(sensors.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function getProductionLineById(
  ownerId: string,
  id: string
): Promise<ProductionLineRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'lineId');
  return runQuery('getProductionLineById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(productionLines)
      .where(and(eq(productionLines.ownerId, cleanOwner), eq(productionLines.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function getFinishedGoodById(
  ownerId: string,
  id: string
): Promise<FinishedGoodRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'finishedGoodId');
  return runQuery('getFinishedGoodById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(finishedGoods)
      .where(and(eq(finishedGoods.ownerId, cleanOwner), eq(finishedGoods.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function getBatchCheckSpecById(
  ownerId: string,
  id: string
): Promise<BatchCheckSpecRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'specId');
  return runQuery('getBatchCheckSpecById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(batchCheckSpecs)
      .where(and(eq(batchCheckSpecs.ownerId, cleanOwner), eq(batchCheckSpecs.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function getBatchCheckRecordById(
  ownerId: string,
  id: string
): Promise<BatchCheckRecordRow | null> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  const cleanId = assertNonEmptyId(id, 'recordId');
  return runQuery('getBatchCheckRecordById', async (activeDb) => {
    const rows = await activeDb
      .select()
      .from(batchCheckRecords)
      .where(and(eq(batchCheckRecords.ownerId, cleanOwner), eq(batchCheckRecords.id, cleanId)));
    return rows[0] ?? null;
  });
}

export async function listFormulasOrdered(ownerId: string): Promise<FormulaRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listFormulasOrdered', (activeDb) =>
    activeDb
      .select()
      .from(formulas)
      .where(eq(formulas.ownerId, cleanOwner))
      .orderBy(asc(formulas.sku), desc(formulas.version))
  );
}

export async function listRawMaterialsOrdered(ownerId: string): Promise<RawMaterialRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listRawMaterialsOrdered', (activeDb) =>
    activeDb
      .select()
      .from(rawMaterials)
      .where(eq(rawMaterials.ownerId, cleanOwner))
      .orderBy(asc(rawMaterials.materialCode))
  );
}

export async function listBatchesOrdered(ownerId: string): Promise<BatchRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listBatchesOrdered', (activeDb) =>
    activeDb
      .select()
      .from(batches)
      .where(eq(batches.ownerId, cleanOwner))
      .orderBy(desc(batches.batchNumber))
  );
}

export async function listFinishedGoodsOrdered(ownerId: string): Promise<FinishedGoodRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listFinishedGoodsOrdered', (activeDb) =>
    activeDb
      .select()
      .from(finishedGoods)
      .where(eq(finishedGoods.ownerId, cleanOwner))
      .orderBy(desc(finishedGoods.productionDate))
  );
}

export async function listSensorsOrdered(ownerId: string): Promise<SensorRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listSensorsOrdered', (activeDb) =>
    activeDb
      .select()
      .from(sensors)
      .where(eq(sensors.ownerId, cleanOwner))
      .orderBy(asc(sensors.sensorCode))
  );
}

export async function listBatchCheckSpecsOrdered(
  ownerId: string
): Promise<BatchCheckSpecRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listBatchCheckSpecsOrdered', (activeDb) =>
    activeDb
      .select()
      .from(batchCheckSpecs)
      .where(eq(batchCheckSpecs.ownerId, cleanOwner))
      .orderBy(desc(batchCheckSpecs.batchNumber))
  );
}

export async function listBatchCheckRecordsOrdered(
  ownerId: string
): Promise<BatchCheckRecordRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listBatchCheckRecordsOrdered', (activeDb) =>
    activeDb
      .select()
      .from(batchCheckRecords)
      .where(eq(batchCheckRecords.ownerId, cleanOwner))
      .orderBy(desc(batchCheckRecords.recordedAt), desc(batchCheckRecords.createdAt))
  );
}

export async function listProductionLinesOrdered(
  ownerId: string
): Promise<ProductionLineRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listProductionLinesOrdered', (activeDb) =>
    activeDb
      .select()
      .from(productionLines)
      .where(eq(productionLines.ownerId, cleanOwner))
      .orderBy(asc(productionLines.lineCode))
  );
}

export async function listRecentAuditLogs(
  ownerId: string,
  limitCount = 500
): Promise<AuditLogRow[]> {
  const cleanOwner = assertNonEmptyId(ownerId, 'ownerId');
  return runQuery('listRecentAuditLogs', (activeDb) =>
    activeDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.ownerId, cleanOwner))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limitCount)
  );
}
