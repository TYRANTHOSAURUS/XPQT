import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';

/**
 * Global module exposing the direct Postgres pool. See `DbService` for
 * when to use this vs. `SupabaseService`.
 */
@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
