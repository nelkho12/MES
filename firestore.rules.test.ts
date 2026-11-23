/**
 * Firestore Security Rules — Dirty Dozen Verification Suite Specification
 * Verifies all 12 adversarial payloads against the Eight Pillars in firestore.rules.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  collection: string;
  operation: 'create' | 'update' | 'get' | 'list' | 'delete';
  expected: 'PERMISSION_DENIED';
  payload: Record<string, unknown>;
  enforcingRule: string;
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Identity Spoofing on Create',
    collection: 'rawMaterials',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'other-user-uid', lotNumber: 'RM-999' },
    enforcingRule: 'isValidRawMaterialLot(incoming()) enforces incoming().ownerId == request.auth.uid',
  },
  {
    id: 2,
    name: 'Shadow Field Injection',
    collection: 'formulas',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { sku: 'SKU-01', isVerified: true },
    enforcingRule: 'data.keys().hasOnly([...]) rejects shadow keys',
  },
  {
    id: 3,
    name: 'ID Poisoning',
    collection: 'batches',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { docId: 'invalid!@#id$' + 'a'.repeat(140) },
    enforcingRule: 'isValidId(batchId) requires <= 128 chars matching ^[a-zA-Z0-9_\\-]+$',
  },
  {
    id: 4,
    name: 'Orphaned Batch Creation',
    collection: 'batches',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { formulaId: 'non-existent-formula-id' },
    enforcingRule: 'exists(/databases/$(database)/documents/formulas/$(incoming().formulaId))',
  },
  {
    id: 5,
    name: 'Terminal State Mutation on Closed Batch',
    collection: 'batches',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { goodQty: 9999 },
    enforcingRule: 'existing().status != "Closed" || isAdmin()',
  },
  {
    id: 6,
    name: 'Immutable Owner Tampering',
    collection: 'sensors',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { ownerId: 'attacker-uid' },
    enforcingRule: 'incoming().ownerId == existing().ownerId and affectedKeys().hasOnly(...)',
  },
  {
    id: 7,
    name: 'Timestamp Forgery',
    collection: 'rawMaterials',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { createdAt: '2020-01-01T00:00:00Z' },
    enforcingRule: 'incoming().createdAt == request.time && incoming().updatedAt == request.time',
  },
  {
    id: 8,
    name: 'Unbounded Array Exhaustion',
    collection: 'formulas',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { ingredients: Array.from({ length: 35 }, (_, i) => ({ code: `ING-${i}` })) },
    enforcingRule: 'data.ingredients is list && data.ingredients.size() <= 30',
  },
  {
    id: 9,
    name: 'Value Poisoning on Whitelisted Key',
    collection: 'sensors',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { currentTempC: 'HOT_STRING_INJECTION' },
    enforcingRule: 'isValidThermalSensor(incoming()) enforces data.currentTempC is number',
  },
  {
    id: 10,
    name: 'Email Spoofing Attack',
    collection: 'batches',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    payload: { authEmail: 'nelson.kho@mayralab.com', emailVerified: false },
    enforcingRule: 'isBootstrappedAdmin() mandates request.auth.token.email_verified == true',
  },
  {
    id: 11,
    name: 'Cross-Tenant List Scraping',
    collection: 'batches',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    payload: { query: 'unfiltered collection scan' },
    enforcingRule: 'allow list: if isVerifiedUser() && (resource.data.ownerId == request.auth.uid || isBootstrappedAdmin())',
  },
  {
    id: 12,
    name: 'Privilege Escalation',
    collection: 'admins',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { role: 'admin' },
    enforcingRule: 'admins match blocks all client writes; users role restricted to manager|operator|qc',
  },
];
