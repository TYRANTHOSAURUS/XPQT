import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useTestWebhook } from '@/api/webhooks';

interface WebhookTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhookId: string;
}

export function WebhookTestDialog({ open, onOpenChange, webhookId }: WebhookTestDialogProps) {
  const test = useTestWebhook();
  const [payload, setPayload] = useState(
    '{\n  "issue": { "title": "Example" }\n}',
  );
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; dto?: unknown; error?: string } | null>(null);

  const run = () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    setParseError(null);
    test.mutate(
      { id: webhookId, payload: parsed },
      {
        onSuccess: (res) => setResult(res),
        onError: (err) => setResult({ ok: false, error: err.message }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Test payload</DialogTitle>
          <DialogDescription>
            Runs mapping without creating a ticket. Shows the resulting ticket draft or a mapping error.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={parseError ? 'true' : undefined}>
            <FieldLabel htmlFor="wh-test-payload">Sample payload (JSON)</FieldLabel>
            <Textarea
              id="wh-test-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={10}
              className="font-mono text-xs"
            />
            <FieldDescription>
              Paste a payload from the source system. Mapping runs against it here the same way it
              would on a real event.
            </FieldDescription>
            {parseError && <FieldError>{parseError}</FieldError>}
          </Field>
        </FieldGroup>

        {result && (
          <div className="rounded-md border bg-muted/30 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              {result.ok ? (
                <>
                  <Check className="size-4 text-green-600" /> Mapping OK
                </>
              ) : (
                <>
                  <X className="size-4 text-red-600" /> Mapping failed
                </>
              )}
            </div>
            {result.error && <div className="text-sm text-red-600">{result.error}</div>}
            {result.dto !== undefined && (
              <pre className="font-mono text-xs overflow-x-auto">
                {JSON.stringify(result.dto, null, 2)}
              </pre>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={run} disabled={test.isPending}>
            {test.isPending ? 'Testing…' : 'Run test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
