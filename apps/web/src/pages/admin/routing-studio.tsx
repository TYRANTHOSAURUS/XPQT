import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';
import { CaseOwnershipEditor } from '@/components/admin/routing-studio/case-ownership-editor';
import { VisibilityTab } from '@/components/admin/routing-studio/visibility-tab';
import { RoutingMap } from '@/components/admin/routing-studio/routing-map';
import { ChildDispatchTab } from '@/components/admin/routing-studio/child-dispatch-tab';
import { AdvancedOverridesTab } from '@/components/admin/routing-studio/advanced-overrides-tab';

/**
 * Routing Studio — seven top-level tabs matching Artifact C's target IA:
 *
 *   Routing Map · Case Ownership · Child Dispatch · Visibility ·
 *   Simulator · Advanced Overrides · Audit
 *
 * Removed from the v0 layout: Overview (empty state now lives in Routing
 * Map), Coverage (legacy matrix; merged into Child Dispatch sub-panel),
 * Mappings + Groups (ditto), Domains + Fallbacks (merged into Advanced
 * Overrides sub-panels). Old `?tab=` URLs redirect to the new tab they
 * live inside so bookmarks keep working.
 *
 * ─── Deep-link contract ─────────────────────────────────────────────────
 *
 * Routing Studio is the canonical destination for any rule-touching link
 * across the admin. Other hubs (Person, Request Type, Location, Vendor,
 * Team, Ticket) deep-link in via these query params. Keep this contract
 * stable — every hub depends on it.
 *
 *   ?tab=<tab>            Lands on a specific tab. Aliases for the
 *                         retired `coverage`/`mappings`/`groups`/
 *                         `fallbacks`/`domains`/`overview` values are
 *                         resolved by `coerceTab` so old bookmarks keep
 *                         working.
 *
 *   ?rt=<request_type_id> Pre-fills Case Ownership / Child Dispatch with
 *                         the chosen request type and pre-loads the
 *                         Simulator's request-type field. Today: wired.
 *
 *   ?location=<space_id>  Filters Routing Map + Child Dispatch to rules
 *                         and mappings touching this space (and its
 *                         descendants via space closure). Wired by the
 *                         Location hub PR (Wave 1).
 *
 *   ?team=<team_id>       Filters rules with action_assign_team_id
 *                         pointing at this team. Wired by the Team hub
 *                         PR (Wave 1).
 *
 *   ?vendor=<vendor_id>   Filters rules with action_assign_vendor_id
 *                         pointing at this vendor. Wired alongside the
 *                         vendor-routing un-dormanting (Wave 1).
 *
 *   ?rule=<rule_id>       Opens Advanced Overrides on the named rule and
 *                         scrolls/highlights it. Wired alongside the
 *                         "smart-link fact bar" PR (Wave 1).
 *
 *   ?ticket=<ticket_id>   Pre-fills the Simulator with the ticket's
 *                         request-type/location/requester context and
 *                         opens the Audit tab filtered to this ticket.
 *                         Wired by the `tickets.routing_rule_id`
 *                         backlink PR (Wave 1).
 *
 * Params are read once on mount + on URL change. Tabs that don't yet
 * consume a param ignore it without erroring; the param survives in the
 * URL so a follow-up PR can wire it without a contract change.
 */

type TabId =
  | 'routing-map'
  | 'case-ownership'
  | 'child-dispatch'
  | 'visibility'
  | 'simulator'
  | 'rules'
  | 'audit';

const VALID_TABS: readonly TabId[] = [
  'routing-map',
  'case-ownership',
  'child-dispatch',
  'visibility',
  'simulator',
  'rules',
  'audit',
] as const;

// Old URLs land on the new tab that absorbs them.
const TAB_ALIASES: Record<string, TabId> = {
  overview: 'routing-map',
  coverage: 'child-dispatch',
  mappings: 'child-dispatch',
  groups: 'child-dispatch',
  fallbacks: 'rules',
  domains: 'rules',
};

function coerceTab(value: string | null): TabId {
  if (!value) return 'routing-map';
  if ((VALID_TABS as readonly string[]).includes(value)) return value as TabId;
  if (value in TAB_ALIASES) return TAB_ALIASES[value];
  return 'routing-map';
}

/**
 * Deep-link params other hubs send into Studio. Single source of truth for
 * (a) what Studio reads on mount and (b) what gets cleared when an admin
 * manually clicks between tabs (so stale context doesn't leak across tabs).
 * Keep in sync with the JSDoc contract above.
 */
const DEEP_LINK_PARAMS = ['rt', 'location', 'team', 'vendor', 'rule', 'ticket'] as const;
type DeepLinkParam = (typeof DEEP_LINK_PARAMS)[number];

export function RoutingStudioPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = coerceTab(searchParams.get('tab'));
  const [tab, setTabState] = useState<TabId>(urlTab);

  useEffect(() => {
    if (urlTab !== tab) setTabState(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const setTab = (next: TabId, extraParams?: Partial<Record<DeepLinkParam, string>>) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    // Clear all deep-link params when switching manually; deep-link
    // arrivals re-add them via extraParams. Without this, a stale rt /
    // location / team / etc. sticks across manual tab clicks.
    for (const key of DEEP_LINK_PARAMS) params.delete(key);
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        if (value) params.set(key, value);
      }
    }
    setSearchParams(params, { replace: true });
  };

  const openTabWithRt = (next: TabId, rtId: string) => setTab(next, { rt: rtId });
  const initialRtId = searchParams.get('rt') ?? null;
  const initialTicketId = searchParams.get('ticket') ?? null;

  return (
    <SettingsPageShell width="full">
      <SettingsPageHeader
        title="Routing Studio"
        description="One surface for how tickets get assigned. The resolver runs the steps below in order — first match wins."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(coerceTab(v))}>
        <TabsList>
          <TabsTrigger value="routing-map">Routing Map</TabsTrigger>
          <TabsTrigger value="case-ownership">Case Ownership</TabsTrigger>
          <TabsTrigger value="child-dispatch">Child Dispatch</TabsTrigger>
          <TabsTrigger value="visibility">Visibility</TabsTrigger>
          <TabsTrigger value="simulator">Simulator</TabsTrigger>
          <TabsTrigger value="rules">Advanced Overrides</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="routing-map">
          <RoutingMap
            onOpenTab={(t) => setTab(coerceTab(t))}
            onOpenForRequestType={openTabWithRt}
          />
        </TabsContent>

        <TabsContent value="case-ownership">
          <CaseOwnershipEditor initialRequestTypeId={tab === 'case-ownership' ? initialRtId : null} />
        </TabsContent>

        <TabsContent value="child-dispatch">
          <ChildDispatchTab initialRequestTypeId={tab === 'child-dispatch' ? initialRtId : null} />
        </TabsContent>

        <TabsContent value="visibility">
          <VisibilityTab />
        </TabsContent>

        <TabsContent value="simulator">
          <RoutingSimulator />
        </TabsContent>

        <TabsContent value="rules">
          <AdvancedOverridesTab />
        </TabsContent>

        <TabsContent value="audit">
          <RoutingAuditTab initialTicketId={tab === 'audit' ? initialTicketId : null} />
        </TabsContent>
      </Tabs>
    </SettingsPageShell>
  );
}
