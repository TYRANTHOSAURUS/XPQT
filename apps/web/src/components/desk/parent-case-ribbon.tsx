import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/api';

interface ParentCaseRibbonProps {
  parentId: string;
}

interface ParentMinimal {
  id: string;
  title: string;
}

/**
 * Top-of-page ribbon shown on work-order detail that links back to the parent case.
 * Fetches only the parent's title in a tiny request — the detail view doesn't join it today.
 */
export function ParentCaseRibbon({ parentId }: ParentCaseRibbonProps) {
  const [parent, setParent] = useState<ParentMinimal | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ParentMinimal>(`/tickets/${parentId}`)
      .then((row) => { if (!cancelled) setParent({ id: row.id, title: row.title }); })
      .catch(() => { if (!cancelled) setParent({ id: parentId, title: 'parent case' }); });
    return () => { cancelled = true; };
  }, [parentId]);

  return (
    <Link
      to={`/desk/tickets/${parentId}`}
      className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 border-b"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      <span>Work order of</span>
      <span className="font-medium text-foreground truncate">{parent?.title ?? '…'}</span>
    </Link>
  );
}
