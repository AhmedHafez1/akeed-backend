import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';
import type {
  ProviderTemplateRecord,
  TemplateComponentsSnapshot,
} from '../../../shared/messaging/template-provider.types';
import type { TemplateTextModel } from '../../../shared/messaging/template-text.types';
import {
  TemplateCatalogError,
  type TemplateCatalogErrorCode,
  type TemplateCatalogPort,
} from '../../../shared/ports/template-catalog.port';
import { readWhatsappTemplateConfig } from '../../../shared/config/whatsapp-template.config';
import {
  RATE_LIMIT_ERROR_CODES,
  TOKEN_ERROR_CODE,
  isPermissionErrorCode,
  mapApiStatus,
  mapCategory,
  mapComponents,
  mapQuality,
  normalizeLanguageCode,
} from './meta-template.mapping';
import { describeMetaComponents } from './meta-template-text';

/** The Graph version Akeed already sends with (record, "Graph API version"). */
export const META_TEMPLATE_GRAPH_BASE_URL = 'https://graph.facebook.com/v24.0';

/** The fields read for each template (record 4.1.2). */
export const META_TEMPLATE_FIELDS = [
  'id',
  'name',
  'language',
  'status',
  'category',
  'correct_category',
  'quality_score',
  'components',
].join(',');

/** Page size and page cap: 60 pages of 100 covers 6,000 templates (4.9.2). */
export const META_TEMPLATE_PAGE_SIZE = 100;
export const META_TEMPLATE_MAX_PAGES = 60;

interface MetaTemplateNode {
  id?: unknown;
  name?: unknown;
  language?: unknown;
  status?: unknown;
  category?: unknown;
  correct_category?: unknown;
  quality_score?: unknown;
  components?: unknown;
}

interface MetaTemplatePage {
  data?: MetaTemplateNode[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}

/**
 * Reads the WhatsApp Business Account's templates from Meta (record 4.1.1),
 * read-only.
 *
 * - The token travels in the `Authorization` header only, never in a URL.
 * - Pages are followed with `paging.cursors.after`. `paging.next` is read only
 *   as "is there more"; it is never followed, because it is a full URL that
 *   may carry credentials (record 1.4).
 * - Every page is read before anything is returned, so a failure part-way
 *   gives the caller nothing rather than a partial list.
 * - A log line carries the HTTP status, Meta's numeric code and the page
 *   number, never the URL, the response body or the token.
 */
@Injectable()
export class MetaTemplateCatalogAdapter implements TemplateCatalogPort {
  private readonly logger = new Logger(MetaTemplateCatalogAdapter.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  async listTemplates(): Promise<ProviderTemplateRecord[]> {
    const accountId = readWhatsappTemplateConfig(this.config).businessAccountId;
    const token = this.config.get<string>('WA_ACCESS_TOKEN');
    if (!accountId || !token) {
      throw this.failure('not_configured', undefined, 0);
    }

    const records: ProviderTemplateRecord[] = [];
    let after: string | undefined;
    for (let page = 1; page <= META_TEMPLATE_MAX_PAGES; page += 1) {
      const body = await this.readPage(accountId, token, after, page);
      for (const node of body.data ?? []) {
        const record = toRecord(node);
        if (record) records.push(record);
      }
      const cursor = body.paging?.cursors?.after;
      if (!body.paging?.next || typeof cursor !== 'string' || !cursor) {
        return records;
      }
      after = cursor;
    }
    throw this.failure('too_many_pages', undefined, META_TEMPLATE_MAX_PAGES);
  }

  describeComponents(
    snapshot: TemplateComponentsSnapshot | null,
  ): TemplateTextModel | null {
    return describeMetaComponents(snapshot);
  }

  private async readPage(
    accountId: string,
    token: string,
    after: string | undefined,
    page: number,
  ): Promise<MetaTemplatePage> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<MetaTemplatePage>(
          `${META_TEMPLATE_GRAPH_BASE_URL}/${accountId}/message_templates`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              fields: META_TEMPLATE_FIELDS,
              limit: META_TEMPLATE_PAGE_SIZE,
              ...(after ? { after } : {}),
            },
            timeout: 15_000,
          },
        ),
      );
      const data = response.data;
      if (!data || (data.data !== undefined && !Array.isArray(data.data))) {
        throw this.failure('provider_error', response.status, page);
      }
      return data;
    } catch (error) {
      if (error instanceof TemplateCatalogError) throw error;
      throw this.classify(error, page);
    }
  }

  private classify(error: unknown, page: number): TemplateCatalogError {
    if (!isAxiosError<{ error?: { code?: unknown } }>(error)) {
      return this.failure('network', undefined, page);
    }
    if (!error.response) return this.failure('network', undefined, page);
    const metaCode = error.response.data?.error?.code;
    if (typeof metaCode === 'number' && Number.isInteger(metaCode)) {
      const code: TemplateCatalogErrorCode = RATE_LIMIT_ERROR_CODES.has(
        metaCode,
      )
        ? 'rate_limited'
        : metaCode === TOKEN_ERROR_CODE
          ? 'auth_failed'
          : isPermissionErrorCode(metaCode)
            ? 'permission_denied'
            : 'provider_error';
      return this.failure(code, metaCode, page, error.response.status);
    }
    return this.failure(
      'provider_error',
      error.response.status,
      page,
      error.response.status,
    );
  }

  private failure(
    code: TemplateCatalogErrorCode,
    providerCode: number | undefined,
    page: number,
    httpStatus?: number,
  ): TemplateCatalogError {
    this.logger.warn(
      buildBackendLog(MetaTemplateCatalogAdapter.name, {
        action: 'meta-template-list',
        outcome: 'failure',
        errorCode: code,
        ...(providerCode !== undefined ? { providerCode } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        page,
      }),
    );
    return new TemplateCatalogError(code, providerCode);
  }
}

/**
 * One listed template in neutral terms. A node without a name, a language or
 * an ID cannot be matched to anything and is left out.
 */
function toRecord(node: MetaTemplateNode): ProviderTemplateRecord | null {
  const id =
    typeof node.id === 'string'
      ? node.id
      : typeof node.id === 'number'
        ? String(node.id)
        : null;
  if (
    !id ||
    typeof node.name !== 'string' ||
    typeof node.language !== 'string'
  ) {
    return null;
  }
  const category = mapCategory(node.category);
  // `correct_category` names a coming change (record 4.5.7); equal to the
  // current category, it announces nothing.
  const correct =
    node.correct_category === undefined || node.correct_category === null
      ? null
      : mapCategory(node.correct_category);
  return {
    providerTemplateId: id,
    templateName: node.name,
    languageCode: normalizeLanguageCode(node.language),
    status: mapApiStatus(node.status),
    category,
    pendingCategory: correct && correct !== category ? correct : null,
    quality: mapQuality(node.quality_score),
    components: mapComponents(node.components),
  };
}
