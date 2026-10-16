import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatOrderTotal } from './message-values';
import { formatItemList } from './order-detail-values';
import { fillMessageText, MESSAGE_TEXT_PURPOSES } from './message-texts.types';
import { STARTER_MESSAGE_TEXTS } from './starter-message-texts';
import {
  STARTER_DRAFT_AUTHOR_ID,
  STARTER_TEMPLATE_DRAFTS,
} from './starter-template-drafts';
import {
  STORE_TEMPLATE_FIELDS,
  storeTemplateKeys,
} from './store-template-selection';
import {
  buildDraftKey,
  buildTemplateName,
  validateTemplateDraft,
} from './template-draft.validation';
import {
  matchCountryLanguage,
  resolveTemplateLanguageForPhone,
} from './template-language';
import { EXPECTED_CATEGORY_BY_PURPOSE } from './template-provider.types';
import {
  TEMPLATE_LANGUAGES,
  type TemplateLanguage,
} from './template-registry.types';
import { templateSampleValues } from './template-rendering';
import {
  isLiveLanguage,
  selectTemplateForSend,
  templatesAwaitingLaunch,
} from './template-selector';
import { templateDirection } from './template-text.types';
import {
  authoredTemplate,
  seededRegistryTemplates,
  syncedApprovedTemplates,
} from './testing/seeded-template-registry';

const PAKISTAN_PHONE = '+923001234567';
const SPAIN_PHONE = '+34612345678';
const MEXICO_PHONE = '+525512345678';
const FRANCE_PHONE = '+33612345678';
const TURKEY_PHONE = '+905321234567';
const EGYPT_PHONE = '+201001112223';
const US_PHONE = '+14155550101';

const seeded = seededRegistryTemplates();
const live = (language: TemplateLanguage, style = 'standard_v1') =>
  authoredTemplate(language, style, {
    isActive: true,
    isDefault: true,
    reviewStatus: 'approved',
  });

describe('message languages', () => {
  it('lists Arabic and English first, then Urdu, Spanish, French and Turkish', () => {
    expect(TEMPLATE_LANGUAGES).toEqual(['ar', 'en', 'ur', 'es', 'fr', 'tr']);
  });

  it('writes Arabic and Urdu right to left, the others left to right', () => {
    expect(TEMPLATE_LANGUAGES.map(templateDirection)).toEqual([
      'rtl',
      'ltr',
      'rtl',
      'ltr',
      'ltr',
      'ltr',
    ]);
  });

  it('keeps the Arabic and English amount as it was and puts the code last elsewhere', () => {
    expect(formatOrderTotal('1250', 'EGP', 'ar')).toBe('1,250.00 ج.م');
    expect(formatOrderTotal('1250', 'EGP', 'en')).toBe('EGP 1,250.00');
    expect(formatOrderTotal('1250', 'PKR', 'ur')).toBe('1,250.00 PKR');
    expect(formatOrderTotal('1250', 'EUR', 'es')).toBe('1,250.00 EUR');
    expect(formatOrderTotal('1250', 'EUR', 'fr')).toBe('1,250.00 EUR');
    expect(formatOrderTotal('1250', 'TRY', 'tr')).toBe('1,250.00 TRY');
  });

  it('has sample values and item wording for every language', () => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      name: `Item ${index + 1}`,
      quantity: 1,
      unitPrice: null,
      options: [],
    }));
    for (const language of TEMPLATE_LANGUAGES) {
      const samples = templateSampleValues(language);
      expect(samples.customer).not.toBe('');
      expect(samples.store).not.toBe('');
      expect(samples.items).not.toBe('');
      expect(formatItemList(items, language)).toContain('+2');
    }
  });
});

