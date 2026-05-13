// Notification templates API barrel — admin CRUD surface for per-tenant
// per-locale partial overrides on the default React Email templates.
// See ./keys.ts, ./queries.ts, ./mutations.ts. Wire-shape types in ./types.ts.

export { notificationTemplateKeys } from './keys';
export {
  useNotificationTemplates,
  useNotificationTemplate,
  useNotificationTemplateQuiet,
  notificationTemplatesListOptions,
  notificationTemplateOptions,
} from './queries';
export { useUpsertNotificationTemplate } from './mutations';
export {
  KNOWN_EVENT_KINDS,
  type KnownEventKind,
  type TemplateDetailResponse,
  type TemplateLocale,
  type TemplateOverrideRow,
  type TemplateUpsertBody,
} from './types';
