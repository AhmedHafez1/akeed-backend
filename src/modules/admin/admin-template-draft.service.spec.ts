import { randomUUID } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
} from '../../../test/contracts/meta-template-api-fake';
import {
  ABANDONED_SUBMIT_MS,
  effectiveDraftState,
  type DraftClaim,
  type NewTemplateDraft,
  type TemplateAuditEntry,
  type TemplateDraftPatch,
  type TemplateDraftRow,
} from '../../infrastructure/database/repositories/whatsapp-template-drafts.repository';
import { MetaTemplateCatalogAdapter } from '../../infrastructure/spokes/meta/meta-template-catalog.adapter';
import { parseWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import type { TemplateSubmissionResult } from '../../shared/messaging/template-draft.types';
import {
  buildDraftKey,
  buildTemplateName,
  draftIdentity,
} from '../../shared/messaging/template-draft.validation';
import {
  AdminTemplateDraftService,
  WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS,
} from './admin-template-draft.service';
import type { AdminTemplateDraftDto } from './dto/admin-template-authoring.dto';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const BODY =
  'Hello {{customer}}, thank you for your order {{order}} from {{store}}. It comes to {{total}} in all, paid on delivery.';

/** The drafts repository, in memory, with the same state rules. */
class InMemoryDrafts {
  readonly rows = new Map<string, TemplateDraftRow>();
  readonly audits: TemplateAuditEntry[] = [];
  readonly registry: {
    key: string;
    name: string;
    code: string;
    result: TemplateSubmissionResult;
    isActive: boolean;
    isDefault: boolean;
  }[] = [];

  list() {
    return Promise.resolve([...this.rows.values()]);
  }
  findById(id: string) {
    return Promise.resolve(this.rows.get(id));
  }
  takenIdentities(exceptDraftId?: string) {
    return Promise.resolve(
      new Set(
        [...this.rows.values()]
          .filter((row) => row.id !== exceptDraftId)
          .map((row) =>
            draftIdentity(row.metaTemplateName, row.metaLanguageCode),
          ),
      ),
    );
  }
  nextVersion(_purpose: string, language: string, style: string) {
    const versions = [...this.rows.values()]
      .filter((row) => row.language === language && row.style === style)
      .map((row) => row.version);
    return Promise.resolve(Math.max(0, ...versions) + 1);
  }
  async create(
    input: NewTemplateDraft,
    audit: Omit<TemplateAuditEntry, 'metadata'>,
  ) {
    const version = await this.nextVersion(
      input.purpose,
      input.language,
      input.style,
    );
    const now = new Date().toISOString();
    const row: TemplateDraftRow = {
      id: randomUUID(),
      key: buildDraftKey(input.purpose, input.language, input.style, version),
      purpose: input.purpose,
      language: input.language,
      style: input.style,
      version,
      metaTemplateName: buildTemplateName(input.purpose, input.style, version),
      metaLanguageCode: input.languageCode,
      parameterFormat: input.parameterFormat,
      category: input.category,
      body: input.body,
      confirmLabel: input.confirmLabel,
      cancelLabel: input.cancelLabel,
      samples: input.samples,
      state: 'draft',
      stateChangedAt: now,
      lastErrorCode: null,
      lastProviderReference: null,
      templateId: null,
      createdBy: audit.userId,
      updatedBy: audit.userId,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    this.audits.push({ ...audit, metadata: { draftId: row.id } });
    return row;
  }
  update(
    id: string,
    patch: TemplateDraftPatch,
    audit: Omit<TemplateAuditEntry, 'metadata'>,
  ) {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve({ kind: 'not_found' as const });
    if (row.state !== 'draft') {
      return Promise.resolve({ kind: 'not_editable' as const });
    }
    const draft: TemplateDraftRow = {
      ...row,
      body: patch.body ?? row.body,
      confirmLabel: patch.confirmLabel ?? row.confirmLabel,
      cancelLabel: patch.cancelLabel ?? row.cancelLabel,
      samples: patch.samples ?? row.samples,
      metaLanguageCode: patch.languageCode ?? row.metaLanguageCode,
      parameterFormat: patch.parameterFormat ?? row.parameterFormat,
    };
    this.rows.set(id, draft);
    this.audits.push({ ...audit, metadata: { draftId: id } });
    return Promise.resolve({ kind: 'updated' as const, draft });
  }
  discard(id: string, audit: Omit<TemplateAuditEntry, 'metadata'>) {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve('not_found' as const);
    if (row.state !== 'draft') return Promise.resolve('not_editable' as const);
    this.rows.delete(id);
    this.audits.push({ ...audit, metadata: { draftId: id } });
    return Promise.resolve('discarded' as const);
  }
  claimForSubmit(id: string, now = new Date()): Promise<DraftClaim> {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve({ kind: 'not_found' });
    const state = effectiveDraftState(row, now);
    if (state === 'submitted') {
      return Promise.resolve({ kind: 'already_submitted', draft: row });
    }
    if (state === 'submitting') return Promise.resolve({ kind: 'in_progress' });
    if (state === 'submit_unknown') {
      return Promise.resolve({ kind: 'unresolved' });
    }
    const draft = this.set(id, { state: 'submitting' }, now);
    return Promise.resolve({ kind: 'claimed', draft });
  }
  claimForReconcile(id: string, now = new Date()) {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve(undefined);
    if (effectiveDraftState(row, now) !== 'submit_unknown') {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.set(id, { state: 'submitting' }, now));
  }
  closeClaim(
    id: string,
    next: {
      state: 'draft' | 'submit_unknown';
      errorCode: string | null;
      providerReference?: string;
    },
    audit: TemplateAuditEntry,
  ) {
    this.set(id, {
      state: next.state,
      lastErrorCode: next.errorCode,
      lastProviderReference: next.providerReference ?? null,
    });
    this.audits.push(audit);
    return Promise.resolve();
  }
  confirmSubmission(
    id: string,
    params: { result: TemplateSubmissionResult },
    audit: TemplateAuditEntry,
  ) {
    const row = this.rows.get(id)!;
    this.registry.push({
      key: row.key,
      name: row.metaTemplateName,
      code: row.metaLanguageCode,
      result: params.result,
      isActive: false,
      isDefault: false,
    });
    const draft = this.set(id, {
      state: 'submitted',
      templateId: randomUUID(),
      lastErrorCode: null,
    });
    this.audits.push(audit);
    return Promise.resolve({ draft, templateKey: row.key });
  }
  set(id: string, patch: Partial<TemplateDraftRow>, now = new Date()) {
    const next = {
      ...this.rows.get(id)!,
      ...patch,
      stateChangedAt: now.toISOString(),
    };
    this.rows.set(id, next);
    return next;
  }
}

function dto(
  overrides: Partial<AdminTemplateDraftDto> = {},
): AdminTemplateDraftDto {
  return {
    purpose: 'cod_confirmation',
    language: 'en',
    style: 'warm',
    language_code: 'en',
    parameter_format: 'named',
    body: BODY,
    confirm_label: 'Confirm order',
    cancel_label: 'Cancel order',
    samples: {
      customer: 'Ahmed',
      store: 'Akeed Store',
      order: 'TEST-1',
      total: '250.00 USD',
    },
    ...overrides,
  };
}

function setup(env: Record<string, string> = {}) {
  const api = new FakeMetaTemplateApi();
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: FAKE_TOKEN,
    NODE_ENV: 'test',
    whatsappTemplates: parseWhatsappTemplateConfig({
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR,
      ...env,
    }),
  };
  const config = { get: (key: string) => values[key] };
  const drafts = new InMemoryDrafts();
  const registry = { listTemplates: jest.fn(), invalidate: jest.fn() };
  const service = new AdminTemplateDraftService(
    drafts as never,
    new MetaTemplateCatalogAdapter(api.httpService as never, config as never),
    registry,
    config as never,
  );
  return { service, drafts, api, registry };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return {
        status: error.getStatus(),
        ...(error.getResponse() as { code: string; reason?: string }),
      };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('AdminTemplateDraftService (US-08-06 criteria 2 to 4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a draft that lives only in Akeed, under a generated name', async () => {
    const { service, api, drafts } = setup();

    const { draft } = await service.create(OPERATOR, dto(), 'req-1');

    expect(draft).toMatchObject({
      key: 'cod_confirm.en.warm_v1',
      template_name: 'akeed_cod_confirm_warm_v1',
      version: 1,
      state: 'draft',
      category: 'utility',
      template_key: null,
      validation: { valid: true, issues: [] },
      variables: [
        { variable: 'customer', parameter: 'customer', sample: 'Ahmed' },
        { variable: 'order', parameter: 'order', sample: 'TEST-1' },
        { variable: 'store', parameter: 'store', sample: 'Akeed Store' },
        { variable: 'total', parameter: 'total', sample: '250.00 USD' },
      ],
      preview: {
        paragraphs: [
          'Hello Ahmed, thank you for your order TEST-1 from Akeed Store. It comes to 250.00 USD in all, paid on delivery.',
        ],
        buttons: [
          { label: 'Confirm order', kind: 'quick_reply' },
          { label: 'Cancel order', kind: 'quick_reply' },
        ],
        direction: 'ltr',
      },
    });
    expect(api.requests).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
    expect(drafts.registry).toHaveLength(0);
    expect(drafts.audits).toEqual([
      {
        userId: OPERATOR,
        action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.create,
        requestId: 'req-1',
        metadata: { draftId: draft.id },
      },
    ]);
  });

  it('gives the next draft of the same style the next version', async () => {
    const { service } = setup();
    await service.create(OPERATOR, dto());

    const { draft } = await service.create(OPERATOR, dto());

    expect(draft.template_name).toBe('akeed_cod_confirm_warm_v2');
    expect(draft.key).toBe('cod_confirm.en.warm_v2');
  });

  it('saves an unfinished draft and reports each failing field', async () => {
    const { service } = setup();

    const { draft } = await service.create(
      OPERATOR,
      dto({ body: '{{customer}} hello', confirm_label: '' }),
    );

    expect(draft.validation.valid).toBe(false);
    expect(draft.validation.issues.map((issue) => issue.rule).sort()).toEqual([
      'button_label_required',
      'parameter_at_edge',
      'parameter_ratio',
    ]);
  });

  it('checks a draft as written without saving it', async () => {
    const { service, drafts } = setup();

    const check = await service.check(dto({ language_code: 'ar_SA' }));

    expect(check).toMatchObject({
      template_name: 'akeed_cod_confirm_warm_v1',
      key: 'cod_confirm.en.warm_v1',
      validation: {
        valid: false,
        issues: [{ field: 'language_code', rule: 'language_code_unsupported' }],
      },
    });
    expect(drafts.rows.size).toBe(0);
  });

  it('refuses to submit a draft that fails validation, sending nothing', async () => {
    const { service, api } = setup();
    const { draft } = await service.create(OPERATOR, dto({ cancel_label: '' }));

    expect(await refusal(service.submit(OPERATOR, draft.id))).toMatchObject({
      status: 422,
      code: 'WHATSAPP_TEMPLATE_DRAFT_INVALID',
    });
    expect(api.requests).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
  });

  it('submits a draft: one create, the provider ID stored, the registry row inactive', async () => {
    const { service, api, drafts, registry } = setup();
    const { draft } = await service.create(OPERATOR, dto());

    const result = await service.submit(OPERATOR, draft.id, 'req-2');

    expect(result.outcome).toBe('created');
    expect(result.draft).toMatchObject({
      state: 'submitted',
      template_key: 'cod_confirm.en.warm_v1',
    });
    expect(api.writes).toHaveLength(1);
    expect(drafts.registry).toEqual([
      {
        key: 'cod_confirm.en.warm_v1',
        name: 'akeed_cod_confirm_warm_v1',
        code: 'en',
        result: {
          providerTemplateId: '910000000000001',
          status: 'pending',
          category: 'utility',
        },
        isActive: false,
        isDefault: false,
      },
    ]);
    expect(registry.invalidate).toHaveBeenCalledTimes(1);
    expect(drafts.audits.at(-1)).toEqual({
      userId: OPERATOR,
      action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.submit,
      requestId: 'req-2',
      metadata: {
        draftId: draft.id,
        templateKey: 'cod_confirm.en.warm_v1',
        outcome: 'created',
        providerReference: '910000000000001',
        reviewStatus: 'pending',
        category: 'utility',
      },
    });
  });

  it('keeps template text out of every audit row', async () => {
    const { service, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    await service.update(OPERATOR, draft.id, {
      ...dto(),
      body: `${BODY} Thank you kindly.`,
    });
    await service.submit(OPERATOR, draft.id);

    const written = JSON.stringify(drafts.audits);
    expect(drafts.audits).toHaveLength(3);
    for (const text of ['Hello', 'Confirm order', 'Cancel order', 'Ahmed']) {
      expect(written).not.toContain(text);
    }
  });

  it('answers a second submit of a submitted draft with the same result and no request', async () => {
    const { service, api, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    await service.submit(OPERATOR, draft.id);

    const again = await service.submit(OPERATOR, draft.id);

    expect(again.outcome).toBe('already_submitted');
    expect(again.draft.template_key).toBe('cod_confirm.en.warm_v1');
    expect(api.writes).toHaveLength(1);
    expect(drafts.registry).toHaveLength(1);
  });

  it('lets only one of two submits at once reach the provider', async () => {
    const { service, api, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());

    const results = await Promise.allSettled([
      service.submit(OPERATOR, draft.id),
      service.submit(OPERATOR, draft.id),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(
      (
        (rejected as PromiseRejectedResult).reason as HttpException
      ).getResponse(),
    ).toMatchObject({ code: 'WHATSAPP_TEMPLATE_SUBMIT_IN_PROGRESS' });
    expect(api.writes).toHaveLength(1);
    expect(drafts.registry).toHaveLength(1);
  });

  it('adopts a template the provider already holds instead of creating it again', async () => {
    const { service, api, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    api.templates.push({
      id: '900000000000777',
      name: 'akeed_cod_confirm_warm_v1',
      language: 'en',
      status: 'APPROVED',
      category: 'UTILITY',
    });

    const result = await service.submit(OPERATOR, draft.id);

    expect(result.outcome).toBe('adopted');
    expect(api.writes).toHaveLength(0);
    expect(drafts.registry[0].result).toEqual({
      providerTemplateId: '900000000000777',
      status: 'approved',
      category: 'utility',
    });
  });

  it('returns the draft for editing when the provider refuses it, with the neutral reason', async () => {
    const { service, api, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    api.failNextWrite({ kind: 'meta_error', httpStatus: 400, code: 2388293 });

    expect(await refusal(service.submit(OPERATOR, draft.id))).toEqual(
      expect.objectContaining({
        status: 422,
        code: 'WHATSAPP_TEMPLATE_SUBMIT_REJECTED',
        reason: 'parameter_ratio',
      }),
    );
    expect(drafts.rows.get(draft.id)).toMatchObject({
      state: 'draft',
      lastErrorCode: 'parameter_ratio',
      lastProviderReference: 'synthetic-trace',
    });
    expect(drafts.registry).toHaveLength(0);
    expect(drafts.audits.at(-1)?.metadata).toMatchObject({
      outcome: 'refused',
      errorCode: 'parameter_ratio',
      providerCode: 2388293,
      providerReference: 'synthetic-trace',
    });
  });

  it('submits nothing when the provider cannot be read first', async () => {
    const { service, api, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    api.failOnPage(1, { kind: 'network' });

    expect(await refusal(service.submit(OPERATOR, draft.id))).toMatchObject({
      status: 502,
      code: 'WHATSAPP_TEMPLATE_PROVIDER_UNAVAILABLE',
    });
    expect(api.writes).toHaveLength(0);
    expect(drafts.rows.get(draft.id)?.state).toBe('draft');
  });

  describe('a submit whose answer never arrived', () => {
    async function lost() {
      const context = setup();
      const { draft } = await context.service.create(OPERATOR, dto());
      context.api.failNextWrite({ kind: 'applied_then_lost' });
      const first = await refusal(context.service.submit(OPERATOR, draft.id));
      return { ...context, draft, first };
    }

    it('is unresolved, and a retry sends nothing until the provider is checked', async () => {
      const { service, api, drafts, draft, first } = await lost();

      expect(first).toMatchObject({
        status: 502,
        code: 'WHATSAPP_TEMPLATE_SUBMIT_UNRESOLVED',
      });
      expect(drafts.rows.get(draft.id)?.state).toBe('submit_unknown');
      expect(drafts.registry).toHaveLength(0);

      expect(await refusal(service.submit(OPERATOR, draft.id))).toMatchObject({
        status: 409,
        code: 'WHATSAPP_TEMPLATE_SUBMIT_UNRESOLVED',
      });
      expect(api.writes).toHaveLength(1);
    });

    it('adopts the template when the check finds it at the provider', async () => {
      const { service, api, drafts, draft } = await lost();

      const result = await service.reconcile(OPERATOR, draft.id, 'req-3');

      expect(result.outcome).toBe('adopted');
      expect(result.draft.state).toBe('submitted');
      expect(api.writes).toHaveLength(1);
      expect(drafts.registry).toHaveLength(1);
      expect(drafts.audits.at(-1)).toMatchObject({
        action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.reconcile,
        requestId: 'req-3',
        metadata: { outcome: 'adopted' },
      });
    });

    it('returns the draft for a new submit when the check does not find it', async () => {
      const context = setup();
      const { draft } = await context.service.create(OPERATOR, dto());
      context.api.failNextWrite({ kind: 'network' });
      await refusal(context.service.submit(OPERATOR, draft.id));

      const result = await context.service.reconcile(OPERATOR, draft.id);

      expect(result.outcome).toBe('not_at_provider');
      expect(result.draft.state).toBe('draft');
      // The check itself creates nothing.
      expect(context.api.writes).toHaveLength(1);
      await expect(
        context.service.submit(OPERATOR, draft.id),
      ).resolves.toMatchObject({ outcome: 'created' });
      expect(context.api.writes).toHaveLength(2);
    });

    it('stays unresolved when the check cannot read the provider', async () => {
      const { service, api, drafts, draft } = await lost();
      api.failOnPage(api.requests.length + 1, { kind: 'network' });

      expect(
        await refusal(service.reconcile(OPERATOR, draft.id)),
      ).toMatchObject({
        code: 'WHATSAPP_TEMPLATE_PROVIDER_UNAVAILABLE',
      });
      expect(drafts.rows.get(draft.id)?.state).toBe('submit_unknown');
    });
  });

  it('treats a submit that died mid-flight as unresolved', async () => {
    const { service, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    drafts.set(
      draft.id,
      { state: 'submitting' },
      new Date(Date.now() - ABANDONED_SUBMIT_MS - 1000),
    );

    expect(await refusal(service.submit(OPERATOR, draft.id))).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_SUBMIT_UNRESOLVED',
    });
    await expect(service.reconcile(OPERATOR, draft.id)).resolves.toMatchObject({
      outcome: 'not_at_provider',
    });
  });

  it('refuses to check a draft with no unanswered submit', async () => {
    const { service } = setup();
    const { draft } = await service.create(OPERATOR, dto());

    expect(await refusal(service.reconcile(OPERATOR, draft.id))).toMatchObject({
      status: 409,
      code: 'WHATSAPP_TEMPLATE_RECONCILE_NOT_NEEDED',
    });
  });

  it('refuses to change or discard a draft once it is submitted', async () => {
    const { service } = setup();
    const { draft } = await service.create(OPERATOR, dto());
    await service.submit(OPERATOR, draft.id);

    expect(
      await refusal(service.update(OPERATOR, draft.id, dto())),
    ).toMatchObject({
      status: 409,
      code: 'WHATSAPP_TEMPLATE_DRAFT_NOT_EDITABLE',
    });
    expect(await refusal(service.discard(OPERATOR, draft.id))).toMatchObject({
      code: 'WHATSAPP_TEMPLATE_DRAFT_NOT_EDITABLE',
    });
  });

  it('discards a draft locally and never calls the provider', async () => {
    const { service, api, drafts } = setup();
    const { draft } = await service.create(OPERATOR, dto());

    await expect(service.discard(OPERATOR, draft.id)).resolves.toEqual({
      discarded: true,
    });
    expect(drafts.rows.size).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(api.writes).toHaveLength(0);
  });

  it('answers 404 with a stable code for an unknown draft', async () => {
    const { service } = setup();

    expect(await refusal(service.get(OPERATOR, randomUUID()))).toMatchObject({
      status: 404,
      code: 'WHATSAPP_TEMPLATE_DRAFT_NOT_FOUND',
    });
  });

  it('tells the UI the environment, the limits and whether the user is an operator', () => {
    const { service } = setup();

    expect(service.context(OPERATOR)).toMatchObject({
      operations: { enabled: true, operator: true },
      environment: { production: false, account_suffix: '0001' },
      options: {
        purposes: ['cod_confirmation'],
        variables: ['customer', 'store', 'order', 'total'],
        limits: { body: 1024, button_label: 25, style: 24 },
        review_max_hours: 24,
      },
    });
    expect(service.context(randomUUID()).operations).toEqual({
      enabled: true,
      operator: false,
    });
  });
});
