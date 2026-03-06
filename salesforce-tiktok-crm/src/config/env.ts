import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Salesforce
  SF_LOGIN_URL: z.string().url().default('https://login.salesforce.com'),
  SF_CLIENT_ID: z.string().min(1),
  SF_CLIENT_SECRET: z.string().min(1),
  SF_USERNAME: z.string().min(1),
  SF_PASSWORD: z.string().min(1),
  SF_SECURITY_TOKEN: z.string().default(''),
  SF_CDC_CHANNEL: z.string().default('/data/LeadChangeEvent'),

  // TikTok — App credentials (from TikTok Developer Portal → Manage Apps)
  TIKTOK_APP_ID: z.string().min(1),
  TIKTOK_APP_SECRET: z.string().min(1),
  TIKTOK_REDIRECT_URI: z.string().url(),

  // TikTok — Events API
  TIKTOK_CRM_EVENT_SET_ID: z.string().optional(), // Now auto-provisioned via CRMEventSetManager — still accepted as fallback
  TIKTOK_API_BASE_URL: z.string().url().default('https://business-api.tiktok.com'),
  TIKTOK_API_VERSION: z.string().default('v1.3'),

  // TikTok — Static token (optional: used as fallback if OAuth not yet set up)
  TIKTOK_ACCESS_TOKEN: z.string().optional(),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  REDIS_DEDUP_TTL_SECONDS: z.coerce.number().default(172800),

  // Postgres
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_DB: z.string().default('crm_events'),
  POSTGRES_USER: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().min(1),

  // App
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  INTEGRATION_VERSION: z.string().default('1.0.0'),

  // Retry / Rate limiting
  TIKTOK_MAX_RETRIES: z.coerce.number().default(5),
  TIKTOK_INITIAL_RETRY_DELAY_MS: z.coerce.number().default(1000),
  TIKTOK_BATCH_SIZE: z.coerce.number().default(50),
  TIKTOK_RATE_LIMIT_RPS: z.coerce.number().default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
