/**
 * TikTokOAuthClient Tests
 *
 * Covers the three-step OAuth2 flow:
 *   1. buildAuthorizationUrl() — correct URL construction
 *   2. exchangeAuthCode()      — auth_code → access + refresh tokens
 *   3. refreshAccessToken()    — refresh_token → new access token
 *   4. verifyState()           — CSRF protection
 *   5. getValidToken()         — auto-refresh when near expiry
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

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  post: (...args: unknown[]) => mockAxiosPost(...args),
}));

import { TikTokOAuthClient } from '../src/auth/tiktok-oauth';
import { TokenStore } from '../src/auth/token-store';
import { StoredToken } from '../src/auth/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockUpsert = jest.fn();
const mockGetActiveToken = jest.fn();
const mockGetStoredToken = jest.fn();
const mockListActive = jest.fn();

const mockTokenStore = {
  upsert: mockUpsert,
  getActiveToken: mockGetActiveToken,
  getStoredToken: mockGetStoredToken,
  listActiveAdvertiserIds: mockListActive,
} as unknown as TokenStore;

function makeStoredToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    id: 'uuid-001',
    advertiser_id: 'adv-001',
    access_token: 'access-abc',
    refresh_token: 'refresh-xyz',
    access_token_expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    refresh_token_expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    scope: 'advertiser.manage',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTikTokTokenResponse(advertiserIds = ['adv-001']) {
  return {
    data: {
      code: 0,
      message: 'OK',
      request_id: 'req-001',
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        access_token_expire_in: 86400,
        refresh_token_expire_in: 31536000,
        token_type: 'bearer',
        scope: 'advertiser.manage',
        advertiser_ids: advertiserIds,
      },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TikTokOAuthClient', () => {
  let client: TikTokOAuthClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new TikTokOAuthClient(mockTokenStore);
  });

  // ── Authorization URL ──────────────────────────────────────────────────────

  describe('buildAuthorizationUrl()', () => {
    it('starts with the TikTok auth base URL', () => {
      const url = client.buildAuthorizationUrl('https://example.com/callback', 'state-abc');
      expect(url).toContain('https://ads.tiktok.com/marketing_api/auth');
    });

    it('includes app_id param', () => {
      const url = client.buildAuthorizationUrl('https://example.com/callback', 'state-abc');
      expect(url).toContain('app_id=test-app-id');
    });

    it('includes redirect_uri param', () => {
      const url = client.buildAuthorizationUrl('https://example.com/callback', 'state-abc');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain(encodeURIComponent('https://example.com/callback'));
    });

    it('includes state param', () => {
      const url = client.buildAuthorizationUrl('https://example.com/callback', 'my-state-token');
      expect(url).toContain('state=my-state-token');
    });

    it('does NOT include client_secret in the URL', () => {
      const url = client.buildAuthorizationUrl('https://example.com/callback', 'state-abc');
      expect(url).not.toContain('test-app-secret');
    });
  });

  // ── State token generation ─────────────────────────────────────────────────

  describe('generateStateToken()', () => {
    it('returns a 64-char hex string', () => {
      const state = client.generateStateToken();
      expect(state).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates unique tokens each call', () => {
      const a = client.generateStateToken();
      const b = client.generateStateToken();
      expect(a).not.toBe(b);
    });
  });

  // ── CSRF state verification ────────────────────────────────────────────────

  describe('verifyState()', () => {
    it('passes when received state matches expected state', () => {
      expect(() => client.verifyState('abc123', 'abc123')).not.toThrow();
    });

    it('throws when state does not match', () => {
      expect(() => client.verifyState('abc123', 'xyz789')).toThrow('OAuth state mismatch');
    });

    it('throws for empty vs populated state', () => {
      expect(() => client.verifyState('', 'abc123')).toThrow('OAuth state mismatch');
    });

    it('is case-sensitive', () => {
      expect(() => client.verifyState('ABC123', 'abc123')).toThrow('OAuth state mismatch');
    });
  });

  // ── exchangeAuthCode ───────────────────────────────────────────────────────

  describe('exchangeAuthCode()', () => {
    beforeEach(() => {
      mockAxiosPost.mockResolvedValue(makeTikTokTokenResponse(['adv-001', 'adv-002']));
      mockUpsert.mockImplementation(({ advertiserId }: { advertiserId: string }) =>
        Promise.resolve(makeStoredToken({ advertiser_id: advertiserId })),
      );
    });

    it('POSTs to the correct token endpoint', async () => {
      await client.exchangeAuthCode('auth-code-abc');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/oauth2/access_token/'),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('sends app_id, secret, and auth_code in the body', async () => {
      await client.exchangeAuthCode('auth-code-abc');
      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.app_id).toBe('test-app-id');
      expect(body.secret).toBe('test-app-secret');
      expect(body.auth_code).toBe('auth-code-abc');
    });

    it('sends grant_type: authorization_code', async () => {
      await client.exchangeAuthCode('my-auth-code');
      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.grant_type).toBe('authorization_code');
    });

    it('upserts one token record per advertiser_id', async () => {
      await client.exchangeAuthCode('auth-code-abc');
      expect(mockUpsert).toHaveBeenCalledTimes(2);
      const calledIds = mockUpsert.mock.calls.map((c: unknown[]) => (c[0] as { advertiserId: string }).advertiserId);
      expect(calledIds).toContain('adv-001');
      expect(calledIds).toContain('adv-002');
    });

    it('returns one StoredToken per advertiser', async () => {
      const tokens = await client.exchangeAuthCode('auth-code-abc');
      expect(tokens).toHaveLength(2);
    });

    it('throws when TikTok returns a non-zero code', async () => {
      mockAxiosPost.mockResolvedValue({
        data: { code: 40001, message: 'Invalid app_id', request_id: 'req-err' },
      });
      await expect(client.exchangeAuthCode('bad-code')).rejects.toThrow('code=40001');
    });
  });

  // ── refreshAccessToken ─────────────────────────────────────────────────────

  describe('refreshAccessToken()', () => {
    const validStoredToken = makeStoredToken();

    beforeEach(() => {
      mockGetStoredToken.mockResolvedValue(validStoredToken);
      mockAxiosPost.mockResolvedValue({
        data: {
          code: 0,
          message: 'OK',
          request_id: 'req-refresh',
          data: {
            access_token: 'refreshed-access-token',
            refresh_token: 'refreshed-refresh-token',
            access_token_expire_in: 86400,
            refresh_token_expire_in: 31536000,
            token_type: 'bearer',
            scope: 'advertiser.manage',
          },
        },
      });
      mockUpsert.mockResolvedValue(makeStoredToken({ access_token: 'refreshed-access-token' }));
    });

    it('POSTs to the refresh token endpoint', async () => {
      await client.refreshAccessToken('adv-001');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/oauth2/refresh_token/'),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('sends the stored refresh_token in the body', async () => {
      await client.refreshAccessToken('adv-001');
      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.refresh_token).toBe('refresh-xyz');
    });

    it('sends grant_type: refresh_token', async () => {
      await client.refreshAccessToken('adv-001');
      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.grant_type).toBe('refresh_token');
    });

    it('upserts the new token pair', async () => {
      await client.refreshAccessToken('adv-001');
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'refreshed-access-token' }),
      );
    });

    it('throws when no stored token found', async () => {
      mockGetStoredToken.mockResolvedValue(null);
      await expect(client.refreshAccessToken('adv-unknown')).rejects.toThrow(
        'No token record found',
      );
    });

    it('throws when refresh token is expired', async () => {
      mockGetStoredToken.mockResolvedValue(
        makeStoredToken({
          refresh_token_expires_at: new Date(Date.now() - 1000), // expired
        }),
      );
      await expect(client.refreshAccessToken('adv-001')).rejects.toThrow(
        'Refresh token.*expired',
      );
    });
  });

  // ── getValidToken ──────────────────────────────────────────────────────────

  describe('getValidToken()', () => {
    it('returns cached token when still valid (>1h remaining)', async () => {
      mockGetActiveToken.mockResolvedValue({
        access_token: 'cached-token',
        advertiser_id: 'adv-001',
        expires_at: new Date(Date.now() + 2 * 3600 * 1000), // 2 hours from now
      });

      const token = await client.getValidToken('adv-001');
      expect(token).toBe('cached-token');
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('proactively refreshes when token expires within 1 hour', async () => {
      mockGetActiveToken.mockResolvedValue({
        access_token: 'expiring-token',
        advertiser_id: 'adv-001',
        expires_at: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      });
      mockGetStoredToken.mockResolvedValue(makeStoredToken());
      mockAxiosPost.mockResolvedValue({
        data: {
          code: 0, message: 'OK', request_id: 'req-001',
          data: {
            access_token: 'fresh-token', refresh_token: 'fresh-refresh',
            access_token_expire_in: 86400, refresh_token_expire_in: 31536000,
            token_type: 'bearer', scope: '',
          },
        },
      });
      mockUpsert.mockResolvedValue(makeStoredToken({ access_token: 'fresh-token' }));

      const token = await client.getValidToken('adv-001');
      expect(token).toBe('fresh-token');
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    });

    it('throws when no token exists for advertiser', async () => {
      mockGetActiveToken.mockResolvedValue(null);
      await expect(client.getValidToken('adv-unknown')).rejects.toThrow(
        'OAuth authorization required',
      );
    });
  });
});
