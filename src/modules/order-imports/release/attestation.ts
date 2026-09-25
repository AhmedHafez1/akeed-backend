/**
 * The consent statement merchants ticked before starting an import, until the
 * start stopped asking for one. Kept as the record of what batches with an
 * `attestation_version` agreed to; nothing reads it at runtime. Never edit.
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
