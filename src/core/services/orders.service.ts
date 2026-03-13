import { Injectable } from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import {
  GetOrdersQueryDto,
  OrderListItemDto,
  PaginatedResponse,
} from '../dto/dashboard.dto';
import { decodeCursor, encodeCursor } from './pagination.helpers';

@Injectable()
export class OrdersService {
  constructor(private readonly ordersRepo: OrdersRepository) {}

  async listByOrg(
    orgId: string,
    query: GetOrdersQueryDto,
  ): Promise<PaginatedResponse<OrderListItemDto>> {
    const limit = query.limit ?? 50;
    const cursor = decodeCursor(query.cursor);

    const orders = await this.ordersRepo.findByOrg(orgId, {
      cursor,
      limit: limit + 1,
    });

    const hasMore = orders.length > limit;
    const items = hasMore ? orders.slice(0, limit) : orders;

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1])
        : null;

    return {
      data: items.map((order) => ({
        id: order.id,
        order_number: order.orderNumber ?? null,
        external_order_id: order.externalOrderId,
        customer_name: order.customerName ?? null,
        customer_phone: order.customerPhone,
        customer_email: order.customerEmail ?? null,
        total_price: order.totalPrice ? String(order.totalPrice) : null,
        currency: order.currency ?? null,
        created_at: order.createdAt ?? null,
        verification_status: order.verifications?.[0]?.status ?? null,
      })),
      next_cursor: nextCursor,
    };
  }
}
