import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../schema';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import { integrations } from '../schema';

@Injectable()
export class IntegrationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async findByPlatformDomain(domain: string, platformType: string) {
    return await this.db.query.integrations.findFirst({
      where: and(
        eq(integrations.platformStoreUrl, domain),
        eq(integrations.platformType, platformType),
      ),
    });
  }
}
