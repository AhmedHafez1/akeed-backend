import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { IntegrationsRepository } from '../../../database/repositories/integrations.repository';
import { integrations } from 'src/infrastructure/database';
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
    integration: typeof integrations.$inferSelect,
    orderId: string,
    tag: string,
  ): Promise<void> {
    if (!integration.accessToken) {
      this.logger.error(
        `Missing token for domain: ${integration.platformStoreUrl}`,
      );
      throw new Error(
        `Missing token for domain: ${integration.platformStoreUrl}`,
      );
    }

    // Ensure orderId is not already a GID before wrapping it.
    // If user passes raw ID "123", we make it "gid://shopify/Order/123".
    const gid = orderId.startsWith('gid://')
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const url = `https://${integration.platformStoreUrl}/admin/api/2026-01/graphql.json`;

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
      const response: AxiosResponse<TagsAddResponse> = await firstValueFrom(
        this._httpService.post<TagsAddResponse>(
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

      this.handleGraphQLErrors(response, 'tagsAdd');

      const reqId = (response.headers?.['x-request-id'] ??
        response.headers?.['X-Request-Id']) as string | undefined;
      this.logger.log(
        `Successfully added tag '${tag}' to order ${gid} on ${integration.platformStoreUrl} (requestId=${reqId ?? 'n/a'})`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to add tag to order: ${message}`, stack);
      throw error;
    }
  }

  private handleGraphQLErrors(
    response: AxiosResponse<TagsAddResponse>,
    operation: string,
  ): void {
    const reqId = (response.headers?.['x-request-id'] ??
      response.headers?.['X-Request-Id']) as string | undefined;
    const data: TagsAddResponse = response.data;

    if (data.errors && data.errors.length > 0) {
      this.logger.error(
        `GraphQL Errors (${operation}, requestId=${reqId ?? 'n/a'}): ${JSON.stringify(data.errors)}`,
      );
    }

    const userErrors = data.data?.tagsAdd?.userErrors;
    if (userErrors && userErrors.length > 0) {
      this.logger.error(
        `User Errors (${operation}, requestId=${reqId ?? 'n/a'}): ${JSON.stringify(userErrors)}`,
      );
    }
  }
}
