import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIRECTORY = resolve(__dirname, 'orders-updated');
const MINUTE = 60_000;
const DAY = 86_400_000;

export interface ReplayDelivery {
  webhookId: string;
  payload: string;
  updatedMinutesAgo: number;
  createdDaysAgo?: number;
  cancelled?: boolean;
}

export interface ReplayRecord {
  trigger: 'fulfillment' | 'tag';
  status: string;
  reasonCode: string | null;
  matchedTag: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

export interface ReplayScenario {
  name: string;
  envEnabled?: boolean;
  unknownOrder?: boolean;
  store: { enabled: boolean; fulfillmentTrigger: boolean; tags: string[] };
  deliveries: ReplayDelivery[];
  intake: { stored: boolean; duplicate: boolean }[];
  /** `handled`, or the reason the processing step skipped the delivery. */
  results: string[];
  record: ReplayRecord | null;
  enqueued: number;
}

export function replayScenarios(): ReplayScenario[] {
  const file = JSON.parse(
    readFileSync(resolve(DIRECTORY, 'scenarios.json'), 'utf8'),
  ) as { scenarios: ReplayScenario[] };
  return file.scenarios;
}

function fill(value: unknown, tokens: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value in tokens) return tokens[value];
  if (Array.isArray(value)) return value.map((item) => fill(item, tokens));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, tokens)]),
    );
  return value;
}

/**
 * The delivery's synthetic payload for one order. Dates are computed from
 * `now`, so a fixture never ages past the 30-day rule.
 */
export function replayPayload(
  delivery: ReplayDelivery,
  orderId: string,
  now = Date.now(),
): Record<string, unknown> {
  const fixture = JSON.parse(
    readFileSync(resolve(DIRECTORY, delivery.payload), 'utf8'),
  ) as { payload: Record<string, unknown> };
  return fill(fixture.payload, {
    '{{orderId}}': orderId,
    '{{createdAt}}': new Date(
      now - (delivery.createdDaysAgo ?? 1) * DAY,
    ).toISOString(),
    '{{updatedAt}}': new Date(
      now - delivery.updatedMinutesAgo * MINUTE,
    ).toISOString(),
    '{{cancelledAt}}': delivery.cancelled
      ? new Date(now - MINUTE).toISOString()
      : null,
  }) as Record<string, unknown>;
}
