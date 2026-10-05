import type { TemplateButtonKind } from './template-provider.types';
import type {
  TemplateLanguage,
  TemplateParameterFormat,
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
