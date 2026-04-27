// ═══════════════════════════════════════════════════════════════════════════
//  Core Type Definitions for META ADS MCP
// ═══════════════════════════════════════════════════════════════════════════

export interface Customer {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  tier: 'free' | 'pro' | 'premium' | 'enterprise';
  weekly_executions_used: number;
  weekly_executions_limit: number;
  max_ad_accounts: number;
  status: 'active' | 'suspended' | 'pending';
  created_at: Date;
  updated_at: Date;
  api_key: string;
}

export interface CustomerAdAccount {
  id: string;
  customer_id: string;
  meta_ad_account_id: string;
  meta_access_token_encrypted: string;
  meta_refresh_token: string | null;
  token_expires_at: Date | null;
  account_name: string | null;
  status: 'connected' | 'disconnected' | 'error';
  connected_at: Date;
  updated_at: Date;
}

export interface UsageLog {
  id: string;
  customer_id: string;
  tool_name: string;
  ad_account_id: string | null;
  executed_at: Date;
  response_time_ms: number;
  success: boolean;
  error_message: string | null;
}

export interface Admin {
  id: string;
  email: string;
  password_hash: string;
  role: 'superadmin' | 'admin';
  created_at: Date;
}

export interface RequestContext {
  customer?: Customer;
  account?: CustomerAdAccount;
  metaToken?: string;
  metaAccountId?: string;
  isAdmin?: boolean;
  admin?: Admin;
}

export interface TierConfig {
  weekly_executions: number;
  max_ad_accounts: number;
  features: string[];
}

export interface MetaApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}
