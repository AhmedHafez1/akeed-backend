import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { normalizeIdempotencyKey } from '../../shared/validation/idempotency-key';
import { IntegrationApiKeyGuard } from '../integration-keys/guards/integration-api-key.guard';
import {
  CurrentIntegrationKey,
  type IntegrationApiKeyPrincipal,
} from '../integration-keys/integration-api-key.principal';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import {
  API_ORDER_IDEMPOTENCY_CODES,
  API_ORDER_READINESS_CODES,
  API_ORDER_SOURCE_CODES,
  ApiOrderChannelAdapter,
  apiOrderValidationError,
} from './api-order.channel-adapter';
import {
  CreateApiOrderDto,
  type CreateApiOrderResponseDto,
} from './dto/create-api-order.dto';

/** A route pipe answering API_VALIDATION_FAILED with per-field errors. */
export const createApiOrderPipe = new ValidationPipe({
  expectedType: CreateApiOrderDto,
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors: ValidationError[]) =>
    apiOrderValidationError(
      Object.fromEntries(
        errors.map((error) => [
          error.property,
          Object.values(error.constraints ?? {})[0] ??
            `${error.property} is invalid.`,
        ]),
      ),
    ),
});

/**
 * The server order API (E05). It authenticates by integration API key only,
 * translates the request and submits it to the same ingestion command the
 * manual form and file import use; the tenant and source come from the key,
 * never from the request.
 */
@Controller('api/v1/orders')
@UseGuards(IntegrationApiKeyGuard)
export class OrderApiController {
  constructor(
    private readonly ingestion: StandaloneOrderIngestionService,
    private readonly adapter: ApiOrderChannelAdapter,
  ) {}

  /** 202: the order is durably stored. It is not yet sent or delivered. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @CurrentIntegrationKey() principal: IntegrationApiKeyPrincipal,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    // Declared as a plain object so the app-wide ValidationPipe skips it and
    // this route's pipe (expectedType) answers with API_VALIDATION_FAILED.
    @Body(createApiOrderPipe) body: object,
  ): Promise<CreateApiOrderResponseDto> {
    const idempotencyKey = normalizeIdempotencyKey(
      idempotencyHeader,
      API_ORDER_IDEMPOTENCY_CODES,
    );
    const accepted = await this.ingestion
      .submitOne(
        principal,
        this.adapter.toCanonicalOrderInput(body as CreateApiOrderDto),
        {
          channel: 'api',
          idempotencyKey,
          codes: {
            source: API_ORDER_SOURCE_CODES,
            readiness: API_ORDER_READINESS_CODES,
          },
        },
      )
      .catch((error: unknown) => this.adapter.rethrowAsHttp(error));
    return this.adapter.toResponse(accepted);
  }
}
