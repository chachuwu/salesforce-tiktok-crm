import { Normalizer } from '../src/normalization/normalizer';

describe('Normalizer', () => {
  // ── email ─────────────────────────────────────────────────────────────────
  describe('email()', () => {
    it('trims whitespace and lowercases', () => {
      expect(Normalizer.email('  USER@EXAMPLE.COM  ')).toBe('user@example.com');
    });

    it('returns undefined for empty string', () => {
      expect(Normalizer.email('')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(Normalizer.email(undefined)).toBeUndefined();
    });

    it('returns undefined for string without @', () => {
      expect(Normalizer.email('notanemail')).toBeUndefined();
    });

    it('handles already-lowercase emails', () => {
      expect(Normalizer.email('test@domain.io')).toBe('test@domain.io');
    });
  });

  // ── phone ─────────────────────────────────────────────────────────────────
  describe('phone()', () => {
    it('converts 10-digit US number to E.164', () => {
      expect(Normalizer.phone('5551234567')).toBe('+15551234567');
    });

    it('strips dashes, parens, and spaces', () => {
      expect(Normalizer.phone('(555) 123-4567')).toBe('+15551234567');
    });

    it('strips dots', () => {
      expect(Normalizer.phone('555.123.4567')).toBe('+15551234567');
    });

    it('handles already-E164 with leading 1', () => {
      expect(Normalizer.phone('+15551234567')).toBe('+15551234567');
    });

    it('handles 11-digit with leading 1', () => {
      expect(Normalizer.phone('15551234567')).toBe('+15551234567');
    });

    it('returns undefined for too-short number', () => {
      expect(Normalizer.phone('555')).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(Normalizer.phone(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(Normalizer.phone('')).toBeUndefined();
    });

    it('preserves international numbers', () => {
      const result = Normalizer.phone('+447911123456');
      expect(result).toBe('+447911123456');
    });
  });

  // ── name ─────────────────────────────────────────────────────────────────
  describe('name()', () => {
    it('trims and lowercases', () => {
      expect(Normalizer.name('  JOHN  ')).toBe('john');
    });

    it('returns undefined for empty string after trim', () => {
      expect(Normalizer.name('   ')).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(Normalizer.name(undefined)).toBeUndefined();
    });
  });

  // ── zip ───────────────────────────────────────────────────────────────────
  describe('zip()', () => {
    it('strips non-numeric characters', () => {
      expect(Normalizer.zip('10001-1234')).toBe('100011234');
    });

    it('returns plain numeric zip unchanged', () => {
      expect(Normalizer.zip('10001')).toBe('10001');
    });

    it('returns undefined for undefined', () => {
      expect(Normalizer.zip(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(Normalizer.zip('')).toBeUndefined();
    });
  });

  // ── geo ───────────────────────────────────────────────────────────────────
  describe('geo()', () => {
    it('trims and lowercases', () => {
      expect(Normalizer.geo('  New York  ')).toBe('new york');
    });

    it('returns undefined for empty string', () => {
      expect(Normalizer.geo('')).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(Normalizer.geo(undefined)).toBeUndefined();
    });
  });
});
