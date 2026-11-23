import { useState } from 'react';
import { Download, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md transition-colors whitespace-nowrap"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        Install Standalone App
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-md transition-colors whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          Install on iOS
        </button>

        {showGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="w-full max-w-sm rounded-lg bg-white border border-slate-200 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Install Kettler MES on iPad / iPhone
                </h3>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  className="p-1 text-slate-400 hover:text-slate-700"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-600 leading-relaxed">
                1. Tap the <strong>Share</strong> icon in Safari&apos;s toolbar.
                <br />
                2. Scroll down and select <strong>Add to Home Screen</strong>.
                <br />
                3. Launch Kettler MES directly as a standalone floor workstation app.
              </p>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="mt-4 w-full px-3 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      data-print-hide="true"
      role="status"
      className="fixed bottom-5 left-5 z-50 inline-flex items-center gap-2 rounded-md bg-amber-700 px-3.5 py-2 text-xs font-medium text-white shadow-md"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Offline Mode — Showing last synchronized plant records.</span>
    </div>
  );
}
