import { useEffect, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, MousePointerClick } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { CatalogBasicsTab } from './catalog-basics-tab';
import { CatalogCoverageTab } from './catalog-coverage-tab';
import { CatalogAudienceTab } from './catalog-audience-tab';
import { CatalogFormTab } from './catalog-form-tab';
import { CatalogFulfillmentTab } from './catalog-fulfillment-tab';

/**
 * The "detail" shape consumed by each tab. Keeps the property names the tabs
 * expect (offerings, criteria, form_variants, on_behalf_rules) while the
 * underlying tables moved onto the request-type-native set. Fields are
 * assembled by the panel from separate GETs on the request-type satellite
 * endpoints. See docs/service-catalog-live.md §5 + §10.
 */
export interface RequestTypeDetail {
  id: string;                  // request_type_id
  key: string;                 // synthetic: first 8 chars of id — kept for display
  name: string;
  description: string | null;
  icon: string | null;
  search_terms: string[] | null;   // mirrors request_types.keywords
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
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
    starts_at: string | null;
    ends_at: string | null;
  }>;
  on_behalf_rules: Array<{ id: string; role: 'actor' | 'target'; criteria_set_id: string }>;
  scope_overrides: Array<{
    id: string;
    scope_kind: 'tenant' | 'space' | 'space_group';
    space_id: string | null;
    space_group_id: string | null;
    inherit_to_descendants: boolean;
    active: boolean;
    handler_kind: 'team' | 'vendor' | 'none' | null;
    handler_team_id: string | null;
    handler_vendor_id: string | null;
    workflow_definition_id: string | null;
    case_sla_policy_id: string | null;
    case_owner_policy_entity_id: string | null;
    child_dispatch_policy_entity_id: string | null;
    executor_sla_policy_id: string | null;
  }>;
}

interface RequestTypeRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  keywords: string[] | null;
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: RequestTypeDetail['on_behalf_policy'];
  display_order: number;
  active: boolean;
}

interface Props {
  requestTypeId: string | null;
  onSaved: () => void;
  onClose: () => void;
}

async function loadDetail(requestTypeId: string): Promise<RequestTypeDetail> {
  const [rt, categoryIds, coverage, audience, variants, onBehalfRules, scopeOverrides] =
    await Promise.all([
      apiFetch<RequestTypeRow>(`/request-types/${requestTypeId}`),
      apiFetch<string[]>(`/request-types/${requestTypeId}/categories`),
      apiFetch<RequestTypeDetail['offerings']>(`/request-types/${requestTypeId}/coverage`),
      apiFetch<RequestTypeDetail['criteria']>(`/request-types/${requestTypeId}/audience`),
      apiFetch<RequestTypeDetail['form_variants']>(`/request-types/${requestTypeId}/form-variants`),
      apiFetch<RequestTypeDetail['on_behalf_rules']>(
        `/request-types/${requestTypeId}/on-behalf-rules`,
      ),
      apiFetch<RequestTypeDetail['scope_overrides']>(
        `/request-types/${requestTypeId}/scope-overrides`,
      ),
    ]);

  return {
    id: rt.id,
    key: rt.id.slice(0, 8),
    name: rt.name,
    description: rt.description,
    icon: rt.icon,
    search_terms: rt.keywords ?? [],
    kb_link: rt.kb_link,
    disruption_banner: rt.disruption_banner,
    on_behalf_policy: rt.on_behalf_policy ?? 'self_only',
    display_order: rt.display_order ?? 0,
    active: rt.active,
    categories: categoryIds.map((cid) => ({ id: cid, category_id: cid, display_order: 0 })),
    offerings: coverage,
    criteria: audience,
    form_variants: variants,
    on_behalf_rules: onBehalfRules,
    scope_overrides: scopeOverrides,
  };
}

export function CatalogServicePanel({ requestTypeId, onSaved, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequestTypeDetail | null>(null);
  const [activeTab, setActiveTab] = useState('basics');

  useEffect(() => {
    if (!requestTypeId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setError(null);
    setDetail(null);
    setActiveTab('basics');
    loadDetail(requestTypeId)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [requestTypeId]);

  const reload = async () => {
    if (!requestTypeId) return;
    try {
      const fresh = await loadDetail(requestTypeId);
      setDetail(fresh);
      onSaved();
    } catch {
      // toast surfaced by child
    }
  };

  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    if (!requestTypeId || !detail) return;
    if (!confirm(`Delete "${detail.name}"? It will be deactivated and hidden from the portal. Existing tickets are unaffected.`)) {
      return;
    }
    setDeleting(true);
    try {
      await apiFetch(`/request-types/${requestTypeId}`, { method: 'DELETE' });
      toast.success('Service deactivated');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  if (!requestTypeId) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2 max-w-xs text-center">
          <MousePointerClick className="size-5 opacity-50" />
          <p>Select a request type from the tree to view its configuration.</p>
        </div>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Failed to load</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!detail) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold truncate">{detail.name}</h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            {!detail.active && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="basics">Basics</TabsTrigger>
          <TabsTrigger value="coverage">
            Coverage
            {detail.offerings.filter((o) => o.active).length > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {detail.offerings.filter((o) => o.active).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="audience">
            Audience
            {detail.criteria.filter((c) => c.active).length > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {detail.criteria.filter((c) => c.active).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="form">
            Form
            {detail.form_variants.filter((v) => v.active).length > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {detail.form_variants.filter((v) => v.active).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="fulfillment">Fulfillment</TabsTrigger>
        </TabsList>

        <TabsContent value="basics" className="mt-4">
          <CatalogBasicsTab
            detail={detail}
            onSaved={reload}
            onDelete={handleDelete}
            deleting={deleting}
          />
        </TabsContent>
        <TabsContent value="coverage" className="mt-4">
          <CatalogCoverageTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="audience" className="mt-4">
          <CatalogAudienceTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="form" className="mt-4">
          <CatalogFormTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="fulfillment" className="mt-4">
          <CatalogFulfillmentTab
            detail={detail}
            onSaved={reload}
            requestTypeId={requestTypeId!}
            onDelete={handleDelete}
            deleting={deleting}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
