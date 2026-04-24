// ESLint flat config for the web app.
// Previously the project shipped with `"lint": "eslint ."` but no config,
// so no rules ran. This wires two plugins where every rule catches a real
// behavioral bug (not a style nit):
//
//  - @tanstack/query — query-key drift, unstable clients, missing deps.
//    Each of these maps to a cache-correctness issue that's easy to miss
//    in review and hard to debug in prod.
//  - react-hooks    — stale closures, rule-of-hooks violations. Existing
//    `eslint-disable-next-line react-hooks/...` comments in the codebase
//    assumed this was enabled; wiring it makes those comments load-bearing
//    and catches future bugs in the same family.
//
// Deliberately minimal: NOT pulling typescript-eslint's recommended preset
// because that would surface hundreds of existing issues on a 200+-file
// codebase with no prior lint config, drowning out the RQ findings.

import pluginQuery from '@tanstack/eslint-plugin-query';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.vercel/**', 'eslint.config.js'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@tanstack/query': pluginQuery,
      'react-hooks': pluginReactHooks,
    },
    rules: {
      '@tanstack/query/exhaustive-deps': 'error',
      '@tanstack/query/no-rest-destructuring': 'warn',
      '@tanstack/query/stable-query-client': 'error',
      '@tanstack/query/no-unstable-deps': 'error',
      '@tanstack/query/infinite-query-property-order': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
