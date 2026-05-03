import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement window.matchMedia — stub it so hooks like
// useIsMobile() don't throw in tests. Default: desktop (not mobile).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