describe('resolveTemplateLanguageForPhone', () => {
  const everyLanguageLive = () => true;
  const noLanguageLive = () => false;

  it('sends the language a store forces, whatever the number', () => {
    for (const language of TEMPLATE_LANGUAGES) {
      expect(resolveTemplateLanguageForPhone(language, EGYPT_PHONE)).toBe(
        language,
      );
    }
  });

  it('reads the country of a number', () => {
    expect(matchCountryLanguage(PAKISTAN_PHONE)).toBe('ur');
    expect(matchCountryLanguage(SPAIN_PHONE)).toBe('es');
    expect(matchCountryLanguage(MEXICO_PHONE)).toBe('es');
    expect(matchCountryLanguage('0033612345678')).toBe('fr');
    expect(matchCountryLanguage(TURKEY_PHONE)).toBe('tr');
    expect(matchCountryLanguage(EGYPT_PHONE)).toBeNull();
    expect(matchCountryLanguage(US_PHONE)).toBeNull();
  });

  it('under auto, follows the country once its language is live', () => {
    const resolve = (phone: string) =>
      resolveTemplateLanguageForPhone('auto', phone, everyLanguageLive);
    expect(resolve(PAKISTAN_PHONE)).toBe('ur');
    expect(resolve(SPAIN_PHONE)).toBe('es');
    expect(resolve(FRANCE_PHONE)).toBe('fr');
    expect(resolve(TURKEY_PHONE)).toBe('tr');
    expect(resolve(EGYPT_PHONE)).toBe('ar');
    expect(resolve(US_PHONE)).toBe('en');
  });

  it('under auto, sends +90 in Turkish only while Turkish is live', () => {
    expect(
      resolveTemplateLanguageForPhone(
        'auto',
        TURKEY_PHONE,
        (language) => language === 'tr',
      ),
    ).toBe('tr');
    expect(
      resolveTemplateLanguageForPhone(
        'auto',
        TURKEY_PHONE,
        (language) => language !== 'tr',
      ),
    ).toBe('en');
  });

  it('under auto, keeps English for a country whose language is not live', () => {
    for (const phone of [
      PAKISTAN_PHONE,
      SPAIN_PHONE,
      FRANCE_PHONE,
      TURKEY_PHONE,
    ]) {
      expect(resolveTemplateLanguageForPhone('auto', phone)).toBe('en');
      expect(
        resolveTemplateLanguageForPhone('auto', phone, noLanguageLive),
      ).toBe('en');
    }
    expect(resolveTemplateLanguageForPhone('auto', EGYPT_PHONE)).toBe('ar');
  });
});

describe('a language that is not live', () => {
  const pending = authoredTemplate('ur', 'standard_v1');
  const approvedInactive = authoredTemplate('ur', 'short_v1', {
    reviewStatus: 'approved',
  });
  const rejected = authoredTemplate('ur', 'formal_v1', {
    reviewStatus: 'rejected',
  });
  const retired = authoredTemplate('ur', 'old_v1', {
    reviewStatus: 'approved',
  });
  const templates = [...seeded, pending, approvedInactive, rejected, retired];

  it('is not live while no template is its active default', () => {
    expect(isLiveLanguage(templates, 'ur')).toBe(false);
    expect(isLiveLanguage(templates, 'ar')).toBe(true);
    expect(isLiveLanguage([...seeded, live('ur')], 'ur')).toBe(true);
  });

  it('shows the templates in review and those approved but not switched on', () => {
    expect(
      templatesAwaitingLaunch(templates, 'ur', [retired.key]).map(
        ({ template, reason }) => [template.style, reason],
      ),
    ).toEqual([
      ['standard_v1', 'in_review'],
      ['short_v1', 'not_enabled'],
    ]);
    expect(templatesAwaitingLaunch(templates, 'es')).toEqual([]);
  });

  it('sends English to its country under auto, exactly as before', () => {
    const selection = selectTemplateForSend(templates, {
      preferredLanguage: 'auto',
      phoneNumber: PAKISTAN_PHONE,
      keys: { ur: pending.key },
    });
    expect(selection.template).toMatchObject({ language: 'en' });
  });

  it('skips the send of a store forced to it, and never sends its draft', () => {
    const selection = selectTemplateForSend(templates, {
      preferredLanguage: 'ur',
      phoneNumber: PAKISTAN_PHONE,
      keys: { ur: pending.key },
    });
    expect(selection).toMatchObject({
      template: null,
      language: 'ur',
      reason: 'default_unavailable',
    });
  });
});

