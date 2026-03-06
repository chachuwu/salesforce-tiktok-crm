// ─── OAuth Token Types ────────────────────────────────────────────────────────

/**
 * Raw response from TikTok's /oauth2/access_token/ endpoint.
 */
export interface TikTokTokenResponse {
  code: number;
  message: string;
  request_id: string;
  data: {
    access_token: string;
    refresh_token: string;
    access_token_expire_in: number;  // seconds until access token expires
    refresh_token_expire_in: number; // seconds until refresh token expires
    token_type: string;              // always "bearer"
    scope: string;
    advertiser_ids: string[];        // business accounts the user authorised
  };
}

/**
 * Raw response from TikTok's /oauth2/refresh_token/ endpoint.
 */
export interface TikTokRefreshResponse {
  code: number;
  message: string;
  request_id: string;
  data: {
    access_token: string;
    refresh_token: string;
    access_token_expire_in: number;
    refresh_token_expire_in: number;
    token_type: string;
    scope: string;
  };
}

/**
 * Normalised token record stored in Postgres and cached in Redis.
 */
export interface StoredToken {
  id: string;                   // uuid
  advertiser_id: string;        // TikTok advertiser account ID
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
  scope: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Minimal token info the API client needs.
 */
export interface ActiveToken {
  access_token: string;
  advertiser_id: string;
  expires_at: Date;
}

/**
 * OAuth state parameter — used for CSRF protection.
 * Stored in Redis for the duration of the authorization flow.
 */
export interface OAuthState {
  csrf_token: string;
  redirect_after?: string; // where to send user after auth completes
  created_at: string;
}

/**
 * Summary of an authorised advertiser account.
 */
export interface AdvertiserInfo {
  advertiser_id: string;
  advertiser_name: string;
  role: string;
}
