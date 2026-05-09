import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { classify, type ClassifiedError } from '@/lib/errors/classify';
import { resolveMessage } from '@/lib/errors/messages.en';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  classified: ClassifiedError | null;
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

/**
 * Top-level boundary used by every route via `<Route element={<RouteErrorBoundary>…`.
 *
 * Renders class-aware copy for the four classes that throw to a boundary
 * (`not_found`, `permission`, `server`, `unknown`) per spec §3.4. Chunk
 * loads still auto-reload once before falling through to the generic
 * "something went wrong" page.
 *
 * The traceId chip uses `data-chip` so triple-click selects it atomically
 * (CLAUDE.md design polish — copy chip rule).
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, classified: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, classified: classify(error, { callSite: 'route_load' }) };
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

  handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  };

  render() {
    const { error, classified } = this.state;
    if (!error || isChunkLoadError(error)) {
      return this.props.children;
    }

    const cls = classified?.class ?? 'unknown';
    const code = classified?.code ?? 'unknown.server_error';
    const traceId = classified?.traceId;
    const resolved = resolveMessage(code, 'dialog');

    if (cls === 'not_found') {
      return (
        <ErrorScaffold
          title="We couldn't find that page"
          detail={resolved.detail ?? 'It may have been moved or removed.'}
          actions={
            <>
              <Button onClick={this.handleGoBack} size="sm" variant="outline">Go back</Button>
              <Button onClick={this.handleReload} size="sm">Reload</Button>
            </>
          }
        />
      );
    }

    if (cls === 'permission') {
      return (
        <ErrorScaffold
          title="You don't have access"
          detail={resolved.detail ?? 'Ask an admin if you need access to this page.'}
          actions={
            <Button onClick={this.handleGoBack} size="sm">Go back</Button>
          }
        />
      );
    }

    if (cls === 'server') {
      return (
        <ErrorScaffold
          title="Something went wrong on our end"
          detail={resolved.detail ?? 'Try reloading. If it keeps happening, contact support with the trace ID.'}
          actions={
            <>
              <Button onClick={this.handleReload} size="sm">Reload</Button>
              <Button asChild size="sm" variant="outline">
                <a href="mailto:support@prequest.app">Contact support</a>
              </Button>
            </>
          }
          traceId={traceId}
        />
      );
    }

    // unknown / fallback
    return (
      <ErrorScaffold
        title="Something went wrong"
        detail="The page failed to load. Try reloading — if it keeps happening, sign out and back in."
        actions={<Button onClick={this.handleReload} size="sm">Reload</Button>}
        traceId={traceId}
      />
    );
  }
}

function ErrorScaffold(props: {
  title: string;
  detail: string;
  actions: ReactNode;
  traceId?: string;
}) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="space-y-1">
          <h1 className="text-base font-medium">{props.title}</h1>
          <p className="text-sm text-muted-foreground">{props.detail}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {props.actions}
        </div>
        {props.traceId ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Reference:{' '}
            <code data-chip className="font-mono text-[11px]">{props.traceId}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
