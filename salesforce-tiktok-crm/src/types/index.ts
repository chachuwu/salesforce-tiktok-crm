// ─── Salesforce CDC ──────────────────────────────────────────────────────────

export type SalesforceChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';

export interface SalesforceCDCHeader {
  changeType: SalesforceChangeType;
  changedFields?: string[];
  transactionKey: string;
  sequenceNumber: number;
  /**
   * ISO-8601 UTC timestamp of when Salesforce committed the change.
   * Per TikTok spec, event_time must reflect when the status actually changed
   * in the CRM — not when the pipeline processed it.
   */
  commitTimestamp: string;
  commitUser: string;
  commitNumber: string;
  entityName: string;
  recordIds?: string[];
}

export interface SalesforceLead {
  Id: string;
  Status: string;
  Email?: string;
  Phone?: string;
  FirstName?: string;
  LastName?: string;
  Company?: string;
  Title?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
  IsConverted: boolean;
  ConvertedDate?: string;
  CreatedDate: string;
  LeadSource?: string;
  Campaign__c?: string;
  TTCLID__c?: string;
  /**
   * TikTok's own native lead form submission ID. Highest-priority matching
   * signal for 1P leads. Must be sent plaintext in user.lead_id (never hashed).
   */
  TikTok_Lead_ID__c?: string;
  External_Id__c?: string;
  IP_Address__c?: string;
  User_Agent__c?: string;
}

export interface SalesforceCDCEvent {
  schema: string;
  payload: {
    ChangeEventHeader: SalesforceCDCHeader;
    [field: string]: unknown;
  };
  event: { replayId: number };
}

// ─── TikTok Standard Events ───────────────────────────────────────────────────
//
// Source: https://ads.tiktok.com/help/article/supported-standard-events (Sep 2025)
//
// These are TikTok's predefined event names with formal platform support:
//   - Automatic campaign objective alignment (Lead / Sales)
//   - Built-in reporting and optimization signals in Ads Manager
//   - Eligible for Deep Funnel Optimization (DFO) without manual mapping
//
// Objective alignment:
//   Lead:        SubmitForm, CompleteRegistration, Contact, FindLocation,
//                Schedule, SubmitApplication, ApplicationApproval, Subscribe,
//                AddToWishlist, ViewContent, Search
//   Sales:       Purchase, AddToCart, InitiateCheckout, AddPaymentInfo,
//                AddToWishlist, Subscribe, StartTrial, ViewContent, Search, Download
//
// CRM-relevant standard events (Lead objective):
//   SubmitForm          → Stage 1: lead captured (top of funnel)
//   Contact             → Stage 2: first outreach attempt
//   Schedule            → Stage 2: appointment / demo booked
//   CompleteRegistration→ Stage 3: lead has qualified / registered fully
//   SubmitApplication   → Stage 3: formal application submitted
//   ApplicationApproval → Stage 4: application / deal approved
//   Subscribe           → Stage 4: subscription started
//   StartTrial          → Stage 4: free trial started
//   Purchase            → Stage 4: deal closed / won

export type TikTokStandardEvent =
  // Lead-objective standard events
  | 'SubmitForm'
  | 'CompleteRegistration'
  | 'Contact'
  | 'FindLocation'
  | 'Schedule'
  | 'SubmitApplication'
  | 'ApplicationApproval'
  | 'Subscribe'
  | 'AddToWishlist'
  | 'ViewContent'
  | 'Search'
  // Sales-objective standard events (also relevant for CRM pipelines)
  | 'Purchase'
  | 'AddToCart'
  | 'InitiateCheckout'
  | 'AddPaymentInfo'
  | 'StartTrial'
  | 'Download'
  | 'CustomizeProduct';

/**
 * All valid TikTok event names for this integration.
 *
 * Standard events are preferred: they need no manual mapping in Events Manager
 * and are automatically eligible for DFO and Lead objective optimization.
 *
 * The 4 legacy custom names are kept as a union so existing records stay valid,
 * but new code should use TikTokStandardEvent values exclusively.
 *
 * @deprecated LeadCreated | LeadContacted | LeadQualified | LeadConverted
 *   Use the corresponding standard events instead (see STATUS_TO_EVENT mapping).
 */
export type TikTokEventName =
  | TikTokStandardEvent
  // Legacy custom event names (kept for backward compat with stored event log records)
  | 'LeadCreated'
  | 'LeadContacted'
  | 'LeadQualified'
  | 'LeadConverted';

/**
 * Maps each TikTok event to its Deep Funnel Optimization stage.
 *
 * TikTok's DFO requires 4 stages; you optimize for stage 2, 3, or 4.
 * Stage 1 is always the initial lead capture event.
 * Volume requirement: ≥50 signals per stage per 14 days for stable optimization.
 */
export type DFOFunnelStage = 1 | 2 | 3 | 4;

