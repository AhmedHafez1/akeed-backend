import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  orderApiRequestState,
  sendOrderApiFailure,
} from './order-api-request-state';
import { toOrderApiFailure } from './order-api.errors';

/**
 * Answers every error of the order API with `{code, message, correlationId}`
 * (US-05-04): authentication, throttling, validation, conflicts and unexpected
 * failures alike. It catches everything, so nothing on this route falls
 * through to the app-wide filter and its looser body.
 */
@Catch()
export class OrderApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    sendOrderApiFailure(
      response,
      orderApiRequestState(http.getRequest<Request>(), response),
      toOrderApiFailure(exception),
    );
  }
}
