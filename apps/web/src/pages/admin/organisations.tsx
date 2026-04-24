import { Link } from 'react-router-dom';
import { Plus, Building2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import { OrgNodeTree, type OrgNodeListItem } from '@/components/admin/org-node-tree';
import { useOrgNodes } from '@/api/org-nodes';
import { cn } from '@/lib/utils';

export function OrganisationsPage() {
  const { data, isPending: loading } = useOrgNodes() as { data: OrgNodeListItem[] | undefined; isPending: boolean };

  const isEmpty = !loading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin"
        title="Organisations"
        description="The requester-side hierarchy. Members of a node inherit its location grants."
        actions={
          <Link
            to="/admin/organisations/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            Create organisation
          </Link>
        }
      />
      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && data && data.length > 0 && <OrgNodeTree nodes={data} />}
      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Building2 className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No organisations yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create your first organisation to start grouping employees and granting them
            access to locations in bulk.
          </p>
          <Link
            to="/admin/organisations/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            Create organisation
          </Link>
        </div>
      )}
    </SettingsPageShell>
  );
}
