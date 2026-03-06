import axios from 'axios';
import { createHash, randomBytes } from 'crypto';
import {
  TikTokTokenResponse,
  TikTokRefreshResponse,
  StoredToken,
  OAuthState,
} from './types';
import { TokenStore } from './token-store';
import { env } from '../config/env';
import { logger } from '../logging/logger';

const TIKTOK_AUTH_BASE = 'https://ads.tiktok.com/marketing_api/auth';
const TIKTOK_TOKEN_URL = `${env.TIKTOK_API_BASE_URL}/open_api/${env.TIKTOK_API_VERSION}/oauth2/access_token/`;
const TIKTOK_REFRESH_URL = `${env.TIKTOK_API_BASE_URL}/open_api/${env.TIKTOK_API_VERSION}/oauth2/refresh_token/`;

// Access tokens last 24 h; refresh tokens last 1 year
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * TikTok OAuth2 Client — "Developer's Own App" flow
 *
 * Step 1: generateAuthUrl()  — redirect the user to TikTok's consent screen
 * Step 2: exchangeAuthCode() — exchange the returned auth_code for tokens
 * Step 3: refreshAccessToken() — keep tokens alive (called automatically)
 *
 * TikTok-specific parameters vs standard OAuth2:
 *   • auth URL uses  ?app_id=  (not ?client_id=)
 *   • token body uses app_id / secret / auth_code  (not client_id/secret/code)
 *   • grant_type field present but no client_credentials flow
 */
export class TikTokOAuthClient {
  constructor(private readonly tokenStore: TokenStore) {}

  // ── Step 1: Build the Authorization URL ────────────────────────────────────

  /**
   * Generate a TikTok OAuth2 authorization URL.
   *
   * The `state` parameter is a CSRF token — it must be verified when TikTok
   * redirects back to your callback route.
   *
   * @param redirectUri  Must exactly match the URI registered in your TikTok app
   * @param state        Opaque CSRF value — store in Redis keyed to the session
   */
  buildAuthorizationUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      app_id: env.TIKTOK_APP_ID,
      redirect_uri: redirectUri,
      state,
    });

    const url = `${TIKTOK_AUTH_BASE}?${params.toString()}`;
    logger.debug({ url }, 'Built TikTok authorization URL');
    return url;
  }

  /**
   * Generate a cryptographically random state token for CSRF protection.
   */
  generateStateToken(): string {
    return randomBytes(32).toString('hex');
  }

  // ── Step 2: Exchange auth_code for tokens ──────────────────────────────────

  /**
   * Exchange the authorization code returned by TikTok's redirect for an
   * access_token + refresh_token pair.
   *
   * Called from the OAuth callback route after verifying the state parameter.
   *
   * POST https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/
   * Body: { app_id, secret, auth_code, grant_type: "authorization_code" }
   */
  async exchangeAuthCode(authCode: string): Promise<StoredToken[]> {
    logger.info('Exchanging TikTok auth_code for tokens');

    const response = await axios.post<TikTokTokenResponse>(
      TIKTOK_TOKEN_URL,
      {
        app_id: env.TIKTOK_APP_ID,
        secret: env.TIKTOK_APP_SECRET,
        auth_code: authCode,
        grant_type: 'authorization_code',
      },
      { headers: { 'Content-Type': 'application/json' } },
    );

    this.assertSuccess(response.data, 'Token exchange');

    const { access_token, refresh_token, advertiser_ids, scope } = response.data.data;

    // TikTok returns one token pair that covers all advertiser_ids in the grant.
    // We store one row per advertiser_id so lookups stay simple.
    const now = new Date();
    const accessExpiry = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpiry = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    const stored: StoredToken[] = [];

    for (const advertiserId of advertiser_ids) {
      const token = await this.tokenStore.upsert({
        advertiserId,
        accessToken: access_token,
        refreshToken: refresh_token,
        accessTokenExpiresAt: accessExpiry,
        refreshTokenExpiresAt: refreshExpiry,
        scope,
      });
      stored.push(token);
    }

    logger.info(
      { advertiserIds: advertiser_ids },
      `Tokens stored for ${advertiser_ids.length} advertiser(s)`,
    );

    return stored;
  }

  // ── Step 3: Refresh access token ───────────────────────────────────────────

  /**
   * Exchange a refresh_token for a new access_token.
   *
   * Access tokens expire after 24 hours. The ProactiveRefresher calls this
   * automatically. You can also trigger it manually.
   *
   * POST https://business-api.tiktok.com/open_api/v1.3/oauth2/refresh_token/
   * Body: { app_id, secret, refresh_token, grant_type: "refresh_token" }
   */
  async refreshAccessToken(advertiserId: string): Promise<StoredToken> {
    const stored = await this.tokenStore.getStoredToken(advertiserId);
    if (!stored) {
      throw new Error(`No token record found for advertiser_id: ${advertiserId}`);
    }

    const now = new Date();
    if (new Date(stored.refresh_token_expires_at) <= now) {
      throw new Error(
        `Refresh token for advertiser ${advertiserId} has expired — user must re-authorize`,
      );
    }

    logger.info({ advertiserId }, 'Refreshing TikTok access token');

    const response = await axios.post<TikTokRefreshResponse>(
      TIKTOK_REFRESH_URL,
      {
        app_id: env.TIKTOK_APP_ID,
        secret: env.TIKTOK_APP_SECRET,
        refresh_token: stored.refresh_token,
        grant_type: 'refresh_token',
      },
      { headers: { 'Content-Type': 'application/json' } },
    );

    this.assertSuccess(response.data, 'Token refresh');

    const { access_token, refresh_token, scope } = response.data.data;

    const accessExpiry = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpiry = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    const updated = await this.tokenStore.upsert({
      advertiserId,
      accessToken: access_token,
      refreshToken: refresh_token,
      accessTokenExpiresAt: accessExpiry,
      refreshTokenExpiresAt: refreshExpiry,
      scope,
    });

    logger.info({ advertiserId }, 'Access token refreshed successfully');
    return updated;
  }

  // ── Token retrieval with auto-refresh ──────────────────────────────────────

  /**
   * Get a valid access token for an advertiser.
   * Automatically refreshes if the stored token is within 1 hour of expiry.
   *
   * This is the method the TikTokAPIClient should call before every request.
   */
  async getValidToken(advertiserId: string): Promise<string> {
    const active = await this.tokenStore.getActiveToken(advertiserId);

    if (!active) {
      throw new Error(
        `No active token for advertiser ${advertiserId} — OAuth authorization required`,
      );
    }

    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    const needsRefresh = new Date(active.expires_at) <= oneHourFromNow;

    if (needsRefresh) {
      logger.info({ advertiserId }, 'Access token expiring soon — proactive refresh');
      const refreshed = await this.refreshAccessToken(advertiserId);
      return refreshed.access_token;
    }

    return active.access_token;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Verify TikTok's state parameter matches the one we generated.
   * Must be called in the callback route before exchanging the auth code.
   */
  verifyState(receivedState: string, expectedState: string): void {
    // Constant-time comparison to prevent timing attacks
    const a = Buffer.from(createHash('sha256').update(receivedState).digest('hex'));
    const b = Buffer.from(createHash('sha256').update(expectedState).digest('hex'));

    if (a.length !== b.length || !a.equals(b)) {
      throw new Error('OAuth state mismatch — possible CSRF attack');
    }
  }

  private assertSuccess(
    response: { code: number; message: string },
    context: string,
  ): void {
    if (response.code !== 0) {
      throw new Error(
        `TikTok ${context} failed: code=${response.code} message=${response.message}`,
      );
    }
  }
}
