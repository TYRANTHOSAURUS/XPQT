/**
 * throwZodError — convert a Zod failure into an `AppError('validation.failed', 422)`.
 *
 * Spec / mandate: CLAUDE.md > Error handling > "Server: validation goes
 * through `throwZodError`". Co-located with the rest of the foundation in
 * Phase 7.A.1 so 7.A.2 doesn't end up copy-pasting four ad-hoc shapes.
 *
 * Accepts either a raw `ZodError` or the `{success:false, error}` shape
 * returned by `safeParse`. Translates each issue to the wire-shape
 * `fields[]` entry: `{field, code, message}` with dot-joined nested paths.
 */

import { ZodError, type ZodSafeParseError } from 'zod';

import { AppError } from './app-error';

type ZodIssueShape = {
  path: ReadonlyArray<string | number | symbol>;
  code: string;
  message: string;
};

export function throwZodError(
  zErr: ZodError | ZodSafeParseError<unknown>,
): never {
  const issues: ReadonlyArray<ZodIssueShape> = isSafeParseError(zErr)
    ? (zErr.error.issues as ReadonlyArray<ZodIssueShape>)
    : (zErr.issues as ReadonlyArray<ZodIssueShape>);
  const fields = issues.map((issue) => ({
    field: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
  throw new AppError('validation.failed', 422, { fields });
}

function isSafeParseError(
  value: ZodError | ZodSafeParseError<unknown>,
): value is ZodSafeParseError<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { success?: unknown }).success === false &&
    'error' in (value as object)
  );
}
