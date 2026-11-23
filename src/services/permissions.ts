import type {
  MesFeatureKey,
  RolePermissionMatrix,
  UserRole,
} from '../types';

export interface MesFeatureDefinition {
  key: MesFeatureKey;
  label: string;
  description: string;
}

export const ALL_USER_ROLES: UserRole[] = [
  'operator',
  'supervisor',
  'qc',
  'manager',
  'admin',
];

export const ROLE_LABELS: Record<UserRole, string> = {
  operator: 'Operator',
  supervisor: 'Supervisor',
  qc: 'QC Inspector',
  manager: 'Manager',
  admin: 'Admin',
};

export const MES_FEATURE_DEFINITIONS: MesFeatureDefinition[] = [
  {
    key: 'viewConfidentialOem',
    label: 'View Confidential OEM Recipes',
    description: 'Reveal proprietary ingredient names & vendor formulations (untick to mask/anonymize).',
  },
  {
    key: 'manageFormulasBom',
    label: 'Manage BOM, Categories & Parameters',
    description: 'Create/approve formula versions, select preset categories, and edit parameter specs.',
  },
  {
    key: 'planReleaseJobOrders',
    label: 'Plan & Release Job Orders',
    description: 'Create new job orders and release production batches to the floor.',
  },
  {
    key: 'executeBatchSteps',
    label: 'Execute Batch Steps & Readings',
    description: 'Issue material lots, record manual Step 5 process readings, and log batch output.',
  },
  {
    key: 'qcSignOff',
    label: 'QC Review & Release Sign-Off',
    description: 'Execute Pass / Hold / Reject QC decisions and post Finished Goods.',
  },
  {
    key: 'overrideClosedBatch',
    label: 'Override Locked Closed Batches',
    description: 'Authorize audited modifications on Closed batches.',
  },
  {
    key: 'manageInventoryWms',
    label: 'Manage Inventory & WMS Settings',
    description: 'Configure WMS REST URL, adjust lots, and run WMS stock imports.',
  },
  {
    key: 'configureSensors',
    label: 'Configure Sensor Adapter',
    description: 'Toggle Sensor Master Switch, gateway URLs, MQTT topics, and per-line feeds.',
  },
  {
    key: 'manageRolesAccess',
    label: 'Control Role Permission Matrix',
    description: 'Modify active role tick permissions across MES features.',
  },
];

export const DEFAULT_ROLE_PERMISSIONS: RolePermissionMatrix = {
  operator: {
    viewConfidentialOem: false,
    manageFormulasBom: false,
    planReleaseJobOrders: true,
    executeBatchSteps: true,
    qcSignOff: false,
    overrideClosedBatch: false,
    manageInventoryWms: false,
    configureSensors: false,
    manageRolesAccess: false,
  },
  supervisor: {
    viewConfidentialOem: true,
    manageFormulasBom: true,
    planReleaseJobOrders: true,
    executeBatchSteps: true,
    qcSignOff: true,
    overrideClosedBatch: true,
    manageInventoryWms: true,
    configureSensors: true,
    manageRolesAccess: false,
  },
  qc: {
    viewConfidentialOem: true,
    manageFormulasBom: false,
    planReleaseJobOrders: false,
    executeBatchSteps: true,
    qcSignOff: true,
    overrideClosedBatch: false,
    manageInventoryWms: false,
    configureSensors: false,
    manageRolesAccess: false,
  },
  manager: {
    viewConfidentialOem: true,
    manageFormulasBom: true,
    planReleaseJobOrders: true,
    executeBatchSteps: true,
    qcSignOff: true,
    overrideClosedBatch: true,
    manageInventoryWms: true,
    configureSensors: true,
    manageRolesAccess: true,
  },
  admin: {
    viewConfidentialOem: true,
    manageFormulasBom: true,
    planReleaseJobOrders: true,
    executeBatchSteps: true,
    qcSignOff: true,
    overrideClosedBatch: true,
    manageInventoryWms: true,
    configureSensors: true,
    manageRolesAccess: true,
  },
};

export function sanitizeRolePermissionMatrix(raw: unknown): RolePermissionMatrix {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = {} as RolePermissionMatrix;

  for (const role of ALL_USER_ROLES) {
    const defaults = DEFAULT_ROLE_PERMISSIONS[role];
    const rawRole =
      src[role] && typeof src[role] === 'object'
        ? (src[role] as Record<string, unknown>)
        : {};
    const nextRole = {} as Record<MesFeatureKey, boolean>;
    for (const def of MES_FEATURE_DEFINITIONS) {
      nextRole[def.key] =
        typeof rawRole[def.key] === 'boolean'
          ? (rawRole[def.key] as boolean)
          : defaults[def.key];
    }
    // Safety invariant: Admin always retains role-matrix control so workspace cannot lock itself out
    if (role === 'admin') {
      nextRole.manageRolesAccess = true;
    }
    result[role] = nextRole;
  }

  return result;
}

export function hasFeaturePermission(
  matrix: RolePermissionMatrix | undefined | null,
  role: UserRole,
  feature: MesFeatureKey
): boolean {
  const resolved = matrix && matrix[role] ? matrix[role] : DEFAULT_ROLE_PERMISSIONS[role];
  if (!resolved) return DEFAULT_ROLE_PERMISSIONS.operator[feature];
  return typeof resolved[feature] === 'boolean'
    ? resolved[feature]
    : DEFAULT_ROLE_PERMISSIONS[role][feature];
}

export function countEnabledFeatures(
  matrix: RolePermissionMatrix | undefined | null,
  role: UserRole
): number {
  return MES_FEATURE_DEFINITIONS.filter((f) => hasFeaturePermission(matrix, role, f.key)).length;
}
