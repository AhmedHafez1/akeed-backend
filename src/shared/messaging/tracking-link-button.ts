import type { TemplateSubmissionButton } from './template-draft.types';
import type {
  TemplateTextButton,
  TemplateTextSegment,
} from './template-text.types';

/**
 * The Shipped message's Track order button: a link to Akeed's short link
 * page, `<base>/t/<code>`. The provider fixes the start of the link when it
 * approves the template; only the code at the end is filled at send time.
 */
export const TRACKING_LINK_PATH = '/t/';
/**
 * The parameter at the end of the link, in a named template too: a link
 * button is filled by position only. The provider approves a named one but
 * keeps it as plain text, so every message would open the same dead link.
 */
export const TRACKING_LINK_PARAMETER = '1';
/** A well-formed sample code for the provider's review. */
export const TRACKING_LINK_SAMPLE_CODE = 'Xk3pQ9vT2mLr8sYwB4nHcA';

export function trackingLinkStart(base: string): string {
  return `${base.replace(/\/+$/, '')}${TRACKING_LINK_PATH}`;
}

export function trackingLinkButton(
  label: string,
  base: string,
): Extract<TemplateSubmissionButton, { kind: 'url' }> {
  const start = trackingLinkStart(base);
  return {
    kind: 'url',
    text: label,
    url: [{ text: start }, { parameter: TRACKING_LINK_PARAMETER }],
    example: `${start}${TRACKING_LINK_SAMPLE_CODE}`,
  };
}

/**
 * Where a template's link button is and what its link needs at send time.
 * `parameter` is the provider parameter at the end of the link, or null for
 * a fixed link. Null when the template has no link button.
 */
export interface TemplateLinkButtonSlot {
  /** The button's position among all the template's buttons. */
  index: number;
  start: string;
  parameter: string | null;
}

export function findLinkButtonSlot(
  buttons: readonly TemplateTextButton[],
): TemplateLinkButtonSlot | null {
  const index = buttons.findIndex((button) => button.kind === 'url');
  if (index < 0) return null;
  const segments: readonly TemplateTextSegment[] = buttons[index].url ?? [];
  const last = segments.at(-1);
  const parameter = last && 'parameter' in last ? last.parameter : null;
  const start = segments
    .flatMap((segment) => ('text' in segment ? [segment.text] : []))
    .join('');
  return { index, start, parameter };
}
