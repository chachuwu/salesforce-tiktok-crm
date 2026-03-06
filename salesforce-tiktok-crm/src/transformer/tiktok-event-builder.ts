import {
  CanonicalEvent,
  TikTokEventsPayload,
  TikTokEventData,
  TikTokEventProperties,
  TikTokUserData,
  HashedUser,
  TikTokStandardEvent,
  EVENT_TO_DFO_STAGE,
} from '../types';
import { Hasher } from '../normalization/hasher';
import { env } from '../config/env';

/**
 * TikTok Event Builder
 *
 * Transforms CanonicalEvents into the exact POST payload required by
 * TikTok's CRM Events API v1.3 (/open_api/v1.3/event/track/).
 *
 * Key spec requirements enforced here:
 *  - event names      : TikTok standard events (SubmitForm, Contact, etc.)
 *  - user.lead_id     : TikTok native form lead ID (plaintext, highest-priority)
 *  - user.phone_number: field name is `phone_number` — NOT `phone`
 *  - user.email       : SHA-256 hashed after lowercase+trim normalisation
 *  - user.ttclid      : plaintext (not hashed)
 *  - user.ip          : plaintext (not hashed)
 *  - user.user_agent  : plaintext (not hashed)
 *  - event_time       : Unix seconds UTC from CDC commitTimestamp (not pipeline time)
 *  - properties.value : recommended for Purchase events (deal value)
 *  - properties.currency: recommended for Purchase events (ISO 4217)
 *  - properties.dfo_stage: included for observability (not sent to TikTok API)
 */
/**
 * Resolver function for the event set ID.
 *
 * When provided, the resolver is called per payload so each advertiser's
 * events are routed to their own CRM event set. Falls back to the static
 * TIKTOK_CRM_EVENT_SET_ID env var when no resolver is given.
 */
export type EventSetIdResolver = (advertiserId?: string) => Promise<string>;

export class TikTokEventBuilder {
  /**
   * Build a full TikTok Events API payload from one or more CanonicalEvents.
   *
   * @param events           One or more CanonicalEvents to include in the payload
   * @param eventSetIdOverride  Optional: pre-resolved event set ID.
   *                            Pass the result of CRMEventSetManager.resolve() here
   *                            to support per-advertiser event sets.
   *                            Falls back to TIKTOK_CRM_EVENT_SET_ID env var.
   */
  static buildPayload(events: CanonicalEvent[], eventSetIdOverride?: string): TikTokEventsPayload {
    const eventSetId = eventSetIdOverride ?? env.TIKTOK_CRM_EVENT_SET_ID ?? '';
    return {
      event_source:    'crm',
      event_source_id: eventSetId,
      data:            events.map((e) => TikTokEventBuilder.buildEventData(e)),
    };
  }

  /**
   * Build a single TikTokEventData entry.
   */
  static buildEventData(event: CanonicalEvent): TikTokEventData {
    const hashed   = Hasher.hashUser(event.user);
    const userData = TikTokEventBuilder.buildUserData(hashed, event);
    const props    = TikTokEventBuilder.buildProperties(event);

    return {
      event:      event.event_name,
      event_time: event.event_time,
      event_id:   event.event_id,
      user:       userData,
      properties: props,
    };
  }

  /**
   * Build properties object.
   *
   * TikTok recommends `currency` + `value` on Purchase events.
   * `dfo_stage` is included for internal observability only and is ignored
   * by TikTok's API (custom properties are stored but not matched against).
   */
  private static buildProperties(event: CanonicalEvent): TikTokEventProperties {
    const dfoStage = EVENT_TO_DFO_STAGE[event.event_name as TikTokStandardEvent];

    const props: TikTokEventProperties = {
      lead_status:         event.lead.status,
      source:              event.attribution.source,
      campaign_id:         event.attribution.campaign_id,
      integration_version: event.metadata.integration_version,
      ...(dfoStage !== undefined && { dfo_stage: dfoStage }),
    };

    // Revenue params — recommended by TikTok for Purchase events
    if (event.event_name === 'Purchase') {
      if (event.value    !== undefined) props.value    = event.value;
      if (event.currency !== undefined) props.currency = event.currency;
    }

    return props;
  }

  /**
   * Merge hashed PII with plaintext attribution/device signals.
   *
   * TikTok identity resolution priority (highest → lowest):
   *   1. lead_id      — TikTok's own native form ID (plaintext)
   *   2. email        — SHA-256 hashed
   *   3. phone_number — SHA-256 hashed  ← field name MUST be `phone_number`
   *   4. external_id  — SHA-256 hashed
   *   5. ttclid       — plaintext
   *   6. ip           — plaintext
   *   7. user_agent   — plaintext
   */
  private static buildUserData(
    hashed: HashedUser,
    event: CanonicalEvent,
  ): TikTokUserData {
    const userData: TikTokUserData = {};

    // Highest-priority: TikTok's native lead ID (plaintext — never hash)
    if (event.user.tiktok_lead_id) userData.lead_id      = event.user.tiktok_lead_id;

    // Hashed PII
    if (hashed.email)        userData.email        = hashed.email;
    if (hashed.phone_number) userData.phone_number = hashed.phone_number;
    if (hashed.external_id)  userData.external_id  = hashed.external_id;
    if (hashed.first_name)   userData.first_name   = hashed.first_name;
    if (hashed.last_name)    userData.last_name    = hashed.last_name;

    // Plaintext attribution/device signals
    if (event.attribution.ttclid) userData.ttclid     = event.attribution.ttclid;
    if (event.device.ip)          userData.ip         = event.device.ip;
    if (event.device.user_agent)  userData.user_agent = event.device.user_agent;

    return userData;
  }

  /**
   * Chunk CanonicalEvents into batches of at most batchSize (max 50 per TikTok spec).
   */
  static batchEvents(
    events: CanonicalEvent[],
    batchSize = env.TIKTOK_BATCH_SIZE,
  ): CanonicalEvent[][] {
    const batches: CanonicalEvent[][] = [];
    for (let i = 0; i < events.length; i += batchSize) {
      batches.push(events.slice(i, i + batchSize));
    }
    return batches;
  }
}
