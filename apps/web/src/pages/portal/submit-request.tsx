import { useState } from 'react';
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

interface RequestType {
  id: string;
  name: string;
  domain: string;
}

export function SubmitRequestPage() {
  const navigate = useNavigate();
  const { categoryId } = useParams();
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [requestTypeId, setRequestTypeId] = useState('');

  const { data: requestTypes } = useApi<RequestType[]>(
    `/request-types${categoryId ? `?domain=${categoryId}` : ''}`,
    [categoryId],
  );

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);

    try {
      await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          priority,
          ticket_type_id: requestTypeId || undefined,
          requester_person_id: 'a0000000-0000-0000-0000-000000000001', // TODO: from auth context
          source_channel: 'portal',
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

          {/* TODO: Dynamic form fields based on request type's form schema */}

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
