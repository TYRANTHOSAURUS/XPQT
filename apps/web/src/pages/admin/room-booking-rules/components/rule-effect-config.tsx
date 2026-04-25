import { useId } from 'react';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Ban, ShieldCheck, AlertTriangle, KeyRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ApprovalConfig, RuleEffect } from '@/api/room-booking-rules';

interface RuleEffectConfigProps {
  effect: RuleEffect;
  approval_config: ApprovalConfig | null;
  denial_message: string | null;
  onEffectChange: (next: RuleEffect) => void;
  onApprovalConfigChange: (next: ApprovalConfig | null) => void;
  onDenialMessageChange: (next: string | null) => void;
}

/**
 * Effect picker (deny / require_approval / warn / allow_override) plus the
 * approval-config sub-form (only when the effect is `require_approval`) plus
 * the denial-message free-text field. Saves are auto-committed by the parent
 * via field-level handlers — this component is purely presentational.
 */
export function RuleEffectConfig({
  effect,
  approval_config,
  denial_message,
  onEffectChange,
  onApprovalConfigChange,
  onDenialMessageChange,
}: RuleEffectConfigProps) {
  const effectId = useId();
  const denialId = useId();
  const thresholdId = useId();

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={effectId}>Effect</FieldLabel>
        <Select<RuleEffect> value={effect} onValueChange={(v) => v && onEffectChange(v)}>
          <SelectTrigger id={effectId} className="w-[280px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deny">
              <Ban className="size-3.5 text-red-600" /> Deny
            </SelectItem>
            <SelectItem value="require_approval">
              <ShieldCheck className="size-3.5 text-amber-600" /> Require approval
            </SelectItem>
            <SelectItem value="warn">
              <AlertTriangle className="size-3.5 text-yellow-600" /> Warn (allow)
            </SelectItem>
            <SelectItem value="allow_override">
              <KeyRound className="size-3.5 text-emerald-600" /> Allow override
            </SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          What happens when this rule fires. <strong>Deny</strong> blocks; <strong>Require approval</strong>
          {' '}routes to an approver; <strong>Warn</strong> lets the booking through with a heads-up;
          {' '}<strong>Allow override</strong> marks the booking as overridable by service desk.
        </FieldDescription>
      </Field>

      {effect === 'require_approval' && (
        <Field>
          <FieldLabel htmlFor={thresholdId}>Approval threshold</FieldLabel>
          <Select<string>
            value={approval_config?.threshold ?? 'all'}
            onValueChange={(next) =>
              next &&
              onApprovalConfigChange({
                threshold: next as 'all' | 'any',
                required_approvers: approval_config?.required_approvers ?? [],
              })
            }
          >
            <SelectTrigger id={thresholdId} className="w-[260px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone must approve</SelectItem>
              <SelectItem value="any">Any one is enough</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>
            Detailed per-team / per-person approver picker is shipped by the approval policy editor.
            For now, blank required-approvers falls back to the request type's default chain.
          </FieldDescription>
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor={denialId}>Denial message</FieldLabel>
        <Textarea
          id={denialId}
          value={denial_message ?? ''}
          onChange={(e) => onDenialMessageChange(e.target.value || null)}
          rows={3}
          placeholder="What employees see when this rule blocks their booking…"
        />
        <FieldDescription>
          Self-explaining denial: shown in the portal and Outlook decline emails. Empty falls back to a
          generic "request denied" string.
        </FieldDescription>
      </Field>

      <DenialPreview effect={effect} message={denial_message} />
    </FieldGroup>
  );
}

function DenialPreview({
  effect,
  message,
}: {
  effect: RuleEffect;
  message: string | null;
}) {
  if (effect === 'allow_override' || effect === 'warn') return null;
  const previewText =
    message?.trim() ||
    (effect === 'deny'
      ? 'Your booking was denied because it conflicts with a room policy.'
      : 'Your booking needs approval before it is confirmed.');

  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Preview
      </div>
      <div
        className={cn(
          'rounded-md border bg-background p-3 text-sm',
          effect === 'deny'
            ? 'border-red-200 dark:border-red-500/30'
            : 'border-amber-200 dark:border-amber-500/30',
        )}
      >
        {previewText}
      </div>
    </div>
  );
}
