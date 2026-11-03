import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TEMPLATE_SYNC_STATES,
  WhatsappConnectionsRepository,
  type WhatsappConnectionRecord,
} from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import {
  WhatsappConnectionTemplatesRepository,
  type WhatsappConnectionTemplatePatch,
  type WhatsappConnectionTemplateRecord,
} from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import {
  WhatsappTemplatesRepository,
  type InspectedTemplate,
} from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { buildMetaTemplateCopyBody } from '../../infrastructure/spokes/meta/meta-template-components.builder';
import { describeMetaComponents } from '../../infrastructure/spokes/meta/meta-template-text';
import {
  OwnNumberGraphClient,
  type OwnNumberGraphFailure,
} from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import { readBusinessToken } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import { readWhatsappOwnNumberConfig } from '../../shared/config/whatsapp-own-number.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { planTemplateCopy } from '../../shared/messaging/template-copy.policy';
import type { ProviderTemplateRecord } from '../../shared/messaging/template-provider.types';
import {
  hasTextDrift,
  templateIdentity,
} from '../template-registry/template-sync.rules';
import {
  CONNECTION_TEMPLATE_STATUS,
  TEMPLATE_MAX_ATTEMPTS,
  TEMPLATE_RATE_LIMIT_DELAY_MS,
  classifyCreateFailure,
  componentsHash,
  intendedCategory,
  isProvisionable,
  isSubmittable,
  planRowSync,
  provisioningSettled,
  providerPatch,
  templateRetryDelayMs,
} from './template-provisioning.policy';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

/** One submission holds its row this long at most. */
export const TEMPLATE_SUBMISSION_LEASE_MS = 2 * 60_000;

export type TemplateRunOutcome =
  /** Nothing waits on a submission or an answer. */
  | 'settled'
  /** More to send or to confirm: run again at `nextRunAt`. */
  | 'more'
  /** Meta's list could not be read; nothing was changed. */
  | 'provider_unavailable'
  /** The token cannot manage this account's templates. */
  | 'credentials'
  /** The connection is not one whose templates are kept in step. */
  | 'skipped';

export interface TemplateRunResult {
  outcome: TemplateRunOutcome;
  submitted: number;
  nextRunAt: Date | null;
}

/**
 * Keeps a merchant's account holding the registry's templates. Each run reads
 * Meta's list first (the list is the truth), writes what it says to the
 * connection's rows, adds rows for templates newly live in the registry, then
 * submits what is still missing, one at a time with a pause between creates.
 *
 * Akeed's own account, token and template sync are not touched here: every
 * call uses the merchant's account id and the merchant's business token.
 */
@Injectable()
export class ConnectionTemplatesService {
  private readonly logger = new Logger(ConnectionTemplatesService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly rows: WhatsappConnectionTemplatesRepository,
    private readonly registry: WhatsappTemplatesRepository,
    private readonly graph: OwnNumberGraphClient,
    private readonly producer: WhatsappConnectionSetupProducer,
  ) {}

  /** The scheduled or webhook-requested sync of one connection. */
  async syncConnection(connectionId: string): Promise<TemplateRunResult> {
    const skipped: TemplateRunResult = {
      outcome: 'skipped',
      submitted: 0,
      nextRunAt: null,
    };
    const connection = await this.connections.findById(connectionId);
    if (
      !connection ||
      !(TEMPLATE_SYNC_STATES as readonly string[]).includes(connection.state) ||
      !connection.numberVerifiedAt
    ) {
      this.log('skipped', connection, { reason: 'not_syncable' });
      return skipped;
    }
    const token = readBusinessToken(
      connection,
      this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
    );
    if (!token) {
      this.log('failure', connection, { reason: 'credentials_unreadable' });
      return { ...skipped, outcome: 'credentials' };
    }
    const result = await this.run(connection, token);
    // A connection still in setup is driven by setup; any other continues
    // on its own until its submissions settle.
    if (
      result.outcome === 'more' &&
      connection.state !== 'connecting' &&
      result.nextRunAt
    )
      await this.producer.requestTemplateSync(
        connection.id,
        Math.max(result.nextRunAt.getTime() - Date.now(), 1_000),
      );
    return result;
  }

