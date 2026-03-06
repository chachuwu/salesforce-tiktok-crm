import { Router, Request, Response } from 'express';
import { CRMEventSetManager } from './crm-event-set-manager';
import { TikTokOAuthClient } from '../auth/tiktok-oauth';
import { logger } from '../logging/logger';

/**
 * Event Set Routes
 *
 * These routes expose the full event set lifecycle over HTTP, enabling
 * both automated provisioning (called from the OAuth callback) and manual
 * control when multiple event sets exist.
 *
 * POST /event-sets/:advertiserId/provision
 *   Auto check-and-create. Called automatically after OAuth; can also be
 *   triggered manually to re-run provisioning.
 *   - 0 sets exist  → creates one, returns { status: 'created_new', ... }
 *   - 1 set exists  → selects it, returns { status: 'selected_existing', ... }
 *   - 2+ sets exist → returns { status: 'multiple_found', event_sets: [...] }
 *                     Caller must then POST /select to pick one.
 *
 * GET /event-sets/:advertiserId
 *   List all existing CRM event sets from TikTok (live API call).
 *
 * POST /event-sets/:advertiserId
 *   Create a new named CRM event set via the TikTok API.
 *
 * POST /event-sets/:advertiserId/select
 *   Manually select an event set when multiple exist.
 *
 * GET /event-sets/:advertiserId/active
 *   Return the currently stored/active event set ID for an advertiser.
 */
export function buildEventSetRouter(
  eventSetManager: CRMEventSetManager,
  oauthClient: TikTokOAuthClient,
): Router {
  const router = Router();

  // ── POST /event-sets/:advertiserId/provision ─────────────────────────────

  router.post('/:advertiserId/provision', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    const { event_set_name } = req.body as { event_set_name?: string };

    try {
      const accessToken = await oauthClient.getValidToken(advertiserId);
      const result = await eventSetManager.provision(advertiserId, accessToken, event_set_name);

      switch (result.status) {
        case 'created_new':
          res.status(201).json({
            status: 'created_new',
            message: 'No existing event set found — a new one was created automatically.',
            event_set: result.eventSet,
            next_step: null,
          });
          break;

        case 'selected_existing':
          res.json({
            status: 'selected_existing',
            message: 'One existing event set found — automatically selected.',
            event_set: result.eventSet,
            next_step: null,
          });
          break;

        case 'multiple_found':
          res.json({
            status: 'multiple_found',
            message: `${result.eventSets.length} event sets found. Select one using POST /event-sets/${advertiserId}/select.`,
            event_sets: result.eventSets,
            next_step: `POST /event-sets/${advertiserId}/select with { "event_set_id": "<id>" }`,
          });
          break;

        case 'error':
          res.status(500).json({ status: 'error', message: result.message });
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, advertiserId }, 'Event set provisioning route error');

      if (message.includes('OAuth authorization required')) {
        res.status(401).json({
          error: 'not_authorized',
          message: `Advertiser ${advertiserId} has not completed OAuth. Visit /auth/tiktok first.`,
        });
      } else {
        res.status(500).json({ error: 'Provisioning failed', details: message });
      }
    }
  });

  // ── GET /event-sets/:advertiserId ────────────────────────────────────────

  router.get('/:advertiserId', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    try {
      const accessToken = await oauthClient.getValidToken(advertiserId);
      const sets = await eventSetManager.list(advertiserId, accessToken);
      res.json({ advertiser_id: advertiserId, event_sets: sets, count: sets.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, advertiserId }, 'Event set list route error');
      res.status(500).json({ error: 'Failed to list event sets', details: message });
    }
  });

  // ── POST /event-sets/:advertiserId ───────────────────────────────────────

  router.post('/:advertiserId', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    const { name } = req.body as { name?: string };

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Request body must include a non-empty "name" field' });
      return;
    }

    try {
      const accessToken = await oauthClient.getValidToken(advertiserId);
      const created = await eventSetManager.create(advertiserId, accessToken, name.trim());
      // Store immediately as the active event set
      // Re-use select flow to persist it
      await eventSetManager.select(advertiserId, created.event_set_id, accessToken);
      res.status(201).json({
        message: 'CRM event set created and set as active.',
        event_set: created,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, advertiserId }, 'Event set create route error');
      res.status(500).json({ error: 'Failed to create event set', details: message });
    }
  });

  // ── POST /event-sets/:advertiserId/select ────────────────────────────────

  router.post('/:advertiserId/select', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    const { event_set_id } = req.body as { event_set_id?: string };

    if (!event_set_id || typeof event_set_id !== 'string') {
      res.status(400).json({ error: 'Request body must include "event_set_id"' });
      return;
    }

    try {
      const accessToken = await oauthClient.getValidToken(advertiserId);
      const selected = await eventSetManager.select(advertiserId, event_set_id, accessToken);
      res.json({
        message: 'Event set selected and stored as active.',
        event_set: selected,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, advertiserId }, 'Event set select route error');

      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: 'Failed to select event set', details: message });
      }
    }
  });

  // ── GET /event-sets/:advertiserId/active ─────────────────────────────────

  router.get('/:advertiserId/active', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    try {
      const eventSetId = await eventSetManager.resolve(advertiserId);
      res.json({ advertiser_id: advertiserId, active_event_set_id: eventSetId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(404).json({ error: 'No active event set found', details: message });
    }
  });

  return router;
}
