/**
 * Unit tests for the inbox Realtime dispatch helpers.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F. We exercise the pure functions
 * (`inboxChannelName`, `handleInboxRealtimePayload`) without mounting the
 * React hook — the hook is a thin wrapper around `supabase.channel(…)`
 * which we don't want to stand up in unit tests. The integration of those
 * pieces is verified manually + by the Realtime SLA section of the spec.
 */

import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  handleInboxRealtimePayload,
  inboxChannelName,
} from '../inbox-subscription';
import { inboxKeys } from '@/api/inbox';

describe('inboxChannelName', () => {
  it('matches the inbox:tenant_<id>:user_<id> contract', () => {
    expect(inboxChannelName('tnt-1', 'usr-1')).toBe('inbox:tenant_tnt-1:user_usr-1');
  });

  it('keeps tenant + user pairs distinct', () => {
    expect(inboxChannelName('a', '1')).not.toBe(inboxChannelName('b', '1'));
    expect(inboxChannelName('a', '1')).not.toBe(inboxChannelName('a', '2'));
  });
});

describe('handleInboxRealtimePayload', () => {
  function setup() {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const toast = vi.fn();
    return { queryClient, invalidate, toast };
  }

  it('INSERT busts inboxKeys.all and toasts when off the inbox page', () => {
    const { queryClient, invalidate, toast } = setup();
    handleInboxRealtimePayload(
      { eventType: 'INSERT', new: { user_id: 'u1' } },
      queryClient,
      { onPath: '/desk/tickets', toast },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all });
    expect(toast).toHaveBeenCalledWith('New notification');
  });

  it('INSERT does NOT toast when the user is already on the inbox page', () => {
    const { queryClient, invalidate, toast } = setup();
    handleInboxRealtimePayload(
      { eventType: 'INSERT', new: { user_id: 'u1' } },
      queryClient,
      { onPath: '/me/inbox', toast },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all });
    expect(toast).not.toHaveBeenCalled();
  });

  it('UPDATE narrows invalidation to the count bucket only', () => {
    const { queryClient, invalidate, toast } = setup();
    handleInboxRealtimePayload(
      { eventType: 'UPDATE', new: { user_id: 'u1', read_at: '2026-05-13T00:00:00.000Z' } },
      queryClient,
      { onPath: '/desk/tickets', toast },
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.count() });
    expect(toast).not.toHaveBeenCalled();
  });

  it('DELETE busts inboxKeys.all and does not toast', () => {
    const { queryClient, invalidate, toast } = setup();
    handleInboxRealtimePayload(
      { eventType: 'DELETE', old: { user_id: 'u1' } },
      queryClient,
      { onPath: '/desk/tickets', toast },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all });
    expect(toast).not.toHaveBeenCalled();
  });

  it('defaults the eventType to INSERT when missing (defensive)', () => {
    const { queryClient, invalidate, toast } = setup();
    handleInboxRealtimePayload(
      { new: { user_id: 'u1' } },
      queryClient,
      { onPath: '/portal', toast },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.all });
    expect(toast).toHaveBeenCalledWith('New notification');
  });
});
