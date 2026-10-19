import { IsIn, ValidateIf } from 'class-validator';
import {
  REVIEW_PROMPT_MERCHANT_ACTIONS,
  REVIEW_REQUEST_CODES,
  type ReviewPromptMerchantAction,
  type ReviewPromptVariant,
  type ReviewRequestCode,
} from '../../../shared/review-prompt/review-prompt.types';

export class ReviewPromptActionDto {
  @IsIn(REVIEW_PROMPT_MERCHANT_ACTIONS)
  action!: ReviewPromptMerchantAction;

  /** The Reviews API code; required with 'result', ignored otherwise. */
  @ValidateIf((dto: ReviewPromptActionDto) => dto.action === 'result')
  @IsIn(REVIEW_REQUEST_CODES)
  code?: ReviewRequestCode;
}

/**
 * Whether the embedded card shows, and what it leads with. Counts are null
 * when the variant is 'fallback' because they could not be read in time.
 */
export interface ReviewPromptStateResponseDto {
  visible: boolean;
  variant: ReviewPromptVariant;
  confirmed: number | null;
  canceled: number | null;
  since: string | null;
}

export interface ReviewPromptActionResponseDto {
  outcome: 'recorded' | 'replayed';
}
