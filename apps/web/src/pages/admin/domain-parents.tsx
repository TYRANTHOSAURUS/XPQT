import { DomainFallbacksEditor } from '@/components/admin/routing-studio/domain-fallbacks-editor';
import { LegacyRoutingPageBanner } from '@/components/admin/routing-studio/legacy-page-banner';

export function DomainParentsPage() {
  return (
    <div>
      <LegacyRoutingPageBanner tab="coverage" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Domain Hierarchy</h1>
        <p className="text-muted-foreground mt-1">
          Parent-domain fallback for cross-domain routing (e.g. "doors" → "fm" means doors requests fall back to fm teams when no doors team matches).
        </p>
      </div>
      <DomainFallbacksEditor />
    </div>
  );
}
