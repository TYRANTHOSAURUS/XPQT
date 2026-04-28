// Test-time stub for @react-pdf/renderer. The real module is ESM-only
// and Jest's default CommonJS transform pipeline can't handle it. None
// of our unit tests exercise actual PDF rendering — that path is
// integration-tested separately. Returning empty buffers + no-op
// components keeps the import chain compilable.
//
// Wired via `moduleNameMapper` in jest.config.js.

module.exports = {
  renderToBuffer: async () => Buffer.alloc(0),
  Document: () => null,
  Page: () => null,
  Text: () => null,
  View: () => null,
  Image: () => null,
  Link: () => null,
  Note: () => null,
  Canvas: () => null,
  Svg: () => null,
  StyleSheet: {
    create: (styles) => styles,
  },
  Font: {
    register: () => {},
    getRegisteredFonts: () => [],
  },
  pdf: () => ({
    toBuffer: async () => Buffer.alloc(0),
    toBlob: async () => null,
    toString: async () => '',
  }),
};
