import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logToMain } from '../../utils/logToMain';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

// Catches render/lifecycle exceptions anywhere in the tree below it — including
// in <App> itself, since this sits above <App> in main.tsx. Without it, a throw
// during render unmounts the whole tree and leaves a blank black window with no
// diagnostic anywhere. Here we record it to the main process log
// (nodebrain-log.txt) and show a fallback the user can actually act on.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = [
      error instanceof Error ? error.stack : undefined,
      info?.componentStack ? `Component stack:${info.componentStack}` : undefined,
    ].filter(Boolean).join('\n');
    logToMain(
      'react-error-boundary',
      error instanceof Error ? error.message : String(error),
      stack || undefined,
    );
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    // Inline styles on purpose: the stylesheet (or Tailwind) may itself be part
    // of what failed, so the fallback must not depend on any external CSS.
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 40,
          background: '#0a0a0f',
          color: '#e2e8f0',
          textAlign: 'center',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>NodeBrain hit an error.</h1>
        <p style={{ fontSize: 14, color: '#94a3b8', maxWidth: 460, lineHeight: 1.5, margin: 0 }}>
          Something in the interface crashed. Restarting the app usually clears it.
          The details were written to the log:
        </p>
        <code
          style={{
            fontSize: 12,
            color: '#94a3b8',
            background: 'rgba(255,255,255,0.06)',
            padding: '6px 10px',
            borderRadius: 6,
            wordBreak: 'break-all',
          }}
        >
          AppData\Roaming\NodeBrain\nodebrain-log.txt
        </code>
        {this.state.message && (
          <p style={{ fontSize: 12, color: '#64748b', maxWidth: 460, margin: 0, fontFamily: 'monospace' }}>
            {this.state.message}
          </p>
        )}
        <button
          onClick={this.handleReload}
          style={{
            marginTop: 8,
            padding: '10px 20px',
            borderRadius: 8,
            border: 'none',
            background: '#6366f1',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
