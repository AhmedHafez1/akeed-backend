import { Injectable } from '@nestjs/common';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { OrderListItemDto } from '../dto/dashboard.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly ordersRepo: OrdersRepository) {}

  async listByOrg(orgId: string): Promise<OrderListItemDto[]> {
    const orders = await this.ordersRepo.findByOrg(orgId);

    return orders.map((order) => ({
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
    }));
  }
}
