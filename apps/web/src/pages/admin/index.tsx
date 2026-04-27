import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SettingsPageShell, SettingsPageHeader } from '@/components/ui/settings-page';
import { adminNavGroups, type AdminNavItem } from '@/lib/admin-nav';

export function AdminIndexPage() {
  return (
    <SettingsPageShell width="ultra">
      <SettingsPageHeader
        title="Admin"
        description="Configure your workspace — catalog, routing, people, access, and operations."
      />

      <div className="gap-x-6 md:columns-2 lg:columns-3 [&>section]:break-inside-avoid">
        {adminNavGroups.map((group) => (
          <section key={group.label} className="mb-6 flex flex-col gap-3">
            <h2 className="text-base font-medium">{group.label}</h2>
            <div className="flex flex-col rounded-lg border bg-card divide-y overflow-hidden">
              {group.items.map((item) => (
                <AdminNavRow key={item.path} item={item} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </SettingsPageShell>
  );
}

function AdminNavRow({ item }: { item: AdminNavItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors"
    >
      <div className="flex size-9 items-center justify-center rounded-md border bg-background text-muted-foreground shrink-0">
        <Icon className="size-4" />
      </div>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="text-sm font-medium">{item.title}</div>
        <div className="text-xs text-muted-foreground">{item.description}</div>
      </div>
      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
    </Link>
  );
}
