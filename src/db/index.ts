// ═══════════════════════════════════════════════════════════════════════════
//  Database Layer — PostgreSQL + Redis
// ═══════════════════════════════════════════════════════════════════════════

import pg from 'pg';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { Customer, CustomerAdAccount, UsageLog, Admin } from '../types/index.js';

const { Pool } = pg;

// ── PostgreSQL ──
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error', err);
});

// ── Redis ──
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379/0', {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

// ── Initialization ──
export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Customers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'premium', 'enterprise')),
        weekly_executions_used INTEGER NOT NULL DEFAULT 0,
        weekly_executions_limit INTEGER NOT NULL DEFAULT 30,
        max_ad_accounts INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
        api_key TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
      CREATE INDEX IF NOT EXISTS idx_customers_api_key ON customers(api_key);
    `);

    // Customer ad accounts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_ad_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        meta_ad_account_id TEXT NOT NULL,
        meta_access_token_encrypted TEXT NOT NULL,
        meta_refresh_token TEXT,
        token_expires_at TIMESTAMPTZ,
        account_name TEXT,
        status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(customer_id, meta_ad_account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_caa_customer ON customer_ad_accounts(customer_id);
      CREATE INDEX IF NOT EXISTS idx_caa_meta_account ON customer_ad_accounts(meta_ad_account_id);
    `);

    // Usage logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        ad_account_id TEXT,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        response_time_ms INTEGER,
        success BOOLEAN NOT NULL DEFAULT true,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_logs(customer_id);
      CREATE INDEX IF NOT EXISTS idx_usage_executed ON usage_logs(executed_at);
    `);

    // Admins table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
    console.log('Database tables initialized successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Customer Queries ──
export async function findCustomerByEmail(email: string): Promise<Customer | null> {
  const res = await pool.query('SELECT * FROM customers WHERE email = $1', [email.toLowerCase()]);
  return res.rows[0] || null;
}

export async function findCustomerById(id: string): Promise<Customer | null> {
  const res = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function findCustomerByApiKey(apiKey: string): Promise<Customer | null> {
  const res = await pool.query('SELECT * FROM customers WHERE api_key = $1', [apiKey]);
  return res.rows[0] || null;
}

export async function createCustomer(data: {
  email: string;
  name: string;
  password_hash: string;
  tier?: string;
  api_key: string;
}): Promise<Customer> {
  const weeklyLimit = data.tier === 'free' ? 30 : data.tier === 'pro' ? 500 : 999999;
  const maxAccounts = data.tier === 'free' ? 2 : data.tier === 'pro' ? 3 : data.tier === 'premium' ? 10 : 50;

  const res = await pool.query(
    `INSERT INTO customers (email, name, password_hash, tier, weekly_executions_limit, max_ad_accounts, api_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [data.email.toLowerCase(), data.name, data.password_hash, data.tier || 'free', weeklyLimit, maxAccounts, data.api_key]
  );
  return res.rows[0];
}

export async function incrementCustomerUsage(customerId: string): Promise<void> {
  await pool.query(
    'UPDATE customers SET weekly_executions_used = weekly_executions_used + 1, updated_at = NOW() WHERE id = $1',
    [customerId]
  );
}

export async function resetWeeklyUsage(): Promise<void> {
  await pool.query('UPDATE customers SET weekly_executions_used = 0, updated_at = NOW()');
}

// ── Ad Account Queries ──
export async function findAdAccountsByCustomer(customerId: string): Promise<CustomerAdAccount[]> {
  const res = await pool.query(
    'SELECT * FROM customer_ad_accounts WHERE customer_id = $1 ORDER BY connected_at DESC',
    [customerId]
  );
  return res.rows;
}

export async function findAdAccountById(id: string): Promise<CustomerAdAccount | null> {
  const res = await pool.query('SELECT * FROM customer_ad_accounts WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function findAdAccountByMetaId(customerId: string, metaAccountId: string): Promise<CustomerAdAccount | null> {
  const res = await pool.query(
    'SELECT * FROM customer_ad_accounts WHERE customer_id = $1 AND meta_ad_account_id = $2',
    [customerId, metaAccountId]
  );
  return res.rows[0] || null;
}

export async function createAdAccount(data: Omit<CustomerAdAccount, 'id' | 'connected_at' | 'updated_at'>): Promise<CustomerAdAccount> {
  const res = await pool.query(
    `INSERT INTO customer_ad_accounts (customer_id, meta_ad_account_id, meta_access_token_encrypted, meta_refresh_token, token_expires_at, account_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [data.customer_id, data.meta_ad_account_id, data.meta_access_token_encrypted, data.meta_refresh_token, data.token_expires_at, data.account_name, data.status]
  );
  return res.rows[0];
}

export async function deleteAdAccount(id: string): Promise<void> {
  await pool.query('DELETE FROM customer_ad_accounts WHERE id = $1', [id]);
}

// ── Usage Log Queries ──
export async function logUsage(data: Omit<UsageLog, 'id'>): Promise<void> {
  await pool.query(
    `INSERT INTO usage_logs (customer_id, tool_name, ad_account_id, executed_at, response_time_ms, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [data.customer_id, data.tool_name, data.ad_account_id, data.executed_at, data.response_time_ms, data.success, data.error_message]
  );
}

export async function getUsageStats(customerId: string, days = 7): Promise<{ tool_name: string; count: number }[]> {
  const res = await pool.query(
    `SELECT tool_name, COUNT(*) as count FROM usage_logs
     WHERE customer_id = $1 AND executed_at > NOW() - INTERVAL '${days} days'
     GROUP BY tool_name ORDER BY count DESC`,
    [customerId]
  );
  return res.rows;
}

// ── Admin Queries ──
export async function findAdminByEmail(email: string): Promise<Admin | null> {
  const res = await pool.query('SELECT * FROM admins WHERE email = $1', [email.toLowerCase()]);
  return res.rows[0] || null;
}

export async function createAdmin(data: { email: string; password_hash: string; role?: string }): Promise<Admin> {
  const res = await pool.query(
    'INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *',
    [data.email.toLowerCase(), data.password_hash, data.role || 'admin']
  );
  return res.rows[0];
}
