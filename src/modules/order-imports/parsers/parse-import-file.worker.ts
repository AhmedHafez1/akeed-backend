import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { ParsedImportFile } from './grid.types';
import {
  ImportFileError,
  type ImportFileErrorCode,
  type ImportFileErrorReason,
} from './import-file.error';
import { parseImportFile, type ImportParseLimits } from './parse-import-file';

export interface ParseWorkerInput {
  bytes: Uint8Array;
  limits: ImportParseLimits;
}

export type ParseWorkerOutput =
  | { ok: true; parsed: ParsedImportFile }
  | {
      ok: false;
      refusal: { code: ImportFileErrorCode; reason: ImportFileErrorReason };
    }
  | { ok: false; refusal: null };

function run(input: ParseWorkerInput): ParseWorkerOutput {
  try {
    const bytes = Buffer.from(
      input.bytes.buffer,
      input.bytes.byteOffset,
      input.bytes.byteLength,
    );
    return { ok: true, parsed: parseImportFile(bytes, input.limits) };
  } catch (error) {
    if (error instanceof ImportFileError)
      return { ok: false, refusal: { code: error.code, reason: error.reason } };
    // Library messages can echo file content, so nothing about the error
    // crosses back; the parent reports an unexpected failure.
    return { ok: false, refusal: null };
  }
}

if (!isMainThread && parentPort)
  parentPort.postMessage(run(workerData as ParseWorkerInput));
