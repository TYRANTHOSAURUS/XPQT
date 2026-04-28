import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthEventsController } from './auth-events.controller';
import type { AuthEventsService } from './auth-events.service';

const SECRET = 'test-hook-secret';

function makeService() {
  return {
    recordSignIn: jest.fn().mockResolvedValue(undefined),
    recordSignOut: jest.fn().mockResolvedValue(undefined),
    recordSignInFailed: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthEventsService & {
    recordSignIn: jest.Mock;
    recordSignOut: jest.Mock;
    recordSignInFailed: jest.Mock;
  };
}

function makeConfig() {
  return {
    get: jest.fn((key: string) =>
      key === 'SUPABASE_AUTH_HOOK_SECRET' ? SECRET : undefined,
    ),
  } as never;
}

describe('AuthEventsController', () => {
  it('routes sign_in payload to recordSignIn', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    const body = {
      type: 'sign_in',
      user_id: 'u-1',
      session_id: 's-1',
      ip_address: '1.2.3.4',
      user_agent: 'UA',
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T00:00:00Z',
    };

    await controller.signInWebhook(`Bearer ${SECRET}`, body);

    expect(service.recordSignIn).toHaveBeenCalledWith(expect.objectContaining({ type: 'sign_in', user_id: 'u-1' }));
  });

  it('routes sign_out payload to recordSignOut', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await controller.signInWebhook(`Bearer ${SECRET}`, {
      type: 'sign_out',
      user_id: 'u-1',
      session_id: 's-1',
      ip_address: null,
      user_agent: null,
      method: null,
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T00:00:00Z',
    });

    expect(service.recordSignOut).toHaveBeenCalled();
  });

  it('routes sign_in_failed payload to recordSignInFailed', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await controller.signInWebhook(`Bearer ${SECRET}`, {
      type: 'sign_in_failed',
      user_id: 'u-1',
      session_id: null,
      ip_address: null,
      user_agent: null,
      method: 'password',
      provider: null,
      mfa_used: false,
      occurred_at: '2026-04-28T00:00:00Z',
      failure_reason: 'invalid_password',
    });

    expect(service.recordSignInFailed).toHaveBeenCalled();
  });

  it('returns 401 when authorization header is missing', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await expect(controller.signInWebhook('', {})).rejects.toThrow(UnauthorizedException);
  });

  it('returns 401 when secret does not match', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await expect(controller.signInWebhook('Bearer wrong', {})).rejects.toThrow(UnauthorizedException);
  });

  it('returns 400 when payload type is unknown', async () => {
    const service = makeService();
    const controller = new AuthEventsController(service, makeConfig());

    await expect(
      controller.signInWebhook(`Bearer ${SECRET}`, { type: 'totally_made_up', user_id: 'u-1' }),
    ).rejects.toThrow(BadRequestException);
  });
});
