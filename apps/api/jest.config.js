/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
    // Transform ESM-only node_modules (jsdom 29 transitive deps) with Babel.
    '^.+\\.(?:js|mjs|cjs)$': ['babel-jest', {
      plugins: [
        '@babel/plugin-transform-modules-commonjs',
        '@babel/plugin-transform-export-namespace-from',
      ],
    }],
  },
  // Map isomorphic-dompurify to its browser (no-jsdom) CJS build.
  // jest.setup.js installs a jsdom global.window so DOMPurify has a DOM to work with.
  //
  // WHY THIS EXISTS: isomorphic-dompurify's Node build pulls in jsdom 29, which has
  // ESM-only transitive deps that Jest can't load without extensive Babel plumbing.
  // The browser build is the exact same DOMPurify core — only the window provider
  // differs. For a sanitizer test the parser logic is what matters; the DOM host is
  // incidental. At runtime production uses the Node build. If you change the
  // ALLOWED_TAGS / ALLOWED_ATTR lists in svg-sanitizer.ts, the security behavior is
  // the same under either build because DOMPurify's tag/attribute enforcement is
  // host-independent.
  moduleNameMapper: {
    '^isomorphic-dompurify$': '<rootDir>/../node_modules/isomorphic-dompurify/dist/browser.js',
  },
  setupFiles: ['<rootDir>/../jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!.*(@asamuzakjp|@csstools|@exodus|html-encoding-sniffer|whatwg-url|whatwg-mimetype|parse5))',
  ],
};