describe('a live language', () => {
  const urdu = live('ur');
  const urduShort = authoredTemplate('ur', 'short_v1', {
    isActive: true,
    reviewStatus: 'approved',
  });
  const templates = [
    ...seeded,
    urdu,
    urduShort,
    live('es'),
    live('fr'),
    live('tr'),
  ];

  it('is sent to its country under auto', () => {
    for (const [phone, language] of [
      [PAKISTAN_PHONE, 'ur'],
      [MEXICO_PHONE, 'es'],
      [FRANCE_PHONE, 'fr'],
      [TURKEY_PHONE, 'tr'],
      [EGYPT_PHONE, 'ar'],
      [US_PHONE, 'en'],
    ] as const) {
      expect(
        selectTemplateForSend(templates, {
          preferredLanguage: 'auto',
          phoneNumber: phone,
        }).template,
      ).toMatchObject({ language });
    }
  });

  it('sends the style the store chose for it', () => {
    const selection = selectTemplateForSend(templates, {
      preferredLanguage: 'ur',
      phoneNumber: EGYPT_PHONE,
      keys: { ur: urduShort.key },
    });
    expect(selection.template).toMatchObject({
      language: 'ur',
      variantKey: 'ur.short_v1',
      languageCode: 'ur',
    });
    expect(
      'fallbackReason' in selection && selection.fallbackReason,
    ).toBeFalsy();
  });

  it('falls back to its own default, never to another language', () => {
    const selection = selectTemplateForSend(templates, {
      preferredLanguage: 'ur',
      phoneNumber: PAKISTAN_PHONE,
      keys: { ur: 'cod_confirm.en.friendly' },
    });
    expect(selection).toMatchObject({
      template: { language: 'ur', variantKey: 'ur.standard_v1' },
      fallbackReason: 'wrong_language',
    });
  });

  it('under the guardrail, auto leaves a language whose default is paused', () => {
    const synced = syncedApprovedTemplates(templates).map((template) =>
      template.key === urdu.key
        ? { ...template, reviewStatus: 'paused' as const }
        : template,
    );
    const selection = selectTemplateForSend(synced, {
      preferredLanguage: 'auto',
      phoneNumber: PAKISTAN_PHONE,
      guardrail: { enabled: true },
    });
    expect(selection.template).toMatchObject({ language: 'en' });
  });
});

describe('storeTemplateKeys', () => {
  it('reads every language from its own fields', () => {
    expect(
      storeTemplateKeys({
        codTemplateArKey: null,
        codTemplateArVariant: 'egyptian',
        codTemplateEnKey: 'cod_confirm.en.direct',
        codTemplateEnVariant: 'friendly',
        codTemplateUrKey: 'cod_confirm.ur.short_v1',
        codReminderFrKey: 'cod_reminder.fr.standard_v1',
        codTemplateTrKey: 'cod_confirm.tr.short_v1',
        codReminderTrKey: 'cod_reminder.tr.standard_v1',
      }),
    ).toEqual({
      keys: {
        ar: 'cod_confirm.ar.egyptian',
        en: 'cod_confirm.en.direct',
        ur: 'cod_confirm.ur.short_v1',
        es: null,
        fr: null,
        tr: 'cod_confirm.tr.short_v1',
      },
      reminderKeys: {
        ar: null,
        en: null,
        ur: null,
        es: null,
        fr: 'cod_reminder.fr.standard_v1',
        tr: 'cod_reminder.tr.standard_v1',
      },
    });
  });

  it('gives only Arabic and English an old variant field', () => {
    expect(
      TEMPLATE_LANGUAGES.filter(
        (language) => 'legacyVariant' in STORE_TEMPLATE_FIELDS[language],
      ),
    ).toEqual(['ar', 'en']);
  });
});

