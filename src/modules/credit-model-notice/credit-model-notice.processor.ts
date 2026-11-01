import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { CREDIT_MODEL_NOTICE_QUEUE } from './credit-model-notice.constants';
import { CreditModelNoticeService } from './credit-model-notice.service';

/** Safe to re-run: each organization is claimed before it is emailed. */
@Processor(CREDIT_MODEL_NOTICE_QUEUE, { concurrency: 1 })
@Injectable()
export class CreditModelNoticeProcessor extends WorkerHost {
  constructor(private readonly notices: CreditModelNoticeService) {
    super();
  }

  async process(): Promise<void> {
    await this.notices.sendEmailBatch();
  }
}
