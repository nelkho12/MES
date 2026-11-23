-- Migration 0004 (DOWN): drop unique batch / lot number indexes (renamed -Dn rows are not reverted).

DROP INDEX IF EXISTS "batches_owner_batch_number_uq";
DROP INDEX IF EXISTS "batches_owner_lot_number_uq";
