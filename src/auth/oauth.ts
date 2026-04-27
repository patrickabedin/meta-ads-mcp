// ═══════════════════════════════════════════════════════════════════════════
//  Meta OAuth Callback Handler
// ═══════════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from 'fastify';
import { redis } from '../db/index.js';
import { findCustomerById, createAdAccount } from '../db/index.js';
import { encryptToken } from './crypto.js';

export async function registerOAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/auth/meta/callback', {
    schema: { hide: true },
  }, async (request, reply) => {
    const { code, state, error: oauthError, error_reason, error_description } = request.query as Record<string, string>;

    if (oauthError) {
      return reply.type('text/html').send(renderErrorPage(`OAuth error: ${oauthError} - ${error_description || error_reason}`));
    }

    if (!code || !state) {
      return reply.type('text/html').send(renderErrorPage('Missing authorization code or state.'));
    }

    // Verify state from Redis
    const customerId = await redis.get(`oauth:state:${state}`);
    if (!customerId) {
      return reply.type('text/html').send(renderErrorPage('Invalid or expired OAuth state. Please try again.'));
    }

    const customer = await findCustomerById(customerId);
    if (!customer) {
      return reply.type('text/html').send(renderErrorPage('Customer not found.'));
    }

    // Exchange code for access token
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.OAUTH_REDIRECT_URL || `https://${request.headers.host}/auth/meta/callback`;

    if (!appId || !appSecret) {
      return reply.type('text/html').send(renderErrorPage('Server configuration error: Missing Meta app credentials.'));
    }

    try {
      const tokenRes = await fetch(
        `https://graph.facebook.com/v22.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`
      );
      const tokenData = await tokenRes.json() as { access_token?: string; expires_in?: number; error?: { message: string } };

      if (tokenData.error || !tokenData.access_token) {
        return reply.type('text/html').send(renderErrorPage(`Token exchange failed: ${tokenData.error?.message || 'Unknown error'}`));
      }

      // Get user's ad accounts
      const accountsRes = await fetch(
        `https://graph.facebook.com/v22.0/me/adaccounts?fields=id,name&limit=50&access_token=${tokenData.access_token}`
      );
      const accountsData = await accountsRes.json() as { data?: Array<{ id: string; name: string }>; error?: { message: string } };

      if (accountsData.error) {
        return reply.type('text/html').send(renderErrorPage(`Failed to fetch ad accounts: ${accountsData.error.message}`));
      }

      const accounts = accountsData.data || [];
      const existingAccounts = await import('../db/index.js').then(m => m.findAdAccountsByCustomer(customer.id));
      const remainingSlots = customer.max_ad_accounts - existingAccounts.length;

      let connectedCount = 0;
      for (const acct of accounts.slice(0, remainingSlots)) {
        const encryptedToken = encryptToken(tokenData.access_token);
        await createAdAccount({
          customer_id: customer.id,
          meta_ad_account_id: acct.id,
          meta_access_token_encrypted: encryptedToken,
          meta_refresh_token: null,
          token_expires_at: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
          account_name: acct.name,
          status: 'connected',
        });
        connectedCount++;
      }

      // Clean up state
      await redis.del(`oauth:state:${state}`);

      return reply.type('text/html').send(renderSuccessPage(connectedCount, accounts.length, remainingSlots));
    } catch (e) {
      console.error('OAuth callback error:', e);
      return reply.type('text/html').send(renderErrorPage('Internal server error during OAuth callback.'));
    }
  });
}

function renderSuccessPage(connected: number, total: number, remaining: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meta Connected — META ADS MCP</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{background:#1e293b;border-radius:16px;padding:48px;max-width:420px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5)}
.icon{font-size:64px;margin-bottom:16px}
h1{margin:0 0 8px;font-size:24px}
p{margin:0 0 24px;color:#94a3b8;line-height:1.6}
.btn{display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;transition:background .2s}
.btn:hover{background:#2563eb}
</style></head><body>
<div class="card"><div class="icon">✅</div><h1>Meta Account Connected!</h1>
<p>Successfully connected <strong>${connected}</strong> of ${total} ad accounts.<br>
${remaining > 0 ? `You can connect up to <strong>${remaining}</strong> more.` : 'You have reached your account limit.'}<br>
Return to your dashboard to start using AI-powered ad management.</p>
<a class="btn" href="/dashboard">Go to Dashboard</a>
</div></body></html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error — META ADS MCP</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{background:#1e293b;border-radius:16px;padding:48px;max-width:420px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5)}
.icon{font-size:64px;margin-bottom:16px}
h1{margin:0 0 8px;font-size:24px;color:#ef4444}
p{margin:0 0 24px;color:#94a3b8;line-height:1.6}
.btn{display:inline-block;background:#475569;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600}
</style></head><body>
<div class="card"><div class="icon">❌</div><h1>Connection Failed</h1>
<p>${message}<br>Please try again or contact support.</p>
<a class="btn" href="/dashboard">Back to Dashboard</a>
</div></body></html>`;
}
