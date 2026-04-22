# Admin: Space Groups, Domain Parents, Location Teams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give admins a UI (no SQL) to configure the three routing knobs that Pass 1 left schema-only: `space_groups` + members, `domain_parents`, and full CRUD over `location_teams` (now supporting either `space_id` OR `space_group_id`).

**Architecture:** Three new NestJS controllers under `apps/api/src/modules/routing/` (location-teams, space-groups, domain-parents), each tenant-isolated via the existing `TenantContext`. Three new admin pages under `apps/web/src/pages/admin/` that copy the established `routing-rules.tsx` pattern: table + dialog for create/edit, `useApi` for list, `apiFetch` for mutations. Three entries in `AdminLayout` config nav + `App.tsx` routes.

**Tech Stack:** NestJS + Supabase (backend). React 19 + shadcn/ui + `useApi` + `apiFetch` (frontend). No React Query.

---

## File structure

### Backend — new

| File | Purpose |
|---|---|
| `apps/api/src/modules/routing/location-teams.controller.ts` | CRUD over `location_teams` rows (scope = space XOR group). |
| `apps/api/src/modules/routing/space-groups.controller.ts` | CRUD over `space_groups` + member add/remove via `space_group_members`. |
| `apps/api/src/modules/routing/domain-parents.controller.ts` | CRUD over `domain_parents` (edit = delete + re-create because `(tenant, domain)` is unique). |

### Backend — modified

| File | Change |
|---|---|
| `apps/api/src/modules/routing/routing.module.ts` | Register the three new controllers. |

### Frontend — new

| File | Purpose |
|---|---|
| `apps/web/src/pages/admin/space-groups.tsx` | List + create/edit dialog with name, description, member spaces. |
| `apps/web/src/pages/admin/domain-parents.tsx` | Flat list of domain → parent_domain pairs. Add + delete. |
| `apps/web/src/pages/admin/location-teams.tsx` | Table showing scope (space or group), domain, assignee (team or vendor). Dialog for create/edit with scope tabs. |

### Frontend — modified

| File | Change |
|---|---|
| `apps/web/src/layouts/admin-layout.tsx` | Add three entries to `configNav` + corresponding `pageTitles` keys. |
| `apps/web/src/App.tsx` | Register three new admin routes. |

---

## Task 1: Location Teams controller

**Files:**
- Create: `apps/api/src/modules/routing/location-teams.controller.ts`
- Modify: `apps/api/src/modules/routing/routing.module.ts`

- [ ] **Step 1: Write the controller**

Create `apps/api/src/modules/routing/location-teams.controller.ts`:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface CreateLocationTeamDto {
  space_id?: string | null;
  space_group_id?: string | null;
  domain: string;
  team_id?: string | null;
  vendor_id?: string | null;
}

interface UpdateLocationTeamDto {
  space_id?: string | null;
  space_group_id?: string | null;
  domain?: string;
  team_id?: string | null;
  vendor_id?: string | null;
}

function validateScope(space_id: string | null | undefined, space_group_id: string | null | undefined) {
  const hasSpace = !!space_id;
  const hasGroup = !!space_group_id;
  if (hasSpace === hasGroup) {
    throw new BadRequestException('Exactly one of space_id or space_group_id must be set.');
  }
}

function validateAssignee(team_id: string | null | undefined, vendor_id: string | null | undefined) {
  if (!team_id && !vendor_id) {
    throw new BadRequestException('At least one of team_id or vendor_id must be set.');
  }
}

