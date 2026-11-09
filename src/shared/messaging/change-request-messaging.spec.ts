import { randomUUID } from 'node:crypto';
import {
  CHANGE_BUTTON_LABELS,
  changeAcknowledgment,
  customerButtonPayload,
  customerRecipientHash,
  resolveCustomerActionPayload,
  changeTemplateUsable,
} from './change-request-messaging';
import { TEMPLATE_LANGUAGES } from './template-registry.types';
import { seededRegistryTemplates } from './testing/seeded-template-registry';
import { selectTemplateForSend, toSelectedTemplate } from './template-selector';
import {
  toTemplateSubmission,
  validateButtons,
} from './template-draft.validation';

describe('change-request messaging contracts', () => {
  it.each(TEMPLATE_LANGUAGES)(
    'has a usable label and fixed localized receipt with both identifiers (%s)',
    (language) => {
      expect(CHANGE_BUTTON_LABELS[language].length).toBeLessThanOrEqual(25);
      const text = changeAcknowledgment(
        language,
        `${language}.standard`,
        'STORE-42',
        'ORDER-91',
      );
      expect(text).toContain('STORE-42');
      expect(text).toContain('ORDER-91');
      expect(text.length).toBeLessThanOrEqual(4096);
    },
  );
  it('keeps Arabic dialect snapshots and the exact approved third label', () => {
    expect(CHANGE_BUTTON_LABELS.ar).toBe('طلب تعديل');
    expect(changeAcknowledgment('ar', 'ar.egyptian', 'STORE', '42')).toContain(
      'هيتواصل معاك',
    );
    expect(changeAcknowledgment('ar', 'ar.gulf', 'STORE', '42')).toContain(
      'بيتواصل معك',
    );
  });
  it.each(['confirmed', 'canceled', 'change_requested'] as const)(
    'round trips %s without accepting ambiguous payloads',
    (action) => {
      const id = randomUUID();
      expect(
        resolveCustomerActionPayload(customerButtonPayload(action, id, 2)),
      ).toEqual({ intent: action, verificationId: id, cycle: 2 });
      for (const suffix of ['|more', '|', 'x'])
        expect(
          resolveCustomerActionPayload(
            customerButtonPayload(action, id, 2) + suffix,
          ),
        ).toBeNull();
      expect(resolveCustomerActionPayload(`cr1|${action}|${id}|0`)).toBeNull();
    },
  );
  it('retains legacy callbacks and normalizes recipient formatting', () => {
    expect(resolveCustomerActionPayload('confirm_legacy')).toEqual({
      intent: 'confirmed',
      verificationId: 'legacy',
    });
    expect(customerRecipientHash('+20 100 000 0000')).toBe(
      customerRecipientHash('201000000000'),
    );
    expect(customerRecipientHash('bad')).toBeNull();
  });
  it('never mistakes a prepared definition for approval or offers it through the ordinary selector', () => {
    const original = seededRegistryTemplates()[0];
    const sibling = {
      ...original,
      key: `${original.key}_change_v1`,
      style: 'change_v1',
      changeRequestOfKey: original.key,
      isDefault: false,
      components: {
        body: 'Order',
        buttons: [
          {
            kind: 'quick_reply' as const,
            text: original.preview.confirmButton,
          },
          { kind: 'quick_reply' as const, text: original.preview.cancelButton },
          {
            kind: 'quick_reply' as const,
            text: CHANGE_BUTTON_LABELS[original.language],
          },
        ],
      },
    };
    expect(changeTemplateUsable(sibling)).toBe(false);
    const approved = {
      ...sibling,
      reviewStatus: 'approved' as const,
      category: 'utility' as const,
      lastSyncedAt: new Date().toISOString(),
    };
    expect(changeTemplateUsable(approved)).toBe(true);
    expect(
      changeTemplateUsable({
        ...approved,
        components: {
          body: 'Order',
          buttons: approved.components.buttons.slice().reverse(),
        },
      }),
    ).toBe(false);
    expect(
      selectTemplateForSend([original, approved], {
        preferredLanguage: original.language,
        phoneNumber: '+201000000000',
      }).template,
    ).toEqual(toSelectedTemplate(original));
  });
  it('submits three buttons in the required order while leaving ordinary drafts at two', () => {
    const content = {
      purpose: 'cod_confirmation' as const,
      language: 'en' as const,
      style: 'friendly',
      version: 2,
      templateName: 'akeed_cod_confirm_friendly_v2',
      languageCode: 'en',
      parameterFormat: 'named' as const,
      category: 'utility' as const,
      body: 'Order {{order}}',
      confirmLabel: 'Confirm',
      cancelLabel: 'Cancel',
      changeLabel: 'Request a change',
      samples: { order: '42' },
    };
    const submission = toTemplateSubmission(content);
    expect(submission.buttons.map((button) => button.text)).toEqual([
      'Confirm',
      'Cancel',
      'Request a change',
    ]);
    expect(
      validateButtons(content.purpose, submission.buttons, content),
    ).toEqual([]);
    expect(
      toTemplateSubmission({ ...content, changeLabel: null }).buttons,
    ).toHaveLength(2);
  });
});
