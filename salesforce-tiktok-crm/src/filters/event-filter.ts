import {
  SalesforceCDCEvent,
  FilterResult,
  SalesforceChangeType,
  TikTokStandardEvent,
} from '../types';
import { logger } from '../logging/logger';

/**
 * Fields that, when changed in isolation, should NOT trigger a TikTok event.
 */
const PII_ONLY_FIELDS = new Set([
  'FirstName', 'LastName', 'Email', 'Phone',
  'Company', 'Title', 'Description', 'Website',
]);

/**
 * Salesforce Lead Status → TikTok Standard Event
 *
 * Maps every known Salesforce Lead Status value to the most appropriate
 * TikTok standard event, grouped by the 4 Deep Funnel Optimization stages.
 *
 * WHY STANDARD EVENTS?
 *   TikTok standard events (SubmitForm, Contact, Schedule, etc.) have formal
 *   platform support: they are automatically recognised for Lead/Sales campaign
 *   objectives, require no manual funnel mapping in Events Manager, and are
 *   eligible for DFO optimization out-of-the-box. Custom events work but must
 *   be manually dragged into each funnel stage in the UI.
 *
 * DFO FUNNEL STAGES (optimise for stage 2, 3, or 4 in Ads Manager):
 *
 *   Stage 1 — Lead Captured   → SubmitForm
 *   Stage 2 — Engaged         → Contact, Schedule
 *   Stage 3 — Qualified       → CompleteRegistration, SubmitApplication
 *   Stage 4 — Converted       → Purchase, ApplicationApproval, Subscribe, StartTrial
 *
 * RULES:
 *  - Keys are lowercase-trimmed (normalisation happens before lookup).
 *  - Terminal negative states (junk, lost, unqualified) map to Purchase so
 *    TikTok can model negative outcomes and suppress similar audiences.
 *  - Unknown statuses log a warning rather than silently dropping.
 *  - Extend this map when new CRM statuses are introduced.
 *
 * VOLUME REQUIREMENT:
 *   TikTok requires ≥50 signals per funnel stage per 14 days for stable DFO.
 *   Ensure all active statuses are mapped to avoid gaps.
 */
export const STATUS_TO_EVENT: Record<string, TikTokStandardEvent> = {

  // ── Stage 1: Lead Captured — SubmitForm ────────────────────────────────────
  // Triggered by CREATE events and explicit "new/open" status transitions.
  // SubmitForm is TikTok's standard event for initial lead capture.
  'new':                        'SubmitForm',
  'open':                       'SubmitForm',
  'open - not contacted':       'SubmitForm',
  'not contacted':              'SubmitForm',
  'pending':                    'SubmitForm',   // awaiting first contact
  'uncontacted':                'SubmitForm',
  'fresh':                      'SubmitForm',

  // ── Stage 2a: Contacted — Contact ─────────────────────────────────────────
  // TikTok's Contact event = any outreach attempt (call, email, SMS).
  'contacted':                  'Contact',
  'attempted to contact':       'Contact',
  'working - contacted':        'Contact',
  'working':                    'Contact',
  'in progress':                'Contact',
  'follow up':                  'Contact',
  'follow-up':                  'Contact',
  'nurturing':                  'Contact',
  'reconnect':                  'Contact',
  're-engaged':                 'Contact',

  // ── Stage 2b: Appointment Booked — Schedule ────────────────────────────────
  // TikTok has a dedicated Schedule standard event for demos/appointments.
  // Previously these were incorrectly mapped to Contact.
  'demo scheduled':             'Schedule',
  'meeting scheduled':          'Schedule',
  'appointment scheduled':      'Schedule',
  'appointment booked':         'Schedule',
  'call scheduled':             'Schedule',
  'demo booked':                'Schedule',
  'intro call scheduled':       'Schedule',
  'discovery call scheduled':   'Schedule',

  // ── Stage 3a: Qualified — CompleteRegistration ────────────────────────────
  // Marketing-qualified leads: expressed interest, meet scoring threshold.
  'qualified':                  'CompleteRegistration',
  'marketing qualified':        'CompleteRegistration',
  'mql':                        'CompleteRegistration',
  'interested':                 'CompleteRegistration',
  'review':                     'CompleteRegistration',
  'under review':               'CompleteRegistration',

  // ── Stage 3b: Application Submitted — SubmitApplication ───────────────────
  // Sales-qualified / formal application / commercial intent shown.
  'sales qualified':            'SubmitApplication',
  'sql':                        'SubmitApplication',
  'opportunity':                'SubmitApplication',
  'proposal sent':              'SubmitApplication',
  'proposal':                   'SubmitApplication',
  'negotiation':                'SubmitApplication',
  'application submitted':      'SubmitApplication',
  'applied':                    'SubmitApplication',

  // ── Stage 4a: Deal Closed / Won — Purchase ─────────────────────────────────
  // TikTok's Purchase = final conversion / closed-won. Also used for terminal
  // negative states so TikTok can model suppression audiences.
  'converted':                  'Purchase',
  'closed - converted':         'Purchase',
  'closed':                     'Purchase',
  'closed won':                 'Purchase',
  'closed - won':               'Purchase',
  'won':                        'Purchase',
  'sale':                       'Purchase',
  'customer':                   'Purchase',
  // Terminal negative — still postback so TikTok suppresses similar users
  'unqualified':                'Purchase',
  'closed - not converted':     'Purchase',
  'closed - not interested':    'Purchase',
  'junk lead':                  'Purchase',
  'junk':                       'Purchase',
  'lost':                       'Purchase',
  'disqualified':               'Purchase',
  'inactive':                   'Purchase',
  'recycled':                   'Purchase',
  'do not contact':             'Purchase',

  // ── Stage 4b: Application Approved — ApplicationApproval ──────────────────
  // For businesses with formal approval workflows (loans, programmes, jobs).
  'approved':                   'ApplicationApproval',
  'application approved':       'ApplicationApproval',
  'credit approved':            'ApplicationApproval',
  'accepted':                   'ApplicationApproval',

  // ── Stage 4c: Subscription / Trial — Subscribe / StartTrial ───────────────
  'subscribed':                 'Subscribe',
  'subscription started':       'Subscribe',
  'trial':                      'StartTrial',
  'trial started':              'StartTrial',
  'free trial':                 'StartTrial',
};

