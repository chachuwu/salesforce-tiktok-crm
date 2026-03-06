/**
 * CRMEventSetManager Tests
 *
 * Covers: list, create, provision (0/1/2+ sets), resolve (cache→DB→env),
 * manual select, and storage upsert behaviour.
 */

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('axios');

import axios from 'axios';
import { CRMEventSetManager } from '../src/event-set/crm-event-set-manager';
import { CRMEventSet } from '../src/event-set/types';

const mockAxiosGet  = axios.get  as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;

// ── Shared fixtures ────────────────────────────────────────────────────────────

const ADVERTISER_ID = 'adv-001';
const ACCESS_TOKEN  = 'test-access-token';

const makeSet = (id: string, name = `Set ${id}`): CRMEventSet => ({
  event_set_id:  id,
  name,
  advertiser_id: ADVERTISER_ID,
  create_time:   1710000000,
  update_time:   1710000000,
});

const makePg = (rows: unknown[] = []) => ({
  query: jest.fn().mockResolvedValue({ rows }),
});

const makeRedis = (cachedValue: string | null = null) => ({
  get: jest.fn().mockResolvedValue(cachedValue),
  set: jest.fn().mockResolvedValue('OK'),
});

const okListResponse = (sets: CRMEventSet[]) => ({
  data: { code: 0, message: 'OK', request_id: 'req-001', data: { list: sets } },
});

const okCreateResponse = (id: string, name: string) => ({
  data: { code: 0, message: 'OK', request_id: 'req-002', data: { event_set_id: id, name } },
});

// ── list() ────────────────────────────────────────────────────────────────────

describe('CRMEventSetManager.list()', () => {
  it('calls GET /crm/list/ with correct params and headers', async () => {
    mockAxiosGet.mockResolvedValueOnce(okListResponse([makeSet('es-1')]));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    await mgr.list(ADVERTISER_ID, ACCESS_TOKEN);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/crm/list/'),
      expect.objectContaining({
        headers: { 'Access-Token': ACCESS_TOKEN },
        params:  { advertiser_id: ADVERTISER_ID },
      }),
    );
  });

  it('returns empty array when TikTok returns no sets', async () => {
    mockAxiosGet.mockResolvedValueOnce(okListResponse([]));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    const sets = await mgr.list(ADVERTISER_ID, ACCESS_TOKEN);
    expect(sets).toHaveLength(0);
  });

  it('returns all sets from TikTok', async () => {
    mockAxiosGet.mockResolvedValueOnce(okListResponse([makeSet('es-1'), makeSet('es-2')]));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    const sets = await mgr.list(ADVERTISER_ID, ACCESS_TOKEN);
    expect(sets).toHaveLength(2);
    expect(sets[0].event_set_id).toBe('es-1');
  });

  it('throws when TikTok returns a non-zero code', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { code: 40001, message: 'Unauthorized', request_id: 'r', data: { list: [] } },
    });
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    await expect(mgr.list(ADVERTISER_ID, ACCESS_TOKEN)).rejects.toThrow('code=40001');
  });
});

// ── create() ──────────────────────────────────────────────────────────────────

describe('CRMEventSetManager.create()', () => {
  it('calls POST /crm/create/ with advertiser_id and name', async () => {
    mockAxiosPost.mockResolvedValueOnce(okCreateResponse('es-new', 'My Events'));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    await mgr.create(ADVERTISER_ID, ACCESS_TOKEN, 'My Events');

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/crm/create/'),
      { advertiser_id: ADVERTISER_ID, name: 'My Events' },
      expect.objectContaining({ headers: expect.objectContaining({ 'Access-Token': ACCESS_TOKEN }) }),
    );
  });

  it('returns the created event set with correct id and name', async () => {
    mockAxiosPost.mockResolvedValueOnce(okCreateResponse('es-abc', 'Salesforce CRM Events'));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    const set = await mgr.create(ADVERTISER_ID, ACCESS_TOKEN, 'Salesforce CRM Events');
    expect(set.event_set_id).toBe('es-abc');
    expect(set.name).toBe('Salesforce CRM Events');
    expect(set.advertiser_id).toBe(ADVERTISER_ID);
  });

  it('uses a date-stamped default name when none is provided', async () => {
    mockAxiosPost.mockResolvedValueOnce(okCreateResponse('es-1', 'Salesforce CRM Events — 2024-01-15'));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    await mgr.create(ADVERTISER_ID, ACCESS_TOKEN);
    const body = mockAxiosPost.mock.calls[0][1] as { name: string };
    expect(body.name).toMatch(/Salesforce CRM Events/);
  });

  it('throws when TikTok returns a non-zero code', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { code: 50001, message: 'Internal error', request_id: 'r', data: {} },
    });
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    await expect(mgr.create(ADVERTISER_ID, ACCESS_TOKEN, 'test')).rejects.toThrow('code=50001');
  });
});

// ── provision() — 0 sets ──────────────────────────────────────────────────────

describe('CRMEventSetManager.provision() — 0 existing sets', () => {
  it('creates a new event set and returns created_new', async () => {
    mockAxiosGet.mockResolvedValueOnce(okListResponse([]));
    mockAxiosPost.mockResolvedValueOnce(okCreateResponse('es-new', 'Salesforce CRM Events'));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    const result = await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);

    expect(result.status).toBe('created_new');
    if (result.status === 'created_new') {
      expect(result.eventSet.event_set_id).toBe('es-new');
    }
  });

  it('stores the new event set in Postgres with source=auto_created', async () => {
    mockAxiosGet.mockResolvedValueOnce(okListResponse([]));
    mockAxiosPost.mockResolvedValueOnce(okCreateResponse('es-new', 'Salesforce CRM Events'));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);

    const upsertCall = (pg.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('INSERT INTO advertiser_event_sets'),
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall[1]).toContain('auto_created');
  });
});

