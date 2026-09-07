import type { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import type { integrations } from '../../infrastructure/database/schema';

type IntegrationRecord = typeof integrations.$inferSelect;

/**
 * Shared "find the org's current commerce source" lookups.
 *
 * Onboarding and test-verification each need this, but map the outcome to
 * different exceptions (different HTTP status, message, and error code), so
 * this returns a plain result for each caller to translate rather than
 * throwing itself — the lookup logic is shared, the error shaping is not.
 */

export type ShopifyLinkedIntegrationResolution =
  | { outcome: 'found'; integration: IntegrationRecord }
  | { outcome: 'not_found' }
  | { outcome: 'inactive'; integration: IntegrationRecord };

/**
 * Looks up the org's Shopify integration for a specific shop domain.
 *
 * `requireActive` controls whether an inactive match counts as found —
 * callers that only read state (onboarding) pass `false`, callers that are
 * about to act through the source (sending a test message) pass `true`.
 */
export async function resolveShopifyLinkedIntegration(
  integrationsRepo: IntegrationsRepository,
  params: { orgId: string; shopDomain: string; requireActive: boolean },
): Promise<ShopifyLinkedIntegrationResolution> {
  const integration = await integrationsRepo.findByOrgAndPlatformDomain(
    params.orgId,
    params.shopDomain,
    'shopify',
  );
  if (!integration) return { outcome: 'not_found' };
  if (params.requireActive && !integration.isActive) {
    return { outcome: 'inactive', integration };
  }
  return { outcome: 'found', integration };
}

export type FallbackActiveIntegrationResolution =
  | { outcome: 'found'; integration: IntegrationRecord }
  | { outcome: 'ambiguous' }
  | { outcome: 'missing'; hasInactiveSource: boolean };

/**
 * Resolves the org's single active commerce source when no platform-specific
 * identity (like a Shopify shop domain) is available to narrow the lookup.
 */
export async function resolveFallbackActiveIntegration(
  integrationsRepo: IntegrationsRepository,
  orgId: string,
): Promise<FallbackActiveIntegrationResolution> {
  const activeSources = await integrationsRepo.findActiveByOrg(orgId);
  if (activeSources.length > 1) return { outcome: 'ambiguous' };

  const source = activeSources[0];
  if (source) return { outcome: 'found', integration: source };

  const existingSources = await integrationsRepo.findByOrg(orgId);
  const hasInactiveSource = existingSources.some(
    (candidate) => candidate.isActive === false,
  );
  return { outcome: 'missing', hasInactiveSource };
}
