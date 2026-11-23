-- Phase 2: Electronic Batch Production Record (EBR) — Safe Rollback Migration (DOWN)
-- Reverses 0001_phase2_ebr_up.sql without touching pre-existing MES columns or data.

DROP INDEX IF EXISTS "idx_audit_logs_owner_batch";
DROP TABLE IF EXISTS "audit_logs";

ALTER TABLE "batches"
  DROP COLUMN IF EXISTS "qc_final_results",
  DROP COLUMN IF EXISTS "qc_in_process_summary",
  DROP COLUMN IF EXISTS "retained_sample_location",
  DROP COLUMN IF EXISTS "retained_sample_code",
  DROP COLUMN IF EXISTS "retained_sample_qty",
  DROP COLUMN IF EXISTS "loss_reason_codes",
  DROP COLUMN IF EXISTS "output_mass_unit",
  DROP COLUMN IF EXISTS "output_mass_qty",
  DROP COLUMN IF EXISTS "by_product_qty",
  DROP COLUMN IF EXISTS "allocated_materials",
  DROP COLUMN IF EXISTS "operators",
  DROP COLUMN IF EXISTS "actual_end_at",
  DROP COLUMN IF EXISTS "actual_start_at",
  DROP COLUMN IF EXISTS "planned_end_at",
  DROP COLUMN IF EXISTS "planned_start_at",
  DROP COLUMN IF EXISTS "shift",
  DROP COLUMN IF EXISTS "equipment_name",
  DROP COLUMN IF EXISTS "pack_size";

ALTER TABLE "raw_materials"
  DROP COLUMN IF EXISTS "quantity_allocated";

ALTER TABLE "formulas"
  DROP COLUMN IF EXISTS "process_parameters";
