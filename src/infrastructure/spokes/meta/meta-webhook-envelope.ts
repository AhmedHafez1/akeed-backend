import { createHash } from 'node:crypto';
import type { NewMetaWebhookEvent } from '../../database/repositories/meta-webhook-events.repository';

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/**
 * Parses the signed body. `message_template_id` is an integer that can be
 * larger than 2^53, so its source text is kept as a string
 * instead of a rounded number.
 */
export function parseBody(rawBody: Buffer): unknown {
  return JSON.parse(
    rawBody.toString('utf8'),
    (key: string, value: unknown, context?: { source?: string }) =>
      key === 'message_template_id' && typeof value === 'number'
        ? (context?.source ?? String(value))
        : value,
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A change's identity. Meta sends no event ID, so it is the field, `entry.id`,
 * `entry.time` and a hash of `value`. The time matters: the same template
 * value can legitimately recur.
 */
export function changeIdentity(
  field: unknown,
  entryId: unknown,
  time: unknown,
  value: unknown,
): string {
  return createHash('sha256')
    .update(
      [
        field,
        entryId,
        String(time),
        createHash('sha256').update(canonicalJson(value)).digest('hex'),
      ].join('|'),
    )
    .digest('hex');
}

function rawEvent(rawBody: Buffer): NewMetaWebhookEvent {
  return {
    dedupeHash: createHash('sha256').update(rawBody).digest('hex'),
    field: null,
    wabaId: null,
    phoneNumberId: null,
    payload: rawBody.toString('utf8'),
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One event per change, each a body of one entry and one change that the
 * handlers read as they read a whole delivery. Anything that cannot be split
 * is kept too, as one event holding the body: the signed POST was accepted, so
 * it stays visible, and the worker marks it failed.
 */
export function splitWebhookBody(rawBody: Buffer): NewMetaWebhookEvent[] {
  let body: JsonRecord | null;
  try {
    body = asRecord(parseBody(rawBody));
  } catch {
    return [rawEvent(rawBody)];
  }
  const entries: unknown[] = Array.isArray(body?.entry) ? body.entry : [];
  const events: NewMetaWebhookEvent[] = [];
  let complete = entries.length > 0;
  for (const item of entries) {
    const entry = asRecord(item);
    const changes: unknown[] = Array.isArray(entry?.changes)
      ? entry.changes
      : [];
    if (!entry || changes.length === 0) complete = false;
    for (const item of changes) {
      const change = asRecord(item);
      if (!entry || !change) {
        complete = false;
        continue;
      }
      const metadata = asRecord(asRecord(change.value)?.metadata);
      events.push({
        dedupeHash: changeIdentity(
          change.field,
          entry.id,
          entry.time,
          change.value,
        ),
        field: textOrNull(change.field),
        wabaId: textOrNull(entry.id),
        phoneNumberId: textOrNull(metadata?.phone_number_id),
        payload: JSON.stringify({
          object: body?.object,
          entry: [{ id: entry.id, time: entry.time, changes: [change] }],
        }),
      });
    }
  }
  return complete ? events : [...events, rawEvent(rawBody)];
}

/** Whether a stored payload is one entry and one change, or a kept body. */
export function isSingleChange(payload: unknown): boolean {
  const entries = asRecord(payload)?.entry;
  if (!Array.isArray(entries) || entries.length !== 1) return false;
  const changes = asRecord(entries[0])?.changes;
  return (
    Array.isArray(changes) &&
    changes.length === 1 &&
    asRecord(changes[0]) !== null
  );
}
