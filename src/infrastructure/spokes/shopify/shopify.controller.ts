import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ShopifyHmacGuard } from '../../../shared/guards/shopify-hmac.guard';
import { ShopifyBillingWebhookService } from './services/shopify-billing-webhook.service';
import { ShopifyGdprWebhookService } from './services/shopify-gdpr-webhook.service';
import { ShopifyOrderWebhookService } from './services/shopify-order-webhook.service';
import {
  ShopifyAppSubscriptionWebhookDto,
  ShopifyAppUninstalledDto,
  ShopifyCustomersDataRequestDto,
  ShopifyCustomersRedactDto,
  ShopifyOrderWebhookDto,
  ShopifyShopRedactDto,
} from './dto/shopify-webhooks.dto';

@Controller('webhooks/shopify')
@UseGuards(ShopifyHmacGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: false,
  }),
)
export class ShopifyController {
  constructor(
    private readonly orderWebhookService: ShopifyOrderWebhookService,
    private readonly billingWebhookService: ShopifyBillingWebhookService,
    private readonly gdprWebhookService: ShopifyGdprWebhookService,
  ) {}

  @Post('orders-create')
  @HttpCode(200)
  async handleOrderCreate(
    @Body() payload: ShopifyOrderWebhookDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    return this.orderWebhookService.handleOrderCreate(
      payload,
      shopDomain,
      webhookId,
      topic,
    );
  }

  @Post('uninstalled')
  @HttpCode(200)
  async handleAppUninstalled(
    @Body() payload: ShopifyAppUninstalledDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    return this.billingWebhookService.handleAppUninstalled(
      payload,
      shopDomain,
      webhookId,
      topic,
    );
  }

  @Post(['app-subscriptions-update', 'app-subscriptions/update'])
  @HttpCode(200)
  async handleAppSubscriptionUpdate(
    @Body() payload: ShopifyAppSubscriptionWebhookDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    return this.billingWebhookService.handleAppSubscriptionUpdate(
      payload,
      shopDomain,
      webhookId,
      topic,
    );
  }

  @Post('customers/data_request')
  @HttpCode(200)
  async handleCustomerDataRequest(
    @Body() payload: ShopifyCustomersDataRequestDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    return this.gdprWebhookService.handleCustomerDataRequest(
      payload,
      shopDomain,
      webhookId,
      topic,
    );
  }

  @Post('customers/redact')
  @HttpCode(200)
  async handleCustomerRedact(
    @Body() payload: ShopifyCustomersRedactDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    return this.gdprWebhookService.handleCustomerRedact(
      payload,
      shopDomain,
      webhookId,
      topic,
    );
  }

  @Post('shop/redact')
  @HttpCode(200)
  async handleShopRedact(
    @Body() payload: ShopifyShopRedactDto,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-webhook-id') webhookId: string,
    @Headers('x-shopify-topic') topic: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    return this.gdprWebhookService.handleShopRedact(
      payload,
      shopDomain,
      webhookId,
      topic,
    );
  }
}
