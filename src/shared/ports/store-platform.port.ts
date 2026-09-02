export const STORE_PLATFORM_PORT = Symbol('STORE_PLATFORM_PORT');
export interface StoreConnection {
  id: string;
  orgId: string;
  platformType: string;
  platformStoreUrl: string;
  accessToken: string | null;
  isActive: boolean | null;
  metadata: unknown;
}
export interface StorePlatformPort {
  getShopName(integration: StoreConnection): Promise<string>;
}
