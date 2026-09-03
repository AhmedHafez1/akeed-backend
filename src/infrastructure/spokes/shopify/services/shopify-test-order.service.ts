import { Inject, Injectable } from '@nestjs/common';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { validateShop } from '../shopify.utils';
import { ShopifyApiService } from './shopify-api.service';
import type { TestCodOrder } from './shopify-api.service.helpers';

@Injectable()
export class ShopifyTestOrderService {
  constructor(
    @Inject(IntegrationsRepository)
    private readonly integrations: IntegrationsRepository,
    @Inject(ShopifyApiService)
    private readonly shopify: ShopifyApiService,
  ) {}

  async createCodOrder(input: {
    store: string;
    phone: string;
    amount?: string;
    currencyCode?: string;
  }): Promise<TestCodOrder> {
    const store = input.store.trim().toLowerCase();
    if (!validateShop(store)) throw new Error('Invalid Shopify store domain');
    if (!/^\+[1-9]\d{7,14}$/.test(input.phone)) {
      throw new Error(
        'Phone must be in E.164 format, for example +201001234567',
      );
    }

    const amount = input.amount ?? '49.95';
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      throw new Error(
        'Amount must be a positive decimal with at most 2 places',
      );
    }
    const currencyCode = (input.currencyCode ?? 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new Error('Currency must be a 3-letter ISO currency code');
    }

    const integration = await this.integrations.findByPlatformDomain(
      store,
      'shopify',
    );
    if (!integration?.isActive || !integration.accessToken) {
      throw new Error(`No active Shopify integration found for ${store}`);
    }

    return this.shopify.createTestCodOrder(integration, {
      phone: input.phone,
      amount,
      currencyCode,
    });
  }
}
