import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches render errors in a module so one failure never white-screens the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="grid place-items-center gap-2 py-24 text-center">
          <div className="text-sm font-semibold" style={{ color: 'var(--color-neg)' }}>
            Something went wrong rendering this module.
          </div>
          <div className="num max-w-lg text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
