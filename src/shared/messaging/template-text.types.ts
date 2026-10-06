import type { TemplateButtonKind } from './template-provider.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
  TemplateVariableKey,
} from './template-registry.types';

/**
 * One piece of a template's text: literal text, or the place a value goes.
 * `parameter` is the provider's parameter name, or its position written as a
 * string (`'1'`, `'2'`).
 */
export type TemplateTextSegment = { text: string } | { parameter: string };

/**
 * A template's text as the provider holds it, with the provider's placeholder
 * syntax already read. Only the provider adapter builds one; everything else
 * works on segments and never parses the provider's text.
 */
export interface TemplateTextModel {
  /** `none` is a template without any parameter. */
  format: TemplateParameterFormat | 'none';
  header?: TemplateTextSegment[];
  body: TemplateTextSegment[];
  footer?: TemplateTextSegment[];
  buttons: { kind: TemplateButtonKind; text: string }[];
}

/** A message ready to show: lines of text and button labels, nothing else. */
export interface RenderedTemplateMessage {
  paragraphs: string[];
  buttons: { label: string; kind: TemplateButtonKind }[];
  /** The direction of the template's own language, not of the page. */
  direction: 'rtl' | 'ltr';
}

export function templateDirection(language: TemplateLanguage): 'rtl' | 'ltr' {
  return language === 'ar' ? 'rtl' : 'ltr';
}

/**
 * A message as merchants preview it (US-08-07g): lines of literal text and
 * the places a value goes, and the button labels. The client fills the
 * values, so a preview shows the merchant's own store name. `source` says
 * whether it was read from the provider's synced text or from the stored
 * preview; the client renders both the same way.
 */
export type TemplateMessageSegment =
  | { text: string }
  | { variable: TemplateVariableKey };

export interface TemplateMessageLines {
  lines: TemplateMessageSegment[][];
  buttons: string[];
  direction: 'rtl' | 'ltr';
  source: 'provider' | 'registered';
}
