import { Injectable, Logger } from '@nestjs/common';
import { OrderImportsRepository } from '../../infrastructure/database/repositories/order-imports.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { normalizeIdempotencyKey } from '../../shared/validation/idempotency-key';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { StandaloneSource } from '../order-ingestion/standalone-source-resolver';
import type { OrderImportBatchDetailDto } from './dto/order-import.dto';
import { OrderImportDetailService } from './order-import-detail.service';
import { OrderImportCommitProducer } from './order-import-commit.producer';
import { assertEditableDraft, orderImportError } from './order-imports.errors';

/** Import keeps its own names for the two shared Idempotency-Key rejections. */
const IMPORT_IDEMPOTENCY_CODES = {
  required: 'IMPORT_IDEMPOTENCY_KEY_REQUIRED',
  invalid: 'IMPORT_VALIDATION_FAILED',
};

@Injectable()
export class OrderImportCommitService {
  private readonly logger = new Logger(OrderImportCommitService.name);

  constructor(
    private readonly repository: OrderImportsRepository,
    private readonly detail: OrderImportDetailService,
    private readonly producer: OrderImportCommitProducer,
  ) {}

  /**
   * Turn a reviewed draft into held orders, exactly once.
   *
   * The merchant may send this request several times -- a double-click, a
   * refresh, a retry after a timeout -- and every one of them must reach the
   * same batch and the same job. The key claims the batch in one conditional
   * UPDATE; everything else here decides which answer the caller gets.
   */
  async commit(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
    idempotencyHeader: string | undefined,
  ): Promise<OrderImportBatchDetailDto> {
    const key = normalizeIdempotencyKey(
      idempotencyHeader,
      IMPORT_IDEMPOTENCY_CODES,
    );
    const now = new Date();

    const batch = await this.repository.findBatchForCommit(user.orgId, batchId);
    if (!batch || batch.integrationId !== source.id) {
      throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    }

    // A batch that has already moved on answers from its current state, so a
    // replay never sees a 410 for a draft window that closed after it started.
    if (batch.status !== 'draft') {
      return this.replayOrConflict(user, batchId, batch.status, {
        stored: batch.commitIdempotencyKey,
        offered: key,
      });
    }

    assertEditableDraft(batch.status, batch.expiresAt, now);
    if (!batch.mapping) throw orderImportError('IMPORT_MAPPING_INCOMPLETE');

    const counts = (batch.counts ?? {}) as Record<string, number>;
    if (!counts.ready) throw orderImportError('IMPORT_NOTHING_TO_IMPORT');

    const owner = await this.repository.findBatchByCommitKey(user.orgId, key);
    if (owner && owner.id !== batchId) {
      throw orderImportError('IMPORT_IDEMPOTENCY_CONFLICT');
    }

    const claim = await this.repository.claimForCommit({
      orgId: user.orgId,
      batchId,
      key,
      now,
    });
    if (claim === 'key_taken') {
      throw orderImportError('IMPORT_IDEMPOTENCY_CONFLICT');
    }
    if (claim === 'not_draft') {
      // Another request won between the read and the update. Re-read and give
      // it the same answer a later replay would get.
      const current = await this.repository.findBatchForCommit(
        user.orgId,
        batchId,
      );
      if (!current) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
      return this.replayOrConflict(user, batchId, current.status, {
        stored: current.commitIdempotencyKey,
        offered: key,
      });
    }

    await this.producer.enqueue({ batchId, orgId: user.orgId });
    this.logger.log(
      buildBackendLog(OrderImportCommitService.name, {
        action: 'order-import-commit-accepted',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: source.id,
        batchId,
        ready: counts.ready,
      }),
    );
    return this.detail.detail(user, batchId);
  }

  /**
   * The same key replays; a different key on a batch that has moved on is a
   * state conflict, which is what a second tab must be told.
   */
  private async replayOrConflict(
    user: AuthenticatedUser,
    batchId: string,
    status: string,
    keys: { stored: string | null; offered: string },
  ): Promise<OrderImportBatchDetailDto> {
    if (keys.stored && keys.stored === keys.offered) {
      return this.detail.detail(user, batchId);
    }
    throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', { status });
  }
}
