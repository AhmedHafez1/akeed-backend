import type { TemplateComponentsSnapshot } from '../../../shared/messaging/template-provider.types';
import type {
  TemplateTextModel,
  TemplateTextSegment,
} from '../../../shared/messaging/template-text.types';

/** Meta's placeholder: `{{name}}` or `{{1}}` (record 4.6.2, 4.6.3). */
const PLACEHOLDER = /{{\s*([A-Za-z0-9_]+)\s*}}/g;

function toSegments(text: string): TemplateTextSegment[] {
  const segments: TemplateTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index) });
    }
    segments.push({ parameter: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/**
 * Reads Meta's placeholder syntax out of a synced snapshot, so nothing outside
 * the spoke parses Meta's text. A template whose placeholders are all numbers
 * is positional (record 4.6.1); any name makes it named. NULL when there is no
 * snapshot or it could not be read.
 */
export function describeMetaComponents(
  snapshot: TemplateComponentsSnapshot | null,
): TemplateTextModel | null {
  if (!snapshot || 'unknown' in snapshot) return null;
  const header =
    snapshot.header !== undefined ? toSegments(snapshot.header) : undefined;
  const body = toSegments(snapshot.body);
  const footer =
    snapshot.footer !== undefined ? toSegments(snapshot.footer) : undefined;
  const parameters = [header, body, footer].flatMap((segments) =>
    (segments ?? []).flatMap((segment) =>
      'parameter' in segment ? [segment.parameter] : [],
    ),
  );
  return {
    format:
      parameters.length === 0
        ? 'none'
        : parameters.every((parameter) => /^\d+$/.test(parameter))
          ? 'positional'
          : 'named',
    ...(header ? { header } : {}),
    body,
    ...(footer ? { footer } : {}),
    buttons: snapshot.buttons.map((button) => ({ ...button })),
  };
}