export class EventFilter {
  static evaluate(cdcEvent: SalesforceCDCEvent): FilterResult {
    const header = cdcEvent.payload.ChangeEventHeader;
    const changeType: SalesforceChangeType = header.changeType;
    const changedFields: string[] = header.changedFields ?? [];
    const entityName = header.entityName;

    if (entityName !== 'Lead') {
      return { shouldProcess: false, reason: `Non-Lead entity: ${entityName}` };
    }

    // ── CREATE → Stage 1: SubmitForm ─────────────────────────────────────────
    // TikTok standard event for initial lead capture from a form submission.
    if (changeType === 'CREATE') {
      return { shouldProcess: true, reason: 'Lead created', eventType: 'SubmitForm' };
    }

    if (changeType !== 'UPDATE') {
      return { shouldProcess: false, reason: `Irrelevant changeType: ${changeType}` };
    }

    // ── IsConverted flag → Stage 4: Purchase ─────────────────────────────────
    if (changedFields.includes('IsConverted')) {
      return {
        shouldProcess: true,
        reason: 'Lead converted (IsConverted flag set)',
        eventType: 'Purchase',
      };
    }

    // ── Status field change → look up TikTok standard event ──────────────────
    if (changedFields.includes('Status')) {
      const rawStatus: unknown = cdcEvent.payload['Status'];
      const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase().trim() : '';
      const mapped = STATUS_TO_EVENT[status];

      if (!mapped) {
        logger.warn(
          { status },
          'Unmapped Salesforce lead status — add to STATUS_TO_EVENT in event-filter.ts',
        );
        return { shouldProcess: false, reason: `Unmapped status: "${status}"` };
      }

      return {
        shouldProcess: true,
        reason: `Status "${status}" → TikTok ${mapped}`,
        eventType: mapped,
      };
    }

    // ── PII-only change — skip ────────────────────────────────────────────────
    const nonPiiChanged = changedFields.filter((f) => !PII_ONLY_FIELDS.has(f));
    if (nonPiiChanged.length === 0) {
      return { shouldProcess: false, reason: 'Only PII fields changed — no status transition' };
    }

    return {
      shouldProcess: false,
      reason: `No actionable DFO transition in: ${changedFields.join(', ')}`,
    };
  }
}
