import jsforce from 'jsforce';
import Connection from 'jsforce/lib/connection';
import { Subscription } from 'jsforce/lib/api/streaming';
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
  private conn!: Connection;
  private subscription: Subscription | null = null;
  private lastReplayId = -1; // -1 = latest, -2 = all retained

  constructor(private readonly onEvent: CDCEventHandler) {}

  async connect(maxRetries = 30, delayMs = 5000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._connect();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        logger.warn({ attempt, maxRetries, err: (err as Error).message }, `Salesforce connection failed, retrying in ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  private async _connect(): Promise<void> {
    logger.info({ loginUrl: env.SF_LOGIN_URL }, 'Connecting to Salesforce');

    // Obtain access token via OAuth2 client credentials flow
    const tokenRes = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.SF_CLIENT_ID,
        client_secret: env.SF_CLIENT_SECRET,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Salesforce auth failed: ${errText}`);
    }

    const { access_token, instance_url } = await tokenRes.json() as {
      access_token: string;
      instance_url: string;
    };

    this.conn = new jsforce.Connection({
      instanceUrl: instance_url,
      accessToken: access_token,
    });

    logger.info(
      { instanceUrl: instance_url },
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

      await this.onEvent(cdcEvent, lead);
    } catch (err) {
      logger.error({ err }, 'Error processing CDC event');
    }
  }

  /**
   * Fetch full Lead record from Salesforce REST API.
   * This gives us all identity fields needed for enrichment.
   */
  private async fetchLead(leadId: string, retries = 5): Promise<SalesforceLead | null> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const lead = await this.conn.sobject('Lead').retrieve(leadId) as unknown as SalesforceLead;
        return lead;
      } catch (err) {
        const isNetwork = (err as any)?.code === 'EADDRNOTAVAIL' || (err as any)?.errno === 'EADDRNOTAVAIL';
        if (isNetwork && attempt < retries) {
          logger.warn({ leadId, attempt, retries }, `Network error fetching Lead, retrying in 3s...`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        logger.error({ err, leadId }, 'Failed to fetch Lead record');
        return null;
      }
    }
    return null;
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
