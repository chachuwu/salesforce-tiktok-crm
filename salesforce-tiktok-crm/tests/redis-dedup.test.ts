/**
 * EventDeduplicator Tests
 *
 * Validates the Redis SET NX deduplication logic:
 * - Novel event IDs return false (not a duplicate) and are registered
 * - Repeated event IDs return true (duplicate)
 * - Redis failures fail open (return false) to prevent data loss
 * - filterDuplicates() correctly partitions a mixed batch
 */

jest.mock('../src/config/env', () => ({
  env: {
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: undefined,
    REDIS_TLS: false,
    REDIS_DEDUP_TTL_SECONDS: 172800,
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// Mock ioredis at the module level
const mockRedisSet = jest.fn();
const mockRedisQuit = jest.fn().mockResolvedValue('OK');
const mockRedisOn = jest.fn();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    set: mockRedisSet,
    quit: mockRedisQuit,
    on: mockRedisOn,
  }));
});

import { EventDeduplicator } from '../src/deduplication/redis-dedup';

describe('EventDeduplicator', () => {
  let deduplicator: EventDeduplicator;

  beforeEach(() => {
    jest.clearAllMocks();
    deduplicator = new EventDeduplicator();
  });

  // ── isDuplicate ────────────────────────────────────────────────────────────

  describe('isDuplicate()', () => {
    it('returns false (novel) when Redis SET NX returns "OK"', async () => {
      mockRedisSet.mockResolvedValue('OK');
      const result = await deduplicator.isDuplicate('event-abc');
      expect(result).toBe(false);
    });

    it('returns true (duplicate) when Redis SET NX returns null', async () => {
      mockRedisSet.mockResolvedValue(null);
      const result = await deduplicator.isDuplicate('event-abc');
      expect(result).toBe(true);
    });

    it('calls Redis with NX and EX options', async () => {
      mockRedisSet.mockResolvedValue('OK');
      await deduplicator.isDuplicate('event-xyz');

      expect(mockRedisSet).toHaveBeenCalledWith(
        'crm:dedup:event-xyz',
        '1',
        'EX',
        172800,
        'NX',
      );
    });

    it('uses the correct key prefix', async () => {
      mockRedisSet.mockResolvedValue('OK');
      await deduplicator.isDuplicate('my-event-id');

      const calledKey = mockRedisSet.mock.calls[0][0];
      expect(calledKey).toBe('crm:dedup:my-event-id');
    });

    it('fails open on Redis error (returns false, does not throw)', async () => {
      mockRedisSet.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await deduplicator.isDuplicate('event-fail');
      expect(result).toBe(false); // fail open
    });

    it('processes each event ID independently', async () => {
      mockRedisSet
        .mockResolvedValueOnce('OK')   // first event: novel
        .mockResolvedValueOnce(null);  // second event: duplicate

      const first = await deduplicator.isDuplicate('event-1');
      const second = await deduplicator.isDuplicate('event-2');

      expect(first).toBe(false);
      expect(second).toBe(true);
    });
  });

  // ── filterDuplicates ───────────────────────────────────────────────────────

  describe('filterDuplicates()', () => {
    it('returns empty set when all events are novel', async () => {
      mockRedisSet.mockResolvedValue('OK');
      const dupes = await deduplicator.filterDuplicates(['e1', 'e2', 'e3']);
      expect(dupes.size).toBe(0);
    });

    it('returns set containing only duplicate IDs', async () => {
      mockRedisSet
        .mockResolvedValueOnce('OK')   // e1: novel
        .mockResolvedValueOnce(null)   // e2: duplicate
        .mockResolvedValueOnce('OK');  // e3: novel

      const dupes = await deduplicator.filterDuplicates(['e1', 'e2', 'e3']);
      expect(dupes.has('e2')).toBe(true);
      expect(dupes.has('e1')).toBe(false);
      expect(dupes.has('e3')).toBe(false);
    });

    it('returns empty set for an empty input array', async () => {
      const dupes = await deduplicator.filterDuplicates([]);
      expect(dupes.size).toBe(0);
      expect(mockRedisSet).not.toHaveBeenCalled();
    });

    it('handles all duplicates', async () => {
      mockRedisSet.mockResolvedValue(null); // all duplicates
      const dupes = await deduplicator.filterDuplicates(['e1', 'e2', 'e3']);
      expect(dupes.size).toBe(3);
    });

    it('fails open per-event when Redis errors mid-batch', async () => {
      mockRedisSet
        .mockResolvedValueOnce('OK')
        .mockRejectedValueOnce(new Error('Redis error'))
        .mockResolvedValueOnce('OK');

      // Should resolve without throwing; errored event is treated as novel
      const dupes = await deduplicator.filterDuplicates(['e1', 'e2', 'e3']);
      expect(dupes.size).toBe(0);
    });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('calls redis.quit()', async () => {
      await deduplicator.disconnect();
      expect(mockRedisQuit).toHaveBeenCalledTimes(1);
    });
  });
});
