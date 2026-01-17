import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import axios, { AxiosResponse } from 'axios';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
// rxjs not needed when using axiosRef

interface TagsAddResponse {
  data?: {
    tagsAdd?: {
      node?: { id: string };
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string; locations?: unknown; path?: string[] }>;
}

@Injectable()
export class ShopifyApiService {
  private readonly logger = new Logger(ShopifyApiService.name);

  constructor(
    private readonly _httpService: HttpService,
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
      const response: AxiosResponse<TagsAddResponse> = await axios.post(
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
      );

      const data: TagsAddResponse = response.data;

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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to add tag to order: ${message}`, stack);
      throw error;
    }
  }
}
