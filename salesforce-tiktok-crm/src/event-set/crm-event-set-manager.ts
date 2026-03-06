import axios from 'axios';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  CRMEventSet,
  CRMListResponse,
  CRMCreateResponse,
  AdvertiserEventSet,
  ProvisionResult,
} from './types';
import { env } from '../config/env';
import { logger } from '../logging/logger';

const EVENT_SET_CACHE_PREFIX = 'tiktok:event_set:';
const EVENT_SET_CACHE_TTL = 3600; // 1 hour — event set IDs rarely change

/**
 * CRM Event Set Manager
 *
 * Handles the full lifecycle of CRM Event Sets for each TikTok advertiser:
 *
 *   1. list()      — GET /open_api/v1.3/crm/list/
 *                    Retrieve all existing CRM event sets for an advertiser
 *
 *   2. create()    — POST /open_api/v1.3/crm/create/
 *                    Programmatically create a new CRM event set
 *                    (ref: TikTok API doc id=1858830704718658)
 *
 *   3. provision() — Called automatically after OAuth completes.
 *                    • If 0 event sets exist  → create one automatically
 *                    • If 1 event set exists  → select it automatically
 *                    • If 2+ event sets exist → surface them for manual selection
 *
 *   4. resolve()   — Hot-path method called by TikTokEventBuilder on every
 *                    event. Returns the event set ID for a given advertiser
 *                    from Redis cache → Postgres → env fallback.
 *
 * This removes the manual "copy Event Set ID from TikTok Events Manager and
 * paste into .env" step from the advertiser onboarding flow.
 */
export class CRMEventSetManager {
  private readonly baseUrl: string;

  constructor(
    private readonly pg: Pool,
    private readonly redis: Redis,
  ) {
    this.baseUrl = `${env.TIKTOK_API_BASE_URL}/open_api/${env.TIKTOK_API_VERSION}`;
  }

  // ── 1. List existing CRM event sets ────────────────────────────────────────

  /**
   * Retrieve all CRM event sets for an advertiser.
   *
   * GET /open_api/v1.3/crm/list/
   * Query params: advertiser_id
   * Header: Access-Token
   */
  async list(advertiserId: string, accessToken: string): Promise<CRMEventSet[]> {
    logger.info({ advertiserId }, 'Listing CRM event sets');

    const response = await axios.get<CRMListResponse>(
      `${this.baseUrl}/crm/list/`,
      {
        headers: { 'Access-Token': accessToken },
        params: { advertiser_id: advertiserId },
      },
    );

    this.assertSuccess(response.data, 'CRM event set list');

    const sets = response.data.data?.list ?? [];
    logger.info({ advertiserId, count: sets.length }, 'CRM event sets retrieved');
    return sets;
  }

  // ── 2. Create a new CRM event set ──────────────────────────────────────────

