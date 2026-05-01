/**
 * /admin/visitors/pools — visitor pass pool index.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.4, §4.5
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 9 task 9.2
 *
 * Index follows the canonical "Index + detail shape":
 *  - Width `wide` — the pools table has more columns than narrow types page.
 *  - Table: anchor space → kind → pass_count / available / in_use / lost → opt-out.
 *  - "+ New pool" → Dialog (space picker + optional notes) → POST → navigate
 *    to detail.
 *  - Empty state explains the inheritance model.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, KeySquare } from 'lucide-react';
import { toastCreated, toastError } from '@/lib/toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { SpaceTreePicker } from '@/components/admin/space-tree-picker';
import { cn } from '@/lib/utils';
import {
  useCreatePool,
  usePoolAnchors,
  type PoolAnchorRow,
} from '@/api/visitors/admin';

export function AdminVisitorPoolsPage() {
  const { data, isLoading } = usePoolAnchors();
  const [createOpen, setCreateOpen] = useState(false);

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Visitor passes"
        description="Manage physical visitor pass pools per site or building. Pools are inherited by descendant spaces unless explicitly opted out."
        actions={
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New pool
          </Button>
        }
      />

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Anchor space</TableHead>
              <TableHead className="w-[80px]">Kind</TableHead>
              <TableHead className="w-[80px] text-right">Total</TableHead>
              <TableHead className="w-[100px] text-right">Available</TableHead>
              <TableHead className="w-[100px] text-right">In use</TableHead>
              <TableHead className="w-[80px] text-right">Lost</TableHead>
              <TableHead className="w-[100px]">Inheritance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row: PoolAnchorRow) => (
              <TableRow key={row.space_id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/visitors/pools/${row.space_id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {row.space_name}
                  </Link>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground capitalize">
                  {row.space_kind}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.pass_count}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.available_count}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.in_use_count}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.lost_count > 0 ? (
                    <Badge variant="destructive">{row.lost_count}</Badge>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell>
                  {row.uses_visitor_passes ? (
                    <span className="text-xs text-muted-foreground">
                      Inherited
                    </span>
                  ) : (
                    <Badge variant="secondary">opted out</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <KeySquare className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No pass pools configured</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            A pool is a set of physical visitor passes anchored to a site or
            building. Descendant buildings inherit the most-specific pool
            unless they opt out.
          </p>
          <Button
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            New pool
          </Button>
        </div>
      )}

      <CreatePoolDialog open={createOpen} onOpenChange={setCreateOpen} />
    </SettingsPageShell>
  );
}

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreatePoolDialog({ open, onOpenChange }: CreateProps) {
  const [spaceId, setSpaceId] = useState('');
  const [notes, setNotes] = useState('');
  const create = useCreatePool();
  const navigate = useNavigate();

  const reset = () => {
    setSpaceId('');
    setNotes('');
  };

  const handleCreate = () => {
    if (!spaceId) return;
    create.mutate(
      { space_id: spaceId, notes: notes.trim() || undefined },
      {
        onSuccess: () => {
          const target = spaceId;
          reset();
          onOpenChange(false);
          toastCreated('Pass pool', {
            onView: () => navigate(`/admin/visitors/pools/${target}`),
          });
          navigate(`/admin/visitors/pools/${target}`);
        },
        onError: (err) =>
          toastError("Couldn't create pool", { error: err }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New pass pool</DialogTitle>
          <DialogDescription>
            Anchor the pool to a site or building. Descendant spaces will
            inherit it. You'll add the actual passes on the next screen.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pool-space">Anchor space</FieldLabel>
            <SpaceTreePicker
              id="pool-space"
              value={spaceId}
              onChange={setSpaceId}
              placeholder="Pick a site or building…"
            />
            <FieldDescription>
              Pool anchors must be a site or building. Floors and rooms can't
              own a pool — they inherit from the closest ancestor.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="pool-notes">Notes</FieldLabel>
            <Input
              id="pool-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional admin-facing note"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!spaceId || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
