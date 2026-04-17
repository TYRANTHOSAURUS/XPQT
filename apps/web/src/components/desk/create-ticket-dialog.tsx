import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { PersonCombobox, type Person } from '@/components/person-combobox';

interface RequestType {
  id: string;
  name: string;
  domain: string;
}

export function CreateTicketDialog({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [requesterId, setRequesterId] = useState('');
  const [selectedRequester, setSelectedRequester] = useState<Person | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [requestTypeId, setRequestTypeId] = useState('');
  const [sourceChannel, setSourceChannel] = useState('phone');

  const { data: requestTypes } = useApi<RequestType[]>('/request-types', []);

  const handleSubmit = async () => {
    if (!title.trim() || !requesterId) return;
    setSubmitting(true);

    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          priority,
          ticket_type_id: requestTypeId || undefined,
          requester_person_id: requesterId,
          source_channel: sourceChannel,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed: ${res.status}`);
      }

      setTitle('');
      setDescription('');
      setPriority('medium');
      setRequestTypeId('');
      setSelectedRequester(null);
      setRequesterId('');
      setSourceChannel('phone');
      setOpen(false);
      onCreated?.();
      toast.success('Ticket created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create ticket');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" className="gap-2" />}>
        <Plus className="h-4 w-4" /> New Ticket
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Ticket</DialogTitle>
          <DialogDescription>Create a ticket on behalf of an employee</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Requester</Label>
            <PersonCombobox
              value={requesterId}
              onChange={setRequesterId}
              onSelect={setSelectedRequester}
              placeholder="Search by name or email..."
            />
            {selectedRequester && (
              <p className="text-xs text-muted-foreground">
                {selectedRequester.email}
                {selectedRequester.department ? ` · ${selectedRequester.department}` : ''}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-ticket-source">Source</Label>
            <Select value={sourceChannel} onValueChange={(v) => setSourceChannel(v ?? 'phone')}>
              <SelectTrigger id="new-ticket-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="phone">Phone call</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="walk_in">Walk-in</SelectItem>
                <SelectItem value="portal">Portal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {requestTypes && requestTypes.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="new-ticket-type">Request Type</Label>
              <Select value={requestTypeId} onValueChange={(v) => setRequestTypeId(v ?? '')}>
                <SelectTrigger id="new-ticket-type"><SelectValue placeholder="Select type..." /></SelectTrigger>
                <SelectContent>
                  {requestTypes.map((rt) => (
                    <SelectItem key={rt.id} value={rt.id}>{rt.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="new-ticket-title">Title</Label>
            <Input
              id="new-ticket-title"
              placeholder="Brief summary..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-ticket-description">Description</Label>
            <Textarea
              id="new-ticket-description"
              placeholder="Details from the employee..."
              className="min-h-[100px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-ticket-priority">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v ?? 'medium')}>
              <SelectTrigger id="new-ticket-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!title.trim() || !requesterId || submitting}>
            <Send className="h-4 w-4 mr-2" />
            {submitting ? 'Creating...' : 'Create Ticket'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
