/**
 * Match Rate Optimization Tests
 *
 * Validates the identity signal scoring model that drives match rate estimates.
 * The system must achieve a score ≥ 70 when the four key signals are present:
 *   email (+35) + phone (+25) + ttclid (+20) = 80 pts → >70% match rate
 *
 * These tests encode the business contract on match rate optimization.
 */

jest.mock('../src/logging/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { IdentityEnrichmentLayer } from '../src/enrichment/identity-enrichment';
import { CanonicalUser, CanonicalAttribution, CanonicalDevice } from '../src/types';

type ScoreInput = {
  user?: CanonicalUser;
  attribution?: CanonicalAttribution;
  device?: CanonicalDevice;
};

function score({ user = {}, attribution = {}, device = {} }: ScoreInput) {
  return IdentityEnrichmentLayer.scoreSignals(user, attribution, device);
}

describe('Match Rate Scoring', () => {
  // ── Core threshold ─────────────────────────────────────────────────────────

  describe('>70% match rate threshold', () => {
    it('achieves >70% with email + phone + ttclid (80 pts)', () => {
      const quality = score({
        user: { email: 'test@example.com', phone: '5551234567' },
        attribution: { ttclid: 'click-abc' },
      });
      expect(quality.score).toBeGreaterThanOrEqual(70);
      expect(quality.estimatedMatchRate).toBe('>70%');
    });

    it('achieves >70% with all four primary signals (90 pts)', () => {
      const quality = score({
        user: {
          email: 'test@example.com',
          phone: '5551234567',
          external_id: 'ext-001',
        },
        attribution: { ttclid: 'click-abc' },
      });
      expect(quality.score).toBe(90);
      expect(quality.estimatedMatchRate).toBe('>70%');
    });

    it('achieves maximum 100 pts with all signals', () => {
      const quality = score({
        user: {
          email: 'test@example.com',
          phone: '5551234567',
          external_id: 'ext-001',
        },
        attribution: { ttclid: 'click-abc' },
        device: { ip: '1.2.3.4', user_agent: 'Mozilla/5.0' },
      });
      expect(quality.score).toBe(100);
    });
  });

  // ── Individual signal weights ──────────────────────────────────────────────

  describe('Individual signal weights', () => {
    it('email alone = 35 pts', () => {
      const q = score({ user: { email: 'x@y.com' } });
      expect(q.score).toBe(35);
    });

    it('phone alone = 25 pts', () => {
      const q = score({ user: { phone: '5551234567' } });
      expect(q.score).toBe(25);
    });

    it('ttclid alone = 20 pts', () => {
      const q = score({ attribution: { ttclid: 'abc' } });
      expect(q.score).toBe(20);
    });

    it('external_id alone = 10 pts', () => {
      const q = score({ user: { external_id: 'ext-001' } });
      expect(q.score).toBe(10);
    });

    it('ip alone = 5 pts', () => {
      const q = score({ device: { ip: '1.2.3.4' } });
      expect(q.score).toBe(5);
    });

    it('user_agent alone = 5 pts', () => {
      const q = score({ device: { user_agent: 'Mozilla' } });
      expect(q.score).toBe(5);
    });

    it('no signals = 0 pts', () => {
      const q = score({});
      expect(q.score).toBe(0);
    });
  });

  // ── Match rate buckets ─────────────────────────────────────────────────────

  describe('Match rate estimate buckets', () => {
    it('"<20%" for score 0–19', () => {
      const q = score({ device: { ip: '1.2.3.4' } }); // 5 pts
      expect(q.estimatedMatchRate).toBe('<20%');
    });

    it('"20–40%" for score 20–44', () => {
      const q = score({ attribution: { ttclid: 'abc' }, device: { ip: '1.2.3.4' } }); // 25 pts
      expect(q.estimatedMatchRate).toBe('20–40%');
    });

    it('"40–70%" for score 45–69', () => {
      const q = score({ user: { email: 'x@y.com' }, device: { ip: '1.2.3.4', user_agent: 'Mozilla' } }); // 45 pts
      expect(q.estimatedMatchRate).toBe('40–70%');
    });

    it('">70%" for score 70+', () => {
      const q = score({ user: { email: 'x@y.com', phone: '5551234567' }, attribution: { ttclid: 'abc' } }); // 80 pts
      expect(q.estimatedMatchRate).toBe('>70%');
    });
  });

  // ── Boolean signal flags ───────────────────────────────────────────────────

  describe('Signal presence flags', () => {
    it('all flags false for empty signals', () => {
      const q = score({});
      expect(q.hasEmail).toBe(false);
      expect(q.hasPhone).toBe(false);
      expect(q.hasTtclid).toBe(false);
      expect(q.hasExternalId).toBe(false);
      expect(q.hasIp).toBe(false);
      expect(q.hasUserAgent).toBe(false);
    });

    it('correct flags for partial signals', () => {
      const q = score({
        user: { email: 'x@y.com', external_id: 'ext-001' },
        device: { ip: '1.2.3.4' },
      });
      expect(q.hasEmail).toBe(true);
      expect(q.hasPhone).toBe(false);
      expect(q.hasTtclid).toBe(false);
      expect(q.hasExternalId).toBe(true);
      expect(q.hasIp).toBe(true);
      expect(q.hasUserAgent).toBe(false);
    });

    it('treats whitespace-only strings as missing', () => {
      const q = score({ user: { email: '   ', phone: '' } });
      expect(q.hasEmail).toBe(false);
      expect(q.hasPhone).toBe(false);
    });
  });

  // ── Additive scoring (no double-counting) ──────────────────────────────────

  describe('Score additivity', () => {
    it('duplicate signal types do not double-count', () => {
      // Having two emails isn't possible in the schema, but city/state won't
      // add to the score since they're not weighted signals
      const q = score({
        user: {
          email: 'x@y.com',
          city: 'NYC',
          state: 'NY',
          country: 'US',
        },
      });
      // Only email adds to score (35), geo fields are not weighted
      expect(q.score).toBe(35);
    });
  });
});