  /**
   * Programmatically create a new CRM event set for an advertiser.
   *
   * POST /open_api/v1.3/crm/create/
   * Body: { advertiser_id, name }
   * Header: Access-Token
   *
   * The created event set ID is immediately stored in Postgres + Redis
   * so it can be resolved on subsequent requests without manual config.
   */
  async create(
    advertiserId: string,
    accessToken: string,
    name = `Salesforce CRM Events — ${new Date().toISOString().slice(0, 10)}`,
  ): Promise<CRMEventSet> {
    logger.info({ advertiserId, name }, 'Creating CRM event set');

    const response = await axios.post<CRMCreateResponse>(
      `${this.baseUrl}/crm/create/`,
      { advertiser_id: advertiserId, name },
      { headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' } },
    );

    this.assertSuccess(response.data, 'CRM event set create');

    const created: CRMEventSet = {
      event_set_id: response.data.data.event_set_id,
      name: response.data.data.name,
      advertiser_id: advertiserId,
      create_time: Math.floor(Date.now() / 1000),
      update_time: Math.floor(Date.now() / 1000),
    };

    logger.info(
      { advertiserId, eventSetId: created.event_set_id, name: created.name },
      'CRM event set created successfully',
    );

    return created;
  }

  // ── 3. Provision — called automatically after OAuth ─────────────────────────

  /**
   * Automatic event set provisioning — called once per advertiser after OAuth
   * completes. Implements the check-then-create-or-select logic:
   *
   *   0 existing → create a new one automatically, store it
   *   1 existing → select it automatically, store it
   *   2+ existing → return them for the caller to surface in the UI
   *
   * @param advertiserId  TikTok advertiser account ID
   * @param accessToken   Valid OAuth access token for this advertiser
   * @param eventSetName  Optional name for auto-created event sets
   */
  async provision(
    advertiserId: string,
    accessToken: string,
    eventSetName?: string,
  ): Promise<ProvisionResult> {
    logger.info({ advertiserId }, 'Provisioning CRM event set');

    try {
      const existing = await this.list(advertiserId, accessToken);

      // ── 0 event sets: auto-create ─────────────────────────────────────────
      if (existing.length === 0) {
        const created = await this.create(advertiserId, accessToken, eventSetName);
        await this.store(advertiserId, created, 'auto_created');
        logger.info(
          { advertiserId, eventSetId: created.event_set_id },
          'No existing event sets — auto-created and stored',
        );
        return { status: 'created_new', eventSet: created };
      }

      // ── 1 event set: auto-select ──────────────────────────────────────────
      if (existing.length === 1) {
        await this.store(advertiserId, existing[0], 'auto_selected');
        logger.info(
          { advertiserId, eventSetId: existing[0].event_set_id },
          'Single existing event set found — auto-selected',
        );
        return { status: 'selected_existing', eventSet: existing[0] };
      }

      // ── 2+ event sets: surface for manual selection ───────────────────────
      logger.info(
        { advertiserId, count: existing.length },
        'Multiple event sets found — manual selection required',
      );
      return { status: 'multiple_found', eventSets: existing };

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, advertiserId }, 'Event set provisioning failed');
      return { status: 'error', message };
    }
  }

  // ── 4. Resolve — hot path used by TikTokEventBuilder ─────────────────────

  /**
   * Return the event set ID for a given advertiser.
   * Resolution order:
   *   1. Redis cache  — sub-millisecond, no DB hit
   *   2. Postgres     — stored by provision() or manual selection
   *   3. Env fallback — TIKTOK_CRM_EVENT_SET_ID (backward compat)
   *
   * @throws if no event set ID is available for the advertiser
   */
  async resolve(advertiserId: string): Promise<string> {
    // 1. Redis cache
    try {
      const cached = await this.redis.get(`${EVENT_SET_CACHE_PREFIX}${advertiserId}`);
      if (cached) return cached;
    } catch {
      // cache miss — fall through
    }

    // 2. Postgres
    const row = await this.pg.query<{ event_set_id: string }>(
      'SELECT event_set_id FROM advertiser_event_sets WHERE advertiser_id = $1 LIMIT 1',
      [advertiserId],
    );

    if (row.rows.length) {
      const id = row.rows[0].event_set_id;
      // Warm the cache
      await this.redis.set(`${EVENT_SET_CACHE_PREFIX}${advertiserId}`, id, 'EX', EVENT_SET_CACHE_TTL).catch(() => {});
      return id;
    }

    // 3. Env fallback (backward compat for single-advertiser deployments)
    if (env.TIKTOK_CRM_EVENT_SET_ID) {
      logger.debug(
        { advertiserId },
        'Using TIKTOK_CRM_EVENT_SET_ID env fallback — consider running /event-sets/provision',
      );
      return env.TIKTOK_CRM_EVENT_SET_ID;
    }

    throw new Error(
      `No CRM event set found for advertiser ${advertiserId}. ` +
      `Complete provisioning at POST /event-sets/${advertiserId}/provision ` +
      `or set TIKTOK_CRM_EVENT_SET_ID in your environment.`,
    );
  }

  // ── Manual selection ───────────────────────────────────────────────────────

  /**
   * Manually select an event set from the list of existing ones.
   * Called when provision() returns { status: 'multiple_found' } and the
   * user picks one from the UI or API.
   */
  async select(
    advertiserId: string,
    eventSetId: string,
    accessToken: string,
  ): Promise<CRMEventSet> {
    // Verify the event set actually belongs to this advertiser
    const sets = await this.list(advertiserId, accessToken);
    const selected = sets.find((s) => s.event_set_id === eventSetId);

    if (!selected) {
      throw new Error(
        `Event set ${eventSetId} not found for advertiser ${advertiserId}`,
      );
    }

    await this.store(advertiserId, selected, 'manually_selected');
    logger.info({ advertiserId, eventSetId }, 'Event set manually selected');
    return selected;
  }

  // ── Storage helpers ────────────────────────────────────────────────────────

  private async store(
    advertiserId: string,
    eventSet: CRMEventSet,
    source: AdvertiserEventSet['source'],
  ): Promise<void> {
    await this.pg.query(
      `INSERT INTO advertiser_event_sets
         (advertiser_id, event_set_id, event_set_name, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (advertiser_id) DO UPDATE SET
         event_set_id   = EXCLUDED.event_set_id,
         event_set_name = EXCLUDED.event_set_name,
         source         = EXCLUDED.source,
         updated_at     = NOW()`,
      [advertiserId, eventSet.event_set_id, eventSet.name, source],
    );

    // Warm cache immediately
    await this.redis
      .set(`${EVENT_SET_CACHE_PREFIX}${advertiserId}`, eventSet.event_set_id, 'EX', EVENT_SET_CACHE_TTL)
      .catch(() => {});
  }

  // ── Error helper ───────────────────────────────────────────────────────────

  private assertSuccess(
    response: { code: number; message: string },
    context: string,
  ): void {
    if (response.code !== 0) {
      throw new Error(
        `TikTok ${context} failed: code=${response.code} message=${response.message}`,
      );
    }
  }
}
