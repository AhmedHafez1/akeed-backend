import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { AdminAccessAuditRepository } from '../../infrastructure/database/repositories/admin-access-audit.repository';
import { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import { readWhatsappTemplateConfig } from '../../shared/config/whatsapp-template.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  planImageTwin,
  providerIdentity,
  type ImageTwinSkipReason,
} from '../../shared/messaging/image-twin.policy';
import type { TemplateReviewStatus } from '../../shared/messaging/template-provider.types';
import {
  TEMPLATE_CATALOG_PORT,
  TemplateCatalogError,
  TemplateSubmissionError,
  type TemplateCatalogPort,
  type TemplateSubmissionErrorCode,
} from '../../shared/ports/template-catalog.port';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import { LogoImageService } from '../merchant-branding/logo-image.service';
import { WHATSAPP_TEMPLATE_ERROR_CODES } from './whatsapp-template-operator.guard';

export const IMAGE_TWIN_AUDIT_ACTIONS = {
  create: 'whatsapp-templates.image-twins.create',
  activate: 'whatsapp-templates.image-twins.activate',
} as const;

/** A refusal that says nothing about one template: the run stops. */
const STOPPING_CODES: ReadonlySet<TemplateSubmissionErrorCode> = new Set([
  'not_configured',
  'auth_failed',
  'permission_denied',
  'rate_limited',
]);

export type ImageTwinOutcome =
  /** Submitted to the provider and registered, inactive. */
  | 'created'
  /** The provider already held it; registered without sending anything. */
  | 'adopted'
  | 'skipped'
  /** The provider refused it. */
  | 'failed'
  /** No usable answer: the provider may hold it. The next run checks. */
  | 'unresolved'
  /** The run stopped before this template. */
  | 'not_attempted';

export interface ImageTwinResultView {
  parent_key: string;
  parent_template_name: string;
  language_code: string;
  twin_template_name: string | null;
  outcome: ImageTwinOutcome;
  reason: ImageTwinSkipReason | TemplateSubmissionErrorCode | null;
  provider_code: number | null;
  review_status: TemplateReviewStatus | null;
}

export interface ImageTwinOverview {
  meta_app_configured: boolean;
  parents: {
    key: string;
    template_name: string;
    language_code: string;
    twin: {
      template_name: string;
      is_active: boolean;
      review_status: TemplateReviewStatus | null;
    } | null;
  }[];
}

function imageTwinError(status: HttpStatus, code: string, message: string) {
  return new HttpException(
    { statusCode: status, error: HttpStatus[status], message, code },
    status,
  );
}

