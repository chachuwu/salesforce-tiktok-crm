import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { RetryJobData, TikTokEventsPayload } from '../types';
import { TikTokAPIClient } from '../clients/tiktok-api-client';
import { getRedis } from '../deduplication/redis-dedup';
import { logger } from '../logging/logger';
import { env } from '../config/env';

const QUEUE_NAME = 'tiktok-events';

let queue: Queue<RetryJobData> | null = null;
let worker: Worker<RetryJobData> | null = null;
let queueEvents: QueueEvents | null = null;

/**
 * Get (or create) the BullMQ queue instance.
 */
export function getQueue(): Queue<RetryJobData> {
  if (!queue) {
    queue = new Queue<RetryJobData>(QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: env.TIKTOK_MAX_RETRIES,
        backoff: {
          type: 'exponential',
          delay: env.TIKTOK_INITIAL_RETRY_DELAY_MS,
        },
        removeOnComplete: { count: 1000 }, // keep last 1000 completed jobs
        removeOnFail: { count: 5000 },    // keep last 5000 failed jobs for audit
      },
    });

    logger.info({ queueName: QUEUE_NAME }, 'BullMQ queue initialised');
  }
  return queue;
}

/**
 * Enqueue a TikTok payload for async delivery.
 */
export async function enqueuePayload(payload: TikTokEventsPayload): Promise<string> {
  const q = getQueue();
  const jobData: RetryJobData = {
    payload,
    attemptNumber: 0,
    originalEventIds: payload.data.map((e) => e.event_id),
    enqueuedAt: new Date().toISOString(),
  };

  const job = await q.add('send-events', jobData, {
    jobId: payload.data.map((e) => e.event_id).join(':'),
  });

  logger.info(
    { jobId: job.id, eventCount: payload.data.length },
    'Enqueued events for delivery',
  );

  return job.id ?? '';
}

/**
 * Start the BullMQ worker that processes queued jobs.
 */
export function startWorker(client: TikTokAPIClient): Worker<RetryJobData> {
  if (worker) return worker;

  worker = new Worker<RetryJobData>(
    QUEUE_NAME,
    async (job: Job<RetryJobData>) => {
      const { payload, originalEventIds } = job.data;

      logger.info(
        {
          jobId: job.id,
          attempt: job.attemptsMade,
          eventIds: originalEventIds,
        },
        'Processing retry job',
      );

      const response = await client.sendEvents(payload);

      logger.info(
        {
          jobId: job.id,
          requestId: response.request_id,
          code: response.code,
        },
        'Retry job succeeded',
      );

      return response;
    },
    {
      connection: getRedis(),
      concurrency: 5,
      limiter: {
        max: env.TIKTOK_RATE_LIMIT_RPS,
        duration: 1000,
      },
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, attempts: job.attemptsMade }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err },
      'Job failed permanently',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'BullMQ worker error');
  });

  logger.info('BullMQ worker started');

  return worker;
}

/**
 * Attach queue event listeners for monitoring.
 */
export function attachQueueEvents(): QueueEvents {
  if (queueEvents) return queueEvents;

  queueEvents = new QueueEvents(QUEUE_NAME, { connection: getRedis() });

  queueEvents.on('waiting', ({ jobId }) => {
    logger.debug({ jobId }, 'Job waiting');
  });

  queueEvents.on('active', ({ jobId }) => {
    logger.debug({ jobId }, 'Job active');
  });

  queueEvents.on('stalled', ({ jobId }) => {
    logger.warn({ jobId }, 'Job stalled');
  });

  return queueEvents;
}

export async function drainQueue(): Promise<void> {
  if (worker) await worker.close();
  if (queue) await queue.close();
  if (queueEvents) await queueEvents.close();
}
