import 'dotenv/config';
import Fastify from 'fastify';
import { randomUUID } from 'crypto';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MetaApiClient } from './client.js';
import { registerAllTools } from './tools/index.js';
import { registerRestRoutes } from './rest/proxy.js';
import { HealthResponseSchema } from './rest/schemas.js';
import { renderLandingPage, FAVICON_SVG_CONTENT } from './landing.js';
import { swaggerDarkCss } from './swagger-theme.js';
import { initDatabase, pool, redis } from './db/index.js';
import { resolveTenant, rateLimit, trackUsage, checkTier, checkWeeklyQuota, startWeeklyResetScheduler } from './middleware/tenant.js';
import { registerCustomerRoutes } from './auth/routes.js';
import { registerAdminRoutes } from './admin/routes.js';
import { registerOAuthRoutes } from './auth/oauth.js';
import type { Customer } from './types/index.js';

const token = process.env.META_ACCESS_TOKEN ?? '';
const API_KEY = process.env.MCP_API_KEY;
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Track active MCP sessions with TTL
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; lastSeen: number; customerId?: string }>();

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(sid);
      console.log(`Session expired: ${sid}`);
    }
  }
}, 5 * 60 * 1000).unref();

function createMcpSession(metaToken?: string, metaAccountId?: string, customer?: Customer): { server: McpServer; transport: StreamableHTTPServerTransport } {
  const resolvedToken = metaToken || token;
  if (!resolvedToken) {
    throw new Error('Missing Meta access token. Provide X-Meta-Token header, connect an account, or set META_ACCESS_TOKEN env var.');
  }
  const client = new MetaApiClient(resolvedToken, {
    accountId: metaAccountId ?? process.env.META_AD_ACCOUNT_ID,
    apiVersion: process.env.META_API_VERSION,
  });
  const server = new McpServer({ name: 'meta-ads-mcp', version: '2.0.0' });
  registerAllTools(server, client, customer);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: false,
  });
  return { server, transport };
}

