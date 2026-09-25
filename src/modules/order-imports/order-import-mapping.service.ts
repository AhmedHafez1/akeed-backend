import { Injectable, Logger } from '@nestjs/common';
import { OrderImportsRepository } from '../../infrastructure/database/repositories/order-imports.repository';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  ONBOARDING_SHIPPING_CURRENCIES,
  type OnboardingShippingCurrency,
} from '../onboarding/dto/onboarding.dto';
import {
  DEFAULT_SHIPPING_CURRENCY,
  resolveShippingCurrency,
} from '../onboarding/shipping-currency';
import { COUNTRY_CURRENCIES } from '../../shared/commerce/canonical-order.rules';
import type { StandaloneSource } from '../order-ingestion/standalone-source-resolver';
import type {
  OrderImportDateFormatDto,
  OrderImportFieldStateDto,
  OrderImportMappingResponseDto,
  OrderImportMappingStateDto,
  OrderImportMappingSuggestionDto,
  OrderImportPaymentValuesDto,
  SaveOrderImportMappingDto,
} from './dto/order-import-mapping.dto';
import {
  IMPORT_FIELDS,
  MAPPING_DICTIONARY_VERSION,
  type ImportField,
} from './mapping/alias-dictionary';
import { matchColumns } from './mapping/column-matcher';
import { detectDateAmbiguity } from './mapping/date-ambiguity';
import { headerSignature } from './mapping/header-key';
import {
  columnsOf,
  IMPORT_DATE_FORMATS,
  mappingFromSuggestions,
  unmappedColumns,
  validateMappingStructure,
  type ImportColumnMapping,
  type ImportDateFormat,
  type ImportOptions,
  type MappingSource,
  type PaymentClassification,
  type StoredImportMapping,
} from './mapping/mapping-rules';
import {
  countValues,
  normalizePaymentValue,
  summarizePaymentValues,
  type PaymentValueCount,
} from './mapping/payment-value-classifier';
import { applySavedProfile, type SavedColumns } from './mapping/saved-profile';
import { assertEditableDraft, orderImportError } from './order-imports.errors';
import { RowValidationService } from './validation/row-validation.service';

/** Rows the name rule looks at to tell `#1001` references from names (AC3). */
const MATCHER_SAMPLE_ROWS = 20;
const DEFAULT_COUNTRY = 'EG';
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** What upload stores on the new draft and returns to the merchant. */
export interface MappingSuggestion {
  response: OrderImportMappingSuggestionDto;
  mapping: StoredImportMapping;
  options: ImportOptions;
  mappingProfileId: string | null;
}

interface ProfileContent {
  columns: SavedColumns | null;
  options: Partial<ImportOptions>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isPaymentClassification(
  value: unknown,
): value is PaymentClassification {
  return value === 'cod' || value === 'not_cod';
}

/** Reads a profile written by this or an older dictionary without trusting it. */
function readProfile(mapping: unknown, options: unknown): ProfileContent {
  const columns =
    isRecord(mapping) && isRecord(mapping.columns)
      ? (mapping.columns as SavedColumns)
      : null;
  const saved: Partial<ImportOptions> = {};
  if (isRecord(options)) {
    if (
      typeof options.country === 'string' &&
      COUNTRY_CODE.test(options.country)
    )
      saved.country = options.country;
    if (
      ONBOARDING_SHIPPING_CURRENCIES.includes(
        options.defaultCurrency as OnboardingShippingCurrency,
      )
    )
      saved.defaultCurrency =
        options.defaultCurrency as OnboardingShippingCurrency;
    if (IMPORT_DATE_FORMATS.includes(options.dateFormat as ImportDateFormat))
      saved.dateFormat = options.dateFormat as ImportDateFormat;
    if (isRecord(options.paymentValueMap))
      saved.paymentValueMap = Object.fromEntries(
        Object.entries(options.paymentValueMap).filter(([, choice]) =>
          isPaymentClassification(choice),
        ),
      ) as Record<string, PaymentClassification>;
  }
  return { columns, options: saved };
}

/** A batch's stored mapping, or null when it is missing or malformed. */
function readStoredMapping(
  value: unknown,
): Pick<StoredImportMapping, 'confirmed' | 'columns' | 'sources'> | null {
  if (!isRecord(value) || !isRecord(value.columns) || !isRecord(value.sources))
    return null;
  const stored = value.columns;
  const columns = Object.fromEntries(
    IMPORT_FIELDS.map((field) => {
      const column = stored[field];
      if (field === 'customerName')
        return [field, isStringArray(column) ? column : []];
      return [field, typeof column === 'string' ? column : null];
    }),
  ) as ImportColumnMapping;
  return {
    confirmed: value.confirmed === true,
    columns,
    sources: value.sources as Record<ImportField, MappingSource>,
  };
}

/** A batch's stored options; upload always writes all of them. */
function readStoredOptions(value: unknown): ImportOptions {
  const { options } = readProfile(null, value);
  return {
    country: options.country ?? DEFAULT_COUNTRY,
    defaultCurrency:
      options.defaultCurrency ?? resolveShippingCurrency(undefined),
    dateFormat: options.dateFormat ?? 'auto',
    paymentValueMap: options.paymentValueMap ?? {},
  };
}

/**
 * The store's defaults (AC5): its country, else Egypt; its shipping currency,
 * unless that is still the column default (USD), which standalone stores never
 * chose -- then the country's own currency, so an Egyptian store gets EGP.
 */
export function defaultImportOptions(source: StandaloneSource): ImportOptions {
  const stored = source.countryCode?.trim().toUpperCase() ?? '';
  const country = COUNTRY_CODE.test(stored) ? stored : DEFAULT_COUNTRY;
  const currency = resolveShippingCurrency(source.shippingCurrency);
  return {
    country,
    defaultCurrency:
      currency === DEFAULT_SHIPPING_CURRENCY
        ? (COUNTRY_CURRENCIES[country] ?? currency)
        : currency,
    dateFormat: 'auto',
    paymentValueMap: {},
  };
}

/** Keeps only the choices for values the merchant was actually shown. */
function choicesForListedValues(
  map: Readonly<Record<string, PaymentClassification>>,
  payment: OrderImportPaymentValuesDto | null,
): Record<string, PaymentClassification> {
  if (!payment) return {};
  const listed = new Set(payment.values.map((entry) => entry.normalizedValue));
  return Object.fromEntries(
    Object.entries(map).filter(([key]) => listed.has(key)),
  );
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((column, i) => column === b[i]);
}

@Injectable()
export class OrderImportMappingService {
  private readonly logger = new Logger(OrderImportMappingService.name);

