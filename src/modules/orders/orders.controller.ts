import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Param,
  UseGuards,
  UsePipes,
  type ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { DualAuthGuard } from '../auth/guards/dual-auth.guard';
import { OrdersService } from './orders.service';
import {} from './dto/dashboard.dto';
import {
  CreateManualOrderDto,
  type CreateManualOrderResponseDto,
} from './dto/create-manual-order.dto';
import type { RetryManualOrderVerificationResponseDto } from './dto/dashboard.dto';

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
