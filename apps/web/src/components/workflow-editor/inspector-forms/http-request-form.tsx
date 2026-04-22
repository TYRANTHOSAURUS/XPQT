import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';

type Headers = Record<string, string>;

export function HttpRequestForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as {
    method?: string;
    url?: string;
    headers?: Headers;
    body?: string;
    save_response_as?: string;
  };
  const headers = c.headers ?? {};
  const headerEntries = Object.entries(headers);

  const updateHeader = (oldKey: string, newKey: string, value: string) => {
    const next: Headers = {};
    for (const [k, v] of headerEntries) {
      if (k === oldKey) {
        if (newKey) next[newKey] = value;
      } else {
        next[k] = v;
      }
    }
    update(node.id, { headers: next });
  };

  const addHeader = () => update(node.id, { headers: { ...headers, '': '' } });
  const removeHeader = (key: string) => {
    const next = { ...headers };
    delete next[key];
    update(node.id, { headers: next });
  };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`http-${node.id}-method`} className="text-xs">Method</FieldLabel>
        <Select
          value={c.method ?? 'POST'}
          onValueChange={(v) => update(node.id, { method: v ?? 'POST' })}
          disabled={readOnly}
        >
          <SelectTrigger id={`http-${node.id}-method`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor={`http-${node.id}-url`} className="text-xs">URL</FieldLabel>
        <Input
          id={`http-${node.id}-url`}
          value={c.url ?? ''}
          onChange={(e) => update(node.id, { url: e.target.value })}
          placeholder="https://api.example.com/notify"
          disabled={readOnly}
        />
        <FieldDescription>Supports <code>{'{{ticket.field}}'}</code> substitution.</FieldDescription>
      </Field>

      <FieldSet>
        <FieldLegend variant="label" className="text-xs">Headers</FieldLegend>
        {headerEntries.map(([k, v], i) => (
          <div key={i} className="flex gap-1">
            <Input
              value={k}
              placeholder="Header"
              onChange={(e) => updateHeader(k, e.target.value, v)}
              disabled={readOnly}
              className="flex-1"
            />
            <Input
              value={v}
              placeholder="Value"
              onChange={(e) => updateHeader(k, k, e.target.value)}
              disabled={readOnly}
              className="flex-1"
            />
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => removeHeader(k)} disabled={readOnly}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addHeader} disabled={readOnly} className="gap-1 w-fit">
          <Plus className="h-3.5 w-3.5" /> Add header
        </Button>
      </FieldSet>

      <Field>
        <FieldLabel htmlFor={`http-${node.id}-body`} className="text-xs">Body (JSON or text)</FieldLabel>
        <Textarea
          id={`http-${node.id}-body`}
          value={c.body ?? ''}
          onChange={(e) => update(node.id, { body: e.target.value })}
          rows={6}
          className="font-mono text-xs"
          placeholder={'{\n  "title": "{{ticket.title}}"\n}'}
          disabled={readOnly}
        />
        <FieldDescription>
          Ignored for GET. Supports <code>{'{{ticket.field}}'}</code>.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={`http-${node.id}-save`} className="text-xs">
          Save response as (optional)
        </FieldLabel>
        <Input
          id={`http-${node.id}-save`}
          value={c.save_response_as ?? ''}
          onChange={(e) => update(node.id, { save_response_as: e.target.value })}
          placeholder="e.g. external_ticket"
          disabled={readOnly}
        />
        <FieldDescription>
          Stores the parsed JSON response at <code>context.&lt;key&gt;</code> for later nodes.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
