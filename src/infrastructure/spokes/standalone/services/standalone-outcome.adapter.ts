import { Injectable } from '@nestjs/common';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceCancellationInspection,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeAdapterRequest,
  type CommerceOutcomeOperationResult,
} from '../../../../shared/commerce/commerce-outcome';

/**
 * A Standalone order lives only in Akeed: every outcome, an automatic
 * cancellation included, is recorded locally and nothing is sent anywhere.
 */
@Injectable()
export class StandaloneOutcomeAdapter implements CommerceOutcomeAdapter {
  readonly platformType = 'standalone';
  readonly capabilities = new Set(COMMERCE_OUTCOME_ACTIONS);
  readonly requiresActiveConnection = false;

  execute(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceOutcomeOperationResult> {
    void request;
    return Promise.resolve({ status: 'applied' });
  }

  /** Akeed is the only record, so nothing outside it can have moved on. */
  inspectForCancellation(
    request: CommerceOutcomeAdapterRequest,
  ): Promise<CommerceCancellationInspection> {
    void request;
    return Promise.resolve({ state: 'cancellable' });
  }
}
