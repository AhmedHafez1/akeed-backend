import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { WhatsappTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-templates.repository';
import {
  TEMPLATE_CATALOG_PORT,
  type TemplateCatalogPort,
} from '../../shared/ports/template-catalog.port';
import { compareTemplateDrift } from '../../shared/messaging/template-drift';
import {
  TEMPLATE_REGISTRY_PORT,
  type TemplateRegistryPort,
} from '../../shared/ports/template-registry.port';
import {
  SENDER_RESOLVER_PORT,
  type SenderResolverPort,
  type ResolvedSender,
} from '../../shared/ports/sender-resolver.port';
import { WhatsappConnectionTemplatesRepository } from '../../infrastructure/database/repositories/whatsapp-connection-templates.repository';
import type { SelectedCodTemplate } from '../../shared/messaging/cod-template-selector';
import {
  selectTemplateForSend,
  toSelectedTemplate,
} from '../../shared/messaging/template-selector';
import { storeTemplateKeys } from '../../shared/messaging/store-template-selection';
import { changeTemplateUsable } from '../../shared/messaging/change-request-messaging';
import {
  applyLogoHeader,
  isHttpsUrl,
} from '../../shared/messaging/logo-header.policy';
import type { integrations } from '../../infrastructure/database/schema';
import type { TemplateSelectionSwitches } from '../../shared/messaging/template-selector';

type Integration = typeof integrations.$inferSelect;
export interface ChangeRequestReadiness {
  ready: boolean;
  variants: {
    language: string;
    style: string;
    sender: string;
    ready: boolean;
    reason: string | null;
    template_key?: string | null;
    branding_supported?: boolean;
    header_format?: 'none' | 'image';
  }[];
}

@Injectable()
export class ChangeRequestTemplatesService {
  constructor(
    @Inject(TEMPLATE_REGISTRY_PORT)
    private readonly registry: TemplateRegistryPort,
    @Inject(SENDER_RESOLVER_PORT) private readonly senders: SenderResolverPort,
    private readonly connectionTemplates: WhatsappConnectionTemplatesRepository,
    @Optional() private readonly templates?: WhatsappTemplatesRepository,
    @Optional()
    @Inject(TEMPLATE_CATALOG_PORT)
    private readonly catalog?: TemplateCatalogPort,
  ) {}

  async counterpart(
    base: SelectedCodTemplate,
    orgId: string,
    sender: ResolvedSender,
  ): Promise<SelectedCodTemplate | null> {
    // Read current persisted approvals rather than the ordinary selector's stale-on-error cache.
    const sibling = (
      await (this.templates?.findAll() ?? this.registry.listTemplates())
    ).find(
      (row) =>
        row.changeRequestOfKey === base.registryKey &&
        row.language === base.language &&
        row.languageCode === base.languageCode &&
        row.purpose ===
          (base.registryKey?.startsWith('cod_reminder.')
            ? 'cod_reminder'
            : 'cod_confirmation') &&
        changeTemplateUsable(row, sender.kind === 'akeed_system'),
    );
    if (!sibling) return null;
    if (this.catalog) {
      const drift = compareTemplateDrift({
        template: sibling,
        reviewStatus: sibling.reviewStatus,
        model: this.catalog.describeComponents(sibling.components ?? null),
        previewSource: 'provider',
      });
      if (
        drift.state === 'unreadable' ||
        drift.differences.some((difference) => difference.severity === 'send')
      )
        return null;
    }
    const selected = {
      ...toSelectedTemplate(sibling),
      variantKey: base.variantKey,
    };
    if (sender.kind === 'merchant_own') {
      if (!sender.connectionId) return null;
      const row = await this.connectionTemplates.findForSend(
        orgId,
        sender.connectionId,
        selected,
      );
      if (
        !row ||
        row.status !== 'approved' ||
        row.category !== 'utility' ||
        row.driftReason ||
        !row.lastSyncedAt
      )
        return null;
    }
    return selected;
  }

  async readiness(
    integration: Integration,
    switches: TemplateSelectionSwitches = {},
  ): Promise<ChangeRequestReadiness> {
    const templates = await this.registry.listTemplates();
    // Representatives cover every branch of the existing automatic language/dialect selectors.
    const phones =
      integration.defaultLanguage === 'auto'
        ? [
            '+201000000001',
            '+966500000001',
            '+212600000001',
            '+12025550100',
            '+923001234567',
            '+34600000000',
            '+33600000000',
            '+905000000000',
          ]
        : integration.defaultLanguage === 'ar' && integration.codTemplateArAuto
          ? ['+201000000001', '+966500000001', '+212600000001']
          : ['+12025550100'];
    const variants: ChangeRequestReadiness['variants'] = [];
    const seen = new Set<string>();
    for (const phone of phones)
      for (const kind of integration.followUpEnabled
        ? (['initial', 'follow_up'] as const)
        : (['initial'] as const)) {
        const selection = selectTemplateForSend(templates, {
          preferredLanguage: integration.defaultLanguage,
          phoneNumber: phone,
          ...storeTemplateKeys(integration),
          kind,
          arAuto: integration.codTemplateArAuto,
          switches,
          guardrail: {
            enabled: this.registry.sendGuardrailEnabled?.() === true,
          },
        });
        const base = selection.template;
        const key =
          base?.registryKey ??
          `${'language' in selection ? selection.language : ''}:${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!base) {
          variants.push({
            language: 'language' in selection ? selection.language : '',
            style: '',
            sender: 'unknown',
            ready: false,
            reason: 'confirmation_template_unavailable',
          });
          continue;
        }
        const sender = await this.senders.resolve({
          orgId: integration.orgId,
          template: base,
        });
        const variant = await this.selectVariant(base, integration, sender);
        const ready =
          variant.ready &&
          (!selection.fallbackReason ||
            selection.fallbackReason === 'key_missing');
        variants.push({
          language: base.language,
          style: base.variantKey,
          sender: sender.kind,
          ready,
          template_key: variant.template.registryKey ?? null,
          branding_supported: sender.kind === 'akeed_system',
          header_format: variant.template.imageHeader ? 'image' : 'none',
          reason: ready
            ? null
            : (variant.reason ?? 'confirmation_template_unavailable'),
        });
      }
    return {
      ready: variants.length > 0 && variants.every((variant) => variant.ready),
      variants,
    };
  }

  /** Uses the same sender-specific decision for settings and each new send. */
  async selectVariant(
    base: SelectedCodTemplate,
    integration: Integration,
    sender: ResolvedSender,
  ) {
    const twins =
      sender.kind === 'akeed_system'
        ? await (this.templates?.findImageTwins() ??
            this.registry.listImageTwins?.() ??
            Promise.resolve([]))
        : [];
    const branded =
      sender.kind === 'akeed_system' &&
      integration.logoHeaderEnabled &&
      Boolean(integration.logoUrl || integration.logoBannerUrl);
    const withLogo = (template: SelectedCodTemplate) =>
      applyLogoHeader(template, {
        enabled:
          sender.kind === 'akeed_system' && integration.logoHeaderEnabled,
        bannerUrl: integration.logoBannerUrl,
        twins,
        guardrail: { enabled: true },
      });
    const fallback = withLogo(base);
    const unavailable = async (reason: string) => {
      let sendable = false;
      if (sender.kind === 'merchant_own' && sender.connectionId) {
        const own = await this.connectionTemplates.findForSend(
          integration.orgId,
          sender.connectionId,
          base,
        );
        sendable = Boolean(
          own &&
          own.status === 'approved' &&
          own.category === 'utility' &&
          own.lastSyncedAt &&
          !own.driftReason,
        );
      } else if (sender.kind === 'akeed_system') {
        const original = (
          await (this.templates?.findAll() ?? this.registry.listTemplates())
        ).find((row) => row.key === base.registryKey);
        sendable = Boolean(
          original?.isActive &&
          original.reviewStatus === 'approved' &&
          original.category === 'utility' &&
          original.lastSyncedAt,
        );
        if (sendable && original && this.catalog) {
          const drift = compareTemplateDrift({
            template: original,
            reviewStatus: original.reviewStatus,
            model: this.catalog.describeComponents(original.components ?? null),
            previewSource: 'provider',
          });
          sendable =
            drift.state !== 'unreadable' &&
            !drift.differences.some((d) => d.severity === 'send');
        }
      }
      return {
        template: fallback,
        ready: false,
        sendable,
        reason: sendable ? reason : 'ordinary_fallback_unavailable',
      };
    };
    const counterpart = await this.counterpart(base, integration.orgId, sender);
    if (!counterpart) return unavailable('change_text_unavailable');
    if (!branded)
      return {
        template: counterpart,
        ready: true,
        sendable: true,
        reason: null,
      };
    if (!isHttpsUrl(integration.logoBannerUrl))
      return unavailable('logo_banner_unavailable');
    const template = withLogo(counterpart);
    return template.imageHeader
      ? { template, ready: true, sendable: true, reason: null }
      : unavailable('change_image_twin_unavailable');
  }

  async assertReady(
    integration: Integration,
    switches: TemplateSelectionSwitches,
  ): Promise<void> {
    const readiness = await this.readiness(integration, switches);
    if (!readiness.ready)
      throw new BadRequestException({
        code: 'CHANGE_REQUEST_TEMPLATES_UNAVAILABLE',
        message:
          'Change requests require approved, usable three-button templates for the selected sender, language and style.',
        readiness,
      });
  }
}
