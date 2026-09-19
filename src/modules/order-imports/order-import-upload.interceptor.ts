import {
  HttpException,
  Injectable,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { orderImportError } from './order-imports.errors';

function isFileSizeLimit(error: unknown): boolean {
  return (
    error instanceof PayloadTooLargeException ||
    (error as { code?: unknown } | null)?.code === 'LIMIT_FILE_SIZE'
  );
}

/**
 * Reads the one `file` part into memory under the module's multer limits.
 *
 * Multer stops reading at the size limit instead of buffering the body. Its
 * refusals reach here as Nest exceptions or as raw `MulterError`s (an
 * unexpected field), and a body cut off mid-upload as a plain parser error;
 * all of them happen before the handler and become import codes instead of a
 * 500. Errors from the handler itself travel on the returned observable and
 * pass through untouched.
 */
@Injectable()
export class OrderImportUploadInterceptor extends FileInterceptor('file') {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (isFileSizeLimit(error))
        throw orderImportError('IMPORT_FILE_TOO_LARGE');
      if (error instanceof HttpException && error.getStatus() >= 500)
        throw error;
      throw orderImportError('IMPORT_FILE_REQUIRED');
    }
  }
}
