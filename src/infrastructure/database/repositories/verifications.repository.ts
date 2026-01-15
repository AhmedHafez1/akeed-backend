import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../schema';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../database.provider';
import { verifications } from '../schema';

@Injectable()
export class VerificationsRepository {
  constructor(@Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>) {}

  async create(data: typeof verifications.$inferInsert) {
    const [result] = await this.db
      .insert(verifications)
      .values(data)
      .returning();
    return result;
  }

  async updateStatus(
    id: string,
    status: typeof verifications.status,
    waMessageId?: string,
  ) {
    return await this.db
      .update(verifications)
      .set({ status, waMessageId, updatedAt: new Date().toISOString() })
      .where(eq(verifications.id, id))
      .returning();
  }
}
