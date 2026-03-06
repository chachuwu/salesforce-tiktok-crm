/**
 * Event Set Routes Tests
 *
 * Covers all 5 HTTP routes: provision, list, create, select, active.
 * Verifies correct HTTP status codes and response shapes for each
 * provision outcome (created_new, selected_existing, multiple_found, error).
 */

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { buildEventSetRouter } from '../src/event-set/event-set-routes';

const makeEventSetManager = () => ({
  provision: jest.fn(),
  list:      jest.fn(),
  create:    jest.fn(),
  select:    jest.fn(),
  resolve:   jest.fn(),
});

const makeOAuthClient = () => ({
  getValidToken: jest.fn().mockResolvedValue('test-access-token'),
});

function buildApp() {
  const mgr    = makeEventSetManager();
  const oauth  = makeOAuthClient();
  const app    = express();
  app.use(express.json());
  app.use('/event-sets', buildEventSetRouter(mgr as any, oauth as any));
  return { app, mgr, oauth };
}

const ADV = 'adv-001';
const SET = { event_set_id: 'es-001', name: 'My Set', advertiser_id: ADV, create_time: 1, update_time: 1 };

// ── POST /event-sets/:id/provision ────────────────────────────────────────────

describe('POST /event-sets/:advertiserId/provision', () => {
  it('returns 201 with created_new when a new set was auto-created', async () => {
    const { app, mgr } = buildApp();
    mgr.provision.mockResolvedValueOnce({ status: 'created_new', eventSet: SET });

    const res = await request(app).post(`/event-sets/${ADV}/provision`);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('created_new');
    expect(res.body.event_set.event_set_id).toBe('es-001');
    expect(res.body.next_step).toBeNull();
  });

  it('returns 200 with selected_existing when one set was auto-selected', async () => {
    const { app, mgr } = buildApp();
    mgr.provision.mockResolvedValueOnce({ status: 'selected_existing', eventSet: SET });

    const res = await request(app).post(`/event-sets/${ADV}/provision`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('selected_existing');
    expect(res.body.event_set.event_set_id).toBe('es-001');
  });

  it('returns 200 with multiple_found and next_step when 2+ sets exist', async () => {
    const { app, mgr } = buildApp();
    const sets = [SET, { ...SET, event_set_id: 'es-002', name: 'Set 2' }];
    mgr.provision.mockResolvedValueOnce({ status: 'multiple_found', eventSets: sets });

    const res = await request(app).post(`/event-sets/${ADV}/provision`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('multiple_found');
    expect(res.body.event_sets).toHaveLength(2);
    expect(res.body.next_step).toContain('/select');
  });

  it('returns 500 when provision returns error status', async () => {
    const { app, mgr } = buildApp();
    mgr.provision.mockResolvedValueOnce({ status: 'error', message: 'TikTok API unavailable' });

    const res = await request(app).post(`/event-sets/${ADV}/provision`);
    expect(res.status).toBe(500);
    expect(res.body.message).toContain('TikTok API unavailable');
  });

  it('returns 401 when advertiser has not completed OAuth', async () => {
    const { app, mgr, oauth } = buildApp();
    oauth.getValidToken.mockRejectedValueOnce(new Error('OAuth authorization required'));
    mgr.provision.mockResolvedValueOnce({ status: 'created_new', eventSet: SET });

    const res = await request(app).post(`/event-sets/${ADV}/provision`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('not_authorized');
  });

  it('accepts optional event_set_name in the request body', async () => {
    const { app, mgr } = buildApp();
    mgr.provision.mockResolvedValueOnce({ status: 'created_new', eventSet: SET });

    await request(app)
      .post(`/event-sets/${ADV}/provision`)
      .send({ event_set_name: 'Custom Name' });

    expect(mgr.provision).toHaveBeenCalledWith(ADV, 'test-access-token', 'Custom Name');
  });
});

// ── GET /event-sets/:advertiserId ─────────────────────────────────────────────

describe('GET /event-sets/:advertiserId', () => {
  it('returns 200 with list of event sets', async () => {
    const { app, mgr } = buildApp();
    mgr.list.mockResolvedValueOnce([SET, { ...SET, event_set_id: 'es-002' }]);

    const res = await request(app).get(`/event-sets/${ADV}`);
    expect(res.status).toBe(200);
    expect(res.body.event_sets).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(res.body.advertiser_id).toBe(ADV);
  });

  it('returns empty array when no event sets exist', async () => {
    const { app, mgr } = buildApp();
    mgr.list.mockResolvedValueOnce([]);

    const res = await request(app).get(`/event-sets/${ADV}`);
    expect(res.status).toBe(200);
    expect(res.body.event_sets).toHaveLength(0);
    expect(res.body.count).toBe(0);
  });

  it('returns 500 on API error', async () => {
    const { app, mgr } = buildApp();
    mgr.list.mockRejectedValueOnce(new Error('TikTok API down'));

    const res = await request(app).get(`/event-sets/${ADV}`);
    expect(res.status).toBe(500);
  });
});

// ── POST /event-sets/:advertiserId ────────────────────────────────────────────

describe('POST /event-sets/:advertiserId', () => {
  it('returns 201 with created set on success', async () => {
    const { app, mgr } = buildApp();
    mgr.create.mockResolvedValueOnce(SET);
    mgr.select.mockResolvedValueOnce(SET);
    // list needed by select to verify ownership
    mgr.list = jest.fn().mockResolvedValue([SET]);

    const res = await request(app)
      .post(`/event-sets/${ADV}`)
      .send({ name: 'My New Set' });

    expect(res.status).toBe(201);
    expect(res.body.event_set.event_set_id).toBe('es-001');
  });

  it('returns 400 when name is missing', async () => {
    const { app } = buildApp();
    const res = await request(app).post(`/event-sets/${ADV}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"name"');
  });

  it('returns 400 when name is empty string', async () => {
    const { app } = buildApp();
    const res = await request(app).post(`/event-sets/${ADV}`).send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});

// ── POST /event-sets/:advertiserId/select ─────────────────────────────────────

describe('POST /event-sets/:advertiserId/select', () => {
  it('returns 200 with selected event set', async () => {
    const { app, mgr } = buildApp();
    mgr.select.mockResolvedValueOnce(SET);

    const res = await request(app)
      .post(`/event-sets/${ADV}/select`)
      .send({ event_set_id: 'es-001' });

    expect(res.status).toBe(200);
    expect(res.body.event_set.event_set_id).toBe('es-001');
  });

  it('returns 400 when event_set_id is missing', async () => {
    const { app } = buildApp();
    const res = await request(app).post(`/event-sets/${ADV}/select`).send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the event set does not belong to the advertiser', async () => {
    const { app, mgr } = buildApp();
    mgr.select.mockRejectedValueOnce(new Error('Event set es-999 not found for advertiser adv-001'));

    const res = await request(app)
      .post(`/event-sets/${ADV}/select`)
      .send({ event_set_id: 'es-999' });

    expect(res.status).toBe(404);
  });
});

// ── GET /event-sets/:advertiserId/active ──────────────────────────────────────

describe('GET /event-sets/:advertiserId/active', () => {
  it('returns the resolved active event set ID', async () => {
    const { app, mgr } = buildApp();
    mgr.resolve.mockResolvedValueOnce('es-001');

    const res = await request(app).get(`/event-sets/${ADV}/active`);
    expect(res.status).toBe(200);
    expect(res.body.active_event_set_id).toBe('es-001');
    expect(res.body.advertiser_id).toBe(ADV);
  });

  it('returns 404 when no event set is configured', async () => {
    const { app, mgr } = buildApp();
    mgr.resolve.mockRejectedValueOnce(new Error('No CRM event set found for advertiser adv-001'));

    const res = await request(app).get(`/event-sets/${ADV}/active`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No active event set found');
  });
});
