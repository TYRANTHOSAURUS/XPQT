/**
 * Jest config for the B.0 real-DB concurrency harness.
 *
 * Spec ref: docs/follow-ups/b0-real-db-concurrency-harness.md.
 *
 * Why a separate config:
 *   These tests open real Postgres connections to the local Supabase
 *   stack, hold advisory locks across two clients, and assert via
 *   pg_locks that the second connection blocks. They cannot be batched
 *   with the unit specs in apps/api/src — they are slow (30s timeouts),
 *   require a running database, and MUST run --runInBand because the
 *   assertions touch shared rows.
 *
 *   The default config at apps/api/jest.config.js sets rootDir=src and
 *   testRegex='.*\\.spec\\.ts$', so these files under
 *   apps/api/test/concurrency/ are NOT picked up by `pnpm test`.
 *   They run only via the explicit `pnpm test:concurrency` script.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          types: ['node', 'jest'],
        },
      },
    ],
  },
  // 30s default; advisory-lock-blocked clients can hold for ~250ms in
  // happy paths but reservation-of-time gives us slack for slow CI.
  testTimeout: 30000,
  // Concurrency tests must serialise — they share advisory-lock keyspace.
  maxWorkers: 1,
  // Quiet down jest's "no tests" worker exit when a single file is filtered.
  passWithNoTests: false,
};
