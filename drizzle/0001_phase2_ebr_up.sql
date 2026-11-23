-- Phase 2: Electronic Batch Production Record (EBR) — Safe Additive Migration (UP)
-- Preserves all existing tables, rows, and JSONB data.

-- 1. Formulas: recipe-defined target / min / max process parameters
ALTER TABLE "formulas"
  ADD COLUMN IF NOT EXISTS "process_parameters" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. Raw Materials: track allocated stock alongside available stock
ALTER TABLE "raw_materials"
  ADD COLUMN IF NOT EXISTS "quantity_allocated" double precision NOT NULL DEFAULT 0;

-- 3. Batches: EBR Header, Material Allocations, Output Mass & Loss Reason Codes, QC & Retained Samples
ALTER TABLE "batches"
  ADD COLUMN IF NOT EXISTS "pack_size" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "equipment_name" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "shift" text NOT NULL DEFAULT 'Shift A (Day)',
  ADD COLUMN IF NOT EXISTS "planned_start_at" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "planned_end_at" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "actual_start_at" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "actual_end_at" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "operators" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "allocated_materials" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "by_product_qty" double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "output_mass_qty" double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "output_mass_unit" text NOT NULL DEFAULT 'kg',
  ADD COLUMN IF NOT EXISTS "loss_reason_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "retained_sample_qty" double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "retained_sample_code" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "retained_sample_location" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "qc_in_process_summary" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "qc_final_results" text NOT NULL DEFAULT '';

-- 4. Immutable Audit Trail Table (who, what, old value, new value, when)
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "users"("uid") ON DELETE CASCADE,
  "actor_uid" text NOT NULL,
  "actor_email" text NOT NULL,
  "actor_name" text NOT NULL,
  "actor_role" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "batch_id" text NOT NULL DEFAULT '',
  "old_value" jsonb,
  "new_value" jsonb,
  "reason" text NOT NULL DEFAULT '',
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_audit_logs_owner_batch"
  ON "audit_logs" ("owner_id", "batch_id", "created_at" DESC);