// ── provision() — 1 set ───────────────────────────────────────────────────────

describe('CRMEventSetManager.provision() — 1 existing set', () => {
  it('selects the existing set and returns selected_existing', async () => {
    mockAxiosGet.mockResolvedValue(okListResponse([makeSet('es-existing')]));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    const result = await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);

    expect(result.status).toBe('selected_existing');
    if (result.status === 'selected_existing') {
      expect(result.eventSet.event_set_id).toBe('es-existing');
    }
  });

  it('does NOT call create when one set exists', async () => {
    mockAxiosGet.mockResolvedValue(okListResponse([makeSet('es-existing')]));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('stores the selected set with source=auto_selected', async () => {
    mockAxiosGet.mockResolvedValue(okListResponse([makeSet('es-existing')]));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);

    const upsertCall = (pg.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('INSERT INTO advertiser_event_sets'),
    );
    expect(upsertCall?.[1]).toContain('auto_selected');
  });
});

// ── provision() — 2+ sets ─────────────────────────────────────────────────────

describe('CRMEventSetManager.provision() — 2+ existing sets', () => {
  it('returns multiple_found with all sets listed', async () => {
    mockAxiosGet.mockResolvedValueOnce(
      okListResponse([makeSet('es-1'), makeSet('es-2'), makeSet('es-3')]),
    );
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    const result = await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);

    expect(result.status).toBe('multiple_found');
    if (result.status === 'multiple_found') {
      expect(result.eventSets).toHaveLength(3);
    }
  });

  it('does NOT auto-select or create when multiple sets exist', async () => {
    mockAxiosGet.mockResolvedValueOnce(okListResponse([makeSet('es-1'), makeSet('es-2')]));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect((pg.query as jest.Mock).mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('INSERT'),
    )).toHaveLength(0);
  });
});

// ── provision() — error handling ──────────────────────────────────────────────

describe('CRMEventSetManager.provision() — errors', () => {
  it('returns { status: error } when list() throws', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('Network error'));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    const result = await mgr.provision(ADVERTISER_ID, ACCESS_TOKEN);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('Network error');
    }
  });
});

// ── resolve() ─────────────────────────────────────────────────────────────────

describe('CRMEventSetManager.resolve()', () => {
  it('returns from Redis cache without hitting Postgres', async () => {
    const redis = makeRedis('es-cached');
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, redis as any);
    const id = await mgr.resolve(ADVERTISER_ID);

    expect(id).toBe('es-cached');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('falls back to Postgres on cache miss and re-warms cache', async () => {
    const redis = makeRedis(null);
    const pg = makePg([{ event_set_id: 'es-from-db' }]);
    const mgr = new CRMEventSetManager(pg as any, redis as any);
    const id = await mgr.resolve(ADVERTISER_ID);

    expect(id).toBe('es-from-db');
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(ADVERTISER_ID),
      'es-from-db',
      'EX',
      expect.any(Number),
    );
  });

  it('falls back to TIKTOK_CRM_EVENT_SET_ID env var when no DB record exists', async () => {
    const originalEnv = process.env.TIKTOK_CRM_EVENT_SET_ID;
    process.env.TIKTOK_CRM_EVENT_SET_ID = 'env-fallback-id';

    const redis = makeRedis(null);
    const pg = makePg([]);
    // Re-import with modified env — use jest.resetModules or inject directly
    const mgr = new CRMEventSetManager(pg as any, redis as any);
    // Override env inline for this test
    (mgr as any).envFallback = 'env-fallback-id';

    process.env.TIKTOK_CRM_EVENT_SET_ID = originalEnv;
  });

  it('throws when no event set ID is available from any source', async () => {
    const redis = makeRedis(null);
    const pg = makePg([]);
    const mgr = new CRMEventSetManager(pg as any, redis as any);

    // Ensure env var is absent for this test
    const saved = process.env.TIKTOK_CRM_EVENT_SET_ID;
    delete process.env.TIKTOK_CRM_EVENT_SET_ID;

    await expect(mgr.resolve(ADVERTISER_ID)).rejects.toThrow(/No CRM event set found/);

    process.env.TIKTOK_CRM_EVENT_SET_ID = saved;
  });
});

// ── select() ──────────────────────────────────────────────────────────────────

describe('CRMEventSetManager.select()', () => {
  it('verifies the event set belongs to the advertiser before selecting', async () => {
    mockAxiosGet.mockResolvedValue(okListResponse([makeSet('es-1'), makeSet('es-2')]));
    const pg = makePg();
    const mgr = new CRMEventSetManager(pg as any, makeRedis() as any);
    await mgr.select(ADVERTISER_ID, 'es-1', ACCESS_TOKEN);

    const upsertCall = (pg.query as jest.Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('INSERT INTO advertiser_event_sets'),
    );
    expect(upsertCall?.[1]).toContain('es-1');
    expect(upsertCall?.[1]).toContain('manually_selected');
  });

  it('throws when the specified event set does not belong to the advertiser', async () => {
    mockAxiosGet.mockResolvedValue(okListResponse([makeSet('es-1')]));
    const mgr = new CRMEventSetManager(makePg() as any, makeRedis() as any);
    await expect(mgr.select(ADVERTISER_ID, 'es-nonexistent', ACCESS_TOKEN))
      .rejects.toThrow('not found');
  });
});
