import { IdentityEnrichmentLayer } from '../src/enrichment/identity-enrichment';
import { SalesforceLead } from '../src/types';

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const fullLead: SalesforceLead = {
  Id: 'lead-001',
  Status: 'Qualified',
  Email: 'john.doe@example.com',
  Phone: '5551234567',
  FirstName: 'John',
  LastName: 'Doe',
  Company: 'Acme Corp',
  Title: 'CEO',
  City: 'New York',
  State: 'NY',
  PostalCode: '10001',
  Country: 'US',
  IsConverted: false,
  CreatedDate: '2024-01-01T00:00:00Z',
  LeadSource: 'TikTok',
  Campaign__c: 'camp-001',
  TTCLID__c: 'tiktok_click_abc',
  External_Id__c: 'ext-user-001',
  IP_Address__c: '1.2.3.4',
  User_Agent__c: 'Mozilla/5.0',
};

describe('IdentityEnrichmentLayer', () => {
  describe('extractUser()', () => {
    it('extracts email correctly', () => {
      const user = IdentityEnrichmentLayer.extractUser(fullLead);
      expect(user.email).toBe('john.doe@example.com');
    });

    it('extracts phone correctly', () => {
      const user = IdentityEnrichmentLayer.extractUser(fullLead);
      expect(user.phone).toBe('5551234567');
    });

    it('extracts external_id from custom field', () => {
      const user = IdentityEnrichmentLayer.extractUser(fullLead);
      expect(user.external_id).toBe('ext-user-001');
    });

    it('extracts geo signals', () => {
      const user = IdentityEnrichmentLayer.extractUser(fullLead);
      expect(user.city).toBe('New York');
      expect(user.state).toBe('NY');
      expect(user.zip).toBe('10001');
      expect(user.country).toBe('US');
    });

    it('handles missing optional fields gracefully', () => {
      const sparse: SalesforceLead = { ...fullLead, Email: undefined, Phone: undefined };
      const user = IdentityEnrichmentLayer.extractUser(sparse);
      expect(user.email).toBeUndefined();
      expect(user.phone).toBeUndefined();
    });
  });

  describe('extractAttribution()', () => {
    it('extracts ttclid from custom field', () => {
      const attr = IdentityEnrichmentLayer.extractAttribution(fullLead);
      expect(attr.ttclid).toBe('tiktok_click_abc');
    });

    it('extracts lead source', () => {
      const attr = IdentityEnrichmentLayer.extractAttribution(fullLead);
      expect(attr.source).toBe('TikTok');
    });

    it('extracts campaign_id from custom field', () => {
      const attr = IdentityEnrichmentLayer.extractAttribution(fullLead);
      expect(attr.campaign_id).toBe('camp-001');
    });
  });

  describe('extractDevice()', () => {
    it('extracts IP address', () => {
      const device = IdentityEnrichmentLayer.extractDevice(fullLead);
      expect(device.ip).toBe('1.2.3.4');
    });

    it('extracts user agent', () => {
      const device = IdentityEnrichmentLayer.extractDevice(fullLead);
      expect(device.user_agent).toBe('Mozilla/5.0');
    });
  });

  describe('scoreSignals()', () => {
    it('returns score >70 when all primary signals present', () => {
      const user = IdentityEnrichmentLayer.extractUser(fullLead);
      const attribution = IdentityEnrichmentLayer.extractAttribution(fullLead);
      const device = IdentityEnrichmentLayer.extractDevice(fullLead);
      const quality = IdentityEnrichmentLayer.scoreSignals(user, attribution, device);
      expect(quality.score).toBeGreaterThan(70);
      expect(quality.estimatedMatchRate).toBe('>70%');
    });

    it('gives 35 pts for email only', () => {
      const user = { email: 'test@example.com' };
      const quality = IdentityEnrichmentLayer.scoreSignals(user, {}, {});
      expect(quality.score).toBe(35);
    });

    it('gives 25 pts for phone only', () => {
      const user = { phone: '5551234567' };
      const quality = IdentityEnrichmentLayer.scoreSignals(user, {}, {});
      expect(quality.score).toBe(25);
    });

    it('gives 20 pts for ttclid only', () => {
      const quality = IdentityEnrichmentLayer.scoreSignals(
        {},
        { ttclid: 'abc123' },
        {},
      );
      expect(quality.score).toBe(20);
    });

    it('returns score=0 for empty signals', () => {
      const quality = IdentityEnrichmentLayer.scoreSignals({}, {}, {});
      expect(quality.score).toBe(0);
      expect(quality.estimatedMatchRate).toBe('<20%');
    });

    it('reports booleans correctly', () => {
      const user = IdentityEnrichmentLayer.extractUser(fullLead);
      const attr = IdentityEnrichmentLayer.extractAttribution(fullLead);
      const device = IdentityEnrichmentLayer.extractDevice(fullLead);
      const quality = IdentityEnrichmentLayer.scoreSignals(user, attr, device);
      expect(quality.hasEmail).toBe(true);
      expect(quality.hasPhone).toBe(true);
      expect(quality.hasTtclid).toBe(true);
      expect(quality.hasExternalId).toBe(true);
      expect(quality.hasIp).toBe(true);
      expect(quality.hasUserAgent).toBe(true);
    });
  });
});
