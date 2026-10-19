import { IsIn } from 'class-validator';
import {
  REVIEW_PROMPT_MERCHANT_ACTIONS,
  type ReviewPromptMerchantAction,
} from '../../../shared/review-prompt/review-prompt.types';

export class ReviewPromptActionDto {
  @IsIn(REVIEW_PROMPT_MERCHANT_ACTIONS)
  action!: ReviewPromptMerchantAction;
}

export interface ReviewPromptStateResponseDto {
  prompt: { id: string } | null;
}

export interface ReviewPromptActionResponseDto {
  outcome: 'recorded' | 'replayed';
}
