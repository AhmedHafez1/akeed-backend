import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WhatsappTemplateDraftsRepository,
  effectiveDraftState,
  toDraftContent,
  type NewTemplateDraft,
  type TemplateAuditEntry,
  type TemplateDraftRow,
} from '../../infrastructure/database/repositories/whatsapp-template-drafts.repository';
import {
  isWhatsappTemplateOperator,
  readWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  TEMPLATE_VARIABLE_KEYS,
  type TemplateDraftContent,
  type TemplateDraftIssue,
  type TemplateDraftState,
  type TemplateSubmissionResult,
} from '../../shared/messaging/template-draft.types';
import {
  TEMPLATE_BODY_MAX_LENGTH,
  TEMPLATE_BUTTON_LABEL_MAX_LENGTH,
  TEMPLATE_LANGUAGE_CODES,
  TEMPLATE_STYLE_MAX_LENGTH,
  buildDraftKey,
  buildTemplateName,
  draftIdentity,
  fillDraftBody,
  toTemplateSubmission,
  validateTemplateDraft,
} from '../../shared/messaging/template-draft.validation';
import { EXPECTED_CATEGORY_BY_PURPOSE } from '../../shared/messaging/template-provider.types';
import type {
  TemplateLanguage,
  TemplateVariableKey,
} from '../../shared/messaging/template-registry.types';
import { templateSampleValues } from '../../shared/messaging/template-rendering';
import {
  templateDirection,
  type RenderedTemplateMessage,
} from '../../shared/messaging/template-text.types';
import {
  TEMPLATE_CATALOG_PORT,
  TemplateSubmissionError,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import type {
  AdminTemplateDraftDto,
  AdminTemplateDraftUpdateDto,
  AdminTemplateDraftValidateDto,
} from './dto/admin-template-authoring.dto';
import { WHATSAPP_TEMPLATE_ERROR_CODES } from './whatsapp-template-operator.guard';

export const WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS = {
  create: 'whatsapp-templates.draft.create',
  update: 'whatsapp-templates.draft.update',
  discard: 'whatsapp-templates.draft.discard',
  submit: 'whatsapp-templates.submit',
  reconcile: 'whatsapp-templates.reconcile',
} as const;

/** A review decision can take this long (record 4.2.3). */
export const TEMPLATE_REVIEW_MAX_HOURS = 24;

const DRAFT_LIST_LIMIT = 200;

export interface AdminTemplateDraftView {
  id: string;
  key: string;
  purpose: string;
  language: TemplateLanguage;
  style: string;
  version: number;
  template_name: string;
  language_code: string;
  parameter_format: string;
  category: string;
  body: string;
  confirm_label: string;
  cancel_label: string;
  samples: Partial<Record<TemplateVariableKey, string>>;
  state: TemplateDraftState;
  state_changed_at: string;
  last_error_code: string | null;
  /** The registry key, once the provider holds the template. */
  template_key: string | null;
  created_at: string;
  updated_at: string;
  variables: {
    variable: TemplateVariableKey;
    parameter: string;
    sample: string;
  }[];
  validation: { valid: boolean; issues: TemplateDraftIssue[] };
  preview: RenderedTemplateMessage;
}

export interface AdminTemplateAuthoringContext {
  operations: { enabled: boolean; operator: boolean };
  /** Which provider account this environment writes to (criterion 10). */
  environment: { production: boolean; account_suffix: string | null };
  options: {
    purposes: string[];
    language_codes: Record<TemplateLanguage, readonly string[]>;
    variables: readonly TemplateVariableKey[];
    sample_defaults: Record<
      TemplateLanguage,
      Record<TemplateVariableKey, string>
    >;
    category: Record<string, string>;
    limits: { body: number; button_label: number; style: number };
    review_max_hours: number;
  };
}

export interface AdminTemplateDraftCheck {
  template_name: string;
  key: string;
  version: number;
  variables: AdminTemplateDraftView['variables'];
  validation: AdminTemplateDraftView['validation'];
}

export type AdminTemplateSubmitOutcome =
  | 'created'
  | 'adopted'
  | 'already_submitted'
  | 'not_at_provider';

function previewOf(content: TemplateDraftContent): RenderedTemplateMessage {
  return {
    paragraphs: fillDraftBody(content.body, content.samples)
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    buttons: [
      { label: content.confirmLabel, kind: 'quick_reply' },
      { label: content.cancelLabel, kind: 'quick_reply' },
    ],
    direction: templateDirection(content.language),
  };
}

/**
 * Staff template drafts and their submission to the provider (US-08-06
 * criteria 2 to 4).
 *
 * A submit is safe to repeat:
 * - Only one submit holds a draft at a time; a second one is told so.
 * - Before anything is created, the provider's own list is read. If it
 *   already holds the draft's name and language, that template is adopted and
 *   nothing is created.
 * - A create is sent once. With no usable answer the draft becomes
 *   `submit_unknown` and nothing more is sent until staff ask Akeed to check
 *   the provider, which reads the list again (contract record 4.1 rule).
 * - The registry row is inserted only when the provider has confirmed the
 *   template, inactive and never a default.
 */
@Injectable()
export class AdminTemplateDraftService {
  private readonly logger = new Logger(AdminTemplateDraftService.name);

  constructor(
    private readonly drafts: WhatsappTemplateDraftsRepository,
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog: TemplateCatalogPort,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
    private readonly config: ConfigService,
  ) {}

  context(userId: string): AdminTemplateAuthoringContext {
    const config = readWhatsappTemplateConfig(this.config);
    return {
      operations: {
        enabled: config.operationsEnabled,
        operator: isWhatsappTemplateOperator(config, userId),
      },
      environment: {
        production: this.config.get<string>('NODE_ENV') === 'production',
        account_suffix: config.businessAccountId?.slice(-4) ?? null,
      },
      options: {
        purposes: Object.keys(EXPECTED_CATEGORY_BY_PURPOSE),
        language_codes: TEMPLATE_LANGUAGE_CODES,
        variables: TEMPLATE_VARIABLE_KEYS,
        sample_defaults: {
          ar: templateSampleValues('ar'),
          en: templateSampleValues('en'),
        },
        category: EXPECTED_CATEGORY_BY_PURPOSE,
        limits: {
          body: TEMPLATE_BODY_MAX_LENGTH,
          button_label: TEMPLATE_BUTTON_LABEL_MAX_LENGTH,
          style: TEMPLATE_STYLE_MAX_LENGTH,
        },
        review_max_hours: TEMPLATE_REVIEW_MAX_HOURS,
      },
    };
  }

  async list(
    userId: string,
  ): Promise<
    AdminTemplateAuthoringContext & { drafts: AdminTemplateDraftView[] }
  > {
    const [rows, taken] = await Promise.all([
      this.drafts.list(DRAFT_LIST_LIMIT),
      this.drafts.takenIdentities(),
    ]);
    return {
      ...this.context(userId),
      drafts: rows.map((row) => this.view(row, withoutOwn(taken, row))),
    };
  }

  async get(
    userId: string,
    id: string,
  ): Promise<
    AdminTemplateAuthoringContext & { draft: AdminTemplateDraftView }
  > {
    const row = await this.require(id);
    return {
      ...this.context(userId),
      draft: this.view(row, await this.drafts.takenIdentities(id)),
    };
  }

  /** Checks a draft as written, without saving anything. */
  async check(
    dto: AdminTemplateDraftValidateDto,
  ): Promise<AdminTemplateDraftCheck> {
    const saved = dto.draft_id ? await this.require(dto.draft_id) : undefined;
    const version =
      saved?.version ??
      (await this.drafts.nextVersion(dto.purpose, dto.language, dto.style));
    const content: TemplateDraftContent = saved
      ? {
          ...toDraftContent(saved),
          ...textOf(dto),
          languageCode: dto.language_code,
          parameterFormat: dto.parameter_format,
        }
      : {
          ...this.newDraft(dto),
          version,
          templateName: buildTemplateName(dto.purpose, dto.style, version),
        };
    const validation = validateTemplateDraft(content, {
      takenIdentities: await this.drafts.takenIdentities(saved?.id),
    });
    return {
      template_name: content.templateName,
      key: buildDraftKey(
        content.purpose,
        content.language,
        content.style,
        content.version,
      ),
      version: content.version,
      variables: toVariableRows(validation.variables),
      validation: { valid: validation.valid, issues: validation.issues },
    };
  }

  async create(
    userId: string,
    dto: AdminTemplateDraftDto,
    requestId?: string,
  ): Promise<{ draft: AdminTemplateDraftView }> {
    const row = await this.drafts.create(this.newDraft(dto), {
      userId,
      action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.create,
      requestId,
    });
    if (!row) throw this.nameTaken();
    this.log(
      'whatsapp-template-draft-create',
      'success',
      userId,
      requestId,
      row,
    );
    return { draft: this.view(row, await this.drafts.takenIdentities(row.id)) };
  }

  async update(
    userId: string,
    id: string,
    dto: AdminTemplateDraftUpdateDto,
    requestId?: string,
  ): Promise<{ draft: AdminTemplateDraftView }> {
    const result = await this.drafts.update(
      id,
      {
        ...patchOf(dto),
        languageCode: dto.language_code,
        parameterFormat: dto.parameter_format,
      },
      {
        userId,
        action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.update,
        requestId,
      },
    );
    if (result.kind === 'not_found') throw this.notFound();
    if (result.kind === 'not_editable') throw this.notEditable();
    if (result.kind === 'name_taken') throw this.nameTaken();
    return {
      draft: this.view(result.draft, await this.drafts.takenIdentities(id)),
    };
  }

  async discard(
    userId: string,
    id: string,
    requestId?: string,
  ): Promise<{ discarded: true }> {
    const result = await this.drafts.discard(id, {
      userId,
      action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.discard,
      requestId,
    });
    if (result === 'not_found') throw this.notFound();
    if (result === 'not_editable') throw this.notEditable();
    return { discarded: true };
  }

  async submit(
    userId: string,
    id: string,
    requestId?: string,
  ): Promise<{
    outcome: AdminTemplateSubmitOutcome;
    draft: AdminTemplateDraftView;
  }> {
    const saved = await this.require(id);
    if (effectiveDraftState(saved) === 'draft') {
      const validation = validateTemplateDraft(toDraftContent(saved), {
        takenIdentities: await this.drafts.takenIdentities(id),
      });
      if (!validation.valid) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'The draft does not pass validation.',
          code: WHATSAPP_TEMPLATE_ERROR_CODES.draftInvalid,
          issues: validation.issues,
        });
      }
    }
    const claim = await this.drafts.claimForSubmit(id);
    switch (claim.kind) {
      case 'not_found':
        throw this.notFound();
      case 'in_progress':
        throw this.conflict(
          WHATSAPP_TEMPLATE_ERROR_CODES.submitInProgress,
          'This draft is being submitted.',
        );
      case 'unresolved':
        throw this.conflict(
          WHATSAPP_TEMPLATE_ERROR_CODES.submitUnresolved,
          'The last submit got no answer. Check the provider before submitting again.',
        );
      case 'already_submitted':
        return {
          outcome: 'already_submitted',
          draft: this.view(claim.draft, new Set()),
        };
      case 'claimed':
        return this.settle(claim.draft, 'submit', {
          userId,
          action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.submit,
          requestId,
        });
    }
  }

  /**
   * Resolves a submit that got no answer by reading the provider. Found, the
   * template is adopted; not found, the draft can be submitted again.
   */
  async reconcile(
    userId: string,
    id: string,
    requestId?: string,
  ): Promise<{
    outcome: AdminTemplateSubmitOutcome;
    draft: AdminTemplateDraftView;
  }> {
    const claimed = await this.drafts.claimForReconcile(id);
    if (claimed === undefined) throw this.notFound();
    if (claimed === null) {
      throw this.conflict(
        WHATSAPP_TEMPLATE_ERROR_CODES.reconcileNotNeeded,
        'This draft has no unanswered submit to check.',
      );
    }
    return this.settle(claimed, 'reconcile', {
      userId,
      action: WHATSAPP_TEMPLATE_DRAFT_AUDIT_ACTIONS.reconcile,
      requestId,
    });
  }

  private async settle(
    draft: TemplateDraftRow,
    mode: 'submit' | 'reconcile',
    actor: Omit<TemplateAuditEntry, 'metadata'>,
  ): Promise<{
    outcome: AdminTemplateSubmitOutcome;
    draft: AdminTemplateDraftView;
  }> {
    const content = toDraftContent(draft);
    const submission = toTemplateSubmission(content);
    const audit = (metadata: Record<string, unknown>): TemplateAuditEntry => ({
      ...actor,
      metadata: { draftId: draft.id, templateKey: draft.key, ...metadata },
    });

    let held: TemplateSubmissionResult | undefined;
    try {
      const identity = draftIdentity(
        content.templateName,
        content.languageCode,
      );
      const record = (await this.catalog.listTemplates()).find(
        (entry) =>
          draftIdentity(entry.templateName, entry.languageCode) === identity,
      );
      held = record && {
        providerTemplateId: record.providerTemplateId,
        status: record.status,
        category: record.category,
      };
    } catch (error) {
      // Nothing was sent, so the draft goes back to where it was.
      await this.drafts.closeClaim(
        draft.id,
        {
          state: mode === 'submit' ? 'draft' : 'submit_unknown',
          errorCode: 'provider_read_failed',
        },
        audit({ outcome: 'provider_read_failed' }),
      );
      this.log(
        `whatsapp-template-${mode}`,
        'failure',
        actor.userId,
        actor.requestId,
        draft,
        {
          errorCode: 'provider_read_failed',
          errorName: normalizeError(error).errorName,
        },
      );
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'The provider could not be read. Nothing was submitted.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.providerUnavailable,
      });
    }

    if (held) return this.confirm(draft, held, 'adopted', mode, audit);

    if (mode === 'reconcile') {
      await this.drafts.closeClaim(
        draft.id,
        { state: 'draft', errorCode: 'not_at_provider' },
        audit({ outcome: 'not_at_provider' }),
      );
      this.log(
        'whatsapp-template-reconcile',
        'success',
        actor.userId,
        actor.requestId,
        draft,
        {
          result: 'not_at_provider',
        },
      );
      return {
        outcome: 'not_at_provider',
        draft: this.view(
          await this.require(draft.id),
          await this.drafts.takenIdentities(draft.id),
        ),
      };
    }

    let created: TemplateSubmissionResult;
    try {
      created = await this.catalog.createTemplate(submission);
    } catch (error) {
      const failure =
        error instanceof TemplateSubmissionError
          ? error
          : new TemplateSubmissionError('unresolved', true);
      await this.drafts.closeClaim(
        draft.id,
        {
          state: failure.ambiguous ? 'submit_unknown' : 'draft',
          errorCode: failure.code,
          providerReference: failure.providerReference,
        },
        audit({
          outcome: failure.ambiguous ? 'unresolved' : 'refused',
          errorCode: failure.code,
          providerCode: failure.providerCode ?? null,
          providerReference: failure.providerReference ?? null,
        }),
      );
      this.log(
        'whatsapp-template-submit',
        'failure',
        actor.userId,
        actor.requestId,
        draft,
        {
          errorCode: failure.code,
          ambiguous: failure.ambiguous,
        },
      );
      if (failure.ambiguous) {
        throw new BadGatewayException({
          statusCode: 502,
          error: 'Bad Gateway',
          message:
            'The provider did not answer. Check the provider before submitting again.',
          code: WHATSAPP_TEMPLATE_ERROR_CODES.submitUnresolved,
        });
      }
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'The provider did not accept the template.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.submitRejected,
        reason: failure.code,
      });
    }
    return this.confirm(draft, created, 'created', mode, audit);
  }

  private async confirm(
    draft: TemplateDraftRow,
    result: TemplateSubmissionResult,
    outcome: 'created' | 'adopted',
    mode: 'submit' | 'reconcile',
    audit: (metadata: Record<string, unknown>) => TemplateAuditEntry,
  ): Promise<{
    outcome: AdminTemplateSubmitOutcome;
    draft: AdminTemplateDraftView;
  }> {
    const content = toDraftContent(draft);
    const entry = audit({
      outcome,
      providerReference: result.providerTemplateId,
      reviewStatus: result.status,
      category: result.category,
    });
    const confirmed = await this.drafts.confirmSubmission(
      draft.id,
      {
        result,
        variables: validateTemplateDraft(content, {
          takenIdentities: new Set(),
        }).variables,
      },
      entry,
    );
    this.registry.invalidate();
    this.log(
      `whatsapp-template-${mode}`,
      'success',
      entry.userId,
      entry.requestId,
      draft,
      {
        result: outcome,
        reviewStatus: result.status,
      },
    );
    return { outcome, draft: this.view(confirmed.draft, new Set()) };
  }

  private newDraft(dto: AdminTemplateDraftDto): NewTemplateDraft & {
    templateName: string;
    version: number;
  } {
    return {
      purpose: dto.purpose,
      language: dto.language,
      style: dto.style,
      languageCode: dto.language_code,
      parameterFormat: dto.parameter_format,
      category: EXPECTED_CATEGORY_BY_PURPOSE[dto.purpose],
      ...textOf(dto),
      templateName: '',
      version: 1,
    };
  }

  private view(
    row: TemplateDraftRow,
    takenIdentities: ReadonlySet<string>,
  ): AdminTemplateDraftView {
    const content = toDraftContent(row);
    const state = effectiveDraftState(row);
    // Once the provider holds the template its name is its own, not a clash.
    const validation = validateTemplateDraft(content, {
      takenIdentities: state === 'draft' ? takenIdentities : new Set(),
    });
    return {
      id: row.id,
      key: row.key,
      purpose: row.purpose,
      language: row.language,
      style: row.style,
      version: row.version,
      template_name: row.metaTemplateName,
      language_code: row.metaLanguageCode,
      parameter_format: row.parameterFormat,
      category: row.category,
      body: row.body,
      confirm_label: row.confirmLabel,
      cancel_label: row.cancelLabel,
      samples: row.samples,
      state,
      state_changed_at: row.stateChangedAt,
      last_error_code: row.lastErrorCode,
      template_key: row.templateId ? row.key : null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      variables: toVariableRows(validation.variables),
      validation: { valid: validation.valid, issues: validation.issues },
      preview: previewOf(content),
    };
  }

  private async require(id: string): Promise<TemplateDraftRow> {
    const row = await this.drafts.findById(id);
    if (!row) throw this.notFound();
    return row;
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'No template draft has this ID.',
      code: WHATSAPP_TEMPLATE_ERROR_CODES.draftNotFound,
    });
  }

  private notEditable(): ConflictException {
    return this.conflict(
      WHATSAPP_TEMPLATE_ERROR_CODES.draftNotEditable,
      'This draft has been submitted and can no longer be changed here.',
    );
  }

  private nameTaken(): ConflictException {
    return this.conflict(
      WHATSAPP_TEMPLATE_ERROR_CODES.draftNameTaken,
      'Another template already has this name and language.',
    );
  }

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message,
      code,
    });
  }

  private log(
    action: string,
    outcome: 'success' | 'failure',
    userId: string,
    requestId: string | undefined,
    draft: Pick<TemplateDraftRow, 'id' | 'key'>,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger[outcome === 'success' ? 'log' : 'warn'](
      buildBackendLog(AdminTemplateDraftService.name, {
        action,
        outcome,
        userId,
        requestId,
        draftId: draft.id,
        templateKey: draft.key,
        ...extra,
      }),
    );
  }
}

function withoutOwn(
  taken: ReadonlySet<string>,
  row: TemplateDraftRow,
): ReadonlySet<string> {
  const own = draftIdentity(row.metaTemplateName, row.metaLanguageCode);
  // The full list counts every draft, this one included.
  const others = new Set(taken);
  others.delete(own);
  return others;
}

export function textOf(dto: {
  body: string;
  confirm_label: string;
  cancel_label: string;
  samples: Partial<Record<TemplateVariableKey, string>>;
}) {
  return {
    body: dto.body,
    confirmLabel: dto.confirm_label,
    cancelLabel: dto.cancel_label,
    samples: { ...dto.samples },
  };
}

const patchOf = textOf;

function toVariableRows(
  variables: readonly {
    key: TemplateVariableKey;
    parameter: string;
    sample: string;
  }[],
): AdminTemplateDraftView['variables'] {
  return variables.map(({ key, parameter, sample }) => ({
    variable: key,
    parameter,
    sample,
  }));
}
