import { HttpException, Logger } from '@nestjs/common';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
} from '../../../test/contracts/meta-template-api-fake';
import type { TemplateDraftRow } from '../../infrastructure/database/repositories/whatsapp-template-drafts.repository';
import type {
  EditStart,
  LifecycleOutcome,
  LifecycleRow,
  TemplateImpact,
} from '../../infrastructure/database/repositories/whatsapp-template-lifecycle.repository';
import { MetaTemplateCatalogAdapter } from '../../infrastructure/spokes/meta/meta-template-catalog.adapter';
import { parseWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import { decideEdit } from '../../shared/messaging/template-lifecycle.policy';
import {
  AdminTemplateLifecycleService,
  WHATSAPP_TEMPLATE_LIFECYCLE_AUDIT_ACTIONS,
} from './admin-template-lifecycle.service';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const KEY = 'cod_confirm.en.warm_v1';
const BODY =
  'Hello {{customer}}, thank you for your order {{order}} from {{store}}. It comes to {{total}} in all, paid on delivery.';

function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: 'template-1',
    key: KEY,
    purpose: 'cod_confirmation',
    language: 'en',
    style: 'warm_v1',
    templateName: 'akeed_cod_confirm_warm_v1',
    isActive: false,
    isDefault: false,
    reviewStatus: 'rejected',
    retiredAt: null,
    providerTemplateId: '900000000000001',
    rejectionReason: 'invalid_format',
    ...overrides,
  };
}

const draft = {
  id: 'draft-1',
  key: KEY,
  purpose: 'cod_confirmation',
  language: 'en',
  style: 'warm',
  version: 1,
  metaTemplateName: 'akeed_cod_confirm_warm_v1',
  metaLanguageCode: 'en',
  parameterFormat: 'named',
  category: 'utility',
  body: BODY,
  confirmLabel: 'Confirm order',
  cancelLabel: 'Cancel order',
  samples: {
    customer: 'Ahmed',
    store: 'Akeed Store',
    order: 'TEST-1',
    total: '250.00 USD',
  },
  state: 'submitted',
  templateId: 'template-1',
} as unknown as TemplateDraftRow;

const text = {
  body: `${BODY} Thank you.`,
  confirm_label: 'Yes, confirm',
  cancel_label: 'No, cancel',
  samples: draft.samples,
};

