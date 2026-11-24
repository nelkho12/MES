import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import type {
  DbConnectionConfigInput,
  DbConnectionConfigPublic,
  DbConnectionMode,
  DbConnectionTestResult,
} from '../types.ts';

export interface StoredDbConnectionConfig {
  mode: DbConnectionMode;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  updatedAt?: string;
}

export function resolveDbConfigFilePath(): string {
  const explicit = process.env.KETTLER_DB_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(process.cwd(), '.kettler-db-config.json');
}

function parseEnvPort(): number {
  const parsed = Number(process.env.SQL_PORT);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return 5432;
}

function parseEnvSsl(): boolean {
  const raw = (process.env.SQL_SSL || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'require';
}

export function getEnvDbConnectionConfig(): StoredDbConnectionConfig {
  return {
    mode: 'env',
    host: (process.env.SQL_HOST || '127.0.0.1').trim(),
    port: parseEnvPort(),
    database: (process.env.SQL_DB_NAME || 'kettler_mes').trim(),
    user: (process.env.SQL_USER || 'postgres').trim(),
    password: process.env.SQL_PASSWORD || '',
    ssl: parseEnvSsl(),
  };
}

export function readOverrideDbConnectionConfig(): StoredDbConnectionConfig | null {
  const filePath = resolveDbConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredDbConnectionConfig>;
    if (!parsed || parsed.mode !== 'remote_ip') return null;
    const host = typeof parsed.host === 'string' ? parsed.host.trim() : '';
    const database = typeof parsed.database === 'string' ? parsed.database.trim() : '';
    const user = typeof parsed.user === 'string' ? parsed.user.trim() : '';
    const port =
      typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535
        ? parsed.port
        : 5432;
    if (!host || !database || !user) return null;
    return {
      mode: 'remote_ip',
      host,
      port,
      database,
      user,
      password: typeof parsed.password === 'string' ? parsed.password : '',
      ssl: Boolean(parsed.ssl),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function getActiveDbConnectionConfig(): StoredDbConnectionConfig {
  const override = readOverrideDbConnectionConfig();
  if (override) {
    return override;
  }
  return getEnvDbConnectionConfig();
}

export function buildPgPoolConfig(cfg: StoredDbConnectionConfig): PoolConfig {
  const isUnixSocket = cfg.host.startsWith('/');
  const poolConfig: PoolConfig = {
    host: cfg.host,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 10,
    connectionTimeoutMillis: 15000,
  };

  if (!isUnixSocket) {
    poolConfig.port = cfg.port || 5432;
    if (cfg.ssl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  }

  return poolConfig;
}

export function maskHostLabel(cfg: StoredDbConnectionConfig): string {
  if (!cfg.host) return 'Not configured';
  if (cfg.host.startsWith('/')) {
    return 'Managed PostgreSQL Socket';
  }
  return `${cfg.host}:${cfg.port || 5432}/${cfg.database}`;
}

export function getPublicDbConnectionConfig(): DbConnectionConfigPublic {
  const override = readOverrideDbConnectionConfig();
  const active = override ?? getEnvDbConnectionConfig();
  const isSocket = active.host.startsWith('/');
  return {
    mode: active.mode,
    host: isSocket ? '' : active.host,
    port: active.port || 5432,
    database: active.database,
    user: active.user,
    ssl: active.ssl,
    hasPassword: Boolean(active.password),
    configuredViaOverride: Boolean(override),
    activeHostLabel: maskHostLabel(active),
    configPathLabel: path.basename(resolveDbConfigFilePath()),
  };
}

export function validateRemoteIpDbInput(
  input: Partial<DbConnectionConfigInput>,
  existingPassword?: string
): StoredDbConnectionConfig {
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const database = typeof input.database === 'string' ? input.database.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const port = Number(input.port ?? 5432);
  const password =
    typeof input.password === 'string' && input.password.length > 0
      ? input.password
      : existingPassword || '';

  if (!host) {
    throw new Error('PostgreSQL IP address or hostname is required (e.g., 192.168.1.50).');
  }
  if (/[\s/\\]/.test(host)) {
    throw new Error('Enter a valid IPv4/IPv6 address or hostname without spaces or slashes.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PostgreSQL port must be an integer between 1 and 65535 (default 5432).');
  }
  if (!database) {
    throw new Error('Database name is required (e.g., kettler_mes).');
  }
  if (!user) {
    throw new Error('SQL username is required (e.g., postgres or kettler_app).');
  }

  return {
    mode: 'remote_ip',
    host,
    port,
    database,
    user,
    password,
    ssl: Boolean(input.ssl),
    updatedAt: new Date().toISOString(),
  };
}

export function saveOverrideDbConnectionConfig(cfg: StoredDbConnectionConfig): void {
  const filePath = resolveDbConfigFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function clearOverrideDbConnectionConfig(): void {
  const filePath = resolveDbConfigFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export async function testSqlConnection(
  cfg: StoredDbConnectionConfig
): Promise<DbConnectionTestResult> {
  const startedAt = Date.now();
  const testPool = new Pool({
    ...buildPgPoolConfig(cfg),
    max: 2,
    connectionTimeoutMillis: 8000,
  });

  try {
    const infoRes = await testPool.query<{
      version: string;
      database_name: string;
      server_ip: string | null;
      server_port: number | null;
    }>(
      `SELECT version() AS version, current_database() AS database_name, inet_server_addr()::text AS server_ip, inet_server_port() AS server_port`
    );
    const tablesRes = await testPool.query<{ table_count: string }>(
      `SELECT count(*)::text AS table_count FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const row = infoRes.rows[0];
    const tableCount = Number(tablesRes.rows[0]?.table_count ?? 0);
    const latencyMs = Date.now() - startedAt;

    return {
      ok: true,
      message: `Connected to PostgreSQL (${row?.database_name || cfg.database}) in ${latencyMs} ms. ${tableCount} public table(s) detected.`,
      serverVersion: row?.version?.split(',')[0] || 'PostgreSQL',
      database: row?.database_name || cfg.database,
      serverIp: row?.server_ip ?? cfg.host,
      serverPort: row?.server_port ?? cfg.port,
      tableCount,
      latencyMs,
    };
  } catch (error: unknown) {
    const rawMsg = error instanceof Error ? error.message : 'Unable to connect to PostgreSQL server.';
    return {
      ok: false,
      message: rawMsg,
    };
  } finally {
    await testPool.end().catch(() => {});
  }
}

const BOOTSTRAP_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "users" (
    "uid" text PRIMARY KEY NOT NULL,
    "email" text NOT NULL,
    "display_name" text NOT NULL,
    "password_hash" text,
    "role" text DEFAULT 'manager' NOT NULL,
    "plant_name" text DEFAULT 'Kettler Processing Facility · Plant 01' NOT NULL,
    "product_categories" jsonb DEFAULT '["Sauce","Syrup","Powder"]'::jsonb NOT NULL,
    "operational_statuses" jsonb DEFAULT '["Active","Standby","CIP Cleaning","Maintenance"]'::jsonb NOT NULL,
    "role_permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "category_parameter_presets" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "sensor_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "wms_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;`,
  `CREATE TABLE IF NOT EXISTS "formulas" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "sku" text NOT NULL,
    "product_name" text NOT NULL,
    "category" text DEFAULT 'Sauce' NOT NULL,
    "pack_size" text NOT NULL,
    "shelf_life_days" integer NOT NULL,
    "standard_batch_size" double precision NOT NULL,
    "output_unit" text NOT NULL,
    "version" text NOT NULL,
    "approval_status" text DEFAULT 'Draft' NOT NULL,
    "is_confidential_oem" boolean DEFAULT false NOT NULL,
    "oem_customer" text DEFAULT '' NOT NULL,
    "labor_cost_per_batch" double precision DEFAULT 0 NOT NULL,
    "overhead_cost_per_batch" double precision DEFAULT 0 NOT NULL,
    "ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "routing_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "process_parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "raw_materials" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "lot_number" text NOT NULL,
    "material_code" text NOT NULL,
    "material_name" text NOT NULL,
    "category" text NOT NULL,
    "unit" text NOT NULL,
    "quantity_initial" double precision NOT NULL,
    "quantity_available" double precision NOT NULL,
    "quantity_allocated" double precision DEFAULT 0 NOT NULL,
    "reorder_level" double precision NOT NULL,
    "unit_cost" double precision NOT NULL,
    "supplier" text NOT NULL,
    "expiry_date" text NOT NULL,
    "storage_zone" text NOT NULL,
    "status" text DEFAULT 'Available' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "batches" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "batch_number" text NOT NULL,
    "lot_number" text DEFAULT '' NOT NULL,
    "formula_id" text NOT NULL REFERENCES "formulas"("id"),
    "formula_version" text NOT NULL,
    "sku" text NOT NULL,
    "product_name" text NOT NULL,
    "pack_size" text DEFAULT '' NOT NULL,
    "source_type" text NOT NULL,
    "source_ref" text DEFAULT '' NOT NULL,
    "planned_qty" double precision NOT NULL,
    "output_unit" text NOT NULL,
    "planned_date" text NOT NULL,
    "line_name" text NOT NULL,
    "equipment_name" text DEFAULT '' NOT NULL,
    "assigned_team" text NOT NULL,
    "shift" text DEFAULT 'Shift A (Day)' NOT NULL,
    "planned_start_at" text DEFAULT '' NOT NULL,
    "planned_end_at" text DEFAULT '' NOT NULL,
    "actual_start_at" text DEFAULT '' NOT NULL,
    "actual_end_at" text DEFAULT '' NOT NULL,
    "operators" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "status" text DEFAULT 'Planned' NOT NULL,
    "availability_checked" boolean DEFAULT false NOT NULL,
    "shortage_count" integer DEFAULT 0 NOT NULL,
    "allocated_materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "issued_materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "process_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "good_qty" double precision DEFAULT 0 NOT NULL,
    "rejected_qty" double precision DEFAULT 0 NOT NULL,
    "sample_qty" double precision DEFAULT 0 NOT NULL,
    "rework_qty" double precision DEFAULT 0 NOT NULL,
    "by_product_qty" double precision DEFAULT 0 NOT NULL,
    "waste_kg" double precision DEFAULT 0 NOT NULL,
    "output_mass_qty" double precision DEFAULT 0 NOT NULL,
    "output_mass_unit" text DEFAULT 'kg' NOT NULL,
    "loss_reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "yield_pct" double precision DEFAULT 0 NOT NULL,
    "variance_pct" double precision DEFAULT 0 NOT NULL,
    "material_cost" double precision DEFAULT 0 NOT NULL,
    "labor_cost" double precision DEFAULT 0 NOT NULL,
    "overhead_cost" double precision DEFAULT 0 NOT NULL,
    "unit_cost" double precision DEFAULT 0 NOT NULL,
    "qc_status" text DEFAULT 'Pending' NOT NULL,
    "qc_notes" text DEFAULT '' NOT NULL,
    "qc_inspector" text DEFAULT '' NOT NULL,
    "retained_sample_qty" double precision DEFAULT 0 NOT NULL,
    "retained_sample_code" text DEFAULT '' NOT NULL,
    "retained_sample_location" text DEFAULT '' NOT NULL,
    "qc_in_process_summary" text DEFAULT '' NOT NULL,
    "qc_final_results" text DEFAULT '' NOT NULL,
    "posted_to_inventory" boolean DEFAULT false NOT NULL,
    "finished_good_id" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "finished_goods" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "batch_id" text NOT NULL REFERENCES "batches"("id"),
    "batch_number" text NOT NULL,
    "lot_number" text NOT NULL,
    "sku" text NOT NULL,
    "product_name" text NOT NULL,
    "quantity_produced" double precision NOT NULL,
    "quantity_available" double precision NOT NULL,
    "unit" text NOT NULL,
    "production_date" text NOT NULL,
    "expiry_date" text NOT NULL,
    "qc_status" text DEFAULT 'Released' NOT NULL,
    "warehouse_zone" text NOT NULL,
    "unit_cost" double precision DEFAULT 0 NOT NULL,
    "shipments" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "sensors" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "sensor_code" text NOT NULL,
    "name" text NOT NULL,
    "zone" text NOT NULL,
    "equipment_type" text NOT NULL,
    "linked_line" text DEFAULT '' NOT NULL,
    "current_temp_c" double precision NOT NULL,
    "target_temp_c" double precision NOT NULL,
    "min_safe_temp_c" double precision NOT NULL,
    "max_safe_temp_c" double precision NOT NULL,
    "humidity_pct" integer DEFAULT 60 NOT NULL,
    "status" text DEFAULT 'Nominal' NOT NULL,
    "yield_impact_note" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "sensor_maintenance_logs" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "sensor_id" text NOT NULL REFERENCES "sensors"("id") ON DELETE cascade,
    "sensor_code" text NOT NULL,
    "maintenance_type" text DEFAULT 'Calibration' NOT NULL,
    "calibration_date" text NOT NULL,
    "next_calibration_due" text NOT NULL,
    "offset_adjustment_c" double precision DEFAULT 0 NOT NULL,
    "as_found_temp_c" double precision,
    "as_left_temp_c" double precision,
    "verification_result" text DEFAULT 'Pass' NOT NULL,
    "technician_name" text NOT NULL,
    "notes" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "batch_check_specs" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "batch_id" text DEFAULT '' NOT NULL,
    "batch_number" text NOT NULL,
    "product_name" text NOT NULL,
    "product_category" text DEFAULT 'Sauce' NOT NULL,
    "ph_min" double precision,
    "ph_max" double precision,
    "aw_min" double precision,
    "aw_max" double precision,
    "brix_min" double precision,
    "brix_max" double precision,
    "additional_params" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "requirement_notes" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "batch_check_records" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "spec_id" text NOT NULL REFERENCES "batch_check_specs"("id") ON DELETE cascade,
    "batch_number" text NOT NULL,
    "product_category" text NOT NULL,
    "sampling_stage" text DEFAULT 'In-Process' NOT NULL,
    "measured_ph" double precision,
    "measured_aw" double precision,
    "measured_brix" double precision,
    "ph_readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "aw_readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "brix_readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "additional_readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "condition_status" text DEFAULT 'In Spec' NOT NULL,
    "inspector_name" text NOT NULL,
    "recorded_at" text NOT NULL,
    "notes" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "production_lines" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "line_code" text NOT NULL,
    "line_name" text NOT NULL,
    "machine_name" text NOT NULL,
    "machine_model" text DEFAULT '' NOT NULL,
    "category" text DEFAULT 'Thermal Kettle' NOT NULL,
    "supported_product_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "status" text DEFAULT 'Active' NOT NULL,
    "batch_capacity" double precision DEFAULT 500 NOT NULL,
    "capacity_unit" text DEFAULT 'kg' NOT NULL,
    "target_temp_c" double precision,
    "agitator_rpm" integer,
    "pressure_bar" double precision,
    "filler_speed_units_per_min" integer,
    "cleaning_interval_hours" integer DEFAULT 8 NOT NULL,
    "default_crew" text DEFAULT '' NOT NULL,
    "linked_sensor_code" text DEFAULT '' NOT NULL,
    "custom_settings" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "notes" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" text PRIMARY KEY NOT NULL,
    "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE cascade,
    "actor_uid" text NOT NULL,
    "actor_email" text NOT NULL,
    "actor_name" text NOT NULL,
    "actor_role" text NOT NULL,
    "action" text NOT NULL,
    "entity_type" text NOT NULL,
    "entity_id" text NOT NULL,
    "batch_id" text DEFAULT '' NOT NULL,
    "old_value" jsonb,
    "new_value" jsonb,
    "reason" text DEFAULT '' NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
  );`,
];

export async function ensureRemoteSqlSchemaApplied(cfg: StoredDbConnectionConfig): Promise<void> {
  const initPool = new Pool({
    ...buildPgPoolConfig(cfg),
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    for (const stmt of BOOTSTRAP_STATEMENTS) {
      await initPool.query(stmt);
    }
  } finally {
    await initPool.end().catch(() => {});
  }
}
