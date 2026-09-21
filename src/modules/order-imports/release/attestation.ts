/**
 * The consent statement a merchant ticks before an import may contact anyone.
 *
 * Stored by version: a batch records only `attestation_version`, so the exact
 * words it agreed to stay recoverable here. Never edit a published version;
 * add a new one and move `CURRENT_ATTESTATION_VERSION`.
 */
export const BULK_IMPORT_ATTESTATIONS = {
  'bulk-import-consent-v1': {
    en: 'I confirm these customers placed these cash-on-delivery orders with my store recently and expect to be contacted on WhatsApp about them.',
    ar: 'أؤكد أن هؤلاء العملاء قدّموا طلبات الدفع عند الاستلام هذه في متجري مؤخرًا ويتوقعون التواصل معهم عبر واتساب بشأنها.',
  },
} as const;

export type AttestationVersion = keyof typeof BULK_IMPORT_ATTESTATIONS;

export const CURRENT_ATTESTATION_VERSION: AttestationVersion =
  'bulk-import-consent-v1';
