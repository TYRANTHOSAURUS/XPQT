import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Settings2, Sparkles, Users2, FormInput, MapPin } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { CatalogBasicsTab } from './catalog-basics-tab';
import { CatalogCoverageTab } from './catalog-coverage-tab';
import { CatalogAudienceTab } from './catalog-audience-tab';
import { CatalogFormTab } from './catalog-form-tab';
import { CatalogFulfillmentTab } from './catalog-fulfillment-tab';

export interface ServiceItemDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  search_terms: string[] | null;
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  fulfillment_type_id: string;
  display_order: number;
  active: boolean;
  categories: Array<{ id: string; category_id: string; display_order: number }>;
  offerings: Array<{
    id: string;
    scope_kind: 'tenant' | 'space' | 'space_group';
    space_id: string | null;
    space_group_id: string | null;
    inherit_to_descendants: boolean;
    starts_at: string | null;
    ends_at: string | null;
    active: boolean;
  }>;
  criteria: Array<{
    id: string;
    criteria_set_id: string;
    mode: 'visible_allow' | 'visible_deny' | 'request_allow' | 'request_deny';
    active: boolean;
  }>;
  form_variants: Array<{
    id: string;
    criteria_set_id: string | null;
    form_schema_id: string;
    priority: number;
    active: boolean;
  }>;
  on_behalf_rules: Array<{ id: string; role: 'actor' | 'target'; criteria_set_id: string }>;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestTypeId: string | null;
  onSaved: () => void;
}

export function CatalogServiceSheet({ open, onOpenChange, requestTypeId, onSaved }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceItemDetail | null>(null);
  const [activeTab, setActiveTab] = useState('basics');

  useEffect(() => {
    if (!open || !requestTypeId) return;
    setLoading(true);
    setError(null);
    setDetail(null);
    setActiveTab('basics');
    apiFetch<ServiceItemDetail>(`/admin/service-items/by-request-type/${requestTypeId}`)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [open, requestTypeId]);

  const reload = async () => {
    if (!detail) return;
    try {
      const fresh = await apiFetch<ServiceItemDetail>(`/admin/service-items/${detail.id}`);
      setDetail(fresh);
      onSaved();
    } catch (e) {
      // soft-fail — toast is already shown by child
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl p-0 flex flex-col gap-0 bg-gradient-to-b from-background via-background to-muted/20"
      >
        <SheetHeader className="shrink-0 px-6 pt-5 pb-4 border-b bg-gradient-to-r from-primary/5 via-background to-transparent">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center ring-1 ring-primary/10">
              <Sparkles className="size-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-lg truncate">
                {loading ? 'Loading…' : detail?.name ?? 'Service'}
              </SheetTitle>
              <SheetDescription className="flex items-center gap-2 mt-1 text-xs">
                {detail?.active === false && (
                  <Badge variant="secondary" className="text-[10px]">Inactive</Badge>
                )}
                {detail?.key && (
                  <span className="font-mono text-muted-foreground/80 truncate">{detail.key}</span>
                )}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <Spinner className="size-6 text-muted-foreground" />
          </div>
        )}

        {error && !loading && (
          <div className="flex-1 flex items-center justify-center text-sm text-destructive px-6">
            {error}
          </div>
        )}

        {detail && !loading && (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 min-h-0 flex flex-col">
            <div className="px-6 pt-3 border-b bg-muted/30">
              <TabsList className="w-full grid grid-cols-5 bg-transparent p-0 h-auto gap-1">
                <TabItem value="basics" label="Basics" icon={<Settings2 className="size-3.5" />} />
                <TabItem
                  value="coverage"
                  label="Coverage"
                  icon={<MapPin className="size-3.5" />}
                  count={detail.offerings.filter((o) => o.active).length || undefined}
                />
                <TabItem
                  value="audience"
                  label="Audience"
                  icon={<Users2 className="size-3.5" />}
                  count={detail.criteria.filter((c) => c.active).length || undefined}
                />
                <TabItem
                  value="form"
                  label="Form"
                  icon={<FormInput className="size-3.5" />}
                  count={detail.form_variants.filter((v) => v.active).length || undefined}
                />
                <TabItem value="fulfillment" label="Fulfillment" icon={<Settings2 className="size-3.5" />} />
              </TabsList>
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
              <TabsContent value="basics" className="m-0 p-6">
                <CatalogBasicsTab detail={detail} onSaved={reload} />
              </TabsContent>
              <TabsContent value="coverage" className="m-0 p-6">
                <CatalogCoverageTab detail={detail} onSaved={reload} />
              </TabsContent>
              <TabsContent value="audience" className="m-0 p-6">
                <CatalogAudienceTab detail={detail} onSaved={reload} />
              </TabsContent>
              <TabsContent value="form" className="m-0 p-6">
                <CatalogFormTab detail={detail} onSaved={reload} />
              </TabsContent>
              <TabsContent value="fulfillment" className="m-0 p-6">
                <CatalogFulfillmentTab detail={detail} onSaved={reload} requestTypeId={requestTypeId!} />
              </TabsContent>
            </div>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}

function TabItem({ value, label, icon, count }: { value: string; label: string; icon: React.ReactNode; count?: number }) {
  return (
    <TabsTrigger
      value={value}
      className="
        relative gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium
        data-[state=active]:bg-background
        data-[state=active]:shadow-sm
        data-[state=active]:ring-1
        data-[state=active]:ring-border
        data-[state=inactive]:text-muted-foreground
        data-[state=inactive]:hover:text-foreground
        transition-all
      "
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0 h-4 font-mono">
          {count}
        </Badge>
      )}
    </TabsTrigger>
  );
}
