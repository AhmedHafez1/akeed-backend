import {
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { OrdersService } from './orders.service';
import {
  GetOrdersQueryDto,
  OrderListItemDto,
  PaginatedResponse,
} from './dto/dashboard.dto';

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
