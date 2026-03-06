// ─── TikTok CRM Event Set API Types ──────────────────────────────────────────

/**
 * A single CRM Event Set returned by GET /open_api/v1.3/crm/list/
 */
export interface CRMEventSet {
  event_set_id: string;
  name: string;
  advertiser_id: string;
  create_time: number;   // Unix seconds
  update_time: number;   // Unix seconds
  /** Number of events received in the last 7 days */
  event_count?: number;
}

/**
 * Response envelope from TikTok's /crm/list/ endpoint.
 */
export interface CRMListResponse {
  code: number;
  message: string;
  request_id: string;
  data: {
    list: CRMEventSet[];
    page_info?: {
      total_number: number;
      page: number;
      page_size: number;
    };
  };
}

/**
 * Response envelope from TikTok's /crm/create/ endpoint.
 */
export interface CRMCreateResponse {
  code: number;
  message: string;
  request_id: string;
  data: {
    event_set_id: string;
    name: string;
  };
}

/**
 * Per-advertiser event set selection stored in Postgres + Redis.
 * Allows each advertiser to use a different event set ID, removing
 * the global TIKTOK_CRM_EVENT_SET_ID requirement.
 */
export interface AdvertiserEventSet {
  advertiser_id: string;
  event_set_id: string;
  event_set_name: string;
  /** How this record was created */
  source: 'auto_created' | 'auto_selected' | 'manually_selected' | 'env_fallback';
  created_at: Date;
  updated_at: Date;
}

/**
 * Result of the provision flow triggered after OAuth.
 */
export type ProvisionResult =
  | { status: 'selected_existing'; eventSet: CRMEventSet }
  | { status: 'created_new'; eventSet: CRMEventSet }
  | { status: 'multiple_found'; eventSets: CRMEventSet[] }
  | { status: 'error'; message: string };
