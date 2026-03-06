import { TikTokOAuthClient } from './tiktok-oauth';
import { TokenStore } from './token-store';
import { logger } from '../logging/logger';

/**
 * Proactive Token Refresher
 *
 * Runs on a configurable interval (default: every 23 hours) and refreshes
 * access tokens for all advertisers whose tokens will expire within the
 * next hour.
 *
 * TikTok access tokens last 24 hours; refresh tokens last 1 year.
 * Running this ensures the pipeline never stalls due to an expired token.
 */
export class ProactiveRefresher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly oauthClient: TikTokOAuthClient,
    private readonly tokenStore: TokenStore,
    /** How often to check for expiring tokens (ms). Default: 23 hours. */
    private readonly intervalMs: number = 23 * 60 * 60 * 1000,
  ) {}

  /**
   * Start the background refresh loop.
   * Safe to call multiple times — won't start a second interval.
   */
  start(): void {
    if (this.intervalHandle) return;

    logger.info(
      { intervalHours: this.intervalMs / 3_600_000 },
      'ProactiveRefresher started',
    );

    // Run immediately on boot, then on the interval
    void this.refreshAll();
    this.intervalHandle = setInterval(() => void this.refreshAll(), this.intervalMs);
  }

  /**
   * Stop the background loop (call during graceful shutdown).
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('ProactiveRefresher stopped');
    }
  }

  /**
   * Immediately check and refresh all expiring tokens.
   * Exposed for manual triggering (e.g. admin endpoint, tests).
   */
  async refreshAll(): Promise<{ refreshed: string[]; failed: string[] }> {
    const advertiserIds = await this.tokenStore.listActiveAdvertiserIds();

    if (advertiserIds.length === 0) {
      logger.debug('ProactiveRefresher: no active advertisers to refresh');
      return { refreshed: [], failed: [] };
    }

    logger.info({ count: advertiserIds.length }, 'ProactiveRefresher: checking tokens');

    const refreshed: string[] = [];
    const failed: string[] = [];

    await Promise.allSettled(
      advertiserIds.map(async (advertiserId) => {
        try {
          const active = await this.tokenStore.getActiveToken(advertiserId);
          if (!active) return;

          const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
          if (new Date(active.expires_at) > oneHourFromNow) {
            logger.debug({ advertiserId }, 'Token still valid — skipping refresh');
            return;
          }

          await this.oauthClient.refreshAccessToken(advertiserId);
          refreshed.push(advertiserId);
          logger.info({ advertiserId }, 'Token proactively refreshed');
        } catch (err) {
          failed.push(advertiserId);
          logger.error({ err, advertiserId }, 'Proactive token refresh failed');
        }
      }),
    );

    if (failed.length > 0) {
      logger.warn(
        { failed },
        'Some tokens could not be refreshed — manual re-authorization may be required',
      );
    }

    return { refreshed, failed };
  }
}
