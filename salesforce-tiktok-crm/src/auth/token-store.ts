import { Pool } from 'pg';
import Redis from 'ioredis';
import { StoredToken, ActiveToken } from './types';
import { logger } from '../logging/logger';
import { v4 as uuidv4 } from 'uuid';

const TOKEN_CACHE_PREFIX = 'tiktok:token:';
// Cache access tokens for 23 h — refresh 1 hour before they expire
const TOKEN_CACHE_TTL_SECONDS = 23 * 60 * 60;

const OAUTH_STATE_PREFIX = 'tiktok:oauth:state:';
// State tokens expire after 10 minutes
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/**
 * Token Store
 *
 * Two-layer storage:
 *   1. Redis  — fast cache for hot-path API calls (23 h TTL)
 *   2. Postgres — durable record; source of truth for refresh tokens
 *
 * Schema:
 *   tiktok_oauth_tokens (id, advertiser_id, access_token, refresh_token,
 *     access_token_expires_at, refresh_token_expires_at, scope,
 *     created_at, updated_at)
 */
export class TokenStore {
  constructor(
    private readonly pg: Pool,
    private readonly redis: Redis,
  ) {}

  // ── Upsert ──────────────────────────────────────────────────────────────────

  /**
   * Persist (or replace) tokens for a given advertiser_id.
   * Called after initial token exchange and every refresh.
   */
  async upsert(params: {
    advertiserId: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
    scope: string;
  }): Promise<StoredToken> {
    const id = uuidv4();

    const sql = `
      INSERT INTO tiktok_oauth_tokens
        (id, advertiser_id, access_token, refresh_token,
         access_token_expires_at, refresh_token_expires_at,
         scope, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      ON CONFLICT (advertiser_id)
      DO UPDATE SET
        access_token             = EXCLUDED.access_token,
        refresh_token            = EXCLUDED.refresh_token,
        access_token_expires_at  = EXCLUDED.access_token_expires_at,
        refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
        scope                    = EXCLUDED.scope,
        updated_at               = NOW()
      RETURNING *
    `;

    const result = await this.pg.query<StoredToken>(sql, [
      id,
      params.advertiserId,
      params.accessToken,
      params.refreshToken,
      params.accessTokenExpiresAt,
      params.refreshTokenExpiresAt,
      params.scope,
    ]);

    const token = result.rows[0];

    // Warm the Redis cache
    await this.cacheToken(token);

    logger.info({ advertiserId: params.advertiserId }, 'Token upserted');
    return token;
  }

  // ── Get Active Token ────────────────────────────────────────────────────────

  /**
   * Return the best available active token for an advertiser.
   * Checks Redis first; falls back to Postgres.
   * Returns null if no token exists or the refresh token has expired.
   */
  async getActiveToken(advertiserId: string): Promise<ActiveToken | null> {
    // 1. Try Redis cache
    const cached = await this.getFromCache(advertiserId);
    if (cached) return cached;

    // 2. Fall back to Postgres
    const sql = `
      SELECT * FROM tiktok_oauth_tokens
      WHERE advertiser_id = $1
        AND refresh_token_expires_at > NOW()
      LIMIT 1
    `;
    const result = await this.pg.query<StoredToken>(sql, [advertiserId]);
    if (!result.rows.length) return null;

    const token = result.rows[0];

    // Re-warm cache if the access token is still valid
    if (new Date(token.access_token_expires_at) > new Date()) {
      await this.cacheToken(token);
    }

    return {
      access_token: token.access_token,
      advertiser_id: token.advertiser_id,
      expires_at: new Date(token.access_token_expires_at),
    };
  }

  /**
   * Fetch full StoredToken row from Postgres (needed for refresh flow).
   */
  async getStoredToken(advertiserId: string): Promise<StoredToken | null> {
    const result = await this.pg.query<StoredToken>(
      'SELECT * FROM tiktok_oauth_tokens WHERE advertiser_id = $1 LIMIT 1',
      [advertiserId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * List all advertiser IDs that have active (non-expired) refresh tokens.
   */
  async listActiveAdvertiserIds(): Promise<string[]> {
    const result = await this.pg.query<{ advertiser_id: string }>(
      `SELECT advertiser_id FROM tiktok_oauth_tokens
       WHERE refresh_token_expires_at > NOW()
       ORDER BY updated_at DESC`,
    );
    return result.rows.map((r) => r.advertiser_id);
  }

  /**
   * Delete token record for an advertiser (e.g. user revokes access).
   */
  async revoke(advertiserId: string): Promise<void> {
    await this.pg.query(
      'DELETE FROM tiktok_oauth_tokens WHERE advertiser_id = $1',
      [advertiserId],
    );
    await this.redis.del(`${TOKEN_CACHE_PREFIX}${advertiserId}`);
    logger.info({ advertiserId }, 'Token revoked');
  }

  // ── OAuth State (CSRF) ──────────────────────────────────────────────────────

  /**
   * Store a one-time OAuth state token in Redis for CSRF verification (10-min TTL).
   */
  async storeState(state: string): Promise<void> {
    const key = `${OAUTH_STATE_PREFIX}${state}`;
    await this.redis.set(key, state, 'EX', OAUTH_STATE_TTL_SECONDS);
  }

  /**
   * Retrieve and atomically delete an OAuth state token.
   * Returns an object with .value if found, or null if expired/missing.
   */
  async getAndDeleteState(state: string): Promise<{ value: string; redirectAfter?: string } | null> {
    const key = `${OAUTH_STATE_PREFIX}${state}`;
    const value = await this.redis.getdel(key);
    if (!value) return null;
    return { value };
  }

  // ── Cache helpers ───────────────────────────────────────────────────────────

  private async cacheToken(token: StoredToken): Promise<void> {
    const key = `${TOKEN_CACHE_PREFIX}${token.advertiser_id}`;
    const value: ActiveToken = {
      access_token: token.access_token,
      advertiser_id: token.advertiser_id,
      expires_at: new Date(token.access_token_expires_at),
    };
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', TOKEN_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'Failed to cache token in Redis — using Postgres fallback');
    }
  }

  private async getFromCache(advertiserId: string): Promise<ActiveToken | null> {
    try {
      const raw = await this.redis.get(`${TOKEN_CACHE_PREFIX}${advertiserId}`);
      if (!raw) return null;
      const token = JSON.parse(raw) as ActiveToken;
      // Don't return stale tokens that slipped through TTL rounding
      if (new Date(token.expires_at) <= new Date()) {
        await this.redis.del(`${TOKEN_CACHE_PREFIX}${advertiserId}`);
        return null;
      }
      return token;
    } catch {
      return null; // cache miss on error is fine
    }
  }
}
