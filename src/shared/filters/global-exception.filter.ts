import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { InvalidPhoneNumberError } from '../errors/invalid-phone-number.error';
import { findDatabaseTimeout } from '../errors/database-timeout.error';
import { withoutQueryParameters } from '../logging/backend-log.util';

@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof InvalidPhoneNumberError) {
      const { httpAdapter } = this.adapterHost;
      const context = host.switchToHttp();

      httpAdapter.reply(
        context.getResponse(),
        {
          statusCode: 400,
          error: 'Bad Request',
          message: exception.message,
        },
        400,
      );
      return;
    }

    // A missed database deadline is a temporary outage, not a bug: callers
    // get 503 with a stable code and may retry. Handlers that catch it first
    // keep their own answer.
    if (findDatabaseTimeout(exception)) {
      const { httpAdapter } = this.adapterHost;
      const context = host.switchToHttp();

      httpAdapter.reply(
        context.getResponse(),
        {
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'The service is temporarily unavailable. Try again shortly.',
          code: 'DATABASE_TIMEOUT',
        },
        503,
      );
      return;
    }

    // Nest logs the message and stack of an error nobody handled. A failed
    // query's message carries the statement's parameters, which are row
    // data, so it is handed on without them. The answer is the same 500.
    super.catch(
      exception instanceof Error
        ? withoutQueryParameters(exception)
        : exception,
      host,
    );
  }
}
