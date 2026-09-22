import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import type { StandaloneSource } from '../order-ingestion/standalone-source-resolver';
import type {
  OrderImportBatchDetailDto,
  OrderImportDraftListDto,
  OrderImportUploadResponseDto,
} from './dto/order-import.dto';
import {
  ListOrderImportRowsQueryDto,
  UpdateOrderImportRowDto,
  type OrderImportRowsPageDto,
  type OrderImportRowUpdateResponseDto,
} from './dto/order-import-rows.dto';
import {
  SaveOrderImportMappingDto,
  type OrderImportMappingResponseDto,
} from './dto/order-import-mapping.dto';
import {
  StartOrderImportDto,
  type OrderImportStartQuoteDto,
  type OrderImportStopResponseDto,
} from './dto/order-import-release.dto';
import {
  ImportSource,
  OrderImportAccess,
} from './guards/order-import-access.guard';
import { OrderImportUploadThrottleGuard } from './guards/order-import-upload-throttle.guard';
import { OrderImportCommitService } from './order-import-commit.service';
import { OrderImportDetailService } from './order-import-detail.service';
import { OrderImportMappingService } from './order-import-mapping.service';
import { OrderImportRowsService } from './order-import-rows.service';
import { OrderImportUploadInterceptor } from './order-import-upload.interceptor';
import { orderImportError } from './order-imports.errors';
import { OrderImportReleaseService } from './release/order-import-release.service';
import {
  OrderImportsService,
  type UploadedImportFile,
} from './order-imports.service';

/** An unknown or malformed id reads as not found, never as a 400 that leaks shape. */
const batchIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => orderImportError('IMPORT_BATCH_NOT_FOUND'),
});

/** `options.defaultCurrency: 'defaultCurrency is not supported.'`, one per field. */
function flattenValidationErrors(
  errors: readonly ValidationError[],
  prefix = '',
): Record<string, string> {
  return Object.fromEntries(
    errors.flatMap((error) => {
      const path = `${prefix}${error.property}`;
      const own = Object.values(error.constraints ?? {})[0];
      if (own) return [[path, own]];
      if (error.children?.length)
        return Object.entries(
          flattenValidationErrors(error.children, `${path}.`),
        );
      return [[path, `${path} is invalid.`]];
    }),
  );
}

/** A route pipe answering IMPORT_VALIDATION_FAILED with per-field errors. */
function importValidationPipe(expectedType: new () => object): ValidationPipe {
  return new ValidationPipe({
    expectedType,
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      orderImportError('IMPORT_VALIDATION_FAILED', {
        fieldErrors: flattenValidationErrors(errors),
      }),
  });
}

const mappingValidationPipe = importValidationPipe(SaveOrderImportMappingDto);
const rowsQueryPipe = importValidationPipe(ListOrderImportRowsQueryDto);
const rowUpdatePipe = importValidationPipe(UpdateOrderImportRowDto);
const startValidationPipe = importValidationPipe(StartOrderImportDto);
const rowNumberPipe = new ParseIntPipe({
  exceptionFactory: () =>
    orderImportError('IMPORT_VALIDATION_FAILED', {
      fieldErrors: { rowNumber: 'rowNumber must be an integer.' },
    }),
});

@Controller('api/order-imports')
export class OrderImportsController {
  constructor(
    private readonly orderImports: OrderImportsService,
    private readonly mapping: OrderImportMappingService,
    private readonly rows: OrderImportRowsService,
    private readonly detail: OrderImportDetailService,
    private readonly commit: OrderImportCommitService,
    private readonly release: OrderImportReleaseService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @SkipThrottle()
  @OrderImportAccess('write', OrderImportUploadThrottleGuard)
  @UseInterceptors(OrderImportUploadInterceptor)
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @UploadedFile() file: UploadedImportFile | undefined,
  ): Promise<OrderImportUploadResponseDto> {
    return this.orderImports.upload(user, source, file);
  }

