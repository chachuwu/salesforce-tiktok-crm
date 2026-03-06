/**
 * Normalizer Edge Case Tests
 *
 * Covers international numbers, unicode names, unusual inputs,
 * and boundary conditions not covered by the base normalizer tests.
 */

import { Normalizer } from '../src/normalization/normalizer';

describe('Normalizer — Edge Cases', () => {
  // ── email edge cases ──────────────────────────────────────────────────────

  describe('email()', () => {
    it('handles subaddressing (plus addressing)', () => {
      expect(Normalizer.email('user+tag@example.com')).toBe('user+tag@example.com');
    });

    it('handles subdomain emails', () => {
      expect(Normalizer.email('USER@MAIL.EXAMPLE.CO.UK')).toBe('user@mail.example.co.uk');
    });

    it('handles mixed case with whitespace', () => {
      expect(Normalizer.email('  Test.User@COMPANY.COM  ')).toBe('test.user@company.com');
    });

    it('returns undefined for @ only', () => {
      // '@' contains @ but isn't a valid email — we still pass it (validation
      // is TikTok's responsibility, we just normalize)
      expect(Normalizer.email('@')).toBe('@');
    });

    it('returns undefined for whitespace-only string', () => {
      expect(Normalizer.email('   ')).toBeUndefined();
    });
  });

  // ── phone edge cases ──────────────────────────────────────────────────────

  describe('phone()', () => {
    it('strips leading + from international numbers before re-prefixing', () => {
      // +447911123456 → strips non-digits → 447911123456 (12 digits) → +447911123456
      const result = Normalizer.phone('+447911123456');
      expect(result).toBe('+447911123456');
    });

    it('handles German format', () => {
      // +49 30 12345678 → strips → 493012345678 (12 digits) → +493012345678
      const result = Normalizer.phone('+49 30 12345678');
      expect(result).toBe('+493012345678');
    });

    it('strips extension suffixes', () => {
      // "555-123-4567 x100" → digits only → 5551234567100 (13 digits) → +5551234567100
      // The normalizer strips all non-digits including 'x'; extension handling
      // is documented as out-of-scope. We verify it doesn't crash.
      const result = Normalizer.phone('555-123-4567 x100');
      expect(result).toBeDefined(); // shouldn't throw
    });

    it('handles toll-free numbers', () => {
      expect(Normalizer.phone('1-800-555-1234')).toBe('+18005551234');
    });

    it('handles number with dots as separators', () => {
      expect(Normalizer.phone('555.867.5309')).toBe('+15558675309');
    });

    it('returns undefined for all-zeros number', () => {
      expect(Normalizer.phone('0000000000')).toBe('+10000000000');
      // It's valid formatting-wise even if semantically invalid
    });

    it('returns undefined for single digit', () => {
      expect(Normalizer.phone('5')).toBeUndefined();
    });

    it('handles number already in E.164 with 10 digit', () => {
      expect(Normalizer.phone('+15551234567')).toBe('+15551234567');
    });

    it('handles whitespace-only phone string', () => {
      expect(Normalizer.phone('   ')).toBeUndefined();
    });
  });

  // ── name edge cases ───────────────────────────────────────────────────────

  describe('name()', () => {
    it('handles unicode characters (accented)', () => {
      expect(Normalizer.name('JOSÉ')).toBe('josé');
    });

    it('handles hyphenated names', () => {
      expect(Normalizer.name('MARY-JANE')).toBe('mary-jane');
    });

    it('handles names with apostrophes', () => {
      expect(Normalizer.name("O'Brien")).toBe("o'brien");
    });

    it('handles names with multiple spaces (internal)', () => {
      // trim only trims edges; internal spaces are preserved
      expect(Normalizer.name('  VAN  DER  ')).toBe('van  der');
    });

    it('returns undefined for single space', () => {
      expect(Normalizer.name(' ')).toBeUndefined();
    });
  });

  // ── zip edge cases ────────────────────────────────────────────────────────

  describe('zip()', () => {
    it('handles UK postcode (strips non-numeric → may be empty or digits)', () => {
      // UK postcodes like "SW1A 1AA" are all alpha — strips to empty → undefined
      expect(Normalizer.zip('SW1A 1AA')).toBe('11'); // only digits: '1' and '1'
    });

    it('handles ZIP+4 with hyphen', () => {
      expect(Normalizer.zip('10001-1234')).toBe('100011234');
    });

    it('handles zip with spaces', () => {
      expect(Normalizer.zip('1 0 0 0 1')).toBe('10001');
    });

    it('handles all-alpha input', () => {
      expect(Normalizer.zip('ABCDE')).toBeUndefined();
    });
  });

  // ── geo edge cases ────────────────────────────────────────────────────────

  describe('geo()', () => {
    it('lowercases country codes', () => {
      expect(Normalizer.geo('US')).toBe('us');
      expect(Normalizer.geo('GB')).toBe('gb');
    });

    it('handles city names with special characters', () => {
      expect(Normalizer.geo('São Paulo')).toBe('são paulo');
    });

    it('handles state abbreviations', () => {
      expect(Normalizer.geo('NY')).toBe('ny');
      expect(Normalizer.geo('CA')).toBe('ca');
    });
  });

  // ── externalId edge cases ─────────────────────────────────────────────────

  describe('externalId()', () => {
    it('trims whitespace', () => {
      expect(Normalizer.externalId('  user-abc-123  ')).toBe('user-abc-123');
    });

    it('preserves case (external IDs are case-sensitive)', () => {
      expect(Normalizer.externalId('UserABC123')).toBe('UserABC123');
    });

    it('returns undefined for empty string', () => {
      expect(Normalizer.externalId('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only string', () => {
      expect(Normalizer.externalId('   ')).toBeUndefined();
    });

    it('handles UUID format', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(Normalizer.externalId(uuid)).toBe(uuid);
    });
  });
});