  constructor(
    private readonly repository: OrderImportsRepository,
    private readonly rowValidation: RowValidationService,
  ) {}

  /**
   * Detects the mapping of a freshly parsed file (AC1–AC3, AC5, AC6), with
   * the organization's saved profile for the same header set laid over it
   * (AC8). Payment values and date ambiguity look at every row, not samples.
   */
  async suggest(
    orgId: string,
    source: StandaloneSource,
    headers: readonly string[],
    rows: readonly { cells: readonly string[] }[],
  ): Promise<MappingSuggestion> {
    const signature = headerSignature(headers);
    const profile = await this.repository.findMappingProfile(orgId, signature);
    const saved = profile
      ? readProfile(profile.mapping, profile.options)
      : null;

    const detected = matchColumns(
      headers,
      rows.slice(0, MATCHER_SAMPLE_ROWS).map((row) => row.cells),
    );
    const suggestions = saved?.columns
      ? applySavedProfile(detected, headers, saved.columns)
      : detected;
    const columns = mappingFromSuggestions(suggestions.fields);
    const countsOf = (column: string) => {
      const index = headers.indexOf(column);
      return countValues(rows.map((row) => row.cells[index] ?? ''));
    };

    const savedChoices = saved?.options.paymentValueMap ?? {};
    const { paymentValues, dateFormat } = this.columnChecks(
      columns,
      countsOf,
      savedChoices,
      'saved',
    );
    const options: ImportOptions = {
      ...defaultImportOptions(source),
      ...saved?.options,
      paymentValueMap: choicesForListedValues(savedChoices, paymentValues),
    };
    const sources = Object.fromEntries(
      suggestions.fields.map((field) => [field.field, field.source]),
    ) as Record<ImportField, MappingSource>;
    const appliedProfile = suggestions.fields.some(
      (field) => field.source === 'saved',
    );

    return {
      response: {
        mappingDictionaryVersion: MAPPING_DICTIONARY_VERSION,
        headerSignature: signature,
        mappingProfileApplied: appliedProfile,
        suggestions,
        options,
        paymentValues,
        dateFormat,
      },
      mapping: {
        dictionaryVersion: MAPPING_DICTIONARY_VERSION,
        confirmed: false,
        columns,
        sources,
      },
      options,
      mappingProfileId: appliedProfile && profile ? profile.id : null,
    };
  }

