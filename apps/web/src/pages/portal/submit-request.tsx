import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ArrowLeft, Send, CheckCircle } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { useAuth } from '@/providers/auth-provider';
import { apiFetch } from '@/lib/api';

interface RequestType {
  id: string;
  name: string;
  domain: string;
  form_schema_id: string | null;
}

interface FormField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
}

interface FormSchemaEntity {
  id: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

export function SubmitRequestPage() {
  const navigate = useNavigate();
  const { categoryId } = useParams();
  const { person } = useAuth();
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [requestTypeId, setRequestTypeId] = useState('');
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});

  const { data: requestTypes } = useApi<RequestType[]>(
    `/request-types${categoryId ? `?domain=${categoryId}` : ''}`,
    [categoryId],
  );

  // Fetch form schema when request type changes
  useEffect(() => {
    if (!requestTypeId || !requestTypes) { setFormFields([]); return; }
    const rt = requestTypes.find((r) => r.id === requestTypeId);
    if (!rt?.form_schema_id) { setFormFields([]); return; }
    apiFetch<FormSchemaEntity>(`/config-entities/${rt.form_schema_id}`)
      .then((entity) => {
        const fields = entity.current_version?.definition?.fields ?? [];
        setFormFields(fields);
        setFormData({});
      })
      .catch(() => setFormFields([]));
  }, [requestTypeId, requestTypes]);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);

    try {
      await apiFetch('/tickets', {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          priority,
          ticket_type_id: requestTypeId || undefined,
          requester_person_id: person?.id,
          source_channel: 'portal',
          form_data: Object.keys(formData).length > 0 ? formData : undefined,
        }),
      });
      setSubmitted(true);
    } catch {
      // TODO: error handling
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
        <h1 className="text-2xl font-bold">Request Submitted</h1>
        <p className="text-muted-foreground mt-2">
          Your request has been submitted and our team will get back to you shortly.
        </p>
        <div className="flex gap-3 justify-center mt-8">
          <Button variant="outline" onClick={() => navigate('/portal/my-requests')}>
            View My Requests
          </Button>
          <Button onClick={() => navigate('/portal')}>
            Submit Another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Button variant="ghost" className="mb-4 -ml-2" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> Back
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Submit a Request</CardTitle>
          <CardDescription>Describe your issue or request and we'll route it to the right team</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Request type */}
          {requestTypes && requestTypes.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="request-type">Request Type</Label>
              <Select value={requestTypeId} onValueChange={(v) => setRequestTypeId(v ?? '')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a request type..." />
                </SelectTrigger>
                <SelectContent>
                  {requestTypes.map((rt) => (
                    <SelectItem key={rt.id} value={rt.id}>{rt.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              placeholder="Brief summary of your request..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Provide details about your request..."
              className="min-h-[120px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <Label htmlFor="priority">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v ?? 'medium')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low — not urgent</SelectItem>
                <SelectItem value="medium">Medium — normal priority</SelectItem>
                <SelectItem value="high">High — needs attention soon</SelectItem>
                <SelectItem value="critical">Critical — blocking my work</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Dynamic form fields from form schema */}
          {formFields.map((field) => (
            <div key={field.id} className="space-y-2">
              <Label>
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </Label>
              {field.help_text && <p className="text-xs text-muted-foreground">{field.help_text}</p>}
              {(field.type === 'text' || field.type === 'number' || field.type === 'date' || field.type === 'datetime') && (
                <Input
                  type={field.type === 'datetime' ? 'datetime-local' : field.type}
                  placeholder={field.placeholder}
                  value={formData[field.id] ?? ''}
                  onChange={(e) => setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))}
                />
              )}
              {field.type === 'textarea' && (
                <Textarea
                  placeholder={field.placeholder}
                  value={formData[field.id] ?? ''}
                  onChange={(e) => setFormData((prev) => ({ ...prev, [field.id]: e.target.value }))}
                />
              )}
              {(field.type === 'dropdown' || field.type === 'multi_select') && field.options && (
                <Select value={formData[field.id] ?? ''} onValueChange={(v) => setFormData((prev) => ({ ...prev, [field.id]: v ?? '' }))}>
                  <SelectTrigger><SelectValue placeholder={field.placeholder ?? 'Select...'} /></SelectTrigger>
                  <SelectContent>
                    {field.options.map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {field.type === 'checkbox' && (
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData[field.id] === 'true'}
                    onChange={(e) => setFormData((prev) => ({ ...prev, [field.id]: String(e.target.checked) }))}
                    className="rounded border-input"
                  />
                  <span className="text-sm">{field.placeholder}</span>
                </div>
              )}
            </div>
          ))}

          {/* Submit */}
          <div className="flex justify-end pt-2">
            <Button onClick={handleSubmit} disabled={!title.trim() || submitting}>
              <Send className="h-4 w-4 mr-2" />
              {submitting ? 'Submitting...' : 'Submit Request'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
