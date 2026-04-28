import 'dotenv/config';
import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

// ============================================================================
// GLOBAL MCP SERVER — Single instance, single transport pair (Pipeboard-style)
// ============================================================================

let globalClientTransport: InMemoryTransport;
let isServerReady = false;

async function initGlobalMcpServer() {
  if (!token) {
    console.warn('[MCP] No META_ACCESS_TOKEN configured — MCP endpoint will reject requests');
    return;
  }

  const client = new MetaApiClient(token, {
    accountId: process.env.META_AD_ACCOUNT_ID,
    apiVersion: process.env.META_API_VERSION,
  });

  const server = new McpServer({ name: 'meta-ads-mcp', version: '2.0.0' });
  registerAllTools(server, client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  globalClientTransport = clientTransport;

  await server.server.connect(serverTransport);
  isServerReady = true;

  console.log('[MCP] Global server initialized with 77 tools');
}

// Send a JSON-RPC request through the global transport and wait for response
async function sendMcpRequest(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isServerReady || !globalClientTransport) {
    throw new Error('MCP server not initialized');
  }

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('MCP request timeout'));
    }, 30000);

    globalClientTransport.onmessage = (msg: any) => {
      clearTimeout(timeout);
      resolve(msg as Record<string, unknown>);
    };

    globalClientTransport.send(requestBody as any);
  });
}

// ============================================================================
// FASTIFY SERVER
// ============================================================================

async function main() {
  // Initialize database
  await initDatabase();
  startWeeklyResetScheduler();

  // Initialize the global MCP server
  await initGlobalMcpServer();

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

    if (path === '/mcp') return; // MCP handles its own auth
    if (request.method === 'OPTIONS') return; // Allow CORS preflight
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

  // Global CORS: add headers to all responses
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Customer-Api-Key, X-Meta-Account-Id, X-Meta-Token, Authorization, Mcp-Session-Id, X-Admin-Token');
  });

  // CORS preflight handler for MCP
  fastify.options('/mcp', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Customer-Api-Key, X-Meta-Account-Id, X-Meta-Token, Authorization, Mcp-Session-Id');
    reply.header('Access-Control-Max-Age', '86400');
    reply.status(204).send();
  });

  // ============================================================================
  // MCP ENDPOINT — Single global server, all requests route through same transport
  // ============================================================================
  fastify.post('/mcp', {
    schema: { tags: ['MCP Protocol'], summary: 'MCP JSON-RPC request' },
  }, async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Customer-Api-Key, X-Meta-Account-Id, X-Meta-Token, Authorization, Mcp-Session-Id');

    const startTime = Date.now();
    const customer = request.ctx?.customer;

    try {
      // Check weekly quota for customer accounts
      if (customer && !checkWeeklyQuota(customer)) {
        return reply.status(429).send({
          jsonrpc: '2.0',
          error: { code: -32001, message: `Weekly execution quota exceeded. Limit: ${customer.weekly_executions_limit}` },
          id: null,
        });
      }

      // Check if MCP server is ready
      if (!isServerReady) {
        return reply.status(503).send({
          jsonrpc: '2.0',
          error: { code: -32003, message: 'MCP server not initialized. Configure META_ACCESS_TOKEN.' },
          id: null,
        });
      }

      const jsonRpcRequest = request.body as Record<string, unknown>;

      // Send request through the global transport and get response
      const response = await sendMcpRequest(jsonRpcRequest);

      // Strip execution field from tools for compatibility
      const resp = response as Record<string, unknown>;
      if (resp.result && typeof resp.result === 'object') {
        const result = resp.result as Record<string, unknown>;
        if (result.tools && Array.isArray(result.tools)) {
          result.tools = (result.tools as any[]).map((t: any) => {
            const tool = { ...t };
            delete tool.execution;
            return tool;
          });
        }
      }

      reply.send(response);

      // Track usage
      if (customer) {
        const method = jsonRpcRequest.method as string;
        const toolName = method === 'tools/call'
          ? ((jsonRpcRequest.params as Record<string, unknown>)?.name as string || 'unknown')
          : 'mcp_session';
        await trackUsage(request, toolName, startTime, true);
      }
    } catch (error) {
      console.error('MCP request error:', error);
      if (customer) {
        await trackUsage(request, 'mcp_error', startTime, false, String(error));
      }
      reply.status(500).send({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  });

  // Also support GET on /mcp for SSE-style connections (some clients use this)
  fastify.get('/mcp', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.send({
      status: 'ok',
      server: 'meta-ads-mcp',
      version: '2.0.0',
      tools: 77,
      endpoint: '/mcp',
      method: 'POST',
    });
  });

  // REST Meta proxy routes
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
