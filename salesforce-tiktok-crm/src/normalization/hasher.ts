import { createHash } from 'crypto';
import { CanonicalUser, HashedUser } from '../types';
import { Normalizer } from './normalizer';

/**
 * Hashing Engine
 *
 * All PII must be normalized THEN hashed with SHA-256 before sending to TikTok.
 * Fields NOT hashed (sent plaintext per spec): ttclid, ip, user_agent, lead_id.
 */
export class Hasher {
  /**
   * SHA-256 hash of a normalized string value.
   * Returns undefined if input is empty/undefined.
   */
  static sha256(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * Deterministic event ID from composite key.
   * Prevents duplicate conversions under retries.
   */
  static eventId(leadId: string, eventType: string, eventTimestamp: number): string {
    return createHash('sha256')
      .update(`${leadId}:${eventType}:${eventTimestamp}`)
      .digest('hex');
  }

  /**
   * Normalize + SHA-256 hash a full CanonicalUser.
   *
   * NOTE: The output field for phone is `phone_number` — this is the field
   * name required by TikTok's CRM Events API. Sending as `phone` causes
   * silent match failures.
   */
  static hashUser(user: CanonicalUser): HashedUser {
    return {
      email:        Hasher.sha256(Normalizer.email(user.email)),
      phone_number: Hasher.sha256(Normalizer.phone(user.phone)),  // field name: phone_number
      first_name:   Hasher.sha256(Normalizer.nameField(user.first_name)),
      last_name:    Hasher.sha256(Normalizer.nameField(user.last_name)),
      city:         Hasher.sha256(Normalizer.geo(user.city)),
      state:        Hasher.sha256(Normalizer.geo(user.state)),
      zip:          Hasher.sha256(Normalizer.zip(user.zip)),
      country:      Hasher.sha256(Normalizer.geo(user.country)),
      external_id:  Hasher.sha256(Normalizer.externalId(user.external_id)),
    };
  }
}
