export const searchKeys = {
  all: ['search'] as const,
  query: (q: string, types?: string[], limit?: number) =>
    [
      ...searchKeys.all,
      q,
      types?.slice().sort().join(',') ?? 'all',
      // limit must be in the key — the same (q, types) at limit=4 vs
      // limit=20 returns different result shapes, and conflating them in
      // cache would serve stale truncated payloads.
      limit ?? 4,
    ] as const,
} as const;
