// Inbox API barrel — re-export the public surface for the per-user
// notification feed. See ./keys.ts for the key-factory shape and ./queries.ts
// + ./mutations.ts for hooks. Wire-shape types live in ./types.ts.

export { inboxKeys, type InboxListArgs } from './keys';
export {
  useInbox,
  useInboxInfinite,
  useInboxCount,
  inboxListOptions,
  inboxCountOptions,
} from './queries';
export { useMarkInboxRead, useMarkAllInboxRead } from './mutations';
export type {
  InboxItemDto,
  InboxListResponse,
  InboxCountResponse,
  InboxMarkReadResponse,
  InboxMarkAllReadResponse,
} from './types';
export { INBOX_DEFAULT_LIMIT } from './types';
