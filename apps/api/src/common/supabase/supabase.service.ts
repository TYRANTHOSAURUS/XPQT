import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private adminClient!: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const serviceKey = this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');

    // Admin client bypasses RLS — used for tenant registry operations
    // and platform-level queries only
    this.adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
  }

  /** Admin client — bypasses RLS. Use only for platform-level operations. */
  get admin(): SupabaseClient {
    return this.adminClient;
  }

  /** Create a client scoped to a specific user's JWT — RLS enforced. */
  forUser(accessToken: string): SupabaseClient {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');

    return createClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      auth: { persistSession: false },
    });
  }
}
