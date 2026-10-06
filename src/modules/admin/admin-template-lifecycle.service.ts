import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { toDraftContent } from '../../infrastructure/database/repositories/whatsapp-template-drafts.repository';
import {
  WhatsappTemplateLifecycleRepository,
  type LifecycleRow,
  type TemplateImpact,
} from '../../infrastructure/database/repositories/whatsapp-template-lifecycle.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type {
  TemplateDraftContent,
  TemplateDraftIssue,
} from '../../shared/messaging/template-draft.types';
import {
  toTemplateSubmission,
  validateTemplateDraft,
} from '../../shared/messaging/template-draft.validation';
import {
  APPROVED_EDIT_LIMIT_PER_30_DAYS,
  APPROVED_EDIT_LIMIT_PER_DAY,
  type TemplateEditRefusal,
  type TemplateLifecycleAction,
  type TemplateLifecycleRefusal,
} from '../../shared/messaging/template-lifecycle.policy';
import {
  TEMPLATE_CATALOG_PORT,
  TemplateSubmissionError,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import { textOf } from './admin-template-draft.service';
import { templateNotFound } from './admin-template-inspection.service';
import type { AdminTemplateTextDto } from './dto/admin-template-authoring.dto';
import { WHATSAPP_TEMPLATE_ERROR_CODES } from './whatsapp-template-operator.guard';

export const WHATSAPP_TEMPLATE_LIFECYCLE_AUDIT_ACTIONS: Record<
  TemplateLifecycleAction | 'edit',
  string
> = {
  activate: 'whatsapp-templates.activate',
  deactivate: 'whatsapp-templates.deactivate',
  set_default: 'whatsapp-templates.set-default',
  retire: 'whatsapp-templates.retire',
  edit: 'whatsapp-templates.edit',
};

const REFUSAL_CODES: Record<TemplateLifecycleRefusal, string> = {
  retired: WHATSAPP_TEMPLATE_ERROR_CODES.retired,
  not_approved: WHATSAPP_TEMPLATE_ERROR_CODES.notApproved,
  not_active: WHATSAPP_TEMPLATE_ERROR_CODES.notActive,
  replacement_required: WHATSAPP_TEMPLATE_ERROR_CODES.replacementRequired,
  replacement_invalid: WHATSAPP_TEMPLATE_ERROR_CODES.replacementInvalid,
};

const REFUSAL_MESSAGES: Record<TemplateLifecycleRefusal, string> = {
  retired: 'This template is retired.',
  not_approved: 'Only a template the provider has approved can be used.',
  not_active: 'Only an active template can be the default.',
  replacement_required:
    'Stores send this template or it is a language default: name a replacement.',
  replacement_invalid:
    'The replacement must be an approved, active template of the same purpose and language.',
};

interface TemplateRef {
  key: string;
  style: string;
  template_name: string;
}

export interface AdminTemplateImpactView {
  key: string;
  is_active: boolean;
  is_default: boolean;
  retired: boolean;
  review_status: string | null;
  rejection_reason: string | null;
  stores: { total: number; active: number };
  requires_replacement: boolean;
  replacements: TemplateRef[];
  edit: {
    allowed: boolean;
    /** Why not, and the contract-record rule that says so. */
    refusal: TemplateEditRefusal | null;
    rule: string | null;
    draft_id: string | null;
    edits_last_day: number;
    edits_last_30_days: number;
    limits: { per_day: number; per_30_days: number };
  };
}

export interface AdminTemplateLifecycleResult {
  key: string;
  action: TemplateLifecycleAction;
  changed: boolean;
  is_active: boolean;
  is_default: boolean;
  retired: boolean;
  replacement_key: string | null;
  moved_stores: number;
}

function toRef(row: LifecycleRow): TemplateRef {
  return { key: row.key, style: row.style, template_name: row.templateName };
}

function toImpactView(impact: TemplateImpact): AdminTemplateImpactView {
  const { template, edit } = impact;
  return {
    key: template.key,
    is_active: template.isActive,
    is_default: template.isDefault,
    retired: template.retiredAt !== null,
    review_status: template.reviewStatus,
    rejection_reason: template.rejectionReason,
    stores: impact.stores,
    requires_replacement: impact.requiresReplacement,
    replacements: impact.replacements.map(toRef),
    edit: {
      allowed: edit.decision.ok,
      refusal: edit.decision.ok ? null : edit.decision.reason,
      rule: edit.decision.ok ? null : edit.decision.rule,
      draft_id: edit.draftId,
      edits_last_day: edit.editsLastDay,
      edits_last_30_days: edit.editsLast30Days,
      limits: {
        per_day: APPROVED_EDIT_LIMIT_PER_DAY,
        per_30_days: APPROVED_EDIT_LIMIT_PER_30_DAYS,
      },
    },
  };
}

/**
 * The staff actions on a registry template (US-08-06 criteria 5 to 7):
 * activate, deactivate, set default, retire and edit. Each is one audited
 * transaction; the rules are in `template-lifecycle.policy.ts`.
 */
@Injectable()
export class AdminTemplateLifecycleService {
  private readonly logger = new Logger(AdminTemplateLifecycleService.name);

  constructor(
    private readonly lifecycle: WhatsappTemplateLifecycleRepository,
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog: TemplateCatalogPort,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
  ) {}

  /** What an action on this template would touch, for the confirmation. */
  async impact(key: string): Promise<AdminTemplateImpactView> {
    const impact = await this.lifecycle.impact(key);
    if (!impact) throw templateNotFound();
    return toImpactView(impact);
  }

  async act(params: {
    userId: string;
    key: string;
    action: TemplateLifecycleAction;
    replacementKey?: string;
    requestId?: string;
  }): Promise<AdminTemplateLifecycleResult> {
    const { userId, key, action, requestId } = params;
    const outcome = await this.lifecycle.applyLifecycle({
      key,
      action,
      replacementKey: params.replacementKey,
      audit: {
        userId,
        action: WHATSAPP_TEMPLATE_LIFECYCLE_AUDIT_ACTIONS[action],
        requestId,
      },
    });
    if (outcome.kind === 'not_found') throw templateNotFound();
    if (outcome.kind === 'replacement_not_found') {
      throw this.refused('replacement_invalid');
    }
    if (outcome.kind === 'refused') {
      this.log(
        `whatsapp-template-${action}`,
        'failure',
        userId,
        requestId,
        key,
        {
          errorCode: REFUSAL_CODES[outcome.reason],
        },
      );
      throw this.refused(outcome.reason);
    }
    this.registry.invalidate();
    this.log(`whatsapp-template-${action}`, 'success', userId, requestId, key, {
      changed: outcome.changed,
      replacementKey: outcome.replacementKey,
      movedStores: outcome.movedStores,
    });
    return {
      key,
      action,
      changed: outcome.changed,
      is_active: outcome.after.is_active,
      is_default: outcome.after.is_default,
      retired: outcome.after.retired,
      replacement_key: outcome.replacementKey,
      moved_stores: outcome.movedStores,
    };
  }

  /**
   * Sends new text for a template the provider already holds. The edit is
   * recorded before it is sent, sent once, and never repeated here. From the
   * moment it is sent the template reads `pending`, so it cannot be activated
   * until the provider approves it again (contract record 4.3.8).
   */
  async edit(params: {
    userId: string;
    key: string;
    dto: AdminTemplateTextDto;
    requestId?: string;
  }): Promise<{ key: string; review_status: 'pending' }> {
    const { userId, key, requestId } = params;
    const audit = (metadata: Record<string, unknown>) => ({
      userId,
      action: WHATSAPP_TEMPLATE_LIFECYCLE_AUDIT_ACTIONS.edit,
      requestId,
      metadata: { templateKey: key, ...metadata },
    });

    const started = await this.lifecycle.beginEdit({ key, userId });
    if (started.kind === 'not_found') throw templateNotFound();
    if (started.kind === 'refused') {
      throw this.editRefused(started.reason, started.rule);
    }
    const { template, draft, editId } = started;
    const patch = textOf(params.dto);
    const content: TemplateDraftContent = {
      ...toDraftContent(draft),
      ...patch,
    };
    const validation = validateTemplateDraft(content, {
      takenIdentities: new Set(),
    });
    const finish = (
      outcome: 'applied' | 'refused' | 'unknown',
      metadata: Record<string, unknown>,
      providerReference?: string,
    ) =>
      this.lifecycle.finishEdit(
        {
          editId,
          templateId: template.id,
          draftId: draft.id,
          outcome,
          providerReference,
          ...(outcome === 'applied'
            ? { content: { patch, variables: validation.variables } }
            : {}),
        },
        audit({ outcome, ...metadata }),
      );

    // A text that cannot pass is closed as `refused`, which does not count
    // against an approved template's edits.
    if (!validation.valid || !template.providerTemplateId) {
      await finish('refused', { errorCode: 'invalid' });
      throw this.invalid(validation.issues);
    }

    try {
      await this.catalog.editTemplate(
        template.providerTemplateId,
        toTemplateSubmission(content, validation.variables),
      );
    } catch (error) {
      const failure =
        error instanceof TemplateSubmissionError
          ? error
          : new TemplateSubmissionError('unresolved', true);
      await finish(
        failure.ambiguous ? 'unknown' : 'refused',
        {
          errorCode: failure.code,
          providerCode: failure.providerCode ?? null,
          providerReference: failure.providerReference ?? null,
        },
        failure.providerReference,
      );
      if (failure.ambiguous) this.registry.invalidate();
      this.log('whatsapp-template-edit', 'failure', userId, requestId, key, {
        errorCode: failure.code,
        ambiguous: failure.ambiguous,
      });
      if (failure.ambiguous) {
        throw new BadGatewayException({
          statusCode: 502,
          error: 'Bad Gateway',
          message:
            'The provider did not answer. The template is treated as under review until the next sync.',
          code: WHATSAPP_TEMPLATE_ERROR_CODES.editUnresolved,
        });
      }
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'The provider did not accept the edit.',
        code: WHATSAPP_TEMPLATE_ERROR_CODES.editRejected,
        reason: failure.code,
      });
    }

    await finish('applied', {
      providerReference: template.providerTemplateId,
      previousReviewStatus: template.reviewStatus,
    });
    this.registry.invalidate();
    this.log('whatsapp-template-edit', 'success', userId, requestId, key);
    return { key, review_status: 'pending' };
  }

  private refused(reason: TemplateLifecycleRefusal): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: REFUSAL_MESSAGES[reason],
      code: REFUSAL_CODES[reason],
    });
  }

  private editRefused(
    reason: TemplateEditRefusal,
    rule: string,
  ): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'This template cannot be edited now.',
      code: WHATSAPP_TEMPLATE_ERROR_CODES.editRefused,
      reason,
      rule,
    });
  }

  private invalid(issues: TemplateDraftIssue[]): UnprocessableEntityException {
    return new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'The text does not pass validation.',
      code: WHATSAPP_TEMPLATE_ERROR_CODES.draftInvalid,
      issues,
    });
  }

  private log(
    action: string,
    outcome: 'success' | 'failure',
    userId: string,
    requestId: string | undefined,
    templateKey: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger[outcome === 'success' ? 'log' : 'warn'](
      buildBackendLog(AdminTemplateLifecycleService.name, {
        action,
        outcome,
        userId,
        requestId,
        templateKey,
        ...extra,
      }),
    );
  }
}
