import {
  SalesforceCDCEvent,
  SalesforceLead,
  CanonicalEvent,
  TikTokEventName,
} from './types';
import { EventFilter } from './filters/event-filter';
import { IdentityEnrichmentLayer } from './enrichment/identity-enrichment';
import { Hasher } from './normalization/hasher';
import { TikTokEventBuilder } from './transformer/tiktok-event-builder';
import { TikTokAPIClient } from './clients/tiktok-api-client';
import { EventDeduplicator } from './deduplication/redis-dedup';
import { EventLog } from './db/event-log';
import { enqueuePayload } from './queue/retry-queue';
import { logger } from './logging/logger';
import { env } from './config/env';
import { CRMEventSetManager } from './event-set/crm-event-set-manager';

/**
 * Central Pipeline
 *
 * Orchestrates the full flow:
 *   CDC Event → Filter → Enrich → Normalize/Hash → Build → Deduplicate → Send
 *
 * Event set resolution order per-event:
 *   1. CRMEventSetManager.resolve(advertiserId)  — per-advertiser, Redis-cached
 *   2. TIKTOK_CRM_EVENT_SET_ID env var           — global fallback
 */
export class Pipeline {
  private readonly tiktokClient: TikTokAPIClient;
  private readonly deduplicator: EventDeduplicator;
  private readonly eventLog: EventLog;
  private readonly eventSetManager: CRMEventSetManager | null;

  constructor(eventSetManager?: CRMEventSetManager) {
    this.tiktokClient = new TikTokAPIClient();
    this.deduplicator = new EventDeduplicator();
    this.eventLog = new EventLog();
    // If no manager is injected (e.g. tests), fall back to env var
    this.eventSetManager = eventSetManager ?? null;
  }

  /**
   * Main entry point — called by the CDC listener for every incoming event.
   */
  async process(cdcEvent: SalesforceCDCEvent, lead: SalesforceLead): Promise<void> {
    const replayId = cdcEvent.event.replayId;
    const leadId = lead.Id;

    // ── 1. FILTER ──────────────────────────────────────────────────────────────
    const filterResult = EventFilter.evaluate(cdcEvent);

    if (!filterResult.shouldProcess) {
      logger.debug(
        { leadId, reason: filterResult.reason },
        'Event filtered out — skipping',
      );
      return;
    }

    const eventName = filterResult.eventType as TikTokEventName;
    logger.info({ leadId, eventName, replayId }, 'Event passed filter — processing');

    // ── 2. ENRICH ─────────────────────────────────────────────────────────────
    const user = IdentityEnrichmentLayer.extractUser(lead);
    const attribution = IdentityEnrichmentLayer.extractAttribution(lead);
    const device = IdentityEnrichmentLayer.extractDevice(lead);

    IdentityEnrichmentLayer.scoreSignals(user, attribution, device);

    // ── 3. RESOLVE EVENT SET ID ───────────────────────────────────────────────
    //
    // Attempt to resolve a per-advertiser event set ID using the lead's
    // attribution data. Falls back transparently to the env var if the
    // manager is unavailable or no record is stored yet.
    //
    // The advertiser ID here comes from the TTCLID attribution chain
    // (the advertiser whose TikTok ad generated this lead). In practice
    // for single-advertiser deployments this will always be the same value.
    const advertiserId = attribution.campaign_id
      ? await this.resolveAdvertiserId(attribution.campaign_id)
      : undefined;

    let eventSetId: string | undefined;
    if (this.eventSetManager && advertiserId) {
      try {
        eventSetId = await this.eventSetManager.resolve(advertiserId);
      } catch (err) {
        logger.warn(
          { leadId, advertiserId, err },
          'Could not resolve per-advertiser event set — falling back to env var',
        );
      }
    }

    // ── 4. BUILD CANONICAL EVENT ──────────────────────────────────────────────
    /**
     * event_time: TikTok spec requires "when the status actually changed in
     * the CRM" in GMT/UTC seconds — NOT the current pipeline time.
     * We use the CDC header's commitTimestamp which Salesforce sets at the
     * moment it commits the DML transaction.
     *
     * Fallback to Date.now() only if commitTimestamp is absent (should never
     * happen with a properly configured Salesforce CDC channel).
     */
    const commitTs = cdcEvent.payload.ChangeEventHeader.commitTimestamp;
    const eventTime = commitTs
      ? Math.floor(new Date(commitTs).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    if (!commitTs) {
      logger.warn({ leadId }, 'commitTimestamp missing — falling back to pipeline time for event_time');
    }

    const eventId = Hasher.eventId(leadId, eventName, eventTime);

    const canonical: CanonicalEvent = {
      event_id:     eventId,
      event_name:   eventName,
      event_time:   eventTime,
      event_source: 'crm',
      lead: {
        lead_id:      leadId,
        status:       lead.Status,
        created_at:   lead.CreatedDate,
        converted_at: lead.ConvertedDate,
      },
      user,
      attribution,
      device,
      metadata: {
        salesforce_object:   'Lead',
        integration_version: env.INTEGRATION_VERSION,
      },
    };

    // ── 5. DEDUPLICATE ────────────────────────────────────────────────────────
    const isDuplicate = await this.deduplicator.isDuplicate(eventId);
    if (isDuplicate) {
      await this.eventLog.insert({
        eventId,
        eventName,
        leadId,
        salesforceReplayId: replayId,
        tiktokPayload: TikTokEventBuilder.buildPayload([canonical], eventSetId),
        status: 'duplicate',
      });
      return;
    }

    // ── 6. TRANSFORM → TIKTOK PAYLOAD ────────────────────────────────────────
    const payload = TikTokEventBuilder.buildPayload([canonical], eventSetId);

    // ── 7. LOG AS PENDING ────────────────────────────────────────────────────
    await this.eventLog.insert({
      eventId,
      eventName,
      leadId,
      salesforceReplayId: replayId,
      tiktokPayload: payload,
      status: 'pending',
    });

    // ── 8. SEND OR ENQUEUE ───────────────────────────────────────────────────
    try {
      const response = await this.tiktokClient.sendEvents(payload);

      await this.eventLog.updateStatus(eventId, 'sent', response);

      logger.info(
        { eventId, eventName, leadId, requestId: response.request_id },
        'Event successfully sent to TikTok',
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      logger.warn(
        { eventId, leadId, error },
        'Direct send failed — enqueueing for retry',
      );

      await this.eventLog.updateStatus(eventId, 'failed', undefined, error);
      await enqueuePayload(payload);
    }
  }

  /**
   * Derive the TikTok advertiser ID from the lead's campaign attribution.
   * In single-advertiser deployments this always returns the same value.
   * In multi-advertiser setups the campaign_id encodes the advertiser.
   *
   * Override this in a subclass if your Salesforce data stores
   * the advertiser ID explicitly (e.g. in a custom Lead field).
   */
  protected async resolveAdvertiserId(campaignId: string): Promise<string | undefined> {
    // Default: campaign_id IS the advertiser_id (simplest deployment model).
    // Replace with a DB lookup if your campaigns are mapped to advertiser IDs.
    return campaignId || undefined;
  }
}
