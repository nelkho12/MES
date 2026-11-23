import { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import {
  ArrowRight,
  Boxes,
  ClipboardCheck,
  ShieldCheck,
  Thermometer,
  TrendingUp,
} from 'lucide-react';
import { auth, googleProvider } from '../firebase';

export function AuthGate() {
  const [signingIn, setSigningIn] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  async function handleGoogleSignIn() {
    setSigningIn(true);
    setErrorMsg('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      setErrorMsg(
        msg.includes('popup-closed-by-user')
          ? 'Sign-in popup was closed before completing authentication.'
          : msg
      );
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-slate-900 flex flex-col">
      <header className="h-16 border-b border-slate-200 bg-white px-8 flex items-center justify-between gap-8">
        <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          Kettler MES
        </span>
        <div className="hidden md:flex items-center gap-6 text-sm text-slate-500">
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
          onClick={handleGoogleSignIn}
          disabled={signingIn}
          className="px-4 py-2 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          {signingIn ? 'Signing in...' : 'Sign in'}
        </button>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-14 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
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
            automatic finished goods posting.
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
                <h2 className="text-sm font-semibold text-slate-900">Real-Time Yield Lab</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Quantify thermal boil-off, weigh tolerance variance, and unit costing across every
                  production line.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="bg-white border border-slate-200 rounded-lg p-8">
            <div className="flex items-center gap-2.5 text-slate-900">
              <ShieldCheck className="w-5 h-5 text-teal-700" />
              <h2 className="text-lg font-semibold">Facility Operator Sign-In</h2>
            </div>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Sign in with your Google account to access your persistent plant manufacturing
              workspace with role-based OEM formula confidentiality.
            </p>

            <div className="mt-6 space-y-3 text-sm text-slate-600 border-y border-slate-200 py-4">
              <div className="flex items-center justify-between">
                <span>Deployment Mode</span>
                <span className="font-mono text-xs text-slate-900">Standalone Desktop / Tablet</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Role Modes</span>
                <span className="font-mono text-xs text-slate-900">Manager · Operator · QC</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Starter Plant Data</span>
                <span className="font-mono text-xs text-slate-900">Auto-provisioned on login</span>
              </div>
            </div>

            {errorMsg && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
                {errorMsg}
              </div>
            )}

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={signingIn}
              className="mt-6 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap"
            >
              <span>{signingIn ? 'Authenticating...' : 'Continue with Google'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
