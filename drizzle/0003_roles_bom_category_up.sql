-- Migration 0003 (UP): Active role feature permissions matrix, BOM preset category, and editable per-category parameter presets

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "role_permissions" jsonb NOT NULL DEFAULT '{
    "operator": {"viewConfidentialOem": false, "manageFormulasBom": false, "planReleaseJobOrders": true, "executeBatchSteps": true, "qcSignOff": false, "overrideClosedBatch": false, "manageInventoryWms": false, "configureSensors": false, "manageRolesAccess": false},
    "supervisor": {"viewConfidentialOem": true, "manageFormulasBom": true, "planReleaseJobOrders": true, "executeBatchSteps": true, "qcSignOff": false, "overrideClosedBatch": true, "manageInventoryWms": true, "configureSensors": true, "manageRolesAccess": false},
    "qc": {"viewConfidentialOem": true, "manageFormulasBom": false, "planReleaseJobOrders": false, "executeBatchSteps": true, "qcSignOff": true, "overrideClosedBatch": false, "manageInventoryWms": false, "configureSensors": false, "manageRolesAccess": false},
    "manager": {"viewConfidentialOem": true, "manageFormulasBom": true, "planReleaseJobOrders": true, "executeBatchSteps": true, "qcSignOff": true, "overrideClosedBatch": true, "manageInventoryWms": true, "configureSensors": true, "manageRolesAccess": true},
    "admin": {"viewConfidentialOem": true, "manageFormulasBom": true, "planReleaseJobOrders": true, "executeBatchSteps": true, "qcSignOff": true, "overrideClosedBatch": true, "manageInventoryWms": true, "configureSensors": true, "manageRolesAccess": true}
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS "category_parameter_presets" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "formulas"
  ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT 'Sauce';

UPDATE "formulas"
SET "category" = 'Syrup'
WHERE ("sku" ILIKE '%GLZ%' OR "product_name" ILIKE '%syrup%' OR "product_name" ILIKE '%glaze%' OR "product_name" ILIKE '%nectar%')
  AND "category" = 'Sauce';
