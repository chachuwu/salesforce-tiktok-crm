/**
 * Pipeline Integration Tests
 *
 * Tests the full orchestration flow:
 *   CDC Event → Filter → Enrich → Hash → Build → Deduplicate → Send / Enqueue
 *
 * All external dependencies (TikTok API, Redis, Postgres, BullMQ) are mocked.
 */

// ─── Mocks (must come before imports) ────────────────────────────────────────

jest.mock('../src/config/env', () => ({
  env: {
    TIKTOK_CRM_EVENT_SET_ID: 'test-event-set-id',
    TIKTOK_BATCH_SIZE: 50,
    INTEGRATION_VERSION: '1.0.0',
    TIKTOK_ACCESS_TOKEN: 'test-token',
    TIKTOK_API_BASE_URL: 'https://business-api.tiktok.com',
    TIKTOK_API_VERSION: 'v1.3',
    TIKTOK_MAX_RETRIES: 3,
    TIKTOK_INITIAL_RETRY_DELAY_MS: 100,
    TIKTOK_RATE_LIMIT_RPS: 100,
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

const mockSendEvents = jest.fn();
jest.mock('../src/clients/tiktok-api-client', () => ({
  TikTokAPIClient: jest.fn().mockImplementation(() => ({ sendEvents: mockSendEvents })),
}));

const mockIsDuplicate = jest.fn();
jest.mock('../src/deduplication/redis-dedup', () => ({
  EventDeduplicator: jest.fn().mockImplementation(() => ({ isDuplicate: mockIsDuplicate })),
}));

const mockInsert = jest.fn();
const mockUpdateStatus = jest.fn();
jest.mock('../src/db/event-log', () => ({
  EventLog: jest.fn().mockImplementation(() => ({
    insert: mockInsert,
    updateStatus: mockUpdateStatus,
  })),
}));

const mockEnqueuePayload = jest.fn();
jest.mock('../src/queue/retry-queue', () => ({
  enqueuePayload: mockEnqueuePayload,
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Pipeline } from '../src/pipeline';
import { SalesforceCDCEvent, SalesforceLead } from '../src/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCDCEvent(
  changeType: string,
  changedFields: string[] = [],
  payload: Record<string, unknown> = {},
): SalesforceCDCEvent {
  return {
    schema: 'test-schema',
    payload: {
      ChangeEventHeader: {
        changeType: changeType as 'CREATE' | 'UPDATE',
        changedFields,
        transactionKey: 'txn-abc',
        sequenceNumber: 1,
        commitTimestamp: '2024-03-15T10:00:00Z',
        commitUser: 'admin@test.com',
        commitNumber: '9999',
        entityName: 'Lead',
        recordIds: ['lead-001'],
      },
      ...payload,
    },
    event: { replayId: 100 },
  };
}

const fullLead: SalesforceLead = {
  Id: 'lead-001',
  Status: 'Qualified',
  Email: 'test@example.com',
  Phone: '5551234567',
  FirstName: 'Jane',
  LastName: 'Smith',
  Company: 'Acme Corp',
  IsConverted: false,
  CreatedDate: '2024-01-01T00:00:00Z',
  City: 'New York',
  State: 'NY',
  PostalCode: '10001',
  Country: 'US',
  TTCLID__c: 'tiktok_click_xyz',
  External_Id__c: 'ext-user-001',
  IP_Address__c: '1.2.3.4',
  User_Agent__c: 'Mozilla/5.0',
};

const tiktokSuccessResponse = {
  code: 0,
  message: 'OK',
  request_id: 'req-abc-123',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Pipeline', () => {
  let pipeline: Pipeline;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDuplicate.mockResolvedValue(false);
    mockInsert.mockResolvedValue('log-id-001');
    mockUpdateStatus.mockResolvedValue(undefined);
    mockSendEvents.mockResolvedValue(tiktokSuccessResponse);
    mockEnqueuePayload.mockResolvedValue('job-001');
    pipeline = new Pipeline();
  });

  // ── Filtering ──────────────────────────────────────────────────────────────

  describe('Event Filtering', () => {
    it('skips events that do not pass the filter', async () => {
      const cdcEvent = makeCDCEvent('UPDATE', ['Email']); // PII-only change
      await pipeline.process(cdcEvent, fullLead);
      expect(mockSendEvents).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('skips DELETE events entirely', async () => {
      const cdcEvent = makeCDCEvent('DELETE');
      await pipeline.process(cdcEvent, fullLead);
      expect(mockSendEvents).not.toHaveBeenCalled();
    });

    it('processes CREATE events', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);
      expect(mockSendEvents).toHaveBeenCalledTimes(1);
    });

    it('processes Status change events', async () => {
      const cdcEvent = makeCDCEvent('UPDATE', ['Status'], { Status: 'Qualified' });
      await pipeline.process(cdcEvent, fullLead);
      expect(mockSendEvents).toHaveBeenCalledTimes(1);
    });

    it('processes IsConverted change events', async () => {
      const cdcEvent = makeCDCEvent('UPDATE', ['IsConverted'], { IsConverted: true });
      await pipeline.process(cdcEvent, fullLead);
      expect(mockSendEvents).toHaveBeenCalledTimes(1);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  describe('Deduplication', () => {
    it('logs a duplicate event and does NOT call TikTok API', async () => {
      mockIsDuplicate.mockResolvedValue(true);
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      expect(mockSendEvents).not.toHaveBeenCalled();
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'duplicate' }),
      );
    });

    it('proceeds when event is novel', async () => {
      mockIsDuplicate.mockResolvedValue(false);
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);
      expect(mockSendEvents).toHaveBeenCalledTimes(1);
    });
  });

  // ── Happy Path ─────────────────────────────────────────────────────────────

  describe('Successful Send', () => {
    it('logs event as pending before sending', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending', leadId: 'lead-001' }),
      );
    });

    it('calls TikTok API with a valid payload structure', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      const calledPayload = mockSendEvents.mock.calls[0][0];
      expect(calledPayload.event_source).toBe('crm');
      expect(calledPayload.event_source_id).toBe('test-event-set-id');
      expect(calledPayload.data).toHaveLength(1);
      expect(calledPayload.data[0].event).toBe('SubmitForm');
    });

    it('sends hashed email (not plaintext)', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      const userData = mockSendEvents.mock.calls[0][0].data[0].user;
      // Email should be a 64-char hex hash, not the raw value
      expect(userData.email).toMatch(/^[a-f0-9]{64}$/);
      expect(userData.email).not.toBe('test@example.com');
    });

    it('sends ttclid in plaintext', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      const userData = mockSendEvents.mock.calls[0][0].data[0].user;
      expect(userData.ttclid).toBe('tiktok_click_xyz');
    });

    it('sends ip in plaintext', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      const userData = mockSendEvents.mock.calls[0][0].data[0].user;
      expect(userData.ip).toBe('1.2.3.4');
    });

    it('updates event log to sent on success', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'sent',
        tiktokSuccessResponse,
      );
    });

    it('does NOT enqueue when send succeeds', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);
      expect(mockEnqueuePayload).not.toHaveBeenCalled();
    });
  });

  // ── Failure & Retry ────────────────────────────────────────────────────────

  describe('Send Failure → Retry Queue', () => {
    beforeEach(() => {
      mockSendEvents.mockRejectedValue(new Error('TikTok API timeout'));
    });

    it('updates event log to failed on send error', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      expect(mockUpdateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        undefined,
        'TikTok API timeout',
      );
    });

    it('enqueues payload for retry on send failure', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);

      expect(mockEnqueuePayload).toHaveBeenCalledTimes(1);
      const enqueuedPayload = mockEnqueuePayload.mock.calls[0][0];
      expect(enqueuedPayload.event_source).toBe('crm');
      expect(enqueuedPayload.data).toHaveLength(1);
    });

    it('does not rethrow — pipeline is resilient to send failures', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await expect(pipeline.process(cdcEvent, fullLead)).resolves.not.toThrow();
    });
  });

  // ── Event ID Determinism ───────────────────────────────────────────────────

  describe('Event ID determinism', () => {
    it('generates the same event_id for the same lead+event type in the same second', async () => {
      const now = Math.floor(Date.now() / 1000);
      jest.spyOn(Date, 'now').mockReturnValue(now * 1000);

      const cdcEvent = makeCDCEvent('CREATE');

      // Process twice in same second
      await pipeline.process(cdcEvent, fullLead);
      const firstCallEventId = mockInsert.mock.calls[0][0].eventId;

      jest.clearAllMocks();
      mockIsDuplicate.mockResolvedValue(false);
      mockInsert.mockResolvedValue('log-id-002');
      mockSendEvents.mockResolvedValue(tiktokSuccessResponse);

      await pipeline.process(cdcEvent, fullLead);
      const secondCallEventId = mockInsert.mock.calls[0][0].eventId;

      expect(firstCallEventId).toBe(secondCallEventId);
      jest.restoreAllMocks();
    });

    it('event_id is a 64-char hex string', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, fullLead);
      const eventId = mockInsert.mock.calls[0][0].eventId;
      expect(eventId).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── Sparse Lead (missing PII) ──────────────────────────────────────────────

  describe('Sparse lead (missing identity signals)', () => {
    const sparseLead: SalesforceLead = {
      Id: 'lead-sparse',
      Status: 'New',
      IsConverted: false,
      CreatedDate: '2024-01-01T00:00:00Z',
      // No email, phone, ttclid, external_id
    };

    it('still sends event even with minimal identity data', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, sparseLead);
      expect(mockSendEvents).toHaveBeenCalledTimes(1);
    });

    it('omits undefined fields from TikTok user payload', async () => {
      const cdcEvent = makeCDCEvent('CREATE');
      await pipeline.process(cdcEvent, sparseLead);
      const userData = mockSendEvents.mock.calls[0][0].data[0].user;
      expect(userData.email).toBeUndefined();
      expect(userData.phone).toBeUndefined();
      expect(userData.ttclid).toBeUndefined();
    });
  });

  // ── Event Name Mapping ─────────────────────────────────────────────────────

  describe('Event name mapping', () => {
    it('maps CREATE → SubmitForm (TikTok standard event)', async () => {
      await pipeline.process(makeCDCEvent('CREATE'), fullLead);
      expect(mockSendEvents.mock.calls[0][0].data[0].event).toBe('SubmitForm');
    });

    it('maps Status=Qualified → CompleteRegistration (TikTok standard event)', async () => {
      await pipeline.process(
        makeCDCEvent('UPDATE', ['Status'], { Status: 'Qualified' }),
        fullLead,
      );
      expect(mockSendEvents.mock.calls[0][0].data[0].event).toBe('CompleteRegistration');
    });

    it('maps Status=Converted → Purchase (TikTok standard event)', async () => {
      await pipeline.process(
        makeCDCEvent('UPDATE', ['Status'], { Status: 'Converted' }),
        fullLead,
      );
      expect(mockSendEvents.mock.calls[0][0].data[0].event).toBe('Purchase');
    });

    it('maps IsConverted=true → Purchase (TikTok standard event)', async () => {
      await pipeline.process(
        makeCDCEvent('UPDATE', ['IsConverted'], { IsConverted: true }),
        fullLead,
      );
      expect(mockSendEvents.mock.calls[0][0].data[0].event).toBe('Purchase');
    });
  });
});