  /** One provisioning run for an account, for setup or a sync. */
  async run(
    connection: WhatsappConnectionRecord,
    businessToken: string,
  ): Promise<TemplateRunResult> {
    const { templateSubmitIntervalMs, templateBatchSize } =
      readWhatsappOwnNumberConfig(this.config);
    const observedAt = new Date().toISOString();
    const listed = await this.graph.listTemplates({
      wabaId: connection.wabaId,
      businessToken,
    });
    if (!listed.ok) {
      const outcome = credentialFailure(listed)
        ? 'credentials'
        : 'provider_unavailable';
      this.log('failure', connection, {
        reason: outcome,
        graphErrorCode: listed.graphErrorCode,
      });
      return { outcome, submitted: 0, nextRunAt: null };
    }

    const [inspected, retired] = await Promise.all([
      this.registry.findAllForInspection(),
      this.registry.findRetiredKeys(),
    ]);
    const retiredKeys = new Set(retired);
    const registryById = new Map(inspected.map((t) => [t.id, t]));
    const eligible = inspected.filter((t) => isProvisionable(t, retiredKeys));
    const eligibleIds = new Set(eligible.map((t) => t.id));

    const added = await this.rows.ensureRows(
      connection.orgId,
      connection.id,
      eligible.map((t) => ({
        templateId: t.id,
        metaLanguageCode: t.template.languageCode,
      })),
    );
    let now = new Date();
    for (const plan of planRowSync(
      await this.rows.listForConnection(connection.orgId, connection.id),
      listed.value,
      registryById,
      now,
    )) {
      if (!plan.patch) continue;
      await this.rows.updateForOrg(
        connection.orgId,
        plan.row.id,
        plan.patch,
        undefined,
        observedAt,
      );
      if (plan.patch.driftReason)
        this.log('drift', connection, {
          templateKey: registryById.get(plan.row.templateId)?.template.key,
          reason: plan.patch.driftReason,
        });
    }

    now = new Date();
    const due = (
      await this.rows.listForConnection(connection.orgId, connection.id)
    ).filter(
      (row) => eligibleIds.has(row.templateId) && isSubmittable(row, now),
    );

    let submitted = 0;
    let stopped: TemplateRunOutcome | null = null;
    for (const row of due.slice(0, templateBatchSize)) {
      if (submitted > 0 && templateSubmitIntervalMs > 0)
        await this.pause(templateSubmitIntervalMs);
      const claimed = await this.rows.claimForSubmission(
        connection.orgId,
        row.id,
        TEMPLATE_SUBMISSION_LEASE_MS,
      );
      if (!claimed) continue;
      submitted += 1;
      const stop = await this.submit(
        connection,
        businessToken,
        claimed,
        registryById.get(claimed.templateId)!,
      );
      if (stop) {
        stopped = stop;
        break;
      }
    }

    const after = (
      await this.rows.listForConnection(connection.orgId, connection.id)
    ).filter((row) => eligibleIds.has(row.templateId));
    this.log('success', connection, {
      added,
      submitted,
      ...(stopped ? { stoppedBy: stopped } : {}),
    });
    if (stopped === 'credentials')
      return { outcome: 'credentials', submitted, nextRunAt: null };
    if (provisioningSettled(after))
      return { outcome: 'settled', submitted, nextRunAt: null };
    return {
      outcome: 'more',
      submitted,
      nextRunAt: nextRunAt(after, new Date(), templateSubmitIntervalMs),
    };
  }

  /**
   * One create request for one claimed row. Returns why the run must stop,
   * or null to go on with the next template.
   */
  private async submit(
    connection: WhatsappConnectionRecord,
    businessToken: string,
    row: WhatsappConnectionTemplateRecord,
    template: InspectedTemplate,
  ): Promise<TemplateRunOutcome | null> {
    const write = (patch: WhatsappConnectionTemplatePatch) =>
      this.rows.updateForOrg(connection.orgId, row.id, patch, row.attempts);
    const plan = planTemplateCopy(
      template.template,
      intendedCategory(template),
      describeMetaComponents(template.components),
      template.template.templateName,
    );
    const body =
      plan.kind === 'create'
        ? buildMetaTemplateCopyBody(plan.submission)
        : null;
    if (plan.kind === 'skip' || !body) {
      await write({
        status: CONNECTION_TEMPLATE_STATUS.incompatible,
        lastErrorCode: plan.kind === 'skip' ? plan.reason : 'unknown_category',
        leaseUntil: null,
      });
      this.log('failure', connection, {
        templateKey: template.template.key,
        reason: plan.kind === 'skip' ? plan.reason : 'unknown_category',
      });
      return null;
    }

    const created = await this.graph.createTemplate({
      wabaId: connection.wabaId,
      businessToken,
      body,
    });
    const submittedHash = componentsHash(template.components!);
    if (created.ok) {
      await write({
        metaTemplateId: created.value.providerTemplateId,
        status: created.value.status,
        category: created.value.category,
        submittedAt: 'now',
        submittedComponentsHash: submittedHash,
        lastError: null,
        lastErrorCode: null,
        nextAttemptAt: null,
        leaseUntil: null,
      });
      return null;
    }

    const failure = classifyCreateFailure(created);
    switch (failure.kind) {
      case 'duplicate':
        await this.adoptExisting(connection, businessToken, template, write);
        return null;
      case 'unresolved':
        // Meta may hold it. The next list decides; nothing is sent again
        // before that.
        await write({
          status: CONNECTION_TEMPLATE_STATUS.unresolved,
          lastErrorCode: 'no_answer',
          leaseUntil: null,
        });
        return null;
      case 'rejected':
        await write({
          status: CONNECTION_TEMPLATE_STATUS.exhausted,
          lastErrorCode: failure.errorCode,
          leaseUntil: null,
          nextAttemptAt: null,
        });
        this.log('failure', connection, {
          templateKey: template.template.key,
          reason: failure.errorCode,
          graphErrorCode: created.graphErrorCode,
        });
        return null;
      case 'rate_limited':
        await write(
          retryPatch(
            row.attempts,
            failure.errorCode,
            TEMPLATE_RATE_LIMIT_DELAY_MS,
          ),
        );
        return 'more';
      case 'credentials':
        await write(retryPatch(row.attempts, failure.errorCode));
        return 'credentials';
    }
  }

