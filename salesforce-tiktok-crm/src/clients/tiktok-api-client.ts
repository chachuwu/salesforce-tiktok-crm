import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { TikTokEventsPayload, TikTokAPIResponse } from '../types';
import { env } from '../config/env';
import { logger } from '../logging/logger';

/** Errors from TikTok that should NOT be retried (client errors) */
const NON_RETRYABLE_CODES = new Set([400, 401, 403]);

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;

  constructor(rps: number) {
    this.maxTokens = rps;
    this.tokens = rps;
    this.lastRefill = Date.now();
    this.refillIntervalMs = 1000;
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = this.refillIntervalMs - (Date.now() - this.lastRefill);
      await new Promise((res) => setTimeout(res, Math.max(waitMs, 10)));
    }
  }

  private refill(): void {
    const now = Date.now();
    if (now - this.lastRefill >= this.refillIntervalMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }
}

/**
 * Token resolver: a function that returns a valid access token on demand.
 *
 * Two modes:
 *   1. OAuth mode   — pass an async fn that calls TikTokOAuthClient.getValidToken()
 *   2. Static mode  — pass () => Promise.resolve(TIKTOK_ACCESS_TOKEN)  (legacy)
 */
export type TokenResolver = () => Promise<string>;

/**
 * TikTok CRM Events API Client
 *
 * Accepts a TokenResolver so it works with both the OAuth dynamic token flow
 * and the legacy static access token env var.
 */
export class TikTokAPIClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter: RateLimiter;
  private readonly resolveToken: TokenResolver;

  constructor(tokenResolver?: TokenResolver) {
    this.rateLimiter = new RateLimiter(env.TIKTOK_RATE_LIMIT_RPS);

    // Fall back to static env token if no resolver provided
    this.resolveToken = tokenResolver ?? (async () => {
      if (!env.TIKTOK_ACCESS_TOKEN) {
        throw new Error(
          'No token resolver provided and TIKTOK_ACCESS_TOKEN is not set. ' +
          'Complete OAuth at /auth/tiktok or set TIKTOK_ACCESS_TOKEN.',
        );
      }
      return env.TIKTOK_ACCESS_TOKEN;
    });

    this.http = axios.create({
      baseURL: `${env.TIKTOK_API_BASE_URL}/open_api/${env.TIKTOK_API_VERSION}`,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });

    axiosRetry(this.http, {
      retries: env.TIKTOK_MAX_RETRIES,
      retryDelay: (retryCount) => {
        const delay = env.TIKTOK_INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1);
        const jitter = Math.random() * 200;
        return delay + jitter;
      },
      retryCondition: (error: AxiosError) => {
        if (error.response) {
          const status = error.response.status;
          if (NON_RETRYABLE_CODES.has(status)) {
            logger.error({ status, url: error.config?.url }, 'Non-retryable TikTok API error');
            return false;
          }
          return status === 429 || status >= 500;
        }
        return axiosRetry.isNetworkError(error);
      },
      onRetry: (retryCount, error) => {
        logger.warn({ retryCount, status: error.response?.status, message: error.message }, 'Retrying TikTok API request');
      },
    });

    this.http.interceptors.request.use((config) => {
      logger.debug({ url: config.url, method: config.method }, 'TikTok API request');
      return config;
    });

    this.http.interceptors.response.use(
      (response) => {
        logger.info(
          { status: response.status, tiktokCode: (response.data as TikTokAPIResponse).code, requestId: (response.data as TikTokAPIResponse).request_id },
          'TikTok API response',
        );
        return response;
      },
      (error: AxiosError) => {
        logger.error({ status: error.response?.status, data: error.response?.data, message: error.message }, 'TikTok API error');
        return Promise.reject(error);
      },
    );
  }

  /**
   * Send a batch of events to TikTok Events API.
   * Resolves a fresh token before each request via the TokenResolver.
   */
  async sendEvents(payload: TikTokEventsPayload): Promise<TikTokAPIResponse> {
    await this.rateLimiter.acquire();

    // Token resolved per-call — the resolver handles caching + proactive refresh
    const accessToken = await this.resolveToken();

    const eventIds = payload.data.map((e) => e.event_id);
    logger.info({ eventCount: payload.data.length, eventIds }, 'Sending events to TikTok');

    const response = await this.http.post<TikTokAPIResponse>('/event/track', payload, {
      headers: { 'Access-Token': accessToken },
    });

    const result = response.data;

    if (result.code !== 0) {
      const err = new Error(`TikTok API returned non-zero code: ${result.code} — ${result.message}`);
      logger.error({ code: result.code, message: result.message, requestId: result.request_id }, 'TikTok API business logic error');
      throw err;
    }

    return result;
  }
}
