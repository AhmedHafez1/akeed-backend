import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import type { RequestWithUser } from '../guards/dual-auth.guard';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import { OrdersService } from '../services/orders.service';
import { OrderListItemDto } from '../dto/dashboard.dto';

@Controller('api/orders')
@UseGuards(DualAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async listOrders(
    @Request() req: RequestWithUser,
  ): Promise<{ orders: OrderListItemDto[] }> {
    const orders = await this.ordersService.listByOrg(req.user.orgId);
    return { orders };
  }
}
