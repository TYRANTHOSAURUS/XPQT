import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Direct Postgres pool — bypasses Supabase REST.
 *
 * Why: every Supabase REST call adds ~70–90 ms of HTTP / JSON overhead
 * on top of the underlying SQL. For hot paths (scheduler-data,
 * picker, search) and bulk operations on large tenants, that overhead
 * dominates the budget. A persistent `pg.Pool` keeps a TCP connection
 * to Postgres warm and skips the entire HTTPS / PostgREST hop —
 * round-trip drops to ~5–15 ms even from outside the VPC.
 *
 * Coexistence with `SupabaseService`:
 *   - Auth, Storage, Realtime, and any feature that needs the user's
 *     JWT for RLS keep using `SupabaseService` — it's the right tool
 *     for those.
 *   - Tenant-scoped query paths that already pass `tenant_id` as a
 *     filter (every `eq('tenant_id', t)` chain in the codebase) move
 *     to `DbService.rpc` / `db.query` over time. RLS isn't enforced
 *     here — the same as `supabase.admin` calls today, which already
 *     bypass RLS via the service-role key. Tenant scoping stays the
 *     application's job.
 *
 * Connection target:
 *   - Default: direct connection on port 5432 (`db.<projectref>.supabase.co`).
 *     One Nest instance, bounded pool of 20 connections, fine for now.
 *   - Multi-instance / serverless: switch `SUPABASE_DB_URL` to the
 *     transaction-mode pooler (`aws-0-<region>.pooler.supabase.com:6543`).
 *     `pg` works with both because we don't issue named prepared
 *     statements (the only feature transaction-mode pooler doesn't
 *     allow).
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DbService.name);
  private pool: Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Connection is configured lazily so the API can boot in environments
    // that don't provision direct DB credentials (e.g. demo/preview deploys
    // that only use the Supabase REST + service-role path). Routes that
    // actually need pg will fail at first use with a clear error.
    const hasUrl = !!this.config.get<string>('SUPABASE_DB_URL');
    const hasPass = !!this.config.get<string>('SUPABASE_DB_PASS');
    if (!hasUrl && !hasPass) {
      this.log.warn('pg pool not initialised: SUPABASE_DB_URL/SUPABASE_DB_PASS missing');
      return;
    }
    await this.initPool();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private async initPool(): Promise<void> {
    const connectionString = this.resolveConnectionString();
    const max = Number(this.config.get<string | number>('PG_POOL_MAX') ?? 20);

    this.pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
    });

    this.pool.on('error', (err) => {
      this.log.error(`pg pool error: ${err.message}`);
    });

    const c = await this.pool.connect();
    try {
      await c.query('select 1');
      this.log.log(`pg pool ready: max=${max}`);
    } finally {
      c.release();
    }
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error(
        'DbService not configured: set SUPABASE_DB_URL or SUPABASE_DB_PASS to use direct Postgres queries',
      );
    }
    return this.pool;
  }

  /**
   * Resolve the connection string.
   *
   * Precedence:
   *   1. `SUPABASE_DB_URL` if set — full override (lets ops point at a
   *      pooler, replica, or dev DB without code changes).
   *   2. Otherwise build from `SUPABASE_URL` (project ref) + `SUPABASE_DB_PASS`.
   */
  private resolveConnectionString(): string {
    const explicit = this.config.get<string>('SUPABASE_DB_URL');
    if (explicit) return explicit;

    const password = this.config.getOrThrow<string>('SUPABASE_DB_PASS');
    const projectRef = this.extractProjectRef();
    if (!projectRef) {
      throw new Error('Cannot derive Postgres host: SUPABASE_URL is missing or malformed');
    }
    const host = this.config.get<string>('PG_HOST') ?? `db.${projectRef}.supabase.co`;
    const port = this.config.get<string | number>('PG_PORT') ?? 5432;
    return `postgresql://postgres:${encodeURIComponent(password)}@${host}:${port}/postgres`;
  }

  private extractProjectRef(): string | null {
    const url = this.config.get<string>('SUPABASE_URL') ?? '';
    const match = url.match(/^https?:\/\/([^.]+)\./);
    return match?.[1] ?? null;
  }

  /**
   * Run a parameterised SQL query. Parameters use `$1, $2, …` placeholders;
   * never inline user input into the SQL string.
   */
  async query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.requirePool().query<T>(sql, params);
  }

  /**
   * Single-row helper. Returns the first row or `null`. Matches the shape
   * of the very common `.maybeSingle()` Supabase pattern so migration is
   * straight find-and-replace at most call sites.
   */
  async queryOne<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> {
    const res = await this.requirePool().query<T>(sql, params);
    return res.rows[0] ?? null;
  }

  /**
   * Multi-row helper. Returns just the rows (drops the wrapper). Equivalent
   * to `.then(({ data }) => data ?? [])` over a Supabase select.
   */
  async queryMany<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const res = await this.requirePool().query<T>(sql, params);
    return res.rows;
  }

  /**
   * Call a Postgres function by name with named arguments. Mirrors the
   * shape of `supabase.admin.rpc(name, args)` so migration is mostly
   * find-and-replace.
   *
   * The function is invoked as `select <name>(arg1 := $1, arg2 := $2)`
   * and the scalar result is returned — covers our "function returns
   * jsonb" pattern (e.g. `scheduler_data`). For functions that return
   * `setof <row>`, use `query` directly.
   */
  async rpc<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const entries = Object.entries(args);
    const argList = entries.map(([k], i) => `${k} := $${i + 1}`).join(', ');
    const values = entries.map(([, v]) => v);
    const sql = entries.length > 0
      ? `select public.${name}(${argList}) as result`
      : `select public.${name}() as result`;
    type Row = { result: T };
    const res = await this.requirePool().query<Row>(sql, values);
    return res.rows[0]?.result as T;
  }

  /**
   * Run a callback inside a transaction. The callback receives a
   * dedicated `PoolClient` — issue all queries through it (not through
   * `db.query`, which would grab a different connection from the pool
   * and miss the transaction context).
   */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      try {
        await client.query('rollback');
      } catch {
        // ignore — original error is what we want to surface
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
