import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Plus, Send, Search } from 'lucide-react';
import { useApi } from '@/hooks/use-api';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  department: string;
}

interface RequestType {
  id: string;
  name: string;
  domain: string;
}

export function CreateTicketDialog({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [requesterSearch, setRequesterSearch] = useState('');
  const [selectedRequester, setSelectedRequester] = useState<Person | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [requestTypeId, setRequestTypeId] = useState('');
  const [sourceChannel, setSourceChannel] = useState('phone');

  const { data: requestTypes } = useApi<RequestType[]>('/request-types', []);

  // Simple person search — in production this would be a proper API search endpoint
  const { data: persons } = useApi<Person[]>(
    requesterSearch.length >= 2 ? `/persons?search=${encodeURIComponent(requesterSearch)}` : '',
    [requesterSearch],
  );

  const handleSubmit = async () => {
    if (!title.trim() || !selectedRequester) return;
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
          requester_person_id: selectedRequester.id,
          source_channel: sourceChannel,
        }),
      });

      // Reset form
      setTitle('');
      setDescription('');
      setPriority('medium');
      setRequestTypeId('');
      setSelectedRequester(null);
      setRequesterSearch('');
      setSourceChannel('phone');
      setOpen(false);
      onCreated?.();
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

        <div className="space-y-5 mt-2">
          {/* Requester picker */}
          <div className="space-y-2">
            <Label>Requester</Label>
            {selectedRequester ? (
              <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30">
                <div>
                  <span className="font-medium">{selectedRequester.first_name} {selectedRequester.last_name}</span>
                  <span className="text-sm text-muted-foreground ml-2">{selectedRequester.email}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setSelectedRequester(null); setRequesterSearch(''); }}>
                  Change
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or email..."
                    className="pl-9"
                    value={requesterSearch}
                    onChange={(e) => setRequesterSearch(e.target.value)}
                  />
                </div>
                {persons && persons.length > 0 && (
                  <div className="border rounded-md max-h-40 overflow-auto">
                    {persons.map((person) => (
                      <button
                        key={person.id}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors"
                        onClick={() => { setSelectedRequester(person); setRequesterSearch(''); }}
                      >
                        <span className="font-medium">{person.first_name} {person.last_name}</span>
                        <span className="text-muted-foreground ml-2">{person.email}</span>
                        {person.department && <span className="text-muted-foreground ml-1">· {person.department}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Source channel */}
          <div className="space-y-2">
            <Label>Source</Label>
            <Select value={sourceChannel} onValueChange={(v) => setSourceChannel(v ?? 'phone')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="phone">Phone call</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="walk_in">Walk-in</SelectItem>
                <SelectItem value="portal">Portal</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Request type */}
          {requestTypes && requestTypes.length > 0 && (
            <div className="space-y-2">
              <Label>Request Type</Label>
              <Select value={requestTypeId} onValueChange={(v) => setRequestTypeId(v ?? '')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type..." />
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
            <Label>Title</Label>
            <Input
              placeholder="Brief summary..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              placeholder="Details from the employee..."
              className="min-h-[100px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v ?? 'medium')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={!title.trim() || !selectedRequester || submitting}>
              <Send className="h-4 w-4 mr-2" />
              {submitting ? 'Creating...' : 'Create Ticket'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
