import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Plus, Ban } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

interface DelegationUser {
  id: string;
  email: string;
  person: Person | null;
}

interface Delegation {
  id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  starts_at: string;
  ends_at: string;
  active: boolean;
  delegator?: DelegationUser | null;
  delegate?: DelegationUser | null;
}

function getDelegationStatus(d: Delegation): 'active' | 'upcoming' | 'expired' {
  const now = new Date();
  const start = new Date(d.starts_at);
  const end = new Date(d.ends_at);
  if (!d.active) return 'expired';
  if (now < start) return 'upcoming';
  if (now > end) return 'expired';
  return 'active';
}

const statusVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  upcoming: 'outline',
  expired: 'secondary',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function getPersonName(p?: DelegationUser | null) {
  if (!p) return '---';
  if (p.person) return `${p.person.first_name} ${p.person.last_name}`;
  return p.email ?? '---';
}

function DelegationPersonPicker({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!value) {
      setDisplayName('');
      return;
    }
    apiFetch<Person[]>('/persons').then((persons) => {
      const p = persons.find((x) => x.id === value);
      if (p) setDisplayName(`${p.first_name} ${p.last_name}`);
    }).catch(() => {});
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch<Person[]>(`/persons?search=${encodeURIComponent(q)}`);
        setResults(data);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
  };

  const handleSelect = (person: Person) => {
    onChange(person.id);
    setDisplayName(`${person.first_name} ${person.last_name}`);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const handleClear = () => {
    onChange('');
    setDisplayName('');
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      {value && displayName ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm h-8 flex items-center">
            {displayName}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleClear}>
            &times;
          </Button>
        </div>
      ) : (
        <Input
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={placeholder}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
        />
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg bg-popover shadow-md ring-1 ring-foreground/10 max-h-48 overflow-y-auto">
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => handleSelect(p)}
            >
              {p.first_name} {p.last_name}
              {p.email && <span className="text-muted-foreground ml-2">{p.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DelegationsPage() {
  const { data, loading, refetch } = useApi<Delegation[]>('/delegations', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [delegatorId, setDelegatorId] = useState('');
  const [delegateId, setDelegateId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');

  const resetForm = () => {
    setDelegatorId('');
    setDelegateId('');
    setStartsAt('');
    setEndsAt('');
  };

  const handleCreate = async () => {
    if (!delegatorId || !delegateId || !startsAt || !endsAt) return;
    await apiFetch('/delegations', {
      method: 'POST',
      body: JSON.stringify({
        delegator_user_id: delegatorId,
        delegate_user_id: delegateId,
        starts_at: startsAt,
        ends_at: endsAt,
      }),
    });
    resetForm();
    setDialogOpen(false);
    refetch();
  };

  const handleDeactivate = async (id: string) => {
    await apiFetch(`/delegations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: false }),
    });
    refetch();
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const sorted = [...(data ?? [])].sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime());

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Delegations</h1>
          <p className="text-muted-foreground mt-1">Manage approval delegations for out-of-office coverage</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Delegation
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Create Delegation</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Delegator (who is away)</Label>
                <DelegationPersonPicker value={delegatorId} onChange={setDelegatorId} placeholder="Search delegator..." />
              </div>
              <div className="space-y-2">
                <Label>Delegate (who will approve)</Label>
                <DelegationPersonPicker value={delegateId} onChange={setDelegateId} placeholder="Search delegate..." />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Starts At</Label>
                  <Input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Ends At</Label>
                  <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button
                  onClick={handleCreate}
                  disabled={!delegatorId || !delegateId || !startsAt || !endsAt || delegatorId === delegateId}
                >
                  Create
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Delegator</TableHead>
            <TableHead>Delegate</TableHead>
            <TableHead className="w-[130px]">Starts</TableHead>
            <TableHead className="w-[130px]">Ends</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && sorted.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No delegations yet.</TableCell></TableRow>
          )}
          {sorted.map((d) => {
            const status = getDelegationStatus(d);
            return (
              <TableRow key={d.id}>
                <TableCell className="font-medium">{getPersonName(d.delegator)}</TableCell>
                <TableCell className="font-medium">{getPersonName(d.delegate)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(d.starts_at)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(d.ends_at)}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant[status]} className="capitalize">{status}</Badge>
                </TableCell>
                <TableCell>
                  {status !== 'expired' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDeactivate(d.id)}
                      title="Deactivate"
                    >
                      <Ban className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
