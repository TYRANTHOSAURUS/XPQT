import { useId, useMemo } from 'react';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useRoles } from '@/api/roles';
import { useOrgNodes } from '@/api/org-nodes';
import type {
  ApprovalConfig,
  RuleTemplate,
  RuleTemplateParamSpec,
} from '@/api/room-booking-rules';

export type TemplateParamValues = Record<string, unknown>;

interface RuleTemplateParamsFormProps {
  template: RuleTemplate;
  values: TemplateParamValues;
  onChange: (next: TemplateParamValues) => void;
}

/**
 * Per-template parameter editor. Renders the right Field shape for each param
 * spec type, all wrapped in a single FieldGroup so the template editor dialog
 * reads as one cohesive form. Required-but-missing values are surfaced by the
 * dialog before save (we don't render per-field error text here — there's no
 * server validation step, only "is this present").
 */
export function RuleTemplateParamsForm({
  template,
  values,
  onChange,
}: RuleTemplateParamsFormProps) {
  if (template.paramSpecs.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
        This template has no parameters. The compiled predicate is fixed.
      </div>
    );
  }

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <FieldGroup>
      {template.paramSpecs.map((spec) => (
        <ParamField key={spec.key} spec={spec} value={values[spec.key]} onChange={(v) => set(spec.key, v)} />
      ))}
    </FieldGroup>
  );
}

interface ParamFieldProps {
  spec: RuleTemplateParamSpec;
  value: unknown;
  onChange: (next: unknown) => void;
}

function ParamField({ spec, value, onChange }: ParamFieldProps) {
  const id = useId();
  const labelText = spec.required ? `${spec.label} *` : spec.label;

  switch (spec.type) {
    case 'role_ids':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <RolePickerMulti
            id={id}
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={onChange}
          />
          {spec.description && <FieldDescription>{spec.description}</FieldDescription>}
        </Field>
      );
    case 'org_node_id':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <OrgNodePickerSingle
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
          />
          {spec.description && <FieldDescription>{spec.description}</FieldDescription>}
        </Field>
      );
    case 'calendar_id':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="business_hours_default"
          />
          <FieldDescription>
            {spec.description ??
              'A configured business-hours calendar key. Calendars admin UI ships separately; for now, paste the calendar id.'}
          </FieldDescription>
        </Field>
      );
    case 'interval_minutes':
    case 'attendee_count':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            type="number"
            min={0}
            inputMode="numeric"
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(Number.isFinite(n) ? n : '');
            }}
            placeholder={spec.default !== undefined ? String(spec.default) : '0'}
            className="w-[180px]"
          />
          {spec.description && <FieldDescription>{spec.description}</FieldDescription>}
        </Field>
      );
    case 'factor':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            type="number"
            step="0.05"
            min={0.5}
            max={5}
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange(Number.isFinite(n) ? n : '');
            }}
            placeholder={spec.default !== undefined ? String(spec.default) : '1.2'}
            className="w-[140px]"
          />
          <FieldDescription>
            {spec.description ?? 'Multiplier on the room\'s capacity. 1.2 = "20% over capacity is OK".'}
          </FieldDescription>
        </Field>
      );
    case 'mode': {
      const options = (spec.enum ?? []).map((v) => String(v));
      const current = typeof value === 'string' ? value : (spec.default as string | undefined) ?? options[0] ?? '';
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Select<string> value={current} onValueChange={(next) => next && onChange(next)}>
            <SelectTrigger id={id} className="w-[220px]">
              <SelectValue placeholder="Pick a mode…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {modeLabel(opt)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {spec.description && <FieldDescription>{spec.description}</FieldDescription>}
        </Field>
      );
    }
    case 'denial_message':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Textarea
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="What employees see when this rule blocks their booking."
            rows={3}
          />
          <FieldDescription>
            {spec.description ??
              "Self-explaining denial. Shown in the portal and in Outlook decline emails. Optional — a sensible default is used if blank."}
          </FieldDescription>
        </Field>
      );
    case 'approval_config':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <ApprovalConfigInline
            id={id}
            value={(value as ApprovalConfig | null | undefined) ?? null}
            onChange={onChange}
          />
          <FieldDescription>
            {spec.description ??
              'Configure approvers for this rule. If omitted, the request type\'s default approver chain is used.'}
          </FieldDescription>
        </Field>
      );
    default:
      return null;
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'deny':
      return 'Deny';
    case 'warn':
      return 'Warn (allow)';
    case 'require_approval':
      return 'Require approval';
    case 'allow_override':
      return 'Allow override';
    default:
      return mode;
  }
}

