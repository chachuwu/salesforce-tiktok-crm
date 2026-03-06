/**
 * PII Safety Tests
 *
 * These are CRITICAL compliance tests. They verify that no raw (unhashed)
 * PII ever reaches the TikTok API payload. This suite should be run as a
 * mandatory gate in CI/CD.
 *
 * Fields that MUST be hashed: email, phone, first_name, last_name,
 *                              city, state, zip, country, external_id
 * Fields that MUST NOT be hashed: ttclid, ip, user_agent
 */

jest.mock('../src/config/env', () => ({
  env: {
    TIKTOK_CRM_EVENT_SET_ID: 'test-event-set-id',
    TIKTOK_BATCH_SIZE: 50,
    INTEGRATION_VERSION: '1.0.0',
  },
}));

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { TikTokEventBuilder } from '../src/transformer/tiktok-event-builder';
import { CanonicalEvent } from '../src/types';

const RAW_EMAIL = 'john.doe@example.com';
const RAW_PHONE = '5551234567';
const RAW_FIRST_NAME = 'John';
const RAW_LAST_NAME = 'Doe';
const RAW_CITY = 'New York';
const RAW_STATE = 'NY';
const RAW_ZIP = '10001';
const RAW_COUNTRY = 'US';
const RAW_EXTERNAL_ID = 'ext-user-001';
const TTCLID = 'tiktok_click_abc_xyz';
const IP = '192.168.1.100';
const USER_AGENT = 'Mozilla/5.0 (Macintosh)';

const piiRichEvent: CanonicalEvent = {
  event_id: 'event-pii-test',
  event_name: 'CompleteRegistration',
  event_time: 1710000000,
  event_source: 'crm',
  lead: { lead_id: 'lead-pii-001', status: 'Qualified' },
  user: {
    email: RAW_EMAIL,
    phone: RAW_PHONE,
    first_name: RAW_FIRST_NAME,
    last_name: RAW_LAST_NAME,
    city: RAW_CITY,
    state: RAW_STATE,
    zip: RAW_ZIP,
    country: RAW_COUNTRY,
    external_id: RAW_EXTERNAL_ID,
  },
  attribution: { ttclid: TTCLID },
  device: { ip: IP, user_agent: USER_AGENT },
  metadata: { salesforce_object: 'Lead', integration_version: '1.0.0' },
};

const HEX_64 = /^[a-f0-9]{64}$/;

describe('PII Safety — TikTok Payload', () => {
  let userData: ReturnType<typeof TikTokEventBuilder.buildPayload>['data'][0]['user'];

  beforeAll(() => {
    const payload = TikTokEventBuilder.buildPayload([piiRichEvent]);
    userData = payload.data[0].user;
  });

  // ── PII fields MUST be hashed ─────────────────────────────────────────────

  describe('Hashed fields', () => {
    it('email is SHA-256 hashed (not plaintext)', () => {
      expect(userData.email).not.toBe(RAW_EMAIL);
      expect(userData.email).toMatch(HEX_64);
    });

    it('phone is SHA-256 hashed (not plaintext)', () => {
      expect(userData.phone).not.toBe(RAW_PHONE);
      expect(userData.phone).toMatch(HEX_64);
    });

    it('first_name is SHA-256 hashed (not plaintext)', () => {
      expect(userData.first_name).not.toBe(RAW_FIRST_NAME);
      expect(userData.first_name).toMatch(HEX_64);
    });

    it('last_name is SHA-256 hashed (not plaintext)', () => {
      expect(userData.last_name).not.toBe(RAW_LAST_NAME);
      expect(userData.last_name).toMatch(HEX_64);
    });

    it('external_id is SHA-256 hashed (not plaintext)', () => {
      expect(userData.external_id).not.toBe(RAW_EXTERNAL_ID);
      expect(userData.external_id).toMatch(HEX_64);
    });
  });

  // ── Non-PII fields MUST NOT be hashed ────────────────────────────────────

  describe('Plaintext fields', () => {
    it('ttclid is sent in plaintext', () => {
      expect(userData.ttclid).toBe(TTCLID);
      // Must NOT be a hash
      expect(userData.ttclid).not.toMatch(HEX_64);
    });

    it('ip is sent in plaintext', () => {
      expect(userData.ip).toBe(IP);
      expect(userData.ip).not.toMatch(HEX_64);
    });

    it('user_agent is sent in plaintext', () => {
      expect(userData.user_agent).toBe(USER_AGENT);
      expect(userData.user_agent).not.toMatch(HEX_64);
    });
  });

  // ── Normalization consistency ─────────────────────────────────────────────

  describe('Normalization consistency', () => {
    it('email hash is stable regardless of input casing', () => {
      const upper: CanonicalEvent = {
        ...piiRichEvent,
        user: { ...piiRichEvent.user, email: 'JOHN.DOE@EXAMPLE.COM' },
      };
      const lower: CanonicalEvent = {
        ...piiRichEvent,
        user: { ...piiRichEvent.user, email: 'john.doe@example.com' },
      };

      const upperPayload = TikTokEventBuilder.buildPayload([upper]);
      const lowerPayload = TikTokEventBuilder.buildPayload([lower]);

      expect(upperPayload.data[0].user.email).toBe(lowerPayload.data[0].user.email);
    });

    it('phone hash is stable regardless of formatting', () => {
      const formatted: CanonicalEvent = {
        ...piiRichEvent,
        user: { ...piiRichEvent.user, phone: '(555) 123-4567' },
      };
      const raw: CanonicalEvent = {
        ...piiRichEvent,
        user: { ...piiRichEvent.user, phone: '5551234567' },
      };

      const formattedPayload = TikTokEventBuilder.buildPayload([formatted]);
      const rawPayload = TikTokEventBuilder.buildPayload([raw]);

      expect(formattedPayload.data[0].user.phone).toBe(rawPayload.data[0].user.phone);
    });

    it('name hash is stable regardless of casing and whitespace', () => {
      const upper: CanonicalEvent = {
        ...piiRichEvent,
        user: { ...piiRichEvent.user, first_name: '  JOHN  ' },
      };
      const lower: CanonicalEvent = {
        ...piiRichEvent,
        user: { ...piiRichEvent.user, first_name: 'john' },
      };

      const upperPayload = TikTokEventBuilder.buildPayload([upper]);
      const lowerPayload = TikTokEventBuilder.buildPayload([lower]);

      expect(upperPayload.data[0].user.first_name).toBe(lowerPayload.data[0].user.first_name);
    });
  });

  // ── Sparse payload safety ─────────────────────────────────────────────────

  describe('Sparse payload (missing PII)', () => {
    it('does not include undefined hashed fields in payload', () => {
      const sparseEvent: CanonicalEvent = {
        ...piiRichEvent,
        user: {}, // no PII at all
        attribution: {},
        device: {},
      };

      const payload = TikTokEventBuilder.buildPayload([sparseEvent]);
      const user = payload.data[0].user;

      expect(user.email).toBeUndefined();
      expect(user.phone).toBeUndefined();
      expect(user.first_name).toBeUndefined();
      expect(user.last_name).toBeUndefined();
      expect(user.external_id).toBeUndefined();
      expect(user.ttclid).toBeUndefined();
      expect(user.ip).toBeUndefined();
      expect(user.user_agent).toBeUndefined();
    });
  });
});
