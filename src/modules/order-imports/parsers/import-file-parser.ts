import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ParsedImportFile } from './grid.types';
import { ImportFileError } from './import-file.error';
import type { ImportParseLimits } from './parse-import-file';
import type {
  ParseWorkerInput,
  ParseWorkerOutput,
} from './parse-import-file.worker';

/**
 * Parses at most this many files at once per process. An upload may inflate to
 * 50 MB, so a burst of uploads queues here instead of exhausting memory.
 */
const MAX_CONCURRENT_PARSES = 2;
const WORKER_HEAP_MB = 512;

/** Raised when the worker dies for a reason other than a file refusal. */
export class ImportParseFailure extends Error {
  constructor(readonly reason: 'worker_crashed' | 'worker_exited') {
    super(`Import parse worker failed: ${reason}`);
    this.name = 'ImportParseFailure';
  }
}

function workerScript(): { path: string; execArgv: string[] } {
  // Under ts-jest this module runs from source, so the worker is TypeScript
  // and needs tsx (a dev dependency); `nest build` emits the .js beside it.
  const typescript = __filename.endsWith('.ts');
  return {
    path: join(
      __dirname,
      `parse-import-file.worker.${typescript ? 'ts' : 'js'}`,
    ),
    execArgv: typescript ? ['--require', 'tsx/cjs'] : [],
  };
}

/**
 * Parses one file in a worker thread.
 *
 * A 5,000 x 100 workbook takes over a second of pure CPU, which would stall
 * every other request on the event loop. The worker also makes the parse-time
 * cap real: SheetJS reads a workbook in one synchronous call that no
 * cooperative check can interrupt, but `terminate()` can.
 */
export function parseInWorker(
  bytes: Buffer,
  limits: ImportParseLimits,
): Promise<ParsedImportFile> {
  const script = workerScript();
  const input: ParseWorkerInput = { bytes: new Uint8Array(bytes), limits };
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(script.path, {
      workerData: input,
      execArgv: script.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      void worker.terminate();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ImportFileError('IMPORT_FILE_UNREADABLE', 'parse_timeout'),
          ),
        ),
      limits.parseTimeoutMs,
    );
    worker.once('message', (output: ParseWorkerOutput) =>
      finish(() => {
        if (output.ok) resolve(output.parsed);
        else if (output.refusal)
          reject(
            new ImportFileError(output.refusal.code, output.refusal.reason),
          );
        else reject(new ImportParseFailure('worker_crashed'));
      }),
    );
    worker.once('error', (error: Error & { code?: string }) =>
      finish(() =>
        reject(
          error.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ImportFileError('IMPORT_FILE_UNREADABLE', 'parse_resources')
            : new ImportParseFailure('worker_crashed'),
        ),
      ),
    );
    worker.once('exit', () =>
      finish(() => reject(new ImportParseFailure('worker_exited'))),
    );
  });
}

/** Runs `parseInWorker` with a small per-process concurrency cap. */
@Injectable()
export class ImportFileParser {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  async parse(
    bytes: Buffer,
    limits: ImportParseLimits,
  ): Promise<ParsedImportFile> {
    await this.acquire();
    try {
      return await parseInWorker(bytes, limits);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_PARSES) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
