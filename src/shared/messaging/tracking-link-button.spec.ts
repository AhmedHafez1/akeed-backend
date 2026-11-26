import type { TemplateDraftContent } from './template-draft.types';
import {
  toTemplateSubmission,
  validateTemplateDraft,
} from './template-draft.validation';
import { planTemplateCopy } from './template-copy.policy';
import { compareTemplateDrift } from './template-drift';
import type { RegistryTemplate } from './template-registry.types';
import type { TemplateTextModel } from './template-text.types';
import {
  TRACKING_LINK_SAMPLE_CODE,
  findLinkButtonSlot,
  trackingLinkButton,
} from './tracking-link-button';
import { isWellFormedShippingTrackingCode } from '../shipping/shipping-tracking-code';

const BASE = 'https://getakeed.com';

function shippedDraft(
  overrides: Partial<TemplateDraftContent> = {},
): TemplateDraftContent {
  return {
    purpose: 'shipping_shipped',
    language: 'en',
    style: 'default',
    version: 1,
    templateName: 'akeed_shipping_shipped_default_v1',
    languageCode: 'en',
    parameterFormat: 'named',
    category: 'utility',
    body: [
      'Hello {{customer}},',
      'Your order {{order}} from {{store}} is on its way.',
      '{{tracking}}',
      'Please have {{total}} ready in cash and keep your phone on so the courier can reach you.',
    ].join('\n'),
    confirmLabel: "I'll receive it",
    cancelLabel: "Won't be available",
    changeLabel: 'Change address',
    linkLabel: 'Track order',
    samples: {
      customer: 'Ahmed',
      order: 'TEST-1',
      store: 'Akeed Store',
      total: '250.00 EGP',
      tracking: 'Tracking: 1Z999AA10123456784',
    },
    ...overrides,
  };
}

const rules = (content: TemplateDraftContent) =>
  validateTemplateDraft(content, { takenIdentities: new Set() })
    .issues.filter((issue) => issue.field === 'link_label')
    .map((issue) => issue.rule);