@Controller('location-teams')
export class LocationTeamsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .select(`
        id, space_id, space_group_id, domain, team_id, vendor_id, created_at, updated_at,
        space:spaces(id, name, type),
        space_group:space_groups(id, name),
        team:teams(id, name),
        vendor:vendors(id, name)
      `)
      .eq('tenant_id', tenant.id)
      .order('domain', { ascending: true });
    if (error) throw error;
    return data;
  }

  @Post()
  async create(@Body() dto: CreateLocationTeamDto) {
    const tenant = TenantContext.current();
    if (!dto.domain?.trim()) throw new BadRequestException('domain is required');
    validateScope(dto.space_id, dto.space_group_id);
    validateAssignee(dto.team_id, dto.vendor_id);

    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .insert({
        tenant_id: tenant.id,
        space_id: dto.space_id ?? null,
        space_group_id: dto.space_group_id ?? null,
        domain: dto.domain.trim(),
        team_id: dto.team_id ?? null,
        vendor_id: dto.vendor_id ?? null,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateLocationTeamDto) {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.domain !== undefined) patch.domain = dto.domain.trim();
    if (dto.space_id !== undefined) patch.space_id = dto.space_id;
    if (dto.space_group_id !== undefined) patch.space_group_id = dto.space_group_id;
    if (dto.team_id !== undefined) patch.team_id = dto.team_id;
    if (dto.vendor_id !== undefined) patch.vendor_id = dto.vendor_id;

    // Validate merged shape if scope or assignee is being touched.
    if ('space_id' in patch || 'space_group_id' in patch || 'team_id' in patch || 'vendor_id' in patch) {
      const { data: current, error: cerr } = await this.supabase.admin
        .from('location_teams')
        .select('space_id, space_group_id, team_id, vendor_id')
        .eq('id', id)
        .eq('tenant_id', tenant.id)
        .single();
      if (cerr) throw new BadRequestException(cerr.message);
      const merged = { ...current, ...patch };
      validateScope(merged.space_id as string | null, merged.space_group_id as string | null);
      validateAssignee(merged.team_id as string | null, merged.vendor_id as string | null);
    }

    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('location_teams')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }
}
```

- [ ] **Step 2: Register in module**

Open `apps/api/src/modules/routing/routing.module.ts`. Add an import for the new controller and list it in the `controllers` array. The updated file should be:

```typescript
import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';
import { LocationTeamsController } from './location-teams.controller';

@Module({
  providers: [RoutingService, ResolverService, ResolverRepository],
  controllers: [RoutingRuleController, LocationTeamsController],
  exports: [RoutingService],
})
export class RoutingModule {}
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @prequest/api build`
Expected: clean compile.

- [ ] **Step 4: Smoke-check the route exists**

Run: `grep -rn "location-teams" apps/api/src/modules/routing/` and confirm the controller appears.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/routing/location-teams.controller.ts \
        apps/api/src/modules/routing/routing.module.ts
git commit -m "feat(routing): location-teams CRUD endpoints"
```

---

## Task 2: Space Groups controller (groups + members)

**Files:**
- Create: `apps/api/src/modules/routing/space-groups.controller.ts`
- Modify: `apps/api/src/modules/routing/routing.module.ts`

- [ ] **Step 1: Write the controller**

Create `apps/api/src/modules/routing/space-groups.controller.ts`:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface CreateSpaceGroupDto {
  name: string;
  description?: string | null;
}

interface UpdateSpaceGroupDto {
  name?: string;
  description?: string | null;
}

interface AddMemberDto {
  space_id: string;
}

