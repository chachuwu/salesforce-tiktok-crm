/**
 * EventLog Tests
 *
 * Tests all Postgres interactions for the event audit log:
 * - insert() with correct SQL and params
 * - updateStatus() with correct SQL and params
 * - findByLeadId() returns mapped rows
 * - ON CONFLICT DO NOTHING for idempotent inserts
 */

jest.mock('../src/config/env', () => ({
  env: {
    POSTGRES_HOST: 'localhost',
    POSTGRES_PORT: 5432,
    POSTGRES_DB: 'crm_events_test',
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: 'test',
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockRelease = jest.fn();
const mockPoolOn = jest.fn();
const mockEnd = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: mockQuery,
    connect: mockConnect,
    on: mockPoolOn,
    end: mockEnd,
  })),
}));

import { EventLog } from '../src/db/event-log';
import { TikTokEventsPayload } from '../src/types';

const testPayload: TikTokEventsPayload = {
  event_source: 'crm',
  event_source_id: 'test-event-set-id',
  data: [
    {
      event: 'LeadCreated',
      event_time: 1710000000,
      event_id: 'event-001',
      user: { email: 'a'.repeat(64) },
    },
  ],
};

describe('EventLog', () => {
  let eventLog: EventLog;

  beforeEach(() => {
    jest.clearAllMocks();
    eventLog = new EventLog();
  });

  // ── insert ─────────────────────────────────────────────────────────────────

  describe('insert()', () => {
    it('executes INSERT with correct parameters', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'uuid-001' }] });

      await eventLog.insert({
        eventId: 'event-001',
        eventName: 'LeadCreated',
        leadId: 'lead-001',
        salesforceReplayId: 42,
        tiktokPayload: testPayload,
        status: 'pending',
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];

      expect(sql).toMatch(/INSERT INTO crm_event_log/i);
      expect(params).toContain('event-001');    // eventId
      expect(params).toContain('LeadCreated');  // eventName
      expect(params).toContain('lead-001');      // leadId
      expect(params).toContain(42);             // replayId
      expect(params).toContain('pending');       // status
    });

    it('serializes tiktokPayload as JSON string', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await eventLog.insert({
        eventId: 'event-002',
        eventName: 'LeadQualified',
        leadId: 'lead-002',
        salesforceReplayId: 99,
        tiktokPayload: testPayload,
        status: 'pending',
      });

      const params = mockQuery.mock.calls[0][1] as unknown[];
      const payloadParam = params.find((p) => typeof p === 'string' && p.includes('event_source'));
      expect(payloadParam).toBeDefined();
      expect(JSON.parse(payloadParam as string)).toMatchObject({ event_source: 'crm' });
    });

    it('uses ON CONFLICT DO NOTHING for idempotency', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await eventLog.insert({
        eventId: 'dupe-event',
        eventName: 'LeadCreated',
        leadId: 'lead-dupe',
        salesforceReplayId: 1,
        tiktokPayload: testPayload,
        status: 'duplicate',
      });

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
    });

    it('returns the generated id', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'generated-uuid' }] });

      const id = await eventLog.insert({
        eventId: 'event-003',
        eventName: 'LeadConverted',
        leadId: 'lead-003',
        salesforceReplayId: 10,
        tiktokPayload: testPayload,
        status: 'pending',
      });

      // The UUID returned is our own generated v4, not the pg response
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  // ── updateStatus ───────────────────────────────────────────────────────────

  describe('updateStatus()', () => {
    it('executes UPDATE with correct event_id and status', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await eventLog.updateStatus('event-001', 'sent', {
        code: 0,
        message: 'OK',
        request_id: 'req-001',
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE crm_event_log/i);
      expect(params).toContain('event-001');
      expect(params).toContain('sent');
    });

    it('serializes TikTok response as JSON', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const response = { code: 0, message: 'OK', request_id: 'req-002' };
      await eventLog.updateStatus('event-001', 'sent', response);

      const params = mockQuery.mock.calls[0][1] as unknown[];
      const responseParam = params.find(
        (p) => typeof p === 'string' && p.includes('request_id'),
      );
      expect(responseParam).toBeDefined();
      expect(JSON.parse(responseParam as string).request_id).toBe('req-002');
    });

    it('sets error field when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await eventLog.updateStatus('event-001', 'failed', undefined, 'Connection timeout');

      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('Connection timeout');
    });

    it('sets response to null when not provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await eventLog.updateStatus('event-001', 'failed');

      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain(null);
    });
  });

  // ── findByLeadId ───────────────────────────────────────────────────────────

  describe('findByLeadId()', () => {
    it('queries by lead_id', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await eventLog.findByLeadId('lead-001');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE lead_id = \$1/i);
      expect(params).toContain('lead-001');
    });

    it('returns all rows for a given lead', async () => {
      const mockRows = [
        { id: 'row-1', event_id: 'event-001', status: 'sent' },
        { id: 'row-2', event_id: 'event-002', status: 'failed' },
      ];
      mockQuery.mockResolvedValue({ rows: mockRows });

      const rows = await eventLog.findByLeadId('lead-001');
      expect(rows).toHaveLength(2);
      expect(rows[0].event_id).toBe('event-001');
      expect(rows[1].event_id).toBe('event-002');
    });

    it('returns empty array when no events found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const rows = await eventLog.findByLeadId('lead-unknown');
      expect(rows).toEqual([]);
    });
  });

  // ── withTransaction ────────────────────────────────────────────────────────

  describe('withTransaction()', () => {
    it('commits on success', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: mockRelease,
      };
      mockConnect.mockResolvedValue(mockClient);

      await eventLog.withTransaction(async (client) => {
        await client.query('SELECT 1');
        return 'ok';
      });

      const queries = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain('BEGIN');
      expect(queries).toContain('COMMIT');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('rolls back on error', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: mockRelease,
      };
      mockConnect.mockResolvedValue(mockClient);

      await expect(
        eventLog.withTransaction(async () => {
          throw new Error('Something went wrong');
        }),
      ).rejects.toThrow('Something went wrong');

      const queries = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain('BEGIN');
      expect(queries).toContain('ROLLBACK');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  // ── disconnect ─────────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('ends the pool', async () => {
      await eventLog.disconnect();
      expect(mockEnd).toHaveBeenCalledTimes(1);
    });
  });
});
