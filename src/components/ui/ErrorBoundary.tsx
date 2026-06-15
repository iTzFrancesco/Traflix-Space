import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <AlertTriangle size={48} className="text-red-500/60" />
          <div>
            <h2 className="font-display font-bold text-lg text-neutral-text-dim mb-1">
              Errore imprevisto
            </h2>
            <p className="text-sm text-neutral-text-muted max-w-md">
              {this.state.error?.message || "Si è verificato un errore nel rendering."}
            </p>
          </div>
          <button
            onClick={this.handleRetry}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
          >
            <RefreshCw size={14} />
            Riprova
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
