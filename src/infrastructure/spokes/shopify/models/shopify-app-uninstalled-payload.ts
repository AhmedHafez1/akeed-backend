export interface ShopifyAppUninstalledPayload {
  id: number;
  name?: string;
  email?: string;
  domain?: string;
  [key: string]: string | number | undefined;
}
