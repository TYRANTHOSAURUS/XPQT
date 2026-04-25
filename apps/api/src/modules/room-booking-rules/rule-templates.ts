import { BadRequestException } from '@nestjs/common';
import type { ApprovalConfig, Predicate, RuleEffect } from './dto';

/**
 * Twelve starter templates for the room-booking rules editor (spec §4.7).
 * Each template owns:
 *  - a stable `id` (string, never changed)
 *  - a `paramSchema` describing the inputs the editor renders
 *  - a `compile(params)` that produces a concrete `applies_when` predicate
 *    + the chosen effect + (optional) denial_message
 *
 * Why TS objects, not JSON Schema? The compile output is the contract — the
 * paramSchema is just for the admin form. A full JSON-Schema dependency adds
 * weight without buying us anything; a tiny in-house shape suffices and we
 * validate at compile time.
 */

export type TemplateParamType = 'role_ids' | 'org_node_id' | 'calendar_id' | 'interval_minutes' | 'attendee_count' | 'factor' | 'mode' | 'approval_config' | 'denial_message';

export interface TemplateParamSpec {
  key: string;
  type: TemplateParamType;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}

export interface CompiledRule {
  applies_when: Predicate;
  effect: RuleEffect;
  denial_message?: string | null;
  approval_config?: ApprovalConfig | null;
  /** Default name suggested by the template (admin can override). */
  suggested_name?: string;
}

export interface TemplateDefinition {
  id: string;
  label: string;
  description: string;
  effect_hint: RuleEffect;
  paramSpecs: TemplateParamSpec[];
  compile(params: Record<string, unknown>): CompiledRule;
}

function requireParam<T>(params: Record<string, unknown>, key: string): T {
  if (params[key] === undefined || params[key] === null || params[key] === '') {
    throw new BadRequestException(`template parameter '${key}' is required`);
  }
  return params[key] as T;
}

function toNumber(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestException(`'${label}' must be a finite number`);
  return n;
}

function toStringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new BadRequestException(`'${label}' must be a string array`);
  }
  return v as string[];
}

