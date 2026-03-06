import {
  SalesforceLead,
  CanonicalUser,
  CanonicalAttribution,
  CanonicalDevice,
  IdentitySignalQuality,
} from '../types';
import { logger } from '../logging/logger';

/**
 * Identity Enrichment Layer
 *
 * Collects all available identity signals from a Salesforce Lead record.
 *
 * Signal priority (per TikTok spec):
 *   1. tiktok_lead_id  — TikTok's own form submission ID; highest-priority 1P match
 *   2. email + phone   — standard PII match keys (hashed before sending)
 *   3. external_id     — stable cross-device identifier
 *   4. ttclid          — click-level attribution (plaintext)
 *   5. ip + user_agent — device/network fallback (plaintext)
 */
export class IdentityEnrichmentLayer {
  /**
   * Build CanonicalUser from a Salesforce Lead record.
   * Includes tiktok_lead_id from TikTok_Lead_ID__c (highest-priority match key).
   */
  static extractUser(lead: SalesforceLead): CanonicalUser {
    return {
      email:           lead.Email,
      phone:           lead.Phone,
      first_name:      lead.FirstName,
      last_name:       lead.LastName,
      city:            lead.City,
      state:           lead.State,
      zip:             lead.PostalCode,
      country:         lead.Country,
      external_id:     lead.External_Id__c,
      /**
       * TikTok's native lead form ID. Only present for leads that originated
       * from a TikTok Lead Generation campaign. Populate TikTok_Lead_ID__c in
       * Salesforce by mapping it during the TikTok → SF lead import/sync.
       */
      tiktok_lead_id:  lead.TikTok_Lead_ID__c,
    };
  }

  /** Build attribution signals (ttclid, source, campaign). */
  static extractAttribution(lead: SalesforceLead): CanonicalAttribution {
    return {
      ttclid:      lead.TTCLID__c,
      source:      lead.LeadSource,
      campaign_id: lead.Campaign__c,
    };
  }

  /** Build device signals (ip, user_agent). */
  static extractDevice(lead: SalesforceLead): CanonicalDevice {
    return {
      ip:         lead.IP_Address__c,
      user_agent: lead.User_Agent__c,
    };
  }

  /**
   * Score identity signal quality and estimate TikTok match rate.
   *
   * Scoring model:
   *   tiktok_lead_id: +40 pts  (native TikTok ID — highest-priority per spec)
   *   email:          +30 pts
   *   phone:          +20 pts
   *   ttclid:         +15 pts
   *   external_id:    +10 pts
   *   ip:             +3  pts
   *   user_agent:     +2  pts
   *
   * ≥70 pts → estimated match rate >70%
   */
  static scoreSignals(
    user: CanonicalUser,
    attribution: CanonicalAttribution,
    device: CanonicalDevice,
  ): IdentitySignalQuality {
    const hasTikTokLeadId = Boolean(user.tiktok_lead_id?.trim());
    const hasEmail        = Boolean(user.email?.trim());
    const hasPhone        = Boolean(user.phone?.trim());
    const hasTtclid       = Boolean(attribution.ttclid?.trim());
    const hasExternalId   = Boolean(user.external_id?.trim());
    const hasIp           = Boolean(device.ip?.trim());
    const hasUserAgent    = Boolean(device.user_agent?.trim());

    const score =
      (hasTikTokLeadId ? 40 : 0) +
      (hasEmail        ? 30 : 0) +
      (hasPhone        ? 20 : 0) +
      (hasTtclid       ? 15 : 0) +
      (hasExternalId   ? 10 : 0) +
      (hasIp           ? 3  : 0) +
      (hasUserAgent    ? 2  : 0);

    let estimatedMatchRate: string;
    if      (score >= 70) estimatedMatchRate = '>70%';
    else if (score >= 45) estimatedMatchRate = '40–70%';
    else if (score >= 20) estimatedMatchRate = '20–40%';
    else                  estimatedMatchRate = '<20%';

    logger.info(
      { signalScore: score, hasTikTokLeadId, hasEmail, hasPhone,
        hasTtclid, hasExternalId, hasIp, hasUserAgent, estimatedMatchRate },
      'Identity signal quality assessment',
    );

    if (score < 45) {
      logger.warn(
        { score },
        'Low identity signal quality — ensure TikTok_Lead_ID__c, email, or phone is populated',
      );
    }

    return {
      score, hasTikTokLeadId, hasEmail, hasPhone,
      hasTtclid, hasExternalId, hasIp, hasUserAgent, estimatedMatchRate,
    };
  }
}
