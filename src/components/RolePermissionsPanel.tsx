import { useState } from 'react';
import { Check, Lock, RotateCcw, ShieldCheck } from 'lucide-react';
import type { MesFeatureKey, RolePermissionMatrix, UserRole } from '../types';
import {
  ALL_USER_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  MES_FEATURE_DEFINITIONS,
  ROLE_LABELS,
  countEnabledFeatures,
  hasFeaturePermission,
  sanitizeRolePermissionMatrix,
} from '../services/permissions';
import { updateRolePermissions } from '../services/mesService';

interface RolePermissionsPanelProps {
  activeRole: UserRole;
  rolePermissions?: RolePermissionMatrix;
  onNotify: (msg: string) => void;
}

export function RolePermissionsPanel({
  activeRole,
  rolePermissions,
  onNotify,
}: RolePermissionsPanelProps) {
  const [draft, setDraft] = useState<RolePermissionMatrix>(() =>
    sanitizeRolePermissionMatrix(rolePermissions)
  );
  const [busy, setBusy] = useState(false);

  const canManageMatrix = hasFeaturePermission(
    rolePermissions,
    activeRole,
    'manageRolesAccess'
  );

  function toggleTick(role: UserRole, feature: MesFeatureKey) {
    if (!canManageMatrix) {
      onNotify(
        `Role "${ROLE_LABELS[activeRole]}" does not have Control Role Permission Matrix enabled.`
      );
      return;
    }
    if (role === 'admin' && feature === 'manageRolesAccess') {
      return; // Prevent admin lockout
    }
    setDraft((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        [feature]: !prev[role][feature],
      },
    }));
  }

  function handleResetDefaults() {
    if (!canManageMatrix) return;
    setDraft(sanitizeRolePermissionMatrix(DEFAULT_ROLE_PERMISSIONS));
    onNotify('Reset draft role control ticks to factory defaults (click Save to persist).');
  }

  async function handleSave() {
    if (!canManageMatrix) return;
    setBusy(true);
    try {
      await updateRolePermissions(draft);
      onNotify('Saved active role control permissions & recorded audit trail entry.');
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Unable to save role permission matrix.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg border border-slate-200 bg-[#F7F8FA] flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-700" />
            Active Role View &amp; Control Level by Feature (Tick Matrix)
          </div>
          <p className="text-xs text-slate-600 mt-0.5">
            Tick features to grant or revoke MES capabilities per role. Active Role:{' '}
            <strong className="text-teal-800">{ROLE_LABELS[activeRole]}</strong> (
            {countEnabledFeatures(draft, activeRole)}/{MES_FEATURE_DEFINITIONS.length} enabled).
          </p>
        </div>
        {!canManageMatrix && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-md">
            <Lock className="w-3.5 h-3.5" />
            Read-only for {ROLE_LABELS[activeRole]} (switch to Manager/Admin to edit ticks)
          </span>
        )}
      </div>

      {/* Role summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        {ALL_USER_ROLES.map((r) => {
          const isCurrent = r === activeRole;
          const count = countEnabledFeatures(draft, r);
          return (
            <div
              key={r}
              className={`rounded-lg border p-3 ${
                isCurrent
                  ? 'border-teal-600 bg-teal-50/70'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-semibold text-slate-900">
                  {ROLE_LABELS[r]}
                </span>
                {isCurrent && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-700 text-white">
                    ACTIVE
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-xs text-slate-600">
                {count} / {MES_FEATURE_DEFINITIONS.length} features
              </div>
            </div>
          );
        })}
      </div>

      {/* Tick Permission Matrix */}
      <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-600">
              <th className="py-3 px-4 font-semibold min-w-[240px]">MES Control Feature</th>
              {ALL_USER_ROLES.map((role) => (
                <th
                  key={role}
                  className={`py-3 px-3 text-center font-semibold min-w-[96px] ${
                    role === activeRole ? 'text-teal-800 bg-teal-50/60' : ''
                  }`}
                >
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {MES_FEATURE_DEFINITIONS.map((feat) => (
              <tr key={feat.key} className="hover:bg-slate-50/70">
                <td className="py-3 px-4">
                  <div className="font-medium text-slate-900">{feat.label}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {feat.description}
                  </div>
                </td>
                {ALL_USER_ROLES.map((role) => {
                  const checked = draft[role]?.[feat.key] ?? false;
                  const lockedAdminSelf =
                    role === 'admin' && feat.key === 'manageRolesAccess';
                  return (
                    <td
                      key={role}
                      className={`py-3 px-3 text-center ${
                        role === activeRole ? 'bg-teal-50/30' : ''
                      }`}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`${ROLE_LABELS[role]} - ${feat.label}`}
                        disabled={!canManageMatrix || lockedAdminSelf}
                        onClick={() => toggleTick(role, feat.key)}
                        className={`w-9 h-9 mx-auto rounded-md border flex items-center justify-center transition-colors ${
                          checked
                            ? 'bg-teal-700 border-teal-700 text-white'
                            : 'bg-white border-slate-300 text-slate-300 hover:border-teal-500'
                        } ${
                          !canManageMatrix || lockedAdminSelf
                            ? 'opacity-65 cursor-not-allowed'
                            : 'cursor-pointer'
                        }`}
                      >
                        {checked ? <Check className="w-4 h-4 stroke-[2.5]" /> : null}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <button
          type="button"
          disabled={!canManageMatrix || busy}
          onClick={handleResetDefaults}
          className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md disabled:opacity-50"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset to Defaults
        </button>
        <button
          type="button"
          disabled={!canManageMatrix || busy}
          onClick={() => void handleSave()}
          className="min-h-[42px] px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
        >
          {busy ? 'Saving...' : 'Save Role Control Permissions'}
        </button>
      </div>
    </div>
  );
}
