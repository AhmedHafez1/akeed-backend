import { Injectable } from '@nestjs/common';

/**
 * Re-validates every stored row of a draft against its saved mapping and
 * options, and recomputes the batch counts.
 *
 * The mapping endpoint calls this after every save. Row rules arrive with
 * US-04.6-04, which fills in this method; until then it is a seam that
 * validates nothing, so the controller and mapping flow never change when
 * it lands.
 */
@Injectable()
export class RowValidationService {
  validateBatch(batchId: string): Promise<void> {
    void batchId; // US-04.6-04.
    return Promise.resolve();
  }
}
