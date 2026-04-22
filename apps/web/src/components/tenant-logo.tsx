import { useEffect, useState } from 'react';
import { useBranding } from '@/hooks/use-branding';
import { cn } from '@/lib/utils';

const FALLBACK = '/assets/prequest-icon-color.svg';

interface TenantLogoProps {
  variant?: 'full' | 'mark';
  className?: string;
  alt?: string;
}

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

export function TenantLogo({ variant = 'full', className, alt = 'Logo' }: TenantLogoProps) {
  const { branding } = useBranding();
  const isDark = useIsDark();

  const tenantLogo = isDark
    ? branding.logo_dark_url ?? branding.logo_light_url
    : branding.logo_light_url;
  const src = tenantLogo ?? FALLBACK;

  return <img src={src} alt={alt} className={cn('object-contain', className)} data-variant={variant} />;
}
