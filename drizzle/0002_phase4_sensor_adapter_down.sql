-- Phase 4: Sensor Adapter & Optional WMS Connector Configuration (DOWN)
-- Cleanly reverses 0002_phase4_sensor_adapter_up.sql without affecting any batch/inventory data.

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "wms_config",
  DROP COLUMN IF EXISTS "sensor_config";