  /**
   * Meta says the name and language already exist. That alone proves
   * nothing about the text, so the list is read again: a template with the
   * registry's text is adopted; other text is adopted for its status and
   * marked for staff, and is never overwritten or deleted.
   */
  private async adoptExisting(
    connection: WhatsappConnectionRecord,
    businessToken: string,
    template: InspectedTemplate,
    write: (
      patch: WhatsappConnectionTemplatePatch,
    ) => Promise<WhatsappConnectionTemplateRecord | null>,
  ): Promise<void> {
    const listed = await this.graph.listTemplates({
      wabaId: connection.wabaId,
      businessToken,
    });
    const identity = templateIdentity(
      template.template.templateName,
      template.template.languageCode,
    );
    const record: ProviderTemplateRecord | undefined = listed.ok
      ? listed.value.find(
          (r) => templateIdentity(r.templateName, r.languageCode) === identity,
        )
      : undefined;
    if (!record) {
      await write({
        status: CONNECTION_TEMPLATE_STATUS.unresolved,
        lastErrorCode: 'duplicate_not_listed',
        leaseUntil: null,
      });
      return;
    }
    const same =
      !('unknown' in record.components) &&
      !hasTextDrift(template.components, record.components);
    await write({
      ...providerPatch(record),
      ...(same
        ? { submittedComponentsHash: componentsHash(template.components!) }
        : { driftAt: 'now', driftReason: 'provider_differs' }),
    });
    this.log(same ? 'success' : 'drift', connection, {
      templateKey: template.template.key,
      reason: same ? 'duplicate_adopted' : 'provider_differs',
    });
  }

  /** The pause between two creates. A method, so a test can skip it. */
  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(
    outcome: 'success' | 'failure' | 'skipped' | 'drift',
    connection: Pick<WhatsappConnectionRecord, 'id' | 'orgId'> | null,
    fields: Record<string, unknown>,
  ): void {
    const context = {
      action: 'whatsapp_connection_templates_run',
      // Drift needs staff, so it is logged as a warning.
      outcome: outcome === 'drift' ? ('failure' as const) : outcome,
      ...(outcome === 'drift' ? { attention: 'drift' } : {}),
      ...(connection
        ? { orgId: connection.orgId, connectionId: connection.id }
        : {}),
      ...fields,
    };
    if (outcome === 'failure' || outcome === 'drift')
      this.logger.warn(
        buildBackendLog(ConnectionTemplatesService.name, context),
      );
    else
      this.logger.log(
        buildBackendLog(ConnectionTemplatesService.name, context),
      );
  }
}

function credentialFailure(failure: OwnNumberGraphFailure): boolean {
  const failureClass = classifyCreateFailure(failure);
  return failureClass.kind === 'credentials';
}

function retryPatch(
  attempts: number,
  errorCode: string,
  delayMs = templateRetryDelayMs(attempts),
): WhatsappConnectionTemplatePatch {
  if (attempts >= TEMPLATE_MAX_ATTEMPTS)
    return {
      status: CONNECTION_TEMPLATE_STATUS.exhausted,
      lastErrorCode: errorCode,
      leaseUntil: null,
      nextAttemptAt: null,
    };
  return {
    status: CONNECTION_TEMPLATE_STATUS.failed,
    lastErrorCode: errorCode,
    leaseUntil: null,
    nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
  };
}

/**
 * When to look again: soon while anything can be sent or confirmed now, else
 * when the earliest retry falls due.
 */
function nextRunAt(
  rows: readonly WhatsappConnectionTemplateRecord[],
  now: Date,
  intervalMs: number,
): Date {
  const soon = new Date(now.getTime() + Math.max(intervalMs, 1_000));
  const waiting = rows
    .filter(
      (row) =>
        row.status === CONNECTION_TEMPLATE_STATUS.failed && row.nextAttemptAt,
    )
    .map((row) => Date.parse(row.nextAttemptAt!));
  const immediate = rows.some(
    (row) =>
      row.status !== CONNECTION_TEMPLATE_STATUS.failed &&
      !provisioningSettled([row]),
  );
  if (immediate || waiting.length === 0) return soon;
  return new Date(Math.max(Math.min(...waiting), soon.getTime()));
}
