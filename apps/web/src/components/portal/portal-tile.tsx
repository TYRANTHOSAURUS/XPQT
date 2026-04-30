import { Link } from 'react-router-dom';
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type TileVariant = 'card' | 'dashed';

interface BaseProps {
  variant?: TileVariant;
  className?: string;
  /** Style passthrough for view-transition-name etc. */
  style?: CSSProperties;
  children: ReactNode;
}

interface LinkProps extends BaseProps {
  to: string;
  href?: never;
  onClick?: never;
}

interface AnchorProps extends BaseProps {
  href: string;
  to?: never;
  onClick?: never;
}

interface ButtonProps extends BaseProps {
  onClick: () => void;
  to?: never;
  href?: never;
  type?: 'button' | 'submit';
  ariaLabel?: string;
}

type Props = LinkProps | AnchorProps | ButtonProps;

const VARIANT_CLASSES: Record<TileVariant, string> = {
  card:   'border-border/70 bg-card hover:border-border hover:bg-card hover:shadow-sm active:bg-accent/40',
  dashed: 'border-dashed border-border/70 bg-transparent hover:border-border hover:bg-muted/40',
};

/**
 * Shared "card on a card" tile primitive used by the portal home category
 * grid, services grid, and any future tile-like surface. Props mirror the
 * three call shapes we have in the wild: react-router `Link`, plain
 * anchor, or `<button>`.
 *
 * Visual contract: rounded-xl, hairline border, hover lift (-0.5px),
 * press settles back to baseline plus subtle accent flash. Motion uses
 * the project's `--ease-portal` / `--dur-portal-hover` tokens. Don't
 * patch hover/press styles in consumers — extend the variant here.
 */
export const PortalTile = forwardRef<HTMLElement, Props>(function PortalTile(props, ref) {
  const { variant = 'card', className, style, children } = props;

  const sharedClass = cn(
    'group block overflow-hidden rounded-xl border',
    'transition-[transform,border-color,background-color,box-shadow]',
    'hover:-translate-y-0.5',
    'active:translate-y-px active:shadow-none',
    'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
    VARIANT_CLASSES[variant],
    className,
  );

  const sharedStyle: CSSProperties = {
    transitionTimingFunction: 'var(--ease-portal)',
    transitionDuration: 'var(--dur-portal-hover)',
    ...style,
  };

  if ('to' in props && props.to) {
    return (
      <Link
        to={props.to}
        viewTransition
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={sharedClass}
        style={sharedStyle}
      >
        {children}
      </Link>
    );
  }
  if ('href' in props && props.href) {
    return (
      <a
        href={props.href}
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={sharedClass}
        style={sharedStyle}
      >
        {children}
      </a>
    );
  }
  const buttonProps = props as ButtonProps;
  return (
    <button
      type={buttonProps.type ?? 'button'}
      onClick={buttonProps.onClick}
      aria-label={buttonProps.ariaLabel}
      ref={ref as React.Ref<HTMLButtonElement>}
      className={cn(sharedClass, 'text-left w-full')}
      style={sharedStyle}
    >
      {children}
    </button>
  );
});
