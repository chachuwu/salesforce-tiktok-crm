import { createHash } from 'crypto';
import { Hasher } from '../src/normalization/hasher';
import { CanonicalUser } from '../src/types';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('Hasher', () => {
  describe('sha256()', () => {
    it('returns hex SHA-256 of a known string', () => {
      // SHA-256("hello") = well-known value
      expect(Hasher.sha256('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('returns undefined for undefined input', () => {
      expect(Hasher.sha256(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(Hasher.sha256('')).toBeUndefined();
    });

    it('is deterministic', () => {
      const value = 'test@example.com';
      expect(Hasher.sha256(value)).toBe(Hasher.sha256(value));
    });
  });

  describe('eventId()', () => {
    it('generates deterministic event ID from composite key', () => {
      const id1 = Hasher.eventId('lead-1', 'LeadCreated', 1710000000);
      const id2 = Hasher.eventId('lead-1', 'LeadCreated', 1710000000);
      expect(id1).toBe(id2);
    });

    it('generates different IDs for different event types', () => {
      const id1 = Hasher.eventId('lead-1', 'LeadCreated', 1710000000);
      const id2 = Hasher.eventId('lead-1', 'LeadQualified', 1710000000);
      expect(id1).not.toBe(id2);
    });

    it('generates different IDs for different timestamps', () => {
      const id1 = Hasher.eventId('lead-1', 'LeadCreated', 1710000000);
      const id2 = Hasher.eventId('lead-1', 'LeadCreated', 1710000001);
      expect(id1).not.toBe(id2);
    });

    it('returns a 64-char hex string', () => {
      const id = Hasher.eventId('lead-1', 'LeadConverted', 1710000000);
      expect(id).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('hashUser()', () => {
    const user: CanonicalUser = {
      email: '  USER@Example.com  ',
      phone: '(555) 123-4567',
      first_name: '  JOHN  ',
      last_name: '  DOE  ',
      city: 'New York',
      state: 'NY',
      zip: '10001-1234',
      country: 'US',
      external_id: 'ext-abc-123',
    };

    it('hashes email after normalization', () => {
      const hashed = Hasher.hashUser(user);
      expect(hashed.email).toBe(sha256('user@example.com'));
    });

    it('hashes phone after E.164 normalization', () => {
      const hashed = Hasher.hashUser(user);
      expect(hashed.phone_number).toBe(sha256('+15551234567'));
    });

    it('hashes first_name after lowercase+trim', () => {
      const hashed = Hasher.hashUser(user);
      expect(hashed.first_name).toBe(sha256('john'));
    });

    it('hashes last_name after lowercase+trim', () => {
      const hashed = Hasher.hashUser(user);
      expect(hashed.last_name).toBe(sha256('doe'));
    });

    it('hashes zip after stripping non-numeric', () => {
      const hashed = Hasher.hashUser(user);
      expect(hashed.zip).toBe(sha256('100011234'));
    });

    it('hashes country after lowercase', () => {
      const hashed = Hasher.hashUser(user);
      expect(hashed.country).toBe(sha256('us'));
    });

    it('returns undefined for missing fields', () => {
      const sparse: CanonicalUser = {};
      const hashed = Hasher.hashUser(sparse);
      expect(hashed.email).toBeUndefined();
      expect(hashed.phone_number).toBeUndefined();
      expect(hashed.external_id).toBeUndefined();
    });

    it('all hashed values are 64-char hex strings', () => {
      const hashed = Hasher.hashUser(user);
      for (const val of Object.values(hashed)) {
        if (val !== undefined) {
          expect(val).toMatch(/^[a-f0-9]{64}$/);
        }
      }
    });
  });
});