/* -------------------------------------------------------------------------- */
/* Multi-role chip picker                                                     */
/* -------------------------------------------------------------------------- */

function RolePickerMulti({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { data: roles, isLoading } = useRoles();

  const sorted = useMemo(() => [...(roles ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [roles]);

  const toggle = (roleId: string) => {
    const next = value.includes(roleId) ? value.filter((r) => r !== roleId) : [...value, roleId];
    onChange(next);
  };

  if (isLoading) {
    return (
      <div id={id} className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Loading roles…
      </div>
    );
  }

  return (
    <div
      id={id}
      className="flex max-h-48 flex-col overflow-auto rounded-md border bg-background"
    >
      {sorted.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No roles yet.</div>
      ) : (
        sorted.map((role) => {
          const checked = value.includes(role.id);
          return (
            <Field
              key={role.id}
              orientation="horizontal"
              className="px-3 py-2 hover:bg-muted/40 cursor-pointer"
              onClick={() => toggle(role.id)}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={() => toggle(role.id)}
                onClick={(e) => e.stopPropagation()}
                id={`${id}-${role.id}`}
              />
              <FieldLabel htmlFor={`${id}-${role.id}`} className="font-normal">
                <div className="flex flex-col">
                  <span>{role.name}</span>
                  {role.description && (
                    <span className="text-xs text-muted-foreground">{role.description}</span>
                  )}
                </div>
              </FieldLabel>
            </Field>
          );
        })
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Single org-node picker                                                     */
/* -------------------------------------------------------------------------- */

function OrgNodePickerSingle({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const { data: nodes, isLoading } = useOrgNodes();
  const sorted = useMemo(() => [...(nodes ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [nodes]);

  return (
    <Select<string> value={value} onValueChange={(v) => onChange(v ?? '')} disabled={isLoading}>
      <SelectTrigger id={id} className="w-[280px]">
        <SelectValue placeholder={isLoading ? 'Loading…' : 'Pick an org node…'} />
      </SelectTrigger>
      <SelectContent>
        {sorted.map((n) => (
          <SelectItem key={n.id} value={n.id}>
            {n.name}
            {n.code && <span className="text-xs text-muted-foreground"> · {n.code}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* -------------------------------------------------------------------------- */
/* Approval-config (inline minimal form)                                      */
/* -------------------------------------------------------------------------- */

function ApprovalConfigInline({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ApprovalConfig | null;
  onChange: (next: ApprovalConfig | null) => void;
}) {
  const threshold = value?.threshold ?? 'all';
  const approvers = value?.required_approvers ?? [];

  const setThreshold = (next: 'all' | 'any') => {
    onChange({ threshold: next, required_approvers: approvers });
  };

  return (
    <div id={id} className="flex flex-col gap-2 rounded-md border bg-background p-3">
      <Field orientation="horizontal">
        <FieldLabel htmlFor={`${id}-threshold`} className="font-normal">
          Threshold
        </FieldLabel>
        <Select<string> value={threshold} onValueChange={(v) => v && setThreshold(v as 'all' | 'any')}>
          <SelectTrigger id={`${id}-threshold`} className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone must approve</SelectItem>
            <SelectItem value="any">Any one is enough</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <p className="text-xs text-muted-foreground">
        Detailed approver picker (per-team, per-person) lands with the approval policy editor. For now,
        this rule will fall back to the request type's default approver chain.
      </p>
    </div>
  );
}
