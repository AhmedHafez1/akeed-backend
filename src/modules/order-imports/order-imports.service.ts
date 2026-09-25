import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  OrderImportDraftLimitError,
  OrderImportsRepository,
  type OpenDraftSummary,
  type CreatedDraft,
} from '../../infrastructure/database/repositories/order-imports.repository';
import { readBulkImportConfig } from '../../shared/config/bulk-import.config';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type { StandaloneSource } from '../order-ingestion/standalone-source-resolver';
import {
  ORDER_IMPORT_TEMPLATE_FORMATS,
  ORDER_IMPORT_TEMPLATE_LOCALES,
  type OrderImportOpenDraftDto,
  type OrderImportTemplateFormat,
  type OrderImportTemplateLocale,
  type OrderImportUploadResponseDto,
} from './dto/order-import.dto';
import {
  buildOrderImportTemplate,
  type OrderImportTemplateFile,
} from './order-import-template';
import { OrderImportMappingService } from './order-import-mapping.service';
import { orderImportError } from './order-imports.errors';
import { sanitizeImportFileName } from './parsers/file-name';
import type { ParsedImportFile } from './parsers/grid.types';
import { ImportFileParser } from './parsers/import-file-parser';
import { ImportFileError } from './parsers/import-file.error';
import { generateShortCode } from './short-code';

/** A draft, and the duplicate-file window, last 24 hours (AC8, AC9). */
const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SAMPLE_ROW_COUNT = 5;

/** The upload as multer hands it over; only these fields are read. */
export interface UploadedImportFile {
  buffer: Buffer;
  size: number;
  originalname: string;
}

function isTemplateFormat(value: string): value is OrderImportTemplateFormat {
  return (ORDER_IMPORT_TEMPLATE_FORMATS as readonly string[]).includes(value);
}

function isTemplateLocale(value: string): value is OrderImportTemplateLocale {
  return (ORDER_IMPORT_TEMPLATE_LOCALES as readonly string[]).includes(value);
}

function toDraftDto(draft: OpenDraftSummary): OrderImportOpenDraftDto {
  return { ...draft };
}

@Injectable()
export class OrderImportsService {
  private readonly logger = new Logger(OrderImportsService.name);

  constructor(
    private readonly repository: OrderImportsRepository,
    private readonly parser: ImportFileParser,
    private readonly config: ConfigService,
    private readonly mapping: OrderImportMappingService,
  ) {}

  /**
   * Parses the upload once and stores it as a draft with all its rows (AC8).
   * Every refusal happens before anything is written, and the write is one
   * transaction, so a rejected or interrupted upload leaves no batch.
   */
  async upload(
    user: AuthenticatedUser,
    source: StandaloneSource,
    file: UploadedImportFile | undefined,
  ): Promise<OrderImportUploadResponseDto> {
    if (!file) throw orderImportError('IMPORT_FILE_REQUIRED');
    const limits = readBulkImportConfig(this.config);
    const startedAt = Date.now();
    const now = new Date();

    // Cheap early refusal; the authoritative check runs again under the
    // organization lock in the same transaction as the insert. The caller's
    // own drafts do not count: this upload replaces them.
    const openDrafts = await this.repository.listOpenDrafts(user.orgId, now, {
      excludeCreatedBy: user.userId,
    });
    if (openDrafts.length >= limits.maxOpenDrafts)
      throw this.tooManyDrafts(user.orgId, openDrafts);

    const fileSha256 = createHash('sha256').update(file.buffer).digest('hex');
    const parsed = await this.parse(user.orgId, file.buffer, limits, startedAt);
    const { headers, rows } = parsed.grid;
    const importRows = rows.map((row) => ({
      rowNumber: row.rowNumber,
      raw: Object.fromEntries(
        headers.map((header, index) => [header, row.cells[index]]),
      ),
      issues: row.issues,
    }));
    const fileName = sanitizeImportFileName(file.originalname);
    const suggestion = await this.mapping.suggest(
      user.orgId,
      source,
      headers,
      rows,
    );

    let created: CreatedDraft;
    try {
      created = await this.repository.createDraftWithRows(
        {
          orgId: user.orgId,
          integrationId: source.id,
          createdBy: user.userId,
          fileName,
          fileSha256,
          fileSize: file.size,
          fileFormat: parsed.format,
          encoding: parsed.encoding,
          delimiter: parsed.delimiter,
          sheetName: parsed.sheetName,
          headers,
          expiresAt: new Date(now.getTime() + DRAFT_LIFETIME_MS),
          mapping: suggestion.mapping,
          options: suggestion.options,
          mappingProfileId: suggestion.mappingProfileId,
        },
        importRows,
        {
          maxOpenDrafts: limits.maxOpenDrafts,
          duplicateSince: new Date(now.getTime() - DRAFT_LIFETIME_MS),
          now,
          generateShortCode: () => generateShortCode(),
        },
      );
    } catch (error) {
      if (error instanceof OrderImportDraftLimitError)
        throw this.tooManyDrafts(user.orgId, error.drafts);
      this.logger.error(
        buildBackendLog(OrderImportsService.name, {
          action: 'order-import-upload',
          outcome: 'failure',
          orgId: user.orgId,
          reason: 'persist_failed',
          format: parsed.format,
          rowCount: rows.length,
          ...normalizeError(error),
        }),
      );
      throw error;
    }

    this.logger.log(
      buildBackendLog(OrderImportsService.name, {
        action: 'order-import-upload',
        outcome: 'success',
        orgId: user.orgId,
        integrationId: source.id,
        batchId: created.batchId,
        format: parsed.format,
        encoding: parsed.encoding ?? undefined,
        rowCount: rows.length,
        columnCount: headers.length,
        duplicateFile: created.duplicateFileOf !== null,
        supersededDrafts: created.supersededDrafts,
        durationMs: Date.now() - startedAt,
      }),
    );
    return {
      batchId: created.batchId,
      status: 'draft',
      fileName,
      format: parsed.format,
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      sheetName: parsed.sheetName,
      ignoredSheets: parsed.ignoredSheets,
      headers,
      rowCount: rows.length,
      sampleRows: importRows.slice(0, SAMPLE_ROW_COUNT),
      ...suggestion.response,
      ...(created.duplicateFileOf
        ? { duplicateFileOf: created.duplicateFileOf }
        : {}),
    };
  }

