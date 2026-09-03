import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { WebhookDispatchService } from './webhook-dispatch.service';

export interface ReconciliationResult {
  candidates: number;
  dispatched: number;
  notClaimed: number;
  failed: number;
  dryRun: boolean;
}

@Injectable()
export class WebhookDispatchReconciler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WebhookDispatchReconciler.name);
  private readonly enabled: boolean;
  private readonly dryRun: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly events: WebhookEventsRepository,
    private readonly dispatcher: WebhookDispatchService,
    config: ConfigService,
  ) {
    this.enabled = this.boolean(
      config.get('WEBHOOK_RECONCILIATION_ENABLED'),
      false,
    );
    this.dryRun = this.boolean(
      config.get('WEBHOOK_RECONCILIATION_DRY_RUN'),
      false,
    );
    this.intervalMs = this.positiveInteger(
      config.get('WEBHOOK_RECONCILIATION_INTERVAL_MS'),
      15_000,
    );
    this.batchSize = Math.min(
      100,
      this.positiveInteger(config.get('WEBHOOK_RECONCILIATION_BATCH_SIZE'), 25),
    );
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.safeRun(), this.intervalMs);
    this.timer.unref();
    void this.safeRun();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcileOnce(): Promise<ReconciliationResult> {
    const candidates = await this.events.findRecoverable(
      this.batchSize,
      this.dispatcher.staleBefore,
      this.dispatcher.retryLimit,
    );
    const result: ReconciliationResult = {
      candidates: candidates.length,
      dispatched: 0,
      notClaimed: 0,
      failed: 0,
      dryRun: this.dryRun,
    };
    if (this.dryRun) return result;

    for (const candidate of candidates) {
      const outcome = await this.dispatcher.dispatchById(candidate.id);
      if (outcome === 'dispatched') result.dispatched += 1;
      else if (outcome === 'failed') result.failed += 1;
      else result.notClaimed += 1;
    }
    return result;
  }

  private async safeRun(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.reconcileOnce();
      this.logger.log(
        buildBackendLog(WebhookDispatchReconciler.name, {
          action: 'webhook-dispatch-reconcile',
          outcome: result.failed > 0 ? 'failure' : 'success',
          ...result,
        }),
      );
    } catch (error) {
      this.logger.error(
        buildBackendLog(WebhookDispatchReconciler.name, {
          action: 'webhook-dispatch-reconcile',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
    } finally {
      this.running = false;
    }
  }

  private boolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return fallback;
  }

  private positiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
