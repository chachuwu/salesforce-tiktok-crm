import { Pool, PoolClient } from 'pg';
import { EventLogRecord, EventLogStatus, TikTokEventsPayload, TikTokAPIResponse } from '../types';
import { env } from '../config/env';
import { logger } from '../logging/logger';
import { v4 as uuidv4 } from 'uuid';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      database: env.POSTGRES_DB,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected Postgres pool error');
    });
  }
  return pool;
}

/**
 * Event Log — persists all events to Postgres for audit, analytics, and replay.
 */
export class EventLog {
  private pool: Pool;

  constructor() {
    this.pool = getPool();
  }

  /**
   * Insert a new event log entry.
   */
  async insert(params: {
    eventId: string;
    eventName: string;
    leadId: string;
    salesforceReplayId: number;
    tiktokPayload: TikTokEventsPayload;
    status: EventLogStatus;
  }): Promise<string> {
    const id = uuidv4();
    const sql = `
      INSERT INTO crm_event_log (
        id, event_id, event_name, lead_id, salesforce_replay_id,
        tiktok_payload, status, attempt_count, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW())
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
    `;

    await this.pool.query(sql, [
      id,
      params.eventId,
      params.eventName,
      params.leadId,
      params.salesforceReplayId,
      JSON.stringify(params.tiktokPayload),
      params.status,
    ]);

    return id;
  }

  /**
   * Update an event log entry with the TikTok API response.
   */
  async updateStatus(
    eventId: string,
    status: EventLogStatus,
    response?: TikTokAPIResponse,
    error?: string,
  ): Promise<void> {
    const sql = `
      UPDATE crm_event_log
      SET status = $2,
          tiktok_response = $3,
          error = $4,
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE event_id = $1
    `;

    await this.pool.query(sql, [
      eventId,
      status,
      response ? JSON.stringify(response) : null,
      error ?? null,
    ]);
  }

  /**
   * Fetch event log entries for a given lead.
   */
  async findByLeadId(leadId: string): Promise<EventLogRecord[]> {
    const result = await this.pool.query<EventLogRecord>(
      'SELECT * FROM crm_event_log WHERE lead_id = $1 ORDER BY created_at DESC',
      [leadId],
    );
    return result.rows;
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }
}
