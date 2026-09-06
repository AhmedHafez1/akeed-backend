import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Param,
  Query,
  UseGuards,
  UsePipes,
  type ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { OrdersService } from './orders.service';
import {
  GetVerificationStatsQueryDto,
  GetOrdersQueryDto,
  OrderListItemDto,
  PaginatedResponse,
  StandaloneDashboardStatsDto,
} from './dto/dashboard.dto';
import {
  CreateManualOrderDto,
  type CreateManualOrderResponseDto,
} from './dto/create-manual-order.dto';
import type { RetryManualOrderVerificationResponseDto } from './dto/dashboard.dto';
import { canWriteOrganization } from '../auth/organization-role';

const readValidationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
});

const createValidationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  exceptionFactory(errors: ValidationError[]) {
    const fieldErrors = Object.fromEntries(
      errors.map((validationError) => [
        validationError.property,
        Object.values(validationError.constraints ?? {})[0] ??
          `${validationError.property} is invalid.`,
      ]),
    );
    return new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Manual order validation failed.',
      code: 'MANUAL_ORDER_VALIDATION_FAILED',
      fieldErrors,
    });
  },
});

@Controller('api/orders')
@UseGuards(DualAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @UsePipes(readValidationPipe)
  async listOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetOrdersQueryDto,
  ): Promise<PaginatedResponse<OrderListItemDto>> {
    const result = await this.ordersService.listByOrg(user.orgId, query);
    const canWrite = canWriteOrganization(user.role);
    return {
      ...result,
      page_context: result.page_context
        ? {
            ...result.page_context,
            permissions: {
              can_send_test_verification: canWrite,
              can_cancel_orders: canWrite,
              can_create_manual_order: canWrite,
              can_retry_verifications: canWrite,
            },
          }
        : undefined,
    };
  }

  @Get('stats')
  @UsePipes(readValidationPipe)
  async getDashboardStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetVerificationStatsQueryDto,
  ): Promise<{ stats: StandaloneDashboardStatsDto }> {
    return {
      stats: await this.ordersService.getDashboardStatsByOrg(
        user.orgId,
        query.date_range,
      ),
    };
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(createValidationPipe)
  async createManualOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() payload: CreateManualOrderDto,
  ): Promise<CreateManualOrderResponseDto> {
    return this.ordersService.createManualOrder(user, idempotencyKey, payload);
  }

  @Post(':orderId/verification/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryOrderVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ): Promise<RetryManualOrderVerificationResponseDto> {
    return this.ordersService.retryOrderVerification(user, orderId);
  }
}
