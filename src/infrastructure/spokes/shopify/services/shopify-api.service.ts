import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ShopifyApiService {
  private readonly logger = new Logger(ShopifyApiService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly integrationsRepo: IntegrationsRepository,
  ) {}

  async addOrderTag(
    shopDomain: string,
    orderId: string,
    tag: string,
  ): Promise<void> {
    const integration = await this.integrationsRepo.findByPlatformDomain(
      shopDomain,
      'shopify',
    );

    if (!integration || !integration.accessToken) {
      this.logger.error(
        `Shopify integration not found or missing token for domain: ${shopDomain}`,
      );
      throw new Error(
        `Shopify integration not found for domain: ${shopDomain}`,
      );
    }

    // Ensure orderId is not already a GID before wrapping it.
    // If user passes raw ID "123", we make it "gid://shopify/Order/123".
    const gid = orderId.startsWith('gid://')
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const url = `https://${shopDomain}/admin/api/2024-01/graphql.json`;

    const mutation = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          url,
          {
            query: mutation,
            variables: {
              id: gid,
              tags: [tag],
            },
          },
          {
            headers: {
              'X-Shopify-Access-Token': integration.accessToken,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      const data = response.data;

      if (data.errors) {
        this.logger.error(`GraphQL Errors: ${JSON.stringify(data.errors)}`);
        throw new Error(
          `Shopify GraphQL Error: ${JSON.stringify(data.errors)}`,
        );
      }

      const userErrors = data.data?.tagsAdd?.userErrors;
      if (userErrors && userErrors.length > 0) {
        this.logger.error(`User Errors: ${JSON.stringify(userErrors)}`);
        throw new Error(`Shopify User Errors: ${JSON.stringify(userErrors)}`);
      }

      this.logger.log(
        `Successfully added tag '${tag}' to order ${gid} on ${shopDomain}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to add tag to order: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
