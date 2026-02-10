import { BadRequestException, Injectable } from '@nestjs/common';
import { VerificationsRepository } from '../../infrastructure/database/repositories/verifications.repository';
import {
  GetVerificationsQueryDto,
  VerificationListItemDto,
} from '../dto/dashboard.dto';
import { VerificationStatus } from '../interfaces/verification.interface';

const ALLOWED_STATUSES: VerificationStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'confirmed',
  'canceled',
  'expired',
  'failed',
];

@Injectable()
export class VerificationsService {
  constructor(private readonly verificationsRepo: VerificationsRepository) {}

  async listByOrg(
    orgId: string,
    query: GetVerificationsQueryDto,
  ): Promise<VerificationListItemDto[]> {
    const statuses = this.parseStatuses(query.status);
    const verifications = await this.verificationsRepo.findByOrg(
      orgId,
      statuses,
    );

    return verifications.map((verification) => ({
      id: verification.id,
      status: verification.status ?? 'pending',
      order_id: verification.orderId,
      order_number: verification.order?.orderNumber ?? null,
      customer_name: verification.order?.customerName ?? null,
      customer_phone: verification.order?.customerPhone ?? null,
      total_price: verification.order?.totalPrice
        ? verification.order.totalPrice.toString()
        : null,
      currency: verification.order?.currency ?? null,
      created_at: verification.createdAt ?? null,
    }));
  }

  private parseStatuses(input?: string): VerificationStatus[] | undefined {
    if (!input) return undefined;

    const statuses = input
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean) as VerificationStatus[];

    if (statuses.length === 0) return undefined;

    const invalid = statuses.filter(
      (status) => !ALLOWED_STATUSES.includes(status),
    );

    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid status filter: ${invalid.join(', ')}`,
      );
    }

    return statuses;
  }
}
