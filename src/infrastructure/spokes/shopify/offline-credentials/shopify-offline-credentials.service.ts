import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../../shared/logging/backend-log.util';
import { decryptToken } from '../../../../shared/utils/token-encryption.util';
import { ShopifyOfflineCredentialsRepository } from '../../../database/repositories/shopify-offline-credentials.repository';
import { ShopifyCredentialService } from '../services/shopify-credential.service';
import {
  REFRESH_TOKEN_KEEP_ALIVE_BEFORE_MS,
  ShopifyReauthRequiredError,
  ShopifyTokenRequestError,
} from '../services/shopify-offline-token';
import { ShopifyTokenClient } from '../services/shopify-token.client';
import {
  isTokenMigrationEnabled,
  isTokenRefreshJobEnabled,
  KEEP_ALIVE_BATCH_SIZE,
  parseMigrationBatchSize,
  parseMigrationShops,
  SHOPIFY_TOKEN_MIGRATION_BATCH_SIZE_KEY,
  SHOPIFY_TOKEN_MIGRATION_ENABLED_KEY,
  SHOPIFY_TOKEN_MIGRATION_SHOPS_KEY,
  SHOPIFY_TOKEN_REFRESH_JOB_ENABLED_KEY,
  type ShopifyOfflineCredentialsSummary,
} from './shopify-offline-credentials.constants';

type MigrationOutcome = 'migrated' | 'skipped';

/**
 * One run: move a batch of stores off non-expiring tokens (when switched on),
 * then renew refresh tokens that end within two weeks. Each store is handled
 * alone; a failure is recorded on its row and the run carries on.
 */
@Injectable()
export class ShopifyOfflineCredentialsService {
  private readonly logger = new Logger(ShopifyOfflineCredentialsService.name);

