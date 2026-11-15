import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres from 'postgres';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import { usesTransactionPooler } from './database.provider';
import { probeDatabaseLatency, shouldRunLatencyProbe } from './latency-probe';

function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Logs one `database-latency-probe` line after boot so a deployment's logs
 * show how far away its database is, independent of any request. Detached:
 * boot never waits on it and a failure only produces a warning.
 */
@Injectable()
export class DatabaseLatencyProbe implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseLatencyProbe.name);

  constructor(private readonly configService: ConfigService) {}

  onApplicationBootstrap(): void {
    const enabled = shouldRunLatencyProbe({
      NODE_ENV: this.configService.get<string>('NODE_ENV'),
      DATABASE_LATENCY_PROBE: this.configService.get<string>(
        'DATABASE_LATENCY_PROBE',
      ),
    });
    if (!enabled) return;
    void this.run();
  }

  async run(): Promise<void> {
    let client: ReturnType<typeof postgres> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const databaseUrl = this.configService.getOrThrow<string>('DATABASE_URL');
      // A separate one-shot client makes the first sample genuinely cold,
      // even if boot tasks have already warmed the application's pool.
      client = postgres(databaseUrl, {
        max: 1,
        prepare: !usesTransactionPooler(databaseUrl),
        connect_timeout: 10,
        idle_timeout: 1,
      });
      const result = await Promise.race([
        probeDatabaseLatency(client),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Database latency probe timed out')),
            15_000,
          );
        }),
      ]);
      this.logger.log(
        buildBackendLog(DatabaseLatencyProbe.name, {
          action: 'database-latency-probe',
          outcome: 'success',
          simpleMs: tenths(result.simpleMs),
          extendedMs: tenths(result.extendedMs),
          protocolOverheadMs: tenths(result.protocolOverheadMs),
          firstSampleMs: tenths(result.firstSampleMs),
          samples: result.samples,
        }),
      );
    } catch (error) {
      this.logger.warn(
        buildBackendLog(DatabaseLatencyProbe.name, {
          action: 'database-latency-probe',
          outcome: 'failure',
          ...normalizeError(error),
        }),
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (client) await client.end({ timeout: 1 }).catch(() => undefined);
    }
  }
}
