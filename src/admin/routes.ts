// ═══════════════════════════════════════════════════════════════════════════
//  Admin API Routes — Agency Dashboard Backend
// ═══════════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, findAdminByEmail, createAdmin, findCustomerById, findAdAccountsByCustomer, getUsageStats } from '../db/index.js';
import { hashPassword, comparePassword, signJwt } from '../auth/crypto.js';
import type { RequestContext } from '../types/index.js';

const AdminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const CreateAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['admin', 'superadmin']).optional(),
});

function requireAdmin(ctx: RequestContext): { isAdmin: true; admin: NonNullable<RequestContext['admin']> } {
  if (!ctx.isAdmin || !ctx.admin) {
    throw new Error('Unauthorized');
  }
  return { isAdmin: true, admin: ctx.admin };
}

export async function registerAdminRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Admin Login ──
  fastify.post('/admin/api/v1/auth/login', {
    schema: {
      tags: ['Admin Auth'],
      summary: 'Admin login',
      body: AdminLoginSchema,
    },
  }, async (request, reply) => {
    const { email, password } = request.body as z.infer<typeof AdminLoginSchema>;

    const admin = await findAdminByEmail(email);
    if (!admin || !(await comparePassword(password, admin.password_hash))) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const token = signJwt({ adminId: admin.id, email: admin.email, role: admin.role, type: 'admin' });
    reply.send({ success: true, token, admin: { id: admin.id, email: admin.email, role: admin.role } });
  });

  // ── Create Admin (superadmin only) ──
  fastify.post('/admin/api/v1/admins', {
    schema: {
      tags: ['Admin Management'],
      summary: 'Create new admin',
      body: CreateAdminSchema,
    },
  }, async (request, reply) => {
    const ctx = request.ctx;
    try {
      requireAdmin(ctx);
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    if (ctx.admin!.role !== 'superadmin') {
      return reply.status(403).send({ error: 'Only superadmins can create admins' });
    }

    const { email, password, role } = request.body as z.infer<typeof CreateAdminSchema>;
    const passwordHash = await hashPassword(password);

    const admin = await createAdmin({ email, password_hash: passwordHash, role });
    reply.status(201).send({ success: true, admin: { id: admin.id, email: admin.email, role: admin.role } });
  });

  // ── List All Customers ──
  fastify.get('/admin/api/v1/customers', {
    schema: {
      tags: ['Admin Dashboard'],
      summary: 'List all customers',
    },
  }, async (request, reply) => {
    const ctx = request.ctx;
    try { requireAdmin(ctx); } catch { return reply.status(401).send({ error: 'Unauthorized' }); }

    const page = parseInt((request.query as Record<string, string>).page || '1', 10);
    const limit = parseInt((request.query as Record<string, string>).limit || '50', 10);
    const offset = (page - 1) * limit;

    const countRes = await pool.query('SELECT COUNT(*) FROM customers');
    const total = parseInt(countRes.rows[0].count, 10);

    const res = await pool.query(
      `SELECT id, email, name, tier, weekly_executions_used, weekly_executions_limit, max_ad_accounts, status, created_at
       FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    reply.send({ customers: res.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  });

  // ── Get Customer Detail ──
  fastify.get('/admin/api/v1/customers/:id', {
    schema: {
      tags: ['Admin Dashboard'],
      summary: 'Get customer details with accounts and usage',
    },
  }, async (request, reply) => {
    const ctx = request.ctx;
    try { requireAdmin(ctx); } catch { return reply.status(401).send({ error: 'Unauthorized' }); }

    const { id } = request.params as { id: string };
    const customer = await findCustomerById(id);
    if (!customer) return reply.status(404).send({ error: 'Customer not found' });

    const accounts = await findAdAccountsByCustomer(id);
    const usageStats = await getUsageStats(id, 7);

    reply.send({
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        tier: customer.tier,
        weekly_executions_used: customer.weekly_executions_used,
        weekly_executions_limit: customer.weekly_executions_limit,
        max_ad_accounts: customer.max_ad_accounts,
        status: customer.status,
        created_at: customer.created_at,
      },
      accounts: accounts.map(a => ({
        id: a.id,
        meta_ad_account_id: a.meta_ad_account_id,
        account_name: a.account_name,
        status: a.status,
        connected_at: a.connected_at,
      })),
      usage_7d: usageStats,
    });
  });

  // ── Update Customer Tier ──
  fastify.patch('/admin/api/v1/customers/:id/tier', {
    schema: {
      tags: ['Admin Dashboard'],
      summary: 'Update customer tier',
    },
  }, async (request, reply) => {
    const ctx = request.ctx;
    try { requireAdmin(ctx); } catch { return reply.status(401).send({ error: 'Unauthorized' }); }

    const { id } = request.params as { id: string };
    const { tier } = request.body as { tier: string };

    const weeklyLimit = tier === 'free' ? 30 : tier === 'pro' ? 500 : 999999;
    const maxAccounts = tier === 'free' ? 2 : tier === 'pro' ? 3 : tier === 'premium' ? 10 : 50;

    await pool.query(
      'UPDATE customers SET tier = $1, weekly_executions_limit = $2, max_ad_accounts = $3, updated_at = NOW() WHERE id = $4',
      [tier, weeklyLimit, maxAccounts, id]
    );

    reply.send({ success: true });
  });

  // ── Suspend/Reactivate Customer ──
  fastify.patch('/admin/api/v1/customers/:id/status', {
    schema: {
      tags: ['Admin Dashboard'],
      summary: 'Update customer status',
    },
  }, async (request, reply) => {
    const ctx = request.ctx;
    try { requireAdmin(ctx); } catch { return reply.status(401).send({ error: 'Unauthorized' }); }

    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };

    await pool.query('UPDATE customers SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    reply.send({ success: true });
  });

  // ── Global Stats ──
  fastify.get('/admin/api/v1/stats', {
    schema: {
      tags: ['Admin Dashboard'],
      summary: 'Global platform statistics',
    },
  }, async (request, reply) => {
    const ctx = request.ctx;
    try { requireAdmin(ctx); } catch { return reply.status(401).send({ error: 'Unauthorized' }); }

    const customerCount = await pool.query('SELECT COUNT(*) FROM customers');
    const activeCount = await pool.query("SELECT COUNT(*) FROM customers WHERE status = 'active'");
    const accountCount = await pool.query('SELECT COUNT(*) FROM customer_ad_accounts WHERE status = \'connected\'');
    const usageToday = await pool.query("SELECT COUNT(*) FROM usage_logs WHERE executed_at > NOW() - INTERVAL '1 day'");
    const usageWeek = await pool.query("SELECT COUNT(*) FROM usage_logs WHERE executed_at > NOW() - INTERVAL '7 days'");

    reply.send({
      customers: { total: parseInt(customerCount.rows[0].count, 10), active: parseInt(activeCount.rows[0].count, 10) },
      connected_accounts: parseInt(accountCount.rows[0].count, 10),
      usage: { today: parseInt(usageToday.rows[0].count, 10), this_week: parseInt(usageWeek.rows[0].count, 10) },
    });
  });
}
