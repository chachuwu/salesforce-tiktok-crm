import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { env } from './config/env';
import { logger } from './logging/logger';
import { SalesforceCDCListener } from './listeners/salesforce-cdc';
import { Pipeline } from './pipeline';
import { TikTokAPIClient } from './clients/tiktok-api-client';
import { TikTokOAuthClient } from './auth/tiktok-oauth';
import { TokenStore } from './auth/token-store';
import { ProactiveRefresher } from './auth/proactive-refresher';
import { buildOAuthRouter } from './auth/oauth-routes';
import { CRMEventSetManager } from './event-set/crm-event-set-manager';
import { buildEventSetRouter } from './event-set/event-set-routes';
import { startWorker, attachQueueEvents, drainQueue, getQueue } from './queue/retry-queue';
import { EventDeduplicator } from './deduplication/redis-dedup';
import { EventLog } from './db/event-log';

const app = express();
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'salesforce-tiktok-crm',
    version: env.INTEGRATION_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// ─── Readiness Check ──────────────────────────────────────────────────────────
app.get('/ready', async (_req: Request, res: Response) => {
  try {
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

// ─── Queue Metrics ────────────────────────────────────────────────────────────
app.get('/metrics/queue', async (_req: Request, res: Response) => {
  try {
    const q = getQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    res.json({ waiting, active, completed, failed, delayed });
  } catch {
    res.status(500).json({ error: 'Failed to fetch queue metrics' });
  }
});

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled request error');
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  // Shared infrastructure
  const pg = new Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  });
  const redis = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    tls: env.REDIS_TLS ? {} : undefined,
  });

  // Auth layer
  const tokenStore = new TokenStore(pg, redis);
  const oauthClient = new TikTokOAuthClient(tokenStore);
  const proactiveRefresher = new ProactiveRefresher(oauthClient, tokenStore);

  // Event set manager — check-then-create-or-select per advertiser
  const eventSetManager = new CRMEventSetManager(pg, redis);

  // Pipeline — inject event set manager for per-advertiser resolution
  const pipeline = new Pipeline(eventSetManager);
  const tiktokClient = new TikTokAPIClient();

  // Mount OAuth routes (auth flow + auto event-set provisioning on callback)
  app.use('/auth', buildOAuthRouter(oauthClient, tokenStore, eventSetManager));

  // Mount Event Set management routes
  // Allows advertisers to list, create, and select event sets via API
  app.use('/event-sets', buildEventSetRouter(eventSetManager, oauthClient));

  // Start background jobs
  startWorker(tiktokClient);
  attachQueueEvents();
  // proactiveRefresher.start(); // Disabled — TikTok access tokens are long-lived

  // Start Salesforce CDC listener
  const listener = new SalesforceCDCListener(
    async (cdcEvent, lead) => {
      await pipeline.process(cdcEvent, lead);
    },
  );

  await listener.connect();

  // Start HTTP server
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, version: env.INTEGRATION_VERSION },
      '🚀  Salesforce → TikTok CRM integration started',
    );
  });

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    server.close(async () => {
      logger.info('HTTP server closed');

      await Promise.allSettled([
        listener.disconnect(),
        drainQueue(),
        proactiveRefresher.stop(),
        new EventLog().disconnect(),
        new EventDeduplicator().disconnect(),
        pg.end(),
        redis.quit(),
      ]);

      logger.info('Graceful shutdown complete');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced exit after 30s shutdown timeout');
      process.exit(1);
    }, 30_000);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Bootstrap failed');
  process.exit(1);
});
