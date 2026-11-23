import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || 'Unexpected application error.',
    };
  }

  componentDidCatch(error: Error) {
    console.error('Kettler MES ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      const friendly =
        this.state.message || 'An unexpected interruption occurred in the production workspace.';

      return (
        <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white border border-slate-200 rounded-lg p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-slate-900">
                  Production Workspace Interrupted
                </h2>
                <p className="mt-2 text-sm text-slate-600 break-words">
                  {friendly}
                </p>
                <div className="mt-5 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Reload Workspace
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
