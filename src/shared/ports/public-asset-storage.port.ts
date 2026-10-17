export const PUBLIC_ASSET_STORAGE_PORT = Symbol('PUBLIC_ASSET_STORAGE_PORT');

/**
 * Files anyone may download by URL, such as a store's logo and the banner
 * the messaging provider fetches. Never for anything private.
 */
export interface PublicAssetStoragePort {
  /**
   * Stores the bytes at `path` and returns their public https URL. A file
   * already at `path` is replaced.
   */
  put(path: string, bytes: Buffer, contentType: string): Promise<string>;
  /** Removes the files at the URLs `put` returned. Unknown URLs are ignored. */
  removeByUrls(urls: readonly string[]): Promise<void>;
}

/** What the storage provider said when it refused, for the logs only. */
export interface PublicAssetStorageErrorDetail {
  providerStatus?: string;
  providerMessage?: string;
}

/** The storage could not be reached or refused the write. */
export class PublicAssetStorageError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: PublicAssetStorageErrorDetail = {},
  ) {
    super('Public asset storage is unavailable.');
  }
}
