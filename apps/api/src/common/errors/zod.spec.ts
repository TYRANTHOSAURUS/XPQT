import { z, ZodError } from 'zod';

import { AppError } from './app-error';
import { throwZodError } from './zod';

describe('throwZodError', () => {
  it('throws an AppError with code validation.failed and status 422', () => {
    const schema = z.object({ title: z.string().min(1) });
    const result = schema.safeParse({ title: '' });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(() => throwZodError(result)).toThrow(AppError);
    try {
      throwZodError(result);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('validation.failed');
      expect(appErr.status).toBe(422);
      expect(appErr.fields).toBeDefined();
      expect(appErr.fields!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('joins nested paths with "."', () => {
    const schema = z.object({
      meta: z.object({ ticket: z.object({ id: z.string().uuid() }) }),
    });
    const result = schema.safeParse({ meta: { ticket: { id: 'not-uuid' } } });
    if (result.success) throw new Error('expected failure');

    try {
      throwZodError(result);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.fields![0].field).toBe('meta.ticket.id');
    }
  });

  it('captures multiple issues as separate field entries', () => {
    const schema = z.object({
      title: z.string().min(1),
      count: z.number().int().nonnegative(),
    });
    const result = schema.safeParse({ title: '', count: -1 });
    if (result.success) throw new Error('expected failure');

    try {
      throwZodError(result);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.fields!.length).toBeGreaterThanOrEqual(2);
      const fieldNames = appErr.fields!.map((f) => f.field).sort();
      expect(fieldNames).toContain('title');
      expect(fieldNames).toContain('count');
    }
  });

  it('accepts a raw ZodError directly (not just safeParse result)', () => {
    const schema = z.object({ x: z.string() });
    const result = schema.safeParse({ x: 1 });
    if (result.success) throw new Error('expected failure');

    const raw: ZodError = result.error;
    try {
      throwZodError(raw);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('validation.failed');
      expect(appErr.fields![0].field).toBe('x');
    }
  });

  it('handles array index paths by stringifying them', () => {
    const schema = z.object({ items: z.array(z.string().min(1)) });
    const result = schema.safeParse({ items: ['ok', ''] });
    if (result.success) throw new Error('expected failure');

    try {
      throwZodError(result);
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.fields![0].field).toBe('items.1');
    }
  });
});
