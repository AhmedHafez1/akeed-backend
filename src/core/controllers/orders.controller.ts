import {
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../guards/dual-auth.guard';
import { CurrentUser } from '../guards/current-user.decorator';
import { DualAuthGuard } from '../guards/dual-auth.guard';
import { OrdersService } from '../services/orders.service';
import {
  GetOrdersQueryDto,
  OrderListItemDto,
  PaginatedResponse,
} from '../dto/dashboard.dto';

@Controller('api/orders')
@UseGuards(DualAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
  }),
)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async listOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetOrdersQueryDto,
  ): Promise<PaginatedResponse<OrderListItemDto>> {
    return this.ordersService.listByOrg(user.orgId, query);
  }
}
