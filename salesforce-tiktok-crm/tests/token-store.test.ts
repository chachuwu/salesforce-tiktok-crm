/**
 * TokenStore Tests
 *
 * Validates the two-layer token storage:
 *   - upsert()               : writes to Postgres + warms Redis cache
 *   - getActiveToken()       : Redis hit, Redis miss → Postgres fallback
 *   - getStoredToken()       : Postgres-only lookup
 *   - listActiveAdvertiserIds(): filters expired tokens
 *   - revoke()               : deletes from Postgres + Redis
 *   - Cache staleness guard  : expired tokens in cache are invalidated
 */

jest.mock('../src/config/env', () => ({
  env: {
    POSTGRES_HOST: 'localhost', POSTGRES_PORT: 5432,
    POSTGRES_DB: 'test', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'test',
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { TokenStore } from '../src/auth/token-store';
import { Pool } from 'pg';
import Redis from 'ioredis';

// ─── Mock pg ────────────────────────────────────────────────────────────────
const mockPgQuery = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: mockPgQuery, on: jest.fn() })) }));

// ─── Mock ioredis ────────────────────────────────────────────────────────────
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

const mockRedis = {
  get: mockRedisGet,
  set: mockRedisSet,
  del: mockRedisDel,
} as unknown as Redis;

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const future = new Date(Date.now() + 24 * 3600 * 1000);
const past   = new Date(Date.now() - 1000);
const year   = new Date(Date.now() + 365 * 24 * 3600 * 1000);

const pgTokenRow = {
  id: 'uuid-001',
  advertiser_id: 'adv-001',
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  access_token_expires_at: future,
  refresh_token_expires_at: year,
  scope: 'advertiser.manage',
  created_at: new Date(),
  updated_at: new Date(),
};

