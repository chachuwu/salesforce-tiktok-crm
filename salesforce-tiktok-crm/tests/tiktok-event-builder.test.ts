/**
 * TikTokEventBuilder Tests — Updated for Standard Events + DFO Stage
 */

jest.mock('../src/config/env', () => ({
  env: { TIKTOK_CRM_EVENT_SET_ID: 'test-event-set', TIKTOK_BATCH_SIZE: 50 },
}));

import { TikTokEventBuilder } from '../src/transformer/tiktok-event-builder';
import { CanonicalEvent } from '../src/types';

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    event_id:     'event-001',
    event_name:   'SubmitForm',
    event_time:   1710000000,
    event_source: 'crm',
    lead:         { lead_id: 'lead-001', status: 'new' },
    user:         { email: 'test@example.com', phone: '5551234567', tiktok_lead_id: 'tt-lead-id-001' },
    attribution:  { ttclid: 'click-abc', source: 'tiktok' },
    device:       { ip: '1.2.3.4', user_agent: 'Mozilla/5.0' },
    metadata:     { salesforce_object: 'Lead', integration_version: '1.0.0' },
    ...overrides,
  };
}

describe('TikTokEventBuilder', () => {

  // ── Payload structure ──────────────────────────────────────────────────────

  describe('buildPayload()', () => {
    it('sets event_source to crm', () => {
      expect(TikTokEventBuilder.buildPayload([makeEvent()]).event_source).toBe('crm');
    });

    it('sets event_source_id from env', () => {
      expect(TikTokEventBuilder.buildPayload([makeEvent()]).event_source_id).toBe('test-event-set');
    });

    it('includes one data entry per event', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent(), makeEvent({ event_id: 'event-002' })]);
      expect(payload.data).toHaveLength(2);
    });
  });

  // ── Standard event names ───────────────────────────────────────────────────

  describe('Standard event names', () => {
    it.each([
      'SubmitForm', 'Contact', 'Schedule', 'CompleteRegistration',
      'SubmitApplication', 'ApplicationApproval', 'Purchase', 'Subscribe', 'StartTrial',
    ] as const)('correctly passes %s event name to API payload', (eventName) => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: eventName })]);
      expect(payload.data[0].event).toBe(eventName);
    });
  });

  // ── DFO stage in properties ────────────────────────────────────────────────

  describe('DFO stage in properties', () => {
    it('SubmitForm → dfo_stage: 1', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'SubmitForm' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(1);
    });

    it('Contact → dfo_stage: 2', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'Contact' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(2);
    });

    it('Schedule → dfo_stage: 2', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'Schedule' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(2);
    });

    it('CompleteRegistration → dfo_stage: 3', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'CompleteRegistration' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(3);
    });

    it('SubmitApplication → dfo_stage: 3', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'SubmitApplication' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(3);
    });

    it('Purchase → dfo_stage: 4', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'Purchase' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(4);
    });

    it('ApplicationApproval → dfo_stage: 4', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'ApplicationApproval' })]);
      expect(payload.data[0].properties?.dfo_stage).toBe(4);
    });
  });

  // ── Purchase properties ────────────────────────────────────────────────────

  describe('Purchase event — value and currency', () => {
    it('includes value and currency when provided', () => {
      const event = makeEvent({ event_name: 'Purchase', value: 5000, currency: 'USD' });
      const payload = TikTokEventBuilder.buildPayload([event]);
      expect(payload.data[0].properties?.value).toBe(5000);
      expect(payload.data[0].properties?.currency).toBe('USD');
    });

    it('omits value/currency when not provided on Purchase', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent({ event_name: 'Purchase' })]);
      expect(payload.data[0].properties?.value).toBeUndefined();
      expect(payload.data[0].properties?.currency).toBeUndefined();
    });

    it('does not include value/currency on non-Purchase events', () => {
      const event = makeEvent({ event_name: 'SubmitForm', value: 999, currency: 'USD' });
      const payload = TikTokEventBuilder.buildPayload([event]);
      expect(payload.data[0].properties?.value).toBeUndefined();
      expect(payload.data[0].properties?.currency).toBeUndefined();
    });
  });

  // ── Identity fields ────────────────────────────────────────────────────────

  describe('Identity field handling', () => {
    it('sends TikTok lead_id as plaintext (highest-priority signal)', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent()]);
      expect(payload.data[0].user.lead_id).toBe('tt-lead-id-001');
    });

    it('hashes email (64-char hex)', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent()]);
      expect(payload.data[0].user.email).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.data[0].user.email).not.toBe('test@example.com');
    });

    it('uses phone_number field name (not phone)', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent()]);
      expect(payload.data[0].user.phone_number).toBeDefined();
      expect((payload.data[0].user as Record<string, unknown>).phone).toBeUndefined();
    });

    it('sends ttclid as plaintext', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent()]);
      expect(payload.data[0].user.ttclid).toBe('click-abc');
    });

    it('sends ip as plaintext', () => {
      const payload = TikTokEventBuilder.buildPayload([makeEvent()]);
      expect(payload.data[0].user.ip).toBe('1.2.3.4');
    });
  });

  // ── Batching ───────────────────────────────────────────────────────────────

  describe('batchEvents()', () => {
    it('splits 55 events into [50, 5]', () => {
      const events = Array.from({ length: 55 }, (_, i) => makeEvent({ event_id: `e-${i}` }));
      const batches = TikTokEventBuilder.batchEvents(events, 50);
      expect(batches).toHaveLength(2);
      expect(batches[0]).toHaveLength(50);
      expect(batches[1]).toHaveLength(5);
    });

    it('returns single batch for ≤50 events', () => {
      const events = Array.from({ length: 10 }, (_, i) => makeEvent({ event_id: `e-${i}` }));
      expect(TikTokEventBuilder.batchEvents(events, 50)).toHaveLength(1);
    });
  });
});
