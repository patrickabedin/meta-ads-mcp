# META ADS MCP — Setup & Deployment Guide

## Prerequisites

- Linux server with Docker & Docker Compose installed
- Domain name (e.g., `meta-ads.hellenicai.com`)
- Meta App with Marketing API product enabled
- Cloudflare or DNS provider for domain management

## Quick Deploy (DigitalOcean)

### 1. Create Droplet

```bash
# Ubuntu 24.04 LTS, 2 vCPU / 2 GB RAM minimum
curl -fsSL https://get.docker.com | sh
```

### 2. Clone Repository

```bash
git clone https://github.com/patrickabedin/meta-ads-mcp.git /opt/meta-ads-mcp
cd /opt/meta-ads-mcp
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

Required variables:
```
ENCRYPTION_KEY=<32-byte-hex>
JWT_SECRET=<48-byte-hex>
POSTGRES_PASSWORD=<strong-password>
MCP_API_KEY=<master-api-key>
META_APP_ID=<your-meta-app-id>
META_APP_SECRET=<your-meta-app-secret>
OAUTH_REDIRECT_URL=https://meta-ads.hellenicai.com/auth/meta/callback
```

Generate keys:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Start Services

```bash
docker-compose up -d
```

### 5. Verify

```bash
curl http://localhost/health
docker-compose ps
```

### 6. SSL (Let's Encrypt)

```bash
# Certbot is included in docker-compose
docker-compose exec certbot certbot certonly \
  --webroot -w /var/www/certbot \
  -d meta-ads.hellenicai.com \
  --agree-tos --no-eff-email -m admin@hellenicai.com
```

Update `nginx.conf` to use SSL paths, then restart:
```bash
docker-compose restart nginx
```

## DNS Configuration

### Cloudflare

| Type | Name | Content | Purpose |
|------|------|---------|---------|
| A | `api.meta-ads` | `<droplet-ip>` | API server |
| CNAME | `meta-ads` | `cname.vercel-dns.com` | Landing page (Vercel) |
| TXT | `_vercel` | `vc-domain-verify=...` | Vercel verification |

## Database Migrations

Tables are auto-created on first startup via `initDatabase()`. No manual migration needed for initial setup.

## Backup

### PostgreSQL
```bash
docker-compose exec postgres pg_dump -U postgres meta_ads_mcp > backup.sql
```

### Redis
```bash
docker-compose exec redis redis-cli BGSAVE
```

## Monitoring

Health endpoint: `GET /health`

Returns:
```json
{
  "status": "ok",
  "name": "meta-ads-mcp",
  "version": "2.0.0",
  "tools": 77,
  "modes": ["mcp", "rest"],
  "uptime": 1234.5,
  "dependencies": {
    "database": "ok",
    "cache": "ok"
  }
}
```

## Updating

```bash
cd /opt/meta-ads-mcp
git pull origin main
docker-compose up -d --build
```

## Troubleshooting

### App container restarting
Check logs: `docker-compose logs app`

### Database connection refused
Ensure postgres container is healthy: `docker-compose ps`

### SSL certificate issues
Ensure certbot-data volume exists and domain DNS points to server IP.

## Development

```bash
npm install
npm run dev
```

Requires local PostgreSQL and Redis, or use docker-compose for services.
