# META ADS MCP by HellenicAI

A production-ready **Model Context Protocol (MCP)** server that gives AI assistants like Claude, Cursor, and ChatGPT complete control over Meta (Facebook & Instagram) advertising operations. Built for agencies with a **free multi-tenant customer model**.

> **Free Tier:** 30 weekly AI tool executions · Up to 2 Meta ad accounts · All core features

---

## Quick Start

### For Claude / Cursor Users

Add this to your MCP configuration:

```json
{
  "mcpServers": {
    "meta-ads": {
      "url": "https://meta-ads.hellenicai.com/mcp",
      "headers": {
        "X-Customer-Api-Key": "YOUR_API_KEY",
        "X-Meta-Account-Id": "act_123456789"
      }
    }
  }
}
```

Get your API key by [registering a free account](https://meta-ads.hellenicai.com).

---

## Features

| Category | Tools | Description |
|----------|-------|-------------|
| **Campaigns** | 8 | Full CRUD + duplication, budget scheduling, automated rules |
| **Ad Sets** | 7 | Create, update, targeting, bid management |
| **Ads** | 6 | Ad management with creative assignment |
| **Creatives** | 5 | Ad creative creation with Object Story Spec |
| **Audiences** | 9 | Custom, lookalike, saved audiences, interest search |
| **Insights** | 5 | Performance analytics at all levels |
| **Media** | 6 | Image/video upload, thumbnail extraction |
| **Automation** | 8 | Batch ops, labels, rules, budget schedules |
| **Tracking** | 7 | Pixel, Conversions API, custom conversions |
| **Admin** | 16 | Customer management, usage tracking, tier control |

**Total: 77+ MCP tools + full REST API**

---

## Architecture

```
┌─────────┐     MCP/REST      ┌──────────────┐     Graph API     ┌──────────┐
│ Claude  │◄─── /mcp ───────►│  META ADS    │◄───────────────►│  Meta    │
│ Cursor  │    /api/v1/*      │     MCP      │   (BUC limited)  │   API    │
│ n8n     │                   │  (Fastify)   │                  │          │
└─────────┘                   └──────┬───────┘                  └──────────┘
                                     │
                        ┌────────────┼────────────┐
                        ▼            ▼            ▼
                   ┌────────┐  ┌────────┐  ┌────────┐
                   │PostgreSQL│  │ Redis  │  │ Nginx  │
                   │(customers│  │(sessions│  │(SSL)   │
                   │ tokens)  │  │ rate)  │  │        │
                   └────────┘  └────────┘  └────────┘
```

---

## API Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /mcp` | `X-Customer-Api-Key` | MCP protocol for AI clients |
| `GET /mcp` | `mcp-session-id` | MCP SSE notifications |
| `GET /api/v1/*` | `X-Customer-Api-Key` | REST API for campaigns, ads, insights |
| `POST /api/v1/auth/register` | Public | Customer registration |
| `POST /api/v1/auth/login` | Public | Customer login |
| `POST /api/v1/accounts/connect` | Customer | Connect Meta ad account |
| `GET /admin/api/v1/customers` | Admin JWT | List all customers |
| `GET /health` | None | Health check |
| `GET /docs` | None | Swagger UI API documentation |

---

## Self-Hosting

### Requirements

- Docker + Docker Compose
- Meta App with Marketing API product
- Domain name (for SSL)

### Setup

```bash
git clone https://github.com/patrickabedin/meta-ads-mcp.git
cd meta-ads-mcp
cp .env.example .env
# Edit .env with your credentials

# Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Start stack
docker-compose up -d
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `ENCRYPTION_KEY` | Yes | 32-byte hex for token encryption |
| `JWT_SECRET` | Yes | Secret for JWT signing |
| `META_APP_ID` | Yes | Meta App ID |
| `META_APP_SECRET` | Yes | Meta App Secret |
| `MCP_API_KEY` | Recommended | Master API key |
| `OAUTH_REDIRECT_URL` | Yes | OAuth callback URL |

---

## Customer Model

### Free Tier (Default)
- **30** weekly AI tool executions
- Up to **2** Meta ad accounts
- All core features: campaigns, ad sets, ads, creatives, insights, audiences, targeting

### Future Paid Tiers
- **Pro** ($29.90/mo): 500 executions, 3 accounts, weekly reports
- **Premium** ($99/mo): Unlimited, 10 accounts, team (5), daily reports
- **Enterprise** ($199/mo): Unlimited, 50 accounts, unlimited team, per-account scoping

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5.9 |
| HTTP Server | Fastify 5 |
| MCP SDK | @modelcontextprotocol/sdk 1.27+ |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Reverse Proxy | Nginx |
| Container | Docker + Docker Compose |

---

## Security

- **AES-256-GCM** encryption for stored Meta access tokens
- **JWT** authentication for customers and admins
- **bcrypt** password hashing (12 rounds)
- Per-customer rate limiting (Redis sliding window)
- Meta BUC rate limiting with exponential backoff
- CORS origin whitelist
- SSL/TLS via Let's Encrypt

---

## License

MIT License — see [LICENSE](LICENSE)

---

Built with ❤️ by [HellenicAI](https://hellenicai.com)