  constructor(
    private readonly credentials: ShopifyOfflineCredentialsRepository,
    private readonly tokenClient: ShopifyTokenClient,
    private readonly credentialService: ShopifyCredentialService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async runOnce(
    now: Date = new Date(),
  ): Promise<ShopifyOfflineCredentialsSummary> {
    const summary: ShopifyOfflineCredentialsSummary = {
      migrated: 0,
      migrationFailed: 0,
      reauthRequired: 0,
      refreshed: 0,
      refreshFailed: 0,
      skipped: 0,
    };
    if (
      isTokenMigrationEnabled(
        this.config.get<string>(SHOPIFY_TOKEN_MIGRATION_ENABLED_KEY),
      )
    )
      await this.migrateBatch(summary);
    if (
      isTokenRefreshJobEnabled(
        this.config.get<string>(SHOPIFY_TOKEN_REFRESH_JOB_ENABLED_KEY),
      )
    )
      await this.keepAlive(summary, now);

    this.logger.log(
      buildBackendLog(ShopifyOfflineCredentialsService.name, {
        action: 'shopify-offline-credentials.run',
        outcome:
          summary.migrationFailed + summary.refreshFailed > 0
            ? 'failure'
            : 'success',
        ...summary,
      }),
    );
    return summary;
  }

  private async migrateBatch(
    summary: ShopifyOfflineCredentialsSummary,
  ): Promise<void> {
    const stores = await this.credentials.findLegacyBatch(
      parseMigrationBatchSize(
        this.config.get<string>(SHOPIFY_TOKEN_MIGRATION_BATCH_SIZE_KEY),
      ),
      parseMigrationShops(
        this.config.get<string>(SHOPIFY_TOKEN_MIGRATION_SHOPS_KEY),
      ),
    );
    for (const store of stores) {
      try {
        const outcome = await this.migrateStore(
          store.integrationId,
          store.shopDomain,
        );
        if (outcome === 'migrated') summary.migrated += 1;
        else summary.skipped += 1;
        this.logger.log(
          buildBackendLog(ShopifyOfflineCredentialsService.name, {
            action: 'shopify-offline-token-migrate',
            outcome: outcome === 'migrated' ? 'success' : 'skipped',
            integrationId: store.integrationId,
            shopDomain: store.shopDomain,
          }),
        );
      } catch (error) {
        await this.recordMigrationFailure(
          store.integrationId,
          store.shopDomain,
          error,
          summary,
        );
      }
    }
  }

  /**
   * Re-reads the store under its lock, so a store that reinstalled or moved
   * through an app open meanwhile is left alone. The legacy token stays
   * stored until the new pair commits: if the save fails, the next run sends
   * the same token and Shopify returns the same pair.
   */
  private migrateStore(
    integrationId: string,
    shopDomain: string,
  ): Promise<MigrationOutcome> {
    return this.credentials.withShopLock(shopDomain, async (tx) => {
      const current = await this.credentials.findState(integrationId, tx);
      if (
        !current?.isActive ||
        !current.accessToken ||
        current.credentialKind !== 'legacy' ||
        current.status !== 'active'
      )
        return 'skipped';
      const pair = await this.tokenClient.migrateLegacy(
        shopDomain,
        this.decrypt(current.accessToken),
      );
      await this.credentials.saveExpiringPair(
        tx,
        integrationId,
        pair,
        'migrated',
      );
      return 'migrated';
    });
  }

  private async recordMigrationFailure(
    integrationId: string,
    shopDomain: string,
    error: unknown,
    summary: ShopifyOfflineCredentialsSummary,
  ): Promise<void> {
    const kind =
      error instanceof ShopifyTokenRequestError ? error.kind : 'error';
    const errorCode = `migrate_${kind}`;
    try {
      if (kind === 'invalid_subject_token') {
        await this.credentials.markReauthRequired(integrationId, errorCode);
        summary.reauthRequired += 1;
      } else {
        await this.credentials.recordError(integrationId, errorCode);
        summary.migrationFailed += 1;
      }
    } catch (recordError) {
      summary.migrationFailed += 1;
      this.logger.error(
        buildBackendLog(ShopifyOfflineCredentialsService.name, {
          action: 'shopify-offline-token-migrate.record',
          outcome: 'failure',
          integrationId,
          shopDomain,
          ...normalizeError(recordError),
        }),
      );
    }
    this.logger.warn(
      buildBackendLog(ShopifyOfflineCredentialsService.name, {
        action: 'shopify-offline-token-migrate',
        outcome: 'failure',
        integrationId,
        shopDomain,
        errorCode,
        ...(error instanceof ShopifyTokenRequestError
          ? {
              httpStatus: error.httpStatus,
              providerError: error.providerError,
            }
          : normalizeError(error)),
      }),
    );
  }

  private async keepAlive(
    summary: ShopifyOfflineCredentialsSummary,
    now: Date,
  ): Promise<void> {
    const due = await this.credentials.findRefreshDue(
      new Date(
        now.getTime() + REFRESH_TOKEN_KEEP_ALIVE_BEFORE_MS,
      ).toISOString(),
      KEEP_ALIVE_BATCH_SIZE,
    );
    for (const store of due) {
      try {
        await this.credentialService.renew(
          { id: store.integrationId, platformStoreUrl: store.shopDomain },
          store.generation,
          true,
        );
        summary.refreshed += 1;
      } catch (error) {
        if (error instanceof ShopifyReauthRequiredError)
          summary.reauthRequired += 1;
        else summary.refreshFailed += 1;
        this.logger.warn(
          buildBackendLog(ShopifyOfflineCredentialsService.name, {
            action: 'shopify-offline-token-keep-alive',
            outcome: 'failure',
            integrationId: store.integrationId,
            shopDomain: store.shopDomain,
            ...normalizeError(error),
          }),
        );
      }
    }
  }

  private decrypt(payload: string): string {
    return decryptToken(
      payload,
      this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
    );
  }
}
