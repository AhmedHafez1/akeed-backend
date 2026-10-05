export const WHATSAPP_TEMPLATE_SYNC_QUEUE = 'whatsapp-template-sync';
export const WHATSAPP_TEMPLATE_SYNC_JOB = 'sync-whatsapp-templates';
export const WHATSAPP_TEMPLATE_SYNC_SCHEDULER = 'whatsapp-template-sync-6h';
/** One delayed job collects a burst of template webhooks into one sync. */
export const WHATSAPP_TEMPLATE_SYNC_WEBHOOK_JOB_ID =
  'whatsapp-template-sync-webhook';

/** Open decision 1: every 6 hours, plus on demand and after webhooks. */
export const WHATSAPP_TEMPLATE_SYNC_EVERY_MS = 6 * 60 * 60_000;
/** How long after a template webhook the follow-up sync runs. */
export const WHATSAPP_TEMPLATE_SYNC_WEBHOOK_DELAY_MS = 60_000;

export interface WhatsappTemplateSyncJob {
  trigger: 'scheduled' | 'webhook';
}
