// Tests for mapRpcErrorToAppError.
//
// Codex remediation (00384) added a JSON-detail parse for the
// planning.version_conflict raise from inside the RPC. The TS pre-check
// at work-order.service.ts:260-284 already throws the same AppError with
// serverVersion + clientVersion populated; the RPC-side raise must produce
// the same wire body so the FE handles both identically.

import { mapRpcErrorToAppError } from './map-rpc-error';

describe('mapRpcErrorToAppError — planning.version_conflict', () => {
  it('parses current_version + client_version from PostgrestError.details and forwards to AppErrors.conflict', () => {
    const err = mapRpcErrorToAppError({
      message: 'planning.version_conflict: server=7 client=5',
      details: JSON.stringify({ current_version: 7, client_version: 5 }),
      code: 'P0001',
    });

    expect(err.code).toBe('planning.version_conflict');
    expect(err.status).toBe(409);
    expect(err.serverVersion).toBe('7');
    expect(err.clientVersion).toBe('5');
  });

  it('handles missing details gracefully (no version, still 409)', () => {
    const err = mapRpcErrorToAppError({
      message: 'planning.version_conflict: missing detail',
      details: null,
      code: 'P0001',
    });

    expect(err.code).toBe('planning.version_conflict');
    expect(err.status).toBe(409);
    expect(err.serverVersion).toBeUndefined();
    expect(err.clientVersion).toBeUndefined();
  });

  it('handles malformed JSON details gracefully (no version, still 409)', () => {
    const err = mapRpcErrorToAppError({
      message: 'planning.version_conflict: server=? client=?',
      details: '{not valid json',
      code: 'P0001',
    });

    expect(err.code).toBe('planning.version_conflict');
    expect(err.status).toBe(409);
    expect(err.serverVersion).toBeUndefined();
    expect(err.clientVersion).toBeUndefined();
  });

  it('does NOT add versions to other 409 codes (e.g. payload_mismatch)', () => {
    const err = mapRpcErrorToAppError({
      message: 'command_operations.payload_mismatch',
      details: JSON.stringify({ current_version: 7, client_version: 5 }),
      code: 'P0001',
    });

    expect(err.code).toBe('command_operations.payload_mismatch');
    expect(err.status).toBe(409);
    expect(err.serverVersion).toBeUndefined();
    expect(err.clientVersion).toBeUndefined();
  });
});
