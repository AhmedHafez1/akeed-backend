import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IntegrationsRepository } from '../../infrastructure/database/repositories/integrations.repository';
import {
  ReviewPromptsRepository,
  type ReviewPromptMerchantScope,
  type ReviewPromptStoreResults,
} from '../../infrastructure/database/repositories/review-prompts.repository';
import { resolveShopifyLinkedIntegration } from '../../shared/commerce/current-integration-resolver';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  effectiveReviewPromptState,
  reviewPromptVariantFor,
} from '../../shared/review-prompt/review-prompt.policy';
import type {
  ReviewPromptMerchantAction,
  ReviewRequestCode,
} from '../../shared/review-prompt/review-prompt.types';
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

/** Past this, the card shows its plain variant rather than wait for counts. */
export const REVIEW_PROMPT_RESULTS_DEADLINE_MS = 3_000;

const HIDDEN: ReviewPromptStateResponseDto = {
  visible: false,
  variant: 'fallback',
  confirmed: null,
  canceled: null,
  since: null,
};

/**
 * The merchant side of the App Store review prompt: whether the embedded
 * card shows and with which numbers, and what the merchant did with it. Only
 * an owner or admin in a Shopify session for the store's own shop is asked.
 */
@Injectable()
export class ReviewPromptService {
  private readonly logger = new Logger(ReviewPromptService.name);

  constructor(
    private readonly reviewPrompts: ReviewPromptsRepository,
    private readonly integrations: IntegrationsRepository,
  ) {}

  /**
   * The card shows while staff have the prompt on and the store's state is
   * eligible. Its results are read live, within a deadline; slow or failed
   * counts give the plain variant rather than hold the page.
   */
  async getState(
    user: AuthenticatedUser,
  ): Promise<ReviewPromptStateResponseDto> {
    if (user.source !== 'shopify' || !user.shop) return HIDDEN;
    if (!canWriteOrganization(user.role)) return HIDDEN;

    const integration = await this.findStore(user, user.shop);
    if (!integration?.isActive) return HIDDEN;

    const view = await this.guard('review-prompt-state', user, () =>
      this.reviewPrompts.findMerchantView(user.orgId, integration.id),
    );
    if (!view.switchedOn) return HIDDEN;
    if (effectiveReviewPromptState(view.state, new Date()) !== 'eligible') {
      return HIDDEN;
    }

    const results = await this.readResults(user.orgId, integration.id);
    return {
      visible: true,
      variant: reviewPromptVariantFor(results?.confirmed ?? null),
      confirmed: results?.confirmed ?? null,
      canceled: results?.canceled ?? null,
      since: results?.since ?? null,
    };
  }

  async recordAction(
    user: AuthenticatedUser,
    action: ReviewPromptMerchantAction,
    code: ReviewRequestCode | undefined,
    httpRequestId?: string,
  ): Promise<ReviewPromptActionResponseDto> {
    const scope = await this.requireScope(user, httpRequestId);
    const result = await this.guard('review-prompt-action', user, () =>
      this.reviewPrompts.recordMerchantEvent(
        scope,
        action,
        action === 'result' ? code : undefined,
      ),
    );
    this.logger.log(
      buildBackendLog(ReviewPromptService.name, {
        action: 'review-prompt-action',
        outcome: result.outcome === 'recorded' ? 'success' : 'skipped',
        result: result.outcome,
        orgId: scope.orgId,
        integrationId: scope.integrationId,
        merchantAction: action,
        resultCode: action === 'result' ? code : undefined,
      }),
    );
    return { outcome: result.outcome };
  }

  /**
   * The store's results, or undefined when they could not be read in time.
   * Never throws: the card still shows, with its plain variant.
   */
  private async readResults(
    orgId: string,
    integrationId: string,
  ): Promise<ReviewPromptStoreResults | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        REVIEW_PROMPT_RESULTS_DEADLINE_MS,
      );
    });
    try {
      const outcome = await Promise.race([
        this.reviewPrompts.countStoreResults(orgId, integrationId),
        deadline,
      ]);
      if (outcome !== 'timeout') return outcome;
      this.logger.warn(
        buildBackendLog(ReviewPromptService.name, {
          action: 'review-prompt-results',
          outcome: 'skipped',
          reason: 'deadline',
          orgId,
          integrationId,
        }),
      );
      return undefined;
    } catch (error) {
      this.logger.warn(
        buildBackendLog(ReviewPromptService.name, {
          action: 'review-prompt-results',
          outcome: 'failure',
          orgId,
          integrationId,
          ...normalizeError(error),
        }),
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requireScope(
    user: AuthenticatedUser,
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
   * card can report again.
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
}
