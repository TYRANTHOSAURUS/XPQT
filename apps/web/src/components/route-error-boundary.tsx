import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { classify, type ClassifiedError } from '@/lib/errors/classify';
import { resolveMessage } from '@/lib/errors/messages.en';
import { STASHED_CLASSIFIED } from '@/lib/errors/use-page-query';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  classified: ClassifiedError | null;
  /**
   * 'reload' = chunk failure that we auto-reloaded; render children while
   * the reload happens. 'fail' = chunk failure on the second attempt; fall
   * through to the generic error UI so the user isn't stranded on a blank.
   */
  chunkFallback: 'none' | 'reload' | 'fail';
}

const RELOAD_FLAG = 'route-error-boundary:reloaded';

function safeReadFlag(): string | null {
  try {
    return sessionStorage.getItem(RELOAD_FLAG);
  } catch {
    // Safari private mode / embedded surfaces can throw on storage access.
    return null;
  }
}

function safeWriteFlag(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    /* noop — see safeReadFlag */
  }
}

function safeClearFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* noop — see safeReadFlag */
  }
}

function isChunkLoadError(error: Error): boolean {
  if (error.name === 'ChunkLoadError') return true;
  const msg = error.message ?? '';
  return (
    /Loading chunk [\w-]+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

function readStashedClassified(error: Error): ClassifiedError | undefined {
  const e = error as Error & { [STASHED_CLASSIFIED]?: ClassifiedError };
  return e[STASHED_CLASSIFIED];
}

/**
 * Top-level boundary used by every route via `<Route element={<RouteErrorBoundary>…`.
 *
 * Renders class-aware copy for the four classes that throw to a boundary
 * (`not_found`, `permission`, `server`, `unknown`) per spec §3.4. Chunk
 * loads auto-reload once before falling through to the generic
 * "something went wrong" page on the second failure.
 *
 * The traceId chip uses `data-chip` so triple-click selects it atomically
 * (CLAUDE.md design polish — copy chip rule).
 *
 * Implementation note: when `usePageQuery` threw the error, it stashed a
 * classified value on the error object so we re-use it instead of re-running
 * `classify()` on every render.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, classified: null, chunkFallback: 'none' };

  static getDerivedStateFromError(error: Error): State {
    if (isChunkLoadError(error)) {
      // Decision deferred to componentDidCatch — it owns the reload-attempt
      // counter via sessionStorage.
      return { error, classified: null, chunkFallback: 'reload' };
    }
    const classified = readStashedClassified(error) ?? classify(error, { callSite: 'route_load' });
    return { error, classified, chunkFallback: 'none' };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error)) {
      const alreadyReloaded = safeReadFlag() === '1';
      if (!alreadyReloaded) {
        safeWriteFlag();
        // Render children while the reload happens (state.chunkFallback ===
        // 'reload') — better than flashing a blank error frame.
        window.location.reload();
        return;
      }
      // Second chunk failure — clear the flag (so a future independent chunk
      // failure can reload again) and fall through to the generic error UI.
      safeClearFlag();
      this.setState({ chunkFallback: 'fail' });
      console.error('RouteErrorBoundary: chunk-load failed twice, falling back', error);
      return;
    }
    safeClearFlag();
    console.error('RouteErrorBoundary caught:', error);
  }

  handleReload = () => {
    safeClearFlag();
    window.location.reload();
  };

  handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  render() {
    const { error, classified, chunkFallback } = this.state;
    if (!error) return this.props.children;

    // Chunk-load: render children during the auto-reload; only render the
    // error UI when the reload itself failed.
    if (chunkFallback === 'reload') return this.props.children;

    const cls = classified?.class ?? (chunkFallback === 'fail' ? 'unknown' : 'unknown');
    const code = classified?.code ?? 'unknown.server_error';
    const traceId = classified?.traceId;
    const resolved = resolveMessage(code, 'dialog');

    if (cls === 'not_found') {
      // Branch on body.reason per spec §3.3 / §4. 'hidden' must look identical
      // to 'missing' — never reveal existence — so they share copy and
      // recoveries.
      const isRemoved = classified?.reason === 'removed';

      // Prefer code-resolved title when the registry has one specific to the
      // wire code (e.g. cost_center_not_found → "We can't find that cost
      // center"). Fall back to a generic page-level title only when the code
      // is the generic bucket. The `removed` reason wins over both.
      const isGenericCode = code === 'generic.not_found';
      const title = isRemoved
        ? 'This was removed'
        : !isGenericCode && resolved.title
          ? resolved.title
          : "We couldn't find that page";
      const detail = isRemoved
        ? 'It was deleted and is no longer available.'
        : (resolved.detail ?? 'It may have been moved or removed.');

      return (
        <ErrorScaffold
          title={title}
          detail={detail}
          actions={
            isRemoved ? (
              <Button onClick={this.handleGoHome} size="sm">Go to dashboard</Button>
            ) : (
              <>
                <Button onClick={this.handleGoBack} size="sm" variant="outline">Go back</Button>
                <Button onClick={this.handleReload} size="sm">Reload</Button>
              </>
            )
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

    // unknown / fallback (incl. chunk-load second failure).
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
