import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface PaletteCtx {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<PaletteCtx | undefined>(undefined);

/**
 * Returns true when the keyboard event is bubbling from a typed control.
 * We don't want '/' to hijack focus when the user is mid-edit somewhere.
 */
function isInTypedControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

// The dialog body — cmdk + skeleton + hover cards + icon imports — is the
// expensive part. Only load it on first open so cold starts stay slim.
const CommandPaletteBody = lazy(() =>
  import('./command-palette-body').then((m) => ({ default: m.CommandPaletteBody })),
);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Track whether the body has ever been rendered. Once true, keep it
  // mounted (closed) so reopening is instant — lazy work is paid once.
  const [hasRendered, setHasRendered] = useState(false);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (open) setHasRendered(true);
  }, [open]);

  // ⌘K / Ctrl+K — global; '/' as alt-trigger when not focused on an input.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isCmdK =
        (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey);
      const isSlash =
        event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;

      if (isCmdK) {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }

      if (isSlash && !isInTypedControl(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const value = useMemo<PaletteCtx>(() => ({ open, setOpen, toggle }), [open, toggle]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {hasRendered && (
        <Suspense fallback={null}>
          <CommandPaletteBody open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}

export function useCommandPalette() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCommandPalette must be used inside <CommandPaletteProvider>');
  return ctx;
}
