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
  GetOrdersQueryDto,
  OrderListItemDto,
  PaginatedResponse,
} from './dto/dashboard.dto';
import {
  CreateManualOrderDto,
  type CreateManualOrderResponseDto,
} from './dto/create-manual-order.dto';
import type { RetryManualOrderVerificationResponseDto } from './dto/dashboard.dto';

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
    return this.ordersService.listByOrg(user.orgId, query);
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
  async retryManualOrderVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ): Promise<RetryManualOrderVerificationResponseDto> {
    return this.ordersService.retryManualOrderVerification(user, orderId);
  }
}