describe('the Track order link button', () => {
  describe('draft validation', () => {
    it('accepts the Shipped draft with its link label', () => {
      const validation = validateTemplateDraft(shippedDraft(), {
        takenIdentities: new Set(),
      });
      expect(validation.issues).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it('requires the link label on a Shipped draft', () => {
      expect(rules(shippedDraft({ linkLabel: null }))).toEqual([
        'button_label_required',
      ]);
      expect(rules(shippedDraft({ linkLabel: '  ' }))).toEqual([
        'button_label_required',
      ]);
    });

    it('limits the label to 25 characters and keeps it distinct', () => {
      expect(rules(shippedDraft({ linkLabel: 'x'.repeat(25) }))).toEqual([]);
      expect(rules(shippedDraft({ linkLabel: 'x'.repeat(26) }))).toEqual([
        'button_label_too_long',
      ]);
      expect(rules(shippedDraft({ linkLabel: 'Change address' }))).toEqual([
        'button_label_too_long',
      ]);
    });

    it('refuses a link label on any other purpose', () => {
      expect(
        rules(
          shippedDraft({
            purpose: 'cod_confirmation',
            body: 'Hello {{customer}}, your order {{order}} from {{store}} comes to {{total}}. Please confirm it.',
            changeLabel: null,
            linkLabel: 'Track order',
          }),
        ),
      ).toEqual(['link_button_not_allowed']);
    });
  });

  describe('submission', () => {
    it('puts the link button after the quick replies when submitting', () => {
      const submission = toTemplateSubmission(shippedDraft(), undefined, {
        trackingLinkBase: BASE,
      });
      expect(submission.buttons).toEqual([
        { kind: 'quick_reply', text: "I'll receive it" },
        { kind: 'quick_reply', text: "Won't be available" },
        { kind: 'quick_reply', text: 'Change address' },
        {
          kind: 'url',
          text: 'Track order',
          url: [{ text: 'https://getakeed.com/t/' }, { parameter: '1' }],
          example: `https://getakeed.com/t/${TRACKING_LINK_SAMPLE_CODE}`,
        },
      ]);
    });

    it('leaves the link out when no origin is given (validation)', () => {
      expect(
        toTemplateSubmission(shippedDraft()).buttons.map((b) => b.kind),
      ).toEqual(['quick_reply', 'quick_reply', 'quick_reply']);
    });

    it('ends the link in a position, whatever the origin looks like', () => {
      expect(trackingLinkButton('Track', `${BASE}/`).url).toEqual([
        { text: 'https://getakeed.com/t/' },
        { parameter: '1' },
      ]);
    });

    it('reviews with a well-formed sample code', () => {
      expect(isWellFormedShippingTrackingCode(TRACKING_LINK_SAMPLE_CODE)).toBe(
        true,
      );
    });
  });

  describe('finding the button at send time', () => {
    it('finds the link button, its index and its parameter', () => {
      expect(
        findLinkButtonSlot([
          { kind: 'quick_reply', text: 'A' },
          { kind: 'quick_reply', text: 'B' },
          { kind: 'quick_reply', text: 'C' },
          {
            kind: 'url',
            text: 'Track order',
            url: [
              { text: 'https://getakeed.com/t/' },
              { parameter: 'tracking_code' },
            ],
          },
        ]),
      ).toEqual({
        index: 3,
        start: 'https://getakeed.com/t/',
        parameter: 'tracking_code',
      });
    });

    it('has nothing to fill without a link button or with a fixed link', () => {
      expect(findLinkButtonSlot([{ kind: 'quick_reply', text: 'A' }])).toBe(
        null,
      );
      expect(
        findLinkButtonSlot([
          { kind: 'url', text: 'Site', url: [{ text: 'https://x.example' }] },
        ]),
      ).toEqual({ index: 0, start: 'https://x.example', parameter: null });
    });
  });

  const shippedModel: TemplateTextModel = {
    format: 'named',
    body: [{ text: 'Hi ' }, { parameter: 'customer' }],
    buttons: [
      { kind: 'quick_reply', text: "I'll receive it" },
      { kind: 'quick_reply', text: "Won't be available" },
      { kind: 'quick_reply', text: 'Change address' },
      {
        kind: 'url',
        text: 'Track order',
        url: [
          { text: 'https://getakeed.com/t/' },
          { parameter: 'tracking_code' },
        ],
      },
    ],
  };

  describe('copy to a merchant account', () => {
    it('carries the link button as the provider holds it', () => {
      const plan = planTemplateCopy(
        {
          language: 'en',
          languageCode: 'en',
          parameterFormat: 'named',
          variables: [{ key: 'customer', name: 'customer' }],
        },
        'utility',
        shippedModel,
        'akeed_shipping_shipped_default_v1',
      );
      expect(plan.kind).toBe('create');
      if (plan.kind !== 'create') return;
      expect(plan.submission.buttons.at(-1)).toEqual({
        kind: 'url',
        text: 'Track order',
        url: [
          { text: 'https://getakeed.com/t/' },
          { parameter: 'tracking_code' },
        ],
        example: `https://getakeed.com/t/${TRACKING_LINK_SAMPLE_CODE}`,
      });
    });

    it('still refuses a phone button', () => {
      expect(
        planTemplateCopy(
          {
            language: 'en',
            languageCode: 'en',
            parameterFormat: 'named',
            variables: [{ key: 'customer', name: 'customer' }],
          },
          'utility',
          {
            ...shippedModel,
            buttons: [{ kind: 'phone', text: 'Call' }],
          },
          'x',
        ),
      ).toEqual({ kind: 'skip', reason: 'non_quick_reply_button' });
    });
  });

  describe('drift', () => {
    const shippedTemplate: RegistryTemplate = {
      key: 'shipping_shipped.en.default_v1',
      purpose: 'shipping_shipped',
      language: 'en',
      style: 'default_v1',
      templateName: 'akeed_shipping_shipped_default_v1',
      languageCode: 'en',
      parameterFormat: 'named',
      variables: [{ key: 'customer', name: 'customer' }],
      preview: {
        greeting: 'Hi {{customer}}',
        body: '',
        totalLabel: '',
        ending: '',
        confirmButton: "I'll receive it",
        cancelButton: "Won't be available",
        changeButton: 'Change address',
        linkButton: 'Track order',
      },
      isActive: true,
      isDefault: true,
      reviewStatus: 'approved',
      category: 'utility',
      lastSyncedAt: '2026-11-25T00:00:00.000Z',
    };
    const buttonDrift = (model: TemplateTextModel) =>
      compareTemplateDrift({
        template: shippedTemplate,
        reviewStatus: 'approved',
        model,
      }).differences.filter((difference) => difference.kind === 'buttons');

    it('accepts three quick replies and the link button', () => {
      expect(buttonDrift(shippedModel)).toEqual([]);
    });

    const withLink = (
      url: TemplateTextModel['buttons'][number]['url'],
    ): TemplateTextModel => ({
      ...shippedModel,
      buttons: [
        ...shippedModel.buttons.slice(0, 3),
        { kind: 'url', text: 'Track order', url },
      ],
    });

    it('reports a link the provider holds as fixed text', () => {
      const held = 'https://getakeed.com/t/%7B%7Btracking_code%7D%7D';

      expect(buttonDrift(withLink([{ text: held }]))).toEqual([
        {
          kind: 'buttons',
          severity: 'send',
          registered: 'url /t/{{1}}',
          provider: `url ${held}`,
        },
      ]);
    });

    it('reports a link that does not end in the tracking page', () => {
      expect(
        buttonDrift(
          withLink([
            { text: 'https://getakeed.com/orders/' },
            { parameter: '1' },
          ]),
        ),
      ).toEqual([
        {
          kind: 'buttons',
          severity: 'send',
          registered: 'url /t/{{1}}',
          provider: 'url https://getakeed.com/orders/{{1}}',
        },
      ]);
    });

    it('reports a Shipped template without its link button', () => {
      expect(
        buttonDrift({
          ...shippedModel,
          buttons: shippedModel.buttons.slice(0, 3),
        }),
      ).toEqual([
        {
          kind: 'buttons',
          severity: 'send',
          registered: 'quick_reply, quick_reply, quick_reply, url',
          provider: 'quick_reply, quick_reply, quick_reply',
        },
      ]);
    });
  });
});
