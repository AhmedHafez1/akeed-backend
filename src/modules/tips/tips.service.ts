import { Injectable, NotFoundException } from '@nestjs/common';
import { TipsCampaignsRepository } from '../../infrastructure/database/repositories/tips-campaigns.repository';
import {
  FALLBACK_INTERFACE_LOCALE,
  type InterfaceLocale,
} from '../../shared/i18n/interface-locales';
import { isTipActionRoute } from '../../shared/tips-campaigns/tip-action-routes';
import { TIPS_CAMPAIGN_ERROR_CODES } from '../../shared/tips-campaigns/tips-campaign.errors';
import {
  TIPS_LIMITS,
  chooseTipsBundle,
} from '../../shared/tips-campaigns/tips-campaign.policy';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import {
  assertOrganizationWriteAllowed,
  canWriteOrganization,
} from '../auth/organization-role';
import type {
  TipsCardActionDto,
  TipsCardDto,
  TipsCardsResponseDto,
  TipsEventResponseDto,
} from './dto/tips.dto';

export type TipsEvent = 'view' | 'click' | 'dismiss';

/**
 * Tips and updates on the merchant dashboard. The organization always comes
 * from the authenticated user, and an event is recorded only on that
 * organization's own recipient row.
 */
@Injectable()
export class TipsService {
  constructor(private readonly campaigns: TipsCampaignsRepository) {}

  async getCards(
    user: AuthenticatedUser,
    locale: InterfaceLocale = FALLBACK_INTERFACE_LOCALE,
  ): Promise<TipsCardsResponseDto> {
    const rows = await this.campaigns.findMerchantCards(
      user.orgId,
      locale,
      TIPS_LIMITS.merchantCards,
    );
    const cards = rows.flatMap((row): TipsCardDto[] => {
      const hasAction = row.action_kind !== null;
      const bundle = chooseTipsBundle(row.translations, locale, hasAction);
      if (!bundle) return [];
      let action: TipsCardActionDto | null = null;
      if (
        row.action_kind === 'internal' &&
        isTipActionRoute(row.action_route) &&
        bundle.action_label
      ) {
        action = {
          kind: 'internal',
          route: row.action_route,
          label: bundle.action_label,
        };
      } else if (
        row.action_kind === 'external' &&
        row.action_url &&
        bundle.action_label
      ) {
        action = {
          kind: 'external',
          url: row.action_url,
          label: bundle.action_label,
        };
      }
      return [
        {
          id: row.id,
          first_viewed_at: row.first_viewed_at,
          type: row.type,
          locale: bundle.locale,
          title: bundle.title,
          description: bundle.description,
          action,
          published_at: row.published_at,
        },
      ];
    });
    return { cards, can_dismiss: canWriteOrganization(user.role) };
  }

  /**
   * A card's first view, first click or permanent dismissal. Repeats are
   * harmless; a campaign this organization did not receive is not found.
   */
  async recordEvent(
    user: AuthenticatedUser,
    campaignId: string,
    event: TipsEvent,
  ): Promise<TipsEventResponseDto> {
    if (event === 'dismiss') {
      assertOrganizationWriteAllowed(user.role, {
        code: TIPS_CAMPAIGN_ERROR_CODES.dismissForbidden,
        message: 'Viewers cannot dismiss tips for the account.',
      });
    }
    const visibility = await this.campaigns.findRecipientVisibility(
      campaignId,
      user.orgId,
    );
    if (!visibility || visibility.status === 'draft') {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'Tip not found.',
        code: TIPS_CAMPAIGN_ERROR_CODES.cardNotFound,
      });
    }
    await this.campaigns.recordEvent(campaignId, user.orgId, event);
    return { recorded: true };
  }
}
