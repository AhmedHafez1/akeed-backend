import { changeRequestDashboardLink } from './change-request-email';
import type { UsageAlertLanguage } from './usage-alert-copy';

/** Only trusted source identity and configured app URLs enter this link. */
export function whatsappSettingsLink(input: {
  language: UsageAlertLanguage;
  platformType: string;
  platformStoreUrl: string;
  dashboardUrl: string;
  shopifyApiKey?: string;
}): string | null {
  const base = changeRequestDashboardLink({ ...input, verificationId: '' });
  if (!base) return null;
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/verifications$/, '/settings');
  url.search = '?tab=whatsapp';
  return url.toString();
}
