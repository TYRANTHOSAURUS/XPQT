import { useBranding } from '@/hooks/use-branding';
import { usePortal } from '@/providers/portal-provider';

/**
 * Desktop-only portal footer. Mobile uses the account menu for legal/help
 * links so we don't stack chrome above the fixed bottom-tabs.
 */
export function PortalFooter() {
  const { branding } = useBranding();
  const { data } = usePortal();

  const tenantName = data?.tenant?.name?.trim() || branding?.name?.trim() || 'Workplace';
  const year = new Date().getFullYear();

  return (
    <footer
      role="contentinfo"
      aria-label="Portal footer"
      className="hidden md:block border-t border-border/50"
    >
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-3 py-6 text-xs text-muted-foreground md:px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            © {year} {tenantName}
          </span>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span className="truncate">
            Powered by{' '}
            <a
              href="#"
              className="text-foreground/80 transition-colors hover:text-foreground"
            >
              Prequest
            </a>
          </span>
        </div>

        <nav aria-label="Legal" className="flex items-center gap-3">
          <a href="#" className="transition-colors hover:text-foreground">
            Help
          </a>
          <span aria-hidden className="text-border">
            ·
          </span>
          <a href="#" className="transition-colors hover:text-foreground">
            Privacy
          </a>
          <span aria-hidden className="text-border">
            ·
          </span>
          <a href="#" className="transition-colors hover:text-foreground">
            Terms
          </a>
        </nav>
      </div>
    </footer>
  );
}
