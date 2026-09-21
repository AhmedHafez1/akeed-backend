import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  MulterModule,
  type MulterModuleOptions,
} from '@nestjs/platform-express';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import {
  readBulkImportConfig,
  type BulkImportConfig,
} from '../../shared/config/bulk-import.config';
import { PhoneService } from '../../shared/services/phone.service';
import { AuthModule } from '../auth/auth.module';
import { OrderIngestionModule } from '../order-ingestion/order-ingestion.module';
import { WebhookQueueModule } from '../webhook-queue/webhook-queue.module';
import { OrderImportAccessGuard } from './guards/order-import-access.guard';
import { OrderImportUploadThrottleGuard } from './guards/order-import-upload-throttle.guard';
import { OrderImportCommitProcessor } from './order-import-commit.processor';
import { OrderImportCommitProducer } from './order-import-commit.producer';
import { OrderImportCommitService } from './order-import-commit.service';
import { OrderImportDetailService } from './order-import-detail.service';
import { OrderImportQueueModule } from './order-import-queue.module';
import { OrderImportMappingService } from './order-import-mapping.service';
import { OrderImportRowsService } from './order-import-rows.service';
import { OrderImportsController } from './order-imports.controller';
import { OrderImportsService } from './order-imports.service';
import { OrderImportProcessor } from './order-import.processor';
import { OrderImportExpireService } from './release/order-import-expire.service';
import { OrderImportReleaseTickService } from './release/order-import-release-tick.service';
import { OrderImportReleaseScheduler } from './release/order-import-release.scheduler';
import { OrderImportReleaseService } from './release/order-import-release.service';
import { ImportFileParser } from './parsers/import-file-parser';
import { RowValidationService } from './validation/row-validation.service';

/**
 * No `dest` or `storage`: multer keeps the upload in memory, so it never
 * touches disk and its name is never used as a path. `fileSize` makes multer
 * stop reading at the limit instead of buffering the body.
 */
export function orderImportMulterOptions(
  bulkImport: BulkImportConfig,
): MulterModuleOptions {
  return {
    limits: {
      fileSize: bulkImport.maxFileBytes,
      files: 1,
      fields: 5,
      parts: 6,
    },
    // Browsers send non-ASCII file names (Arabic) as UTF-8.
    defParamCharset: 'utf8',
  } as MulterModuleOptions;
}

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    OrderIngestionModule,
    OrderImportQueueModule,
    // The release tick hands released events to the shared dispatcher.
    WebhookQueueModule,
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        orderImportMulterOptions(readBulkImportConfig(config)),
    }),
  ],
  controllers: [OrderImportsController],
  providers: [
    OrderImportsService,
    OrderImportMappingService,
    OrderImportDetailService,
    OrderImportRowsService,
    OrderImportCommitService,
    OrderImportCommitProducer,
    OrderImportCommitProcessor,
    OrderImportProcessor,
    OrderImportReleaseService,
    OrderImportReleaseScheduler,
    OrderImportReleaseTickService,
    OrderImportExpireService,
    RowValidationService,
    PhoneService,
    ImportFileParser,
    OrderImportAccessGuard,
    OrderImportUploadThrottleGuard,
  ],
})
export class OrderImportsModule {}
