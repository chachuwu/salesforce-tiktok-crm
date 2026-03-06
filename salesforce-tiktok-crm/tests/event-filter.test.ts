/**
 * EventFilter Tests — Updated for TikTok Standard Events
 *
 * Verifies every Salesforce Lead status and CDC change type maps to the
 * correct TikTok standard event and DFO funnel stage.
 */

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { EventFilter, STATUS_TO_EVENT } from '../src/filters/event-filter';
import { SalesforceCDCEvent } from '../src/types';

function makeEvent(
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
        transactionKey: 'txn-001',
        sequenceNumber: 1,
        commitTimestamp: '2024-03-15T10:00:00Z',
        commitUser: 'admin@test.com',
        commitNumber: '1234',
        entityName: 'Lead',
        recordIds: ['lead-001'],
      },
      ...payload,
    },
    event: { replayId: 1 },
  };
}

describe('EventFilter — Standard Event Mapping', () => {

  // ── Stage 1: SubmitForm ────────────────────────────────────────────────────

  describe('Stage 1 — SubmitForm (Lead Captured)', () => {
    it('maps CREATE → SubmitForm', () => {
      const r = EventFilter.evaluate(makeEvent('CREATE'));
      expect(r.shouldProcess).toBe(true);
      expect(r.eventType).toBe('SubmitForm');
    });

    it.each(['new', 'open', 'open - not contacted', 'not contacted', 'pending', 'fresh'])(
      'maps status "%s" → SubmitForm',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('SubmitForm');
      },
    );
  });

  // ── Stage 2a: Contact ──────────────────────────────────────────────────────

  describe('Stage 2a — Contact (Outreach Attempt)', () => {
    it.each(['contacted', 'attempted to contact', 'working', 'working - contacted',
             'in progress', 'follow up', 'follow-up', 'nurturing', 'reconnect'])(
      'maps status "%s" → Contact',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('Contact');
      },
    );
  });

  // ── Stage 2b: Schedule ────────────────────────────────────────────────────

  describe('Stage 2b — Schedule (Appointment Booked)', () => {
    it.each(['demo scheduled', 'meeting scheduled', 'appointment scheduled',
             'appointment booked', 'call scheduled', 'demo booked'])(
      'maps status "%s" → Schedule (not Contact)',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('Schedule');
        expect(r.eventType).not.toBe('Contact'); // previously incorrectly Contact
      },
    );
  });

  // ── Stage 3a: CompleteRegistration ─────────────────────────────────────────

  describe('Stage 3a — CompleteRegistration (MQL)', () => {
    it.each(['qualified', 'marketing qualified', 'mql', 'interested', 'review'])(
      'maps status "%s" → CompleteRegistration',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('CompleteRegistration');
      },
    );
  });

  // ── Stage 3b: SubmitApplication ────────────────────────────────────────────

  describe('Stage 3b — SubmitApplication (SQL / Proposal)', () => {
    it.each(['sales qualified', 'sql', 'opportunity', 'proposal sent',
             'proposal', 'negotiation', 'application submitted', 'applied'])(
      'maps status "%s" → SubmitApplication',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('SubmitApplication');
      },
    );
  });

  // ── Stage 4a: Purchase ─────────────────────────────────────────────────────

  describe('Stage 4a — Purchase (Closed / Won / Terminal)', () => {
    it.each(['converted', 'closed - converted', 'closed', 'closed won', 'won',
             'sale', 'customer', 'unqualified', 'junk lead', 'lost', 'disqualified',
             'inactive', 'recycled', 'closed - not interested'])(
      'maps status "%s" → Purchase',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('Purchase');
      },
    );

    it('maps IsConverted=true → Purchase (not a custom event)', () => {
      const r = EventFilter.evaluate(makeEvent('UPDATE', ['IsConverted'], { IsConverted: true }));
      expect(r.shouldProcess).toBe(true);
      expect(r.eventType).toBe('Purchase');
    });
  });

  // ── Stage 4b: ApplicationApproval ─────────────────────────────────────────

  describe('Stage 4b — ApplicationApproval', () => {
    it.each(['approved', 'application approved', 'credit approved', 'accepted'])(
      'maps status "%s" → ApplicationApproval',
      (status) => {
        const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
        expect(r.shouldProcess).toBe(true);
        expect(r.eventType).toBe('ApplicationApproval');
      },
    );
  });

  // ── Stage 4c: Subscribe / StartTrial ──────────────────────────────────────

  describe('Stage 4c — Subscribe / StartTrial', () => {
    it.each(['subscribed', 'subscription started'])('maps status "%s" → Subscribe', (status) => {
      const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
      expect(r.shouldProcess).toBe(true);
      expect(r.eventType).toBe('Subscribe');
    });

    it.each(['trial', 'trial started', 'free trial'])('maps status "%s" → StartTrial', (status) => {
      const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: status }));
      expect(r.shouldProcess).toBe(true);
      expect(r.eventType).toBe('StartTrial');
    });
  });

  // ── No custom event names emitted ─────────────────────────────────────────

  describe('Standard events only — no legacy custom names emitted', () => {
    const legacyNames = ['LeadCreated', 'LeadContacted', 'LeadQualified', 'LeadConverted'];

    it('CREATE does not emit a legacy custom event name', () => {
      const r = EventFilter.evaluate(makeEvent('CREATE'));
      expect(legacyNames).not.toContain(r.eventType);
    });

    it('no STATUS_TO_EVENT value is a legacy custom event name', () => {
      for (const [status, event] of Object.entries(STATUS_TO_EVENT)) {
        expect(legacyNames).not.toContain(event);
      }
    });
  });

  // ── Normalisation ──────────────────────────────────────────────────────────

  describe('Case / whitespace normalisation', () => {
    it('normalises UPPERCASE status to lowercase before lookup', () => {
      const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: 'QUALIFIED' }));
      expect(r.shouldProcess).toBe(true);
      expect(r.eventType).toBe('CompleteRegistration');
    });

    it('trims whitespace from status', () => {
      const r = EventFilter.evaluate(makeEvent('UPDATE', ['Status'], { Status: '  won  ' }));
      expect(r.shouldProcess).toBe(true);
      expect(r.eventType).toBe('Purchase');
    });
  });

  // ── Filtering ─────────────────────────────────────────────────────────────

  describe('Filtered events', () => {
    it('returns shouldProcess=false for PII-only updates', () => {
      const r = EventFilter.evaluate(makeEvent('UPDATE', ['Email', 'Phone']));
      expect(r.shouldProcess).toBe(false);
    });

    it('returns shouldProcess=false for DELETE events', () => {
      const r = EventFilter.evaluate(makeEvent('DELETE'));
      expect(r.shouldProcess).toBe(false);
    });

    it('returns shouldProcess=false for non-Lead entities', () => {
      const cdcEvent = makeEvent('CREATE');
      cdcEvent.payload.ChangeEventHeader.entityName = 'Contact';
      const r = EventFilter.evaluate(cdcEvent);
      expect(r.shouldProcess).toBe(false);
    });

    it('returns shouldProcess=false for unknown status with warning', () => {
      const r = EventFilter.evaluate(
        makeEvent('UPDATE', ['Status'], { Status: 'totally_unknown_status_xyz' }),
      );
      expect(r.shouldProcess).toBe(false);
    });
  });
});
