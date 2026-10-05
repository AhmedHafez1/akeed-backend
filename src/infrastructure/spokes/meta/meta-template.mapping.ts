import type {
  TemplateButtonKind,
  TemplateCategory,
  TemplateComponentsSnapshot,
  TemplateQuality,
  TemplateReviewStatus,
} from '../../../shared/messaging/template-provider.types';

/**
 * Meta's template vocabulary and its neutral meaning. This file is the only
 * place Meta's status, event, category and quality strings appear; every
 * table comes from the US-08-01 contract record, and any value the record
 * does not list maps to `unknown`, which is never sendable.
 */

/** API `status` values (record 4.2.1). `ARCHIVED` is a filter value too. */
const API_STATUS: Record<string, TemplateReviewStatus> = {
  APPROVED: 'approved',
  IN_APPEAL: 'in_appeal',
  PENDING: 'pending',
  REJECTED: 'rejected',
  PENDING_DELETION: 'pending_deletion',
  DELETED: 'deleted',
  DISABLED: 'disabled',
  PAUSED: 'paused',
  LIMIT_EXCEEDED: 'limit_exceeded',
  ARCHIVED: 'archived',
};

/**
 * Webhook `event` values (record 4.8.7). `FLAGGED`, `LOCKED`, `REINSTATED`
 * and `UNARCHIVED` have no documented meaning for sending (4.2.11, 4.2.12):
 * they are carried as their own neutral values, none of which is sendable,
 * and the receiver asks for a sync to read the real status.
 */
const WEBHOOK_EVENT: Record<string, TemplateReviewStatus> = {
  APPROVED: 'approved',
  ARCHIVED: 'archived',
  UNARCHIVED: 'unarchived',
  DELETED: 'deleted',
  DISABLED: 'disabled',
  FLAGGED: 'flagged',
  IN_APPEAL: 'in_appeal',
  LIMIT_EXCEEDED: 'limit_exceeded',
  LOCKED: 'locked',
  PAUSED: 'paused',
  PENDING: 'pending',
  REINSTATED: 'reinstated',
  PENDING_DELETION: 'pending_deletion',
  REJECTED: 'rejected',
};

/** Record 4.5.1. */
const CATEGORY: Record<string, TemplateCategory> = {
  AUTHENTICATION: 'authentication',
  MARKETING: 'marketing',
  UTILITY: 'utility',
};

/** Record 4.5.2: `UNKNOWN` is Meta's "quality pending" for a new template. */
const QUALITY: Record<string, TemplateQuality> = {
  GREEN: 'high',
  YELLOW: 'medium',
  RED: 'low',
  UNKNOWN: 'pending',
};

function lookup<T extends string>(
  table: Record<string, T>,
  value: unknown,
  fallback: T,
): T {
  return typeof value === 'string' && Object.hasOwn(table, value)
    ? table[value]
    : fallback;
}

export function mapApiStatus(value: unknown): TemplateReviewStatus {
  return lookup(API_STATUS, value, 'unknown');
}

export function mapWebhookEvent(value: unknown): TemplateReviewStatus {
  return lookup(WEBHOOK_EVENT, value, 'unknown');
}

export function mapCategory(value: unknown): TemplateCategory {
  return lookup(CATEGORY, value, 'unknown');
}

/**
 * Reads a quality score. The list response carries it as `{ score, date }`
 * (record 3.2, VERIFIED on the dev app); webhooks carry the bare string
 * (record 4.8.9). Any other shape or value is `unknown`. Quality never decides
 * whether a template may be sent.
 */
export function mapQuality(value: unknown): TemplateQuality {
  const score = asRecord(value)?.score ?? value;
  return lookup(QUALITY, score, 'unknown');
}

/**
 * Meta writes language codes with `_` in the API and sometimes with `-` in
 * webhooks (record 4.8.16). Both are read as the same code.
 */
export function normalizeLanguageCode(value: string): string {
  return value.trim().replaceAll('-', '_');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buttonKind(type: unknown): TemplateButtonKind {
  return typeof type === 'string' && type.toUpperCase() === 'QUICK_REPLY'
    ? 'quick_reply'
    : 'other';
}

/**
 * Reads `components` in the creation syntax the record documents (S2, 4.7.5):
 * `BODY`, optional text `HEADER` and `FOOTER`, and a `BUTTONS` component of
 * `{ type, text }`. Anything else, including a header that is not text, makes
 * the whole snapshot `unknown` rather than a partial guess (PROVISIONAL until
 * the US-08-01 live run captures a list response).
 */
export function mapComponents(value: unknown): TemplateComponentsSnapshot {
  const unknown = { unknown: true } as const;
  if (!Array.isArray(value)) return unknown;
  let header: string | undefined;
  let body: string | undefined;
  let footer: string | undefined;
  const buttons: { kind: TemplateButtonKind; text: string }[] = [];
  for (const item of value) {
    const component = asRecord(item);
    if (!component || typeof component.type !== 'string') return unknown;
    const type = component.type.toUpperCase();
    if (type === 'BUTTONS') {
      if (!Array.isArray(component.buttons)) return unknown;
      for (const entry of component.buttons) {
        const button = asRecord(entry);
        if (!button || typeof button.text !== 'string') return unknown;
        buttons.push({ kind: buttonKind(button.type), text: button.text });
      }
      continue;
    }
    if (typeof component.text !== 'string') return unknown;
    if (type === 'BODY') body = component.text;
    else if (type === 'HEADER') header = component.text;
    else if (type === 'FOOTER') footer = component.text;
    else return unknown;
  }
  if (body === undefined) return unknown;
  return {
    ...(header !== undefined ? { header } : {}),
    body,
    ...(footer !== undefined ? { footer } : {}),
    buttons,
  };
}

/** Graph error codes for template management (record 4.1.11). */
export const RATE_LIMIT_ERROR_CODES: ReadonlySet<number> = new Set([
  4, 80007, 80008,
]);
export const TOKEN_ERROR_CODE = 190;

/** Record 4.1 rule: 10 and 200 to 299 mean the token cannot manage templates. */
export function isPermissionErrorCode(code: number): boolean {
  return code === 10 || (code >= 200 && code <= 299);
}