@Controller('space-groups')
export class SpaceGroupsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('space_groups')
      .select(`
        id, name, description, created_at, updated_at,
        members:space_group_members(space_id, space:spaces(id, name, type))
      `)
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post()
  async create(@Body() dto: CreateSpaceGroupDto) {
    const tenant = TenantContext.current();
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    const { data, error } = await this.supabase.admin
      .from('space_groups')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        description: dto.description?.trim() ?? null,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSpaceGroupDto) {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('name cannot be empty');
      patch.name = dto.name.trim();
    }
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;

    const { data, error } = await this.supabase.admin
      .from('space_groups')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('space_groups')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  @Post(':id/members')
  async addMember(@Param('id') groupId: string, @Body() dto: AddMemberDto) {
    const tenant = TenantContext.current();
    if (!dto.space_id) throw new BadRequestException('space_id is required');
    const { data, error } = await this.supabase.admin
      .from('space_group_members')
      .insert({
        tenant_id: tenant.id,
        space_group_id: groupId,
        space_id: dto.space_id,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id/members/:spaceId')
  async removeMember(@Param('id') groupId: string, @Param('spaceId') spaceId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('space_group_members')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('space_group_id', groupId)
      .eq('space_id', spaceId);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }
}
```

- [ ] **Step 2: Register in module**

Update `apps/api/src/modules/routing/routing.module.ts` to include the new controller:

```typescript
import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';
import { LocationTeamsController } from './location-teams.controller';
import { SpaceGroupsController } from './space-groups.controller';

@Module({
  providers: [RoutingService, ResolverService, ResolverRepository],
  controllers: [RoutingRuleController, LocationTeamsController, SpaceGroupsController],
  exports: [RoutingService],
})
export class RoutingModule {}
```

- [ ] **Step 3: Build and commit**

```bash
pnpm --filter @prequest/api build
git add apps/api/src/modules/routing/space-groups.controller.ts \
        apps/api/src/modules/routing/routing.module.ts
git commit -m "feat(routing): space-groups CRUD + member management endpoints"
```

---

## Task 3: Domain Parents controller

**Files:**
- Create: `apps/api/src/modules/routing/domain-parents.controller.ts`
- Modify: `apps/api/src/modules/routing/routing.module.ts`

- [ ] **Step 1: Write the controller**

Create `apps/api/src/modules/routing/domain-parents.controller.ts`:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface CreateDomainParentDto {
  domain: string;
  parent_domain: string;
}

@Controller('domain-parents')
export class DomainParentsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('domain_parents')
      .select('id, domain, parent_domain, created_at, updated_at')
      .eq('tenant_id', tenant.id)
      .order('domain');
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post()
  async create(@Body() dto: CreateDomainParentDto) {
    const tenant = TenantContext.current();
    const domain = dto.domain?.trim();
    const parent = dto.parent_domain?.trim();
    if (!domain) throw new BadRequestException('domain is required');
    if (!parent) throw new BadRequestException('parent_domain is required');
    if (domain === parent) throw new BadRequestException('domain and parent_domain must differ');

    const { data, error } = await this.supabase.admin
      .from('domain_parents')
      .insert({
        tenant_id: tenant.id,
        domain,
        parent_domain: parent,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('domain_parents')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }
}
```

(No PATCH — the `(tenant, domain)` unique constraint makes "editing the parent" cleanest as delete + recreate on the frontend.)

- [ ] **Step 2: Register in module**

Update `apps/api/src/modules/routing/routing.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';
import { LocationTeamsController } from './location-teams.controller';
import { SpaceGroupsController } from './space-groups.controller';
import { DomainParentsController } from './domain-parents.controller';

@Module({
  providers: [RoutingService, ResolverService, ResolverRepository],
  controllers: [
    RoutingRuleController,
    LocationTeamsController,
    SpaceGroupsController,
    DomainParentsController,
  ],
  exports: [RoutingService],
})
export class RoutingModule {}
```

- [ ] **Step 3: Build and commit**

```bash
pnpm --filter @prequest/api build
git add apps/api/src/modules/routing/domain-parents.controller.ts \
        apps/api/src/modules/routing/routing.module.ts
git commit -m "feat(routing): domain-parents CRUD endpoints"
```

---

## Task 4: Space Groups admin page

**Files:**
- Create: `apps/web/src/pages/admin/space-groups.tsx`

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/admin/space-groups.tsx`:

```tsx
import { useState } from 'react';
import { Plus, Pencil, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { EntityPicker } from '@/components/desk/editors/entity-picker';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface SpaceOption { id: string; name: string; type?: string }

interface GroupMember { space_id: string; space: { id: string; name: string; type?: string } | null }

interface SpaceGroup {
  id: string;
  name: string;
  description: string | null;
  members: GroupMember[];
}

export function SpaceGroupsPage() {
  const { data, loading, refetch } = useApi<SpaceGroup[]>('/space-groups', []);
  const { data: spaces } = useApi<SpaceOption[]>('/spaces', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [pickerValue, setPickerValue] = useState<string | null>(null);

  const resetForm = () => {
    setEditId(null); setName(''); setDescription(''); setMemberIds([]); setPickerValue(null);
  };

  const openCreate = () => { resetForm(); setDialogOpen(true); };

  const openEdit = (group: SpaceGroup) => {
    setEditId(group.id);
    setName(group.name);
    setDescription(group.description ?? '');
    setMemberIds(group.members.map((m) => m.space_id));
    setPickerValue(null);
    setDialogOpen(true);
  };

  async function saveGroup(): Promise<string | null> {
    if (!name.trim()) return null;
    const body = { name: name.trim(), description: description.trim() || null };
    try {
      if (editId) {
        await apiFetch(`/space-groups/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        return editId;
      }
      const created = await apiFetch<{ id: string }>('/space-groups', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return created.id;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save group');
      return null;
    }
  }

  async function syncMembers(groupId: string, originalIds: string[], nextIds: string[]) {
    const toAdd = nextIds.filter((id) => !originalIds.includes(id));
    const toRemove = originalIds.filter((id) => !nextIds.includes(id));
    await Promise.all([
      ...toAdd.map((space_id) =>
        apiFetch(`/space-groups/${groupId}/members`, {
          method: 'POST',
          body: JSON.stringify({ space_id }),
        })
      ),
      ...toRemove.map((space_id) =>
        apiFetch(`/space-groups/${groupId}/members/${space_id}`, { method: 'DELETE' })
      ),
    ]);
  }

  async function handleSave() {
    const id = await saveGroup();
    if (!id) return;
    const original = data?.find((g) => g.id === id)?.members.map((m) => m.space_id) ?? [];
    try {
      await syncMembers(id, original, memberIds);
      toast.success(editId ? 'Group updated' : 'Group created');
      setDialogOpen(false);
      resetForm();
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to sync members');
    }
  }

  async function handleDelete(group: SpaceGroup) {
    if (!confirm(`Delete space group "${group.name}"? Any location_teams rows using it will be removed.`)) return;
    try {
      await apiFetch(`/space-groups/${group.id}`, { method: 'DELETE' });
      toast.success('Group deleted');
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  const spaceOptions = (spaces ?? []).map((s) => ({
    id: s.id,
    label: s.name,
    sublabel: s.type ?? null,
  }));
  const availableOptions = spaceOptions.filter((opt) => !memberIds.includes(opt.id));
  const memberLabels = memberIds.map((id) => ({
    id,
    name: spaceOptions.find((o) => o.id === id)?.label ?? id,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Space Groups</h1>
          <p className="text-muted-foreground mt-1">
            Group spaces with no common ancestor under one routing target (e.g. Buildings A, C, F share one FM team).
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Group
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Space Group</DialogTitle>
              <DialogDescription>A set of spaces treated as one scope in location-based routing.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sg-name">Name</FieldLabel>
                <Input id="sg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. East Campus FM" />
              </Field>
              <Field>
                <FieldLabel htmlFor="sg-description">Description</FieldLabel>
                <Textarea id="sg-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </Field>
              <Field>
                <FieldLabel>Member spaces</FieldLabel>
                <EntityPicker
                  value={pickerValue}
                  options={availableOptions}
                  placeholder="space"
                  onChange={(opt) => {
                    if (opt) {
                      setMemberIds((prev) => [...prev, opt.id]);
                      setPickerValue(null);
                    }
                  }}
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {memberLabels.length === 0 && (
                    <span className="text-xs text-muted-foreground">No spaces yet.</span>
                  )}
                  {memberLabels.map((m) => (
                    <Badge key={m.id} variant="secondary" className="gap-1">
                      {m.name}
                      <button
                        type="button"
                        className="ml-0.5 hover:text-destructive"
                        onClick={() => setMemberIds((prev) => prev.filter((id) => id !== m.id))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <FieldDescription>Pick spaces one at a time. Changes save when you click Save.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[80px]">Members</TableHead>
            <TableHead className="w-[120px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No space groups yet." />}
          {(data ?? []).map((group) => (
            <TableRow key={group.id}>
              <TableCell className="font-medium">{group.name}</TableCell>
              <TableCell className="text-muted-foreground">{group.description ?? '—'}</TableCell>
              <TableCell className="font-mono">{group.members.length}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(group)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile. If `Textarea` is missing at `apps/web/src/components/ui/textarea.tsx`, it was installed in Pass 1 Task 7 — should exist.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/admin/space-groups.tsx
git commit -m "feat(admin): SpaceGroupsPage — CRUD + member management"
```

---

## Task 5: Domain Parents admin page

**Files:**
- Create: `apps/web/src/pages/admin/domain-parents.tsx`

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/admin/domain-parents.tsx`:

```tsx
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface DomainParent {
  id: string;
  domain: string;
  parent_domain: string;
}

export function DomainParentsPage() {
  const { data, loading, refetch } = useApi<DomainParent[]>('/domain-parents', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [parentDomain, setParentDomain] = useState('');

  const reset = () => { setDomain(''); setParentDomain(''); };

  const openCreate = () => { reset(); setDialogOpen(true); };

  async function handleCreate() {
    if (!domain.trim() || !parentDomain.trim()) return;
    try {
      await apiFetch('/domain-parents', {
        method: 'POST',
        body: JSON.stringify({ domain: domain.trim(), parent_domain: parentDomain.trim() }),
      });
      toast.success('Domain parent added');
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add');
    }
  }

  async function handleDelete(row: DomainParent) {
    if (!confirm(`Remove parent relationship "${row.domain} → ${row.parent_domain}"?`)) return;
    try {
      await apiFetch(`/domain-parents/${row.id}`, { method: 'DELETE' });
      toast.success('Relationship removed');
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Domain Hierarchy</h1>
          <p className="text-muted-foreground mt-1">
            Parent-domain fallback for cross-domain routing (e.g. "doors" → "fm" means doors requests fall back to fm teams when no doors team matches).
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) reset(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Relationship
          </DialogTrigger>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Add Domain Parent</DialogTitle>
              <DialogDescription>Define a fallback domain when routing can't find an exact match.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="dp-domain">Domain</FieldLabel>
                <Input id="dp-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. doors" />
                <FieldDescription>The specific domain (child).</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="dp-parent">Parent Domain</FieldLabel>
                <Input id="dp-parent" value={parentDomain} onChange={(e) => setParentDomain(e.target.value)} placeholder="e.g. fm" />
                <FieldDescription>The broader domain this falls back to.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!domain.trim() || !parentDomain.trim()}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            <TableHead>Parent Domain</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={3} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={3} message="No parent-domain relationships yet." />}
          {(data ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono">{row.domain}</TableCell>
              <TableCell className="font-mono text-muted-foreground">→ {row.parent_domain}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(row)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Build and commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/pages/admin/domain-parents.tsx
git commit -m "feat(admin): DomainParentsPage — cross-domain fallback editor"
```

---

## Task 6: Location Teams admin page

**Files:**
- Create: `apps/web/src/pages/admin/location-teams.tsx`

- [ ] **Step 1: Write the page**

Create `apps/web/src/pages/admin/location-teams.tsx`:

```tsx
import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { EntityPicker } from '@/components/desk/editors/entity-picker';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface LocationTeam {
  id: string;
  space_id: string | null;
  space_group_id: string | null;
  domain: string;
  team_id: string | null;
  vendor_id: string | null;
  space: { id: string; name: string } | null;
  space_group: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
}

interface SpaceOption { id: string; name: string }
interface GroupOption { id: string; name: string }
interface TeamOption { id: string; name: string }
interface VendorOption { id: string; name: string }

type ScopeTab = 'space' | 'group';
type AssigneeTab = 'team' | 'vendor';

export function LocationTeamsPage() {
  const { data, loading, refetch } = useApi<LocationTeam[]>('/location-teams', []);
  const { data: spaces } = useApi<SpaceOption[]>('/spaces', []);
  const { data: groups } = useApi<GroupOption[]>('/space-groups', []);
  const { data: teams } = useApi<TeamOption[]>('/teams', []);
  const { data: vendors } = useApi<VendorOption[]>('/vendors', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [scopeTab, setScopeTab] = useState<ScopeTab>('space');
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [assigneeTab, setAssigneeTab] = useState<AssigneeTab>('team');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);

  const reset = () => {
    setEditId(null); setScopeTab('space'); setSpaceId(null); setGroupId(null);
    setDomain(''); setAssigneeTab('team'); setTeamId(null); setVendorId(null);
  };

  const openCreate = () => { reset(); setDialogOpen(true); };

  const openEdit = (row: LocationTeam) => {
    setEditId(row.id);
    setScopeTab(row.space_group_id ? 'group' : 'space');
    setSpaceId(row.space_id);
    setGroupId(row.space_group_id);
    setDomain(row.domain);
    setAssigneeTab(row.vendor_id ? 'vendor' : 'team');
    setTeamId(row.team_id);
    setVendorId(row.vendor_id);
    setDialogOpen(true);
  };

  function onScopeTabChange(next: string) {
    const t = next as ScopeTab;
    setScopeTab(t);
    if (t === 'space') setGroupId(null); else setSpaceId(null);
  }

  function onAssigneeTabChange(next: string) {
    const t = next as AssigneeTab;
    setAssigneeTab(t);
    if (t === 'team') setVendorId(null); else setTeamId(null);
  }

  async function handleSave() {
    if (!domain.trim()) { toast.error('Domain is required'); return; }
    const scopeValue = scopeTab === 'space' ? spaceId : groupId;
    if (!scopeValue) { toast.error('Pick a space or space group'); return; }
    const assigneeValue = assigneeTab === 'team' ? teamId : vendorId;
    if (!assigneeValue) { toast.error('Pick a team or vendor'); return; }

    const body = {
      space_id: scopeTab === 'space' ? spaceId : null,
      space_group_id: scopeTab === 'group' ? groupId : null,
      domain: domain.trim(),
      team_id: assigneeTab === 'team' ? teamId : null,
      vendor_id: assigneeTab === 'vendor' ? vendorId : null,
    };

    try {
      if (editId) {
        await apiFetch(`/location-teams/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Routing entry updated');
      } else {
        await apiFetch('/location-teams', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Routing entry created');
      }
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function handleDelete(row: LocationTeam) {
    if (!confirm(`Delete routing entry for domain "${row.domain}"?`)) return;
    try {
      await apiFetch(`/location-teams/${row.id}`, { method: 'DELETE' });
      toast.success('Routing entry deleted');
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  const spaceOptions = (spaces ?? []).map((s) => ({ id: s.id, label: s.name }));
  const groupOptions = (groups ?? []).map((g) => ({ id: g.id, label: g.name }));
  const teamOptions = (teams ?? []).map((t) => ({ id: t.id, label: t.name }));
  const vendorOptions = (vendors ?? []).map((v) => ({ id: v.id, label: v.name }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Location Teams</h1>
          <p className="text-muted-foreground mt-1">
            Map a space (or space group) + domain to the team or vendor that handles it.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) reset(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Entry
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Location Team</DialogTitle>
              <DialogDescription>Assign a team or vendor to handle a given domain at a space or space group.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>Scope</FieldLabel>
                <Tabs value={scopeTab} onValueChange={onScopeTabChange}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="space">Space</TabsTrigger>
                    <TabsTrigger value="group">Space Group</TabsTrigger>
                  </TabsList>
                  <TabsContent value="space" className="pt-2">
                    <EntityPicker value={spaceId} options={spaceOptions} placeholder="space" onChange={(o) => setSpaceId(o?.id ?? null)} />
                  </TabsContent>
                  <TabsContent value="group" className="pt-2">
                    <EntityPicker value={groupId} options={groupOptions} placeholder="group" onChange={(o) => setGroupId(o?.id ?? null)} />
                  </TabsContent>
                </Tabs>
              </Field>
              <Field>
                <FieldLabel htmlFor="lt-domain">Domain</FieldLabel>
                <Input id="lt-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. fm, it, doors" />
                <FieldDescription>Must match the request type's domain value.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Assignee</FieldLabel>
                <Tabs value={assigneeTab} onValueChange={onAssigneeTabChange}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="team">Team</TabsTrigger>
                    <TabsTrigger value="vendor">Vendor</TabsTrigger>
                  </TabsList>
                  <TabsContent value="team" className="pt-2">
                    <EntityPicker value={teamId} options={teamOptions} placeholder="team" onChange={(o) => setTeamId(o?.id ?? null)} />
                  </TabsContent>
                  <TabsContent value="vendor" className="pt-2">
                    <EntityPicker value={vendorId} options={vendorOptions} placeholder="vendor" onChange={(o) => setVendorId(o?.id ?? null)} />
                  </TabsContent>
                </Tabs>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave}>{editId ? 'Save' : 'Create'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Domain</TableHead>
            <TableHead>Assignee</TableHead>
            <TableHead className="w-[120px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No location-team entries yet." />}
          {(data ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                {row.space ? (
                  <span className="flex items-center gap-1.5"><Badge variant="outline">Space</Badge> {row.space.name}</span>
                ) : row.space_group ? (
                  <span className="flex items-center gap-1.5"><Badge variant="secondary">Group</Badge> {row.space_group.name}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="font-mono">{row.domain}</TableCell>
              <TableCell>
                {row.team ? (
                  <span className="flex items-center gap-1.5"><Badge variant="outline">Team</Badge> {row.team.name}</span>
                ) : row.vendor ? (
                  <span className="flex items-center gap-1.5"><Badge variant="secondary">Vendor</Badge> {row.vendor.name}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(row)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Build and commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/pages/admin/location-teams.tsx
git commit -m "feat(admin): LocationTeamsPage — space/group × domain × assignee CRUD"
```

---

## Task 7: Wire routes + sidebar navigation

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/layouts/admin-layout.tsx`

- [ ] **Step 1: Register routes in App.tsx**

Open `apps/web/src/App.tsx`. Find the admin route imports block. Add:

```tsx
import { LocationTeamsPage } from '@/pages/admin/location-teams';
import { SpaceGroupsPage } from '@/pages/admin/space-groups';
import { DomainParentsPage } from '@/pages/admin/domain-parents';
```

Then find the admin `<Route>` children. Immediately after the existing `<Route path="routing-rules" element={<RoutingRulesPage />} />` line, add:

```tsx
            <Route path="location-teams" element={<LocationTeamsPage />} />
            <Route path="space-groups" element={<SpaceGroupsPage />} />
            <Route path="domain-parents" element={<DomainParentsPage />} />
```

- [ ] **Step 2: Add sidebar entries in admin-layout.tsx**

Open `apps/web/src/layouts/admin-layout.tsx`. At the top of the file, the icon imports from `lucide-react` include `Route`, `MapPin`, etc. Add `Network` and `Layers` to that import list:

Find the `lucide-react` import block and add (append inside the existing `{ ... }`):

```tsx
  Network,
  Layers,
```

Then find the `configNav` array. Immediately after the `Routing Rules` entry, add three new entries:

```tsx
  { title: 'Location Teams', path: '/admin/location-teams', icon: MapPin },
  { title: 'Space Groups', path: '/admin/space-groups', icon: Layers },
  { title: 'Domain Hierarchy', path: '/admin/domain-parents', icon: Network },
```

Then find `pageTitles` and add three keys:

```tsx
  '/admin/location-teams': 'Location Teams',
  '/admin/space-groups': 'Space Groups',
  '/admin/domain-parents': 'Domain Hierarchy',
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/layouts/admin-layout.tsx
git commit -m "feat(admin): wire space-groups, domain-parents, location-teams routes + sidebar"
```

---

## Task 8: End-to-end sanity pass

- [ ] **Step 1: Run full API test suite**

Run: `pnpm --filter @prequest/api test`
Expected: all suites pass. No new tests added by this plan (CRUD endpoints are trivial); existing suite should stay green.

- [ ] **Step 2: API build**

Run: `pnpm --filter @prequest/api build`

- [ ] **Step 3: Web build**

Run: `pnpm --filter @prequest/web build`

- [ ] **Step 4: Manual smoke test**

Run `pnpm dev`. Navigate to `/admin/space-groups`. Verify:
- Page loads, empty state shows.
- Create a group "Test Group", save. Appears in the table.
- Edit it, add 1-2 spaces as members, save. Member count updates.
- Navigate to `/admin/domain-parents`. Add `doors → fm`. Appears. Delete it.
- Navigate to `/admin/location-teams`. Add an entry with scope = the "Test Group", domain = "fm", assignee = any team. Row appears with "Group" badge.
- Edit the entry, change scope to a specific space. Row updates.
- Delete the test group from Space Groups — confirm the location-teams row is also gone (cascade).

Stop `pnpm dev`.

- [ ] **Step 5: Report and merge**

Report commit list and any fix-ups. Merge feature branch to main with fast-forward.

---

## Self-review notes

- **Spec coverage:** All three tables (`location_teams`, `space_groups`, `domain_parents`) have full CRUD over HTTP. All three have an admin page following the `routing-rules.tsx` pattern. Nav + routes wired.
- **Placeholder scan:** every step has complete code or exact commands. No TBDs.
- **Type consistency:** `EntityOption` is `{ id: string; label: string; sublabel?: string | null }` — matches the existing picker. `useApi<T>(path, defaultValue)` returns `{ data, loading, refetch }` — matches the existing admin pages.
- **Open points:**
  - The space-groups page stores members as a local array and syncs on save via parallel `POST /members` + `DELETE /members/:spaceId` — simple and matches how other admin pages treat child collections. If member counts grow large, a single bulk endpoint is the next improvement.
  - The location-teams PATCH revalidates scope/assignee XOR by re-fetching the current row — one extra DB round-trip per edit, acceptable for a low-write admin surface.
