import { Router, Request, Response } from 'express';
import { TikTokOAuthClient } from './tiktok-oauth';
import { TokenStore } from './token-store';
import { CRMEventSetManager } from '../event-set/crm-event-set-manager';
import { logger } from '../logging/logger';

/**
 * OAuth Routes
 *
 * Implements TikTok's "Developer's Own App" OAuth2 flow plus token management.
 * After a successful authorization, event set provisioning is triggered
 * automatically so advertisers don't need to visit Events Manager manually.
 *
 * GET  /auth/tiktok                     — Begin: generate state, redirect to TikTok
 * GET  /auth/tiktok/callback            — Finish: verify state, exchange code, store tokens,
 *                                         auto-provision event set
 * GET  /auth/tiktok/status              — List all authorized advertiser IDs
 * POST /auth/tiktok/refresh/:id         — Manually refresh a token
 * POST /auth/tiktok/revoke/:id          — Revoke access for an advertiser
 */
export function buildOAuthRouter(
  oauthClient: TikTokOAuthClient,
  tokenStore: TokenStore,
  eventSetManager: CRMEventSetManager,
): Router {
  const router = Router();

  // ── GET /auth/tiktok — Initiate OAuth ─────────────────────────────────────
  router.get('/tiktok', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { url, state } = oauthClient.buildAuthorizationUrl();

      // Store state in Redis for CSRF verification in the callback (10-min TTL)
      await tokenStore.storeState(state);

      logger.info({ state }, 'Initiating TikTok OAuth — redirecting to consent screen');
      res.redirect(url);
    } catch (err) {
      logger.error({ err }, 'Failed to initiate OAuth');
      res.status(500).json({ error: 'Failed to initiate OAuth flow' });
    }
  });

  // ── GET /auth/tiktok/callback — Handle TikTok redirect ────────────────────
  router.get('/tiktok/callback', async (req: Request, res: Response): Promise<void> => {
    const { auth_code, state, error: oauthError } = req.query as Record<string, string | undefined>;

    // User denied consent
    if (oauthError === 'access_denied') {
      res.status(400).json({ error: 'Authorization denied by user' });
      return;
    }

    if (!auth_code) {
      res.status(400).json({ error: 'Missing auth_code in callback' });
      return;
    }

    if (!state) {
      res.status(400).json({ error: 'Missing state in callback' });
      return;
    }

    // Verify + consume CSRF state (one-time use)
    const storedState = await tokenStore.getAndDeleteState(state);
    if (!storedState) {
      res.status(400).json({ error: 'State expired or not found — restart OAuth flow' });
      return;
    }

    if (!oauthClient.verifyState(state, storedState.value)) {
      res.status(403).json({ error: 'State mismatch — possible CSRF attack' });
      return;
    }

    try {
      // Exchange auth code for tokens (one row per advertiser_id in Postgres)
      const tokens = await oauthClient.exchangeAuthCode(auth_code);
      const advertiserIds = tokens.map((t) => t.advertiser_id);

      logger.info({ advertiserIds }, 'OAuth flow completed successfully');

      // ── Auto-provision event sets ─────────────────────────────────────────
      // For each newly authorized advertiser, run the provision flow:
      //   - 0 existing sets → creates one automatically
      //   - 1 existing set  → selects it automatically
      //   - 2+ sets         → deferred to manual selection via /event-sets API
      const provisionResults = await Promise.allSettled(
        tokens.map(async (token) => {
          const accessToken = await oauthClient.getValidToken(token.advertiser_id);
          const result = await eventSetManager.provision(token.advertiser_id, accessToken);
          return { advertiserId: token.advertiser_id, result };
        }),
      );

      const provisioned: Record<string, unknown> = {};
      for (const outcome of provisionResults) {
        if (outcome.status === 'fulfilled') {
          const { advertiserId, result } = outcome.value;
          provisioned[advertiserId] = result;
        } else {
          logger.warn({ reason: outcome.reason }, 'Event set provisioning failed for one advertiser');
        }
      }

      // Redirect or JSON response
      const redirectAfter = storedState.redirectAfter;
      if (redirectAfter) {
        res.redirect(
          `${redirectAfter}?authorized=true&advertiser_ids=${advertiserIds.join(',')}`,
        );
        return;
      }

      res.json({
        advertiser_ids: advertiserIds,
        message: `Successfully authorized ${advertiserIds.length} advertiser account(s)`,
        event_set_provisioning: provisioned,
      });

    } catch (err) {
      logger.error({ err }, 'OAuth callback error');
      res.status(500).json({ error: 'Token exchange failed' });
    }
  });

  // ── GET /auth/tiktok/status ────────────────────────────────────────────────
  router.get('/tiktok/status', async (_req: Request, res: Response): Promise<void> => {
    try {
      const advertiserIds = await tokenStore.listActiveAdvertiserIds();
      res.json({
        authorized_advertisers: advertiserIds,
        count: advertiserIds.length,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch authorized advertisers' });
    }
  });

  // ── POST /auth/tiktok/refresh/:advertiserId ────────────────────────────────
  router.post('/tiktok/refresh/:advertiserId', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    try {
      const updated = await oauthClient.refreshAccessToken(advertiserId);
      res.json({ status: 'refreshed', advertiser_id: advertiserId, expires_at: updated.access_token_expires_at });
    } catch (err) {
      logger.error({ err, advertiserId }, 'Manual token refresh failed');
      res.status(400).json({ error: err instanceof Error ? err.message : 'Refresh failed' });
    }
  });

  // ── POST /auth/tiktok/revoke/:advertiserId ─────────────────────────────────
  router.post('/tiktok/revoke/:advertiserId', async (req: Request, res: Response): Promise<void> => {
    const { advertiserId } = req.params;
    try {
      await tokenStore.revoke(advertiserId);
      res.json({ status: 'revoked', advertiser_id: advertiserId });
    } catch (err) {
      logger.error({ err, advertiserId }, 'Token revocation failed');
      res.status(500).json({ error: 'Revocation failed' });
    }
  });

  return router;
}
