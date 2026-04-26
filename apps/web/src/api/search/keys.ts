export const searchKeys = {
  all: ['search'] as const,
  query: (q: string, types?: string[]) =>
    [...searchKeys.all, q, types?.slice().sort().join(',') ?? 'all'] as const,
} as const;
