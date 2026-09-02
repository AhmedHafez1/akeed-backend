import type { CodStatus } from '../interfaces/commerce-source.interface';

const COD_MATCHERS: RegExp[] = [
  /\bcod\b/i,
  /\bcash\s*on\s*delivery\b/i,
  /\bcash\s*on\s*receipt\b/i,
  /\bcollect\s*on\s*delivery\b/i,
  /\bpay\s*on\s*delivery\b/i,
  /\u0627\u0644\u062f\u0641\u0639\s*\u0639\u0646\u062f\s*\u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645/i,
  /\u0643\u0627\u0634\s*\u0639\u0646\u062f\s*\u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645/i,
];

export function normalizePaymentSignal(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function appendPaymentSignal(target: string[], value?: unknown): void {
  if (typeof value !== 'string' || !value) return;

  const normalized = normalizePaymentSignal(value);
  if (normalized && !target.includes(normalized)) target.push(normalized);
}

export function isCashOnDeliveryPaymentSignal(signal: string): boolean {
  const normalized = normalizePaymentSignal(signal);
  return COD_MATCHERS.some((matcher) => matcher.test(normalized));
}

export function classifyCodStatus(signals: readonly string[]): CodStatus {
  if (signals.length === 0) return 'unknown';
  return signals.some(isCashOnDeliveryPaymentSignal) ? 'cod' : 'non_cod';
}
