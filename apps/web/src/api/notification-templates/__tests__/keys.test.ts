/**
 * Stability tests for the notification-templates query-key factory.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G. Mutations invalidate the
 * top-level `notificationTemplateKeys.all` namespace; an accidental
 * rename here would silently break that wire-up. Pin the wire-shape via
 * these tests.
 */

import { describe, expect, it } from 'vitest';
import { notificationTemplateKeys } from '../keys';

describe('notificationTemplateKeys factory', () => {
  it('roots every key under ["notification-templates"]', () => {
    expect(notificationTemplateKeys.all).toEqual(['notification-templates']);
  });

  it('lists() nests under all', () => {
    expect(notificationTemplateKeys.lists()).toEqual([
      'notification-templates',
      'list',
    ]);
  });

  it('list() includes a stable args object so React Query hits the same bucket', () => {
    expect(notificationTemplateKeys.list()).toEqual([
      'notification-templates',
      'list',
      {},
    ]);
  });

  it('details() and lists() are siblings', () => {
    expect(notificationTemplateKeys.details()).toEqual([
      'notification-templates',
      'detail',
    ]);
  });

  it('detail(eventKind) appends the event_kind verbatim', () => {
    expect(notificationTemplateKeys.detail('booking.approval_required')).toEqual([
      'notification-templates',
      'detail',
      'booking.approval_required',
    ]);
  });

  // Hierarchical-prefix invariant: invalidating `all` must bust both list
  // and detail buckets. React Query matches by prefix.
  it('list and detail share the ["notification-templates"] prefix', () => {
    for (const k of [
      notificationTemplateKeys.lists(),
      notificationTemplateKeys.details(),
    ]) {
      expect(k[0]).toBe('notification-templates');
    }
  });
});
