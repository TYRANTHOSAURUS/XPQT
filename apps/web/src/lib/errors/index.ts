/**
 * Error handling — public surface.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *
 * Foundation built in Phase 7.B-2. Migration of every existing useMutation
 * onto these helpers happens in a follow-up wave; new code should import
 * exclusively from this barrel.
 */

export { classify, type CallSite, type ClassifyContext, type ClassifiedError, type ClassifiedField, type Recovery, type ErrorClass } from './classify';
export { handleMutationError, handleQueryError, withErrorHandling, type HandleMutationErrorOptions, type HandleQueryErrorOptions } from './handlers';
export { throwToBoundary } from './throw-to-boundary';
export { usePageQuery } from './use-page-query';
export { resolveMessage, ERROR_MESSAGES_EN, type ErrorMessage, type Surface } from './messages.en';
export { RouteErrorBoundary } from '@/components/route-error-boundary';