describe('TokenStore', () => {
  let store: TokenStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new TokenStore(new Pool() as unknown as Pool, mockRedis);
  });

  // ── upsert ─────────────────────────────────────────────────────────────────

  describe('upsert()', () => {
    it('executes INSERT ... ON CONFLICT DO UPDATE with correct params', async () => {
      mockPgQuery.mockResolvedValue({ rows: [pgTokenRow] });
      mockRedisSet.mockResolvedValue('OK');

      await store.upsert({
        advertiserId: 'adv-001',
        accessToken: 'access-abc',
        refreshToken: 'refresh-xyz',
        accessTokenExpiresAt: future,
        refreshTokenExpiresAt: year,
        scope: 'advertiser.manage',
      });

      const sql = mockPgQuery.mock.calls[0][0] as string;
      expect(sql).toMatch(/INSERT INTO tiktok_oauth_tokens/i);
      expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);

      const params = mockPgQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('adv-001');
      expect(params).toContain('access-abc');
      expect(params).toContain('refresh-xyz');
    });

    it('warms Redis cache after Postgres write', async () => {
      mockPgQuery.mockResolvedValue({ rows: [pgTokenRow] });
      mockRedisSet.mockResolvedValue('OK');

      await store.upsert({
        advertiserId: 'adv-001',
        accessToken: 'access-abc',
        refreshToken: 'refresh-xyz',
        accessTokenExpiresAt: future,
        refreshTokenExpiresAt: year,
        scope: '',
      });

      expect(mockRedisSet).toHaveBeenCalledWith(
        'tiktok:token:adv-001',
        expect.any(String),
        'EX',
        expect.any(Number),
      );
    });

    it('does not throw if Redis warm fails', async () => {
      mockPgQuery.mockResolvedValue({ rows: [pgTokenRow] });
      mockRedisSet.mockRejectedValue(new Error('Redis down'));

      await expect(
        store.upsert({
          advertiserId: 'adv-001',
          accessToken: 'x', refreshToken: 'y',
          accessTokenExpiresAt: future, refreshTokenExpiresAt: year, scope: '',
        }),
      ).resolves.not.toThrow();
    });
  });

  // ── getActiveToken — Redis hit ─────────────────────────────────────────────

  describe('getActiveToken() — cache hit', () => {
    it('returns token from Redis without querying Postgres', async () => {
      const cachedToken = {
        access_token: 'cached-token',
        advertiser_id: 'adv-001',
        expires_at: future.toISOString(),
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(cachedToken));

      const result = await store.getActiveToken('adv-001');

      expect(result?.access_token).toBe('cached-token');
      expect(mockPgQuery).not.toHaveBeenCalled();
    });

    it('invalidates and falls through when cached token is expired', async () => {
      const staleToken = {
        access_token: 'stale-token',
        advertiser_id: 'adv-001',
        expires_at: past.toISOString(),
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(staleToken));
      mockRedisDel.mockResolvedValue(1);
      mockPgQuery.mockResolvedValue({ rows: [] });

      await store.getActiveToken('adv-001');
      expect(mockRedisDel).toHaveBeenCalledWith('tiktok:token:adv-001');
    });
  });

  // ── getActiveToken — Postgres fallback ─────────────────────────────────────

  describe('getActiveToken() — Postgres fallback', () => {
    beforeEach(() => {
      mockRedisGet.mockResolvedValue(null); // cache miss
    });

    it('queries Postgres when cache misses', async () => {
      mockPgQuery.mockResolvedValue({ rows: [pgTokenRow] });
      mockRedisSet.mockResolvedValue('OK');

      const result = await store.getActiveToken('adv-001');
      expect(result?.access_token).toBe('access-abc');
      expect(mockPgQuery).toHaveBeenCalledTimes(1);
    });

    it('returns null when no Postgres row found', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] });
      const result = await store.getActiveToken('adv-unknown');
      expect(result).toBeNull();
    });

    it('re-warms Redis cache after Postgres hit', async () => {
      mockPgQuery.mockResolvedValue({ rows: [pgTokenRow] });
      mockRedisSet.mockResolvedValue('OK');

      await store.getActiveToken('adv-001');
      expect(mockRedisSet).toHaveBeenCalled();
    });

    it('handles Redis get error gracefully (falls through to Postgres)', async () => {
      mockRedisGet.mockRejectedValue(new Error('Redis error'));
      mockPgQuery.mockResolvedValue({ rows: [pgTokenRow] });
      mockRedisSet.mockResolvedValue('OK');

      const result = await store.getActiveToken('adv-001');
      expect(result?.access_token).toBe('access-abc');
    });
  });

  // ── listActiveAdvertiserIds ────────────────────────────────────────────────

  describe('listActiveAdvertiserIds()', () => {
    it('returns advertiser IDs with non-expired refresh tokens', async () => {
      mockPgQuery.mockResolvedValue({
        rows: [{ advertiser_id: 'adv-001' }, { advertiser_id: 'adv-002' }],
      });

      const ids = await store.listActiveAdvertiserIds();
      expect(ids).toEqual(['adv-001', 'adv-002']);
    });

    it('returns empty array when no active advertisers', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] });
      const ids = await store.listActiveAdvertiserIds();
      expect(ids).toEqual([]);
    });

    it('queries for tokens where refresh_token has not expired', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] });
      await store.listActiveAdvertiserIds();
      const sql = mockPgQuery.mock.calls[0][0] as string;
      expect(sql).toMatch(/refresh_token_expires_at > NOW/i);
    });
  });

  // ── revoke ────────────────────────────────────────────────────────────────

  describe('revoke()', () => {
    it('deletes row from Postgres', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] });
      mockRedisDel.mockResolvedValue(1);

      await store.revoke('adv-001');

      const sql = mockPgQuery.mock.calls[0][0] as string;
      expect(sql).toMatch(/DELETE FROM tiktok_oauth_tokens/i);
      const params = mockPgQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('adv-001');
    });

    it('deletes token from Redis cache', async () => {
      mockPgQuery.mockResolvedValue({ rows: [] });
      mockRedisDel.mockResolvedValue(1);

      await store.revoke('adv-001');
      expect(mockRedisDel).toHaveBeenCalledWith('tiktok:token:adv-001');
    });
  });
});