export const RULE_TEMPLATES: TemplateDefinition[] = [
  {
    id: 'restrict_to_roles',
    label: 'Restrict to roles',
    description: 'Deny bookings unless the requester holds one of the listed roles.',
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'role_ids', type: 'role_ids', label: 'Allowed roles', required: true },
      { key: 'denial_message', type: 'denial_message', label: 'Denial message', required: false },
    ],
    compile(params) {
      const roleIds = toStringArray(requireParam(params, 'role_ids'), 'role_ids');
      const denialMessage = (params.denial_message as string) ?? 'This room is restricted to specific roles.';
      // requester.role_ids is itself an array. The engine's `in` op checks
      // membership of a scalar in an array; for "any of requester.role_ids
      // is in roleIds" we use the dedicated fn `array_intersects`.
      return {
        applies_when: {
          not: {
            fn: 'array_intersects',
            args: ['$.requester.role_ids', roleIds],
          },
        } as Predicate,
        effect: 'deny',
        denial_message: denialMessage,
        suggested_name: 'Restrict to roles',
      };
    },
  },
  {
    id: 'restrict_to_org_subtree',
    label: 'Restrict to org subtree',
    description: 'Deny bookings unless the requester sits within the chosen org subtree.',
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'org_node_id', type: 'org_node_id', label: 'Org root', required: true },
      { key: 'denial_message', type: 'denial_message', label: 'Denial message', required: false },
    ],
    compile(params) {
      const root = requireParam<string>(params, 'org_node_id');
      const denialMessage =
        (params.denial_message as string) ??
        'This room is restricted to a specific part of the organisation.';
      return {
        applies_when: {
          not: {
            fn: 'in_org_descendants',
            args: ['$.requester.org_node_id', root],
          },
        } as Predicate,
        effect: 'deny',
        denial_message: denialMessage,
        suggested_name: 'Restrict to org subtree',
      };
    },
  },
  {
    id: 'off_hours_need_approval',
    label: 'Off-hours need approval',
    description: 'Require approval when the booking starts outside business hours.',
    effect_hint: 'require_approval',
    paramSpecs: [
      { key: 'calendar_id', type: 'calendar_id', label: 'Business-hours calendar', required: true },
      { key: 'approval_config', type: 'approval_config', label: 'Approvers', required: false },
    ],
    compile(params) {
      const calId = requireParam<string>(params, 'calendar_id');
      const approvalConfig = (params.approval_config as ApprovalConfig | undefined) ?? null;
      return {
        applies_when: {
          not: { fn: 'in_business_hours', args: ['$.booking.start_at', calId] },
        } as Predicate,
        effect: 'require_approval',
        approval_config: approvalConfig,
        suggested_name: 'Off-hours need approval',
      };
    },
  },
  {
    id: 'min_lead_time',
    label: 'Minimum lead time',
    description: 'Deny bookings made less than N minutes before the start time.',
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'interval_minutes', type: 'interval_minutes', label: 'Minimum lead (minutes)', required: true },
      { key: 'denial_message', type: 'denial_message', label: 'Denial message', required: false },
    ],
    compile(params) {
      const minutes = toNumber(requireParam(params, 'interval_minutes'), 'interval_minutes');
      const denialMessage =
        (params.denial_message as string) ??
        `This room requires at least ${minutes} minutes' lead time.`;
      return {
        applies_when: {
          fn: 'lead_minutes_lt',
          args: ['$.booking.start_at', minutes],
        } as Predicate,
        effect: 'deny',
        denial_message: denialMessage,
        suggested_name: `Minimum lead time (${minutes} min)`,
      };
    },
  },
  {
    id: 'max_lead_time',
    label: 'Maximum lead time',
    description: 'Deny bookings made more than N minutes in advance.',
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'interval_minutes', type: 'interval_minutes', label: 'Maximum lead (minutes)', required: true },
      { key: 'denial_message', type: 'denial_message', label: 'Denial message', required: false },
    ],
    compile(params) {
      const minutes = toNumber(requireParam(params, 'interval_minutes'), 'interval_minutes');
      return {
        applies_when: {
          fn: 'lead_minutes_gt',
          args: ['$.booking.start_at', minutes],
        } as Predicate,
        effect: 'deny',
        denial_message:
          (params.denial_message as string) ??
          `This room cannot be booked more than ${minutes} minutes in advance.`,
        suggested_name: `Maximum lead time (${minutes} min)`,
      };
    },
  },
  {
    id: 'max_duration',
    label: 'Maximum duration',
    description: 'Deny bookings longer than N minutes.',
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'interval_minutes', type: 'interval_minutes', label: 'Maximum duration (minutes)', required: true },
      { key: 'denial_message', type: 'denial_message', label: 'Denial message', required: false },
    ],
    compile(params) {
      const minutes = toNumber(requireParam(params, 'interval_minutes'), 'interval_minutes');
      return {
        applies_when: {
          fn: 'duration_minutes_gt',
          args: ['$.booking.start_at', '$.booking.end_at', minutes],
        } as Predicate,
        effect: 'deny',
        denial_message:
          (params.denial_message as string) ??
          `This room can be booked for at most ${minutes} minutes.`,
        suggested_name: `Max duration (${minutes} min)`,
      };
    },
  },
  {
    id: 'capacity_tolerance',
    label: 'Capacity tolerance',
    description:
      "Treat over-capacity bookings (attendees > capacity × factor) per the chosen mode.",
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'factor', type: 'factor', label: 'Tolerance factor', required: true, default: 1.2 },
      {
        key: 'mode',
        type: 'mode',
        label: 'When over-capacity',
        required: true,
        enum: ['deny', 'warn', 'require_approval'],
        default: 'warn',
      },
      { key: 'denial_message', type: 'denial_message', label: 'Message', required: false },
      { key: 'approval_config', type: 'approval_config', label: 'Approvers (if approval)', required: false },
    ],
    compile(params) {
      const factor = toNumber(requireParam(params, 'factor'), 'factor');
      const mode = String(requireParam(params, 'mode')) as RuleEffect;
      if (!['deny', 'warn', 'require_approval'].includes(mode)) {
        throw new BadRequestException(`mode must be deny, warn, or require_approval`);
      }
      // attendee_count > capacity * factor
      // We build that as: attendee_count * 1 > capacity * factor (no left-side
      // arithmetic in the engine, so we compute capacity * factor as a
      // dynamic right by using `gt` with attendee_count and an evaluated
      // capacity-times-factor expression. We don't have arithmetic ops, so
      // we instead express as: NOT (attendee_count <= capacity*factor),
      // which still requires an op to multiply. Pragmatic shortcut: encode
      // the factor in a dedicated fn-shaped predicate so capacity is fetched
      // at runtime. Simpler: introduce a tiny inline form using lte against
      // the precomputed `capacity * factor` after the resolver fills it on
      // the context. The resolver computes `space.capacity_x_factor` =
      // capacity * factor right before evaluation. Predicate stays simple.
      // For now, we encode via a fn-style predicate that the engine knows.
      // (To avoid adding a fn we'll use an op + a synthetic context value
      // computed on the fly; see resolver.)
      // We use op:gt against $.space.__capacity_threshold which the resolver
      // recomputes for each rule using the rule's own factor. Simpler path:
      // keep the factor in the predicate value, and let the engine compare
      // against attendee_count. We use a small math helper via fn.
      return {
        applies_when: {
          fn: 'attendees_over_capacity_factor',
          args: ['$.booking.attendee_count', '$.space.capacity', factor],
        } as Predicate,
        effect: mode,
        denial_message:
          (params.denial_message as string) ??
          (mode === 'deny'
            ? `This room cannot be booked above ${Math.round(factor * 100)}% capacity.`
            : null),
        approval_config: (params.approval_config as ApprovalConfig | undefined) ?? null,
        suggested_name: `Capacity tolerance (×${factor})`,
      };
    },
  },
  {
    id: 'long_bookings_need_manager_approval',
    label: 'Long bookings need approval',
    description: 'Require approval when a booking exceeds N minutes in length.',
    effect_hint: 'require_approval',
    paramSpecs: [
      { key: 'interval_minutes', type: 'interval_minutes', label: 'Threshold (minutes)', required: true },
      { key: 'approval_config', type: 'approval_config', label: 'Approvers', required: false },
    ],
    compile(params) {
      const minutes = toNumber(requireParam(params, 'interval_minutes'), 'interval_minutes');
      return {
        applies_when: {
          fn: 'duration_minutes_gt',
          args: ['$.booking.start_at', '$.booking.end_at', minutes],
        } as Predicate,
        effect: 'require_approval',
        approval_config: (params.approval_config as ApprovalConfig | undefined) ?? null,
        suggested_name: `Long bookings (>${minutes} min) need approval`,
      };
    },
  },
  {
    id: 'high_capacity_needs_vp_approval',
    label: 'High-attendee bookings need approval',
    description: 'Require approval when the attendee count exceeds N.',
    effect_hint: 'require_approval',
    paramSpecs: [
      { key: 'attendee_threshold', type: 'attendee_count', label: 'Attendee threshold', required: true },
      { key: 'approval_config', type: 'approval_config', label: 'Approvers', required: false },
    ],
    compile(params) {
      const threshold = toNumber(requireParam(params, 'attendee_threshold'), 'attendee_threshold');
      return {
        applies_when: {
          op: 'gt',
          left: '$.booking.attendee_count',
          right: threshold,
        } as Predicate,
        effect: 'require_approval',
        approval_config: (params.approval_config as ApprovalConfig | undefined) ?? null,
        suggested_name: `Bookings above ${threshold} attendees need approval`,
      };
    },
  },
  {
    id: 'capacity_floor',
    label: 'Capacity floor',
    description:
      "Deny bookings with fewer attendees than the room's `min_attendees`. Only fires when min_attendees is set on the room.",
    effect_hint: 'deny',
    paramSpecs: [
      { key: 'denial_message', type: 'denial_message', label: 'Denial message', required: false },
    ],
    compile(params) {
      return {
        applies_when: {
          fn: 'attendees_below_min',
          args: ['$.booking.attendee_count', '$.space.min_attendees'],
        } as Predicate,
        effect: 'deny',
        denial_message:
          (params.denial_message as string) ??
          'This room has a minimum-attendee requirement and your booking is below it.',
        suggested_name: 'Capacity floor',
      };
    },
  },
  {
    id: 'soft_over_capacity_warning',
    label: 'Soft over-capacity warning',
    description: 'Warn (without blocking) when attendee_count exceeds the room capacity.',
    effect_hint: 'warn',
    paramSpecs: [],
    compile() {
      return {
        applies_when: {
          op: 'gt',
          left: '$.booking.attendee_count',
          right: '$.space.capacity',
        } as Predicate,
        effect: 'warn',
        denial_message: null,
        suggested_name: 'Soft over-capacity warning',
      };
    },
  },
  {
    id: 'service_desk_override_allow',
    label: 'Service-desk override',
    description:
      "Marks the booking as overridable when the requester (or actor) holds the `rooms.override_rules` permission.",
    effect_hint: 'allow_override',
    paramSpecs: [],
    compile() {
      return {
        applies_when: {
          fn: 'has_permission',
          args: ['rooms.override_rules'],
        } as Predicate,
        effect: 'allow_override',
        denial_message: null,
        suggested_name: 'Service-desk override',
      };
    },
  },
];

const TEMPLATE_BY_ID = new Map(RULE_TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): TemplateDefinition {
  const t = TEMPLATE_BY_ID.get(id);
  if (!t) throw new BadRequestException(`unknown template_id: ${id}`);
  return t;
}

export function listTemplates(): Array<Omit<TemplateDefinition, 'compile'>> {
  return RULE_TEMPLATES.map(({ id, label, description, effect_hint, paramSpecs }) => ({
    id,
    label,
    description,
    effect_hint,
    paramSpecs,
  }));
}
