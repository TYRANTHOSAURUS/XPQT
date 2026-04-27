import { useEffect, useState } from 'react';
import { SettingsGroup, SettingsRow } from '@/components/ui/settings-row';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  usePortalAppearanceList,
  useUpdatePortalAppearance,
} from '@/api/portal-appearance';
import {
  usePortalAnnouncements,
  useUnpublishAnnouncement,
  type Announcement,
} from '@/api/portal-announcements';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { useSpaceTree } from '@/api/spaces';
import type { SpaceTreeNode } from '@/api/spaces/types';
import { PortalHeroSlot } from './portal-hero-slot';
import { AnnouncementDialog } from './announcement-dialog';
import { toastError } from '@/lib/toast';

function flattenSitesAndBuildings(nodes: SpaceTreeNode[]): SpaceTreeNode[] {
  const out: SpaceTreeNode[] = [];
  const visit = (n: SpaceTreeNode) => {
    if (n.type === 'site' || n.type === 'building') out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

export function PortalAppearanceSection() {
  const { data: rows } = usePortalAppearanceList();
  const { data: tree } = useSpaceTree();
  const update = useUpdatePortalAppearance();

  const heroLocations = flattenSitesAndBuildings(tree ?? []);
  const primary = heroLocations[0];
  const primaryRow = rows?.find((r) => r.location_id === primary?.id);

  const [headline, setHeadline] = useState('');
  const [sub, setSub] = useState('');
  const [greeting, setGreeting] = useState(true);

  useEffect(() => {
    setHeadline(primaryRow?.welcome_headline ?? '');
    setSub(primaryRow?.supporting_line ?? '');
    setGreeting(primaryRow?.greeting_enabled ?? true);
  }, [primaryRow?.location_id]);

  const saveField = async (
    field: 'welcome_headline' | 'supporting_line' | 'greeting_enabled',
    value: string | boolean | null,
  ) => {
    if (!primary) return;
    try {
      await update.mutateAsync({ location_id: primary.id, [field]: value } as any);
    } catch (err) {
      toastError("Couldn't save portal appearance", { error: err, retry: () => saveField(field, value) });
    }
  };

  useDebouncedSave(headline, (v) => saveField('welcome_headline', v || null));
  useDebouncedSave(sub, (v) => saveField('supporting_line', v || null));

  // Announcements
  const { data: announcements } = usePortalAnnouncements();
  const unpublish = useUnpublishAnnouncement();
  const [annDialogOpen, setAnnDialogOpen] = useState(false);
  const [annEditing, setAnnEditing] = useState<Announcement | null>(null);
  const active = (announcements ?? []).filter(
    (a) => !a.expires_at || new Date(a.expires_at) > new Date(),
  );

  return (
    <div className="mt-10 space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Portal appearance</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          How the employee portal looks. Skip anything and the portal falls back to a branded default — gradient hero, no announcements.
        </p>
      </div>

      <SettingsGroup title="Workplace hero">
        {heroLocations.map((loc) => {
          const row = rows?.find((r) => r.location_id === loc.id);
          return (
            <PortalHeroSlot
              key={loc.id}
              locationId={loc.id}
              locationName={loc.name}
              currentUrl={row?.hero_image_url ?? null}
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Greeting & voice">
        <SettingsRow label="Welcome headline" description="Shown below the time-of-day greeting. Under 50 chars.">
          <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="How can we help you today?" className="max-w-sm" />
        </SettingsRow>
        <SettingsRow label="Supporting line" description="One sentence beneath the headline.">
          <Input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Submit a request, book a room…" className="max-w-sm" />
        </SettingsRow>
        <SettingsRow label="Time-of-day greeting" description='Prefix with "Good morning / afternoon / evening, [name]".'>
          <Switch checked={greeting} onCheckedChange={(v) => { setGreeting(v); void saveField('greeting_enabled', v); }} />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">Announcements</h2>
          <p className="text-sm text-muted-foreground">One active per location. Edit replaces the current one.</p>
        </div>
        <Button size="sm" onClick={() => { setAnnEditing(null); setAnnDialogOpen(true); }}>
          Publish announcement
        </Button>
      </div>
      <SettingsGroup>
        {heroLocations.map((loc) => {
          const ann = active.find((a) => a.location_id === loc.id);
          return (
            <SettingsRow
              key={loc.id}
              label={loc.name}
              description={ann ? `"${ann.title}"` : 'No active announcement.'}
            >
              {ann ? (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setAnnEditing(ann); setAnnDialogOpen(true); }}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => unpublish.mutate(ann.id)}>Unpublish</Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => { setAnnEditing({ id: '', location_id: loc.id } as Announcement); setAnnDialogOpen(true); }}>
                  Publish
                </Button>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      {annEditing !== null && (
        <AnnouncementDialog
          open={annDialogOpen}
          onOpenChange={setAnnDialogOpen}
          locationId={annEditing?.location_id ?? primary?.id ?? ''}
          locationName={heroLocations.find((l) => l.id === annEditing?.location_id)?.name ?? ''}
          editing={annEditing?.id ? annEditing : null}
        />
      )}
    </div>
  );
}
