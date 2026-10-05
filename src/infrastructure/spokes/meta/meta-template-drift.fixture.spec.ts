import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareTemplateDrift } from '../../../shared/messaging/template-drift';
import { renderTemplateMessage } from '../../../shared/messaging/template-rendering';
import { seededRegistryTemplates } from '../../../shared/messaging/testing/seeded-template-registry';
import { describeMetaComponents } from './meta-template-text';
import { mapApiStatus, mapComponents } from './meta-template.mapping';

interface CapturedTemplate {
  name: string;
  language: string;
  status: string;
  components: unknown;
}

/** The list response captured from the dev app, sanitized (US-08-01). */
const captured = (
  JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../test/fixtures/whatsapp-templates/template-list.json',
      ),
      'utf8',
    ),
  ) as { payload: { data: CapturedTemplate[] } }
).payload.data;

/** Each seeded registry row as one sync of the captured account leaves it. */
const synced = seededRegistryTemplates().map((template) => {
  const record = captured.find(
    (entry) =>
      entry.name === template.templateName &&
      entry.language === template.languageCode,
  );
  const reviewStatus = record ? mapApiStatus(record.status) : 'missing';
  const model = record
    ? describeMetaComponents(mapComponents(record.components))
    : null;
  return {
    template: {
      ...template,
      reviewStatus,
      lastSyncedAt: '2026-10-05T19:57:36.000Z',
    },
    model,
  };
});

describe('drift against the templates the dev app holds (US-08-01 run)', () => {
  it('finds only a text difference on the seven templates Meta holds', () => {
    const found = synced.filter(({ model }) => model !== null);

    expect(found).toHaveLength(7);
    for (const { template, model } of found) {
      const drift = compareTemplateDrift({
        template,
        reviewStatus: template.reviewStatus,
        model,
      });
      expect([template.key, drift.state, drift.differences.length]).toEqual([
        template.key,
        'drift',
        1,
      ]);
      expect(drift.differences[0]).toMatchObject({
        kind: 'body',
        severity: 'preview',
      });
    }
  });

  it('reports en/direct as missing: Meta holds no template under its name', () => {
    const missing = synced.filter(({ model }) => model === null);

    expect(missing.map(({ template }) => template.key)).toEqual([
      'cod_confirm.en.direct',
    ]);
    expect(
      compareTemplateDrift({
        template: missing[0].template,
        reviewStatus: missing[0].template.reviewStatus,
        model: null,
      }),
    ).toEqual({ state: 'missing', differences: [] });
  });

  it('renders every held template without an unfilled parameter', () => {
    for (const { template, model } of synced) {
      if (!model) continue;
      const rendered = renderTemplateMessage(model, template);

      expect(rendered.buttons).toHaveLength(2);
      expect(rendered.direction).toBe(
        template.language === 'ar' ? 'rtl' : 'ltr',
      );
      expect(rendered.paragraphs.join('\n')).not.toMatch(/\[|{{/);
      expect(rendered.paragraphs.join('\n')).toContain('TEST-1');
    }
  });
});
