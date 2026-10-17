import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_MERCHANT_LOGO_BUCKET,
  MERCHANT_BRANDING_CONFIG,
  type MerchantBrandingConfig,
} from '../../shared/config/merchant-branding.config';
import {
  PublicAssetStorageError,
  type PublicAssetStoragePort,
} from '../../shared/ports/public-asset-storage.port';

/** Each storage call gives up after this long. */
const STORAGE_TIMEOUT_MS = 15_000;

/**
 * Public files in a Supabase Storage bucket, written with the service role.
 * The bucket is created public by staff once per environment; this adapter
 * never creates or reconfigures it.
 */
@Injectable()
export class SupabasePublicAssetStorage implements PublicAssetStoragePort {
  private client: SupabaseClient | null = null;

  constructor(private readonly config: ConfigService) {}

  async put(path: string, bytes: Buffer, contentType: string): Promise<string> {
    const storage = this.bucket();
    const { error } = await withTimeout(
      storage.upload(path, bytes, {
        contentType,
        upsert: true,
        // The path changes with the content, so a long cache is safe.
        cacheControl: '31536000',
      }),
    );
    if (error) throw storageFailure('upload_failed', error);
    const { data } = storage.getPublicUrl(path);
    if (!data.publicUrl.startsWith('https://')) {
      throw new PublicAssetStorageError('public_url_not_https');
    }
    return data.publicUrl;
  }

  async removeByUrls(urls: readonly string[]): Promise<void> {
    const prefix = this.publicPrefix();
    const paths = urls
      .filter((url) => url.startsWith(prefix))
      .map((url) => decodeURIComponent(url.slice(prefix.length)));
    if (paths.length === 0) return;
    const { error } = await withTimeout(this.bucket().remove(paths));
    if (error) throw storageFailure('remove_failed', error);
  }

  /** The URL every public file of the bucket starts with. */
  private publicPrefix(): string {
    return this.bucket().getPublicUrl('').data.publicUrl.replace(/\/?$/, '/');
  }

  private bucket() {
    this.client ??= createClient(
      this.config.getOrThrow<string>('SUPABASE_URL'),
      this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const bucket =
      this.config.get<MerchantBrandingConfig>(MERCHANT_BRANDING_CONFIG)
        ?.bucket ?? DEFAULT_MERCHANT_LOGO_BUCKET;
    return this.client.storage.from(bucket);
  }
}

/**
 * Keeps Supabase's own status and message for the logs. A missing bucket
 * gets its own reason because it is a setup step, not an outage.
 */
export function storageFailure(
  fallback: string,
  error: unknown,
): PublicAssetStorageError {
  const fields = (error ?? {}) as {
    message?: unknown;
    statusCode?: unknown;
    status?: unknown;
  };
  const providerMessage =
    typeof fields.message === 'string'
      ? fields.message.slice(0, 200)
      : undefined;
  const rawStatus = fields.statusCode ?? fields.status;
  const providerStatus =
    typeof rawStatus === 'string' || typeof rawStatus === 'number'
      ? String(rawStatus)
      : undefined;
  const reason =
    providerMessage && /bucket not found/i.test(providerMessage)
      ? 'bucket_missing'
      : fallback;
  return new PublicAssetStorageError(reason, {
    providerStatus,
    providerMessage,
  });
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PublicAssetStorageError('timeout')),
          STORAGE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
