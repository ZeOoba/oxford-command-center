import { Component, type ReactNode } from 'react';
import { isStaleChunkError, reloadOnceForStaleChunk, type StaleChunkReloadDeps } from './stale-chunk';

interface Props {
  children: ReactNode;
  /** Test seam for the stale-chunk reload guard. */
  reloadDeps?: StaleChunkReloadDeps;
}
interface State {
  error: Error | null;
  reloading: boolean;
}

/** Catches render errors in a module so one failure never white-screens the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    // A lazy module chunk deleted by a rebuild: reload once to pick up the new build.
    if (isStaleChunkError(error) && reloadOnceForStaleChunk(this.props.reloadDeps)) {
      this.setState({ reloading: true });
    }
  }

  render() {
    if (this.state.reloading) {
      return (
        <div role="alert" className="grid place-items-center gap-2 py-24 text-center">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
            A new version was deployed. Reloading…
          </div>
        </div>
      );
    }
    if (this.state.error) {
      return (
        <div role="alert" className="grid place-items-center gap-2 py-24 text-center">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-neg)' }}>
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
