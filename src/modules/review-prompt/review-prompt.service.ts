import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  ReviewPromptsRepository,
  type ReviewPromptMerchantScope,
} from '../../infrastructure/database/repositories/review-prompts.repository';
import { resolveShopifyLinkedIntegration } from '../../shared/commerce/current-integration-resolver';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import type { ReviewPromptMerchantAction } from '../../shared/review-prompt/review-prompt.types';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../auth/organization-role';
import type {
  ReviewPromptActionResponseDto,
  ReviewPromptStateResponseDto,
} from './dto/review-prompt.dto';

export const REVIEW_PROMPT_ERROR_CODES = {
  forbidden: 'REVIEW_PROMPT_FORBIDDEN',
  notFound: 'REVIEW_PROMPT_NOT_FOUND',
  notPending: 'REVIEW_PROMPT_NOT_PENDING',
  unavailable: 'REVIEW_PROMPT_UNAVAILABLE',
} as const;

/**
 * The merchant side of the App Store review prompt: whether the embedded
 * dashboard shows the banner, its first impression and the merchant's one
 * answer. Only a Shopify session for the store's own shop reaches a request.
 */
@Injectable()
export class ReviewPromptService {
  private readonly logger = new Logger(ReviewPromptService.name);

  constructor(
    private readonly reviewPrompts: ReviewPromptsRepository,
    private readonly integrations: IntegrationsRepository,
  ) {}

  /** The store's pending request, or null when the banner should not show. */
  async getState(
    user: AuthenticatedUser,
  ): Promise<ReviewPromptStateResponseDto> {
    if (user.source !== 'shopify' || !user.shop) return { prompt: null };
    if (!canWriteOrganization(user.role)) return { prompt: null };

    const integration = await this.findStore(user, user.shop);
    if (!integration?.isActive) return { prompt: null };

    const pending = await this.guard('review-prompt-state', user, () =>
      this.reviewPrompts.findPending(user.orgId, integration.id),
    );
    return { prompt: pending ? { id: pending.id } : null };
  }

  async recordShown(
    user: AuthenticatedUser,
    requestId: string,
    httpRequestId?: string,
  ): Promise<void> {
    const scope = await this.requireScope(user, requestId, httpRequestId);
    const result = await this.guard('review-prompt-shown', user, () =>
      this.reviewPrompts.recordShown(scope),
    );
    if (result.outcome === 'not_found') throw this.notFound();
    this.logOutcome('review-prompt-shown', scope, result.outcome);
  }

  async recordAction(
    user: AuthenticatedUser,
    requestId: string,
    action: ReviewPromptMerchantAction,
    httpRequestId?: string,
  ): Promise<ReviewPromptActionResponseDto> {
    const scope = await this.requireScope(user, requestId, httpRequestId);
    const result = await this.guard('review-prompt-action', user, () =>
      this.reviewPrompts.recordMerchantAction(scope, action),
    );
    if (result.outcome === 'not_found') throw this.notFound();
    if (result.outcome === 'conflict') {
      this.logOutcome('review-prompt-action', scope, 'conflict', action);
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'This review request was already answered or closed.',
        code: REVIEW_PROMPT_ERROR_CODES.notPending,
      });
    }
    this.logOutcome('review-prompt-action', scope, result.outcome, action);
    return { outcome: result.outcome };
  }

  private async requireScope(
    user: AuthenticatedUser,
    requestId: string,
    httpRequestId?: string,
  ): Promise<ReviewPromptMerchantScope> {
    assertOrganizationWriteAllowed(user.role, {
      code: REVIEW_PROMPT_ERROR_CODES.forbidden,
      message: 'Viewers cannot answer the review request.',
    });
    if (user.source !== 'shopify' || !user.shop) throw this.notFound();
    const integration = await this.findStore(user, user.shop);
    if (!integration) throw this.notFound();
    return {
      orgId: user.orgId,
      integrationId: integration.id,
      requestId,
      actorId: user.userId,
      httpRequestId: httpRequestId?.slice(0, 128),
    };
  }

  /** The session's own shop within its own org; never a store from the body. */
  private async findStore(user: AuthenticatedUser, shopDomain: string) {
    const resolution = await this.guard('review-prompt-store', user, () =>
      resolveShopifyLinkedIntegration(this.integrations, {
        orgId: user.orgId,
        shopDomain,
        requireActive: false,
      }),
    );
    return resolution.outcome === 'not_found'
      ? undefined
      : resolution.integration;
  }

  /**
   * A database failure becomes a coded 503. Nothing was committed, so the
   * request is still pending and the banner can retry.
   */
  private async guard<T>(
    action: string,
    user: AuthenticatedUser,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.logger.error(
        buildBackendLog(ReviewPromptService.name, {
          action,
          outcome: 'failure',
          orgId: user.orgId,
          ...normalizeError(error),
        }),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The review request could not be saved. Try again.',
        code: REVIEW_PROMPT_ERROR_CODES.unavailable,
      });
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'Review request not found.',
      code: REVIEW_PROMPT_ERROR_CODES.notFound,
    });
  }

  private logOutcome(
    action: string,
    scope: ReviewPromptMerchantScope,
    outcome: string,
    merchantAction?: ReviewPromptMerchantAction,
  ): void {
    this.logger.log(
      buildBackendLog(ReviewPromptService.name, {
        action,
        outcome: outcome === 'recorded' ? 'success' : 'skipped',
        result: outcome,
        orgId: scope.orgId,
        integrationId: scope.integrationId,
        reviewPromptId: scope.requestId,
        merchantAction,
      }),
    );
  }
}
