/**
 * Public surface of the notifications module.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step C.
 *
 * Sub-step D's outbox handler imports from here, not from individual files,
 * so internal restructuring doesn't break consumers.
 */

export { NotificationsModule } from './notifications.module';
export { NotificationsService, type DispatchArgs } from './notifications.service';
export { EmailChannel } from './channels/email.channel';
export {
  type DispatchInput,
  type DispatchResult,
  type NotificationChannel,
  type RenderedNotification,
} from './channels/notification-channel.interface';
export {
  TemplateResolverService,
  type ResolveArgs,
  type NotificationEventPayloads,
} from './templates/template-resolver.service';
export type {
  BookingApprovalRequiredPayload,
  RenderedTemplate,
  TemplateModule,
  TemplateOverrides,
} from './templates/types';