/** A plain stand-in mark, so the review sample shows no real brand. */
async function sampleLogo(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
  <rect x="40" y="40" width="520" height="520" rx="120" fill="#e2e8f0"/>
  <circle cx="300" cy="300" r="150" fill="#94a3b8"/>
  <rect x="210" y="270" width="180" height="60" rx="30" fill="#e2e8f0"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Creates, for every text template, the image-header twin the logo header
 * sends, and switches on the twins the provider has approved. Each template
 * is submitted once, one after another; nothing is retried. A twin the
 * provider already holds (an earlier run, or an answer Akeed could not read)
 * is registered without being sent again, so a second run only fills gaps.
 */
@Injectable()
export class AdminImageTwinsService {
  private readonly logger = new Logger(AdminImageTwinsService.name);

  constructor(
    private readonly templates: WhatsappTemplatesRepository,
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog: TemplateCatalogPort,
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
    private readonly audit: AdminAccessAuditRepository,
    private readonly images: LogoImageService,
    private readonly config: ConfigService,
  ) {}

  async overview(): Promise<ImageTwinOverview> {
    const [parents, twins, retired] = await Promise.all([
      this.templates.findAllForInspection(),
      this.templates.findImageTwins(),
      this.templates.findRetiredKeys(),
    ]);
    const twinByParent = new Map(
      twins.map((twin) => [twin.imageTwinOfKey, twin]),
    );
    return {
      meta_app_configured: this.metaAppConfigured(),
      parents: parents
        .filter(({ template }) => !retired.includes(template.key))
        .map(({ template }) => {
          const twin = twinByParent.get(template.key);
          return {
            key: template.key,
            template_name: template.templateName,
            language_code: template.languageCode,
            twin: twin
              ? {
                  template_name: twin.templateName,
                  is_active: twin.isActive,
                  review_status: twin.reviewStatus,
                }
              : null,
          };
        }),
    };
  }

  async createMissing(params: {
    userId: string;
    requestId?: string;
  }): Promise<{ results: ImageTwinResultView[] }> {
    if (
      !this.metaAppConfigured() ||
      !this.catalog.uploadSampleImage ||
      !this.catalog.createImageTwin
    ) {
      throw imageTwinError(
        HttpStatus.SERVICE_UNAVAILABLE,
        WHATSAPP_TEMPLATE_ERROR_CODES.imageTwinNotConfigured,
        'Set META_APP_ID to create image twins.',
      );
    }

    const [parents, twins, retired, provider] = await Promise.all([
      this.templates.findAllForInspection(),
      this.templates.findImageTwins(),
      this.templates.findRetiredKeys(),
      this.readProviderIdentities(),
    ]);
    const context = {
      twinParentKeys: new Set(twins.map((twin) => twin.imageTwinOfKey)),
      providerIdentities: provider,
    };
    const plans = parents.map((parent) => ({
      parent,
      plan: planImageTwin(
        {
          template: parent.template,
          category: parent.template.category,
          retired: retired.includes(parent.template.key),
        },
        this.catalog.describeComponents(parent.components),
        context,
      ),
    }));

    // Upload the review sample only when something will be submitted.
    let headerHandle: string | null = null;
    if (plans.some(({ plan }) => plan.kind === 'create')) {
      headerHandle = await this.uploadSample();
    }

    const results: ImageTwinResultView[] = [];
    let stopped: TemplateSubmissionErrorCode | null = null;
    for (const { parent, plan } of plans) {
      const base = {
        parent_key: parent.template.key,
        parent_template_name: parent.template.templateName,
        language_code: parent.template.languageCode,
      };
      if (plan.kind === 'skip') {
        results.push({
          ...base,
          twin_template_name: null,
          outcome: 'skipped',
          reason: plan.reason,
          provider_code: null,
          review_status: null,
        });
        continue;
      }
      const twinName =
        plan.kind === 'adopt'
          ? plan.templateName
          : plan.submission.templateName;
      if (stopped) {
        results.push({
          ...base,
          twin_template_name: twinName,
          outcome: 'not_attempted',
          reason: stopped,
          provider_code: null,
          review_status: null,
        });
        continue;
      }
      if (plan.kind === 'adopt') {
        await this.templates.registerImageTwin(parent.template.key, {
          templateName: twinName,
          providerTemplateId: null,
          reviewStatus: null,
          category: null,
        });
        results.push({
          ...base,
          twin_template_name: twinName,
          outcome: 'adopted',
          reason: null,
          provider_code: null,
          review_status: null,
        });
        continue;
      }
      try {
        const created = await this.catalog.createImageTwin({
          ...plan.submission,
          headerHandle: headerHandle!,
        });
        await this.templates.registerImageTwin(parent.template.key, {
          templateName: twinName,
          providerTemplateId: created.providerTemplateId,
          reviewStatus: created.status,
          category: created.category,
        });
        results.push({
          ...base,
          twin_template_name: twinName,
          outcome: 'created',
          reason: null,
          provider_code: null,
          review_status: created.status,
        });
      } catch (error) {
        if (!(error instanceof TemplateSubmissionError)) throw error;
        if (STOPPING_CODES.has(error.code)) stopped = error.code;
        results.push({
          ...base,
          twin_template_name: twinName,
          outcome: error.ambiguous ? 'unresolved' : 'failed',
          reason: error.code,
          provider_code: error.providerCode ?? null,
          review_status: null,
        });
      }
    }

    this.registry.invalidate();
    const counts = countOutcomes(results);
    await this.audit.record({
      userId: params.userId,
      action: IMAGE_TWIN_AUDIT_ACTIONS.create,
      outcome: 'allowed',
      requestId: params.requestId,
      metadata: { ...counts, ...(stopped ? { stoppedBy: stopped } : {}) },
    });
    for (const result of results) {
      if (result.outcome === 'skipped') continue;
      this.logger.log(
        buildBackendLog(AdminImageTwinsService.name, {
          action: 'whatsapp-template-image-twin',
          outcome:
            result.outcome === 'created' || result.outcome === 'adopted'
              ? 'success'
              : 'failure',
          templateKey: result.parent_key,
          twinOutcome: result.outcome,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.provider_code !== null
            ? { providerCode: result.provider_code }
            : {}),
        }),
      );
    }
    return { results };
  }

  async activateApproved(params: {
    userId: string;
    requestId?: string;
  }): Promise<{
    activated: string[];
    waiting: { key: string; review_status: TemplateReviewStatus | null }[];
  }> {
    const activated = await this.templates.activateApprovedImageTwins();
    this.registry.invalidate();
    const twins = await this.templates.findImageTwins();
    const waiting = twins
      .filter((twin) => !twin.isActive)
      .map((twin) => ({
        key: twin.imageTwinOfKey,
        review_status: twin.reviewStatus,
      }));
    await this.audit.record({
      userId: params.userId,
      action: IMAGE_TWIN_AUDIT_ACTIONS.activate,
      outcome: 'allowed',
      requestId: params.requestId,
      metadata: { activated, waiting: waiting.length },
    });
    this.logger.log(
      buildBackendLog(AdminImageTwinsService.name, {
        action: 'whatsapp-template-image-twins-activate',
        outcome: 'success',
        activated: activated.length,
        waiting: waiting.length,
      }),
    );
    return { activated, waiting };
  }

  private metaAppConfigured(): boolean {
    return Boolean(readWhatsappTemplateConfig(this.config).metaAppId);
  }

  /** The provider's names and languages, read in full once per run. */
  private async readProviderIdentities(): Promise<Set<string>> {
    try {
      const records = await this.catalog.listTemplates();
      return new Set(
        records.map((record) =>
          providerIdentity(record.templateName, record.languageCode),
        ),
      );
    } catch (error) {
      if (!(error instanceof TemplateCatalogError)) throw error;
      // Without the list a rerun could submit a twin twice: stop here.
      throw imageTwinError(
        HttpStatus.SERVICE_UNAVAILABLE,
        WHATSAPP_TEMPLATE_ERROR_CODES.providerUnavailable,
        "The provider's templates could not be read. Try again shortly.",
      );
    }
  }

  private async uploadSample(): Promise<string> {
    try {
      const { banner } = await this.images.render(await sampleLogo());
      return await this.catalog.uploadSampleImage!(banner, 'image/jpeg');
    } catch (error) {
      this.logger.error(
        buildBackendLog(AdminImageTwinsService.name, {
          action: 'whatsapp-template-image-twin-sample',
          outcome: 'failure',
          ...(error instanceof TemplateSubmissionError
            ? { errorCode: error.code }
            : {}),
          ...normalizeError(error),
        }),
      );
      throw imageTwinError(
        HttpStatus.BAD_GATEWAY,
        WHATSAPP_TEMPLATE_ERROR_CODES.imageTwinUploadFailed,
        'The sample image could not be uploaded to the provider.',
      );
    }
  }
}

function countOutcomes(
  results: readonly ImageTwinResultView[],
): Record<ImageTwinOutcome, number> {
  const counts: Record<ImageTwinOutcome, number> = {
    created: 0,
    adopted: 0,
    skipped: 0,
    failed: 0,
    unresolved: 0,
    not_attempted: 0,
  };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}
