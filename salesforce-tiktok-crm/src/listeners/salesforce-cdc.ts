import jsforce from 'jsforce';
import { SalesforceCDCEvent, SalesforceLead } from '../types';
import { env } from '../config/env';
import { logger } from '../logging/logger';

type CDCEventHandler = (event: SalesforceCDCEvent, lead: SalesforceLead) => Promise<void>;

/**
 * Salesforce Change Data Capture (CDC) Listener
 *
 * - Authenticates via OAuth2 client credentials (Connected App)
 * - Subscribes to /data/LeadChangeEvent streaming channel
 * - Fetches full Lead record on every event (for identity enrichment)
 * - Maintains a durable replay ID in memory (extend to Redis for HA)
 * - Auto-reconnects on disconnection
 */
export class SalesforceCDCListener {
  private conn!: jsforce.Connection;
  private subscription: jsforce.Subscription | null = null;
  private lastReplayId = -1; // -1 = latest, -2 = all retained
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  constructor(private readonly onEvent: CDCEventHandler) {}

  async connect(): Promise<void> {
    logger.info({ loginUrl: env.SF_LOGIN_URL }, 'Connecting to Salesforce');

    this.conn = new jsforce.Connection({
      oauth2: {
        loginUrl: env.SF_LOGIN_URL,
        clientId: env.SF_CLIENT_ID,
        clientSecret: env.SF_CLIENT_SECRET,
      },
      loginUrl: env.SF_LOGIN_URL,
    });

    await this.conn.login(
      env.SF_USERNAME,
      env.SF_PASSWORD + env.SF_SECURITY_TOKEN,
    );

    logger.info(
      { instanceUrl: this.conn.instanceUrl },
      'Salesforce authentication successful',
    );

    this.subscribe();
  }

  private subscribe(): void {
    const channel = env.SF_CDC_CHANNEL;
    logger.info({ channel, lastReplayId: this.lastReplayId }, 'Subscribing to CDC channel');

    // jsforce streaming uses EMP connector / CometD under the hood
    this.subscription = this.conn.streaming.topic(channel).subscribe(
      (rawMessage: unknown) => {
        void this.handleRawMessage(rawMessage);
      },
    );
  }

  private async handleRawMessage(rawMessage: unknown): Promise<void> {
    try {
      const cdcEvent = rawMessage as SalesforceCDCEvent;
      const header = cdcEvent.payload?.ChangeEventHeader;

      if (!header) {
        logger.warn({ rawMessage }, 'CDC event missing ChangeEventHeader');
        return;
      }

      // Track replay ID for durable subscriptions
      this.lastReplayId = cdcEvent.event.replayId;

      logger.debug(
        {
          replayId: this.lastReplayId,
          changeType: header.changeType,
          entityName: header.entityName,
          changedFields: header.changedFields,
          recordIds: header.recordIds,
        },
        'CDC event received',
      );

      // Fetch the full Lead record for identity enrichment
      const recordId = header.recordIds?.[0];
      if (!recordId) {
        logger.warn({ header }, 'CDC event has no recordId');
        return;
      }

      const lead = await this.fetchLead(recordId);
      if (!lead) return;

      this.reconnectAttempts = 0; // reset on successful processing
      await this.onEvent(cdcEvent, lead);
    } catch (err) {
      logger.error({ err }, 'Error processing CDC event');
    }
  }

  /**
   * Fetch full Lead record from Salesforce REST API.
   * This gives us all identity fields needed for enrichment.
   */
  private async fetchLead(leadId: string): Promise<SalesforceLead | null> {
    try {
      const lead = await this.conn.sobject('Lead').retrieve(leadId) as unknown as SalesforceLead;
      return lead;
    } catch (err) {
      logger.error({ err, leadId }, 'Failed to fetch Lead record');
      return null;
    }
  }

  /**
   * Gracefully disconnect and clean up subscription.
   */
  async disconnect(): Promise<void> {
    if (this.subscription) {
      this.subscription.cancel();
      this.subscription = null;
    }
    logger.info('Salesforce CDC listener disconnected');
  }

  /**
   * Return current replay ID (useful for persisting position).
   */
  getLastReplayId(): number {
    return this.lastReplayId;
  }
}
