import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

const RELOAD_FLAG = 'route-error-boundary:reloaded';

function isChunkLoadError(error: Error): boolean {
  if (error.name === 'ChunkLoadError') return true;
  const msg = error.message ?? '';
  return (
    /Loading chunk [\w-]+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error) && !sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, '1');
      window.location.reload();
      return;
    }
    sessionStorage.removeItem(RELOAD_FLAG);
    console.error('RouteErrorBoundary caught:', error);
  }

  handleReload = () => {
    sessionStorage.removeItem(RELOAD_FLAG);
    window.location.reload();
  };

  render() {
    if (this.state.error && !isChunkLoadError(this.state.error)) {
      return (
        <div className="flex min-h-screen w-full items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <div className="space-y-1">
              <h1 className="text-base font-medium">Something went wrong</h1>
              <p className="text-sm text-muted-foreground">
                The page failed to load. Try reloading — if it keeps happening, sign out and back in.
              </p>
            </div>
            <Button onClick={this.handleReload} size="sm">Reload</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
