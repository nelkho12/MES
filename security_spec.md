# Kettler MES — Firestore Security Specification

## 1. Data Invariants
1. **Strict Ownership Isolation**: Every manufacturing document (`formulas`, `rawMaterials`, `batches`, `finishedGoods`, `sensors`) carries an immutable `ownerId` matching the creating authenticated user's UID (`request.auth.uid`). List queries enforce `resource.data.ownerId == request.auth.uid || isBootstrappedAdmin()` with zero `get()` lookups.
2. **Verified Identity & Anti-Escalation**: All writes require `request.auth != null && request.auth.token.email_verified == true`. Users cannot write to `/admins/{uid}` or escalate privileges.
3. **Referential Integrity**: Creating a `ProductionBatch` requires `exists(/databases/$(database)/documents/formulas/$(incoming().formulaId))` owned by the caller. Creating a `FinishedGoodLot` requires `exists(/databases/$(database)/documents/batches/$(incoming().batchId))`.
4. **Terminal State Locking**: Once a `ProductionBatch` reaches `status == 'Closed'`, no further client mutations are allowed except by an explicit Admin override. Once a `FormulaBOM` reaches `approvalStatus == 'Archived'`, it is locked against modification.
5. **Temporal Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update. `updatedAt` must equal `request.time` on every creation and update.
6. **Bounded Arrays & Strict Key Allowlists**: All arrays (`ingredients <= 30`, `routingSteps <= 15`, `issuedMaterials <= 40`, `processChecks <= 20`, `shipments <= 25`) are strictly size-capped, every string has explicit `.size()` bounds, and every update branch uses `affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Identity Spoofing on Create**: User A attempts to create a `rawMaterials` lot with `ownerId: "user_B"`. -> Expected: `PERMISSION_DENIED`.
2. **Shadow Field Injection**: User creates a `formulas` doc including an unlisted key `isVerified: true`. -> Expected: `PERMISSION_DENIED`.
3. **ID Poisoning**: User attempts to create `/batches/{200_char_invalid_id!@#}` violating `isValidId()`. -> Expected: `PERMISSION_DENIED`.
4. **Orphaned Batch Creation**: User creates a `batches` doc referencing a non-existent `formulaId: "missing-formula"`. -> Expected: `PERMISSION_DENIED`.
5. **Terminal State Mutation**: Non-admin user attempts to modify `goodQty` on a `batches` doc where `existing().status == 'Closed'`. -> Expected: `PERMISSION_DENIED`.
6. **Immutable Owner Tampering**: User attempts to update `ownerId` on an existing `sensors` doc. -> Expected: `PERMISSION_DENIED`.
7. **Timestamp Forgery**: User submits a client-fabricated `createdAt` timestamp instead of `serverTimestamp()` (`request.time`). -> Expected: `PERMISSION_DENIED`.
8. **Unbounded Array Exhaustion**: User submits `ingredients` array with 35 elements (`> 30`). -> Expected: `PERMISSION_DENIED`.
9. **Value Poisoning on Whitelisted Key**: User updates `currentTempC` on a `sensors` doc with a string `"HOT"` instead of a number. -> Expected: `PERMISSION_DENIED`.
10. **Email Spoofing Attack**: Unverified account (`email_verified: false`) bearing admin email attempts write/read on another user's batch. -> Expected: `PERMISSION_DENIED`.
11. **Cross-Tenant List Scraping**: User A runs an unfiltered `list` query across `/batches` containing User B's records. -> Expected: `PERMISSION_DENIED`.
12. **Privilege Escalation**: User attempts to write their own UID into `/admins/{uid}` or set `role: "admin"` in `/users/{uid}`. -> Expected: `PERMISSION_DENIED`.
