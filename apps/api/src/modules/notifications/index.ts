/**
 * Public surface of the notifications module.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * Sub-step D's outbox handler imports from here, not from individual files,
 * so internal restructuring doesn't break consumers.
 *
 * Self-review I4: EmailChannel + TemplateResolverService are
 * MODULE-INTERNAL — only NotificationsModule provides them in DI; direct
 * consumers outside the module would hit DI errors. Consumers route
 * through `NotificationsService.dispatch` (the only exported provider).
 * The DispatchInput / RenderedTemplate type re-exports are kept for
 * sub-step D's handler payload typing.
 */

export { NotificationsModule } from './notifications.module';
export { NotificationsService, type DispatchArgs } from './notifications.service';
export { NotificationTemplateService } from './template-overrides.service';
export {
  type DispatchInput,
  type DispatchResult,
  type NotificationChannel,
  type RenderedNotification,
} from './channels/notification-channel.interface';
export {
  type ResolveArgs,
  type NotificationEventKind,
  type NotificationEventPayloads,
} from './templates/template-resolver.service';
export type {
  BookingApprovalRequiredPayload,
  RenderedTemplate,
  TemplateModule,
  TemplateOverrides,
} from './templates/types';
