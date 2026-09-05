import { Injectable } from '@nestjs/common';
import {
  COMMERCE_OUTCOME_ACTIONS,
  type CommerceOutcomeAdapter,
  type CommerceOutcomeAdapterRequest,
  type CommerceOutcomeOperationResult,
} from '../../../../shared/commerce/commerce-outcome';

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
}
