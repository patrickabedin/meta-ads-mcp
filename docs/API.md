# META ADS MCP — API Reference

Base URL: `https://api.meta-ads.hellenicai.com`

## Authentication

All API requests (except public auth endpoints) require authentication via one of:

### 1. Customer API Key
Header: `X-Customer-Api-Key: mak_...`

### 2. Master API Key
Header: `Authorization: Bearer <MCP_API_KEY>`

### 3. Admin JWT
Header: `X-Admin-Token: <jwt_token>`

---

## MCP Protocol

### Endpoint: `POST /mcp`

Send MCP JSON-RPC requests. Used by MCP clients (Claude, Cursor, etc.) to invoke tools.

**Headers:**
- `X-Customer-Api-Key` — Your customer API key
- `X-Meta-Account-Id` — Meta ad account ID (e.g., `act_123456789`)
- `X-Meta-Token` — Optional direct Meta access token (overrides stored token)

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_campaigns",
    "arguments": {
      "limit": 10
    }
  },
  "id": 1
}
```

### Endpoint: `GET /mcp`

Server-Sent Events stream for MCP notifications. Requires `mcp-session-id` header.

### Endpoint: `DELETE /mcp`

Terminate an active MCP session. Requires `mcp-session-id` header.

---

## Customer Authentication

### POST /api/v1/auth/register

Register a new free-tier customer account.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword123",
  "name": "John Doe"
}
```

**Response:**
```json
{
  "success": true,
  "customer": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "api_key": "mak_..."
  }
}
```

### POST /api/v1/auth/login

Authenticate and receive a JWT token.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

### GET /api/v1/auth/me

Get current customer profile and connected accounts.

**Headers:** `X-Customer-Api-Key: mak_...`

---

## Account Management

### POST /api/v1/customer/accounts/connect

Connect a Meta ad account by storing an encrypted access token.

**Headers:** `X-Customer-Api-Key: mak_...`

**Body:**
```json
{
  "meta_ad_account_id": "act_123456789",
  "meta_access_token": "EAA...",
  "meta_refresh_token": "optional",
  "token_expires_at": "2026-05-27T00:00:00Z",
  "account_name": "My Ad Account"
}
```

### GET /api/v1/customer/accounts

List connected Meta ad accounts.

### DELETE /api/v1/customer/accounts/:id

Disconnect a Meta ad account.

---

## Meta OAuth

### GET /api/v1/auth/meta/oauth-url

Get the Meta OAuth authorization URL for connecting accounts via OAuth flow.

**Response:**
```json
{
  "url": "https://www.facebook.com/v22.0/dialog/oauth?...",
  "state": "base64encodedstate"
}
```

### GET /auth/meta/callback

OAuth callback endpoint. Redirects here after Meta authorization.

---

## REST API — Meta Ads Operations

All endpoints below proxy to the Meta Marketing API. They require:
- `X-Customer-Api-Key` or `Authorization: Bearer <key>`
- `X-Meta-Account-Id` (unless using a stored connected account)

### Campaigns

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/campaigns` | List campaigns |
| POST | `/api/v1/campaigns` | Create campaign |
| GET | `/api/v1/campaigns/:id` | Get campaign details |
| POST | `/api/v1/campaigns/:id` | Update campaign |
| DELETE | `/api/v1/campaigns/:id` | Delete campaign |

### Ad Sets

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/adsets` | List ad sets |
| POST | `/api/v1/adsets` | Create ad set |
| GET | `/api/v1/adsets/:id` | Get ad set |
| POST | `/api/v1/adsets/:id` | Update ad set |

### Ads

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/ads` | List ads |
| POST | `/api/v1/ads` | Create ad |
| GET | `/api/v1/ads/:id` | Get ad |
| POST | `/api/v1/ads/:id` | Update ad |

### Insights

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/insights` | Get insights/reports |

### Audiences

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/custom-audiences` | List custom audiences |
| POST | `/api/v1/custom-audiences` | Create custom audience |
| GET | `/api/v1/lookalike-audiences` | List lookalike audiences |
| POST | `/api/v1/lookalike-audiences` | Create lookalike |

### Creatives

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/adcreatives` | List creatives |
| POST | `/api/v1/adcreatives` | Create creative |

### Images & Videos

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/images` | Upload image |
| POST | `/api/v1/videos` | Upload video |

---

## Admin API

All admin endpoints require `X-Admin-Token` header with a valid admin JWT.

### POST /admin/api/v1/auth/login

Admin login.

### GET /admin/api/v1/customers

List all customers with pagination.

### GET /admin/api/v1/customers/:id

Get customer details with accounts and usage stats.

### PATCH /admin/api/v1/customers/:id/tier

Update customer tier (free/pro/premium/enterprise).

### PATCH /admin/api/v1/customers/:id/status

Update customer status (active/suspended/pending).

### GET /admin/api/v1/stats

Global platform statistics.

---

## Rate Limits

- Per-customer: 120 requests per 60-second window
- MCP endpoint: 10 requests per second burst
- Meta BUC limits: Automatically managed with exponential backoff

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Bad Request |
| 401 | Unauthorized — missing or invalid credentials |
| 403 | Forbidden — tier limit exceeded or insufficient permissions |
| 404 | Not Found |
| 429 | Rate limit exceeded |
| 500 | Internal Server Error |

---

For the complete OpenAPI spec, visit `/docs` on any running server instance.
