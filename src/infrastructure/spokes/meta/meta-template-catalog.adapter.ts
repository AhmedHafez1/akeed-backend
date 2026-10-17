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
import type {
  ImageTwinSubmission,
  TemplateEditSubmission,
  TemplateSubmission,
  TemplateSubmissionResult,
} from '../../../shared/messaging/template-draft.types';
import {
  TemplateCatalogError,
  TemplateSubmissionError,
  type TemplateCatalogErrorCode,
  type TemplateCatalogPort,
  type TemplateSubmissionErrorCode,
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
  mapRejectionReason,
  mapSubmissionErrorCode,
  normalizeLanguageCode,
} from './meta-template.mapping';
import {
  buildMetaCreateBody,
  buildMetaEditBody,
  buildMetaImageTwinBody,
} from './meta-template-components.builder';
import { describeMetaComponents } from './meta-template-text';

/** The Graph version Akeed already sends with (record, "Graph API version"). */
export const META_TEMPLATE_GRAPH_BASE_URL = 'https://graph.facebook.com/v24.0';

/** The fields read for each template. */
export const META_TEMPLATE_FIELDS = [
  'id',
  'name',
  'language',
  'status',
  'category',
  'correct_category',
  'quality_score',
  'rejected_reason',
  'components',
].join(',');

/** One attempt, this long at most. A create or an edit is never retried. */
export const META_TEMPLATE_WRITE_TIMEOUT_MS = 15_000;

/** A provider trace reference is kept only when it looks like one. */
const TRACE_REFERENCE = /^[A-Za-z0-9_-]{1,64}$/;

/** A template node ID is digits; it goes into a URL path. */
const TEMPLATE_NODE_ID = /^\d{1,32}$/;

type MetaWriteAction =
  | 'meta-template-create'
  | 'meta-template-edit'
  | 'meta-template-image-upload';

/** An upload session id (`upload:...`) goes into a URL path. */
const UPLOAD_SESSION_ID = /^upload:[A-Za-z0-9_=+/-]{1,512}$/;

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
  rejected_reason?: unknown;
  components?: unknown;
}

