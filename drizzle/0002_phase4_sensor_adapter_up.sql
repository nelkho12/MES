-- Phase 4: Sensor Adapter & Optional WMS Connector Configuration (UP)
-- Safe additive migration: both Sensor Master Switch and WMS REST Connector default to OFF (false).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "sensor_config" jsonb NOT NULL DEFAULT '{
    "masterEnabled": false,
    "adapterMode": "simulator",
    "perLineEnabled": {},
    "pollingIntervalSec": 5,
    "saveIntervalSec": 60,
    "gatewayUrl": "http://localhost:4100/api/readings",
    "backfillUrl": "",
    "mqttWsUrl": "ws://localhost:9001/mqtt",
    "mqttTopic": "mayralab/mes/+/readings",
    "offlineAlarmThresholdSec": 30,
    "autoBackfillOnOpen": true
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS "wms_config" jsonb NOT NULL DEFAULT '{
    "enabled": false,
    "baseUrl": "http://localhost:4200/api/wms",
    "rawMaterialsPath": "/raw-materials",
    "finishedGoodsPath": "/finished-goods",
    "timeoutMs": 8000,
    "autoPushFgOnQcPass": false,
    "lastSyncAt": ""
  }'::jsonb;
