import { resolveShopifyLinkedIntegration } from './current-integration-resolver';
import {
  createRequestContext,
  recordQuery,
  rememberAuthIntegration,
  runRequestContext,
} from '../request-context/request-context';

const remembered = {
  id: 'int-1',
  orgId: 'org-1',
  platformType: 'shopify',
  platformStoreUrl: 'synthetic.myshopify.com',
  isActive: true,
} as never;

const fromRepo = { ...(remembered as object), id: 'int-from-repo' } as never;

function repo() {
  return {
    findByOrgAndPlatformDomain: jest.fn().mockResolvedValue(fromRepo),
  } as never;
}

const params = {
  orgId: 'org-1',
  shopDomain: 'synthetic.myshopify.com',
  requireActive: false,
};

describe('resolveShopifyLinkedIntegration', () => {
  it('reuses the integration the auth guard loaded for the same org and shop', async () => {
    const integrations = repo();
    const resolution = await runRequestContext(createRequestContext(), () => {
      rememberAuthIntegration(remembered);
      return resolveShopifyLinkedIntegration(integrations, params);
    });
    expect(resolution).toEqual({ outcome: 'found', integration: remembered });
    expect(
      (integrations as { findByOrgAndPlatformDomain: jest.Mock })
        .findByOrgAndPlatformDomain,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['another organization', { ...params, orgId: 'org-2' }],
    ['another shop', { ...params, shopDomain: 'other.myshopify.com' }],
  ])('reads from the repository for %s', async (_, lookup) => {
    const integrations = repo();
    const resolution = await runRequestContext(createRequestContext(), () => {
      rememberAuthIntegration(remembered);
      return resolveShopifyLinkedIntegration(integrations, lookup);
    });
    expect(resolution).toEqual({ outcome: 'found', integration: fromRepo });
  });

  it('reads from the repository once the request has written', async () => {
    const integrations = repo();
    const resolution = await runRequestContext(createRequestContext(), () => {
      rememberAuthIntegration(remembered);
      recordQuery('update integrations set store_name = $1', 3);
      return resolveShopifyLinkedIntegration(integrations, params);
    });
    expect(resolution).toEqual({ outcome: 'found', integration: fromRepo });
  });

  it('reads from the repository outside a request context', async () => {
    const integrations = repo();
    await expect(
      resolveShopifyLinkedIntegration(integrations, params),
    ).resolves.toEqual({ outcome: 'found', integration: fromRepo });
  });

  it('still applies requireActive to a reused row', async () => {
    const inactive = { ...(remembered as object), isActive: false } as never;
    const resolution = await runRequestContext(createRequestContext(), () => {
      rememberAuthIntegration(inactive);
      return resolveShopifyLinkedIntegration(repo(), {
        ...params,
        requireActive: true,
      });
    });
    expect(resolution).toEqual({ outcome: 'inactive', integration: inactive });
  });

  it('reports not_found when neither source has the shop', async () => {
    const integrations = {
      findByOrgAndPlatformDomain: jest.fn().mockResolvedValue(undefined),
    } as never;
    await expect(
      resolveShopifyLinkedIntegration(integrations, params),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});