export const EVENT_TO_DFO_STAGE: Record<TikTokStandardEvent, DFOFunnelStage> = {
  // Stage 1 — Lead Captured
  SubmitForm:          1,
  ViewContent:         1,
  Search:              1,
  FindLocation:        1,
  // Stage 2 — Engaged / Contacted
  Contact:             2,
  Schedule:            2,
  AddToWishlist:       2,
  AddToCart:           2,
  InitiateCheckout:    2,
  // Stage 3 — Qualified / Intent Shown
  CompleteRegistration:3,
  SubmitApplication:   3,
  AddPaymentInfo:      3,
  Download:            3,
  CustomizeProduct:    3,
  // Stage 4 — Converted
  Purchase:            4,
  ApplicationApproval: 4,
  Subscribe:           4,
  StartTrial:          4,
};

// ─── Canonical Event ──────────────────────────────────────────────────────────

export interface CanonicalLead {
  lead_id: string;
  status: string;
  created_at?: string;
  converted_at?: string;
}

export interface CanonicalUser {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  external_id?: string;
  /** TikTok native lead form ID — plaintext, highest-priority matching signal */
  tiktok_lead_id?: string;
}

export interface CanonicalAttribution {
  ttclid?: string;
  source?: string;
  campaign_id?: string;
}

export interface CanonicalDevice {
  ip?: string;
  user_agent?: string;
}

export interface CanonicalEventMetadata {
  salesforce_object: 'Lead';
  integration_version: string;
}

export interface CanonicalEvent {
  event_id: string;
  event_name: TikTokEventName;
  /**
   * Unix seconds UTC — from CDC commitTimestamp, NOT pipeline time.
   * TikTok spec: "when the actual event occurred in the CRM".
   */
  event_time: number;
  event_source: 'crm';
  lead: CanonicalLead;
  user: CanonicalUser;
  attribution: CanonicalAttribution;
  device: CanonicalDevice;
  metadata: CanonicalEventMetadata;
  /** Revenue data — recommended for Purchase events */
  value?: number;
  currency?: string;
}

// ─── Hashed User ─────────────────────────────────────────────────────────────

export interface HashedUser {
  email?: string;
  /** TikTok CRM Events API requires `phone_number` (not `phone`). */
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  external_id?: string;
}

// ─── TikTok API Payload ───────────────────────────────────────────────────────

export interface TikTokUserData {
  /** TikTok native lead form ID. Plaintext — NOT hashed. Highest-priority key. */
  lead_id?: string;
  email?: string;
  /** Must be `phone_number` per spec — using `phone` causes silent match failures. */
  phone_number?: string;
  external_id?: string;
  ttclid?: string;
  ip?: string;
  user_agent?: string;
  first_name?: string;
  last_name?: string;
}

export interface TikTokEventProperties {
  /** Recommended for Purchase events */
  currency?: string;
  value?: number;
  /** Supplemental metadata (not used for identity matching) */
  lead_status?: string;
  source?: string;
  campaign_id?: string;
  integration_version?: string;
  dfo_stage?: DFOFunnelStage;
}

export interface TikTokEventData {
  event: string;
  event_time: number;
  event_id: string;
  user: TikTokUserData;
  properties?: TikTokEventProperties;
}

export interface TikTokEventsPayload {
  event_source: 'crm';
  event_source_id: string;
  data: TikTokEventData[];
}

export interface TikTokAPIResponse {
  code: number;
  message: string;
  request_id: string;
  data?: {
    batch_upload_status?: Array<{
      event_id: string;
      status: 'success' | 'failed';
      error_message?: string;
    }>;
  };
}

// ─── Retry Queue ─────────────────────────────────────────────────────────────

export interface RetryJobData {
  payload: TikTokEventsPayload;
  attemptNumber: number;
  originalEventIds: string[];
  enqueuedAt: string;
}

// ─── Event Log ───────────────────────────────────────────────────────────────

export type EventLogStatus = 'pending' | 'sent' | 'failed' | 'duplicate';

export interface EventLogRecord {
  id: string;
  event_id: string;
  event_name: string;
  lead_id: string;
  salesforce_replay_id: number;
  tiktok_payload: TikTokEventsPayload;
  status: EventLogStatus;
  tiktok_response?: TikTokAPIResponse;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
  error?: string;
}

// ─── Filter ──────────────────────────────────────────────────────────────────

export interface FilterResult {
  shouldProcess: boolean;
  reason: string;
  eventType?: TikTokEventName;
}

// ─── Identity Signal Quality ─────────────────────────────────────────────────

export interface IdentitySignalQuality {
  score: number;
  hasTikTokLeadId: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasTtclid: boolean;
  hasExternalId: boolean;
  hasIp: boolean;
  hasUserAgent: boolean;
  estimatedMatchRate: string;
}
