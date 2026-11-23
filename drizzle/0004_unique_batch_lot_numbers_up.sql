-- Migration 0004 (UP): enforce unique batch / lot numbers per owner.
-- Existing duplicates (possible with the old count-based numbering) are renamed first
-- by appending -D2, -D3 ... to the later rows, so the unique indexes can be created.

WITH ranked AS (
  SELECT id, batch_number,
         ROW_NUMBER() OVER (PARTITION BY owner_id, batch_number ORDER BY created_at, id) AS rn
  FROM "batches"
)
UPDATE "batches" b
SET batch_number = b.batch_number || '-D' || r.rn
FROM ranked r
WHERE b.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT id, lot_number,
         ROW_NUMBER() OVER (PARTITION BY owner_id, lot_number ORDER BY created_at, id) AS rn
  FROM "batches"
  WHERE lot_number <> ''
)
UPDATE "batches" b
SET lot_number = b.lot_number || '-D' || r.rn
FROM ranked r
WHERE b.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "batches_owner_batch_number_uq"
  ON "batches" ("owner_id", "batch_number");

CREATE UNIQUE INDEX IF NOT EXISTS "batches_owner_lot_number_uq"
  ON "batches" ("owner_id", "lot_number")
  WHERE "lot_number" <> '';