async function main() {
  // Initialize database
  await initDatabase();
  startWeeklyResetScheduler();

  const fastify = Fastify({ logger: false });
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // Swagger
  await fastify.register(fastifySwagger, {
    transform: jsonSchemaTransform,
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'META ADS MCP Server — REST API',
        description: 'RESTful API for Meta (Facebook/Instagram) Ads management with multi-tenant customer support.',
        version: '2.0.0',
      },
      servers: [
        { url: 'https://meta-ads.hellenicai.com', description: 'Production' },
        { url: `http://localhost:${PORT}`, description: 'Local development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'MCP API Key or Admin JWT' },
          customerApiKey: { type: 'apiKey', in: 'header', name: 'X-Customer-Api-Key', description: 'Customer API key for tenant resolution' },
          metaToken: { type: 'apiKey', in: 'header', name: 'X-Meta-Token', description: 'Meta/Facebook access token' },
        },
      },
      security: [{ bearerAuth: [] }, { customerApiKey: [] }, { metaToken: [] }],
      tags: [
        { name: 'Health', description: 'Server health check' },
        { name: 'Auth', description: 'Customer registration and authentication' },
        { name: 'Accounts', description: 'Meta ad account connection management' },
        { name: 'Admin Auth', description: 'Admin authentication' },
        { name: 'Admin Dashboard', description: 'Agency admin operations' },
        { name: 'Admin Management', description: 'Admin user management' },
        { name: 'MCP Protocol', description: 'Model Context Protocol endpoints' },
      ],
    },
  });
  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    theme: { title: 'META ADS MCP API', css: [{ filename: 'dark-theme.css', content: swaggerDarkCss }] },
  });

  // Resolve tenant on every request
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/' || request.url === '/health' || request.url === '/favicon.svg' || request.url.startsWith('/docs')) return;
    await resolveTenant(request, reply);
  });

  // Rate limiting
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/' || request.url === '/health' || request.url === '/favicon.svg' || request.url.startsWith('/docs')) return;
    await rateLimit(request, reply);
  });

  // Auth hook for MCP and REST
  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/' || path === '/health' || path === '/favicon.svg' || path.startsWith('/docs')) return;
    if (path === '/auth/meta/callback') return;
    if (path.startsWith('/api/v1/auth/')) return; // Allow public auth endpoints
    if (path.startsWith('/admin/api/v1/auth/')) return; // Allow admin login

    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const queryKey = (request.query as Record<string, string>)?.api_key;
    const providedKey = bearer ?? queryKey;

    // If no API key at all and no customer context, reject
    if (!providedKey && !request.ctx?.customer && !request.ctx?.isAdmin) {
      // Check if master key is required
      if (API_KEY) {
        return reply.status(401).send({ error: 'Unauthorized — missing API key or customer credentials' });
      }
    }

    // Validate master key
    if (API_KEY && providedKey && providedKey === API_KEY) {
      return; // Master key bypass
    }

    // Customer context already resolved by tenant middleware via X-Customer-Api-Key
    if (request.ctx?.customer) {
      return;
    }

    // Admin context resolved
    if (request.ctx?.isAdmin) {
      return;
    }

    if (API_KEY && providedKey) {
      return reply.status(401).send({ error: 'Unauthorized — invalid API key' });
    }
  });

  // Landing page
  fastify.get('/', { schema: { hide: true } }, async (_request, reply) => {
    reply.type('text/html').send(renderLandingPage(process.uptime()));
  });
  fastify.get('/favicon.svg', { schema: { hide: true } }, async (_request, reply) => {
    reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(FAVICON_SVG_CONTENT);
  });

  // Health check
  fastify.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Health check',
      response: { 200: HealthResponseSchema },
    },
  }, async () => {
    let dbStatus = 'ok';
    let redisStatus = 'ok';
    try { await pool.query('SELECT 1'); } catch { dbStatus = 'error'; }
    try { await redis.ping(); } catch { redisStatus = 'error'; }
    return {
      status: dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded',
      name: 'meta-ads-mcp',
      version: '2.0.0',
      tools: 77,
      modes: ['mcp', 'rest'],
      uptime: process.uptime(),
      dependencies: { database: dbStatus, cache: redisStatus },
    };
  });

  // Customer routes
  await registerCustomerRoutes(fastify);

  // Admin routes
  await registerAdminRoutes(fastify);

  // OAuth routes
  await registerOAuthRoutes(fastify);

  // MCP endpoint
  fastify.post('/mcp', {
    schema: { tags: ['MCP Protocol'], summary: 'MCP JSON-RPC request' },
  }, async (request, reply) => {
    const startTime = Date.now();
    try {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const customer = request.ctx?.customer;

      if (customer) {
        // Check weekly quota
        if (!checkWeeklyQuota(customer)) {
          if (!reply.sent) {
            return reply.status(429).send({
              jsonrpc: '2.0',
              error: { code: -32001, message: `Weekly execution quota exceeded. Limit: ${customer.weekly_executions_limit}` },
              id: null,
            });
          }
          return;
        }
      }

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastSeen = Date.now();
        reply.hijack();
        await session.transport.handleRequest(request.raw, reply.raw, request.body);
      } else if (!sessionId) {
        const metaToken = request.headers['x-meta-token'] as string | undefined;
        const metaAccountId = request.headers['x-meta-account-id'] as string | undefined;
        const resolvedToken = metaToken || request.ctx?.metaToken || token;
        const resolvedAccount = metaAccountId || request.ctx?.metaAccountId || process.env.META_AD_ACCOUNT_ID;

        if (!resolvedToken) {
          return reply.status(401).send({
            jsonrpc: '2.0',
            error: { code: -32002, message: 'Missing Meta access token. Connect an account or provide X-Meta-Token header.' },
            id: null,
          });
        }

        const { server, transport } = createMcpSession(resolvedToken, resolvedAccount, customer || undefined);
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) { sessions.delete(sid); console.log(`Session closed: ${sid}`); }
        };
        await server.connect(transport);
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
        if (transport.sessionId) {
          sessions.set(transport.sessionId, { server, transport, lastSeen: Date.now(), customerId: customer?.id });
          console.log(`Session created: ${transport.sessionId} (customer: ${customer?.email || 'master'})`);
        }
      } else {
        reply.status(404).send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found. Send request without mcp-session-id to create a new session.' },
          id: null,
        });
      }

      // Track usage
      if (customer) {
        const body = request.body as { method?: string; params?: { name?: string } } | undefined;
        const toolName = body?.method === 'tools/call' ? (body.params?.name || 'unknown') : 'mcp_session';
        await trackUsage(request, toolName, startTime, true);
      }
    } catch (error) {
      console.error('MCP request error:', error);
      if (customer) {
        await trackUsage(request, 'mcp_error', startTime, false, String(error));
      }
      if (!reply.sent) {
        reply.status(500).send({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  // MCP SSE
  fastify.get('/mcp', {
    schema: { tags: ['MCP Protocol'], summary: 'MCP SSE stream' },
  }, async (request, reply) => {
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const session = sessions.get(sessionId)!;
    session.lastSeen = Date.now();
    reply.hijack();
    await session.transport.handleRequest(request.raw, reply.raw);
  });

  // MCP DELETE
  fastify.delete('/mcp', {
    schema: { tags: ['MCP Protocol'], summary: 'Terminate MCP session' },
  }, async (request, reply) => {
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    const { transport } = sessions.get(sessionId)!;
    sessions.delete(sessionId);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw);
  });

  // REST Meta proxy routes (from base repo)
  await registerRestRoutes(fastify);

  // Start server
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`META ADS MCP server running at http://0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint:  http://0.0.0.0:${PORT}/mcp`);
  console.log(`  REST API:      http://0.0.0.0:${PORT}/api/v1/*`);
  console.log(`  Admin API:     http://0.0.0.0:${PORT}/admin/api/v1/*`);
  console.log(`  Health check:  http://0.0.0.0:${PORT}/health`);
  console.log(`  API docs:      http://0.0.0.0:${PORT}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
