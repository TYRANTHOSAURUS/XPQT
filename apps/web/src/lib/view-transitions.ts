/**
 * Wrap `document.startViewTransition` with a feature check so call sites
 * don't repeat the type assertion. Falls back to running the callback
 * synchronously in browsers that don't support the API.
 */
type DocWithVT = Document & { startViewTransition?: (cb: () => void) => unknown };

export function startViewTransition(cb: () => void): void {
  const start = (document as DocWithVT).startViewTransition;
  if (typeof start === 'function') {
    start.call(document, cb);
  } else {
    cb();
  }
}
