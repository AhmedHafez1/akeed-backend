import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import type { OrderImportUploadResponseDto } from './dto/order-import.dto';
import {
  SaveOrderImportMappingDto,
  type OrderImportMappingResponseDto,
} from './dto/order-import-mapping.dto';
import {
  ImportSource,
  OrderImportAccess,
} from './guards/order-import-access.guard';
import { OrderImportUploadThrottleGuard } from './guards/order-import-upload-throttle.guard';
import { OrderImportMappingService } from './order-import-mapping.service';
import { OrderImportUploadInterceptor } from './order-import-upload.interceptor';
import { orderImportError } from './order-imports.errors';
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

const mappingValidationPipe = new ValidationPipe({
  expectedType: SaveOrderImportMappingDto,
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors: ValidationError[]) =>
    orderImportError('IMPORT_VALIDATION_FAILED', {
      fieldErrors: flattenValidationErrors(errors),
    }),
});

@Controller('api/order-imports')
export class OrderImportsController {
  constructor(
    private readonly orderImports: OrderImportsService,
    private readonly mapping: OrderImportMappingService,
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

  @Put(':id/mapping')
  @OrderImportAccess('write')
  saveMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', batchIdPipe) batchId: string,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with IMPORT_VALIDATION_FAILED.
    @Body(mappingValidationPipe) body: object,
  ): Promise<OrderImportMappingResponseDto> {
    return this.mapping.save(user, batchId, body as SaveOrderImportMappingDto);
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
