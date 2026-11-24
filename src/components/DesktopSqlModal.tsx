import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  KeyRound,
  Monitor,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  DbConnectionConfigPublic,
  DbConnectionTestResult,
  SqlAuthUser,
} from '../types';
import {
  changeSqlPassword,
  fetchDbConnectionConfig,
  resetDbConnectionConfig,
  saveDbConnectionConfig,
  testDbConnection,
} from '../services/sqlAuthClient';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface DesktopSqlModalProps {
  currentUser: SqlAuthUser | null;
  initialTab?: 'sql' | 'desktop' | 'password';
  onClose: () => void;
  onDatabaseSwitched?: (config: DbConnectionConfigPublic) => void;
  onNotify?: (msg: string) => void;
}

export function DesktopSqlModal({
  currentUser,
  initialTab = 'sql',
  onClose,
  onDatabaseSwitched,
  onNotify,
}: DesktopSqlModalProps) {
  const [tab, setTab] = useState<'sql' | 'desktop' | 'password'>(initialTab);
  const [loadingCfg, setLoadingCfg] = useState(true);
  const [cfgError, setCfgError] = useState('');
  const [publicCfg, setPublicCfg] = useState<DbConnectionConfigPublic | null>(null);

  const [host, setHost] = useState('192.168.1.50');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('mes_db');
  const [sqlUser, setSqlUser] = useState('postgres');
  const [sqlPassword, setSqlPassword] = useState('');
  const [ssl, setSsl] = useState(false);
  const [initializeSchema, setInitializeSchema] = useState(true);

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<DbConnectionTestResult | null>(null);

  // SQL Account Password Form
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingCfg(true);
      setCfgError('');
      try {
        const cfg = await fetchDbConnectionConfig();
        if (cancelled) return;
        setPublicCfg(cfg);
        if (cfg.host) setHost(cfg.host);
        setPort(String(cfg.port || 5432));
        if (cfg.database) setDatabase(cfg.database);
        if (cfg.user) setSqlUser(cfg.user);
        setSsl(Boolean(cfg.ssl));
      } catch (err) {
        if (!cancelled) {
          setCfgError(
            err instanceof Error
              ? err.message
              : 'Unable to load SQL connection details. Admin/Manager or local desktop access is required.'
          );
        }
      } finally {
        if (!cancelled) setLoadingCfg(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    setCfgError('');
    try {
      const res = await testDbConnection({
        mode: 'remote_ip',
        host: host.trim(),
        port: Number(port) || 5432,
        database: database.trim(),
        user: sqlUser.trim(),
        password: sqlPassword,
        ssl,
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveAndConnect() {
    setSaving(true);
    setTestResult(null);
    setCfgError('');
    try {
      const res = await saveDbConnectionConfig({
        mode: 'remote_ip',
        host: host.trim(),
        port: Number(port) || 5432,
        database: database.trim(),
        user: sqlUser.trim(),
        password: sqlPassword,
        ssl,
        initializeSchema,
      });
      setPublicCfg(res.config);
      setTestResult(res.testResult);
      setSqlPassword('');
      onDatabaseSwitched?.(res.config);
      onNotify?.(`Connected to PostgreSQL at ${res.config.activeHostLabel}`);
    } catch (err) {
      setCfgError(err instanceof Error ? err.message : 'Failed to connect to SQL IP address.');
    } finally {
      setSaving(false);
    }
  }

  async function handleResetDefault() {
    setSaving(true);
    setCfgError('');
    try {
      const cfg = await resetDbConnectionConfig();
      setPublicCfg(cfg);
      setTestResult({
        ok: true,
        message: `Reverted to default server SQL configuration (${cfg.activeHostLabel}).`,
      });
      onDatabaseSwitched?.(cfg);
      onNotify?.('Reverted to default environment SQL connection.');
    } catch (err) {
      setCfgError(err instanceof Error ? err.message : 'Unable to reset SQL configuration.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSqlPassword() {
    setPwMessage(null);
    if (newPw.length < 6) {
      setPwMessage({ ok: false, text: 'Password must be at least 6 characters.' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMessage({ ok: false, text: 'Passwords do not match.' });
      return;
    }
    setPwSaving(true);
    try {
      await changeSqlPassword(newPw, currentUser?.hasPassword ? currentPw : undefined);
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setPwMessage({
        ok: true,
        text: 'SQL login password saved in PostgreSQL. You can now sign in with Email + Password on any desktop workstation.',
      });
      onNotify?.('SQL login password updated.');
    } catch (err) {
      setPwMessage({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to update SQL password.',
      });
    } finally {
      setPwSaving(false);
    }
  }

  function handleDownloadDesktopEnv() {
    const content = [
      '# Manufacturing Execution System — Standalone Desktop PostgreSQL Configuration',
      `SQL_HOST=${host.trim() || '192.168.1.50'}`,
      `SQL_PORT=${Number(port) || 5432}`,
      `SQL_DB_NAME=${database.trim() || 'mes_db'}`,
      `SQL_USER=${sqlUser.trim() || 'postgres'}`,
      'SQL_PASSWORD=REPLACE_WITH_SQL_PASSWORD',
      `SQL_SSL=${ssl ? 'true' : 'false'}`,
      `SQL_ADMIN_USER=${sqlUser.trim() || 'postgres'}`,
      'SQL_ADMIN_PASSWORD=REPLACE_WITH_SQL_PASSWORD',
      'PORT=3000',
      '',
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mes-desktop.env';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotify?.('Downloaded desktop SQL .env template.');
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-3xl bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden my-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-[#F7F8FA]">
          <div className="flex items-center gap-2.5">
            <Server className="w-5 h-5 text-teal-700 shrink-0" />
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Standalone Desktop &amp; SQL IP Connection
              </h2>
              <p className="text-xs text-slate-500">
                Connect directly to a PostgreSQL database by IP address and run Manufacturing Execution System as an individual desktop app.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-800 rounded-md"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 pt-3 border-b border-slate-200 flex flex-wrap gap-2 bg-white">
          <button
            type="button"
            onClick={() => setTab('sql')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'sql'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            PostgreSQL Server IP
          </button>
          <button
            type="button"
            onClick={() => setTab('desktop')}
            className={`min-h-[40px] px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === 'desktop'
                ? 'border-teal-700 text-teal-800'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Monitor className="w-3.5 h-3.5" />
            Individual Desktop App
          </button>
          {currentUser && (
            <button
              type="button"
              onClick={() => setTab('password')}
              className={`min-h-[40px] px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                tab === 'password'
                  ? 'border-teal-700 text-teal-800'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              SQL Account Password
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {tab === 'sql' && (
            <>
              <div className="border border-slate-200 bg-[#F7F8FA] rounded-md p-3.5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Active SQL Target
                  </div>
                  <div className="font-mono text-xs font-semibold text-slate-900 mt-0.5">
                    {loadingCfg
                      ? 'Inspecting active SQL pool...'
                      : publicCfg?.activeHostLabel || 'Default Environment SQL'}
                  </div>
                </div>
                {publicCfg && (
                  <div className="font-mono text-[11px] text-slate-600">
                    Mode: {publicCfg.configuredViaOverride ? 'Custom IP Override' : 'Environment Default'}
                  </div>
                )}
              </div>

              {cfgError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
                  {cfgError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5">
                <div className="sm:col-span-8">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    PostgreSQL Server IP Address / Hostname
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.50"
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>
                <div className="sm:col-span-4">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Port
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="5432"
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>

                <div className="sm:col-span-6">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Database Name
                  </label>
                  <input
                    type="text"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="mes_db"
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>
                <div className="sm:col-span-6">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SQL Username
                  </label>
                  <input
                    type="text"
                    value={sqlUser}
                    onChange={(e) => setSqlUser(e.target.value)}
                    placeholder="postgres"
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>

                <div className="sm:col-span-8">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SQL Password {publicCfg?.hasPassword ? '(leave blank to keep saved password)' : ''}
                  </label>
                  <input
                    type="password"
                    value={sqlPassword}
                    onChange={(e) => setSqlPassword(e.target.value)}
                    placeholder={publicCfg?.hasPassword ? '••••••••••••' : 'Enter SQL user password'}
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>
                <div className="sm:col-span-4 flex items-end">
                  <label className="w-full min-h-[40px] px-3 py-2 border border-slate-200 rounded-md bg-[#F7F8FA] flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ssl}
                      onChange={(e) => setSsl(e.target.checked)}
                      className="rounded border-slate-300 text-teal-700"
                    />
                    Use TLS / SSL
                  </label>
                </div>
              </div>

              <label className="flex items-start gap-2.5 text-xs text-slate-700 bg-[#F7F8FA] border border-slate-200 rounded-md p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={initializeSchema}
                  onChange={(e) => setInitializeSchema(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 text-teal-700"
                />
                <span>
                  <strong className="text-slate-900">
                    Automatically create / verify MES SQL tables on connect
                  </strong>
                  <span className="block text-slate-500 mt-0.5">
                    Safely runs idempotent <code className="font-mono">CREATE TABLE IF NOT EXISTS</code> for all 11 Manufacturing Execution System tables on the target PostgreSQL IP database.
                  </span>
                </span>
              </label>

              {testResult && (
                <div
                  className={`p-3 rounded-md border text-xs flex items-start gap-2.5 ${
                    testResult.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-red-50 border-red-200 text-red-900'
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-700" />
                  ) : (
                    <WifiOff className="w-4 h-4 shrink-0 mt-0.5 text-red-700" />
                  )}
                  <div className="space-y-1">
                    <div className="font-semibold">{testResult.message}</div>
                    {testResult.serverVersion && (
                      <div className="font-mono text-[11px] opacity-90">
                        {testResult.serverVersion} · Server IP: {testResult.serverIp || host}:
                        {testResult.serverPort || port} · Latency: {testResult.latencyMs} ms
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={testing || saving}
                    onClick={() => void handleTestConnection()}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:border-teal-700 rounded-md disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
                    {testing ? 'Testing...' : 'Test Connection'}
                  </button>
                  {publicCfg?.configuredViaOverride && (
                    <button
                      type="button"
                      disabled={saving || testing}
                      onClick={() => void handleResetDefault()}
                      className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-md"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset to Default
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  disabled={saving || testing}
                  onClick={() => void handleSaveAndConnect()}
                  className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
                >
                  <Database className="w-3.5 h-3.5" />
                  {saving ? 'Connecting...' : 'Save & Connect to SQL IP'}
                </button>
              </div>
            </>
          )}

          {tab === 'desktop' && (
            <div className="space-y-4 text-xs text-slate-700">
              <div className="border border-slate-200 rounded-md p-4 bg-[#F7F8FA] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Option 1: One-Click Desktop Window App (PWA)
                    </h3>
                    <p className="text-slate-600 mt-0.5">
                      Installs Manufacturing Execution System as an isolated desktop application window on Windows, macOS, or Linux without browser tabs.
                    </p>
                  </div>
                  {isInstalled ? (
                    <span className="font-mono text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded">
                      Running in Standalone Desktop Mode
                    </span>
                  ) : isInstallable ? (
                    <button
                      type="button"
                      onClick={() => void install()}
                      className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                    >
                      <Download className="w-4 h-4" />
                      Install on Desktop
                    </button>
                  ) : (
                    <span className="font-mono text-[11px] text-slate-600 bg-white border border-slate-200 px-2.5 py-1.5 rounded">
                      {isIOS ? 'Use Safari Share → Add to Home Screen' : 'Use Browser Address Bar Install Icon'}
                    </span>
                  )}
                </div>
                {!isInstalled && !isInstallable && (
                  <p className="text-[11px] text-slate-600 leading-relaxed border-t border-slate-200 pt-2.5">
                    In Chrome or Microsoft Edge on desktop: click the <strong>Install Manufacturing Execution System</strong> icon on the right side of the address bar (or Menu → <em>Apps / Cast, save, and share</em> → <em>Install page as app</em>).
                  </p>
                )}
              </div>

              <div className="border border-slate-200 rounded-md p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Option 2: Individual Offline Desktop Runner &amp; LAN PostgreSQL
                    </h3>
                    <p className="text-slate-600 mt-0.5">
                      Run Manufacturing Execution System independently on each workstation PC and connect directly to a PostgreSQL server IP on your plant network.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleDownloadDesktopEnv}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-md"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download .env Template
                  </button>
                </div>

                <div className="bg-slate-900 text-slate-100 rounded-md p-3.5 font-mono text-[11px] space-y-1.5 overflow-x-auto">
                  <div># 1. Run standalone desktop launcher (opens dedicated app window):</div>
                  <div className="text-emerald-300">npm install &amp;&amp; npm run build &amp;&amp; npm run desktop:local</div>
                  <div className="pt-1"># 2. Or build native Windows .exe / macOS .dmg / Linux AppImage:</div>
                  <div className="text-emerald-300">cd desktop &amp;&amp; npm install &amp;&amp; npm run dist</div>
                </div>

                <div className="text-[11px] text-slate-600 space-y-1">
                  <div className="font-semibold text-slate-800">
                    PostgreSQL Server IP Checklist (on your LAN DB host, e.g. 192.168.1.50):
                  </div>
                  <ul className="list-disc pl-5 space-y-0.5">
                    <li>
                      Set <code className="font-mono bg-slate-100 px-1">listen_addresses = &apos;*&apos;</code> in <code className="font-mono">postgresql.conf</code> and open TCP port <code className="font-mono">5432</code> in the firewall.
                    </li>
                    <li>
                      Allow your desktop subnet in <code className="font-mono">pg_hba.conf</code> (e.g. <code className="font-mono">host all all 192.168.1.0/24 scram-sha-256</code>).
                    </li>
                    <li>
                      Enter the server IP in the <strong>PostgreSQL Server IP</strong> tab — Manufacturing Execution System stores the target IP locally on that desktop and auto-creates any missing tables.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {tab === 'password' && currentUser && (
            <div className="space-y-4">
              <div className="border border-slate-200 bg-[#F7F8FA] rounded-md p-3.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-slate-900">
                      {currentUser.displayName} ({currentUser.email})
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {currentUser.hasPassword
                        ? 'SQL password is active. This account signs in directly against PostgreSQL without Firebase.'
                        : 'No SQL password set yet. Set one now so you can sign in directly with Email + Password on any desktop PC.'}
                    </div>
                  </div>
                </div>
              </div>

              {currentUser.hasPassword && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Current SQL Password
                  </label>
                  <input
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    New SQL Password (min 6 chars)
                  </label>
                  <input
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Confirm SQL Password
                  </label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                  />
                </div>
              </div>

              {pwMessage && (
                <div
                  className={`p-3 rounded-md border text-xs ${
                    pwMessage.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-red-50 border-red-200 text-red-900'
                  }`}
                >
                  {pwMessage.text}
                </div>
              )}

              <div className="flex justify-end pt-2 border-t border-slate-200">
                <button
                  type="button"
                  disabled={pwSaving}
                  onClick={() => void handleSaveSqlPassword()}
                  className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {pwSaving ? 'Saving...' : 'Save SQL Login Password'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