  @Get('template')
  @OrderImportAccess('read')
  template(
    @Query('format') format: string | undefined,
    @Query('locale') locale: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): StreamableFile {
    const file = this.orderImports.template(format, locale);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(file.body, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.body.length,
    });
  }

  @Get()
  @OrderImportAccess('read')
  listDrafts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status: string | undefined,
  ): Promise<OrderImportDraftListDto> {
    return this.detail.listDrafts(user, status);
  }

  // Declared after `template` so that literal path is not read as an id.
  @Get(':id')
  @OrderImportAccess('read')
  getBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', batchIdPipe) batchId: string,
  ): Promise<OrderImportBatchDetailDto> {
    return this.detail.detail(user, batchId);
  }

  @Put(':id/mapping')
  @OrderImportAccess('write')
  saveMapping(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @Param('id', batchIdPipe) batchId: string,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with IMPORT_VALIDATION_FAILED.
    @Body(mappingValidationPipe) body: object,
  ): Promise<OrderImportMappingResponseDto> {
    return this.mapping.save(
      user,
      source,
      batchId,
      body as SaveOrderImportMappingDto,
    );
  }

  @Get(':id/rows')
  @OrderImportAccess('read')
  listRows(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', batchIdPipe) batchId: string,
    // Plain object for the same reason as the mapping body.
    @Query(rowsQueryPipe) query: object,
  ): Promise<OrderImportRowsPageDto> {
    return this.rows.list(user, batchId, query as ListOrderImportRowsQueryDto);
  }

  @Patch(':id/rows/:rowNumber')
  @OrderImportAccess('write')
  updateRow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', batchIdPipe) batchId: string,
    @Param('rowNumber', rowNumberPipe) rowNumber: number,
    @Body(rowUpdatePipe) body: object,
  ): Promise<OrderImportRowUpdateResponseDto> {
    return this.rows.setInclude(
      user,
      batchId,
      rowNumber,
      (body as UpdateOrderImportRowDto).include,
    );
  }

  /**
   * 202: the orders are created in the background, and the merchant watches
   * progress through `GET /:id`. Replaying the same key returns the batch as
   * it stands rather than starting a second import.
   */
  @Post(':id/commit')
  @HttpCode(HttpStatus.ACCEPTED)
  @OrderImportAccess('write')
  commitBatch(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @Param('id', batchIdPipe) batchId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<OrderImportBatchDetailDto> {
    return this.commit.commit(user, source, batchId, idempotencyKey);
  }

  /** What starting would send, cost and take, plus a signed quote token. */
  @Get(':id/start-quote')
  @OrderImportAccess('write')
  startQuote(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @Param('id', batchIdPipe) batchId: string,
  ): Promise<OrderImportStartQuoteDto> {
    return this.release.quote(user, source, batchId);
  }

  /**
   * 202: the orders are released at the organization's pace in the
   * background; `GET /:id` shows progress. The same key replays.
   */
  @Post(':id/start')
  @HttpCode(HttpStatus.ACCEPTED)
  @OrderImportAccess('write')
  startBatch(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @Param('id', batchIdPipe) batchId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    // A plain object so the app-wide ValidationPipe skips it and this route's
    // pipe answers with IMPORT_VALIDATION_FAILED.
    @Body(startValidationPipe) body: object,
  ): Promise<OrderImportBatchDetailDto> {
    return this.release.start(
      user,
      source,
      batchId,
      idempotencyKey,
      body as StartOrderImportDto,
    );
  }

  /** Still answers while the flag is off: the kill switch never traps orders. */
  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  @OrderImportAccess('write', { whenDisabled: 'allow' })
  stopBatch(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @Param('id', batchIdPipe) batchId: string,
  ): Promise<OrderImportStopResponseDto> {
    return this.release.stop(user, source, batchId);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @OrderImportAccess('write')
  resumeBatch(
    @CurrentUser() user: AuthenticatedUser,
    @ImportSource() source: StandaloneSource,
    @Param('id', batchIdPipe) batchId: string,
  ): Promise<OrderImportBatchDetailDto> {
    return this.release.resume(user, source, batchId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrderImportAccess('write')
  discard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', batchIdPipe) batchId: string,
  ): Promise<void> {
    return this.orderImports.discard(user, batchId);
  }
}
