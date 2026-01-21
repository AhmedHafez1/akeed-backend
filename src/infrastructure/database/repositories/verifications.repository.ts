import { Injectable, Inject } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../schema';
import { eq } from 'drizzle-orm';
import { VerificationStatus } from 'src/core/interfaces/verification.interface';
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

  async findByOrderId(id: string) {
    return await this.db.query.verifications.findFirst({
      where: eq(verifications.orderId, id),
    });
  }

  async findById(verificationId: string) {
    return await this.db.query.verifications.findFirst({
      where: eq(verifications.id, verificationId),
    });
  }

  async updateStatus(
    id: string,
    status: VerificationStatus,
    waMessageId?: string,
  ) {
    return await this.db
      .update(verifications)
      .set({
        status: status as typeof verifications.$inferSelect.status,
        waMessageId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(verifications.id, id))
      .returning();
  }

  async updateStatusByWamid(wamid: string, status: VerificationStatus) {
    return await this.db
      .update(verifications)
      .set({
        status: status as typeof verifications.$inferSelect.status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(verifications.waMessageId, wamid))
      .returning();
  }
}
