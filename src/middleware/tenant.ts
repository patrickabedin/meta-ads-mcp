// ═══════════════════════════════════════════════════════════════════════════
//  Middleware — Tenant Resolution, Usage Tracking, Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════

import type { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../db/index.js';
import { findCustomerByApiKey, findAdAccountByMetaId, incrementCustomerUsage, logUsage, findAdminByEmail } from '../db/index.js';
import { verifyJwt, decryptToken } from './crypto.js';
import type { RequestContext, Customer } from '../types/index.js';

// Extend Fastify request type
declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 120; // requests per window per customer

// ── Tenant Resolver ──
export async function resolveTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx: RequestContext = {};

  // 1. Check for customer API key (MCP or REST)
  const apiKey =
    (request.headers['x-customer-api-key'] as string) ||
    (request.query as Record<string, string>)?.customer_api_key ||
    (request.headers.authorization?.startsWith('Bearer mak_') ? request.headers.authorization.slice(7) : undefined);

  if (apiKey) {
    const customer = await findCustomerByApiKey(apiKey);
    if (customer && customer.status === 'active') {
      ctx.customer = customer;
    }
  }

  // 2. Check for admin JWT
  const adminToken = request.headers['x-admin-token'] as string;
  if (adminToken) {
    const decoded = verifyJwt(adminToken);
    if (decoded && decoded.email) {
      const admin = await findAdminByEmail(decoded.email as string);
      if (admin) {
        ctx.isAdmin = true;
        ctx.admin = admin;
      }
    }
  }

  // 3. Check for Meta account scoping
  const metaAccountId = (request.headers['x-meta-account-id'] as string) || (request.query as Record<string, string>)?.account_id;
  if (ctx.customer && metaAccountId) {
    const account = await findAdAccountByMetaId(ctx.customer.id, metaAccountId);
    if (account && account.status === 'connected') {
      ctx.account = account;
      try {
        ctx.metaToken = decryptToken(account.meta_access_token_encrypted);
      } catch (e) {
        console.error('Failed to decrypt token for account', account.id, e);
      }
      ctx.metaAccountId = account.meta_ad_account_id;
    }
  }

  // 4. Fallback to direct X-Meta-Token (for master key or testing)
  if (!ctx.metaToken) {
    const directToken = request.headers['x-meta-token'] as string;
    if (directToken) {
      ctx.metaToken = directToken;
      ctx.metaAccountId = metaAccountId || undefined;
    }
  }

  request.ctx = ctx;
}

// ── Rate Limiter ──
export async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Skip rate limit for health
  const path = request.url.split('?')[0];
  if (path === '/health') return;

  const identifier = request.ctx?.customer?.id || request.ip;
  const key = `ratelimit:${identifier}`;

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  if (current > RATE_LIMIT_MAX) {
    reply.status(429).send({ error: 'Rate limit exceeded. Please slow down.' });
    return;
  }
}

// ── Usage Tracker ──
export async function trackUsage(
  request: FastifyRequest,
  toolName: string,
  startTime: number,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  if (!request.ctx.customer) return;

  const customerId = request.ctx.customer.id;
  const responseTime = Math.round(Date.now() - startTime);

  try {
    await incrementCustomerUsage(customerId);
    await logUsage({
      customer_id: customerId,
      tool_name: toolName,
      ad_account_id: request.ctx.metaAccountId || null,
      executed_at: new Date(),
      response_time_ms: responseTime,
      success,
      error_message: errorMessage || null,
    });
  } catch (e) {
    console.error('Failed to track usage:', e);
  }
}

// ── Tier Enforcement ──
export function checkTier(customer: Customer, feature: string): boolean {
  const tierFeatures: Record<string, string[]> = {
    free: ['campaigns', 'adsets', 'ads', 'creatives', 'insights', 'audiences', 'images', 'targeting', 'previews', 'reach_estimate', 'activities'],
    pro: ['campaigns', 'adsets', 'ads', 'creatives', 'insights', 'audiences', 'images', 'videos', 'targeting', 'previews', 'reach_estimate', 'activities', 'copies', 'labels', 'budget_schedules'],
    premium: ['campaigns', 'adsets', 'ads', 'creatives', 'insights', 'audiences', 'images', 'videos', 'targeting', 'previews', 'reach_estimate', 'activities', 'copies', 'labels', 'budget_schedules', 'rules', 'batch', 'conversions', 'custom_conversions', 'pixel', 'leadgen'],
    enterprise: ['*'],
  };

  const features = tierFeatures[customer.tier] || tierFeatures.free;
  return features.includes('*') || features.includes(feature);
}

export function checkWeeklyQuota(customer: Customer): boolean {
  return customer.weekly_executions_used < customer.weekly_executions_limit;
}

// ── Weekly Quota Reset Scheduler ──
export function startWeeklyResetScheduler(): void {
  // Reset every Sunday at 00:00 UTC
  const now = new Date();
  const nextSunday = new Date(now);
  nextSunday.setUTCDate(now.getUTCDate() + (7 - now.getUTCDay()));
  nextSunday.setUTCHours(0, 0, 0, 0);
  const msUntilSunday = nextSunday.getTime() - now.getTime();

  setTimeout(() => {
    resetAllWeeklyUsage();
    // Then every 7 days
    setInterval(resetAllWeeklyUsage, 7 * 24 * 60 * 60 * 1000);
  }, msUntilSunday);
}

async function resetAllWeeklyUsage(): Promise<void> {
  try {
    const { resetWeeklyUsage } = await import('../db/index.js');
    await resetWeeklyUsage();
    console.log('Weekly usage quotas reset for all customers');
  } catch (e) {
    console.error('Failed to reset weekly usage:', e);
  }
}
