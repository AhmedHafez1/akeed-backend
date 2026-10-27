import { IsIn, IsOptional } from 'class-validator';
import {
  INTERFACE_LOCALES,
  type InterfaceLocale,
} from '../../../shared/i18n/interface-locales';
import type { TipActionRoute } from '../../../shared/tips-campaigns/tip-action-routes';
import type { TipsCampaignType } from '../../../shared/tips-campaigns/tips-campaign.types';

export class TipsCardsQueryDto {
  /** The merchant's dashboard language; cards fall back to English. */
  @IsOptional()
  @IsIn(INTERFACE_LOCALES)
  locale?: InterfaceLocale;
}

export type TipsCardActionDto =
  | { kind: 'internal'; route: TipActionRoute; label: string }
  | { kind: 'external'; url: string; label: string };

export interface TipsCardDto {
  /** First view by any teammate in this organization; null means unread. */
  first_viewed_at: string | null;
  id: string;
  type: TipsCampaignType;
  /** The language the card is written in, which may be the English fallback. */
  locale: InterfaceLocale;
  title: string;
  description: string;
  action: TipsCardActionDto | null;
  published_at: string;
}

export interface TipsCardsResponseDto {
  cards: TipsCardDto[];
  /** Viewers see cards but cannot dismiss them for the whole account. */
  can_dismiss: boolean;
}

export interface TipsEventResponseDto {
  recorded: true;
}
