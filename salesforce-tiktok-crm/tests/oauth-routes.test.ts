/**
 * OAuth Routes Tests
 *
 * Tests the Express HTTP handlers for:
 *   GET  /auth/tiktok             — builds auth URL, stores state, redirects
 *   GET  /auth/tiktok/callback    — verifies state, exchanges code, returns result
 *   GET  /auth/tiktok/status      — lists authorised advertiser IDs
 *   POST /auth/tiktok/refresh/:id — manual token refresh
 *   POST /auth/tiktok/revoke/:id  — revoke access
 *
 * Uses supertest for HTTP-level assertions; all OAuth/store dependencies mocked.
 */

jest.mock('../src/config/env', () => ({
  env: {
    TIKTOK_APP_ID: 'test-app-id',
    TIKTOK_APP_SECRET: 'test-app-secret',
    TIKTOK_REDIRECT_URI: 'https://example.com/auth/tiktok/callback',
    TIKTOK_API_BASE_URL: 'https://business-api.tiktok.com',
    TIKTOK_API_VERSION: 'v1.3',
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { buildOAuthRouter } from '../src/auth/oauth-routes';
import { TikTokOAuthClient } from '../src/auth/tiktok-oauth';
import { TokenStore } from '../src/auth/token-store';
import { StoredToken } from '../src/auth/types';
import Redis from 'ioredis';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockBuildAuthUrl = jest.fn();
const mockGenerateState = jest.fn();
const mockVerifyState = jest.fn();
const mockExchangeAuthCode = jest.fn();
const mockRefreshToken = jest.fn();

const mockOAuthClient = {
  buildAuthorizationUrl: mockBuildAuthUrl,
  generateStateToken: mockGenerateState,
  verifyState: mockVerifyState,
  exchangeAuthCode: mockExchangeAuthCode,
  refreshAccessToken: mockRefreshToken,
} as unknown as TikTokOAuthClient;

const mockListActive = jest.fn();
const mockRevoke = jest.fn();

const mockTokenStore = {
  listActiveAdvertiserIds: mockListActive,
  revoke: mockRevoke,
} as unknown as TokenStore;

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

const mockRedis = {
  get: mockRedisGet,
  set: mockRedisSet,
  del: mockRedisDel,
} as unknown as Redis;

// ─── Test app setup ───────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', buildOAuthRouter(mockOAuthClient, mockTokenStore, mockRedis));
  return app;
}

function makeStoredToken(advertiserId: string): StoredToken {
  return {
    id: 'uuid-001',
    advertiser_id: advertiserId,
    access_token: 'access-abc',
    refresh_token: 'refresh-xyz',
    access_token_expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    refresh_token_expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    scope: 'advertiser.manage',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OAuth Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // ── GET /auth/tiktok — initiate ─────────────────────────────────────────────

  describe('GET /auth/tiktok', () => {
    it('redirects to TikTok authorization URL', async () => {
      mockGenerateState.mockReturnValue('state-token-abc');
      mockRedisSet.mockResolvedValue('OK');
      mockBuildAuthUrl.mockReturnValue(
        'https://ads.tiktok.com/marketing_api/auth?app_id=test-app-id&state=state-token-abc',
      );

      const res = await request(app).get('/auth/tiktok');

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('ads.tiktok.com/marketing_api/auth');
    });

    it('stores state in Redis with TTL', async () => {
      mockGenerateState.mockReturnValue('state-xyz');
      mockRedisSet.mockResolvedValue('OK');
      mockBuildAuthUrl.mockReturnValue('https://ads.tiktok.com/marketing_api/auth?state=state-xyz');

      await request(app).get('/auth/tiktok');

      expect(mockRedisSet).toHaveBeenCalledWith(
        expect.stringContaining('state-xyz'),
        expect.any(String),
        'EX',
        600, // 10-minute TTL
      );
    });
  });

  // ── GET /auth/tiktok/callback — success ─────────────────────────────────────

  describe('GET /auth/tiktok/callback — success', () => {
    const storedState = JSON.stringify({
      csrf_token: 'state-token-abc',
      created_at: new Date().toISOString(),
    });

    beforeEach(() => {
      mockRedisGet.mockResolvedValue(storedState);
      mockRedisDel.mockResolvedValue(1);
      mockVerifyState.mockReturnValue(undefined); // no throw = valid
      mockExchangeAuthCode.mockResolvedValue([makeStoredToken('adv-001')]);
    });

    it('returns 200 with authorized advertiser IDs', async () => {
      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'auth-code-abc', state: 'state-token-abc' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('authorized');
      expect(res.body.advertiser_ids).toContain('adv-001');
    });

    it('deletes the state key from Redis after use', async () => {
      await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'auth-code-abc', state: 'state-token-abc' });

      expect(mockRedisDel).toHaveBeenCalledWith(
        expect.stringContaining('state-token-abc'),
      );
    });

    it('calls exchangeAuthCode with the correct auth_code', async () => {
      await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'my-auth-code', state: 'state-token-abc' });

      expect(mockExchangeAuthCode).toHaveBeenCalledWith('my-auth-code');
    });

    it('redirects if redirect_after was stored in state', async () => {
      mockRedisGet.mockResolvedValue(
        JSON.stringify({
          csrf_token: 'state-token-abc',
          redirect_after: 'https://app.example.com/dashboard',
          created_at: new Date().toISOString(),
        }),
      );

      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'auth-code-abc', state: 'state-token-abc' });

      expect(res.status).toBe(302);
      expect(res.headers['location']).toContain('app.example.com/dashboard');
      expect(res.headers['location']).toContain('authorized=true');
    });
  });

  // ── GET /auth/tiktok/callback — error cases ────────────────────────────────

  describe('GET /auth/tiktok/callback — errors', () => {
    it('returns 400 when user denies authorization', async () => {
      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ error: 'access_denied', error_description: 'User denied' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('authorization_denied');
    });

    it('returns 400 when auth_code is missing', async () => {
      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ state: 'some-state' }); // no auth_code

      expect(res.status).toBe(400);
    });

    it('returns 400 when state is missing', async () => {
      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'some-code' }); // no state

      expect(res.status).toBe(400);
    });

    it('returns 400 when state not found in Redis (expired or invalid)', async () => {
      mockRedisGet.mockResolvedValue(null);

      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'code', state: 'unknown-state' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid or expired/i);
    });

    it('returns 403 on CSRF state mismatch', async () => {
      mockRedisGet.mockResolvedValue(
        JSON.stringify({ csrf_token: 'valid-state', created_at: new Date().toISOString() }),
      );
      mockRedisDel.mockResolvedValue(1);
      mockVerifyState.mockImplementation(() => {
        throw new Error('OAuth state mismatch — possible CSRF attack');
      });

      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'code', state: 'tampered-state' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/state verification/i);
    });

    it('returns 500 when token exchange fails', async () => {
      mockRedisGet.mockResolvedValue(
        JSON.stringify({ csrf_token: 'state-abc', created_at: new Date().toISOString() }),
      );
      mockRedisDel.mockResolvedValue(1);
      mockVerifyState.mockReturnValue(undefined);
      mockExchangeAuthCode.mockRejectedValue(new Error('TikTok API error'));

      const res = await request(app)
        .get('/auth/tiktok/callback')
        .query({ auth_code: 'code', state: 'state-abc' });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/token exchange failed/i);
    });
  });

  // ── GET /auth/tiktok/status ────────────────────────────────────────────────

  describe('GET /auth/tiktok/status', () => {
    it('returns list of authorized advertiser IDs', async () => {
      mockListActive.mockResolvedValue(['adv-001', 'adv-002', 'adv-003']);

      const res = await request(app).get('/auth/tiktok/status');

      expect(res.status).toBe(200);
      expect(res.body.authorized_advertisers).toEqual(['adv-001', 'adv-002', 'adv-003']);
      expect(res.body.count).toBe(3);
    });

    it('returns empty list when no advertisers authorized', async () => {
      mockListActive.mockResolvedValue([]);
      const res = await request(app).get('/auth/tiktok/status');
      expect(res.body.count).toBe(0);
    });
  });

  // ── POST /auth/tiktok/refresh/:advertiserId ────────────────────────────────

  describe('POST /auth/tiktok/refresh/:advertiserId', () => {
    it('returns 200 with new expiry on success', async () => {
      const expiry = new Date(Date.now() + 24 * 3600 * 1000);
      mockRefreshToken.mockResolvedValue(makeStoredToken('adv-001'));

      const res = await request(app).post('/auth/tiktok/refresh/adv-001');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('refreshed');
      expect(res.body.advertiser_id).toBe('adv-001');
    });

    it('returns 400 when refresh fails (expired refresh token)', async () => {
      mockRefreshToken.mockRejectedValue(new Error('Refresh token has expired'));

      const res = await request(app).post('/auth/tiktok/refresh/adv-expired');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Refresh failed');
    });
  });

  // ── POST /auth/tiktok/revoke/:advertiserId ─────────────────────────────────

  describe('POST /auth/tiktok/revoke/:advertiserId', () => {
    it('returns 200 on successful revocation', async () => {
      mockRevoke.mockResolvedValue(undefined);

      const res = await request(app).post('/auth/tiktok/revoke/adv-001');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('revoked');
      expect(res.body.advertiser_id).toBe('adv-001');
    });

    it('returns 500 on revocation error', async () => {
      mockRevoke.mockRejectedValue(new Error('DB error'));

      const res = await request(app).post('/auth/tiktok/revoke/adv-001');
      expect(res.status).toBe(500);
    });
  });
});
