export const SENDER_ALERT_KINDS = [
  'fallback',
  'disconnect',
  'template_rejection',
  'quality_drop',
  'payment',
] as const;
export type SenderAlertKind = (typeof SENDER_ALERT_KINDS)[number];
export type SenderAlertReason =
  | 'primary_inactivity'
  | 'offboarded'
  | 'disconnected'
  | 'payment'
  | 'red'
  | 'recategorized'
  | 'unavailable'
  | 'credentials'
  | 'restricted'
  | 'sender_unavailable';
export interface SenderAlertTemplate {
  key: string;
  language: string;
  status: string;
  category: string | null;
}
export interface SenderAlert {
  kind: SenderAlertKind;
  reason: SenderAlertReason;
  severity: 'warning' | 'critical';
  action: 'reconnect' | 'whatsapp_manager' | 'review_templates' | 'none';
  templates: SenderAlertTemplate[];
}
export interface SenderAlertFacts {
  state: string;
  stateReason: string | null;
  degradedClass: string | null;
  qualityRating: string | null;
  templates: SenderAlertTemplate[];
  fallback: { reason: string; at: string } | null;
  merchantAcceptedAt: string | null;
  /** From the connection row. Absent for callers that only need banners. */
  setupStatus?: string;
  connectedAt?: string | null;
  createdAt?: string | null;
}

/** Current facts, rather than event arrival order, decide the banners. */
export function senderAlerts(
  facts: SenderAlertFacts,
  sendingEnabled: boolean,
): SenderAlert[] {
  const result: SenderAlert[] = [];
  const add = (
    kind: SenderAlertKind,
    reason: SenderAlertReason,
    action: SenderAlert['action'],
    severity: SenderAlert['severity'] = 'warning',
    templates: SenderAlertTemplate[] = [],
  ) => result.push({ kind, reason, action, severity, templates });
  if (
    ['disconnected', 'offboarded'].includes(facts.state) ||
    (facts.state === 'verifying' && facts.stateReason === 'ACCOUNT_RECONNECTED')
  )
    add(
      'disconnect',
      facts.stateReason === 'PRIMARY_INACTIVITY'
        ? 'primary_inactivity'
        : facts.state === 'offboarded'
          ? 'offboarded'
          : 'disconnected',
      'reconnect',
      'critical',
    );
  if (facts.degradedClass === 'payment')
    add('payment', 'payment', 'whatsapp_manager');
  if (facts.qualityRating === 'RED')
    add('quality_drop', 'red', 'whatsapp_manager');
  const affected = facts.templates.filter(
    (t) =>
      ['rejected', 'paused', 'disabled'].includes(t.status) ||
      t.category === 'marketing',
  );
  if (!['disconnected', 'offboarded'].includes(facts.state) && affected.length)
    add(
      'template_rejection',
      affected.some((t) => t.category === 'marketing')
        ? 'recategorized'
        : 'unavailable',
      'review_templates',
      'warning',
      affected,
    );
  const fallback = facts.fallback;
  if (
    sendingEnabled &&
    (['credentials', 'restricted'].includes(facts.degradedClass ?? '') ||
      (fallback &&
        (!facts.merchantAcceptedAt ||
          Date.parse(fallback.at) > Date.parse(facts.merchantAcceptedAt))))
  ) {
    const credentials = facts.degradedClass === 'credentials';
    const restricted = facts.degradedClass === 'restricted';
    add(
      'fallback',
      credentials
        ? 'credentials'
        : restricted
          ? 'restricted'
          : 'sender_unavailable',
      credentials ? 'reconnect' : 'none',
    );
  }
  return result;
}

/** Meta usually answers a template review within a day; three days is a stall. */
export const FIRST_TIME_WINDOW_MS = 72 * 60 * 60 * 1000;
const SETTLED_TEMPLATE_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'rejected',
  'paused',
  'disabled',
]);

/**
 * A number that has never been active and is still being set up or waiting
 * for Meta's template review. Akeed sending in its place is expected then, so
 * the "fallback" email is held back. A number that was active stays `active`
 * when it degrades, so it is never in this window. Without connection
 * timestamps the window cannot be judged and is reported as closed.
 */
export function inFirstTimeWindow(
  facts: SenderAlertFacts,
  now: number = Date.now(),
): boolean {
  if (
    !['connecting', 'verifying'].includes(facts.state) ||
    facts.stateReason === 'ACCOUNT_RECONNECTED'
  )
    return false;
  const since = Date.parse(facts.connectedAt ?? facts.createdAt ?? '');
  if (!Number.isFinite(since) || now - since >= FIRST_TIME_WINDOW_MS)
    return false;
  return (
    facts.setupStatus !== 'complete' ||
    facts.templates.some((t) => !SETTLED_TEMPLATE_STATUSES.has(t.status))
  );
}

export function suppressFallbackEmail(alerts: readonly SenderAlert[]): boolean {
  return alerts.some((a) =>
    ['disconnect', 'payment', 'template_rejection'].includes(a.kind),
  );
}
