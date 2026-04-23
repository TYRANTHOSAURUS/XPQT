import { Injectable, UnauthorizedException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import type { WebhookRow } from './webhook-types';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

@Injectable()
export class WebhookAuthService {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Authenticate an inbound webhook request. Returns the webhook row on
   * success or throws a NestJS HTTP exception on failure.
   *
   * HMAC is intentionally not implemented in v1 — add a second branch here
   * and a nullable hmac_secret column on workflow_webhooks when needed.
   */
  async verify(authorizationHeader: string | undefined, sourceIp: string | undefined): Promise<WebhookRow> {
    const key = this.extractBearerKey(authorizationHeader);
    if (!key) throw new UnauthorizedException('Missing Bearer API key');

    const hash = createHash('sha256').update(key).digest('hex');
    const { data, error } = await this.supabase.admin
      .from('workflow_webhooks')
      .select('*')
      .eq('api_key_hash', hash)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new UnauthorizedException('Invalid API key');

    const webhook = data as WebhookRow;
    if (!webhook.active) throw new ForbiddenException('Webhook is inactive');

    this.assertIpAllowed(webhook, sourceIp);
    this.assertRateLimit(webhook);

    return webhook;
  }

  private extractBearerKey(header: string | undefined): string | null {
    if (!header) return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }

  private assertIpAllowed(webhook: WebhookRow, sourceIp: string | undefined) {
    if (!webhook.allowed_cidrs?.length) return;
    if (!sourceIp) throw new ForbiddenException('Source IP unresolvable');
    const ok = webhook.allowed_cidrs.some(cidr => ipMatchesCidr(sourceIp, cidr));
    if (!ok) throw new ForbiddenException('Source IP not permitted');
  }

  private assertRateLimit(webhook: WebhookRow) {
    const limit = webhook.rate_limit_per_minute ?? 60;
    const now = Date.now();
    const refillPerMs = limit / 60_000;
    const b = this.buckets.get(webhook.id) ?? { tokens: limit, updatedAt: now };
    const elapsed = now - b.updatedAt;
    b.tokens = Math.min(limit, b.tokens + elapsed * refillPerMs);
    b.updatedAt = now;
    if (b.tokens < 1) {
      this.buckets.set(webhook.id, b);
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    b.tokens -= 1;
    this.buckets.set(webhook.id, b);
  }
}

/**
 * Tiny CIDR match for IPv4 and exact-match for IPv6. Good enough for a
 * per-webhook allowlist — real protection belongs at the edge.
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!ip.includes('.') || !base.includes('.')) return ip === base;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