  /**
   * `PUT /api/order-imports/:id/mapping` (AC4, AC5, AC7, AC8): checks the
   * mapping against the file, stores it with the options, remembers it for
   * the header set and re-validates the rows. The same body gives the same
   * result.
   */
  async save(
    user: AuthenticatedUser,
    source: StandaloneSource,
    batchId: string,
    body: SaveOrderImportMappingDto,
  ): Promise<OrderImportMappingResponseDto> {
    const startedAt = Date.now();
    const now = new Date();
    const batch = await this.repository.findBatchForMapping(
      user.orgId,
      batchId,
    );
    if (!batch) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
    assertEditableDraft(batch.status, batch.expiresAt, now);
    const headers = isStringArray(batch.headers) ? batch.headers : [];

    const columns = this.toColumnMapping(body);
    const fieldErrors = validateMappingStructure(headers, columns);
    if (Object.keys(fieldErrors).length > 0)
      throw orderImportError('IMPORT_MAPPING_INCOMPLETE', { fieldErrors });

    const choices = Object.fromEntries(
      Object.entries(body.options.paymentValueMap ?? {}).map(
        ([value, choice]) => [normalizePaymentValue(value), choice],
      ),
    );
    const [paymentCounts, dateCounts] = await Promise.all([
      columns.paymentMethod
        ? this.repository.columnValueCounts(
            user.orgId,
            batchId,
            columns.paymentMethod,
          )
        : Promise.resolve([]),
      columns.orderDate
        ? this.repository.columnValueCounts(
            user.orgId,
            batchId,
            columns.orderDate,
          )
        : Promise.resolve([]),
    ]);
    const { paymentValues, dateFormat } = this.columnChecks(
      columns,
      (column) =>
        column === columns.paymentMethod ? paymentCounts : dateCounts,
      choices,
      'merchant',
    );

    if (dateFormat?.ambiguous && body.options.dateFormat === 'auto')
      fieldErrors['options.dateFormat'] =
        'Choose the date format: every date reads as both day/month and month/day.';
    if (
      paymentValues?.values.some((entry) => entry.classification === 'unknown')
    )
      fieldErrors['options.paymentValueMap'] =
        'Choose COD or not COD for every listed payment value.';
    if (Object.keys(fieldErrors).length > 0)
      throw orderImportError('IMPORT_MAPPING_INCOMPLETE', {
        fieldErrors,
        paymentValues,
        dateFormat,
      });

    const options: ImportOptions = {
      country: body.options.country,
      defaultCurrency: body.options.defaultCurrency,
      dateFormat: body.options.dateFormat,
      paymentValueMap: choicesForListedValues(choices, paymentValues),
    };
    const sources = this.sourcesAfterSave(batch.mapping, columns);
    const stored: StoredImportMapping = {
      dictionaryVersion: MAPPING_DICTIONARY_VERSION,
      confirmed: true,
      columns,
      sources,
    };
    const result = await this.repository.saveMapping({
      orgId: user.orgId,
      batchId,
      userId: user.userId,
      headerSignature: headerSignature(headers),
      mapping: stored,
      options,
      profile: {
        mapping: { dictionaryVersion: MAPPING_DICTIONARY_VERSION, columns },
        options,
      },
      now,
    });
    if (result.outcome === 'not_draft') {
      // A commit or the expiry moved the batch on after it was read.
      const current = await this.repository.findBatchForMapping(
        user.orgId,
        batchId,
      );
      if (!current) throw orderImportError('IMPORT_BATCH_NOT_FOUND');
      assertEditableDraft(current.status, current.expiresAt, new Date());
      throw orderImportError('IMPORT_BATCH_STATE_CONFLICT', {
        status: current.status,
      });
    }

    await this.rowValidation.validateBatch(
      { orgId: user.orgId, source },
      batchId,
    );
    const counts = await this.repository.readCounts(user.orgId, batchId);

    // Field names only, to tune the dictionary; never headers or values.
    this.logger.log(
      buildBackendLog(OrderImportMappingService.name, {
        action: 'order-import-mapping-save',
        outcome: 'success',
        orgId: user.orgId,
        batchId,
        dictionaryVersion: MAPPING_DICTIONARY_VERSION,
        detectedFields: IMPORT_FIELDS.filter(
          (field) => sources[field] === 'auto',
        ).join(','),
        savedFields: IMPORT_FIELDS.filter(
          (field) => sources[field] === 'saved',
        ).join(','),
        changedFields: IMPORT_FIELDS.filter(
          (field) => sources[field] === 'merchant',
        ).join(','),
        durationMs: Date.now() - startedAt,
      }),
    );

    return {
      batchId,
      status: 'draft',
      mappingDictionaryVersion: MAPPING_DICTIONARY_VERSION,
      mapping: columns,
      sources,
      options,
      mappingProfileId: result.mappingProfileId,
      unmappedColumns: unmappedColumns(headers, columns),
      paymentValues,
      dateFormat,
      counts,
    };
  }

  private toColumnMapping(
    body: SaveOrderImportMappingDto,
  ): ImportColumnMapping {
    const { mapping } = body;
    return {
      phone: mapping.phone ?? null,
      customerName: mapping.customerName,
      amount: mapping.amount ?? null,
      orderReference: mapping.orderReference ?? null,
      currency: mapping.currency ?? null,
      paymentMethod: mapping.paymentMethod ?? null,
      orderDate: mapping.orderDate ?? null,
      city: mapping.city ?? null,
      address: mapping.address ?? null,
      notes: mapping.notes ?? null,
    };
  }

