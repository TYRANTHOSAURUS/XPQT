import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a controller or handler as publicly accessible — bypasses the global AuthGuard.
 * Use sparingly: health checks, webhook receivers that authenticate via a URL token, etc.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