function setup() {
  const api = new FakeMetaTemplateApi();
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: FAKE_TOKEN,
    whatsappTemplates: parseWhatsappTemplateConfig({
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    }),
  };
  const lifecycle = {
    applyLifecycle: jest.fn<Promise<LifecycleOutcome>, [unknown]>(),
    impact: jest.fn<Promise<TemplateImpact | null>, [string]>(),
    beginEdit: jest.fn<Promise<EditStart>, [unknown]>().mockResolvedValue({
      kind: 'started',
      editId: 'edit-1',
      template: row(),
      draft,
    }),
    finishEdit: jest
      .fn<Promise<void>, [Record<string, unknown>, Record<string, unknown>]>()
      .mockResolvedValue(undefined),
  };
  const registry = { listTemplates: jest.fn(), invalidate: jest.fn() };
  const service = new AdminTemplateLifecycleService(
    lifecycle as never,
    new MetaTemplateCatalogAdapter(
      api.httpService as never,
      { get: (key: string) => values[key] } as never,
    ),
    registry,
  );
  return { service, lifecycle, registry, api };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return {
        status: error.getStatus(),
        ...(error.getResponse() as Record<string, unknown>),
      };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('AdminTemplateLifecycleService (US-08-06 criteria 5 to 7)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('activate, deactivate, set default, retire', () => {
    it('applies an action as one audited write and drops the registry cache', async () => {
      const { service, lifecycle, registry } = setup();
      lifecycle.applyLifecycle.mockResolvedValue({
        kind: 'applied',
        changed: true,
        before: { is_active: true, is_default: false, retired: false },
        after: { is_active: false, is_default: false, retired: true },
        replacementKey: 'cod_confirm.en.friendly',
        movedStores: 12,
      });

      const result = await service.act({
        userId: OPERATOR,
        key: KEY,
        action: 'retire',
        replacementKey: 'cod_confirm.en.friendly',
        requestId: 'req-1',
      });

      expect(result).toEqual({
        key: KEY,
        action: 'retire',
        changed: true,
        is_active: false,
        is_default: false,
        retired: true,
        replacement_key: 'cod_confirm.en.friendly',
        moved_stores: 12,
      });
      expect(lifecycle.applyLifecycle).toHaveBeenCalledWith({
        key: KEY,
        action: 'retire',
        replacementKey: 'cod_confirm.en.friendly',
        audit: {
          userId: OPERATOR,
          action: 'whatsapp-templates.retire',
          requestId: 'req-1',
        },
      });
      expect(registry.invalidate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['not_approved', 'WHATSAPP_TEMPLATE_NOT_APPROVED'],
      ['not_active', 'WHATSAPP_TEMPLATE_NOT_ACTIVE'],
      ['retired', 'WHATSAPP_TEMPLATE_RETIRED'],
      ['replacement_required', 'WHATSAPP_TEMPLATE_REPLACEMENT_REQUIRED'],
      ['replacement_invalid', 'WHATSAPP_TEMPLATE_REPLACEMENT_INVALID'],
    ] as const)('answers a %s refusal with 409 %s', async (reason, code) => {
      const { service, lifecycle, registry } = setup();
      lifecycle.applyLifecycle.mockResolvedValue({ kind: 'refused', reason });

      expect(
        await refusal(
          service.act({ userId: OPERATOR, key: KEY, action: 'activate' }),
        ),
      ).toMatchObject({ status: 409, code });
      expect(registry.invalidate).not.toHaveBeenCalled();
    });

    it('answers an unknown template with 404 and an unknown replacement with 409', async () => {
      const { service, lifecycle } = setup();
      lifecycle.applyLifecycle.mockResolvedValueOnce({ kind: 'not_found' });
      lifecycle.applyLifecycle.mockResolvedValueOnce({
        kind: 'replacement_not_found',
      });

      const act = () =>
        service.act({ userId: OPERATOR, key: KEY, action: 'retire' });
      expect(await refusal(act())).toMatchObject({
        status: 404,
        code: 'WHATSAPP_TEMPLATE_NOT_FOUND',
      });
      expect(await refusal(act())).toMatchObject({
        status: 409,
        code: 'WHATSAPP_TEMPLATE_REPLACEMENT_INVALID',
      });
    });

    it('uses one audit action per kind of write', () => {
      expect(WHATSAPP_TEMPLATE_LIFECYCLE_AUDIT_ACTIONS).toEqual({
        activate: 'whatsapp-templates.activate',
        deactivate: 'whatsapp-templates.deactivate',
        set_default: 'whatsapp-templates.set-default',
        retire: 'whatsapp-templates.retire',
        edit: 'whatsapp-templates.edit',
      });
    });
  });

  it('describes what an action would touch, for the confirmation', async () => {
    const { service, lifecycle } = setup();
    const template = row({ isActive: true, reviewStatus: 'approved' });
    lifecycle.impact.mockResolvedValue({
      template,
      stores: { total: 14, active: 12 },
      requiresReplacement: true,
      replacements: [
        row({
          key: 'cod_confirm.en.friendly',
          style: 'friendly',
          templateName: 'akeed_cod_verification_friendly',
        }),
      ],
      edit: {
        draftId: 'draft-1',
        editsLastDay: 0,
        editsLast30Days: 2,
        decision: decideEdit({
          target: template,
          hasDraft: true,
          storeCount: 14,
          editsLastDay: 0,
          editsLast30Days: 2,
        }),
      },
    });

    await expect(service.impact(KEY)).resolves.toEqual({
      key: KEY,
      is_active: true,
      is_default: false,
      retired: false,
      review_status: 'approved',
      rejection_reason: 'invalid_format',
      stores: { total: 14, active: 12 },
      requires_replacement: true,
      replacements: [
        {
          key: 'cod_confirm.en.friendly',
          style: 'friendly',
          template_name: 'akeed_cod_verification_friendly',
        },
      ],
      edit: {
        allowed: false,
        refusal: 'in_use',
        rule: '4.3.9',
        draft_id: 'draft-1',
        edits_last_day: 0,
        edits_last_30_days: 2,
        limits: { per_day: 1, per_30_days: 10 },
      },
    });
  });

  describe('edit', () => {
    it('sends an allowed edit once and leaves the template under review', async () => {
      const { service, lifecycle, registry, api } = setup();

      const result = await service.edit({
        userId: OPERATOR,
        key: KEY,
        dto: text,
        requestId: 'req-2',
      });

      // Not sendable until the provider approves it again (record 4.3.8).
      expect(result).toEqual({ key: KEY, review_status: 'pending' });
      expect(api.writes).toHaveLength(1);
      expect(api.writes[0].url).toMatch(/\/900000000000001$/);
      expect(api.writes[0].body).toMatchObject({
        components: [
          { type: 'BODY', text: `${BODY} Thank you.` },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Yes, confirm' },
              { type: 'QUICK_REPLY', text: 'No, cancel' },
            ],
          },
        ],
      });
      expect(lifecycle.finishEdit).toHaveBeenCalledTimes(1);
      const [finished, audit] = lifecycle.finishEdit.mock.calls[0];
      expect(finished).toMatchObject({
        editId: 'edit-1',
        templateId: 'template-1',
        draftId: 'draft-1',
        outcome: 'applied',
      });
      expect(audit).toEqual({
        userId: OPERATOR,
        action: 'whatsapp-templates.edit',
        requestId: 'req-2',
        metadata: {
          templateKey: KEY,
          outcome: 'applied',
          providerReference: '900000000000001',
          previousReviewStatus: 'rejected',
        },
      });
      expect(JSON.stringify(audit)).not.toContain('Thank you');
      expect(registry.invalidate).toHaveBeenCalled();
    });

    it.each([
      ['status_not_editable', '4.3.1'],
      ['in_use', '4.3.9'],
      ['daily_limit', '4.3.2'],
      ['monthly_limit', '4.3.2'],
    ] as const)(
      'refuses a forbidden edit locally (%s), citing rule %s, and sends nothing',
      async (reason, rule) => {
        const { service, lifecycle, api } = setup();
        lifecycle.beginEdit.mockResolvedValue({
          kind: 'refused',
          reason,
          rule,
        });

        expect(
          await refusal(
            service.edit({ userId: OPERATOR, key: KEY, dto: text }),
          ),
        ).toMatchObject({
          status: 409,
          code: 'WHATSAPP_TEMPLATE_EDIT_REFUSED',
          reason,
          rule,
        });
        expect(api.writes).toHaveLength(0);
        expect(lifecycle.finishEdit).not.toHaveBeenCalled();
      },
    );

    it('refuses text that fails validation without using one of the edits', async () => {
      const { service, lifecycle, api } = setup();

      expect(
        await refusal(
          service.edit({
            userId: OPERATOR,
            key: KEY,
            dto: { ...text, confirm_label: 'x'.repeat(26) },
          }),
        ),
      ).toMatchObject({
        status: 422,
        code: 'WHATSAPP_TEMPLATE_DRAFT_INVALID',
        issues: [{ field: 'confirm_label', rule: 'button_label_too_long' }],
      });
      expect(api.writes).toHaveLength(0);
      expect(lifecycle.finishEdit.mock.calls[0][0]).toMatchObject({
        outcome: 'refused',
      });
    });

    it('surfaces the provider refusal and does not count the edit', async () => {
      const { service, lifecycle, api } = setup();
      api.failNextWrite({ kind: 'meta_error', httpStatus: 400, code: 2388039 });

      expect(
        await refusal(service.edit({ userId: OPERATOR, key: KEY, dto: text })),
      ).toMatchObject({
        status: 422,
        code: 'WHATSAPP_TEMPLATE_EDIT_REJECTED',
        reason: 'status_locked',
      });
      expect(lifecycle.finishEdit.mock.calls[0]).toMatchObject([
        { outcome: 'refused', providerReference: 'synthetic-trace' },
        { metadata: { errorCode: 'status_locked', providerCode: 2388039 } },
      ]);
    });

    it('counts an edit with no answer and treats the template as under review', async () => {
      const { service, lifecycle, registry, api } = setup();
      api.failNextWrite({ kind: 'applied_then_lost' });

      expect(
        await refusal(service.edit({ userId: OPERATOR, key: KEY, dto: text })),
      ).toMatchObject({
        status: 502,
        code: 'WHATSAPP_TEMPLATE_EDIT_UNRESOLVED',
      });
      expect(api.writes).toHaveLength(1);
      expect(lifecycle.finishEdit.mock.calls[0][0]).toMatchObject({
        outcome: 'unknown',
      });
      expect(registry.invalidate).toHaveBeenCalled();
    });
  });
});
