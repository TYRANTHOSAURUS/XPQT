import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { spaceImagePreview, spaceImageThumbnail } from '@/lib/image';
import { RoomTypeIcon } from '@/pages/portal/book-room/components/room-type-icon';

interface BaseProps {
  imageUrl: string | null;
  capacity: number | null;
  keywords: readonly string[];
  /**
   * Empty by default — the room name is almost always rendered next to
   * this component. Pass an explicit alt only when the thumbnail is the
   * sole identifier (e.g. a tile in a grid without a label).
   */
  alt?: string;
  className?: string;
}

interface SquareProps extends BaseProps {
  variant?: 'square';
  /** Displayed CSS px size (square). The transform requests 2× for retina. */
  size: number;
}

interface HeroProps extends BaseProps {
  variant: 'hero';
  /** Max preview width in px (CDN render param). Aspect-video container. */
  maxWidth?: number;
}

type Props = SquareProps | HeroProps;

/**
 * Render a room's cover image with a typed fallback when no `image_url`
 * is set. Two variants:
 *
 *   `square` — used in dense list/row contexts. Fixed pixel size; the
 *   transform query requests 2× source so retina stays sharp without
 *   doubling 1× bandwidth.
 *
 *   `hero`   — used in the detail modal. Aspect-video, fills container
 *   width up to `maxWidth` (default 720). The CDN caches each
 *   (path, width) pair independently of the row thumbnail.
 *
 * In both cases we pass `loading="lazy" decoding="async"` and explicit
 * width/height attrs so the browser can defer offscreen images and avoid
 * layout shift. With the scheduler's row virtualizer mounting only ~12
 * rows at a time, the actual concurrency stays bounded even with a
 * large room fleet.
 */
export function RoomThumbnail(props: Props) {
  const { imageUrl, capacity, keywords, alt, className } = props;

  // Reset the error flag when the URL changes — different images get
  // their own retry chance instead of inheriting a stale fallback.
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [imageUrl]);

  if (props.variant === 'hero') {
    const maxWidth = props.maxWidth ?? 720;
    const src = spaceImagePreview(imageUrl, maxWidth);
    const showImage = src && !errored;
    return (
      <div
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-md bg-muted',
          className,
        )}
      >
        {showImage ? (
          <img
            src={src!}
            alt={alt ?? ''}
            loading="lazy"
            decoding="async"
            onError={() => setErrored(true)}
            className="size-full object-cover"
          />
        ) : (
          <RoomTypeIcon variant="fill" capacity={capacity} keywords={keywords} />
        )}
      </div>
    );
  }

  const size = props.size;
  const src = spaceImageThumbnail(imageUrl, size);
  const showImage = src && !errored;
  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden rounded-md bg-muted/40',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={src!}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          onError={() => setErrored(true)}
          className="size-full object-cover"
        />
      ) : (
        <RoomTypeIcon variant="fill" capacity={capacity} keywords={keywords} />
      )}
    </div>
  );
}
