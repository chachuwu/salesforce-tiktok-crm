/**
 * TikTok API Client Tests
 *
 * Tests HTTP success/failure handling, non-retryable error codes,
 * business logic error codes (non-zero code in 200 response),
 * and payload structure sent to the API.
 *
 * Uses axios-mock-adapter to intercept HTTP calls without a real network.
 */

jest.mock('../src/config/env', () => ({
  env: {
    TIKTOK_ACCESS_TOKEN: 'test-access-token',
    TIKTOK_CRM_EVENT_SET_ID: 'test-event-set-id',
    TIKTOK_API_BASE_URL: 'https://business-api.tiktok.com',
    TIKTOK_API_VERSION: 'v1.3',
    TIKTOK_MAX_RETRIES: 2,
    TIKTOK_INITIAL_RETRY_DELAY_MS: 10, // fast for tests
    TIKTOK_RATE_LIMIT_RPS: 100,        // high so rate limiter doesn't block tests
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { TikTokAPIClient } from '../src/clients/tiktok-api-client';
import { TikTokEventsPayload } from '../src/types';

// We intercept at the module level — grab axios's default instance adapter
// Note: TikTokAPIClient creates its own instance via axios.create(),
// so we mock at the adapter level by intercepting the underlying adapter.
// The simplest approach is to mock the http.post method directly.

const makePayload = (eventId = 'event-001'): TikTokEventsPayload => ({
  event_source: 'crm',
  event_source_id: 'test-event-set-id',
  data: [
    {
      event: 'LeadCreated',
      event_time: 1710000000,
      event_id: eventId,
      user: {
        email: 'a'.repeat(64), // mock hash
        ttclid: 'click-abc',
        ip: '1.2.3.4',
      },
    },
  ],
});

describe('TikTokAPIClient', () => {
  let client: TikTokAPIClient;
  let mockPost: jest.SpyInstance;

  beforeEach(() => {
    client = new TikTokAPIClient();
    // Access the private http axios instance via casting
    const httpInstance = (client as unknown as { http: { post: jest.Mock } }).http;
    mockPost = jest.spyOn(httpInstance, 'post');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Successful response ────────────────────────────────────────────────────

  describe('Successful send', () => {
    it('returns TikTok API response on success', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 0, message: 'OK', request_id: 'req-001' },
      });

      const result = await client.sendEvents(makePayload());
      expect(result.code).toBe(0);
      expect(result.request_id).toBe('req-001');
    });

    it('posts to the correct endpoint path', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 0, message: 'OK', request_id: 'req-001' },
      });

      await client.sendEvents(makePayload());
      expect(mockPost).toHaveBeenCalledWith('/event/track', expect.any(Object));
    });

    it('includes all events in the post body', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 0, message: 'OK', request_id: 'req-001' },
      });

      const payload = makePayload();
      await client.sendEvents(payload);

      const sentBody = mockPost.mock.calls[0][1] as TikTokEventsPayload;
      expect(sentBody.data).toHaveLength(1);
      expect(sentBody.data[0].event_id).toBe('event-001');
    });
  });

  // ── Business logic errors (non-zero code in 200 response) ──────────────────

  describe('Business logic errors (code !== 0)', () => {
    it('throws when TikTok returns code 40002 (invalid param)', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 40002, message: 'Invalid parameter', request_id: 'req-err-001' },
      });

      await expect(client.sendEvents(makePayload())).rejects.toThrow(
        'TikTok API returned non-zero code: 40002',
      );
    });

    it('throws when TikTok returns code 40100 (auth failure)', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 40100, message: 'Unauthorized', request_id: 'req-err-002' },
      });

      await expect(client.sendEvents(makePayload())).rejects.toThrow(
        'TikTok API returned non-zero code: 40100',
      );
    });
  });

  // ── HTTP-level errors ──────────────────────────────────────────────────────

  describe('HTTP errors', () => {
    it('throws on 500 server error', async () => {
      mockPost.mockRejectedValue(
        Object.assign(new Error('Internal Server Error'), {
          response: { status: 500, data: { message: 'Server error' } },
          isAxiosError: true,
        }),
      );

      await expect(client.sendEvents(makePayload())).rejects.toThrow();
    });

    it('throws on network timeout', async () => {
      mockPost.mockRejectedValue(
        Object.assign(new Error('ECONNABORTED'), { isAxiosError: true }),
      );

      await expect(client.sendEvents(makePayload())).rejects.toThrow();
    });
  });

  // ── Payload structure validation ───────────────────────────────────────────

  describe('Payload structure', () => {
    it('sends payload with correct event_source', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 0, message: 'OK', request_id: 'req-001' },
      });

      const payload = makePayload();
      await client.sendEvents(payload);

      const body = mockPost.mock.calls[0][1] as TikTokEventsPayload;
      expect(body.event_source).toBe('crm');
    });

    it('sends payload with event_source_id', async () => {
      mockPost.mockResolvedValue({
        status: 200,
        data: { code: 0, message: 'OK', request_id: 'req-001' },
      });

      await client.sendEvents(makePayload());

      const body = mockPost.mock.calls[0][1] as TikTokEventsPayload;
      expect(body.event_source_id).toBe('test-event-set-id');
    });
  });
});