  /**
   * Discards a draft and its rows (AC10); the import modal calls it on close.
   * Idempotent: a draft already gone (discarded, superseded, purged, or never
   * this organization's) is a no-op. Other states cannot be discarded.
   */
  async discard(user: AuthenticatedUser, batchId: string): Promise<void> {
    const result = await this.repository.discardDraft(user.orgId, batchId);
    if (result.outcome === 'not_found') {
      this.logger.log(
        buildBackendLog(OrderImportsService.name, {
          action: 'order-import-discard',
          outcome: 'skipped',
          orgId: user.orgId,
          batchId,
          reason: 'not_found',
        }),
      );
      return;
    }
    if (result.outcome === 'state_conflict')
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: result.status,
      });
    this.logger.log(
      buildBackendLog(OrderImportsService.name, {
        action: 'order-import-discard',
        outcome: 'success',
        orgId: user.orgId,
        batchId,
      }),
    );
  }

  /** The sample file for AC11; both query values are validated here. */
  template(
    format: string | undefined,
    locale: string | undefined,
  ): OrderImportTemplateFile {
    const chosenFormat = format ?? 'csv';
    const chosenLocale = locale ?? 'en';
    const fieldErrors: Record<string, string> = {};
    if (!isTemplateFormat(chosenFormat))
      fieldErrors.format = 'format must be csv or xlsx.';
    if (!isTemplateLocale(chosenLocale))
      fieldErrors.locale = 'locale must be ar or en.';
    if (!isTemplateFormat(chosenFormat) || !isTemplateLocale(chosenLocale))
      throw orderImportError('IMPORT_VALIDATION_FAILED', { fieldErrors });
    return buildOrderImportTemplate(chosenFormat, chosenLocale);
  }

  private async parse(
    orgId: string,
    bytes: Buffer,
    limits: ReturnType<typeof readBulkImportConfig>,
    startedAt: number,
  ): Promise<ParsedImportFile> {
    try {
      return await this.parser.parse(bytes, {
        maxRows: limits.maxRows,
        maxColumns: limits.maxColumns,
        maxUncompressedBytes: limits.maxUncompressedBytes,
        parseTimeoutMs: limits.parseTimeoutMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof ImportFileError) {
        this.logger.warn(
          buildBackendLog(OrderImportsService.name, {
            action: 'order-import-upload',
            outcome: 'failure',
            orgId,
            code: error.code,
            reason: error.reason,
            durationMs,
          }),
        );
        throw orderImportError(error.code);
      }
      this.logger.error(
        buildBackendLog(OrderImportsService.name, {
          action: 'order-import-upload',
          outcome: 'failure',
          orgId,
          code: 'IMPORT_FILE_UNREADABLE',
          reason: 'parser_failure',
          durationMs,
          ...normalizeError(error),
        }),
      );
      throw orderImportError('IMPORT_FILE_UNREADABLE');
    }
  }

  private tooManyDrafts(orgId: string, drafts: OpenDraftSummary[]) {
    this.logger.warn(
      buildBackendLog(OrderImportsService.name, {
        action: 'order-import-upload',
        outcome: 'failure',
        orgId,
        code: 'IMPORT_TOO_MANY_DRAFTS',
        openDrafts: drafts.length,
      }),
    );
    return orderImportError('IMPORT_TOO_MANY_DRAFTS', {
      drafts: drafts.map(toDraftDto),
    });
  }
}
