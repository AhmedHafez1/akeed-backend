import { Injectable } from '@nestjs/common';
import { WooCommerceConnectionsRepository } from '../../database/repositories/woocommerce-connections.repository';
import type {
  SourceCredentialStatus,
  SourceSetupBlockedReason,
  SourceSetupContribution,
  SourceSetupContributor,
  SourceWebhookHealth,
} from '../../../shared/commerce/source-setup';
import { WooCommerceConnectionHealthService } from './woocommerce-connection-health.service';

/**
 * What the WooCommerce connection adds to setup and health (US-07-05).
 *
 * `describe` reads the connection row alone: it runs on every state read, so
 * it never waits on a store. The credential status is therefore the last
 * answer the store gave, and a disabled webhook is the last state Akeed read.
 * `inspectWebhooks` is the one that asks the store, and only the health read
 * calls it.
 *
 * Currency and phone country are not setup inputs here: every order carries
 * its own (contract record, finding 4.14). Both are reported as null and
 * neither blocks setup.
 *
 * A 401 and a 403 are both "rejected": either way the merchant has to
 * reconnect. A paused or deleted webhook is shown in health and is not a
 * setup blocker; only one the store disabled is.
 */
@Injectable()
export class WooCommerceSetupContributor implements SourceSetupContributor {
  readonly platformType = 'woocommerce';
  readonly readableWhenDisconnected = true;

  constructor(
    private readonly connections: WooCommerceConnectionsRepository,
    private readonly health: WooCommerceConnectionHealthService,
  ) {}

  async describe(source: {
    id: string;
    orgId: string;
  }): Promise<SourceSetupContribution | null> {
    const connection = await this.connections.findByIntegration(
      source.id,
      source.orgId,
    );
    if (!connection) return null;

    const disconnected = connection.disconnectedAt !== null;
    const credentials: SourceCredentialStatus = disconnected
      ? 'removed'
      : connection.health === 'ok'
        ? 'ok'
        : 'rejected';

    const blockedReasons: SourceSetupBlockedReason[] = [];
    if (disconnected) blockedReasons.push('source_disconnected');
    else {
      if (credentials === 'rejected')
        blockedReasons.push('credentials_rejected');
      if (
        connection.orderCreatedWebhookState === 'disabled' ||
        connection.orderUpdatedWebhookState === 'disabled'
      )
        blockedReasons.push('webhook_disabled');
    }

    return {
      connectionState: disconnected ? 'disconnected' : 'connected',
      disconnectedAt: connection.disconnectedAt,
      store: {
        reference: connection.storeUrl,
        verified: connection.storeVerifiedAt !== null,
      },
      orderDefaults: { currency: null, phoneCountry: null },
      blockedReasons,
      credentials: { status: credentials },
      // Akeed sets the webhook secret itself, so there is none to be missing.
      delivery: {
        secretsMissing: false,
        rejectedCount: connection.rejectedDeliveries,
        lastRejectedAt: connection.lastRejectedAt,
      },
    };
  }

  inspectWebhooks(source: {
    id: string;
    orgId: string;
  }): Promise<SourceWebhookHealth | null> {
    return this.health.inspectWebhooks(source.id, source.orgId);
  }
}
