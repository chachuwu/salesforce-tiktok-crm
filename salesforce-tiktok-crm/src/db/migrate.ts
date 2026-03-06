import { Pool } from 'pg';
import { env } from '../config/env';

const pool = new Pool({
  host: env.POSTGRES_HOST, port: env.POSTGRES_PORT,
  database: env.POSTGRES_DB, user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
});

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS crm_event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id TEXT NOT NULL UNIQUE,
    event_name TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    salesforce_replay_id BIGINT NOT NULL,
    tiktok_payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','duplicate')),
    tiktok_response JSONB,
    attempt_count INT NOT NULL DEFAULT 1,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_crm_event_log_lead_id ON crm_event_log (lead_id);
  CREATE INDEX IF NOT EXISTS idx_crm_event_log_status  ON crm_event_log (status);
  CREATE INDEX IF NOT EXISTS idx_crm_event_log_created ON crm_event_log (created_at DESC);

  CREATE TABLE IF NOT EXISTS tiktok_oauth_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    advertiser_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token_expires_at TIMESTAMPTZ NOT NULL,
    refresh_token_expires_at TIMESTAMPTZ NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tiktok_tokens_advertiser
    ON tiktok_oauth_tokens (advertiser_id);
  CREATE INDEX IF NOT EXISTS idx_tiktok_tokens_refresh_exp
    ON tiktok_oauth_tokens (refresh_token_expires_at);

  CREATE OR REPLACE FUNCTION update_updated_at_column()
  RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ language 'plpgsql';

  DROP TRIGGER IF EXISTS trg_crm_event_log_upd ON crm_event_log;
  CREATE TRIGGER trg_crm_event_log_upd
    BEFORE UPDATE ON crm_event_log FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();


  CREATE TABLE IF NOT EXISTS advertiser_event_sets (
    advertiser_id   TEXT PRIMARY KEY,
    event_set_id    TEXT NOT NULL,
    event_set_name  TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL CHECK (source IN ('auto_created','auto_selected','manually_selected','env_fallback')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_advertiser_event_sets_event_set_id
    ON advertiser_event_sets (event_set_id);

  DROP TRIGGER IF EXISTS trg_advertiser_event_sets_upd ON advertiser_event_sets;
  CREATE TRIGGER trg_advertiser_event_sets_upd
    BEFORE UPDATE ON advertiser_event_sets FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
  DROP TRIGGER IF EXISTS trg_tiktok_tokens_upd ON tiktok_oauth_tokens;
  CREATE TRIGGER trg_tiktok_tokens_upd
    BEFORE UPDATE ON tiktok_oauth_tokens FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running database migration...');
    await client.query(MIGRATION);
    console.log('Migration complete');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
