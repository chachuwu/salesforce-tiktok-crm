/**
 * Normalization Engine
 *
 * All PII fields MUST be normalized before hashing.
 * Rules sourced from TikTok Events API docs and industry CRM→Ads standards.
 */

export class Normalizer {
  /**
   * Email: trim + lowercase
   */
  static email(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    // Basic sanity check
    return normalized.includes('@') ? normalized : undefined;
  }

  /**
   * Phone: remove all non-digit chars, then format to E.164 (+1XXXXXXXXXX).
   * Defaults country code to +1 (US) if absent.
   */
  static phone(raw: string | undefined, defaultCountryCode = '1'): string | undefined {
    if (!raw) return undefined;
    // Strip everything non-numeric
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 0) return undefined;

    // Already has country code (10-digit US → 11 with leading 1)
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }
    if (digits.length === 10) {
      return `+${defaultCountryCode}${digits}`;
    }
    // International numbers: just prefix +
    if (digits.length > 10) {
      return `+${digits}`;
    }
    return undefined; // too short to be valid
  }

  /**
   * Name fields: trim + lowercase
   */
  static name(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
  }

  /**
   * Zip: strip all non-numeric characters
   */
  static zip(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const digits = raw.replace(/\D/g, '');
    return digits.length > 0 ? digits : undefined;
  }

  /**
   * City / State / Country: trim + lowercase
   */
  static geo(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
  }

  /**
   * External ID: trim
   */
  static externalId(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
}
