import type { TemplateLanguage } from './template-registry.types';

/**
 * Free-form copy staff manage (US-08-07). Not a provider template: these are
 * sent as plain text inside the customer service window, or used as words in
 * a template's values.
 *
 * - `ack_confirmed`, `ack_canceled`: the acknowledgment after a customer
 *   confirms or cancels.
 * - `unresolved_reply_nudge`: the nudge after a typed reply Akeed could not
 *   read.
 * - `fallback_customer_name`, `fallback_store_name`: the word used when a
 *   customer or store name is missing.
 */
export type MessageTextPurpose =
  | 'ack_confirmed'
  | 'ack_canceled'
  | 'unresolved_reply_nudge'
  | 'fallback_customer_name'
  | 'fallback_store_name';

export const MESSAGE_TEXT_PURPOSES = [
  'ack_confirmed',
  'ack_canceled',
  'unresolved_reply_nudge',
  'fallback_customer_name',
  'fallback_store_name',
] as const satisfies readonly MessageTextPurpose[];

/** The style every language has; a dialect style overrides it. */
export const DEFAULT_MESSAGE_TEXT_STYLE = 'default';

/** Record 4.10.4: a text message body holds at most 4096 characters. */
export const MESSAGE_TEXT_MAX_LENGTH = 4096;

/** A style is `default` or a template style, for example `egyptian`. */
export const MESSAGE_TEXT_STYLE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export interface MessageText {
  id: string;
  purpose: MessageTextPurpose;
  language: TemplateLanguage;
  style: string;
  /** Akeed's own placeholders, `{{order}}` and `{{store}}`. */
  body: string;
  isActive: boolean;
  updatedAt: string;
}

/** An acknowledgment or a nudge: a free-form message sent to a customer. */
export type ServiceMessageKind = 'acknowledgment' | 'nudge';

export type ServiceMessageState = 'claimed' | 'sent' | 'skipped' | 'failed';

/**
 * Why a service message was not sent.
 *
 * - `outside_window`: the customer's message is older than the window.
 * - `window_closed`: the provider refused it because the window had closed.
 * - `text_unavailable`: no active text for the language.
 * - `provider_rejected`: the provider refused it for another reason.
 * - `provider_error`: no clear answer from the provider. Never retried.
 * - `delivery_failed`: the provider accepted it, then reported it failed.
 */
export type ServiceMessageSkipReason =
  | 'outside_window'
  | 'window_closed'
  | 'text_unavailable'
  | 'provider_rejected'
  | 'provider_error'
  | 'delivery_failed';

/** Record 4.10.1 and 4.10.3: the customer service window. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const TEXT_TOKEN = /{{\s*([a-z_]+)\s*}}/gi;

/**
 * Fills `{{order}}` and `{{store}}` in a free-form text. A placeholder with no
 * value is left as written, so a typo in staff copy shows up in review and
 * never turns into an empty gap.
 */
export function fillMessageText(
  body: string,
  values: Readonly<Record<string, string>>,
): string {
  return body.replace(TEXT_TOKEN, (token, key: string) => {
    const name = key.toLowerCase();
    return Object.hasOwn(values, name) ? values[name] : token;
  });
}
