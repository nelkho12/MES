import { type FormEvent, useEffect, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  ClipboardCheck,
  Database,
  KeyRound,
  Server,
  ShieldCheck,
  Thermometer,
  TrendingUp,
  UserPlus,
} from 'lucide-react';
import type { AuthStatusResponse, UserRole } from '../types';
import { fetchAuthStatus, loginWithSql, registerWithSql } from '../services/sqlAuthClient';
import { DesktopSqlModal } from './DesktopSqlModal';

export function AuthGate() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('manager');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [showDbModal, setShowDbModal] = useState(false);

  async function refreshStatus() {
    try {
      const status = await fetchAuthStatus();
      setAuthStatus(status);
      if (status.sqlUsersCount === 0 || !status.hasPasswordedUsers) {
        setMode('register');
      }
    } catch {
      // Keep default login form if status endpoint is temporarily unreachable
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorMsg('Please enter both your email address and SQL password.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'login') {
        await loginWithSql(trimmedEmail, password);
      } else {
        if (password.length < 6) {
          setErrorMsg('Password must be at least 6 characters.');
          setSubmitting(false);
          return;
        }
        await registerWithSql({
          email: trimmedEmail,
          password,
          displayName: displayName.trim() || undefined,
          role,
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-slate-900 flex flex-col">
      <header className="h-16 border-b border-slate-200 bg-white px-6 sm:px-8 flex items-center justify-between gap-4">
        <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          Manufacturing Execution System
        </span>
        <div className="hidden lg:flex items-center gap-6 text-sm text-slate-500">
          <span>Batch Execution</span>
          <span aria-hidden="true">·</span>
          <span>Lot Inventory</span>
          <span aria-hidden="true">·</span>
          <span>HACCP Telemetry</span>
          <span aria-hidden="true">·</span>
          <span>Yield Control</span>
        </div>
        <button
          type="button"
          onClick={() => setShowDbModal(true)}
          className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:border-teal-700 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <Server className="w-3.5 h-3.5 text-teal-700" />
          <span>SQL IP &amp; Desktop</span>
        </button>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-7 space-y-6">
          <p className="text-xs font-medium text-teal-800">
            Food Processing Manufacturing Execution System
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 leading-tight max-w-xl">
            Batch control, lot traceability, and real-time thermal yield optimization.
          </h1>
          <p className="text-base text-slate-600 leading-relaxed max-w-xl">
            Manage the complete 9-step production lifecycle from versioned BOM explosion and
            lot-deducted material issue to HACCP sensor monitoring, QC quarantine release, and
            automatic finished goods posting — persisted directly in PostgreSQL.
          </p>

          <div className="pt-2 grid grid-cols-1 sm:grid-cols-2 gap-6 border-t border-slate-200">
            <div className="flex items-start gap-3">
              <ClipboardCheck className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">9-Step Batch Lifecycle</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Plan, check BOM shortages, release lot numbers, issue stock, log checks, and
                  auto-post passed output.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Thermometer className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Live HACCP Sensors</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Monitor kettles, pasteurizers, blast chillers, and cold rooms with live safe-band
                  drift alerts.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Boxes className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Lot-Level Inventory</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Centralized kg/g/L/ml unit normalization with FEFO lot deduction and bidirectional
                  recall search.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <TrendingUp className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Direct SQL &amp; Desktop IP</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Run standalone on any desktop workstation and connect to your plant PostgreSQL
                  database by IP address.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="bg-white border border-slate-200 rounded-lg p-7 sm:p-8 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 text-slate-900">
                <ShieldCheck className="w-5 h-5 text-teal-700" />
                <h2 className="text-lg font-semibold">PostgreSQL Operator Sign-In</h2>
              </div>
              <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200">
                SQL Auth
              </span>
            </div>

            {authStatus && (
              <div className="mt-3 px-3 py-2 bg-[#F7F8FA] border border-slate-200 rounded-md flex items-center justify-between gap-2 text-[11px]">
                <span className="flex items-center gap-1.5 text-slate-600 min-w-0">
                  <Database className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                  <span className="font-mono truncate">{authStatus.dbConfig.activeHostLabel}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowDbModal(true)}
                  className="text-teal-700 hover:text-teal-800 font-semibold whitespace-nowrap shrink-0"
                >
                  Change IP
                </button>
              </div>
            )}

            {/* Mode Switcher */}
            <div className="mt-5 grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md border border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMsg('');
                }}
                className={`py-2 px-3 text-xs font-semibold rounded transition-colors flex items-center justify-center gap-1.5 ${
                  mode === 'login'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" />
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setErrorMsg('');
                }}
                className={`py-2 px-3 text-xs font-semibold rounded transition-colors flex items-center justify-center gap-1.5 ${
                  mode === 'register'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <UserPlus className="w-3.5 h-3.5" />
                Create SQL Account
              </button>
            </div>

            <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
              {mode === 'register' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Operator Name
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="e.g. Plant Manager"
                      className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Facility Role
                    </label>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as UserRole)}
                      className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 bg-white focus:outline-none focus:border-teal-700"
                    >
                      <option value="manager">Manager</option>
                      <option value="operator">Operator</option>
                      <option value="supervisor">Supervisor</option>
                      <option value="qc">QC Inspector</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@plant.local"
                  className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  SQL Password {mode === 'register' ? '(min 6 chars)' : ''}
                </label>
                <input
                  type="password"
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>

              {errorMsg && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
                  {errorMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
              >
                <span>
                  {submitting
                    ? mode === 'login'
                      ? 'Authenticating...'
                      : 'Provisioning SQL Workspace...'
                    : mode === 'login'
                      ? 'Sign in with PostgreSQL'
                      : 'Create Account & Launch MES'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
              Accounts, role permissions, BOMs, batches, and HACCP sensor logs are stored directly
              in your configured PostgreSQL database.
            </p>
          </div>
        </div>
      </main>

      {showDbModal && (
        <DesktopSqlModal
          currentUser={null}
          initialTab="sql"
          onClose={() => setShowDbModal(false)}
          onDatabaseSwitched={() => {
            void refreshStatus();
          }}
        />
      )}
    </div>
  );
}

