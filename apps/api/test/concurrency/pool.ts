/**
 * pg.Pool factory for the concurrency harness.
 *
 * Spec ref: docs/follow-ups/b0-real-db-concurrency-harness.md.
 *
 * Targets the local Supabase stack by default (`pnpm db:start`):
 *   host=127.0.0.1 port=54322 user=postgres password=postgres db=postgres.
 *
 * Override via env so CI / a dedicated test DB can repoint without
 * editing source:
 *   - SUPABASE_DB_HOST     (default 127.0.0.1)
 *   - SUPABASE_DB_PORT     (default 54322)
 *   - SUPABASE_DB_USER     (default postgres)
 *   - SUPABASE_DB_PASSWORD (default postgres)
 *   - SUPABASE_DB_NAME     (default postgres)
 *
 * The pool is sized for two-connection contention scenarios; bumping
 * `max` higher buys nothing because every test holds at most two
 * concurrent connections.
 */

import { Pool, PoolConfig } from 'pg';

export interface ConcurrencyPoolConfig extends PoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function getPoolConfig(): ConcurrencyPoolConfig {
  return {
    host: process.env.SUPABASE_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.SUPABASE_DB_PORT ?? '54322'),
    user: process.env.SUPABASE_DB_USER ?? 'postgres',
    password: process.env.SUPABASE_DB_PASSWORD ?? 'postgres',
    database: process.env.SUPABASE_DB_NAME ?? 'postgres',
    // Two connections for the contention probe + a couple of headroom
    // for fixture seeding/teardown that runs in parallel.
    max: 6,
    // Concurrency tests poll pg_locks; keep idle timeout short so a
    // failed test doesn't hold connections beyond the test run.
    idleTimeoutMillis: 5_000,
    // 10s connect timeout — local Supabase comes up fast; CI should
    // already have it warm before this job starts.
    connectionTimeoutMillis: 10_000,
  };
}

let pool: Pool | null = null;

/**
 * Lazily create a shared pool. Tests usually call this once per file
 * in beforeAll and close in afterAll; the singleton avoids
 * connection-storm churn when multiple specs run sequentially.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(getPoolConfig());
  }
  return pool;
}

export async function endPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
