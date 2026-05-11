/**
 * Errors module barrel — single import surface for the Phase 7.A.1
 * foundation. Producers do:
 *
 *   import { AppError, AppErrors, throwZodError } from '@/common/errors';
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 */

export {
  AppError,
  AppErrors,
  isAppError,
  type AppErrorField,
  type AppErrorOptions,
} from './app-error';
export { throwZodError } from './zod';
export {
  normalize,
  randomTraceId,
  type WireShape,
  type NormalizedError,
} from './normalize';
export { AllExceptionsFilter } from './all-exceptions.filter';
export { resolveMessageEn, type ErrorMessage } from './messages.en';
export { mapRpcErrorToAppError } from './map-rpc-error';
