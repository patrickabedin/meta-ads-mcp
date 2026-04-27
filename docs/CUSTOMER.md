# META ADS MCP — Customer Usage Guide

## Getting Started

### 1. Sign Up for Free

Visit [https://meta-ads.hellenicai.com](https://meta-ads.hellenicai.com) and click "Get Started Free".

Or register via API:
```bash
curl -X POST https://api.meta-ads.hellenicai.com/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"securepass","name":"Your Name"}'
```

Response includes your unique `api_key` (starts with `mak_`). Save this securely.

### 2. Connect Your Meta Ad Account

#### Option A: OAuth (Recommended)
```bash
curl -H "X-Customer-Api-Key: mak_..." \
  https://api.meta-ads.hellenicai.com/api/v1/auth/meta/oauth-url
```

Open the returned URL, login with Facebook, and authorize access to your ad accounts.

#### Option B: Direct Token
```bash
curl -X POST https://api.meta-ads.hellenicai.com/api/v1/customer/accounts/connect \
  -H "X-Customer-Api-Key: mak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "meta_ad_account_id": "act_123456789",
    "meta_access_token": "EAA...",
    "account_name": "My Account"
  }'
```

### 3. Use with Claude

Add to your Claude MCP configuration:

```json
{
  "mcpServers": {
    "meta-ads": {
      "url": "https://api.meta-ads.hellenicai.com/mcp",
      "headers": {
        "X-Customer-Api-Key": "mak_...",
        "X-Meta-Account-Id": "act_123456789"
      }
    }
  }
}
```

### 4. Use with Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "meta-ads": {
      "url": "https://api.meta-ads.hellenicai.com/mcp?customer_api_key=mak_...&account_id=act_123456789"
    }
  }
}
```

### 5. Use with n8n / Make / Zapier

Use the REST API directly:

```bash
# Get campaigns
curl https://api.meta-ads.hellenicai.com/api/v1/campaigns \
  -H "X-Customer-Api-Key: mak_..." \
  -H "X-Meta-Account-Id: act_123456789"

# Create campaign
curl -X POST https://api.meta-ads.hellenicai.com/api/v1/campaigns \
  -H "X-Customer-Api-Key: mak_..." \
  -H "X-Meta-Account-Id: act_123456789" \
  -H "Content-Type: application/json" \
  -d '{"name":"Summer Sale","objective":"CONVERSIONS","status":"PAUSED","special_ad_categories":[]}'
```

## Free Tier Limits

| Feature | Limit |
|---------|-------|
| Weekly AI executions | 30 |
| Connected ad accounts | 2 |
| Campaign management | Yes |
| Ad set & ad CRUD | Yes |
| Insights & reporting | Yes |
| Audience management | Yes |
| Creative upload | Yes |
| Batch operations | Yes |

Weekly limits reset every Sunday at 00:00 UTC.

## Example MCP Conversations

### Analyze Campaign Performance
> "Analyze my campaign performance for the last 7 days and tell me which campaigns have the best ROAS."

Claude will call:
- `get_insights` with date range and breakdown
- `get_campaigns` to get campaign names
- Present results with recommendations

### Create a New Campaign
> "Create a conversion campaign called 'Spring Collection' with a $100/day budget targeting women 25-34 in the US."

Claude will call:
- `create_campaign`
- `create_adset` with targeting
- Ask you to confirm before activating

### Duplicate and Scale
> "Duplicate my best performing campaign from last month and increase the budget by 50%."

Claude will call:
- `get_campaigns` to find the best performer
- `copy_campaign` to duplicate
- `update_campaign` to adjust budget

## Security Best Practices

1. **Never share your API key** — Treat it like a password
2. **Use OAuth when possible** — We never store your Facebook password
3. **Scope tokens appropriately** — Only grant `ads_management` and `ads_read` permissions
4. **Monitor usage** — Check `/api/v1/auth/me` to see your execution count

## Support

- GitHub Issues: [github.com/patrickabedin/meta-ads-mcp](https://github.com/patrickabedin/meta-ads-mcp)
- Email: Coming soon
