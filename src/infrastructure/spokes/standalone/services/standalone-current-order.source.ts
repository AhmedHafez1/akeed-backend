import { Injectable } from '@nestjs/common';
import type { PlatformType } from '../../../../shared/interfaces/commerce-source.interface';
import type {
  CurrentOrderReadRequest,
  CurrentOrderReadResult,
  CurrentOrderSource,
} from '../../../../shared/ports/current-order-source.port';

/**
 * Standalone orders (manual, imported, API) have no external store: Akeed's
 * order record is their source of truth, edited through the existing manual,
 * import and API paths. Their current details are the stored ones.
 */
@Injectable()
export class StandaloneCurrentOrderSource implements CurrentOrderSource {
  readonly platform: PlatformType = 'standalone';

  readCurrentOrder(
    request: CurrentOrderReadRequest,
  ): Promise<CurrentOrderReadResult> {
    return Promise.resolve({ status: 'found', order: request.stored });
  }
}