  /**
   * A field the merchant left as it was keeps its origin (detected or saved);
   * a changed one becomes `merchant`. Re-saving the same body is stable.
   */
  private sourcesAfterSave(
    previous: unknown,
    columns: ImportColumnMapping,
  ): Record<ImportField, MappingSource> {
    const before =
      isRecord(previous) &&
      isRecord(previous.columns) &&
      isRecord(previous.sources)
        ? {
            columns: previous.columns as ImportColumnMapping,
            sources: previous.sources as Record<ImportField, MappingSource>,
          }
        : null;
    return Object.fromEntries(
      IMPORT_FIELDS.map((field): [ImportField, MappingSource] => {
        const now = columnsOf(columns, field);
        if (!before) return [field, now.length > 0 ? 'merchant' : 'none'];
        const then = columnsOf(
          {
            ...before.columns,
            customerName: isStringArray(before.columns.customerName)
              ? before.columns.customerName
              : [],
          },
          field,
        );
        const kept = sameColumns(then, now) ? before.sources[field] : undefined;
        return [field, kept ?? (now.length > 0 ? 'merchant' : 'none')];
      }),
    ) as Record<ImportField, MappingSource>;
  }

  /**
   * The mapping as the batch page shows it after a refresh or resume: the
   * stored columns and their origin, the matcher's confidence and
   * alternatives for the file, and the payment values and date check for the
   * mapped columns, computed the same way as at upload and save.
   */
  async describe(
    orgId: string,
    batch: {
      batchId: string;
      headers: readonly string[];
      mapping: unknown;
      options: unknown;
    },
    sampleRows: readonly { cells: readonly string[] }[],
  ): Promise<OrderImportMappingStateDto> {
    const detected = matchColumns(
      batch.headers,
      sampleRows.slice(0, MATCHER_SAMPLE_ROWS).map((row) => row.cells),
    );
    const stored = readStoredMapping(batch.mapping);
    const columns = stored?.columns ?? mappingFromSuggestions(detected.fields);
    const options = readStoredOptions(batch.options);

    const fields = detected.fields.map(
      (suggestion): OrderImportFieldStateDto => {
        const chosen = columnsOf(columns, suggestion.field);
        const source: MappingSource =
          stored?.sources[suggestion.field] ?? suggestion.source;
        const confidence =
          chosen.length === 0
            ? 'none'
            : source === 'auto'
              ? sameColumns(suggestion.columns, chosen)
                ? suggestion.confidence
                : 'partial'
              : 'exact';
        return {
          field: suggestion.field,
          required: suggestion.required,
          columns: chosen,
          confidence,
          source: chosen.length === 0 && source !== 'saved' ? 'none' : source,
          alternatives: [...suggestion.columns, ...suggestion.alternatives]
            .filter((column) => !chosen.includes(column))
            .filter((column, index, all) => all.indexOf(column) === index),
        };
      },
    );

    const counts = new Map<string, PaymentValueCount[]>();
    await Promise.all(
      [columns.paymentMethod, columns.orderDate]
        .filter((column): column is string => column !== null)
        .map(async (column) =>
          counts.set(
            column,
            await this.repository.columnValueCounts(
              orgId,
              batch.batchId,
              column,
            ),
          ),
        ),
    );
    const { paymentValues, dateFormat } = this.columnChecks(
      columns,
      (column) => counts.get(column) ?? [],
      options.paymentValueMap,
      stored?.confirmed ? 'merchant' : 'saved',
    );

    return {
      mappingConfirmed: stored?.confirmed ?? false,
      suggestions: {
        fields,
        unmappedColumns: unmappedColumns(batch.headers, columns),
      },
      options,
      paymentValues,
      dateFormat,
    };
  }

  /** Payment values and the date-format check for the mapped columns. */
  private columnChecks(
    columns: ImportColumnMapping,
    counts: (column: string) => PaymentValueCount[],
    choices: Readonly<Record<string, PaymentClassification>>,
    source: 'saved' | 'merchant',
  ): {
    paymentValues: OrderImportPaymentValuesDto | null;
    dateFormat: OrderImportDateFormatDto | null;
  } {
    const payment = columns.paymentMethod;
    const date = columns.orderDate;
    return {
      paymentValues: payment
        ? {
            column: payment,
            ...summarizePaymentValues(counts(payment), {
              map: choices,
              source,
            }),
          }
        : null,
      dateFormat: date
        ? {
            column: date,
            ...detectDateAmbiguity(counts(date).map(({ value }) => value)),
          }
        : null,
    };
  }
}
