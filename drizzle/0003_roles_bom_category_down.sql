-- Migration 0003 (DOWN): Revert role_permissions, category_parameter_presets, and formula category columns

ALTER TABLE "formulas"
  DROP COLUMN IF EXISTS "category";

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "category_parameter_presets",
  DROP COLUMN IF EXISTS "role_permissions";