interface MetaTemplatePage {
  data?: MetaTemplateNode[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}

/**
 * Reads the WhatsApp Business Account's templates from Meta,
 * and creates and edits them (4.1.3, 4.1.4). It never deletes one.
 *
 * - A create or an edit is sent once. Whatever the answer, it is not sent
 *   again here: no answer, a 5xx or a body without a Graph
 *   code is `unresolved`, because Meta may have applied it.
 * - The token travels in the `Authorization` header only, never in a URL.
 * - Pages are followed with `paging.cursors.after`. `paging.next` is read only
 *   as "is there more"; it is never followed, because it is a full URL that
 *   may carry credentials.
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

  async createTemplate(
    submission: TemplateSubmission,
  ): Promise<TemplateSubmissionResult> {
    return this.create(buildMetaCreateBody(submission));
  }

  async createImageTwin(
    submission: ImageTwinSubmission,
  ): Promise<TemplateSubmissionResult> {
    return this.create(buildMetaImageTwinBody(submission));
  }

  /**
   * Meta's resumable upload, in its two calls: open a session for the file,
   * then send the bytes from offset 0. The answer's `h` is the handle a
   * template's image header is reviewed with. Neither call is retried; a
   * failed upload creates nothing a template refers to.
   */
  async uploadSampleImage(
    bytes: Buffer,
    contentType: 'image/jpeg',
  ): Promise<string> {
    const action = 'meta-template-image-upload';
    const { token } = this.writeCredentials(action);
    const appId = readWhatsappTemplateConfig(this.config).metaAppId;
    if (!appId) throw this.writeFailure(action, 'not_configured', false);

    let session: unknown;
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ id?: unknown }>(
          `${META_TEMPLATE_GRAPH_BASE_URL}/${appId}/uploads`,
          null,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              file_name: 'akeed-logo-sample.jpg',
              file_length: bytes.byteLength,
              file_type: contentType,
            },
            timeout: META_TEMPLATE_WRITE_TIMEOUT_MS,
          },
        ),
      );
      session = response.data?.id;
    } catch (error) {
      throw this.classifyWrite(action, error);
    }
    if (typeof session !== 'string' || !UPLOAD_SESSION_ID.test(session)) {
      throw this.writeFailure(action, 'unresolved', false);
    }

    let handle: unknown;
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ h?: unknown }>(
          `${META_TEMPLATE_GRAPH_BASE_URL}/${session}`,
          bytes,
          {
            // The upload API takes the token as `OAuth`, not `Bearer`.
            headers: {
              Authorization: `OAuth ${token}`,
              file_offset: '0',
              'Content-Type': contentType,
            },
            timeout: META_TEMPLATE_WRITE_TIMEOUT_MS,
          },
        ),
      );
      handle = response.data?.h;
    } catch (error) {
      throw this.classifyWrite(action, error);
    }
    if (typeof handle !== 'string' || handle.length === 0) {
      throw this.writeFailure(action, 'unresolved', false);
    }
    this.logger.log(
      buildBackendLog(MetaTemplateCatalogAdapter.name, {
        action,
        outcome: 'success',
        bytes: bytes.byteLength,
      }),
    );
    return handle;
  }

  /** One create request, for a template or an image twin. */
  private async create(
    body: Record<string, unknown> | null,
  ): Promise<TemplateSubmissionResult> {
    const { accountId, token } = this.writeCredentials('meta-template-create');
    if (!body) {
      throw this.writeFailure(
        'meta-template-create',
        'invalid_parameter',
        false,
      );
    }
    const data = await this.post<{
      id?: unknown;
      status?: unknown;
      category?: unknown;
    }>(
      'meta-template-create',
      `${META_TEMPLATE_GRAPH_BASE_URL}/${accountId}/message_templates`,
      token,
      body,
    );
    const id =
      typeof data?.id === 'string'
        ? data.id
        : typeof data?.id === 'number'
          ? String(data.id)
          : null;
    if (!id) {
      // Accepted, but without the ID the template cannot be told apart from
      // one that was never created: the caller reads the list to find out.
      throw this.writeFailure('meta-template-create', 'unresolved', true);
    }
    this.logger.log(
      buildBackendLog(MetaTemplateCatalogAdapter.name, {
        action: 'meta-template-create',
        outcome: 'success',
        providerTemplateId: id,
      }),
    );
    return {
      providerTemplateId: id,
      status: mapApiStatus(data?.status),
      category: mapCategory(data?.category),
    };
  }

  async editTemplate(
    providerTemplateId: string,
    submission: TemplateEditSubmission,
  ): Promise<void> {
    const { token } = this.writeCredentials('meta-template-edit');
    if (!TEMPLATE_NODE_ID.test(providerTemplateId)) {
      throw this.writeFailure('meta-template-edit', 'invalid_parameter', false);
    }
    const data = await this.post<{ success?: unknown }>(
      'meta-template-edit',
      `${META_TEMPLATE_GRAPH_BASE_URL}/${providerTemplateId}`,
      token,
      buildMetaEditBody(submission),
    );
    // Akeed reads `success` only.
    if (data?.success !== true) {
      throw this.writeFailure('meta-template-edit', 'unresolved', true);
    }
    this.logger.log(
      buildBackendLog(MetaTemplateCatalogAdapter.name, {
        action: 'meta-template-edit',
        outcome: 'success',
        providerTemplateId,
      }),
    );
  }

  private writeCredentials(action: MetaWriteAction): {
    accountId: string;
    token: string;
  } {
    const accountId = readWhatsappTemplateConfig(this.config).businessAccountId;
    const token = this.config.get<string>('WA_ACCESS_TOKEN');
    if (!accountId || !token) {
      throw this.writeFailure(action, 'not_configured', false);
    }
    return { accountId, token };
  }

  /** One POST, with the token in the header only and no retry. */
  private async post<T>(
    action: MetaWriteAction,
    url: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<T | undefined> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<T>(url, body, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: META_TEMPLATE_WRITE_TIMEOUT_MS,
        }),
      );
      return response.data;
    } catch (error) {
      throw this.classifyWrite(action, error);
    }
  }

  private classifyWrite(
    action: MetaWriteAction,
    error: unknown,
  ): TemplateSubmissionError {
    if (
      !isAxiosError<{ error?: { code?: unknown; fbtrace_id?: unknown } }>(
        error,
      ) ||
      !error.response
    ) {
      return this.writeFailure(action, 'unresolved', true);
    }
    const { status, data } = error.response;
    const metaCode = data?.error?.code;
    const trace = data?.error?.fbtrace_id;
    const reference =
      typeof trace === 'string' && TRACE_REFERENCE.test(trace)
        ? trace
        : undefined;
    if (
      status >= 500 ||
      typeof metaCode !== 'number' ||
      !Number.isInteger(metaCode)
    ) {
      return this.writeFailure(
        action,
        'unresolved',
        true,
        status,
        status,
        reference,
      );
    }
    return this.writeFailure(
      action,
      mapSubmissionErrorCode(metaCode),
      false,
      metaCode,
      status,
      reference,
    );
  }

  private writeFailure(
    action: MetaWriteAction,
    code: TemplateSubmissionErrorCode,
    ambiguous: boolean,
    providerCode?: number,
    httpStatus?: number,
    providerReference?: string,
  ): TemplateSubmissionError {
    this.logger.warn(
      buildBackendLog(MetaTemplateCatalogAdapter.name, {
        action,
        outcome: 'failure',
        errorCode: code,
        ambiguous,
        ...(providerCode !== undefined ? { providerCode } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(providerReference ? { providerReference } : {}),
      }),
    );
    return new TemplateSubmissionError(
      code,
      ambiguous,
      providerCode,
      providerReference,
    );
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
  const rejectionReason = mapRejectionReason(node.rejected_reason);
  // `correct_category` names a coming change; equal to the
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
    ...(rejectionReason !== undefined ? { rejectionReason } : {}),
  };
}
