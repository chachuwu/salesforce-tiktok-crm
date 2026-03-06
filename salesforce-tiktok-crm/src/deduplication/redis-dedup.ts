import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../logging/logger';

const DEDUP_KEY_PREFIX = 'crm:dedup:';

let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      tls: env.REDIS_TLS ? {} : undefined,
      retryStrategy: (times) => {
        const delay = Math.min(times * 100, 3000);
        logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting...');
        return delay;
      },
      lazyConnect: true,
    });

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis client error');
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected');
    });
  }
  return redisClient;
}

/**
 * Event Deduplication Store
 *
 * Uses Redis SET NX (set if not exists) to provide idempotent event
 * processing within a 48-hour window.
 *
 * Key: crm:dedup:<event_id>
 * TTL: REDIS_DEDUP_TTL_SECONDS (default 172800 = 48 h)
 */
export class EventDeduplicator {
  private redis: Redis;

  constructor() {
    this.redis = getRedisClient();
  }

  /**
   * Returns true if this event_id is a duplicate (already processed).
   * Returns false if novel — and atomically marks it as processed.
   */
  async isDuplicate(eventId: string): Promise<boolean> {
    const key = `${DEDUP_KEY_PREFIX}${eventId}`;
    try {
      // NX = only set if key doesn't exist; EX = TTL in seconds
      const result = await this.redis.set(
        key,
        '1',
        'EX',
        env.REDIS_DEDUP_TTL_SECONDS,
        'NX',
      );

      // SET NX returns 'OK' if set (novel), null if already existed (duplicate)
      const isDup = result === null;

      if (isDup) {
        logger.warn({ eventId }, 'Duplicate event detected — skipping');
      }

      return isDup;
    } catch (err) {
      // On Redis failure, allow the event through (fail open) to avoid data loss
      logger.error({ err, eventId }, 'Redis dedup check failed — allowing event through');
      return false;
    }
  }

  /**
   * Bulk check multiple event IDs.
   * Returns a Set of event IDs that are duplicates.
   */
  async filterDuplicates(eventIds: string[]): Promise<Set<string>> {
    const duplicates = new Set<string>();

    await Promise.all(
      eventIds.map(async (id) => {
        if (await this.isDuplicate(id)) {
          duplicates.add(id);
        }
      }),
    );

    return duplicates;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

export function getRedis(): Redis {
  return getRedisClient();
}
