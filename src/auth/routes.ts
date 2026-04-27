// ═══════════════════════════════════════════════════════════════════════════
//  Customer API Routes — Registration, Auth, Meta Account Management
// ═══════════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  findCustomerByEmail,
  createCustomer,
  findAdAccountsByCustomer,
  createAdAccount,
  deleteAdAccount,
} from '../db/index.js';
import { hashPassword, comparePassword, signJwt, generateApiKey, encryptToken } from '../auth/crypto.js';
import { redis } from '../db/index.js';
import type { RequestContext } from '../types/index.js';

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ConnectMetaSchema = z.object({
  meta_ad_account_id: z.string().regex(/^act_\d+$/),
  meta_access_token: z.string().min(1),
  meta_refresh_token: z.string().optional(),
  token_expires_at: z.string().optional(), // ISO date
  account_name: z.string().optional(),
});

export async function registerCustomerRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Register ──
  fastify.post('/api/v1/auth/register', {
    schema: {
      tags: ['Auth'],
      summary: 'Register a new customer',
      description: 'Create a free-tier customer account.',
      body: RegisterSchema,
      response: {
        201: z.object({ success: z.boolean(), customer: z.object({ id: z.string(), email: z.string(), name: z.string(), api_key: z.string() }) }),
        409: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { email, password, name } = request.body as z.infer<typeof RegisterSchema>;

    const existing = await findCustomerByEmail(email);
    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' });
    }

    const passwordHash = await hashPassword(password);
    const apiKey = generateApiKey();

    const customer = await createCustomer({
      email,
      name,
      password_hash: passwordHash,
      api_key: apiKey,
    });

    reply.status(201).send({
      success: true,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        api_key: customer.api_key,
      },
    });
  });

  // ── Login ──
  fastify.post('/api/v1/auth/login', {
    schema: {
      tags: ['Auth'],
      summary: 'Customer login',
      description: 'Authenticate and receive a JWT token.',
      body: LoginSchema,
      response: {
        200: z.object({ success: z.boolean(), token: z.string(), customer: z.object({ id: z.string(), email: z.string(), name: z.string(), api_key: z.string(), tier: z.string() }) }),
        401: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body as z.infer<typeof LoginSchema>;

    const customer = await findCustomerByEmail(email);
    if (!customer || !(await comparePassword(password, customer.password_hash))) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    if (customer.status !== 'active') {
      return reply.status(401).send({ error: 'Account is not active' });
    }

    const token = signJwt({ customerId: customer.id, email: customer.email, type: 'customer' });

    reply.send({
      success: true,
      token,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        api_key: customer.api_key,
        tier: customer.tier,
      },
    });
  });

  // ── Get Profile ──
  fastify.get('/api/v1/auth/me', {
    schema: {
      tags: ['Auth'],
      summary: 'Get current customer profile',
    },
  }, async (request, reply) => {
    const ctx = request.ctx as RequestContext;
    if (!ctx.customer) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const accounts = await findAdAccountsByCustomer(ctx.customer.id);

    reply.send({
      customer: {
        id: ctx.customer.id,
        email: ctx.customer.email,
        name: ctx.customer.name,
        tier: ctx.customer.tier,
        weekly_executions_used: ctx.customer.weekly_executions_used,
        weekly_executions_limit: ctx.customer.weekly_executions_limit,
        max_ad_accounts: ctx.customer.max_ad_accounts,
        status: ctx.customer.status,
        api_key: ctx.customer.api_key,
      },
      connected_accounts: accounts.map(a => ({
        id: a.id,
        meta_ad_account_id: a.meta_ad_account_id,
        account_name: a.account_name,
        status: a.status,
        connected_at: a.connected_at,
      })),
    });
  });

  // ── Connect Meta Ad Account ──
  fastify.post('/api/v1/customer/accounts/connect', {
    schema: {
      tags: ['Accounts'],
      summary: 'Connect a Meta ad account',
      description: 'Store an encrypted Meta access token for an ad account.',
      body: ConnectMetaSchema,
    },
  }, async (request, reply) => {
    const ctx = request.ctx as RequestContext;
    if (!ctx.customer) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const existingAccounts = await findAdAccountsByCustomer(ctx.customer.id);
    if (existingAccounts.length >= ctx.customer.max_ad_accounts) {
      return reply.status(403).send({ error: `Maximum ${ctx.customer.max_ad_accounts} ad accounts allowed on your tier.` });
    }

    const body = request.body as z.infer<typeof ConnectMetaSchema>;
    const encryptedToken = encryptToken(body.meta_access_token);

    const account = await createAdAccount({
      customer_id: ctx.customer.id,
      meta_ad_account_id: body.meta_ad_account_id,
      meta_access_token_encrypted: encryptedToken,
      meta_refresh_token: body.meta_refresh_token || null,
      token_expires_at: body.token_expires_at ? new Date(body.token_expires_at) : null,
      account_name: body.account_name || null,
      status: 'connected',
    });

    reply.status(201).send({
      success: true,
      account: {
        id: account.id,
        meta_ad_account_id: account.meta_ad_account_id,
        account_name: account.account_name,
      },
    });
  });

  // ── List Connected Accounts ──
  fastify.get('/api/v1/customer/accounts', {
    schema: {
      tags: ['Accounts'],
      summary: 'List connected Meta ad accounts',
    },
  }, async (request, reply) => {
    const ctx = request.ctx as RequestContext;
    if (!ctx.customer) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const accounts = await findAdAccountsByCustomer(ctx.customer.id);
    reply.send({
      accounts: accounts.map(a => ({
        id: a.id,
        meta_ad_account_id: a.meta_ad_account_id,
        account_name: a.account_name,
        status: a.status,
        connected_at: a.connected_at,
      })),
    });
  });

  // ── Disconnect Account ──
  fastify.delete('/api/v1/customer/accounts/:id', {
    schema: {
      tags: ['Accounts'],
      summary: 'Disconnect a Meta ad account',
    },
  }, async (request, reply) => {
    const ctx = request.ctx as RequestContext;
    if (!ctx.customer) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const accounts = await findAdAccountsByCustomer(ctx.customer.id);
    const account = accounts.find(a => a.id === id);

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    await deleteAdAccount(id);
    reply.send({ success: true });
  });

  // ── Meta OAuth URL ──
  fastify.get('/api/v1/auth/meta/oauth-url', {
    schema: {
      tags: ['Auth'],
      summary: 'Get Meta OAuth authorization URL',
      description: 'Returns the URL to redirect the user for Meta OAuth login.',
    },
  }, async (request, reply) => {
    const ctx = request.ctx as RequestContext;
    if (!ctx.customer) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const appId = process.env.META_APP_ID;
    const redirectUri = process.env.OAUTH_REDIRECT_URL || `https://${request.headers.host}/auth/meta/callback`;
    const state = Buffer.from(JSON.stringify({ customerId: ctx.customer.id, redirect: '/dashboard' })).toString('base64url');

    // Store state in Redis with 10-minute expiry
    await redis.setex(`oauth:state:${state}`, 600, ctx.customer.id);

    const scopes = [
      'ads_management',
      'ads_read',
      'business_management',
      'pages_read_engagement',
    ].join(',');

    const url = `https://www.facebook.com/v22.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${scopes}&response_type=code`;

    reply.send({ url, state });
  });
}
