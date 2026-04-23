/**
 * Minimal JSONPath evaluator for webhook payload mapping.
 * Supports: $.a.b, $.items[0].name, a.b (leading $ optional).
 * Returns undefined for any missing / type-mismatched step.
 */
export function evalJsonPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const cleaned = path.replace(/^\$\.?/, '');
  if (!cleaned) return obj;

  const tokens: Array<string | number> = [];
  for (const segment of cleaned.split('.')) {
    const m = segment.match(/^([^[\]]+)?((?:\[\d+\])*)$/);
    if (!m) { tokens.push(segment); continue; }
    if (m[1]) tokens.push(m[1]);
    const idxMatches = m[2].match(/\[(\d+)\]/g);
    if (idxMatches) for (const idx of idxMatches) tokens.push(Number(idx.slice(1, -1)));
  }

  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}
