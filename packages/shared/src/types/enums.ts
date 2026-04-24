// Core enums shared across frontend and backend

export const StatusCategory = {
  NEW: 'new',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  WAITING: 'waiting',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
} as const;
export type StatusCategory = (typeof StatusCategory)[keyof typeof StatusCategory];

export const WaitingReason = {
  REQUESTER: 'requester',
  VENDOR: 'vendor',
  APPROVAL: 'approval',
  SCHEDULED_WORK: 'scheduled_work',
  OTHER: 'other',
} as const;
export type WaitingReason = (typeof WaitingReason)[keyof typeof WaitingReason];

export const InteractionMode = {
  INTERNAL: 'internal',
  EXTERNAL: 'external',
} as const;
export type InteractionMode = (typeof InteractionMode)[keyof typeof InteractionMode];

export const AssetRole = {
  FIXED: 'fixed',
  PERSONAL: 'personal',
  POOLED: 'pooled',
} as const;
export type AssetRole = (typeof AssetRole)[keyof typeof AssetRole];

export const AssignmentType = {
  PERMANENT: 'permanent',
  TEMPORARY: 'temporary',
} as const;
export type AssignmentType = (typeof AssignmentType)[keyof typeof AssignmentType];

export const ActivityType = {
  INTERNAL_NOTE: 'internal_note',
  EXTERNAL_COMMENT: 'external_comment',
  SYSTEM_EVENT: 'system_event',
} as const;
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

export const Visibility = {
  INTERNAL: 'internal',
  EXTERNAL: 'external',
  SYSTEM: 'system',
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

export const ApprovalStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DELEGATED: 'delegated',
  EXPIRED: 'expired',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const WorkflowInstanceStatus = {
  ACTIVE: 'active',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type WorkflowInstanceStatus = (typeof WorkflowInstanceStatus)[keyof typeof WorkflowInstanceStatus];

export const ConfigStatus = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
} as const;
export type ConfigStatus = (typeof ConfigStatus)[keyof typeof ConfigStatus];

export const OrderStatus = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  CONFIRMED: 'confirmed',
  FULFILLED: 'fulfilled',
  CANCELLED: 'cancelled',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const FulfillmentStatus = {
  ORDERED: 'ordered',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
} as const;
export type FulfillmentStatus = (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

export const CatalogCategory = {
  FOOD_AND_DRINKS: 'food_and_drinks',
  EQUIPMENT: 'equipment',
  SUPPLIES: 'supplies',
  SERVICES: 'services',
} as const;
export type CatalogCategory = (typeof CatalogCategory)[keyof typeof CatalogCategory];

export const CatalogUnit = {
  PER_PERSON: 'per_person',
  PER_ITEM: 'per_item',
  FLAT_RATE: 'flat_rate',
} as const;
export type CatalogUnit = (typeof CatalogUnit)[keyof typeof CatalogUnit];

export const PersonType = {
  EMPLOYEE: 'employee',
  VISITOR: 'visitor',
  CONTRACTOR: 'contractor',
  VENDOR_CONTACT: 'vendor_contact',
  TEMPORARY_WORKER: 'temporary_worker',
} as const;
export type PersonType = (typeof PersonType)[keyof typeof PersonType];

export const SpaceType = {
  SITE: 'site',
  BUILDING: 'building',
  WING: 'wing',
  FLOOR: 'floor',
  ROOM: 'room',
  DESK: 'desk',
  MEETING_ROOM: 'meeting_room',
  COMMON_AREA: 'common_area',
  STORAGE_ROOM: 'storage_room',
  TECHNICAL_ROOM: 'technical_room',
  PARKING_SPACE: 'parking_space',
} as const;
export type SpaceType = (typeof SpaceType)[keyof typeof SpaceType];

export const WorkflowNodeType = {
  TRIGGER: 'trigger',
  CONDITION: 'condition',
  ASSIGN: 'assign',
  CREATE_CHILD_TASKS: 'create_child_tasks',
  APPROVAL: 'approval',
  WAIT_FOR: 'wait_for',
  TIMER: 'timer',
  NOTIFICATION: 'notification',
  UPDATE_TICKET: 'update_ticket',
  END: 'end',
} as const;
export type WorkflowNodeType = (typeof WorkflowNodeType)[keyof typeof WorkflowNodeType];

export const AssetLifecycleState = {
  PROCURED: 'procured',
  ACTIVE: 'active',
  MAINTENANCE: 'maintenance',
  RETIRED: 'retired',
  DISPOSED: 'disposed',
} as const;
export type AssetLifecycleState = (typeof AssetLifecycleState)[keyof typeof AssetLifecycleState];

export const NotificationChannel = {
  EMAIL: 'email',
  IN_APP: 'in_app',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];
