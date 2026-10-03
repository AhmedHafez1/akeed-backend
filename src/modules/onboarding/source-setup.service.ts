import { Inject, Injectable, Optional } from '@nestjs/common';
import { CommerceOutcomeSyncsRepository } from '../../infrastructure/database/repositories/commerce-outcome-syncs.repository';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import type { integrations } from '../../infrastructure/database/schema';
import { COMMERCE_OUTCOME_ACTIONS } from '../../shared/commerce/commerce-outcome';
import {
  SOURCE_HEALTH_WINDOW_DAYS,
  SOURCE_SETUP_CONTRIBUTORS,
  type SourceHealthDto,
  type SourceSetupContribution,
  type SourceSetupContributor,
} from '../../shared/commerce/source-setup';
import {
  MESSAGING_PORT,
  type MessagingPort,
  type MessagingSenderStatus,
} from '../../shared/ports/messaging.port';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';

type IntegrationRecord = typeof integrations.$inferSelect;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads what a source's own spoke says about its connection, by platform
 * type, and builds the source's health from facts the hub already records.
 * Nothing here names a provider: a source without a contributor simply has no
 * connection block and no credential or delivery signal.
 */
@Injectable()
export class SourceSetupService {
  private readonly contributors: ReadonlyMap<string, SourceSetupContributor>;

  constructor(
    @Inject(SOURCE_SETUP_CONTRIBUTORS)
    contributors: SourceSetupContributor[],
    private readonly integrationsRepo: IntegrationsRepository,
    private readonly webhookEvents: WebhookEventsRepository,
    private readonly outcomeSyncs: CommerceOutcomeSyncsRepository,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
    @Optional()
    @Inject(MESSAGING_PORT)
    private readonly messaging?: MessagingPort,
  ) {
    const byPlatform = new Map<string, SourceSetupContributor>();
    for (const contributor of contributors) {
      if (byPlatform.has(contributor.platformType))
        throw new Error(
          `Duplicate source setup contributor for ${contributor.platformType}`,
        );
      byPlatform.set(contributor.platformType, contributor);
    }
    this.contributors = byPlatform;
  }

  async describe(
    integration: Pick<IntegrationRecord, 'id' | 'orgId' | 'platformType'>,
  ): Promise<SourceSetupContribution | null> {
    const contributor = this.contributors.get(integration.platformType);
    return contributor
      ? contributor.describe({ id: integration.id, orgId: integration.orgId })
      : null;
  }

  /**
   * The organization's one source, when it is inactive because its merchant
   * disconnected it and its spoke keeps it readable. A source that is
   * inactive for any other reason is not found here.
   */
  async findReadableDisconnectedSource(
    orgId: string,
  ): Promise<IntegrationRecord | undefined> {
    const sources = await this.integrationsRepo.findByOrg(orgId);
    if (sources.length !== 1) return undefined;
    const [source] = sources;
    if (source.isActive !== false) return undefined;
    if (!this.contributors.get(source.platformType)?.readableWhenDisconnected)
      return undefined;
    const contribution = await this.describe(source);
    return contribution?.connectionState === 'disconnected'
      ? source
      : undefined;
  }

  senderStatus(): MessagingSenderStatus {
    return (
      this.messaging?.getSenderStatus?.() ?? {
        sender: 'akeed_shared',
        status: 'unknown',
      }
    );
  }

  async health(
    integration: IntegrationRecord,
    now = new Date(),
  ): Promise<SourceHealthDto> {
    const since = new Date(now.getTime() - SOURCE_HEALTH_WINDOW_DAYS * DAY_MS);
    const [contribution, events, syncs] = await Promise.all([
      this.describe(integration),
      this.webhookEvents.summarizeForIntegration(
        integration.orgId,
        integration.id,
        since,
      ),
      this.outcomeSyncs.summarizeForIntegration(
        integration.orgId,
        integration.id,
        since,
      ),
    ]);
    const active = integration.isActive === true;

    return {
      integrationId: integration.id,
      platformType: integration.platformType,
      connectionState:
        contribution?.connectionState ??
        (active ? 'connected' : 'disconnected'),
      disconnectedAt: contribution?.disconnectedAt ?? null,
      windowDays: SOURCE_HEALTH_WINDOW_DAYS,
      credentials: contribution?.credentials ?? null,
      events: {
        lastAcceptedAt: events.lastAcceptedAt,
        acceptedCount: events.acceptedCount,
      },
      processing: {
        failedCount: events.failedCount,
        lastFailedAt: events.lastFailedAt,
      },
      backlog: {
        waitingCount: events.waitingCount,
        oldestWaitingAt: events.oldestWaitingAt,
      },
      remoteSync: syncs,
      delivery: contribution?.delivery ?? null,
      // An inactive source writes nothing, whatever its adapter could do.
      capabilities: COMMERCE_OUTCOME_ACTIONS.map((action) => ({
        action,
        supported:
          active &&
          this.commerceOutcomes.supports(integration.platformType, action),
      })),
    };
  }
}