describe('starter template drafts', () => {
  const readMigration = (file: string) =>
    readFileSync(resolve(__dirname, '../../../drizzle', file), 'utf8');
  const languagesMigration = readMigration(
    '0064_whatsapp_template_languages.sql',
  );
  const turkishMigration = readMigration('0068_whatsapp_template_turkish.sql');
  /** The migration that writes a language's drafts and texts. */
  const migrationOf = (language: TemplateLanguage) =>
    language === 'tr' ? turkishMigration : languagesMigration;
  const sqlText = (value: string) =>
    value.replaceAll("'", "''").replaceAll('\n', '\\n');

  it('has two confirmations and one reminder for each new language', () => {
    expect(
      STARTER_TEMPLATE_DRAFTS.map(({ purpose, language, style }) =>
        buildDraftKey(purpose, language, style, 1),
      ),
    ).toEqual(
      (['ur', 'es', 'fr', 'tr'] as const).flatMap((language) => [
        `cod_confirm.${language}.standard_v1`,
        `cod_confirm.${language}.short_v1`,
        `cod_reminder.${language}.standard_v1`,
      ]),
    );
  });

  it.each(STARTER_TEMPLATE_DRAFTS)(
    'passes every authoring rule: $purpose $language $style',
    (draft) => {
      const samples = templateSampleValues(draft.language);
      const validation = validateTemplateDraft(
        {
          ...draft,
          version: 1,
          templateName: buildTemplateName(draft.purpose, draft.style, 1),
          parameterFormat: 'named',
          category: EXPECTED_CATEGORY_BY_PURPOSE[draft.purpose],
          samples,
        },
        { takenIdentities: new Set() },
      );
      expect(validation.issues).toEqual([]);
    },
  );

  it.each(STARTER_TEMPLATE_DRAFTS)(
    'is written to the drafts table by the migration: $purpose $language $style',
    (draft) => {
      const row = migrationOf(draft.language)
        .split('\n')
        .find((line) =>
          line.includes(
            `'${buildDraftKey(draft.purpose, draft.language, draft.style, 1)}'`,
          ),
        );
      expect(row).toBeDefined();
      expect(row).toContain(
        `'${buildTemplateName(draft.purpose, draft.style, 1)}', '${draft.languageCode}'`,
      );
      expect(row).toContain(`E'${sqlText(draft.body)}'`);
      expect(row).toContain(
        `'${sqlText(draft.confirmLabel)}', '${sqlText(draft.cancelLabel)}'`,
      );
      expect(row).toContain(`'${STARTER_DRAFT_AUTHOR_ID}'`);
    },
  );

  it.each([
    ['0064', languagesMigration],
    ['0068', turkishMigration],
  ])(
    'writes drafts only: migration %s adds no template a send could read',
    (_, migration) => {
      expect(migration).toContain('INSERT INTO "whatsapp_template_drafts"');
      expect(migration).not.toContain('INSERT INTO "whatsapp_templates"');
    },
  );

  it('writes Turkish in 0068 only, and nothing else there', () => {
    expect(languagesMigration).not.toContain('.tr.');
    expect(turkishMigration).not.toMatch(/\.(ur|es|fr)\./);
    expect(turkishMigration).not.toMatch(/, '(ar|en|ur|es|fr)', 'default'/);
  });

  describe('free-form texts', () => {
    it('has every purpose once for each new language, and none for Arabic or English', () => {
      expect(
        STARTER_MESSAGE_TEXTS.map(({ language, purpose }) => [
          language,
          purpose,
        ]),
      ).toEqual(
        (['ur', 'es', 'fr', 'tr'] as const).flatMap((language) =>
          MESSAGE_TEXT_PURPOSES.map((purpose) => [language, purpose]),
        ),
      );
      expect(
        STARTER_MESSAGE_TEXTS.every(({ style }) => style === 'default'),
      ).toBe(true);
    });

    it.each(STARTER_MESSAGE_TEXTS)(
      'uses only the values its purpose has: $language $purpose',
      ({ purpose, body }) => {
        const isName = purpose.startsWith('fallback_');
        const filled = fillMessageText(body, {
          order: '#1009',
          store: 'Akeed',
        });
        // Nothing is left unfilled, and a name is a short word with no value.
        expect(filled).not.toContain('{{');
        if (isName) {
          expect(filled).toBe(body);
          expect(body.length).toBeLessThanOrEqual(60);
        }
        if (purpose.startsWith('ack_')) expect(filled).toContain('#1009');
      },
    );

    it.each(STARTER_MESSAGE_TEXTS)(
      'is written to the texts table by the migration: $language $purpose',
      ({ purpose, language, body }) => {
        expect(migrationOf(language)).toContain(
          `('${purpose}', '${language}', 'default', '${body.replaceAll("'", "''")}', true, '${STARTER_DRAFT_AUTHOR_ID}')`,
        );
      },
    );

    it('reads correctly in Turkish when the store or customer name is missing', () => {
      const turkish = (purpose: string) =>
        STARTER_MESSAGE_TEXTS.find(
          (text) => text.language === 'tr' && text.purpose === purpose,
        )?.body ?? '';
      const values = {
        customer: turkish('fallback_customer_name'),
        store: turkish('fallback_store_name'),
        order: '#1009',
        total: '250.00 TRY',
      };
      const bodies = [
        ...STARTER_TEMPLATE_DRAFTS.filter(
          ({ language }) => language === 'tr',
        ).map(({ body }) => body),
        turkish('ack_confirmed'),
        turkish('ack_canceled'),
      ];
      for (const body of bodies) {
        const filled = fillMessageText(body, values);
        expect(filled).not.toContain('{{');
        expect(filled).not.toMatch(/mağazamız mağaza/i);
      }
      expect(fillMessageText(turkish('ack_canceled'), values)).toContain(
        'mağazamız adına',
      );
    });
  });
});
